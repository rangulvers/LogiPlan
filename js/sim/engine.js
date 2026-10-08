// Simulation engine: wires the road graph, the traffic system, the logistics brain and the statistics into one
// steppable object (docs/ARCHITECTURE.md 5.5). DOM-free; the same code runs in the browser (live view) and in
// Node (headless experiments, tests). Reset is simply constructing a new Simulation.
//
// One tick (step):  logistics.step(dt, t)  ->  traffic.step(dt)  ->  time += dt  ->  stats.sample(dt)
// Everything the logistics layer emits, plus 'deadlock', goes through one event bus: statistics first, then the
// listeners registered with on().
//
// How the open points of the spec were resolved:
//  * The layout is run through normalizeLayout, which returns a deep copy: the caller's layout is never read again
//    nor modified, and `sim.layout` / `sim.settings` are the simulation's own (normalised) copies.
//  * Events are delivered as fn(payload, name) for named listeners and for the '*' wildcard alike. The 'deadlock'
//    payload is plain data { t, nodes, vehicles: ids, victim: id | null, resolved }; `t` is the end of the tick.
//    One standing jam is one deadlock: traffic loses track of a jam for a moment now and then and reports the same vehicles
//    again after its 20 s timer ran out anew. A repeated unresolved report about vehicles that have not left their place
//    (less than a cell of driving since the first report) therefore produces no event and no history entry; the statistics are
//    told ('deadlockRepeat') to take it off their count. Vehicles that drove away and jammed again are a new deadlock.
//    A listener that throws cannot leave the simulation half-stepped: the tick is completed first, the remaining
//    listeners still run, and the first error is rethrown by step() after the tick.
//  * Warm-up: stats.reset() runs exactly once, in the tick that makes time reach settings.warmup (that tick belongs
//    to the discarded warm-up; the comparison tolerates the rounding of the accumulated clock, WARMUP_EPS). With
//    warmup 0 the measurement window simply starts at time 0 (the statistics start fresh), so no reset is needed.
//  * advance() always steps whole ticks of `dt` and never a shorter last one, so the sequence of time steps - and with
//    it every result - is the same however a run is cut into advance() calls or time budgets. A request that is not
//    a multiple of dt is rounded up to the next whole tick. A request shorter than dt * 1e-6 counts as already done: that
//    tolerance absorbs the rounding of clocks that were accumulated tick by tick (1000 ticks of 0.1 s are not exactly 100 s),
//    so "advance(target - sim.time)" never steps a whole extra tick for a remainder of 1e-12. Anything longer advances at least
//    one tick. Callers that need an exact end time keep an absolute target and ask for `target - sim.time` (the live runner does).
//  * A time budget (maxMillis) is checked between ticks, never inside one. The clock is read after every tick at first and then
//    every few ticks, as many as keep the reading overhead small and the overshoot of the budget to about an eighth of it;
//    a plant whose ticks are slow is therefore checked after every tick.
//  * setRuntime() accepts exactly RUNTIME_KEYS. Other keys (e.g. when a whole settings object is passed) are ignored,
//    so a structural setting can never be changed behind the simulation's back; junk values of the accepted keys
//    keep the current value. Factors are clamped to [MIN_FACTOR, MAX_FACTOR].

import { DISPATCH_STRATEGIES, RUNTIME_KEYS, ROUTING_MODES } from '../model/defaults.js';
import { normalizeLayout } from '../model/layout.js';
import { createRng } from '../util/rng.js';
import { buildGraph } from './graph.js';
import { Logistics } from './logistics.js';
import { Stats, WARMUP_EPS } from './stats.js';
import { TrafficSystem } from './traffic.js';
import { generateInsights } from './insights.js';

/** Range of the what-if factors accepted by setRuntime (demand, vehicle speed, process time). */
export const MIN_FACTOR = 0.05;
export const MAX_FACTOR = 20;
/** advance() looks at the clock at most once per this many ticks (more often when ticks are slow, see advance). */
export const CLOCK_CHECK_TICKS = 32;
/** advance() aims at this many clock readings per time budget. */
const CLOCK_READS_PER_BUDGET = 8;
/** Deadlock reports kept in sim.deadlocks. */
export const DEADLOCK_HISTORY = 50;

const FACTOR_KEYS = new Set(['demandFactor', 'speedFactor', 'processFactor']);

/** Wall clock for time budgets; without a high-resolution clock there is simply no budget (never Date.now: determinism). */
function defaultNow() {
  return typeof performance === 'object' && performance !== null && typeof performance.now === 'function' ? performance.now() : 0;
}

/** Accepted value for one runtime key, or undefined when `value` is junk (the current value then stays). */
function runtimeValue(key, value) {
  if (FACTOR_KEYS.has(key)) {
    return typeof value === 'number' && !Number.isNaN(value) ? Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value)) : undefined;
  }
  const allowed = key === 'dispatch' ? DISPATCH_STRATEGIES : ROUTING_MODES;
  return typeof value === 'string' && Object.hasOwn(allowed, value) ? value : undefined;
}

