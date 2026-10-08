// Station runtime (StationRT) of the logistics layer: sources, workstations, storage, sinks and depots.
// Owns everything that happens *inside* a station: arrival schedules, the yard, machine cycles with
// bills of materials, breakdowns and blocking, dwell, queue capacities and inbound reservations.
// Vehicles and the dispatcher live in vehicles.js / dispatcher.js and touch stations only through the
// small API exported here. See docs/ARCHITECTURE.md 5.3.
//
// Load bookkeeping (the conservation law asserted by the tests):
//   created   = loads made by sources + loads made as process output
//   live      = loads in yards, queues, storage, machines (finished outputs), vehicles
//               + input loads of running cycles (they stay in WIP until the cycle ends)
//   retired   = completed (sink / process without outgoing flow) + inputs of finished cycles
//   created === live + retired  at all times.
//
// Per-type meaning of the counters: produced = loads made (source, process) or released to a vehicle
// (storage); consumed = inputs of finished cycles (process) or loads received (storage, sink);
// arrivals = loads delivered by vehicles, for a source the number of arrival events (a batch counts once).

import { defaultStationParams } from '../../model/defaults.js';
import { sampleDist } from '../../util/rng.js';
import { Swrr } from './swrr.js';
import {
  EPS, MAX_CYCLES_PER_STEP, MAX_MACHINES, MIN_CYCLE, MIN_GAP, MIN_REPAIR, YARD_LIMIT, atLeast, cleanDist, removeFromQueue, whole,
} from './common.js';

/** Upper bound of the state changes (cycle ends, failures, repairs) one machine goes through within a single tick. */
const MAX_MACHINE_STEPS = 4 * MAX_CYCLES_PER_STEP;

/** Sanitised, defaulted copy of a layout station's params (never throws, never contains NaN). */
function stationParams(def) {
  const base = defaultStationParams(def.type);
  const raw = def.params && typeof def.params === 'object' ? def.params : {};
  switch (def.type) {
    case 'source':
      return {
        interArrival: cleanDist(raw.interArrival, base.interArrival),
        batch: whole(raw.batch, 1, base.batch),
        outCap: whole(raw.outCap, 0, base.outCap),
        startDelay: atLeast(raw.startDelay, 0, 0),
      };
    case 'process':
      return {
        cycle: cleanDist(raw.cycle, base.cycle),
        machines: Math.min(MAX_MACHINES, whole(raw.machines, 0, base.machines)),
        outPerCycle: whole(raw.outPerCycle, 0, base.outPerCycle),
        inCap: whole(raw.inCap, 0, base.inCap),
        outCap: whole(raw.outCap, 0, base.outCap),
        mtbf: atLeast(raw.mtbf, 0, 0),
        mttr: atLeast(raw.mttr, 0, 0),
      };
    case 'storage':
      return { capacity: whole(raw.capacity, 0, base.capacity), dwell: atLeast(raw.dwell, 0, 0) };
    case 'depot': {
      const slots = whole(raw.slots, 0, base.slots);
      return { slots, chargers: Math.min(slots, whole(raw.chargers, 0, base.chargers)) };
    }
    default:
      return {};
  }
}

const ratio = (n, cap) => (cap > 0 ? Math.min(1, n / cap) : n > 0 ? 1 : 0);

export class StationRT {
  /**
   * @param {object} def the layout station
   * @param {object} rng this station's own stream (`rng.fork('station:' + id)`)
   */
  constructor(def, rng) {
    this.id = def.id;
    this.type = def.type;
    this.def = def;
    this.params = stationParams(def);
    this.produced = 0;
    this.consumed = 0;
    this.arrivals = 0;
    this.breakdowns = 0;
    /** Per-flow queues, keyed by flow id. inQ: process inputs; outQ: loads waiting for pickup. */
    this.inQ = new Map();
    this.outQ = new Map();
    /** Space reserved by orders that are on their way here, per incoming flow id. */
    this.inbound = new Map();
    this.inboundTotal = 0;
    /** Wired by Logistics: { flow, queue, cap, claimed } per outgoing flow, { flow, queue, perCycle } per incoming flow. */
    this.outLinks = [];
    this.inLinks = [];
    this.swrr = null;
    this.hasRoom = null;
    this.rng = rng;
    if (this.type === 'source') this.initSource();
    else if (this.type === 'process') this.initProcess();
    else if (this.type === 'storage') this.pool = [];
    else if (this.type === 'depot') this.initDepot();
  }

