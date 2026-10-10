// Helpers of tests/stats.truth.review.test.js: the review of the TRUTH of the numbers and the HONESTY of the sentences of the Statistics dock
// (docs/ENTITY-INSIGHTS-DESIGN.md 3, 4 and 5; js/ui/panels/stats-model.js on the real engine with the collector on).
//
//   * plant builders with a KNOWN answer (buildLine makes a straight corridor with stations on short bays): corridorPlant (exactly one route, 29 steps = 58 m between the two docks),
//     splitPlant (two sinks fed 2 : 1 by the flow weights), processPlant (a saturated workstation: its real output is its capacity), twoFlowSourcePlant (a Goods in with two outgoing
//     flows), shuttlePlant (a loop A -> S -> B), twoDockPlant (a storage with two dock cells), batteryPlant (a fleet that charges)
//   * observedRun(layout, opts): the real Simulation with the collector on and an Observer attached
//   * Observer: an independent per-tick reader of the engine's public vehicle fields. It is written from the DEFINITIONS of the design (section 3.1 / 4.1), not from
//     js/sim/detail.js: it classifies every tick of every vehicle itself (the 11 pieces of the time split), follows the loaded legs by the states (and the engine's own state
//     timestamp for a state left and entered again in one tick) and by the edges, and keeps cumulative snapshots every 30 s so that any window can be read
//   * vehicleDiscrepancies(model, observer, ...): every number of a vehicle model that disagrees with the observer; roundTo: a rounding that does not use the model's formatters
//
// Nothing here changes a simulation: an Observer only reads, and every plant is a plain layout made with the layout.js mutators.

import { createLayout, paintRoadPath, addStation, addFlow, addFleet, updateSettings } from '../../js/model/layout.js';
import { Simulation } from '../../js/sim/engine.js';

export const CELL = 2; // metres per cell of every engineered plant
export const DRIVING_STATES = Object.freeze({ toPickup: true, toDrop: true, toCharger: true, toPark: true });

// ---------------------------------------------------------------------------------------------------------
// Plants with a known answer
// ---------------------------------------------------------------------------------------------------------

const must = (value, what) => {
  if (!value) throw new Error(`stats-truth-gen: could not create ${what}`);
  return value;
};

/**
 * A straight two-way corridor (y = 14) with stations on short bays above (`side: 'up'`) or below it. Every station is `{ key, type, name, x, side, w, h, params, ops }`; its bay is the
 * column x + 1. Returns { layout, ids: { key -> station id }, dock: { key -> [cx, cy] } }.
 */
export function buildLine({ stations, flows = [], fleets = [], settings = {}, cols = 90, rows = 30, from = 2, to = 87 } = {}) {
  const layout = createLayout({ name: 'Truth line', cols, rows, cellSize: CELL });
  must(paintRoadPath(layout, [[from, 14], [to, 14]]), 'corridor');
  const ids = {};
  const dock = {};
  for (const s of stations) {
    const w = s.w ?? 3;
    const h = s.h ?? 2;
    const side = s.side || 'up';
    const y0 = side === 'up' ? 11 - h : 18;
    const bayEnd = side === 'up' ? 11 : 17;
    const bx = s.x + 1;
    must(paintRoadPath(layout, [[bx, 14], [bx, bayEnd]]), `bay of ${s.name}`);
    const st = must(addStation(layout, { type: s.type, name: s.name, x: s.x, y: y0, w, h, params: s.params, ops: s.ops }), `station ${s.name}`);
    ids[s.key] = st.id;
    dock[s.key] = [bx, bayEnd];
  }
  for (const f of flows) must(addFlow(layout, ids[f.from], ids[f.to], f.patch), `flow ${f.from}->${f.to}`);
  for (const f of fleets) must(addFleet(layout, f.preset || 'agv', { ...f.patch, home: f.home ? ids[f.home] : undefined }), `fleet ${f.preset}`);
  if (Object.keys(settings).length) updateSettings(layout, settings);
  return { layout, ids, dock };
}

const normal = (mean, spread = 0) => ({ kind: spread > 0 ? 'normal' : 'const', mean, spread });

