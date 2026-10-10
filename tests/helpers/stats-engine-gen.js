// Helper of tests/stats.engine.review.test.js: the adversarial review of the ENGINE side of the click-an-item statistics (docs/ENTITY-INSIGHTS-DESIGN.md S1, the optional detail
// collector js/sim/detail.js and its seams in engine.js / traffic.js / insights.js): neutrality, containment, determinism, memory and cost.
//
// Written independently of tests/helpers/detail-digest.js, detail-snapshot.js and the generators of the SIM builder: the plants come from the OTHER generators of the repository
// (hostilePlant, hostileTruckPlant, dockPlant / hostileDocks, fuzzPlant: none of them was written for the collector), and what a run is compared with is read from the public
// surface of a Simulation (poses, states, counters, the event stream, kpis(), heat(), traffic.stats), never from the collector.
//
//   plantOf(family, seed)            { name, layout, seed, actions } from one of the generators (family 'hostile' | 'truck' | 'dock' | 'hdock' | 'fuzz'), or null when the generator refuses
//   REVIEW_PLANTS                    the plants of the default corpus, chosen from a scan of seeds 1 to 40 so that together they reach every corner the collector has code for
//                                    (relocation by deadlock resolution, zero-length legs, breakdowns, dead batteries, trucks, late dock choice, a removed vehicle, coarse and fine ticks)
//   chargingPlant()                  Two lines with a tiny battery: charge sessions within minutes
//   withSettings(plant, patch)       the same plant with other settings (dt, warmup, ...)
//   runTrace(plant, mode, opts)      one run in one collector mode (MODES) and a digest of EVERYTHING observable about the simulation (events, poses, states, counters, kpis, heat map,
//                                    traffic statistics, deadlock list); runs on `opts.Sim` (default: the Simulation of this tree), so a scratch comparison with another tree is possible
//   listenerCount(sim)               how many listeners sit on the event bus (a collector that is dropped or disabled must leave none behind)
//   featuresOf(sim)                  which corners a finished run reached (relocated / zero-length / paused legs, dead vehicles, breakdowns, charge sessions, ...)
//   readOnlyView(sim, violations)    a deep read-only view of a Simulation: every WRITE made through it is recorded, with its path. A collector built on it proves "reads only, mutates nothing"
//   runnerRig(opts)                  the real runner on the real engine with a fake clock and fake animation frames, to attack the collector through the store and the runner
import { createHash } from 'node:crypto';
import { Simulation } from '../../js/sim/engine.js';
import { FLAG } from '../../js/sim/detail.js';
import { EXAMPLES } from '../../js/model/examples.js';
import * as L from '../../js/model/layout.js';
import { createRunner } from '../../js/ui/runner.js';
import { createStore } from '../../js/store/store.js';
import { hostilePlant } from './engine-review-gen.js';
import { hostileTruckPlant } from './m1-sim-review-gen.js';
import { dockPlant, hostileDocks } from './docks-review-gen.js';
import { fuzzPlant } from './trucks-gen.js';

// ---- plants -----------------------------------------------------------------------------------------------------------------------------

export const FAMILIES = Object.freeze(['hostile', 'truck', 'dock', 'hdock', 'fuzz']);

/** A plant of one family and seed, or null when its generator refuses (a few hostile seeds do). */
export function plantOf(family, seed) {
  if (!FAMILIES.includes(family)) throw new RangeError(`unknown plant family ${family}`);
  try {
    switch (family) {
      case 'hostile': return { name: `hostile ${seed}`, layout: hostilePlant(seed), seed: 1 + (seed % 5), actions: [] };
      case 'truck': { const { layout, actions } = hostileTruckPlant(seed, { horizon: 1500 }); return { name: `truck ${seed}`, layout, seed, actions }; }
      case 'dock': return { name: `dock ${seed}`, layout: dockPlant(seed), seed: 1 + (seed % 3), actions: [] };
      case 'hdock': return { name: `hdock ${seed}`, layout: hostileDocks(seed), seed: 1 + (seed % 3), actions: [] };
      default: return { name: `fuzz ${seed}`, layout: fuzzPlant(seed), seed, actions: [] };
    }
  } catch {
    return null; // a generator may refuse a seed (a layout the model rejects)
  }
}