  initSource() {
    const { interArrival, startDelay } = this.params;
    this.rngArrival = this.rng.fork('arrival');
    this.yardQ = [];
    /** Loads that were never created because the yard was full (YARD_LIMIT). */
    this.dropped = 0;
    /** A source whose mean inter-arrival time is 0 never produces. */
    this.enabled = interArrival.mean > 0;
    this.nextArrival = this.enabled ? startDelay : Infinity;
  }

  initProcess() {
    const { machines, mtbf, mttr } = this.params;
    this.rngCycle = this.rng.fork('cycle');
    this.rngFail = this.rng.fork('fail');
    this.failing = mtbf > 0 && mttr > 0;
    this.machines = Array.from({ length: machines }, () => ({
      state: 'idle',
      remaining: 0,
      cycleTime: 0,
      progress: 0,
      holding: [],
      /** Input loads inside the running cycle (consumed from inQ, still counted as WIP). */
      inputs: 0,
      /** createdAt handed to the outputs: the oldest input's. */
      born: 0,
      /** Calendar time of the next failure, and (while down) of the end of the repair. */
      failAt: this.failing ? this.rngFail.exp(mtbf) : Infinity,
      upAt: 0,
      /** Repair time still to go as of the last tick (display). */
      repairLeft: 0,
      downFrom: 'idle',
    }));
  }

  initDepot() {
    this.slots = this.params.slots;
    this.chargers = this.params.chargers;
    this.parked = [];
    this.charging = [];
    /** Parking places / chargers promised to vehicles that are still driving here. */
    this.reservedSlots = 0;
    this.reservedChargers = 0;
    /** Since when a parked vehicle with work has been unable to leave (null: it can). */
    this.blockedSince = null;
  }

  /** Loads that arrived at a source but found the output buffer full (count; the loads are in `yardQ`). */
  get yard() {
    return this.yardQ ? this.yardQ.length : 0;
  }

  /** Loads queued for pickup (storage: everything held). */
  get outCount() {
    let n = this.pool ? this.pool.length : 0;
    for (const link of this.outLinks) n += link.queue.length;
    return n;
  }

  /** Loads waiting in input queues (workstations only). */
  get inCount() {
    let n = 0;
    for (const link of this.inLinks) n += link.queue.length;
    return n;
  }

  /** Storage: all held loads. */
  get held() {
    return this.type === 'storage' ? this.outCount : 0;
  }

  /** Input loads of running cycles (workstations). */
  get inProcess() {
    let n = 0;
    if (this.machines) for (const m of this.machines) n += m.inputs;
    return n;
  }

  get state() {
    switch (this.type) {
      case 'source': return this.yardQ.length > 0 ? 'blocked' : 'normal';
      case 'process': return aggregateState(this.machines);
      case 'storage': return this.outCount >= this.params.capacity ? 'full' : 'normal';
      default: return 'normal';
    }
  }

  /** 0..1 buffer fill: source output buffer, workstation input buffers, storage, depot occupancy. */
  get fill() {
    switch (this.type) {
      case 'source': return ratio(this.outCount, this.outCapacity()) || (this.yardQ.length > 0 ? 1 : 0);
      case 'process': return ratio(this.inCount, this.inLinks.length * this.params.inCap);
      case 'storage': return ratio(this.outCount, this.params.capacity);
      case 'depot': return ratio(this.parked.length + this.charging.length, this.slots);
      default: return 0;
    }
  }

  get fillLabel() {
    switch (this.type) {
      case 'source': return `${this.outCount}/${this.outCapacity()}${this.yardQ.length ? ` +${this.yardQ.length}` : ''}`;
      case 'process': return `${this.inCount}/${this.inLinks.length * this.params.inCap}`;
      case 'storage': return `${this.outCount}/${this.params.capacity}`;
      case 'depot': return `${this.parked.length + this.charging.length}/${this.slots}`;
      default: return '';
    }
  }

  outCapacity() {
    let cap = 0;
    for (const link of this.outLinks) cap += link.cap;
    return cap;
  }