/** Goods in A -> Goods out B on a corridor: ONE route, 29 steps of 2 m = 58 m between the two dock cells, one vehicle (or `vehicles`). */
export function corridorPlant({ vehicles = 1, interArrival = 50, settings = {}, fleet = {} } = {}) {
  const p = buildLine({
    stations: [
      { key: 'A', type: 'source', name: 'Goods in A', x: 5, side: 'up', params: { interArrival: normal(interArrival), outCap: 8 } },
      { key: 'B', type: 'sink', name: 'Goods out B', x: 28, side: 'up' },
      { key: 'D', type: 'depot', name: 'Parking', x: 16, side: 'up', params: { slots: 4, chargers: 0 } },
    ],
    flows: [{ from: 'A', to: 'B' }],
    fleets: [{ preset: 'agv', home: 'D', patch: { count: vehicles, name: 'AGV', ...fleet } }],
    settings: { warmup: 300, ...settings },
  });
  return p;
}

/** The expected length of the corridor route A -> B in metres (29 steps of one cell: 3 up the bay, 23 along, 3 down). */
export const CORRIDOR_METRES = 29 * CELL;

/** Goods in A -> sink B (weight 2) and sink C (weight 1): the stock round robin sends exactly two of every three loads to B. One vehicle, one road: one path per pair. */
export function splitPlant({ interArrival = 90, settings = {} } = {}) {
  return buildLine({
    stations: [
      { key: 'A', type: 'source', name: 'Goods in A', x: 5, side: 'up', params: { interArrival: normal(interArrival), outCap: 12 } },
      { key: 'B', type: 'sink', name: 'Goods out B', x: 28, side: 'up' },
      { key: 'C', type: 'sink', name: 'Goods out C', x: 48, side: 'down' },
      { key: 'D', type: 'depot', name: 'Parking', x: 16, side: 'up', params: { slots: 4, chargers: 0 } },
    ],
    flows: [{ from: 'A', to: 'B', patch: { weight: 2 } }, { from: 'A', to: 'C', patch: { weight: 1 } }],
    fleets: [{ preset: 'agv', home: 'D', patch: { count: 1, name: 'AGV' } }],
    settings: { warmup: 300, ...settings },
  });
}

/**
 * Goods in A -> workstation P -> Goods out B. The workstation is the bottleneck by far (cycle 60 s, `machines` machines, `outPerCycle` per cycle): with `processFactor` it runs
 * f times as long per cycle. Its real output per hour is the measured truth the capacity line has to agree with.
 */
export function processPlant({ machines = 1, cycle = 60, outPerCycle = 1, processFactor = 1, vehicles = 3, inCap = 8 } = {}) {
  return buildLine({
    stations: [
      { key: 'A', type: 'source', name: 'Goods in A', x: 4, side: 'up', params: { interArrival: normal(cycle / (machines * 4)), outCap: 16, batch: 1 } },
      { key: 'P', type: 'process', name: 'Press', x: 26, side: 'up', w: 4, h: 3, params: { cycle: normal(cycle), machines, outPerCycle, inCap, outCap: 8 } },
      { key: 'B', type: 'sink', name: 'Goods out B', x: 48, side: 'up' },
      { key: 'D', type: 'depot', name: 'Parking', x: 16, side: 'down', params: { slots: 6, chargers: 0 } },
    ],
    flows: [{ from: 'A', to: 'P', patch: { perCycle: 1 } }, { from: 'P', to: 'B' }],
    fleets: [{ preset: 'agv', home: 'D', patch: { count: vehicles, name: 'AGV', capacity: 2 } }],
    settings: { warmup: 300, processFactor },
  });
}

/** A Goods in with TWO outgoing flows (to the sinks B and C): the output buffer holds up to `outCap` loads PER flow. */
export function twoFlowSourcePlant({ outCap = 3, interArrival = 10, vehicles = 1 } = {}) {
  return buildLine({
    stations: [
      { key: 'A', type: 'source', name: 'Goods in A', x: 5, side: 'up', params: { interArrival: normal(interArrival), outCap } },
      { key: 'B', type: 'sink', name: 'Goods out B', x: 40, side: 'up' },
      { key: 'C', type: 'sink', name: 'Goods out C', x: 60, side: 'down' },
      { key: 'D', type: 'depot', name: 'Parking', x: 16, side: 'up', params: { slots: 4, chargers: 0 } },
    ],
    flows: [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }],
    fleets: [{ preset: 'agv', home: 'D', patch: { count: vehicles, name: 'AGV' } }],
    settings: { warmup: 300 },
  });
}