/** Every family for every seed of `seeds`. */
export function reviewCorpus(seeds, families = FAMILIES) {
  const out = [];
  for (const seed of seeds) for (const family of families) { const p = plantOf(family, seed); if (p) out.push(p); }
  return out;
}

/**
 * The default corpus: [family, seed]. Found by a greedy cover of the corners over seeds 1 to 40 of every family (600 simulated seconds each, collector on); the test asserts the
 * coverage of the whole set, so that a change of a generator that loses a corner fails there instead of silently weakening every comparison.
 */
export const REVIEW_PLANTS = Object.freeze([['truck', 37], ['dock', 5], ['truck', 35], ['hostile', 4], ['fuzz', 25], ['dock', 16]]);

/** Two lines with a small battery on the AGVs and one charger: the collector's charge sessions (the examples have none in minutes). */
export function chargingPlant() {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  const fleet = layout.fleets.find((f) => f.id === 'v2') || layout.fleets[layout.fleets.length - 1];
  L.updateFleet(layout, fleet.id, { battery: { enabled: true, runtimeMin: 4, chargeTimeMin: 1, lowPct: 60, resumePct: 95 } });
  layout.settings.warmup = 0;
  return { name: 'two lines, small battery', layout, seed: 1, actions: [] };
}

export const exampleOf = (id, seed = 1) => ({ name: id, layout: EXAMPLES.find((e) => e.id === id).build(), seed, actions: [] });

/** The same plant with other settings; the layout is copied. */
export function withSettings(plant, patch) {
  const layout = structuredClone(plant.layout);
  Object.assign(layout.settings, patch);
  return { ...plant, layout, name: `${plant.name} ${JSON.stringify(patch)}` };
}

// ---- a run, digested -----------------------------------------------------------------------------------------------------------------------

/**
 * Collector modes of runTrace. `plain`: never enabled. `on`: enabled before the first tick. `toggle`: on, off at 20 %, on at 45 %, off at 70 %, on at 85 % of the run. `late`: enabled at 40 %.
 * `enableTwice`: on, on again at 30 %, off at 60 %. `dropped-afterTick` / `dropped-listener`: on, and at 50 % its afterTick (or its event handlers) is made to throw: the engine drops it.
 * `drop-reenable`: dropped at 40 % by a throwing afterTick and enabled again at 70 %.
 */
export const MODES = Object.freeze(['plain', 'on', 'toggle', 'late', 'enableTwice', 'dropped-afterTick', 'dropped-listener', 'drop-reenable']);

const vehicleLine = (v) => {
  const tv = v.tv;
  return `${v.id},${v.state},${v.x},${v.y},${v.heading},${v.battery},${v.trips},${v.loadedDistance},${v.emptyDistance},${v.parkDistance},${v.load.length},${v.visible},${tv ? tv.teleports : ''},${tv && tv.waiting ? 1 : 0}`;
};

/** The number of listeners on the event bus of a simulation (named and wildcard). */
export function listenerCount(sim) {
  let n = sim._wildcards.length;
  for (const list of sim._listeners.values()) n += list.length;
  return n;
}

/**
 * Run `plant` for `horizon` simulated seconds in one collector mode and digest everything a user of the simulation can observe: every event of the bus (as a line of ids and numbers),
 * the poses, states and counters of every vehicle and station every `sampleEvery` ticks, the KPI text now and then and at the end, the heat map, the traffic statistics and the
 * deadlock list. Two runs of the same plant are the same run exactly when the digests are equal.
 * @returns {{ digest: string, events: number, ticks: number, sim: object, forced: boolean }}
 */