  /** Free parking places (not counting vehicles that are driving here). */
  get freeSlots() {
    return this.slots - this.parked.length - this.charging.length - this.reservedSlots;
  }

  get freeChargers() {
    return this.chargers - this.charging.length - this.reservedChargers;
  }
}

/** 'down' if all machines are down (or there are none), else 'busy', 'blocked' (none busy) or 'starved'. */
function aggregateState(machines) {
  let down = 0;
  let busy = false;
  let blocked = false;
  for (const m of machines) {
    if (m.state === 'down') down++;
    else if (m.state === 'busy') busy = true;
    else if (m.state === 'blocked') blocked = true;
  }
  if (down === machines.length) return 'down';
  if (busy) return 'busy';
  return blocked ? 'blocked' : 'starved';
}

/**
 * Finish construction once all flows are wired: the weighted round-robin over outgoing flows and the
 * eligibility test it uses (a free output slot; storage accepts anything, its capacity is global).
 */
export function finalizeStation(st) {
  st.swrr = new Swrr(st.outLinks.map((link) => link.flow.def.weight));
  st.hasRoom = st.type === 'storage' ? () => true : (i) => st.outLinks[i].queue.length < st.outLinks[i].cap;
}

// ---- space & reservations ---------------------------------------------------------------------------------

/** Free space for new inbound loads of `flow` at its destination (reservations already deducted). */
export function flowSpace(flow) {
  const to = flow.to;
  switch (to.type) {
    case 'process': return to.params.inCap - flow.inLink.queue.length - to.inbound.get(flow.id);
    case 'storage': return to.params.capacity - to.outCount - to.inboundTotal;
    default: return Infinity;
  }
}

/** Most loads of `flow` the destination could ever hold (sink: unlimited). */
export function flowCapacity(flow) {
  switch (flow.to.type) {
    case 'process': return flow.to.params.inCap;
    case 'storage': return flow.to.params.capacity;
    default: return Infinity;
  }
}

export function reserveInbound(flow, qty) {
  flow.to.inbound.set(flow.id, flow.to.inbound.get(flow.id) + qty);
  flow.to.inboundTotal += qty;
}

/** The reservation for `qty` loads of `flow` at its destination ends (delivered, or the order was given up). */
export function releaseInbound(flow, qty) {
  flow.to.inbound.set(flow.id, flow.to.inbound.get(flow.id) - qty);
  flow.to.inboundTotal -= qty;
}

/**
 * Loads of `flow` at its origin that are ready for pickup and not yet claimed (at most `limit` counted).
 * `age` is how long the oldest of them has been ready, `next` when the first load that is not ready yet will be
 * (Infinity if none): the dispatcher wakes up then.
 * @returns {{ count: number, age: number, oldest: number, next: number }}
 */
export function readyLoads(flow, t, limit) {
  const link = flow.outLink;
  const q = link.queue;
  let n = 0;
  let next = Infinity;
  for (let i = link.claimed; i < q.length && n < limit; i++) {
    if (q[i].readyAt > t + EPS) { next = q[i].readyAt; break; }
    n++;
  }
  const oldest = n > 0 ? q[link.claimed].readyAt : Infinity;
  return { count: n, age: n > 0 ? t - oldest : 0, oldest, next };
}

/**
 * An order that has not picked up its loads is given up: they become available again, right behind the loads other
 * orders still hold (so the claimed loads stay a prefix of the queue), oldest first.
 */
export function unclaimLoads(flow, loads) {
  const link = flow.outLink;
  removeFromQueue(link.queue, new Set(loads));
  link.claimed -= loads.length;
  link.queue.splice(link.claimed, 0, ...loads);
  for (const load of loads) load.claimed = false;
}

// ---- delivery -----------------------------------------------------------------------------------------------

/** Loads of an order arrive at their destination: release the reservation and hand them over. */
export function acceptLoads(flow, loads, t, lg) {
  const st = flow.to;
  releaseInbound(flow, loads.length);
  st.arrivals += loads.length;
  for (const load of loads) load.claimed = false;
  if (st.type === 'sink') {
    st.consumed += loads.length;
    for (const load of loads) lg.completeLoad(load, st, t);
  } else if (st.type === 'storage') {
    st.consumed += loads.length;
    for (const load of loads) storeLoad(st, load, t);
    lg.markDirty();
  } else {
    for (const load of loads) flow.inLink.queue.push(load);
  }
}