/** Goods in A -> Storage S -> Goods out B with ONE vehicle: the round is a loop (A -> S, S -> B). */
export function shuttlePlant({ vehicles = 1, interArrival = 70 } = {}) {
  return buildLine({
    stations: [
      { key: 'A', type: 'source', name: 'Goods in A', x: 5, side: 'up', params: { interArrival: normal(interArrival), outCap: 8 } },
      { key: 'S', type: 'storage', name: 'Storage S', x: 30, side: 'up', w: 4, h: 2, params: { capacity: 40, dwell: 0 } },
      { key: 'B', type: 'sink', name: 'Goods out B', x: 56, side: 'up' },
      { key: 'D', type: 'depot', name: 'Parking', x: 16, side: 'down', params: { slots: 4, chargers: 0 } },
    ],
    flows: [{ from: 'A', to: 'S' }, { from: 'S', to: 'B' }],
    fleets: [{ preset: 'agv', home: 'D', patch: { count: vehicles, name: 'AGV' } }],
    settings: { warmup: 300 },
  });
}

/** Two vehicles that carry from A to the storage S, which has two docks (two bays touch it): the way depends on the dock. */
export function twoDockPlant({ vehicles = 3, interArrival = 20 } = {}) {
  const p = buildLine({
    stations: [
      { key: 'A', type: 'source', name: 'Goods in A', x: 4, side: 'up', params: { interArrival: normal(interArrival), outCap: 8 } },
      { key: 'S', type: 'storage', name: 'Storage S', x: 30, side: 'up', w: 8, h: 2, params: { capacity: 60, dwell: 0 } },
      { key: 'B', type: 'sink', name: 'Goods out B', x: 60, side: 'up' },
      { key: 'D', type: 'depot', name: 'Parking', x: 16, side: 'down', params: { slots: 6, chargers: 0 } },
    ],
    flows: [{ from: 'A', to: 'S' }, { from: 'S', to: 'B' }],
    fleets: [{ preset: 'agv', home: 'D', patch: { count: vehicles, name: 'AGV' } }],
    settings: { warmup: 300 },
  });
  // a second bay under the same station: the storage then has two dock cells (x = 31 and x = 36)
  must(paintRoadPath(p.layout, [[36, 14], [36, 11]]), 'second bay');
  return p;
}

/** A battery fleet that charges in the depot: drives to a charger (depot drives) and a window with charge stops. */
export function batteryPlant({ vehicles = 2, runtimeMin = 12, chargeTimeMin = 3 } = {}) {
  return buildLine({
    stations: [
      { key: 'A', type: 'source', name: 'Goods in A', x: 5, side: 'up', params: { interArrival: normal(45), outCap: 8 } },
      { key: 'B', type: 'sink', name: 'Goods out B', x: 40, side: 'up' },
      { key: 'D', type: 'depot', name: 'Charging', x: 20, side: 'down', params: { slots: 4, chargers: 2 } },
    ],
    flows: [{ from: 'A', to: 'B' }],
    fleets: [{ preset: 'agv', home: 'D', patch: { count: vehicles, name: 'AGV', battery: { enabled: true, runtimeMin, chargeTimeMin, lowPct: 40, resumePct: 80 } } }],
    settings: { warmup: 300 },
  });
}

/** A run of `layout` for `seconds` of simulated time after the warm-up, the collector on, an Observer attached; `tick` is called after every step when given. */
export function observedRun(layout, { seed = 1, seconds = 3600, detail = true, observe = true, snapshots = false, tick = null, runtime = null } = {}) {
  const sim = new Simulation(layout, { seed });
  if (detail) sim.enableDetail();
  const obs = observe ? new Observer(sim, { snapshots }) : null;
  const end = (layout.settings.warmup || 0) + seconds;
  while (sim.time < end - 1e-9) {
    if (runtime) runtime(sim);
    sim.step();
    if (obs) obs.tick();
    if (tick) tick(sim);
  }
  return { sim, obs };
}

// ---------------------------------------------------------------------------------------------------------
// The independent observer (reads the public fields of the vehicles after every tick; written from the design's definitions)
// ---------------------------------------------------------------------------------------------------------