export function runTrace(plant, mode, { horizon = 600, sampleEvery = 50, Sim = Simulation } = {}) {
  const sim = new Sim(plant.layout, { seed: plant.seed });
  const h = createHash('sha1');
  let events = 0;
  sim.on('*', (p, name) => {
    events++;
    h.update(`E${name}|${p.t}|${p.order ? p.order.id : ''}|${p.vehicle ? p.vehicle.id : p.vehicleId || ''}|${p.stationId || ''}|${p.load ? p.load.id : ''}|${p.waitForPickup ?? ''}|${p.leadTime ?? ''}|${p.truck ? p.truck.id : ''}\n`);
  });
  const actions = (plant.actions || []).map((a) => ({ ...a }));
  const T = horizon;
  const schedule = {
    plain: [], on: [[0, 'on']], toggle: [[0, 'on'], [0.2, 'off'], [0.45, 'on'], [0.7, 'off'], [0.85, 'on']], late: [[0.4, 'on']], enableTwice: [[0, 'on'], [0.3, 'on'], [0.6, 'off']],
    'dropped-afterTick': [[0, 'on'], [0.5, 'break-afterTick']], 'dropped-listener': [[0, 'on'], [0.5, 'break-listeners']], 'drop-reenable': [[0, 'on'], [0.4, 'break-afterTick'], [0.7, 'on']],
  }[mode].map(([at, what]) => [at * T, what]);
  let forced = false;
  let tick = 0;
  while (sim.time < T - 1e-9) {
    while (schedule.length && schedule[0][0] <= sim.time + 1e-9) {
      const [, what] = schedule.shift();
      if (what === 'on') sim.enableDetail();
      else if (what === 'off') sim.disableDetail();
      else if (sim.detail) {
        const det = sim.detail;
        forced = true;
        if (what === 'break-afterTick') det.afterTick = () => { throw new Error('boom'); };
        else det.onCompleted = det.onDelivered = det.onPicked = det.onTruckReady = det.onTruckDeparted = () => { throw new Error('boom'); };
      }
    }
    while (actions.length && actions[0].at <= sim.time + 1e-9) {
      const a = actions.shift();
      if (a.kind === 'demand') { if (a.value === 0) sim.logistics.setRuntime({ demandFactor: 0 }); else sim.setRuntime({ demandFactor: a.value }); }
      else if (a.kind === 'runtime') sim.setRuntime(a.patch);
      else if (a.kind === 'removeVehicle' && sim.logistics.vehicles.length) sim.logistics.removeVehicle(sim.logistics.vehicles[a.index % sim.logistics.vehicles.length]);
    }
    sim.step();
    tick++;
    if (tick % sampleEvery === 0) {
      h.update(`T${sim.time}\n`);
      for (const v of sim.vehicles) h.update(`${vehicleLine(v)}\n`);
      for (const s of sim.stations) h.update(`${s.id},${s.state},${s.produced},${s.consumed},${s.arrivals},${s.fillLabel}\n`);
      if (tick % (sampleEvery * 20) === 0) h.update(JSON.stringify(sim.kpis()));
    }
  }
  h.update(`FINAL${JSON.stringify(sim.kpis())}`);
  h.update(JSON.stringify(sim.heat()));
  const ts = sim.traffic.stats;
  for (const k of Object.keys(ts).sort()) h.update(`${k}:${ArrayBuffer.isView(ts[k]) ? Array.from(ts[k]).join(',') : JSON.stringify(ts[k])}\n`);
  const lg = sim.logistics;
  h.update([lg.liveLoads, lg.completed, lg.createdBySources, lg.createdByProcesses, lg.loadsConsumed, lg.ordersDelivered, lg.deadlocks, lg.activeOrders.size, lg.loadSeq, lg.orderSeq].join(','));
  h.update(JSON.stringify(sim.deadlocks));
  return { digest: h.digest('hex'), events, ticks: tick, sim, forced };
}

