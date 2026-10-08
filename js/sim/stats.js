// Stats - KPI collection for a running simulation (docs/ARCHITECTURE.md section 5.4).
//
// Responsibility: read the public runtime fields of the traffic and logistics modules once per tick
// (sample), listen to the three events that carry data nothing else exposes (loadCompleted,
// orderDelivered, deadlock) and condense both into a JSON-serialisable KpiReport. It never mutates the sim.
//
// Measurement window: everything is relative to the last reset(). Time-weighted figures integrate the
// sampled value over dt, so they are exact for piecewise-constant signals. Cumulative counters kept by other
// modules (traffic.stats arrays, vehicle trips/distances, station produced/consumed/arrivals) are
// snapshotted at reset and reported as deltas. The window length is the sum of the sampled dt values.
//
// Hot path: sample(dt) runs up to ~12,000 times per real second. It only reads fields and adds to
// preallocated typed arrays: no arrays, objects or closures are created per tick. Everything that
// allocates (report, heat, the rebuild after a shape change) lives outside it.
//
// How the open points of the spec were resolved (also listed in the engineer's report):
//  * Process stations: starved / blocked / down / utilization are shares of machine-time, so
//    busy + starved + blocked + down = 1 ('idle' machines count as starved). `breakdowns` counts machines
//    entering 'down', observed from the sampled machine states (the machineDown payload is undocumented).
//  * Source: blocked = share of time in state 'blocked', utilization = 1 - blocked.
//    Storage: utilization = avgFill; starved / blocked = share of time completely empty / completely full.
//    Sink and depot: utilization = avgFill, the other shares are 0.
//  * Fleet shares are shares of vehicle-time. A 'dead' vehicle counts as 'broken'; a driving vehicle with
//    tv.waiting counts as 'waiting'. utilization = driving + waiting + loading + unloading (breakdowns and
//    charging are not "working"). A fleet without vehicles reports idle = 1 so shares always sum to 1.
//  * traffic.waitShare = (vehicle + junction + broken wait) / traffic.stats.drivingTime, because drivingTime
//    already contains the waiting. `traffic.brokenWait` is an addition to the documented shape.
//  * series.t is absolute sim time (window.start + k * interval). throughput is the trailing 10 minutes in
//    units/h; wip / vehiclesWorking / vehiclesWaiting are means over the interval since the previous point.
//    Reset clears the series together with every other accumulator.
//  * emptyShare, avgPickupWait, avgTransit and every lead-time statistic are null when there is no data.

/** Sim seconds between two series points (before decimation). */
export const SERIES_INTERVAL = 60;
/** Series length at which neighbouring points are merged pairwise and the spacing doubles. Must be even. */
export const SERIES_MAX_POINTS = 2000;
/** Length of the trailing-throughput window, in series intervals (10 minutes). */
export const TRAILING_INTERVALS = 10;
/** Lead-time samples kept exactly; beyond this the store thins itself out by a doubling stride. */
export const LEAD_SAMPLE_CAP = 50000;
/** Number of congestion hot spots in the report. */
export const HOTSPOT_COUNT = 10;
/** Deadlock events kept in the report (the counter keeps counting). */
export const DEADLOCK_EVENT_CAP = 50;

const NONE = Object.freeze([]);
const EPS = 1e-9;
/** A storage counts as completely full above this fill. */
const FULL = 1 - EPS;

const K_SOURCE = 0;
const K_PROCESS = 1;
const K_STORAGE = 2;
const K_OTHER = 3;