/** Unsigned 32-bit seed from any finite number (fractions dropped, negatives wrapped); undefined for junk. */
function seedValue(seed) {
  return typeof seed === 'number' && Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : undefined;
}

const odometerOf = (v) => (v && Number.isFinite(v.odometer) ? v.odometer : 0);
const idOf = (v) => (typeof v === 'string' ? v : v && v.id !== undefined ? String(v.id) : '');
/** The same jam whatever the order of its vehicles in a report. */
const jamKey = (ids) => ids.slice().sort().join(',');

export class Simulation {
  /**
   * @param {object} layout any layout object (it is normalised and copied)
   * @param {{ seed?: number }} [opts] `seed` overrides settings.seed
   * @throws {TypeError} when `layout` is not an object
   */
  constructor(layout, opts = {}) {
    this.layout = normalizeLayout(layout);
    this.settings = this.layout.settings;
    const seed = seedValue(opts && opts.seed);
    if (seed !== undefined) this.settings.seed = seed;
    this.seed = this.settings.seed;
    this.dt = this.settings.dt;
    this.time = 0;
    this.rng = createRng(this.seed);
    /** Recent deadlock reports (newest last, at most DEADLOCK_HISTORY), see the 'deadlock' event. */
    this.deadlocks = [];
    /** vehicle ids (sorted) -> { event, odometers } of the latest report about these vehicles, for recognising a jam that stands. */
    this._jams = new Map();

    this._listeners = new Map();
    this._wildcards = [];
    this._fault = null;
    this._tickEnd = 0;
    this._measuring = !(this.settings.warmup > 0);

    this.graph = buildGraph(this.layout);
    this.traffic = new TrafficSystem(this.graph, {
      handedness: this.settings.handedness,
      resolveDeadlocks: this.settings.deadlock === 'resolve',
      rng: this.rng.fork('traffic'),
    });
    this.logistics = new Logistics({ layout: this.layout, graph: this.graph, traffic: this.traffic, rng: this.rng, emit: (name, payload) => this.emit(name, payload) });
    this.stats = new Stats(this);
    this.traffic.onDeadlock = (info) => this.handleDeadlock(info);

    this.stations = this.logistics.stations;
    this.vehicles = this.logistics.vehicles;
    this.flows = this.logistics.flows;
  }

  /** The five live-adjustable settings as they are now (a copy). */
  get runtime() {
    return Object.fromEntries(RUNTIME_KEYS.map((key) => [key, this.settings[key]]));
  }

  // ---- stepping -------------------------------------------------------------------------------------------

  /**
   * Advance the simulation by one tick. A non-positive or non-finite `dt` does nothing.
   * @param {number} [dt] tick length in seconds (default settings.dt)
   */
  step(dt = this.dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const t = this.time;
    this._tickEnd = t + dt;
    this.logistics.step(dt, t);
    this.traffic.step(dt);
    this.time = this._tickEnd;
    this.stats.sample(dt);
    if (!this._measuring && this.time + WARMUP_EPS >= this.settings.warmup) {
      this._measuring = true;
      this.stats.reset();
    }
    if (this._fault !== null) {
      const error = this._fault;
      this._fault = null;
      throw error;
    }
  }

  /**
   * Run whole ticks until `seconds` of simulated time have passed or the time budget is used up.
   * @param {number} seconds simulated time to advance (non-positive or non-finite: nothing happens; shorter than dt * 1e-6: counts as done)
   * @param {{ maxMillis?: number, now?: () => number }} [opts] `maxMillis`: stop early once this much real time has gone by
   *   (the clock is read between ticks, so at least one tick always runs and the budget can be overshot by the tail of one
   *   tick plus about an eighth of the budget); `now`: clock in milliseconds, default performance.now
   * @returns {number} simulated seconds actually advanced
   */
  advance(seconds, { maxMillis = Infinity, now = defaultNow } = {}) {
    if (!(seconds > 0) || !Number.isFinite(seconds)) return 0;
    const start = this.time;
    const end = start + seconds - this.dt * 1e-6;
    if (!Number.isFinite(maxMillis)) {
      while (this.time < end) this.step(this.dt);
      return this.time - start;
    }
    let last = now();
    const began = last;
    let interval = 1;
    let sinceRead = 0;
    while (this.time < end) {
      this.step(this.dt);
      if (++sinceRead < interval) continue;
      const stamp = now();
      if (stamp - began >= maxMillis) break;
      const perTick = (stamp - last) / sinceRead;
      interval = perTick > 0 ? Math.min(CLOCK_CHECK_TICKS, Math.max(1, Math.floor(maxMillis / CLOCK_READS_PER_BUDGET / perTick))) : CLOCK_CHECK_TICKS;
      last = stamp;
      sinceRead = 0;
    }
    return this.time - start;
  }

  // ---- what-if settings -----------------------------------------------------------------------------------