/** Which corners a finished run reached (it needs the collector for the leg flags; without one only the simulation's own counters). */
export function featuresOf(sim) {
  const f = { relocated: 0, zero: 0, paused: 0, partial: 0, rerouted: 0, waitCell: 0, dead: 0, broken: 0, charged: 0, deadlocks: sim.traffic.stats.deadlocks, legs: 0, balanced: 0 };
  for (const v of sim.vehicles) { if (v.state === 'dead') f.dead++; if (v.breakdowns > 0) f.broken++; }
  const det = sim.detail;
  if (det) {
    const legs = det.legs;
    f.legs = legs.size;
    f.charged = det.charges.count;
    f.balanced = det.balanceFiled;
    for (let k = 0; k < legs.size; k++) {
      const flags = legs.flags[legs.at(k)];
      if (flags & FLAG.RELOCATED) f.relocated++;
      if (flags & FLAG.ZERO) f.zero++;
      if (flags & FLAG.PAUSED) f.paused++;
      if (flags & FLAG.PARTIAL) f.partial++;
      if (flags & FLAG.REROUTED) f.rerouted++;
      if (flags & FLAG.WAIT_CELL) f.waitCell++;
    }
  }
  return f;
}

// ---- the write barrier ---------------------------------------------------------------------------------------------------------------------

const MUTATORS_OF_COLLECTIONS = new Set(['set', 'delete', 'clear', 'add']);
const MUTATORS_OF_TYPED_ARRAYS = new Set(['set', 'fill', 'sort', 'reverse', 'copyWithin']);

/**
 * A deep read-only view of a Simulation. Hand it to `new Detail(view)`: every object the collector reaches through it is wrapped (one wrapper per object, so identities compare the way
 * they do on the real thing), a method of a simulation object runs with the wrapper as `this` (so a write inside a getter or a pure-looking method is caught too), the payloads of
 * the events it listens to are wrapped, and every set / define / delete / mutating Map, Set or typed-array call is pushed to `violations` as a path and still carried out.
 * `sim.detail` and `sim.detailError` are the seam's own and may be set.
 * @param {object} sim a Simulation
 * @param {string[]} violations receives one entry per write
 */
export function readOnlyView(sim, violations) {
  const cache = new WeakMap();
  const wrap = (value, path) => {
    if (value === null || typeof value !== 'object') return value;
    const known = cache.get(value);
    if (known) return known;
    const isCollection = value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet;
    const isTyped = ArrayBuffer.isView(value);
    const view = new Proxy(value, {
      get(target, key) {
        if (isCollection || isTyped) { // built-ins need their own `this`; the mutators are reported
          const member = Reflect.get(target, key, target);
          if (typeof member !== 'function') return member;
          const mutator = isCollection ? MUTATORS_OF_COLLECTIONS.has(key) : MUTATORS_OF_TYPED_ARRAYS.has(key);
          return (...args) => {
            if (mutator) violations.push(`${path}.${String(key)}() on a ${target.constructor.name}`);
            const result = member.apply(target, args);
            return isCollection && key === 'get' ? wrap(result, `${path}.get(${String(args[0]).slice(0, 30)})`) : result;
          };
        }
        const member = Reflect.get(target, key, view);
        if (typeof member === 'function' || typeof key === 'symbol') return member;
        return wrap(member, `${path}.${key}`);
      },
      set(target, key, v) { violations.push(`${path}.${String(key)} = ${v !== null && typeof v === 'object' ? 'object' : String(v).slice(0, 30)}`); return Reflect.set(target, key, v); },
      defineProperty(target, key, descriptor) { violations.push(`${path} defineProperty ${String(key)}`); return Reflect.defineProperty(target, key, descriptor); },
      deleteProperty(target, key) { violations.push(`${path} delete ${String(key)}`); return Reflect.deleteProperty(target, key); },
      setPrototypeOf() { violations.push(`${path} setPrototypeOf`); return false; },
    });
    cache.set(value, view);
    return view;
  };
  const root = new Proxy(sim, {
    get(target, key) {
      if (key === 'on') return (name, fn) => target.on(name, (payload, eventName) => fn(wrap(payload, `event:${name}`), eventName));
      const member = Reflect.get(target, key, root);
      if (typeof member === 'function') return member.bind(target);
      return typeof key === 'symbol' ? member : wrap(member, `sim.${key}`);
    },
    set(target, key, v) {
      if (key !== 'detail' && key !== 'detailError') violations.push(`sim.${String(key)} = ...`);
      return Reflect.set(target, key, v);
    },
  });
  return root;
}