const DRIVING = 0;
const WAITING = 1;
const LOADING = 2;
const UNLOADING = 3;
const IDLE = 4;
const PARKED = 5;
const CHARGING = 6;
const BROKEN = 7;
const SLOT_KEYS = ['driving', 'waiting', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken'];
const SLOTS = SLOT_KEYS.length;
const STATE_SLOT = Object.assign(Object.create(null), {
  toPickup: DRIVING, toDrop: DRIVING, toCharger: DRIVING, toPark: DRIVING,
  loading: LOADING, unloading: UNLOADING, idle: IDLE, parked: PARKED, charging: CHARGING,
  broken: BROKEN, dead: BROKEN,
});

/** Finite, non-negative number or 0: NaN, Infinity, negatives and missing values all become 0. */
const nn = (x) => (x > 0 && x < Infinity ? x : 0);
/** Share t / den limited to [0, 1]; 0 when there is nothing to divide by. */
const share = (t, den) => (den > 0 && t > 0 ? Math.min(1, t / den) : 0);
/** Mean of a sum over n items, null when n is 0. */
const meanOf = (sum, n) => (n > 0 ? sum / n : null);
/** First argument when it is a finite non-negative number, else the second, else 0. */
const firstValid = (a, b) => (Number.isFinite(a) && a >= 0 ? a : Number.isFinite(b) && b >= 0 ? b : 0);

function kindOf(type) {
  if (type === 'source') return K_SOURCE;
  if (type === 'process') return K_PROCESS;
  if (type === 'storage') return K_STORAGE;
  return K_OTHER;
}

/**
 * Linear-interpolation percentile of an ascending array (the "R-7" definition used by spreadsheets).
 * @param {ArrayLike<number>} sorted ascending values
 * @param {number} p fraction in [0, 1] (0.95 = 95th percentile)
 * @returns {number|null} null for an empty array
 */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  const rank = Math.min(1, Math.max(0, p)) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Bounded sample store for lead times. Count, sum, min and max are exact for every sample ever added;
 * percentiles come from the retained samples. Up to `cap` samples are kept as they arrive; when the store
 * is full it keeps every second retained sample and doubles the stride, so the retained set is always the
 * arrivals 0, s, 2s, ... for the current stride s (deterministic, evenly spread over the whole window).
 * The sorted copy needed for percentiles is cached until the retained set changes.
 */
export class SampleSet {
  /** @param {number} [cap] retained samples before thinning starts (at least 2) */
  constructor(cap = LEAD_SAMPLE_CAP) {
    this.cap = Math.max(2, Math.floor(cap));
    this.clear();
  }

  clear() {
    this.items = [];
    this.stride = 1;
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this._sorted = null;
  }

  /** Add one sample; non-finite values are ignored. Returns true when the sample was counted. */
  add(x) {
    if (!Number.isFinite(x)) return false;
    const index = this.count++;
    this.sum += x;
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
    if (index % this.stride !== 0) return true;
    if (this.items.length >= this.cap) {
      this._thin();
      if (index % this.stride !== 0) return true;
    }
    this.items.push(x);
    this._sorted = null;
    return true;
  }

  /** Retained samples in ascending order. The same array instance is returned until the next change. */
  sorted() {
    if (!this._sorted) this._sorted = Float64Array.from(this.items).sort();
    return this._sorted;
  }

  /** Percentile (p in [0, 1]) of the retained samples, null when empty. */
  percentile(p) {
    return percentile(this.sorted(), p);
  }

  _thin() {
    const items = this.items;
    const kept = Math.ceil(items.length / 2);
    for (let i = 0; i < kept; i++) items[i] = items[2 * i];
    items.length = kept;
    this.stride *= 2;
    this._sorted = null;
  }
}

/** Window-relative copy of a cumulative typed array, plus its maximum. */
function windowDelta(current, snapshot, Type) {
  const out = new Type(snapshot.length);
  let max = 0;
  for (let i = 0; i < out.length; i++) {
    const d = nn(current[i] - snapshot[i]);
    out[i] = d;
    if (d > max) max = d;
  }
  return { out, max };
}

/** Number of loads in a queue that are ready for pickup at `now` (claimed or not). */
function readyLoads(queue, now) {
  let n = 0;
  if (queue) for (const load of queue) if (!(load.readyAt > now)) n++;
  return n;
}

const displayName = (st) => (st.def && st.def.name) || st.id;

export class Stats {
  /**
   * @param {{ time: number, layout: object, graph?: object, traffic: object, logistics: object, settings: object }} sim
   *   anything exposing the documented fields; read lazily, so it may be completed after construction
   */
  constructor(sim) {
    this.sim = sim;
    this.lead = new SampleSet();
    this.reset();
  }

  /** Start a fresh measurement window at the current sim time. */
  reset() {
    if (this._stale()) this._build();
    this.start = nn(this.sim.time);
    this.duration = 0;
    for (const a of this._zeroed) a.fill(0);
    this.minBat.fill(Infinity);
    this.lead.clear();
    this.aWip = 0;
    this.wipMax = 0;
    this.completed = 0;
    this.oCount = 0;
    this.oPick = 0;
    this.oTransit = 0;
    this.deadlockEvents = [];
    this.stride = 1;
    this.serK = 0;
    this.serSince = 0;
    this.serWip = 0;
    this.serWorking = 0;
    this.serWaiting = 0;
    this.sT = [];
    this.sThroughput = [];
    this.sWip = [];
    this.sWorking = [];
    this.sWaiting = [];
    this._snapshot();
  }

  /**
   * Account for one finished tick of `dt` seconds. Call once per tick, after traffic.step.
   * @param {number} dt seconds
   */
  sample(dt) {
    if (!(dt > 0 && dt < Infinity)) return;
    if (this._stale()) this.reset();
    const lg = this.sim.logistics;
    if (!lg) return;
    this.duration += dt;
    const live = nn(lg.liveLoads);
    this.aWip += live * dt;
    this.serWip += live * dt;
    if (live > this.wipMax) this.wipMax = live;
    this._sampleStations(lg.stations || NONE, dt);
    this._sampleVehicles(lg.vehicles || NONE, dt);
    const k = Math.floor((this.duration + EPS) / SERIES_INTERVAL);
    if (k > this.serK) this._closeInterval(k);
  }

  /**
   * Take note of an engine event. Only loadCompleted, orderDelivered and deadlock carry data that sampling
   * cannot see; every other event is ignored.
   * @param {string} name event name
   * @param {object} [payload] event payload as documented in section 5.3
   */
  onEvent(name, payload) {
    if (this._stale()) this.reset();
    if (name === 'loadCompleted') this._onLoadCompleted(payload || {});
    else if (name === 'orderDelivered') this._onOrderDelivered(payload || {});
    else if (name === 'deadlock') this._onDeadlock(payload || {});
  }

  /** Congestion heat of the current window: per-edge passes, per-edge and per-node waiting (veh*s) and their maxima. */
  heat() {
    if (this._stale()) this.reset();
    const ts = this._trafficStats();
    const passes = windowDelta(ts.edgePasses || NONE, this.snapEdgePasses, Int32Array);
    const edgeWait = windowDelta(ts.edgeWait || NONE, this.snapEdgeWait, Float64Array);
    const nodeWait = windowDelta(ts.nodeWait || NONE, this.snapNodeWait, Float64Array);
    return {
      edgePasses: passes.out, edgeWait: edgeWait.out, nodeWait: nodeWait.out,
      maxEdgePasses: passes.max, maxEdgeWait: edgeWait.max, maxNodeWait: nodeWait.max,
    };
  }

  /** @returns {object} the KpiReport of the current window (see section 5.4); safe to JSON.stringify */
  report() {
    if (this._stale()) this.reset();
    const dur = this.duration;
    const liveNow = nn(this.sim.logistics?.liveLoads);
    return {
      window: this._windowReport(dur),
      throughput: this._throughputReport(dur),
      leadTime: this._leadTimeReport(),
      wip: { mean: dur > 0 ? this.aWip / dur : 0, max: Math.max(this.wipMax, liveNow), now: liveNow },
      stations: this._stationsReport(dur),
      fleets: this._fleetsReport(dur),
      flows: this._flowsReport(),
      traffic: this._trafficReport(),
      orders: { completed: this.oCount, avgPickupWait: meanOf(this.oPick, this.oCount), avgTransit: meanOf(this.oTransit, this.oCount) },
      series: {
        interval: SERIES_INTERVAL * this.stride,
        t: this.sT.slice(),
        throughput: this.sThroughput.slice(),
        wip: this.sWip.slice(),
        vehiclesWorking: this.sWorking.slice(),
        vehiclesWaiting: this.sWaiting.slice(),
      },
    };
  }

  // ---- structure -----------------------------------------------------------------------------------------

  _trafficStats() {
    return (this.sim.traffic && this.sim.traffic.stats) || {};
  }

  /** True when the sim no longer has the shape the accumulators were allocated for (or none yet). */
  _stale() {
    const { logistics: lg, traffic } = this.sim;
    const ts = traffic && traffic.stats;
    return (lg && lg.stations ? lg.stations.length : 0) !== this.nSt
      || (lg && lg.vehicles ? lg.vehicles.length : 0) !== this.nVeh
      || (ts && ts.edgePasses ? ts.edgePasses.length : 0) !== this.nEdges
      || (ts && ts.nodeWait ? ts.nodeWait.length : 0) !== this.nNodes;
  }

  /** Allocate every accumulator for the current sim shape. Not part of the hot path. */
  _build() {
    const { sim } = this;
    const lg = sim.logistics || {};
    const stations = lg.stations || NONE;
    const vehicles = lg.vehicles || NONE;
    const fleets = (sim.layout && sim.layout.fleets) || NONE;
    const flows = (sim.layout && sim.layout.flows) || NONE;
    const ts = this._trafficStats();
    const nSt = stations.length;
    const nFleet = fleets.length;
    const nFlow = flows.length;
    this.nSt = nSt;
    this.nVeh = vehicles.length;
    this.nEdges = ts.edgePasses ? ts.edgePasses.length : 0;
    this.nNodes = ts.nodeWait ? ts.nodeWait.length : 0;

    this.stIndex = new Map(stations.map((s, i) => [s.id, i]));
    this.kind = Uint8Array.from(stations, (s) => kindOf(s.type));
    this.mCount = Int32Array.from(stations, (s) => (kindOf(s.type) === K_PROCESS && s.machines ? s.machines.length : 0));
    this.mOff = new Int32Array(nSt);
    let machines = 0;
    for (let i = 0; i < nSt; i++) {
      this.mOff[i] = machines;
      machines += this.mCount[i];
    }
    this.prevDown = new Uint8Array(machines);

    this.fleetIndex = new Map(fleets.map((f, i) => [f.id, i]));
    this.flowIndex = new Map(flows.map((f, i) => [f.id, i]));
    this.vehFleet = Int32Array.from(vehicles, (v) => this.fleetIndex.get(v.fleetId) ?? -1);
    this.vehFleetById = new Map(vehicles.map((v, i) => [v.id, this.vehFleet[i]]));
    this.fleetCount = new Int32Array(nFleet);
    for (const fi of this.vehFleet) if (fi >= 0) this.fleetCount[fi]++;
    this.batteryOn = Uint8Array.from(fleets, (f) => (f.battery && f.battery.enabled ? 1 : 0));

    const f64 = (n) => new Float64Array(n);
    this.aIn = f64(nSt); this.aOut = f64(nSt); this.aFill = f64(nSt);
    this.mIn = f64(nSt); this.mOut = f64(nSt); this.mFill = f64(nSt);
    this.tBusy = f64(nSt); this.tStarved = f64(nSt); this.tBlocked = f64(nSt); this.tDown = f64(nSt);
    this.tCap = f64(nSt); this.yardMax = f64(nSt); this.breakdowns = f64(nSt); this.sinkCount = f64(nSt);
    this.fleetTime = f64(nFleet * SLOTS);
    this.minBat = f64(nFleet);
    this.fOrders = f64(nFleet); this.fPick = f64(nFleet); this.fTransit = f64(nFleet);
    this.lDelivered = f64(nFlow); this.lTrips = f64(nFlow); this.lPick = f64(nFlow); this.lTransit = f64(nFlow);
    this.ring = f64(TRAILING_INTERVALS + 1);
    this._zeroed = [
      this.aIn, this.aOut, this.aFill, this.mIn, this.mOut, this.mFill, this.tBusy, this.tStarved, this.tBlocked,
      this.tDown, this.tCap, this.yardMax, this.breakdowns, this.sinkCount, this.fleetTime, this.fOrders,
      this.fPick, this.fTransit, this.lDelivered, this.lTrips, this.lPick, this.lTransit, this.ring,
    ];
    this.snapStation = f64(nSt * 3);
    this.snapVehicle = f64(this.nVeh * 3);
  }

  /** Remember the cumulative counters of other modules so the window reports deltas only. */
  _snapshot() {
    const lg = this.sim.logistics || {};
    const stations = lg.stations || NONE;
    const vehicles = lg.vehicles || NONE;
    const ts = this._trafficStats();
    this.snapEdgePasses = Int32Array.from(ts.edgePasses || NONE);
    this.snapEdgeWait = Float64Array.from(ts.edgeWait || NONE);
    this.snapNodeWait = Float64Array.from(ts.nodeWait || NONE);
    this.snapTraffic = {
      waitVehicle: nn(ts.waitVehicle), waitJunction: nn(ts.waitJunction), waitBroken: nn(ts.waitBroken),
      deadlocks: nn(ts.deadlocks), drivingTime: nn(ts.drivingTime),
    };
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      this.snapStation[i * 3] = nn(st.produced);
      this.snapStation[i * 3 + 1] = nn(st.consumed);
      this.snapStation[i * 3 + 2] = nn(st.arrivals);
      const ms = st.machines;
      for (let j = 0; j < this.mCount[i] && ms && j < ms.length; j++) this.prevDown[this.mOff[i] + j] = ms[j].state === 'down' ? 1 : 0;
    }
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      this.snapVehicle[i * 3] = nn(v.trips);
      this.snapVehicle[i * 3 + 1] = nn(v.loadedDistance);
      this.snapVehicle[i * 3 + 2] = nn(v.emptyDistance);
    }
  }

  // ---- sampling (hot path) -------------------------------------------------------------------------------

  _sampleStations(stations, dt) {
    const { aIn, aOut, aFill, mIn, mOut, mFill, kind } = this;
    const n = stations.length;
    for (let i = 0; i < n; i++) {
      const st = stations[i];
      const inCount = nn(st.inCount);
      const outCount = nn(st.outCount);
      let fill = nn(st.fill);
      if (fill > 1) fill = 1;
      aIn[i] += inCount * dt;
      aOut[i] += outCount * dt;
      aFill[i] += fill * dt;
      if (inCount > mIn[i]) mIn[i] = inCount;
      if (outCount > mOut[i]) mOut[i] = outCount;
      if (fill > mFill[i]) mFill[i] = fill;
      const k = kind[i];
      if (k === K_PROCESS) this._sampleMachines(i, st, dt);
      else if (k === K_SOURCE) {
        const yard = nn(st.yard);
        if (yard > this.yardMax[i]) this.yardMax[i] = yard;
        if (st.state === 'blocked') this.tBlocked[i] += dt;
      } else if (k === K_STORAGE) {
        if (fill <= 0) this.tStarved[i] += dt;
        else if (fill >= FULL) this.tBlocked[i] += dt;
      }
    }
  }

  _sampleMachines(i, st, dt) {
    const ms = st.machines;
    const n = ms ? Math.min(ms.length, this.mCount[i]) : 0;
    const base = this.mOff[i];
    this.tCap[i] += n * dt;
    for (let j = 0; j < n; j++) {
      const state = ms[j].state;
      const down = state === 'down' ? 1 : 0;
      if (down) {
        this.tDown[i] += dt;
        if (!this.prevDown[base + j]) this.breakdowns[i]++;
      } else if (state === 'busy') this.tBusy[i] += dt;
      else if (state === 'blocked') this.tBlocked[i] += dt;
      else this.tStarved[i] += dt;
      this.prevDown[base + j] = down;
    }
  }

  _sampleVehicles(vehicles, dt) {
    const { vehFleet, fleetTime, batteryOn, minBat } = this;
    let working = 0;
    let waiting = 0;
    const n = vehicles.length;
    for (let i = 0; i < n; i++) {
      const fi = vehFleet[i];
      if (fi < 0) continue;
      const v = vehicles[i];
      let slot = STATE_SLOT[v.state];
      if (slot === undefined) slot = IDLE;
      else if (slot === DRIVING && v.tv && v.tv.waiting) slot = WAITING;
      fleetTime[fi * SLOTS + slot] += dt;
      if (slot <= UNLOADING) {
        working++;
        if (slot === WAITING) waiting++;
      }
      if (batteryOn[fi] && v.battery < minBat[fi]) minBat[fi] = v.battery;
    }
    this.serWorking += working * dt;
    this.serWaiting += waiting * dt;
  }

  /** A series boundary was reached: update the trailing-throughput ring and, every `stride` boundaries, emit a point. */
  _closeInterval(k) {
    const ring = this.ring;
    for (let j = this.serK + 1; j <= k; j++) ring[j % ring.length] = this.completed;
    const before = k > TRAILING_INTERVALS ? ring[(k - TRAILING_INTERVALS) % ring.length] : 0;
    const throughput = ((this.completed - before) / (Math.min(TRAILING_INTERVALS, k) * SERIES_INTERVAL)) * 3600;
    const previous = this.serK;
    this.serK = k;
    if (Math.floor(k / this.stride) <= Math.floor(previous / this.stride)) return;
    const span = this.duration - this.serSince;
    this.sT.push(this.start + k * SERIES_INTERVAL);
    this.sThroughput.push(throughput);
    this.sWip.push(span > 0 ? this.serWip / span : 0);
    this.sWorking.push(span > 0 ? this.serWorking / span : 0);
    this.sWaiting.push(span > 0 ? this.serWaiting / span : 0);
    this.serWip = 0;
    this.serWorking = 0;
    this.serWaiting = 0;
    this.serSince = this.duration;
    if (this.sT.length >= SERIES_MAX_POINTS) this._decimateSeries();
  }

  /** Halve the series: times and throughput take the later point of each pair, interval means are averaged. */
  _decimateSeries() {
    const later = (a) => {
      for (let i = 0; i < a.length >> 1; i++) a[i] = a[2 * i + 1];
      a.length >>= 1;
    };
    const average = (a) => {
      for (let i = 0; i < a.length >> 1; i++) a[i] = (a[2 * i] + a[2 * i + 1]) / 2;
      a.length >>= 1;
    };
    later(this.sT);
    later(this.sThroughput);
    average(this.sWip);
    average(this.sWorking);
    average(this.sWaiting);
    this.stride *= 2;
  }

  // ---- events ----------------------------------------------------------------------------------------------

  _onLoadCompleted(p) {
    this.completed++;
    const si = this.stIndex.get(typeof p.station === 'string' ? p.station : p.station && p.station.id);
    if (si !== undefined) this.sinkCount[si]++;
    const lead = Number.isFinite(p.leadTime) ? p.leadTime : (p.load ? nn(p.t ?? this.sim.time) - p.load.createdAt : NaN);
    if (lead >= 0) this.lead.add(lead);
  }

  _onOrderDelivered(p) {
    const order = p.order || {};
    const wait = firstValid(p.waitForPickup, order.pickedAt - order.readySince);
    const transit = firstValid(p.transit, order.deliveredAt - order.pickedAt);
    const qty = nn(order.qty) || nn(order.loads && order.loads.length) || 1;
    this.oCount++;
    this.oPick += wait;
    this.oTransit += transit;
    const fi = this.vehFleetById.get(order.vehicleId);
    if (fi !== undefined && fi >= 0) {
      this.fOrders[fi]++;
      this.fPick[fi] += wait;
      this.fTransit[fi] += transit;
    }
    const li = this.flowIndex.get(order.flowId);
    if (li !== undefined) {
      this.lDelivered[li] += qty;
      this.lTrips[li]++;
      this.lPick[li] += wait;
      this.lTransit[li] += transit;
    }
  }

  _onDeadlock(p) {
    if (this.deadlockEvents.length >= DEADLOCK_EVENT_CAP) return;
    const ids = Array.from(p.vehicles || NONE, (v) => (typeof v === 'string' ? v : (v && v.id) || ''));
    this.deadlockEvents.push({
      t: nn(p.t ?? this.sim.time),
      nodes: Array.from(p.nodes || NONE, Number).filter(Number.isFinite),
      vehicles: ids.filter(Boolean),
      resolved: Boolean(p.resolved),
    });
  }

  // ---- report sections -------------------------------------------------------------------------------------

  _windowReport(dur) {
    const settings = this.sim.settings || (this.sim.layout && this.sim.layout.settings) || {};
    return { start: this.start, end: this.start + dur, duration: dur, warmingUp: nn(this.sim.time) < nn(settings.warmup) };
  }

  _throughputReport(dur) {
    const perHour = (n) => (dur > 0 ? (n / dur) * 3600 : 0);
    const bySink = {};
    const stations = this.sim.logistics?.stations || NONE;
    for (let i = 0; i < stations.length; i++) {
      const count = this.sinkCount[i];
      if (stations[i].type === 'sink' || count > 0) bySink[stations[i].id] = { name: displayName(stations[i]), count, perHour: perHour(count) };
    }
    return { total: this.completed, perHour: perHour(this.completed), bySink };
  }

  _leadTimeReport() {
    const s = this.lead;
    if (s.count === 0) return { count: 0, mean: null, min: null, p50: null, p90: null, p95: null, max: null };
    return { count: s.count, mean: s.sum / s.count, min: s.min, p50: s.percentile(0.5), p90: s.percentile(0.9), p95: s.percentile(0.95), max: s.max };
  }

  _stationsReport(dur) {
    const out = {};
    const stations = this.sim.logistics?.stations || NONE;
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      const k = this.kind[i];
      const den = k === K_PROCESS ? this.tCap[i] : dur;
      const avgFill = dur > 0 ? Math.min(1, this.aFill[i] / dur) : 0;
      let utilization = avgFill;
      if (k === K_PROCESS) utilization = share(this.tBusy[i], den);
      else if (k === K_SOURCE) utilization = dur > 0 ? 1 - share(this.tBlocked[i], dur) : 0;
      const yardNow = k === K_SOURCE ? nn(st.yard) : 0;
      out[st.id] = {
        type: st.type,
        name: displayName(st),
        utilization,
        starved: share(this.tStarved[i], den),
        blocked: share(this.tBlocked[i], den),
        down: share(this.tDown[i], den),
        avgIn: dur > 0 ? this.aIn[i] / dur : 0,
        maxIn: this.mIn[i],
        avgOut: dur > 0 ? this.aOut[i] / dur : 0,
        maxOut: this.mOut[i],
        avgFill,
        maxFill: this.mFill[i],
        produced: Math.max(0, nn(st.produced) - this.snapStation[i * 3]),
        consumed: Math.max(0, nn(st.consumed) - this.snapStation[i * 3 + 1]),
        arrivals: Math.max(0, nn(st.arrivals) - this.snapStation[i * 3 + 2]),
        yardMax: k === K_SOURCE ? Math.max(this.yardMax[i], yardNow) : 0,
        yardNow,
        breakdowns: this.breakdowns[i],
      };
    }
    return out;
  }

  _fleetsReport(dur) {
    const defs = (this.sim.layout && this.sim.layout.fleets) || NONE;
    const vehicles = this.sim.logistics?.vehicles || NONE;
    const trips = new Float64Array(defs.length);
    const loaded = new Float64Array(defs.length);
    const empty = new Float64Array(defs.length);
    for (let i = 0; i < vehicles.length; i++) {
      const fi = this.vehFleet[i];
      if (fi < 0) continue;
      const v = vehicles[i];
      trips[fi] += Math.max(0, nn(v.trips) - this.snapVehicle[i * 3]);
      loaded[fi] += Math.max(0, nn(v.loadedDistance) - this.snapVehicle[i * 3 + 1]);
      empty[fi] += Math.max(0, nn(v.emptyDistance) - this.snapVehicle[i * 3 + 2]);
    }
    const out = {};
    for (let fi = 0; fi < defs.length; fi++) {
      const count = this.fleetCount[fi];
      const shares = this._fleetShares(fi, count);
      const distance = loaded[fi] + empty[fi];
      out[defs[fi].id] = {
        name: defs[fi].name || defs[fi].id,
        count,
        utilization: shares.driving + shares.waiting + shares.loading + shares.unloading,
        shares,
        trips: trips[fi],
        tripsPerVehicleHour: count > 0 && dur > 0 ? trips[fi] / ((count * dur) / 3600) : 0,
        distance,
        distancePerVehicle: count > 0 ? distance / count : 0,
        emptyShare: distance > 0 ? Math.min(1, empty[fi] / distance) : null,
        avgPickupWait: meanOf(this.fPick[fi], this.fOrders[fi]),
        avgTransit: meanOf(this.fTransit[fi], this.fOrders[fi]),
        minBattery: this.batteryOn[fi] && this.minBat[fi] !== Infinity ? Math.min(1, Math.max(0, this.minBat[fi])) : null,
      };
    }
    return out;
  }

  /** Fractions of vehicle-time per state; sum to 1 whenever the fleet has vehicles and time has passed. */
  _fleetShares(fi, count) {
    const shares = {};
    const base = fi * SLOTS;
    let total = 0;
    for (let s = 0; s < SLOTS; s++) total += this.fleetTime[base + s];
    for (let s = 0; s < SLOTS; s++) shares[SLOT_KEYS[s]] = total > 0 ? this.fleetTime[base + s] / total : 0;
    if (count === 0 && this.duration > 0) shares.idle = 1;
    return shares;
  }

  _flowsReport() {
    const flows = (this.sim.layout && this.sim.layout.flows) || NONE;
    const stations = this.sim.logistics?.stations || NONE;
    const now = nn(this.sim.time);
    const out = {};
    for (let li = 0; li < flows.length; li++) {
      const f = flows[li];
      const origin = stations[this.stIndex.get(f.from)];
      out[f.id] = {
        from: f.from,
        to: f.to,
        delivered: this.lDelivered[li],
        trips: this.lTrips[li],
        avgPickupWait: meanOf(this.lPick[li], this.lTrips[li]),
        avgTransit: meanOf(this.lTransit[li], this.lTrips[li]),
        backlog: origin && origin.outQ ? readyLoads(origin.outQ.get(f.id), now) : 0,
      };
    }
    return out;
  }

  _trafficReport() {
    const ts = this._trafficStats();
    const delta = (key) => Math.max(0, nn(ts[key]) - this.snapTraffic[key]);
    const vehicleWait = delta('waitVehicle');
    const junctionWait = delta('waitJunction');
    const brokenWait = delta('waitBroken');
    const driving = delta('drivingTime');
    return {
      waitShare: share(vehicleWait + junctionWait + brokenWait, driving),
      vehicleWait,
      junctionWait,
      brokenWait,
      deadlocks: delta('deadlocks'),
      hotspots: this._hotspots(ts.nodeWait),
      deadlockEvents: this.deadlockEvents.map((e) => ({ ...e, nodes: e.nodes.slice(), vehicles: e.vehicles.slice() })),
    };
  }

  /** The HOTSPOT_COUNT road cells with the most waiting in this window (ties: lower node id first). */
  _hotspots(nodeWait) {
    const best = [];
    const cols = (this.sim.graph && this.sim.graph.cols) || (this.sim.layout && this.sim.layout.grid && this.sim.layout.grid.cols) || 1;
    const snap = this.snapNodeWait;
    for (let node = 0; nodeWait && node < snap.length; node++) {
      const wait = nn(nodeWait[node] - snap[node]);
      if (wait === 0) continue;
      if (best.length === HOTSPOT_COUNT && wait <= best[HOTSPOT_COUNT - 1].wait) continue;
      let pos = best.length;
      while (pos > 0 && best[pos - 1].wait < wait) pos--;
      best.splice(pos, 0, { node, cx: node % cols, cy: Math.floor(node / cols), wait });
      if (best.length > HOTSPOT_COUNT) best.pop();
    }
    return best;
  }
}