/** A load enters storage: routed to an outgoing flow (weighted round-robin) and available after `dwell`. */
function storeLoad(st, load, t) {
  load.readyAt = t + st.params.dwell;
  if (st.outLinks.length === 0) { st.pool.push(load); return; }
  st.outLinks[st.swrr.pick(st.hasRoom)].queue.push(load);
}

// ---- per-tick behaviour -------------------------------------------------------------------------------------

/** Advance one station by `dt` (sources and workstations; storage, sinks and depots are passive). */
export function stepStation(st, dt, t, lg) {
  if (st.type === 'source') stepSource(st, t, lg);
  else if (st.type === 'process') stepProcess(st, dt, t, lg);
}

function nextGap(st, lg) {
  const f = lg.runtime.demandFactor;
  if (!(f > 0)) return Infinity;
  return Math.max(MIN_GAP, sampleDist(st.rngArrival, st.params.interArrival, 1 / f));
}

function stepSource(st, t, lg) {
  const { batch } = st.params;
  while (st.nextArrival <= t + EPS) {
    const at = st.nextArrival;
    const made = Math.min(batch, YARD_LIMIT - st.yardQ.length);
    for (let i = 0; i < made; i++) st.yardQ.push(lg.createLoad(st, at, t, 'source'));
    st.dropped += batch - made;
    st.arrivals++;
    st.produced += made;
    st.nextArrival = at + nextGap(st, lg);
  }
  flushYard(st, t, lg);
}

/** Move yard loads into the output buffers of outgoing flows (weighted round-robin among flows with room). */
function flushYard(st, t, lg) {
  const yard = st.yardQ;
  while (yard.length > 0) {
    const i = st.swrr.pick(st.hasRoom);
    if (i < 0) return;
    const load = yard.shift();
    load.readyAt = t;
    st.outLinks[i].queue.push(load);
    lg.markDirty();
  }
}

function stepProcess(st, dt, t, lg) {
  for (const m of st.machines) stepMachine(st, m, dt, t, lg);
}

/**
 * One machine for one tick: accounts for the interval (t - dt, t] that has just ended. Cycle ends, failures and
 * repairs happen at their exact times inside the interval (cycle clocks and breakdown times do not depend on dt),
 * while everything that needs the buffers (releasing outputs, taking inputs) is decided with the state at the tick
 * time t, which is when other parts of the plant change it. A cycle that ends mid-tick hands the rest of the interval
 * to the next cycle when that starts at once, so throughput does not depend on dt. Breakdowns run on calendar time:
 * a machine can fail while idle or blocked, and a running cycle is frozen while it is down.
 */
function stepMachine(st, m, dt, t, lg) {
  let at = t - dt; // the interval is accounted for up to here
  for (let n = 0; n < MAX_MACHINE_STEPS; n++) {
    if (m.state === 'down') {
      if (m.upAt > t + EPS) { m.repairLeft = m.upAt - t; return; }
      at = Math.max(at, m.upAt);
      repairMachine(st, m, at, lg, t);
      continue;
    }
    if (m.failAt <= at + EPS) { failMachine(st, m, lg, t); continue; }
    const until = Math.min(t, m.failAt);
    if (m.state === 'busy') {
      const span = Math.max(0, until - at);
      if (m.remaining > span + EPS) { // still busy when the interval, or the time to the failure, ends
        m.remaining -= span;
        m.progress = Math.min(1, Math.max(0, 1 - m.remaining / m.cycleTime));
        at = until;
      } else {
        at += m.remaining;
        finishCycle(st, m, t, lg);
        if (m.state === 'idle') startCycle(st, m, t, lg); // back to back: the next cycle starts at once
        continue;
      }
    } else {
      at = until; // idle or blocked: only events at the tick time can change that
      if (at < t - EPS) continue; // a failure comes first
      if (m.state === 'blocked') releaseOutputs(st, m, t, lg);
      if (m.state === 'idle') startCycle(st, m, t, lg);
      return;
    }
    if (at >= t - EPS) return;
  }
}