// ---- the runner on the real engine ---------------------------------------------------------------------------------------------------------

/**
 * The real runner (js/ui/runner.js) on the real engine, a real store, a fake clock that moves `tick` milliseconds at every reading and fake animation frames.
 * Every Simulation the runner builds is kept in `made` (the displayed one, the replacement being pre-rolled and the paired control run of the impact card).
 * @returns {{ runner, store, made: object[], errors: Error[], frame(ms?): void, until(cond, max?): number, play(speed?): Promise<void>, runTo(seconds): Promise<void> }}
 */
export function runnerRig({ id = 'two-lines', layout = null, speed = 600, tick = 1 } = {}) {
  const made = [];
  class TrackedSimulation extends Simulation {
    constructor(...args) { super(...args); made.push(this); }
  }
  const clock = { t: 5000 };
  const handles = new Set();
  let queued = null;
  let seq = 0;
  const raf = (cb) => { const handle = ++seq; handles.add(handle); queued = { handle, cb }; return handle; };
  const caf = (handle) => { handles.delete(handle); if (queued && queued.handle === handle) queued = null; };
  const store = createStore({ storage: undefined });
  store.newProject(layout || EXAMPLES.find((e) => e.id === id).build());
  const errors = [];
  const runner = createRunner({
    store, renderer: { sim: null, layout: null, render() {} }, raf, caf, now: () => { clock.t += tick; return clock.t; }, document: undefined,
    SimulationClass: TrackedSimulation, onError: (error) => errors.push(error), speed,
  });
  const rig = {
    runner, store, made, errors,
    frame(ms = 16) { const { handle, cb } = queued; queued = null; handles.delete(handle); clock.t += ms; cb(clock.t); },
    until(cond, max = 4000) { for (let i = 0; i < max; i++) { if (cond()) return i; rig.frame(); } throw new Error('the condition was not reached'); },
    async play(s = speed) { rig.frame(); runner.setSpeed(s); await runner.play(); },
    async runTo(seconds) { await rig.play(); rig.until(() => runner.time >= seconds); },
  };
  return rig;
}

// ---- an independent observer ---------------------------------------------------------------------------------------------------------------