  /**
   * Change RUNTIME_KEYS settings (demandFactor, speedFactor, processFactor, dispatch, routing) while running.
   * Other keys and junk values are ignored; factors are clamped to [MIN_FACTOR, MAX_FACTOR].
   * @param {object} patch
   * @returns {object} the runtime settings now in force
   */
  setRuntime(patch) {
    const source = patch !== null && typeof patch === 'object' ? patch : {};
    const accepted = {};
    for (const key of RUNTIME_KEYS) {
      const value = Object.hasOwn(source, key) ? runtimeValue(key, source[key]) : undefined;
      if (value !== undefined) accepted[key] = value;
    }
    Object.assign(this.settings, accepted);
    this.logistics.setRuntime(accepted);
    return this.runtime;
  }

  // ---- events ---------------------------------------------------------------------------------------------

  /**
   * Listen to simulation events: every logistics event ('loadCreated', 'loadCompleted', 'orderAssigned',
   * 'orderPickedUp', 'orderDelivered', 'orderCancelled', 'machineDown', 'machineUp', 'vehicleDown', 'vehicleUp',
   * 'vehicleDead') and 'deadlock'. The name '*' receives all of them. Listeners are called as fn(payload, name).
   * @param {string} name event name or '*'
   * @param {(payload: object, name: string) => void} fn
   * @returns {() => void} call it to unsubscribe
   */
  on(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('Simulation.on: the listener must be a function');
    const entry = { fn };
    if (name === '*') this._wildcards = [...this._wildcards, entry];
    else this._listeners.set(name, [...(this._listeners.get(name) || []), entry]);
    return () => {
      if (name === '*') this._wildcards = this._wildcards.filter((e) => e !== entry);
      else {
        const rest = (this._listeners.get(name) || []).filter((e) => e !== entry);
        if (rest.length > 0) this._listeners.set(name, rest);
        else this._listeners.delete(name);
      }
    };
  }

  /**
   * Publish an event: statistics first, then the listeners of `name`, then the wildcard listeners. Called by the
   * logistics layer and the deadlock hook; listener errors are held back until the end of the tick (see step).
   * @param {string} name
   * @param {object} payload
   */
  emit(name, payload) {
    this.stats.onEvent(name, payload);
    const named = this._listeners.get(name);
    if (named !== undefined) this.deliver(named, payload, name);
    if (this._wildcards.length > 0) this.deliver(this._wildcards, payload, name);
  }

  deliver(entries, payload, name) {
    for (const entry of entries) {
      try {
        entry.fn(payload, name);
      } catch (error) {
        if (this._fault === null) this._fault = error;
      }
    }
  }

  /** The traffic system reports a deadlock: logistics re-plans the victim, the event goes out, the history is updated. */
  handleDeadlock(info) {
    const vehicles = Array.from(info.vehicles || [], idOf).filter(Boolean);
    const event = {
      t: this._tickEnd,
      nodes: Array.from(info.nodes || [], Number),
      vehicles,
      victim: info.victim ? idOf(info.victim) : null,
      resolved: info.resolved !== false,
    };
    const key = jamKey(vehicles);
    const known = this._jams.get(key);
    const standing = known !== undefined && !known.event.resolved && !this.hasLeft(known, info.vehicles);
    if (standing && !event.resolved) { // the same jam, reported once more
      this.stats.onEvent('deadlockRepeat', event);
      return;
    }
    this.logistics.handleDeadlock(info);
    if (standing) Object.assign(known.event, event, { t: known.event.t }); // the jam was relocated after all
    else this.recordDeadlock(event, key, info.vehicles);
    this.emit('deadlock', event);
  }

  /** Append to sim.deadlocks (at most DEADLOCK_HISTORY entries) and remember where the vehicles of the jam were. */
  recordDeadlock(event, key, trafficVehicles) {
    const odometers = new Map(Array.from(trafficVehicles || [], (v) => [idOf(v), odometerOf(v)]));
    this._jams.set(key, { event, odometers });
    this.deadlocks.push(event);
    if (this.deadlocks.length > DEADLOCK_HISTORY) {
      const dropped = this.deadlocks.shift();
      const droppedKey = jamKey(dropped.vehicles);
      if (this._jams.get(droppedKey)?.event === dropped) this._jams.delete(droppedKey);
    }
  }

  /** Has any vehicle of a jam driven more than a cell since the jam was first reported? Then it is not the same jam any more. */
  hasLeft(jam, trafficVehicles) {
    const limit = this.graph.cellSize;
    return Array.from(trafficVehicles || []).some((v) => Math.abs(odometerOf(v) - (jam.odometers.get(idOf(v)) ?? 0)) > limit);
  }

  // ---- results --------------------------------------------------------------------------------------------

  /** KPI report of the current measurement window (docs/ARCHITECTURE.md 5.4). */
  kpis() {
    return this.stats.report();
  }

  /**
   * Plain-language findings for the planner.
   * @param {object} [report] a KpiReport to analyse (default: a fresh one), so callers that already have one avoid computing it twice
   */
  insights(report = this.kpis()) {
    return generateInsights(report, this.layout);
  }

  /** Congestion heat data of the current window (per-edge passes and waiting, per-node waiting). Allocates; ask at UI pace. */
  heat() {
    return this.stats.heat();
  }
}