/** The classes of a vehicle's time (the 11 pieces of the design, 3.1). */
export const CLASSES = Object.freeze(['drivingLoaded', 'drivingEmpty', 'drivingDepot', 'trafficWait', 'dockQueue', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken']);
const CI = Object.fromEntries(CLASSES.map((c, i) => [c, i]));

/** A leg the observer saw: a loaded drive from the station where the load was picked up to the one it was delivered to. */
class Leg {
  constructor(t0, from, to, flow) {
    this.t0 = t0; this.from = from; this.to = to; this.flow = flow;
    this.driven = 0; // seconds in the state toDrop (a repair is not in it)
    this.held = 0; // seconds of it held up
    this.queue = 0; // seconds of it in a queue for a dock
    this.edges = []; // the edges of the road it drove, in order
    this.relocated = false; // a deadlock relocation put the vehicle somewhere else
    this.closed = false; // arrived (left the state toDrop for anything but a breakdown)
    this.t1 = null;
    this.loadStart = null; // when the vehicle began to load at the pickup (the arrival at the pickup), if it came from the state loading
  }
}

export class Observer {
  /**
   * @param {object} sim a Simulation
   * @param {{ snapshots?: boolean }} [opts] snapshots: keep the cumulative figures every 30 s of simulated time (the collector's windows begin on such a boundary when the
   *   warm-up is a multiple of 30 s), so that window(i, t0) can be read; the end of a window is always the live figure
   */
  constructor(sim, { snapshots = false } = {}) {
    this.sim = sim;
    this.lg = sim.logistics;
    this.V = sim.vehicles;
    this.n = this.V.length;
    this.snapshots = snapshots;
    this.lastT = sim.time;
    this.cls = Array.from({ length: this.n }, () => new Float64Array(CLASSES.length)); // cumulative seconds per class
    this.odo = Array.from({ length: this.n }, () => new Float64Array(4)); // loaded, empty, park metres (cumulative) and trips
    this.bat = new Float64Array(this.n).fill(Infinity); // the lowest battery since the last snapshot
    this.state = this.V.map((v) => v.state);
    this.since = this.V.map((v) => v.stateSince);
    this.legs = this.V.map(() => []); // loaded legs per vehicle, in order (the last one may be open)
    this.open = this.V.map(() => null);
    this.preBroken = this.V.map(() => null);
    this.teleports = this.V.map((v) => (v.tv ? v.tv.teleports : 0));
    this.lastEdge = this.V.map(() => -1);
    this.loadStart = this.V.map(() => null); // when the vehicle's last loading began
    this.starts = this.V.map(() => ({ toPickup: [], toDrop: [], toCharger: [], toPark: [] })); // when each drive began (a repair that resumes a drive is not a start)
    this.charges = this.V.map(() => []); // [{ t0, t1 }] charging periods per vehicle that are over
    this.charging = this.V.map(() => null);
    this.snap = []; // [{ t, cls, odo, bat: Float64Array(n) lowest battery since the snapshot before }]
    this._snapshot();
  }

  _classOf(vr) {
    const s = vr.state;
    if (DRIVING_STATES[s] === true) {
      if (vr.tv && vr.tv.waiting) return vr.dock !== null && this.lg.docks.waitsForDock(vr, vr.dock) ? CI.dockQueue : CI.trafficWait;
      return s === 'toDrop' ? CI.drivingLoaded : s === 'toPickup' ? CI.drivingEmpty : CI.drivingDepot;
    }
    switch (s) {
      case 'loading': return CI.loading;
      case 'unloading': return CI.unloading;
      case 'idle': return CI.idle;
      case 'parked': return CI.parked;
      case 'charging': return CI.charging;
      default: return CI.broken; // broken, dead
    }
  }

  /** Call after every sim.step(). */
  tick() {
    const sim = this.sim;
    const dt = sim.time - this.lastT;
    this.lastT = sim.time;
    if (!(dt > 0)) return;
    for (let i = 0; i < this.n; i++) {
      const vr = this.V[i];
      const s = vr.state;
      const prev = this.state[i];
      const c = this._classOf(vr);
      this.cls[i][c] += dt;
      const o = this.odo[i];
      o[0] = vr.loadedDistance; o[1] = vr.emptyDistance; o[2] = vr.parkDistance; o[3] = vr.trips;
      if (vr.battery < this.bat[i]) this.bat[i] = vr.battery;
      // charging periods
      if (s === 'charging' && this.charging[i] === null) this.charging[i] = { t0: sim.time - dt, t1: null };
      if (s !== 'charging' && this.charging[i] !== null) { this.charging[i].t1 = sim.time - dt; this.charges[i].push(this.charging[i]); this.charging[i] = null; }
      // loaded legs: a leg opens when the state becomes toDrop (or is entered again in the very tick it was left: the engine's own timestamp moves) and closes when the
      // vehicle leaves it for anything but a breakdown; a repair that returns to the state before the breakdown continues the drive
      const changed = s !== prev || vr.stateSince !== this.since[i];
      if (changed) {
        if (s === 'broken' && prev !== 'broken') this.preBroken[i] = prev;
        if (s === 'loading') this.loadStart[i] = sim.time - dt;
        const resumes = prev === 'broken' && s !== 'broken' && s === this.preBroken[i];
        if (!resumes) {
          if (prev === 'toDrop' && s !== 'broken') this._closeLeg(i, sim.time - dt, s);
          if (s === 'toDrop') this._openLeg(i, sim.time - dt, vr);
          if (DRIVING_STATES[s] === true) this.starts[i][s].push(sim.time - dt);
        }
        this.since[i] = vr.stateSince;
      }
      const leg = this.open[i];
      if (leg !== null && s === 'toDrop') {
        leg.driven += dt;
        if (vr.tv && vr.tv.waiting) { leg.held += dt; if (c === CI.dockQueue) leg.queue += dt; }
        const e = vr.tv ? vr.tv.edge : -1;
        if (e >= 0 && e !== this.lastEdge[i]) { leg.edges.push(e); this.lastEdge[i] = e; }
        if (vr.tv && vr.tv.teleports !== this.teleports[i]) leg.relocated = true;
      }
      if (vr.tv) this.teleports[i] = vr.tv.teleports;
      this.state[i] = s;
    }
    if (this.snapshots) {
      const k = sim.time / 30;
      if (Math.abs(k - Math.round(k)) * 30 < 0.25) this._snapshot(); // the few ticks around every 30 s: the collector closes a bucket at the first tick at or after its boundary
    }
  }

  _openLeg(i, t, vr) {
    const o = vr.order;
    const leg = new Leg(t, o ? o.from : null, o ? o.to : null, o ? o.flowId : null);
    if (this.state[i] === 'loading') leg.loadStart = this.loadStart[i];
    this.open[i] = leg;
    this.legs[i].push(leg);
    this.lastEdge[i] = -1;
  }

  _closeLeg(i, t, next) {
    const leg = this.open[i];
    if (leg === null) return;
    leg.closed = true;
    leg.t1 = t;
    leg.dropped = next === 'dead'; // a dead battery drops the leg: no arrival
    this.open[i] = null;
  }

  _snapshot() {
    const C = CLASSES.length;
    const cls = new Float64Array(this.n * C);
    const odo = new Float64Array(this.n * 4);
    for (let i = 0; i < this.n; i++) { cls.set(this.cls[i], i * C); odo.set(this.odo[i], i * 4); }
    this.snap.push({ t: this.sim.time, cls, odo, bat: Float64Array.from(this.bat) });
    for (let i = 0; i < this.n; i++) this.bat[i] = this.V[i].battery;
  }

  /** The first snapshot at or after time t (within a quarter second of it), or null. */
  at(t) {
    for (let k = 0; k < this.snap.length; k++) if (this.snap[k].t >= t - 1e-9 && this.snap[k].t < t + 0.25) return this.snap[k];
    return null;
  }

  /**
   * The seconds of each class of vehicle i between the time t0 and now (the window of the collector), the deliveries and the metres. Needs `snapshots` and a window that
   * began on a 30 s boundary of simulated time; throws when there is no snapshot at t0.
   */
  window(i, t0) {
    const C = CLASSES.length;
    const a = this.at(t0);
    if (a === null) throw new Error(`Observer: no snapshot at t0 = ${t0}`);
    const now = this.sim.time;
    const o = this.odo[i];
    const out = { seconds: 0, trips: o[3] - a.odo[i * 4 + 3], loaded: o[0] - a.odo[i * 4], empty: o[1] - a.odo[i * 4 + 1], park: o[2] - a.odo[i * 4 + 2], t0: a.t, t1: now };
    for (let c = 0; c < C; c++) { out[CLASSES[c]] = this.cls[i][c] - a.cls[i * C + c]; out.seconds += out[CLASSES[c]]; }
    out.driving = out.drivingLoaded + out.drivingEmpty + out.drivingDepot;
    out.held = out.trafficWait + out.dockQueue;
    out.busy = out.driving + out.held + out.loading + out.unloading;
    return out;
  }

  /** The loaded legs of vehicle i that began at or after t0. */
  loadedLegs(i, t0) {
    return this.legs[i].filter((l) => l.t0 >= t0 - 1e-9);
  }

  /** The lowest battery vehicle i had at any tick after t0 (needs snapshots). */
  lowestBattery(i, t0) {
    let low = this.bat[i];
    const a = this.at(t0);
    if (a === null) throw new Error(`Observer: no snapshot at t0 = ${t0}`);
    for (const s of this.snap) if (s.t > a.t + 1e-9 && s.bat[i] < low) low = s.bat[i];
    return Math.min(low, this.V[i].battery);
  }

  /** The charging periods of vehicle i that ended at or after t0 (a period still running is not counted: a session ends when the vehicle stops charging). */
  chargeStops(i, t0) {
    return this.charges[i].filter((c) => c.t1 >= t0 - 1e-9);
  }
}

// ---------------------------------------------------------------------------------------------------------
// What a planner reads
// ---------------------------------------------------------------------------------------------------------

/** A decimal rounding written here, not borrowed from the model: round half up on the printed digit, never "-0". */
export function roundTo(x, d = 0) {
  const f = 10 ** d;
  const r = Math.round(x * f + 1e-9) / f;
  return r === 0 ? 0 : r;
}

// ---------------------------------------------------------------------------------------------------------
// The comparison of a vehicle model with the observer
// ---------------------------------------------------------------------------------------------------------

/** The pieces of the time split (model key -> observer class). */
export const SPLIT_OF = Object.freeze({
  drivingLoaded: 'drivingLoaded', drivingEmpty: 'drivingEmpty', drivingDepot: 'drivingDepot', waiting: 'trafficWait', dockQueue: 'dockQueue', loading: 'loading', unloading: 'unloading',
  idle: 'idle', parked: 'parked', charging: 'charging', broken: 'broken',
});

/**
 * Every number of the vehicle model `m` (kind 'start' | 'last30') that disagrees with what the observer saw, as readable strings: the window length, trips per hour,
 * busy, held up, driven, parked, the lowest battery and the charge stops, the average loaded trip, each piece of the time split, the "loaded · empty · to depot" shares
 * of the metres and the trips-per-pair of the rows. `tol` = { share, seconds, rate } absolute tolerances.
 */
export function vehicleDiscrepancies(m, obs, det, i, kind, { share = 1e-6, seconds = 0.15, rate = 1e-4, mean = 0.06 } = {}) {
  const bad = [];
  const w = det.windowOf(kind);
  const o = obs.window(i, w.t0);
  const hours = o.seconds / 3600;
  const T = (id) => m.tiles.find((t) => t.id === id);
  const eq = (what, got, want, tol) => { if (!(Math.abs(got - want) <= tol)) bad.push(`${what}: model ${got}, observer ${want} (tolerance ${tol})`); };
  eq('window seconds', m.window.seconds, o.seconds, seconds);
  eq('trips per hour', T('trips').raw, o.trips / hours, rate * Math.max(1, o.trips / hours));
  eq('busy', T('busy').raw, o.busy / o.seconds, share);
  eq('held up', T('held').raw, o.held / o.seconds, share);
  eq('driven km/h', T('driven').raw, (o.loaded + o.empty + o.park) / hours / 1000, rate);
  if (T('parked')) eq('parked', T('parked').raw, o.parked / o.seconds, share);
  if (T('battery')) {
    eq('lowest battery', T('battery').raw, obs.lowestBattery(i, w.t0), 1e-6);
    const wanted = obs.chargeStops(i, w.t0).length;
    const printed = /(\d+) charge stops?/.exec(T('battery').ref.text);
    if (!printed || Number(printed[1]) !== wanted) bad.push(`charge stops: model "${T('battery').ref.text}", observer ${wanted}`);
  }
  const legs = obs.legs[i].filter((l) => l.closed && !l.dropped && l.t0 >= w.t0 - 1e-9);
  if (legs.length && T('loaded').raw !== null) eq('average loaded trip', T('loaded').raw, legs.reduce((a, l) => a + l.driven, 0) / legs.length, mean);
  const split = m.blocks.find((b) => b.type === 'time').split.items;
  for (const [key, cls] of Object.entries(SPLIT_OF)) {
    const item = split.find((p) => p.key === key);
    const want = o[cls] / o.seconds;
    if (item) eq(`time split ${key}`, item.share, want, share);
    else if (want > 0.004 + share) bad.push(`time split ${key}: missing, observer ${want}`);
  }
  const driven = o.loaded + o.empty + o.park;
  if (driven > 0) {
    const mm = /loaded (\d+) % · empty (\d+) % · to depot (\d+) %/.exec(T('driven').ref.text);
    if (!mm) bad.push(`driven shares: "${T('driven').ref.text}"`);
    else for (const [k, x] of [[1, o.loaded], [2, o.empty], [3, o.park]]) eq(`driven share ${k}`, Number(mm[k]), roundTo((100 * x) / driven), 1);
  }
  return bad;
}