const BASE_SLOT_OF = { toPickup: 'driving', toDrop: 'driving', toCharger: 'driving', toPark: 'driving', loading: 'loading', unloading: 'unloading', idle: 'idle', parked: 'parked', charging: 'charging', broken: 'broken', dead: 'broken' };
export const SPLIT_KEYS = Object.freeze(['driving', 'waiting', 'dockQueue', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken']);
const DRIVING = new Set(['toPickup', 'toDrop', 'toCharger', 'toPark']);

/**
 * Run `plant` with the collector on and watch it from outside with the plain public surface of the simulation, after every tick:
 *   cum / snapshots   seconds per vehicle and time slot since the collector's window began (the slot of a state, a driving vehicle that `tv.waiting` is waiting, or queued for a dock
 *                     when the dock book says so), and a copy of them at the first tick at or after every 30 s of window time (what the collector's ring is supposed to hold)
 *   cells / queueCells waiting seconds per vehicle and road cell (the cell traffic books the waiting on), and the part of them that was a queue for a dock
 *   deliveries        every 'orderDelivered' of the window
 *   nodeWait          traffic's own sum of waiting seconds booked on cells since the window began
 *   routes            path id -> the cells of the route object the collector interned under it
 * Actions of the plant are applied (a removal restarts the collector's window: the observer restarts with it). dt / warmup override the plant's settings.
 */
export function observedRun(plant, { horizon = 1800, dt, warmup } = {}) {
  const patch = {};
  if (dt !== undefined) patch.dt = dt;
  if (warmup !== undefined) patch.warmup = warmup;
  const layout = Object.keys(patch).length ? withSettings(plant, patch).layout : plant.layout;
  const sim = new Simulation(layout, { seed: plant.seed });
  const det = sim.enableDetail();
  const obs = { sim, det, deliveries: [], snapshots: [], restarts: 0, nodeWaitBase: 0, routes: new Map() };
  if (!det) return obs;
  const wait = () => { let s = 0; for (const x of sim.traffic.stats.nodeWait) s += x; return s; };
  const fresh = () => {
    const n = sim.vehicles.length;
    obs.n = n; obs.cum = new Float64Array(n * 9); obs.cells = Array.from({ length: n }, () => new Map()); obs.queueCells = Array.from({ length: n }, () => new Map()); obs.snapshots = [];
    obs.deliveries = []; obs.nodeWaitBase = wait(); obs.windowStart = det.windowStart; obs.nextSnap = det.windowStart + 30;
    obs.snapshots.push({ t: det.windowStart, cum: Float64Array.from(obs.cum) });
    // every distinct route the collector logs, as the cells of the route object it came from (a restart gives the collector a new path pool: the ids begin again)
    obs.routes = new Map();
    const intern = det.pool.intern.bind(det.pool);
    det.pool.intern = (route) => { const id = intern(route); if (id >= 0 && !obs.routes.has(id)) obs.routes.set(id, Array.from(route.nodes)); return id; };
  };
  fresh();
  sim.on('orderDelivered', (ev) => obs.deliveries.push({ veh: ev.vehicle.id, from: ev.order.from, to: ev.order.to, flow: ev.order.flowId, qty: ev.order.qty }));
  const actions = (plant.actions || []).map((a) => ({ ...a }));
  const docks = sim.logistics.docks;
  let lastStart = det.windowStart;
  let lastDet = det;
  while (sim.time < horizon - 1e-9) {
    while (actions.length && actions[0].at <= sim.time + 1e-9) {
      const a = actions.shift();
      if (a.kind === 'demand') { if (a.value === 0) sim.logistics.setRuntime({ demandFactor: 0 }); else sim.setRuntime({ demandFactor: a.value }); }
      else if (a.kind === 'removeVehicle' && sim.logistics.vehicles.length) { sim.logistics.removeVehicle(sim.logistics.vehicles[a.index % sim.logistics.vehicles.length]); obs.restarts++; }
    }
    sim.step();
    if (sim.detail !== lastDet || !sim.detail) { obs.dropped = true; break; }
    if (det.windowStart !== lastStart || det.nV !== obs.n) { lastStart = det.windowStart; fresh(); continue; } // a new window began in this tick (the end of the warm-up, a restart): that tick is not counted
    const step = sim.dt;
    for (let i = 0; i < obs.n; i++) {
      const vr = sim.vehicles[i];
      const tv = vr.tv;
      let slot = SPLIT_KEYS.indexOf(BASE_SLOT_OF[vr.state] ?? 'idle');
      if (tv.waiting && DRIVING.has(vr.state)) {
        const node = sim.traffic.waitNodeOf(tv);
        obs.cells[i].set(node, (obs.cells[i].get(node) || 0) + step);
        const queued = vr.dock !== null && docks.waitsForDock(vr, vr.dock);
        if (queued) obs.queueCells[i].set(node, (obs.queueCells[i].get(node) || 0) + step);
        slot = queued ? 2 : 1;
      }
      obs.cum[i * 9 + slot] += step;
    }
    if (sim.time + 1e-9 >= obs.nextSnap) { obs.snapshots.push({ t: sim.time, cum: Float64Array.from(obs.cum) }); obs.nextSnap += 30; }
  }
  obs.nodeWait = wait() - obs.nodeWaitBase;
  return obs;
}