/** Take the inputs (perCycle from every incoming flow) and start a cycle; false when inputs are missing. */
function startCycle(st, m, t, lg) {
  const links = st.inLinks;
  for (const link of links) if (link.queue.length < link.perCycle) return false;
  let born = Infinity;
  let taken = 0;
  for (const link of links) {
    const q = link.queue;
    for (let i = 0; i < link.perCycle; i++) if (q[i].createdAt < born) born = q[i].createdAt;
    q.splice(0, link.perCycle);
    taken += link.perCycle;
  }
  if (taken > 0) lg.markDirty(); // input space was freed
  m.inputs = taken;
  m.born = taken > 0 ? born : t;
  m.cycleTime = Math.max(MIN_CYCLE, sampleDist(st.rngCycle, st.params.cycle, lg.runtime.processFactor));
  m.remaining = m.cycleTime;
  m.progress = 0;
  m.state = 'busy';
  return true;
}

/** The cycle is done: inputs are retired, outputs are made and released (or held when the buffers are full). */
function finishCycle(st, m, t, lg) {
  lg.retireInputs(m.inputs);
  st.consumed += m.inputs;
  m.inputs = 0;
  const outputs = st.params.outPerCycle;
  for (let i = 0; i < outputs; i++) m.holding.push(lg.createLoad(st, m.born, t, 'process'));
  st.produced += outputs;
  m.progress = 1;
  m.state = 'blocked';
  releaseOutputs(st, m, t, lg);
}

/** Route held outputs to outgoing flows with room (no outgoing flow: the load leaves the system). */
function releaseOutputs(st, m, t, lg) {
  const held = m.holding;
  while (held.length > 0) {
    if (st.outLinks.length === 0) { lg.completeLoad(held.shift(), st, t); continue; }
    const i = st.swrr.pick(st.hasRoom);
    if (i < 0) { m.state = 'blocked'; return false; }
    const load = held.shift();
    load.readyAt = t;
    st.outLinks[i].queue.push(load);
    lg.markDirty();
  }
  m.progress = 0;
  m.state = 'idle';
  return true;
}

/** The machine fails at its scheduled time `m.failAt` (inside the tick that ends at `t`). */
function failMachine(st, m, lg, t) {
  m.downFrom = m.state;
  m.state = 'down';
  m.upAt = m.failAt + Math.max(MIN_REPAIR, st.rngFail.exp(st.params.mttr));
  m.repairLeft = m.upAt - t;
  st.breakdowns++;
  lg.emit('machineDown', { station: st, stationId: st.id, machine: st.machines.indexOf(m), t });
}

/** The repair ends at `at` (inside the tick that ends at `t`); the machine goes on where it was. */
function repairMachine(st, m, at, lg, t) {
  m.state = m.downFrom;
  m.repairLeft = 0;
  m.failAt = at + st.rngFail.exp(st.params.mtbf);
  lg.emit('machineUp', { station: st, stationId: st.id, machine: st.machines.indexOf(m), t });
}

// ---- live what-if changes -----------------------------------------------------------------------------------

/**
 * demandFactor changed: the pending arrival keeps its place in the (rescaled) arrival process, so a slider
 * drag takes effect at once instead of after the next, possibly very distant, arrival. The first arrival of a source
 * is not part of that process: it comes at startDelay, a fixed offset, whatever the demand.
 */
export function rescaleArrivals(st, oldFactor, newFactor, now, lg) {
  if (!st.enabled) return;
  if (!(newFactor > 0)) { st.nextArrival = Infinity; return; }
  if (!(oldFactor > 0)) {
    st.nextArrival = st.arrivals === 0 ? Math.max(st.params.startDelay, now) : now + nextGap(st, lg);
    return;
  }
  if (st.arrivals === 0) return;
  st.nextArrival = now + Math.max(0, st.nextArrival - now) * (oldFactor / newFactor);
}

/**
 * processFactor changed: running cycles speed up or slow down proportionally. The machines have accounted for time
 * up to the start of the last tick, so the last `pending` seconds of a running cycle were still driven by the old factor.
 */
export function rescaleCycles(st, oldFactor, newFactor, pending) {
  const r = newFactor / oldFactor;
  for (const m of st.machines) {
    if (m.state === 'busy') {
      if (m.remaining > pending) m.remaining = (m.remaining - pending) * r + pending;
      m.cycleTime *= r;
    } else if (m.state === 'down' && m.downFrom === 'busy') {
      m.remaining *= r;
      m.cycleTime *= r;
    }
  }
}
