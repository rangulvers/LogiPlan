// The detail collector: the OPTIONAL recorder behind `sim.detail` (docs/ENTITY-INSIGHTS-DESIGN.md 6, docs/ARCHITECTURE.md 5.8).
//
// What it is for. The KPI report (`sim.kpis()`) holds the figures of the whole plant. What a planner asks when clicking on ONE item - which cells did this vehicle drive, where
// did it queue, how does its time split, how long does a pallet wait in the yard, what happened in the last 30 minutes - the report cannot answer. This collector records
// that, per vehicle, per station and per leg, with memory that does not grow with the length of a run.
//
// What it is not. Nothing in kpis() / report() / the golden fixtures depends on it. A Simulation that never calls enableDetail() pays ONE pointer test per tick (engine.js).
// The collector only READS the simulation (public fields, the event bus, TrafficSystem.waitNodeOf), uses no random numbers and mutates nothing; it cannot stop a run
// (afterTickSafe never throws; a collector that failed is dropped by the engine, `sim.detailError` says why). Only the browser runner turns it on.
//
// Feeds
//   afterTickSafe(dt, fresh)  engine.step, once per tick after stats.sample: the POLL. Per vehicle one float compare (vr.stateSince) finds every state change; the open leg is
//                             closed / opened; while it is open the route object, the relocation counter and the waiting flag are watched. `fresh` = this tick ended the warm-up:
//                             reset(t) instead of sampling (that tick belongs to the warm-up, as in Stats). When the number of vehicles or stations changed (Logistics.removeVehicle
//                             exists; the UI normally rebuilds the Simulation instead) everything is re-allocated and the window restarts with a notice.
//   events                    sim.on(...): loadCompleted (lead time per Goods out), orderDelivered (wait for a vehicle per origin, the owed loaded leg), orderPickedUp (yard wait per
//                             pallet of a Goods in), truckReady / truckDeparted (the release stamp of a truck's pallets).
//   coarse                    once per simulated second (time-weighted by the real spacing): the stations - fill, queues, machine states, which input of a starving workstation is short.
//   bucket                    every BUCKET_S (30 s) of window time: one row of cumulative figures per vehicle and station into the snapshot ring (RING = 61 rows: the baseline and
//                             60 buckets). "Last 30 min" is the difference of the current figure and the oldest row. The runtime-setting check (what-if) runs here.
// Everything is a preallocated typed array (the leg log grows by doubling up to LEG_CAP rows); nothing allocates per vehicle and tick. Queries allocate and are meant for the
// selected item at UI pace; a query never changes what the collector records next (tests/sim.detail.determinism.test.js).
//
// ---- the public API (the contract with the model and overlay builders; tests/fixtures/stats/*.json hold its answers for fixed runs) --------------------------------------------
//
//   Indices. `i` of a vehicle query is the position in `det.V` (= sim.vehicles, the order of the fleets); `det.vehicleIndex(id)` finds it from an id like "v2#1" (-1: unknown).
//   `i` of a station query is the position in `det.stations` (= sim.stations); `det.stIndex.get(stationId)`. A station index 0xffff (NO_STATION) means "no station" (a
//   waiting place on the road). A bad index never throws: the answer is the empty one (zeros, [], null).
//   Windows. `w = det.windowOf('start' | 'last30')` -> { kind, t0, seconds, row, zero }: `t0` window start (s of simulated time), `seconds` its length (now - t0),
//   `row` the ring row to subtract, `zero` = true when nothing is subtracted, i.e. the window is the whole run since the collector began (always for 'start'; for 'last30' while
//   fewer than 30 minutes were measured: then "Last 30 min" EQUALS "Since start"). A window object is valid for the moment it was made. Legs belong to a window when they STARTED in it.
//
//   Nulls. A mean over nothing is null, never NaN: routesOf meanTime / meanWait / meanDockWait / meanQty / usualTime / usualWait / metres, visitsTo meanApproach / meanDockQueue, stationWindow
//   bufferWait / yardWait / intakeWait, roundOf, metresToGo, and a histogram's percentile(p). No result holds a NaN or an Infinity (the fixtures and the fuzz test check).
//   Indices change. When the number of vehicles or stations changes under a running collector (Logistics.removeVehicle) it restarts its window and adds a notice; `det.V` and
//   `det.stations` are then the NEW lists, so a caller keeps ids (det.vehicleIndex(id), det.stIndex.get(id)) between calls, not indices.
//
//   state    windowStart (s), version (bumps on every leg close and bucket close: the overlay redraws when it changes), notices [{ t, text }], whatIf [{ t, key, from, to }]
//            (runtime settings changed), failed, error, memoryBytes, nV, nS, bCount (buckets closed), legs.count / legs.size / legs.cap
//   engine   afterTickSafe(dt, fresh) -> boolean (false = failed, the engine drops it); reset(t); detach()
//   windows  windowOf(kind); legCoverage() -> { rows, cap, wrapped, since }   once the ring of legs has wrapped, every leg that STARTED at or after `since` (the latest time at which a dropped leg
//            was filed) is still in it; the leg queries below count from max(w.t0, since), so a caller divides what they return by the time since then, not by the whole window, and says
//            "the last N trips since H:MM" when `wrapped`
//
//   vehicles
//     timeSplit(i, w)  -> { seconds, driving, waiting, dockQueue, loading, unloading, idle, parked, charging, broken, drivingLoaded, drivingEmpty, drivingDepot }   seconds
//                         = sum of the 9 slots (driving ... broken) = the window; drivingLoaded + drivingEmpty + drivingDepot = driving
//     counts(i, w)     -> { trips, loaded, empty, park, qty }   the report's own counters for the window (trips = deliveries; metres; loads carried)
//     workingSeries(i, n = 60) -> number[]   busy share (driving, waiting, queue, loading, unloading) per 30 s bucket, oldest first
//     batteryOf(i, w)  -> { now, min, stops: [{ t0, minutes, b0, b1 }] }   `min` = lowest charge INSIDE the window; stops = charge sessions that ended in it
//     routesOf(i, w, kinds = [1]) -> [{ kind, from, to, flow, trips, complete, meanTime, meanWait, meanDockWait, meanQty, pathId, pathShare, drawn, undrawn, variants, metres,
//                         usualTime, usualWait, disturbed, pathIds: [{ id, n, complete, meanTime, meanWait }] }]   kinds: 1 loaded, 0 empty (to a pickup), 2 to a charger, 3 to park.
//                         Groups by (kind, from, to) sorted by trips; `pathId` the usual (most frequent DRAWABLE) path, `pathShare` its share of the drawn trips, `undrawn` the
//                         trips with no path (zero length, pool full), `disturbed` the relocated legs (not variants); times are means over the COMPLETE legs
//     roundOf(i, w, jobs = 2) -> { jobs: [{ from, to }], count, of, share } | null   the usual round (needs 3 occurrences)
//     queuesOf(i, w)   -> [{ station, seconds, legs, dockNode }]   dock queue by destination station of the closed, complete legs that started in the window (an open leg and a partial leg are not
//                         in it: the TOTAL of a window is timeSplit().dockQueue, exact; this says where, in proportion)
//     hotspots(i, n)   -> { cells: [{ node, seconds }], total, folded }   SINCE START only; without the dock-queue seconds; total = all waiting seconds booked by this vehicle
//     idleSpots(i, n)  -> [{ node, seconds }]   since start only: where it stood without a job
//     metresToGo(i)    -> number | null   live
//   stations and routes
//     stationWindow(i, w) -> { seconds, fill, inQ, outQ, busy, starved, blocked, down, arrivals, produced, consumed, orders, bufferWait, pallets, yardWait, intakeWait }
//     queueNow(i)      -> { loads, oldest }   live: ready, unclaimed loads in the output buffers and the age of the oldest
//     visitsTo(i, w)   -> { visits, meanApproach, meanDockQueue, byVehicle: [{ veh, visits }] }
//     loadedRoutes({ from?, to? }, w) -> [{ from, to, trips, meanTime, meanWait, pathId, share, drawn, undrawn, disturbed, variants, metres }]   as routesOf, all vehicles: `share` = that of the usual
//                         path among the DRAWN trips; relocated, zero-length and pool-full legs are trips but not variants (drawn + undrawn = trips)
//     busiestRoutes(w, n) -> { total, routes: [{ from, to, trips, metres, share, pathId }] }   by loaded metres of the drawable paths
//     cellUse(nodes, w) -> { legs, byFlow: [{ key, n }] }   key = 'loaded|<flow index>' | 'empty|<flow index>' | 'depot|65535'; answered from an index of the paths by cell (built on the first call,
//                         extended by the next ones: the poll never pays for it; 8 bytes per cell of a path)
//     chargeStopsAt(d, w) -> [{ veh, t0, minutes, b0, b1 }]   the charge sessions that ended in the window at depot (station index) d; a session records the depot it charged at
//     pickWait, yardWait: Map(station index -> LogHist { n, sum, max, percentile(p) });  sinkLead: Map(station index -> SampleSet)
//     pool.nodes(pathId) -> Int32Array of road cells;  pool.len[pathId] steps;  pool.start[pathId]
//
// What is sampled and what is exact: the vehicle figures (time split, waiting, legs, battery) are exact at tick resolution; the station integrals (fill, queues, machine
// shares) are sampled once per simulated second (measured error below 0.0007 in a share on the examples); the counters (arrivals, produced, consumed, deliveries) are exact.

import { SampleSet } from './stats.js';

export const SLOT_KEYS = ['driving', 'waiting', 'dockQueue', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken'];
/** Sub-slots of 'driving' (they sum to it): the seconds a vehicle drove with a load, to a pickup, and to a depot / charger. */
export const DRIVE_KEYS = ['drivingLoaded', 'drivingEmpty', 'drivingDepot'];
const NS = SLOT_KEYS.length;
const NX = NS + DRIVE_KEYS.length; // columns of the time matrix
const [S_DRIVING, S_WAITING, S_DOCKQ, S_LOADING, S_UNLOADING, S_IDLE, S_PARKED, S_CHARGING, S_BROKEN] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
/** The time slot a vehicle state belongs to (the same table as Stats' STATE_SLOT; a ledger test compares them with the engine's VEHICLE_STATES). */
export const BASE_SLOT = {
  toPickup: S_DRIVING, toDrop: S_DRIVING, toCharger: S_DRIVING, toPark: S_DRIVING,
  loading: S_LOADING, unloading: S_UNLOADING, idle: S_IDLE, parked: S_PARKED, charging: S_CHARGING, broken: S_BROKEN, dead: S_BROKEN,
};
/** Leg kinds, in the order of the `kinds` argument of routesOf. */
export const KIND = { toPickup: 0, toDrop: 1, toCharger: 2, toPark: 3 };
const DRIVE_SUB = { toDrop: 0, toPickup: 1, toCharger: 2, toPark: 2 };
/** The states in which a vehicle drives a route (a ledger test compares them with the engine's DRIVING_STATES). */
export const DRIVING_STATE = { toPickup: true, toDrop: true, toCharger: true, toPark: true };
/** "No station" in the station columns of the leg log (a waiting place on the road). */
export const NO_STATION = 0xffff;
const NONE16 = NO_STATION;
/** Bits of a leg's flags. */
export const FLAG = Object.freeze({ REROUTED: 1, RELOCATED: 2, WAIT_CELL: 4, PAUSED: 8, PARTIAL: 16, ZERO: 32 });

export const BUCKET_S = 30;
export const RING = 61; // rows kept: the baseline of the window and 60 buckets = 30 minutes
export const LEG_CAP = 1 << 15;
/** The leg log starts with this many rows and doubles up to its cap, so a small plant does not pay for the big one. */
export const LEG_START = 2048;
export const PATH_CAP = 16384;
export const NOTICE_CAP = 20;
export const WHATIF_CAP = 50;
const HOT_SLOTS = 24;
const MAX_LINKS = 8;
const CHARGE_CAP = 2048;
const RUNTIME = ['demandFactor', 'speedFactor', 'processFactor', 'dispatch', 'routing'];

// vehicle snapshot row: the 9 time slots + 3 driving sub-slots (window-relative seconds), then trips (deliveries), loaded / empty / park metres, loads carried,
// battery now, lowest battery inside the bucket
const VF = NX + 7;
const F_TRIPS = NX; const F_DL = NX + 1; const F_DE = NX + 2; const F_DP = NX + 3; const F_QTY = NX + 4; const F_BAT = NX + 5; const F_BMIN = NX + 6;
// station snapshot row: sampled integrals (time-weighted, 1 s) of fill, input queue, output queue, machine-seconds busy / starved / blocked / down, then arrivals, produced,
// consumed, then the event sums of the Goods-in waits: orders picked up, their wait in the output buffer (s), pallets, their wait in the yard (s), their time from creation to ready (s)
const SFN = 15;
const K_PROCESS = 1;

// ---- distinct paths: one start cell and 2 bits per step (N, E, S, W) ---------------------------------------------------------------

class PathPool {
  constructor(graph, cap) {
    this.graph = graph;
    this.cap = cap;
    this.start = []; this.len = []; this.dirs = []; this.hash = [];
    this.byRoute = new WeakMap();
    this.byHash = new Map();
    this.overflow = 0; // legs that found the pool full (they keep path -1: counted, not drawn)
    this.bytes = 0;
    this.head = null; this.next = null; this.pid = null; this.entries = 0; this.indexed = 0; // the cell index (see indexPaths), built on demand
  }

  get size() { return this.start.length; }

  /** The id of the cell path of `route` (a distinct sequence of road cells gets one id, whatever route object carries it); -1 when the pool is full. */
  intern(route) {
    let id = this.byRoute.get(route);
    if (id !== undefined) return id;
    const edges = this.graph.edges;
    const e = route.edges;
    const n = e.length;
    const dirs = new Uint8Array((n + 3) >> 2);
    let h = (2166136261 ^ route.nodes[0]) >>> 0;
    for (let i = 0; i < n; i++) {
      const d = edges[e[i]].dir;
      dirs[i >> 2] |= d << ((i & 3) * 2);
      h = Math.imul(h ^ (d + 1), 16777619) >>> 0;
    }
    const bucket = this.byHash.get(h);
    if (bucket !== undefined) {
      for (const cand of bucket) {
        if (this.start[cand] !== route.nodes[0] || this.len[cand] !== n) continue;
        const p = this.dirs[cand];
        let same = true;
        for (let i = 0; i < dirs.length; i++) if (p[i] !== dirs[i]) { same = false; break; }
        if (same) { this.byRoute.set(route, cand); return cand; }
      }
    }
    if (this.start.length >= this.cap) { this.overflow++; return -1; }
    id = this.start.length;
    this.start.push(route.nodes[0]); this.len.push(n); this.dirs.push(dirs); this.hash.push(h);
    this.bytes += 48 + dirs.length;
    if (bucket === undefined) this.byHash.set(h, [id]); else bucket.push(id);
    this.byRoute.set(route, id);
    return id;
  }

  /**
   * Make sure every interned path is in the cell index (built on the first road-cell query, never by the poll: a plant that nobody clicks a road cell on pays nothing). The index is
   * three typed arrays: `head[node]` the newest entry of that cell, `next[entry]` the one before it, `pid[entry]` the path. A path of n steps adds n + 1 entries (8 bytes each);
   * paths interned later are added by the next call, so a query never decodes a path twice.
   */
  indexPaths() {
    if (this.head === null) { this.head = new Int32Array(this.graph.nodeCount).fill(-1); this.next = new Int32Array(0); this.pid = new Int32Array(0); this.entries = 0; this.indexed = 0; }
    if (this.indexed >= this.start.length) return;
    const cols = this.graph.cols;
    const step = [-cols, 1, cols, -1];
    const head = this.head;
    let need = this.entries;
    for (let id = this.indexed; id < this.start.length; id++) need += this.len[id] + 1;
    if (need > this.next.length) { // one allocation for what is to be indexed now, with a quarter of room for the paths of the next call
      const size = Math.ceil(need * 1.25) + 1024;
      const nn = new Int32Array(size); nn.set(this.next.subarray(0, this.entries)); this.next = nn;
      const pp = new Int32Array(size); pp.set(this.pid.subarray(0, this.entries)); this.pid = pp;
    }
    const next = this.next; const pid = this.pid;
    let at = this.entries;
    for (let id = this.indexed; id < this.start.length; id++) {
      const n = this.len[id]; const dirs = this.dirs[id];
      let node = this.start[id];
      for (let k = 0; k <= n; k++) {
        if (node >= 0 && node < head.length) { next[at] = head[node]; pid[at] = id; head[node] = at; at++; }
        if (k < n) node += step[(dirs[k >> 2] >> ((k & 3) * 2)) & 3];
      }
    }
    this.entries = at; this.indexed = this.start.length;
  }

  /** The ids of the paths that pass any of `nodes` (a Set). Builds or extends the cell index first. */
  pathsThrough(nodes) {
    this.indexPaths();
    const out = new Set();
    for (const nd of nodes) {
      if (!Number.isInteger(nd) || nd < 0 || nd >= this.head.length) continue;
      for (let e = this.head[nd]; e >= 0; e = this.next[e]) out.add(this.pid[e]);
    }
    return out;
  }

  get indexBytes() { return this.head === null ? 0 : this.head.byteLength + this.next.byteLength + this.pid.byteLength; }

  /** The cells of path `id` (decoded on demand; the UI asks for at most a dozen at a time). */
  nodes(id) {
    if (!(id >= 0 && id < this.start.length)) return new Int32Array(0);
    const n = this.len[id];
    const out = new Int32Array(n + 1);
    const cols = this.graph.cols;
    const step = [-cols, 1, cols, -1];
    const dirs = this.dirs[id];
    let node = this.start[id];
    out[0] = node;
    for (let i = 0; i < n; i++) { node += step[(dirs[i >> 2] >> ((i & 3) * 2)) & 3]; out[i + 1] = node; }
    return out;
  }
}

// ---- the leg log: a ring of rows, struct of arrays, growing by doubling up to its cap ----------------------------------------------

// `span` = close time - start time (the `dur` column leaves a breakdown's repair out): t0 + span is when the leg was filed, which is what the ring needs to know about a row it overwrites.
const LEG_COLUMNS = [['veh', Uint16Array], ['kind', Uint8Array], ['from', Uint16Array], ['to', Uint16Array], ['flow', Uint16Array], ['path', Int32Array], ['t0', Float64Array],
  ['dur', Float32Array], ['wait', Float32Array], ['dockWait', Float32Array], ['qty', Uint16Array], ['flags', Uint8Array], ['span', Float32Array]];

class LegLog {
  constructor(cap, start = LEG_START) {
    this.cap = Math.max(1, cap);
    this.rows = Math.min(this.cap, Math.max(1, start)); // rows allocated now
    for (const [name, Type] of LEG_COLUMNS) this[name] = new Type(this.rows);
    this.count = 0; // legs filed since the last clear (including those the ring has dropped)
    this.lostUntil = 0; // the latest time at which a leg that the ring has dropped was filed: every leg that STARTED after it is still here (0: nothing was dropped)
  }

  get bytes() { return this.rows * 40; }
  get size() { return Math.min(this.count, this.cap); }
  /** Storage row of the k-th kept leg, oldest first. */
  at(k) { return this.count <= this.cap ? k : (this.count + k) % this.cap; }
  clear() { this.count = 0; this.lostUntil = 0; }
  grow() {
    const rows = Math.min(this.cap, this.rows * 2);
    for (const [name, Type] of LEG_COLUMNS) { const a = new Type(rows); a.set(this[name]); this[name] = a; }
    this.rows = rows;
  }

  push(veh, kind, from, to, flow, path, t0, dur, wait, dockWait, qty, flags, span = 0) {
    if (this.count >= this.rows && this.rows < this.cap) this.grow();
    const i = this.count % this.rows;
    if (this.count >= this.rows) { const filed = this.t0[i] + this.span[i]; if (filed > this.lostUntil) this.lostUntil = filed; } // the ring overwrites its oldest row
    this.veh[i] = veh; this.kind[i] = kind; this.from[i] = from; this.to[i] = to; this.flow[i] = flow; this.path[i] = path;
    this.t0[i] = t0; this.dur[i] = dur; this.wait[i] = wait; this.dockWait[i] = dockWait; this.qty[i] = qty > 0xffff ? 0xffff : qty; this.flags[i] = flags; this.span[i] = span;
    this.count++;
  }
}

// ---- a few cells with their seconds per vehicle, the rest in `other` ---------------------------------------------------------------

class HotTable {
  constructor(nVeh) {
    this.keys = new Int32Array(nVeh * HOT_SLOTS).fill(-1);
    // Float64: `hotQ` and `hotStray` add `dt` to a cell EVERY tick and hotspots() subtracts hotQ from the (float64) running streak of `hot`; a float32 sum of 0.05 s steps drifts by
    // 5e-5 to 2e-4 of itself, which showed up as phantom seconds on a cell where the vehicle only queued (tests/stats.engine.review.test.js STAT-ENG-REV-4). 100 vehicles: 38 KB per table.
    this.secs = new Float64Array(nVeh * HOT_SLOTS);
    this.other = new Float64Array(nVeh);
    this.last = new Int32Array(nVeh);
  }

  clear() { this.keys.fill(-1); this.secs.fill(0); this.other.fill(0); this.last.fill(0); }

  add(v, node, dt) {
    const base = v * HOT_SLOTS;
    const l = base + this.last[v];
    if (this.keys[l] === node) { this.secs[l] += dt; return; }
    let free = -1; let min = -1;
    for (let k = base; k < base + HOT_SLOTS; k++) {
      const key = this.keys[k];
      if (key === node) { this.secs[k] += dt; this.last[v] = k - base; return; }
      if (key < 0) { if (free < 0) free = k; } else if (min < 0 || this.secs[k] < this.secs[min]) min = k;
    }
    if (free >= 0) { this.keys[free] = node; this.secs[free] = dt; this.last[v] = free - base; return; }
    this.other[v] += this.secs[min];
    this.keys[min] = node; this.secs[min] = dt; this.last[v] = min - base;
  }
}

/** Log histogram, 8 bins per octave from 1 s (a percentile is within 4.5 % of the true value): the wait of loads for a vehicle, per origin station. */
export class LogHist {
  constructor() { this.bins = new Uint32Array(160); this.n = 0; this.sum = 0; this.max = 0; }
  add(x) {
    if (!(x >= 0) || !Number.isFinite(x)) return;
    this.n++; this.sum += x; if (x > this.max) this.max = x;
    this.bins[x < 1 ? 0 : Math.min(159, 1 + Math.floor(Math.log2(x) * 8))]++;
  }

  percentile(p) {
    if (this.n === 0) return null;
    const goal = Math.ceil(p * this.n);
    let c = 0;
    for (let b = 0; b < 160; b++) { c += this.bins[b]; if (c >= goal) return Math.min(this.max, b === 0 ? 1 : 2 ** ((b - 0.5) / 8)); }
    return this.max;
  }
}

const emptySplit = () => ({ seconds: 0, driving: 0, waiting: 0, dockQueue: 0, loading: 0, unloading: 0, idle: 0, parked: 0, charging: 0, broken: 0, drivingLoaded: 0, drivingEmpty: 0, drivingDepot: 0 });

// ---- the collector ---------------------------------------------------------------------------------------------------------------

export class Detail {
  /** @param {object} sim a Simulation; @param {{ legCap?: number, pathCap?: number, legStart?: number }} [opts] */
  constructor(sim, opts = {}) {
    this.sim = sim;
    this.opts = opts;
    this.lg = sim.logistics;
    this.graph = sim.graph;
    this.traffic = sim.traffic;
    this.cell = sim.graph.cellSize;
    this.failed = false; // a collector that failed is dropped by the engine; the simulation never notices
    this.error = null;
    this.notices = []; // [{ t, text }]: "the fleet changed, counting restarts" and the like, shown in the window text
    this.balanceFiled = 0; // loaded legs that only the balance against vr.trips found (diagnostic)
    this.releaseAt = new Map(); // Goods in with trucks: truck id -> the time its pallets were released to the yard (kept until the truck leaves)
    this.version = 0;
    this._off = [
      sim.on('loadCompleted', (p) => this.guard(() => this.onCompleted(p))),
      sim.on('orderPickedUp', (p) => this.guard(() => this.onPicked(p))),
      sim.on('orderDelivered', (p) => this.guard(() => this.onDelivered(p))),
      sim.on('truckReady', (p) => this.guard(() => this.onTruckReady(p))),
      sim.on('truckDeparted', (p) => this.guard(() => this.onTruckDeparted(p))),
    ];
    try {
      this.alloc();
      this.reset(sim.time);
      for (let i = 0; i < this.nV; i++) this.syncState(i, this.V[i]);
    } catch (e) { // the collector is optional: one that cannot even start leaves nothing behind (the engine keeps the reason: sim.detailError)
      this.detach();
      throw e;
    }
  }

  /** (Re)allocate everything that depends on the number of vehicles and stations: once at construction and again when the fleet or the station list changed. */
  alloc() {
    const lg = this.lg; const sim = this.sim; const opts = this.opts;
    this.V = lg.vehicles;
    this.nV = this.V.length;
    const n = this.nV;
    this.stations = lg.stations;
    this.nS = lg.stations.length;
    // the leg log keeps vehicle, station and flow numbers in 16 bits (0xffff = none): a plant beyond that is not recorded rather than recorded wrongly
    if (this.nV >= NONE16 || this.nS >= NONE16 || lg.flows.length >= NONE16) throw new RangeError(`the detail collector records at most ${NONE16 - 1} vehicles, stations and flows`);
    this.stIndex = new Map(lg.stations.map((st, i) => [st.id, i]));
    this.flowIndex = new Map(lg.flows.map((f, i) => [f.id, i]));
    this.vIdIndex = new Map(this.V.map((vr, i) => [vr.id, i]));
    this.kindOf = Uint8Array.from(lg.stations, (st) => (st.type === 'process' ? K_PROCESS : 0));
    this.isSource = Uint8Array.from(lg.stations, (st) => (st.type === 'source' ? 1 : 0));
    this.legs = new LegLog(opts.legCap || LEG_CAP, opts.legStart || LEG_START);
    // a path is a property of the road graph, not of the fleet: the pool survives a restart, so a path id handed out before (the overlay caches the shapes by id) keeps its meaning
    if (!this.pool) this.pool = new PathPool(sim.graph, opts.pathCap || PATH_CAP);
    this.hot = new HotTable(n);
    this.hotStray = new HotTable(n); // waiting seconds of a vehicle that is NOT in a driving state (broken, idle after a repair): booked by traffic's nodeWait, not part of the Waiting tile
    this.hotQ = new HotTable(n); // the part of the waiting that was a queue for a dock, by cell: the cell rows of "where it waits" are hot - hotQ
    this.idleHot = new HotTable(n);
    this.split = new Float64Array(n * NX);
    this.drvSub = new Uint8Array(n);
    this.lastSince = new Float64Array(n).fill(-1);
    this.lastState = new Array(n).fill(null);
    this.lastTarget = new Array(n).fill(null);
    this.lastOrder = new Array(n).fill(null);
    this.lastRoute = new Array(n).fill(null);
    this.vIndex = new Map(this.V.map((vr, i) => [vr, i]));
    this.delivered = new Array(n).fill(null); // the order of the latest 'orderDelivered' of each vehicle (consumed by the balance)
    this.lastTrips = new Int32Array(n);
    this.legsLoaded = new Uint32Array(n); // loaded legs filed in the window (real or zero length): balanced against vr.trips every tick
    this.credit = new Uint8Array(n); // 1: the vehicle was unloading when the window began, so its delivery has no leg inside the window
    this.slotBase = new Uint8Array(n);
    this.batMin = new Float32Array(n); this.bktMin = new Float32Array(n);
    this.curNode = new Int32Array(n).fill(-1); this.curSecs = new Float64Array(n);
    this.curIdle = new Int32Array(n).fill(-1); this.curIdleSecs = new Float64Array(n);
    this.open = new Uint8Array(n); this.oKind = new Uint8Array(n);
    this.oFrom = new Uint16Array(n).fill(NONE16); this.oTo = new Uint16Array(n).fill(NONE16); this.oFlow = new Uint16Array(n).fill(NONE16);
    this.oPath = new Int32Array(n).fill(-1); this.oT0 = new Float64Array(n); this.oWait = new Float64Array(n); this.oDockWait = new Float64Array(n);
    this.oQty = new Uint16Array(n); this.oFlags = new Uint8Array(n); this.oHasRoute = new Uint8Array(n);
    this.oPaused = new Float64Array(n); this.pauseAt = new Float64Array(n).fill(-1); this.oTele = new Int32Array(n);
    this.charges = { cap: CHARGE_CAP, veh: new Uint16Array(CHARGE_CAP), t0: new Float64Array(CHARGE_CAP), dur: new Float32Array(CHARGE_CAP), b0: new Float32Array(CHARGE_CAP), b1: new Float32Array(CHARGE_CAP), dep: new Uint16Array(CHARGE_CAP).fill(NONE16), count: 0 }; // dep: the station index of the depot it charged at
    this.cT0 = new Float64Array(n); this.cB0 = new Float32Array(n);
    this.base = new Float64Array(n * 4); // window start: trips, loaded / empty / park metres
    this.qty = new Float64Array(n); // loads carried in the window (loaded legs that ended)
    this.depotIdx = new Int32Array(n).fill(-1);
    this.depotSecs = new Float64Array(this.nS * 2); // parked, charging vehicle-seconds per depot
    // stations: sampled once a simulated second, each sample weighted by the real time since the previous one
    this.sInt = new Float64Array(this.nS * 7); // fill, in, out, busy, starved, blocked, down
    this.sBase = new Float64Array(this.nS * 3); // arrivals, produced, consumed at the window start
    this.sEv = new Float64Array(this.nS * 5); // orders picked up, their wait in the output buffer, pallets, their wait in the yard, their time from creation to ready (cumulative in the window)
    this.sSecs = 0; // seconds the samples stand for
    this.starvedBy = new Float64Array(this.nS * MAX_LINKS);
    this.sinkLead = new Map(); // station index -> SampleSet (loads that left the plant there)
    this.pickWait = new Map(); // station index -> LogHist (s from ready to picked up, orders that left this station; the report's definition)
    this.yardWait = new Map(); // station index -> LogHist (s a pallet waited in the yard of a Goods in, from its release to the output buffer)
    // snapshot ring
    this.vRing = new Float32Array(RING * n * VF);
    this.sRing = new Float32Array(RING * this.nS * SFN);
    this.ringT = new Float64Array(RING);
    this.ringN = new Float64Array(RING); // seconds the station samples stood for when the row was written
    this.bCount = 0;
    this.whatIf = []; // [{ t, key, from, to }]
    this.rt = {};
    this.windowStart = 0;
    this.lastCoarse = 0;
    this.nextCoarse = 0;
    this.nextBucket = 0;
  }

  detach() { for (const off of this._off) off(); this._off = []; }

  get memoryBytes() {
    let b = this.legs.bytes + this.pool.bytes + this.vRing.byteLength + this.sRing.byteLength;
    for (const v of [this.hot.keys, this.hot.secs, this.hotStray.keys, this.hotStray.secs, this.hotQ.keys, this.hotQ.secs, this.idleHot.keys, this.idleHot.secs, this.split, this.starvedBy, this.sInt, this.sEv]) b += v.byteLength;
    return b + this.charges.cap * 24 + this.pool.indexBytes;
  }

  // ---- containment -----------------------------------------------------------------------------------------------------------------

  guard(fn) { try { fn(); } catch (e) { this.fail(e); } }

  fail(e) { if (!this.failed) { this.failed = true; this.error = e instanceof Error ? e : new Error(String(e)); } }

  /**
   * The engine's entry point (one pointer test per tick when no collector is attached). Never throws: the collector is optional and must not be able to stop the
   * simulation. Returns false when it failed (the engine then drops it and remembers the error for the dock: "statistics stopped"). When the number of vehicles
   * or stations changed (Logistics.removeVehicle exists, the UI normally rebuilds the Simulation instead) the arrays are re-made and the window restarts, with a notice.
   */
  afterTickSafe(dt, fresh) {
    if (this.failed) return false;
    try {
      const lg = this.lg;
      if (lg.vehicles !== this.V || lg.vehicles.length !== this.nV || lg.stations !== this.stations || lg.stations.length !== this.nS) this.rebind();
      else this.afterTick(dt, fresh);
    } catch (e) { this.fail(e); }
    return !this.failed;
  }

  rebind() {
    this.alloc();
    this.notice('The vehicles or stations changed; the statistics start counting again here.');
    this.reset(this.sim.time);
    for (let i = 0; i < this.nV; i++) this.syncState(i, this.V[i]);
  }

  notice(text) {
    this.notices.push({ t: this.sim.time, text });
    if (this.notices.length > NOTICE_CAP) this.notices.shift();
  }

  /** Start the window at time `t`: clears what was recorded, keeps identities and the path pool, turns drives in progress into partial legs. */
  reset(t) {
    this.windowStart = t;
    this.legs.clear(); this.hot.clear(); this.hotStray.clear(); this.hotQ.clear(); this.idleHot.clear();
    this.curNode.fill(-1); this.curSecs.fill(0); this.curIdle.fill(-1); this.curIdleSecs.fill(0);
    this.split.fill(0); this.qty.fill(0); this.legsLoaded.fill(0); this.delivered.fill(null);
    this.charges.count = 0;
    this.depotSecs.fill(0); this.sInt.fill(0); this.sEv.fill(0); this.sSecs = 0; this.starvedBy.fill(0); this.sinkLead.clear(); this.pickWait.clear(); this.yardWait.clear();
    this.lastCoarse = t; this.nextCoarse = t + 1; this.nextBucket = t + BUCKET_S; this.bCount = 0;
    this.vRing.fill(0); this.sRing.fill(0); this.ringT.fill(0); this.ringN.fill(0); this.ringT[0] = t;
    this.whatIf = []; this.rt = {};
    for (const k of RUNTIME) this.rt[k] = this.sim.settings[k];
    for (let i = 0; i < this.nV; i++) {
      const vr = this.V[i];
      if (this.open[i]) { this.oFlags[i] |= FLAG.PARTIAL; this.oT0[i] = t; this.oPaused[i] = 0; if (this.pauseAt[i] >= 0) this.pauseAt[i] = t; }
      this.oWait[i] = 0; this.oDockWait[i] = 0;
      this.base[i * 4] = vr.trips; this.base[i * 4 + 1] = vr.loadedDistance; this.base[i * 4 + 2] = vr.emptyDistance; this.base[i * 4 + 3] = vr.parkDistance;
      this.lastTrips[i] = vr.trips; this.credit[i] = vr.state === 'unloading' ? 1 : 0;
      this.batMin[i] = vr.battery; this.bktMin[i] = vr.battery;
    }
    for (let i = 0; i < this.nS; i++) { const st = this.stations[i]; this.sBase[i * 3] = st.arrivals; this.sBase[i * 3 + 1] = st.produced; this.sBase[i * 3 + 2] = st.consumed; }
    this.version++;
  }

  /**
   * Right after a reset at the end of the warm-up: a vehicle that changed state in that very tick has the leg that ended in it (a leg of the warm-up) dropped and its new state
   * adopted, as a partial leg when it drives; the others keep the drive in progress as a partial leg (reset did that). Without this a leg that ended in the last warm-up tick
   * would be filed in the first tick of the window with a duration of 0, as a trip the report does not count.
   */
  resync() {
    for (let i = 0; i < this.nV; i++) {
      const vr = this.V[i];
      if (vr.stateSince !== this.lastSince[i] || vr.state !== this.lastState[i]) { this.open[i] = 0; this.pauseAt[i] = -1; this.syncState(i, vr); }
    }
  }

  // ---- state tracking ------------------------------------------------------------------------------------------------------------

  syncState(i, vr) {
    this.lastState[i] = vr.state; this.lastSince[i] = vr.stateSince; this.lastTarget[i] = vr.targetId; this.lastOrder[i] = vr.order; this.lastRoute[i] = vr.route;
    this.slotBase[i] = BASE_SLOT[vr.state] ?? S_IDLE;
    this.drvSub[i] = DRIVE_SUB[vr.state] ?? 1;
    this.oTele[i] = vr.tv.teleports;
    if (DRIVING_STATE[vr.state]) this.openLeg(i, vr, vr.stateSince, true);
  }

  stationOfNode(node, prefer) {
    const at = this.graph.stationsAt.get(node);
    if (at === undefined || at.length === 0) return NONE16;
    return this.stIndex.get(prefer !== undefined && prefer !== null && at.includes(prefer) ? prefer : at[0]);
  }

  openLeg(i, vr, t0, adopting = false) {
    this.open[i] = 1; this.oKind[i] = KIND[vr.state];
    const ord = vr.order;
    this.oFlow[i] = ord ? (this.flowIndex.get(ord.flowId) ?? NONE16) : NONE16;
    this.oQty[i] = vr.state === 'toDrop' && ord ? ord.qty : 0;
    this.oTo[i] = vr.spot < 0 && vr.targetId !== null ? (this.stIndex.get(vr.targetId) ?? NONE16) : NONE16;
    this.oT0[i] = t0; this.oWait[i] = 0; this.oDockWait[i] = 0; this.oPaused[i] = 0; this.pauseAt[i] = -1; this.oFlags[i] = 0; this.oPath[i] = -1; this.oHasRoute[i] = 0;
    if (adopting && t0 < this.windowStart) { this.oT0[i] = this.windowStart; this.oFlags[i] |= FLAG.PARTIAL; }
    this.oFrom[i] = NONE16; this.oTele[i] = vr.tv.teleports;
    if (vr.tv.driving) this.takeRoute(i, vr);
  }

  takeRoute(i, vr) {
    const route = vr.route;
    if (!route || !route.nodes || route.nodes.length < 2) return;
    this.oHasRoute[i] = 1; this.lastRoute[i] = route;
    this.oPath[i] = this.pool.intern(route);
    // the origin of a LOADED leg is the station of its order, whatever cell the (re)planned route starts on (after a relocation or a replan that is a road cell); an empty
    // leg keeps the first origin it had (re-planning must not overwrite a known station with "a road cell")
    const f = this.stationOfNode(route.nodes[0], vr.order ? vr.order.from : vr.leaveStation);
    if (this.oKind[i] === 1 && vr.order) this.oFrom[i] = this.stIndex.get(vr.order.from) ?? f;
    else if (f !== NONE16 || this.oFrom[i] === NONE16) this.oFrom[i] = f;
    if (this.oTo[i] === NONE16) this.oFlags[i] |= FLAG.WAIT_CELL; // a waiting cell: no station
  }

  closeLeg(i, t1, next) {
    if (!this.open[i]) return;
    this.open[i] = 0;
    let path = this.oPath[i]; let flags = this.oFlags[i];
    if (!this.oHasRoute[i]) {
      // never drove: either the order was given back before the vehicle left (no leg), or the target is the cell the vehicle stands on (two stations share a dock
      // cell): a leg of length 0. A LOADED one is a trip whether or not the unloading is seen (unloadTime 0 skips the state): the balance against vr.trips in afterTick
      // files it; an empty one is filed only when the state sequence shows it.
      if (!((next === 'unloading' && this.oKind[i] === 1) || (next === 'loading' && this.oKind[i] === 0))) return;
      path = -2; flags |= FLAG.ZERO;
    }
    const dur = Math.max(0, t1 - this.oT0[i] - this.oPaused[i]);
    this.legs.push(i, this.oKind[i], this.oFrom[i], this.oTo[i], this.oFlow[i], path, this.oT0[i], dur, this.oWait[i], this.oDockWait[i], this.oQty[i], flags, Math.max(0, t1 - this.oT0[i]));
    if (this.oKind[i] === 1) { this.legsLoaded[i]++; if (!(flags & FLAG.PARTIAL)) this.qty[i] += this.oQty[i]; }
    this.version++;
  }

  /** A leg whose target is the cell the vehicle already stands on begins and ends inside one tick: no driving state is ever seen. It is a trip (the report counts the
   *  delivery), path -2, not drawn. `ord` is the order (the one before this tick's transition); without one the leg is filed with no origin or destination. */
  zeroLeg(i, ord, kind, t) {
    const from = ord ? (this.stIndex.get(ord.from) ?? NONE16) : NONE16;
    const to = ord ? (this.stIndex.get(kind === 1 ? ord.to : ord.from) ?? NONE16) : NONE16;
    const flow = ord ? (this.flowIndex.get(ord.flowId) ?? NONE16) : NONE16;
    const qty = ord && kind === 1 ? ord.qty : 0;
    this.legs.push(i, kind, from, to, flow, -2, t, 0, 0, 0, qty, FLAG.ZERO, 0);
    if (kind === 1) { this.qty[i] += qty; this.legsLoaded[i]++; }
    this.version++;
  }

  /** The vehicle entered `state` at time `t` (vr.stateSince; for a change of order or target inside a state: the start of the tick that showed it). */
  transition(i, vr, state, t) {
    const prev = this.lastState[i];
    const open = this.open[i] === 1;
    if (state === 'broken' && open && prev !== 'broken') { this.pauseAt[i] = t; this.oFlags[i] |= FLAG.PAUSED; } // a breakdown pauses the leg: its duration excludes the repair
    else if (open && prev === 'broken' && this.pauseAt[i] >= 0 && DRIVING_STATE[state] && vr.targetId === this.lastTarget[i] && vr.order === this.lastOrder[i]) {
      this.oPaused[i] += t - this.pauseAt[i]; this.pauseAt[i] = -1;
    } else if (state === 'dead') this.open[i] = 0;
    else {
      if (open) this.closeLeg(i, this.pauseAt[i] >= 0 ? this.pauseAt[i] : t, state);
      if (prev === 'charging' && state !== 'charging') this.endCharge(i, vr, t);
      if (state === 'charging' && prev !== 'charging') { this.cT0[i] = t; this.cB0[i] = vr.battery; }
      if (DRIVING_STATE[state]) this.openLeg(i, vr, t);
      else if (vr.order && ((state === 'unloading' && prev === 'loading') || (state === 'loading' && (prev === 'unloading' || prev === 'idle')))) this.zeroLeg(i, vr.order, state === 'unloading' ? 1 : 0, t);
    }
    if (state === 'parked' || state === 'charging') this.depotIdx[i] = vr.depot ? this.stIndex.get(vr.depot.id) ?? -1 : -1;
    this.lastState[i] = state; this.lastSince[i] = vr.stateSince; this.lastTarget[i] = vr.targetId; this.lastOrder[i] = vr.order;
    this.slotBase[i] = BASE_SLOT[state] ?? S_IDLE;
    this.drvSub[i] = DRIVE_SUB[state] ?? this.drvSub[i];
  }

  endCharge(i, vr, t) {
    const c = this.charges; const k = c.count % c.cap;
    c.veh[k] = i; c.t0[k] = this.cT0[i]; c.dur[k] = t - this.cT0[i]; c.b0[k] = this.cB0[i]; c.b1[k] = vr.battery; c.dep[k] = this.depotIdx[i] >= 0 ? this.depotIdx[i] : NONE16; c.count++;
  }

  // ---- the poll ------------------------------------------------------------------------------------------------------------------

  afterTick(dt, fresh) {
    if (fresh) { this.reset(this.sim.time); this.resync(); return; }
    // The loop below runs once per vehicle and tick. Its arrays are read into locals first: a property load of `this` for each of the thirty accesses per vehicle was measurable at
    // 100 vehicles (the arrays are only ever replaced by alloc(), which is not called from here).
    const V = this.V; const n = this.nV; const split = this.split; const traffic = this.traffic; const docks = this.lg.docks;
    const lastSince = this.lastSince; const lastState = this.lastState; const lastOrder = this.lastOrder; const lastTarget = this.lastTarget; const lastTrips = this.lastTrips; const lastRoute = this.lastRoute;
    const open = this.open; const oHasRoute = this.oHasRoute; const oTele = this.oTele; const oFlags = this.oFlags; const oWait = this.oWait; const oDockWait = this.oDockWait;
    const bktMin = this.bktMin; const batMin = this.batMin; const slotBase = this.slotBase; const drvSub = this.drvSub;
    const curNode = this.curNode; const curSecs = this.curSecs; const curIdle = this.curIdle; const curIdleSecs = this.curIdleSecs;
    const base = this.base; const credit = this.credit; const legsLoaded = this.legsLoaded; const delivered = this.delivered; const depotIdx = this.depotIdx; const depotSecs = this.depotSecs;
    const hot = this.hot; const hotQ = this.hotQ; const hotStray = this.hotStray; const idleHot = this.idleHot;
    for (let i = 0; i < n; i++) {
      const vr = V[i];
      const prevOrder = lastOrder[i];
      if (vr.stateSince !== lastSince[i] || vr.state !== lastState[i]) this.transition(i, vr, vr.state, vr.stateSince);
      else if (open[i] === 1 && (vr.order !== lastOrder[i] || vr.targetId !== lastTarget[i])) this.transition(i, vr, vr.state, this.sim.time - dt);
      if (vr.trips !== lastTrips[i]) {
        // the engine counted a delivery. Every delivery has a loaded leg; one that began and ended inside a tick was not seen by the poll (a drop on the cell the vehicle
        // stands on with unloadTime 0, a load and a drop in one tick): file what is owed from the order the vehicle had before this tick.
        lastTrips[i] = vr.trips;
        let owed = vr.trips - base[i * 4] - credit[i] - legsLoaded[i];
        const ord = delivered[i] || prevOrder;
        while (owed-- > 0) { this.zeroLeg(i, ord, 1, this.sim.time - dt); this.balanceFiled++; } // it began and ended inside this tick: it starts with the tick
        delivered[i] = null;
      }
      const tv = vr.tv;
      if (open[i] === 1) {
        if (oHasRoute[i] === 0) { if (tv.driving) this.takeRoute(i, vr); } else if (vr.route !== lastRoute[i] && tv.driving) { this.takeRoute(i, vr); oFlags[i] |= FLAG.REROUTED; }
        if (tv.teleports !== oTele[i]) { oTele[i] = tv.teleports; oFlags[i] |= FLAG.RELOCATED; }
      }
      const b = vr.battery;
      if (b < bktMin[i]) { bktMin[i] = b; if (b < batMin[i]) batMin[i] = b; }
      let slot = slotBase[i];
      if (tv.waiting) {
        // traffic's nodeWait books the waiting of ANY held-up vehicle; the Waiting tile (Stats.slotOf) only that of a vehicle in a driving state. The cell table follows the tile
        // (`hot`), the rest goes to `hotStray`, so that a cell list can never add up to more than the tile and the sum of both tables still equals nodeWait.
        const node = traffic.waitNodeOf(tv);
        const queue = vr.dock !== null && docks.waitsForDock(vr, vr.dock);
        if (slot === S_DRIVING) {
          if (node === curNode[i]) curSecs[i] += dt;
          else { if (curNode[i] >= 0) hot.add(i, curNode[i], curSecs[i]); curNode[i] = node; curSecs[i] = dt; }
          if (queue) hotQ.add(i, node, dt);
          if (open[i] === 1) { oWait[i] += dt; if (queue) oDockWait[i] += dt; } // a leg's held-up seconds are those of a vehicle that drives (not those of a breakdown)
        } else {
          if (curNode[i] >= 0) { hot.add(i, curNode[i], curSecs[i]); curNode[i] = -1; }
          hotStray.add(i, node, dt);
        }
        if (slot === S_DRIVING) slot = queue ? S_DOCKQ : S_WAITING;
      } else {
        if (curNode[i] >= 0) { hot.add(i, curNode[i], curSecs[i]); curNode[i] = -1; }
        if (slot === S_IDLE && tv.node >= 0) {
          if (tv.node === curIdle[i]) curIdleSecs[i] += dt;
          else { if (curIdle[i] >= 0) idleHot.add(i, curIdle[i], curIdleSecs[i]); curIdle[i] = tv.node; curIdleSecs[i] = dt; }
        } else if (curIdle[i] >= 0) { idleHot.add(i, curIdle[i], curIdleSecs[i]); curIdle[i] = -1; }
      }
      split[i * NX + slot] += dt;
      if (slot === S_DRIVING) split[i * NX + NS + drvSub[i]] += dt;
      if (slot === S_CHARGING || slot === S_PARKED) { const d = depotIdx[i]; if (d >= 0) depotSecs[d * 2 + (slot === S_CHARGING ? 1 : 0)] += dt; }
    }
    const now = this.sim.time;
    if (now + 1e-9 >= this.nextCoarse) this.coarse(now);
    if (now + 1e-9 >= this.nextBucket) this.closeBucket();
  }

  /** Once per simulated second: the stations. Each sample stands for the time since the previous one (1 s for every dt that divides it; the real spacing for any other). */
  coarse(now) {
    const w = now - this.lastCoarse;
    this.lastCoarse = now; this.nextCoarse += 1; if (this.nextCoarse <= now) this.nextCoarse = now + 1;
    if (!(w > 0)) return;
    this.sSecs += w;
    const sts = this.stations; const a = this.sInt;
    for (let i = 0; i < this.nS; i++) {
      const st = sts[i];
      let f = st.fill; f = f > 0 ? (f > 1 ? 1 : f) : 0;
      const o = i * 7;
      a[o] += f * w; a[o + 1] += (st.inCount > 0 ? st.inCount : 0) * w; a[o + 2] += (st.outCount > 0 ? st.outCount : 0) * w;
      if (this.kindOf[i] === K_PROCESS) {
        const ms = st.machines;
        if (ms) {
          for (let j = 0; j < ms.length; j++) {
            const mach = ms[j];
            a[o + (mach.state === 'busy' ? 3 : mach.state === 'down' ? 6 : mach.state === 'blocked' ? 5 : 4)] += w;
          }
        } else a[o + 6] += w;
        if (st.state === 'starved') {
          const links = st.inLinks;
          for (let l = 0; l < links.length && l < MAX_LINKS; l++) { const link = links[l]; if (link.queue.length < link.perCycle) this.starvedBy[i * MAX_LINKS + l] += w; }
        }
      }
    }
  }

  closeBucket() {
    const j = ++this.bCount; const row = j % RING;
    this.nextBucket += BUCKET_S;
    this.ringT[row] = this.windowStart + j * BUCKET_S;
    this.ringN[row] = this.sSecs;
    const vr0 = row * this.nV * VF;
    for (let i = 0; i < this.nV; i++) {
      const vr = this.V[i]; const o = vr0 + i * VF;
      for (let s = 0; s < NX; s++) this.vRing[o + s] = this.split[i * NX + s];
      this.vRing[o + F_TRIPS] = vr.trips - this.base[i * 4]; this.vRing[o + F_DL] = vr.loadedDistance - this.base[i * 4 + 1];
      this.vRing[o + F_DE] = vr.emptyDistance - this.base[i * 4 + 2]; this.vRing[o + F_DP] = vr.parkDistance - this.base[i * 4 + 3];
      this.vRing[o + F_QTY] = this.qty[i]; this.vRing[o + F_BAT] = vr.battery;
      this.vRing[o + F_BMIN] = this.bktMin[i]; this.bktMin[i] = vr.battery; // lowest charge inside the bucket that just ended
    }
    const s0 = row * this.nS * SFN;
    for (let i = 0; i < this.nS; i++) {
      const o = s0 + i * SFN; const st = this.stations[i];
      for (let k = 0; k < 7; k++) this.sRing[o + k] = this.sInt[i * 7 + k];
      this.sRing[o + 7] = st.arrivals - this.sBase[i * 3]; this.sRing[o + 8] = st.produced - this.sBase[i * 3 + 1]; this.sRing[o + 9] = st.consumed - this.sBase[i * 3 + 2];
      for (let k = 0; k < 5; k++) this.sRing[o + 10 + k] = this.sEv[i * 5 + k];
    }
    // the what-if check: a runtime setting that changed since the last bucket
    const settings = this.sim.settings;
    for (const k of RUNTIME) {
      if (settings[k] !== this.rt[k]) {
        this.whatIf.push({ t: this.sim.time, key: k, from: this.rt[k], to: settings[k] }); this.rt[k] = settings[k];
        if (this.whatIf.length > WHATIF_CAP) this.whatIf.shift();
      }
    }
    this.version++;
  }

  // ---- events --------------------------------------------------------------------------------------------------------------------

  onCompleted(ev) {
    const i = this.stIndex.get(ev.stationId !== undefined ? ev.stationId : ev.station && ev.station.id);
    if (i === undefined) return;
    let set = this.sinkLead.get(i);
    if (set === undefined) this.sinkLead.set(i, (set = new SampleSet(2000)));
    set.add(ev.leadTime);
  }

  /** The report's own quantity: seconds from the first load of the order being ready in the output buffer to its pickup, counted when the order is delivered. */
  onDelivered(ev) {
    const vi = this.vIndex.get(ev.vehicle);
    if (vi !== undefined) this.delivered[vi] = ev.order;
    const i = this.stIndex.get(ev.order.from);
    if (i === undefined) return;
    let h = this.pickWait.get(i);
    if (h === undefined) this.pickWait.set(i, (h = new LogHist()));
    h.add(ev.waitForPickup);
    if (ev.waitForPickup >= 0) { this.sEv[i * 5] += 1; this.sEv[i * 5 + 1] += ev.waitForPickup; }
  }

  /** Goods in: the yard wait of each pallet of a picked-up order = from its release (truck: check-in over; plain source: its creation) until it entered the output buffer. */
  onPicked(ev) {
    const i = this.stIndex.get(ev.order.from);
    if (i === undefined || this.isSource[i] === 0) return;
    let h = this.yardWait.get(i);
    if (h === undefined) this.yardWait.set(i, (h = new LogHist()));
    const loads = ev.order.loads;
    for (let k = 0; k < loads.length; k++) {
      const load = loads[k];
      const released = load.tk >= 0 ? (this.releaseAt.get(load.tk) ?? load.createdAt) : load.createdAt;
      const w = Math.max(0, load.readyAt - released);
      h.add(w); this.sEv[i * 5 + 2] += 1; this.sEv[i * 5 + 3] += w; this.sEv[i * 5 + 4] += Math.max(0, load.readyAt - load.createdAt);
    }
  }

  onTruckReady(ev) {
    const i = this.stIndex.get(ev.stationId);
    if (i !== undefined && this.isSource[i] === 1) this.releaseAt.set(ev.truck.id, ev.t);
  }

  onTruckDeparted(ev) { this.releaseAt.delete(ev.truck.id); }

  // ---- queries (allocate; the selected item, at UI pace; none of them changes what is recorded next) ----------------------------------

  vOk(i) { return Number.isInteger(i) && i >= 0 && i < this.nV; }

  sOk(i) { return Number.isInteger(i) && i >= 0 && i < this.nS; }

  /** The position of a vehicle in det.V by its id ("v2#1"), -1 when there is none (a fleet shrunk by an edit, a vehicle that did not fit on the road). */
  vehicleIndex(id) { const i = this.vIdIndex.get(id); return i === undefined ? -1 : i; }

  /** { kind, t0, seconds, row, zero }: 'start' = since the window began, 'last30' = since the bucket 30 minutes ago (the oldest row of the ring). `zero`: nothing is subtracted. */
  windowOf(kind = 'start') {
    const now = this.sim.time;
    if (kind !== 'last30') return { kind: 'start', t0: this.windowStart, seconds: now - this.windowStart, row: 0, zero: true };
    const jb = Math.max(0, this.bCount - (RING - 1));
    const t0 = this.windowStart + jb * BUCKET_S;
    return { kind: 'last30', t0, seconds: now - t0, row: jb % RING, zero: jb === 0 };
  }

  /**
   * What the leg log still holds. `wrapped`: the ring dropped its oldest legs. `since`: every leg that STARTED at or after this time is still in the log (the window text says
   * "the last N trips since 3:12" when `wrapped`); it is the latest time at which a dropped leg was filed, never earlier than the window start. Every query that reads the legs
   * (routesOf, roundOf, queuesOf, loadedRoutes, visitsTo, busiestRoutes, cellUse) counts the legs that started in the window AND after `since`, so a caller divides the legs it
   * gets by the time since `max(w.t0, since)`, not by the whole window.
   */
  legCoverage() {
    const L = this.legs; const wrapped = L.count > L.cap;
    return { rows: L.size, cap: L.cap, wrapped, since: wrapped ? Math.max(this.windowStart, L.lostUntil) : this.windowStart };
  }

  /** The earliest start time (minus a rounding margin) of the legs a query may count in window `w`: the window start, or where the leg log is complete from when it wrapped. */
  legFrom(w) { return Math.max(w.t0, this.legs.lostUntil) - 1e-9; }

  vrow(i, w, s) { return w.zero ? 0 : this.vRing[w.row * this.nV * VF + i * VF + s]; }

  /** Seconds per slot in the window; `seconds` = the sum of the 9 slots (= the window). drivingLoaded / drivingEmpty / drivingDepot are parts of `driving`. */
  timeSplit(i, w = this.windowOf('start')) {
    if (!this.vOk(i)) return emptySplit();
    const out = { seconds: 0 };
    let sum = 0;
    for (let s = 0; s < NS; s++) { const x = Math.max(0, this.split[i * NX + s] - this.vrow(i, w, s)); out[SLOT_KEYS[s]] = x; sum += x; } // the float32 ring may round up: never a negative time
    for (let s = NS; s < NX; s++) out[DRIVE_KEYS[s - NS]] = Math.max(0, this.split[i * NX + s] - this.vrow(i, w, s));
    out.seconds = sum;
    return out;
  }

  /** Deliveries, metres and loads carried by vehicle `i` in the window (the report's own counters, so they equal the Results tab). */
  counts(i, w = this.windowOf('start')) {
    if (!this.vOk(i)) return { trips: 0, loaded: 0, empty: 0, park: 0, qty: 0 };
    const vr = this.V[i]; const o = i * 4;
    return {
      trips: Math.max(0, Math.round(vr.trips - this.base[o] - this.vrow(i, w, F_TRIPS))), loaded: Math.max(0, vr.loadedDistance - this.base[o + 1] - this.vrow(i, w, F_DL)),
      empty: Math.max(0, vr.emptyDistance - this.base[o + 2] - this.vrow(i, w, F_DE)), park: Math.max(0, vr.parkDistance - this.base[o + 3] - this.vrow(i, w, F_DP)), qty: Math.max(0, Math.round(this.qty[i] - this.vrow(i, w, F_QTY))),
    };
  }

  /** Share of each of the last `n` buckets that vehicle `i` spent working (driving, waiting, queue, loading, unloading), oldest first: the sparkline. */
  workingSeries(i, n = 60) {
    if (!this.vOk(i)) return [];
    const out = []; const hi = this.bCount; const lo = Math.max(1, hi - Math.min(n, RING - 1) + 1);
    const at = (j, s) => (j === 0 ? 0 : this.vRing[(j % RING) * this.nV * VF + i * VF + s]);
    for (let j = lo; j <= hi; j++) {
      // busy seconds over ALL seconds of the bucket (a bucket closes at the first tick at or after its 30 s, so it can be a tick longer or shorter: never a share above 100 %)
      let busy = 0; let all = 0;
      for (let s = 0; s < NS; s++) { const x = Math.max(0, at(j, s) - at(j - 1, s)); all += x; if (s <= 4) busy += x; }
      out.push(all > 0 ? Math.min(1, busy / all) : 0);
    }
    return out;
  }

  /** Battery now, the lowest charge inside the window (since the window began, or inside the buckets of the last 30 minutes) and the charge stops that ended in it. */
  batteryOf(i, w = this.windowOf('start')) {
    if (!this.vOk(i)) return { now: 1, min: 1, stops: [] };
    const battery = this.V[i].battery;
    let min = battery;
    if (w.zero) min = Math.min(min, this.batMin[i]); // the whole run so far: the running minimum
    else {
      min = Math.min(min, this.bktMin[i]);
      for (let j = Math.max(1, this.bCount - (RING - 2)); j <= this.bCount; j++) min = Math.min(min, this.vRing[(j % RING) * this.nV * VF + i * VF + F_BMIN]);
    }
    return { now: battery, min, stops: this.chargeStops(i, w) };
  }

  /** Where vehicle `i` stood in the queue for a dock, by station: seconds (legs that started in the window) and the dock cell its usual path ended at. */
  queuesOf(i, w = this.windowOf('start')) {
    if (!this.vOk(i)) return [];
    const L = this.legs; const lt = this.legFrom(w); const by = new Map();
    for (let k = 0; k < L.size; k++) {
      const r = L.at(k);
      if (L.veh[r] !== i || L.t0[r] < lt || (L.flags[r] & FLAG.PARTIAL) || L.to[r] === NONE16) continue;
      const g = by.get(L.to[r]) || { station: L.to[r], seconds: 0, legs: 0, ends: new Map() };
      g.seconds += L.dockWait[r]; g.legs++;
      if (L.path[r] >= 0 && L.dockWait[r] > 0) g.ends.set(L.path[r], (g.ends.get(L.path[r]) || 0) + L.dockWait[r]);
      by.set(L.to[r], g);
    }
    return [...by.values()].filter((g) => g.seconds > 0).sort((a, b) => b.seconds - a.seconds).map((g) => {
      const best = [...g.ends].sort((a, b) => b[1] - a[1])[0];
      const nodes = best ? this.pool.nodes(best[0]) : null;
      return { station: g.station, seconds: g.seconds, legs: g.legs, dockNode: nodes ? nodes[nodes.length - 1] : -1 };
    });
  }

  /** The cells of a hot table with the vehicle's running streak added (reads only: a query must not change what the collector will record next). */
  topOf(table, i, n, curNode, curSecs, skipQueue) {
    const out = [];
    let streakDone = curNode < 0;
    for (let k = i * HOT_SLOTS; k < (i + 1) * HOT_SLOTS; k++) {
      const key = table.keys[k];
      if (key < 0) continue;
      let sec = table.secs[k];
      if (key === curNode) { sec += curSecs; streakDone = true; }
      if (skipQueue) sec -= this.queueSecondsAt(i, key);
      if (sec > 1e-9) out.push({ node: key, seconds: sec });
    }
    if (!streakDone && curSecs > 0) out.push({ node: curNode, seconds: curSecs - (skipQueue ? this.queueSecondsAt(i, curNode) : 0) });
    out.sort((a, b) => b.seconds - a.seconds);
    return out.slice(0, n);
  }

  queueSecondsAt(i, node) {
    for (let k = i * HOT_SLOTS; k < (i + 1) * HOT_SLOTS; k++) if (this.hotQ.keys[k] === node) return this.hotQ.secs[k];
    return 0;
  }

  /** The legs of vehicle `i` in the window grouped by (kind, origin, destination): trips, metres, times, usual path and its share. */
  routesOf(i, w = this.windowOf('start'), kinds = [1]) {
    if (!this.vOk(i)) return [];
    const L = this.legs; const lt = this.legFrom(w); const groups = new Map();
    for (let k = 0; k < L.size; k++) {
      const r = L.at(k);
      if (L.veh[r] !== i || !kinds.includes(L.kind[r]) || L.t0[r] < lt) continue;
      const key = (L.kind[r] * 65536 + L.from[r]) * 65536 + L.to[r];
      let g = groups.get(key);
      if (g === undefined) groups.set(key, (g = { kind: L.kind[r], from: L.from[r], to: L.to[r], flow: L.flow[r], trips: 0, full: 0, dur: 0, wait: 0, dockWait: 0, qty: 0, paths: new Map(), disturbed: 0 }));
      g.trips++;
      const complete = (L.flags[r] & FLAG.PARTIAL) === 0;
      if (complete) { g.full++; g.dur += L.dur[r]; g.wait += L.wait[r]; g.dockWait += L.dockWait[r]; g.qty += L.qty[r]; }
      if (L.flags[r] & FLAG.RELOCATED) g.disturbed++;
      const pid = (L.flags[r] & FLAG.RELOCATED) ? -3 : L.path[r]; // a leg that was relocated by deadlock resolution restarted its route mid-way: a trip, but not a path of this pair
      let p = g.paths.get(pid);
      if (p === undefined) g.paths.set(pid, (p = { id: pid, n: 0, full: 0, dur: 0, wait: 0 }));
      p.n++;
      if (complete) { p.full++; p.dur += L.dur[r]; p.wait += L.wait[r]; }
    }
    const out = [];
    for (const g of groups.values()) {
      // only drawable paths (id >= 0) are variants of a route: -1 (pool full) and -2 (length 0) are counted as trips, reported as `undrawn`, and never become "the usual route"
      let best = null; let drawn = 0; let variants = 0;
      for (const p of g.paths.values()) if (p.id >= 0) { drawn += p.n; variants++; if (best === null || p.n > best.n || (p.n === best.n && p.id < best.id)) best = p; }
      const metres = best ? this.pool.len[best.id] * this.cell : null;
      out.push({
        kind: g.kind, from: g.from, to: g.to, flow: g.flow, trips: g.trips, complete: g.full, meanTime: g.full ? g.dur / g.full : null, meanWait: g.full ? g.wait / g.full : null,
        meanDockWait: g.full ? g.dockWait / g.full : null, meanQty: g.full ? g.qty / g.full : null, pathId: best ? best.id : -1, pathShare: best && drawn ? best.n / drawn : 0,
        drawn, undrawn: g.trips - drawn, variants, metres, usualTime: best && best.full ? best.dur / best.full : null, usualWait: best && best.full ? best.wait / best.full : null, disturbed: g.disturbed,
        pathIds: [...g.paths.values()].filter((p) => p.id >= 0).sort((a, b) => b.n - a.n || a.id - b.id).map((p) => ({ id: p.id, n: p.n, complete: p.full, meanTime: p.full ? p.dur / p.full : null, meanWait: p.full ? p.wait / p.full : null })),
      });
    }
    out.sort((a, b) => b.trips - a.trips || (b.metres ?? 0) - (a.metres ?? 0) || a.from - b.from || a.to - b.to);
    return out;
  }

  /**
   * The usual ROUND of vehicle `i`: the most frequent sequence of `jobs` consecutive loaded trips (origin -> destination pairs) between two visits of a depot or charger.
   * The empty drive between two trips is implied (end of the first, start of the second). Ties go to the sequence seen first. Returns null below 3 occurrences.
   * { jobs: [{ from, to }], count, of, share }: `of` = the number of sequences of that length in the window, `share` = count / of.
   */
  roundOf(i, w = this.windowOf('start'), jobs = 2) {
    if (!this.vOk(i) || !(jobs >= 1)) return null;
    const L = this.legs; const lt = this.legFrom(w); const seen = new Map(); let of = 0; let run = [];
    const flush = () => {
      for (let k = 0; k + jobs <= run.length; k++) {
        of++;
        let key = '';
        for (let j = 0; j < jobs; j++) key += (j ? '|' : '') + run[k + j];
        const e = seen.get(key);
        if (e === undefined) seen.set(key, { n: 1, first: of, parts: run.slice(k, k + jobs) }); else e.n++;
      }
      run = [];
    };
    for (let k = 0; k < L.size; k++) {
      const r = L.at(k);
      if (L.veh[r] !== i || L.t0[r] < lt) continue;
      if (L.kind[r] >= 2) { flush(); continue; } // to a charger or to park: the round starts over
      if (L.kind[r] === 1 && L.from[r] !== NONE16 && L.to[r] !== NONE16) run.push(L.from[r] * 65536 + L.to[r]);
    }
    flush();
    let best = null;
    for (const e of seen.values()) if (best === null || e.n > best.n || (e.n === best.n && e.first < best.first)) best = e;
    if (best === null || best.n < 3) return null;
    return { jobs: best.parts.map((c) => ({ from: Math.floor(c / 65536), to: c % 65536 })), count: best.n, of, share: best.n / of };
  }

  /**
   * Per vehicle, SINCE THE WINDOW BEGAN only (a cell table has no 30-minute version): where it waited, top n cells (seconds booked on the cell that blocks), WITHOUT the
   * seconds it spent in the queue for a dock (those are `queuesOf`), so that the two lists never count a second twice. `total` = all waiting seconds booked
   * (tables plus the part folded into `other`), the denominator of a cell's share.
   */
  hotspots(i, n = 5) {
    if (!this.vOk(i)) return { cells: [], total: 0, folded: 0 };
    const cells = this.topOf(this.hot, i, n, this.curNode[i], this.curSecs[i], true);
    let total = this.hot.other[i] + (this.curNode[i] >= 0 ? this.curSecs[i] : 0);
    for (let k = i * HOT_SLOTS; k < (i + 1) * HOT_SLOTS; k++) if (this.hot.keys[k] >= 0) total += this.hot.secs[k];
    return { cells, total, folded: this.hot.other[i] };
  }

  idleSpots(i, n = 3) { return this.vOk(i) ? this.topOf(this.idleHot, i, n, this.curIdle[i], this.curIdleSecs[i], false) : []; }

  /**
   * The loaded routes that start at (`from`) or end at (`to`) a station, all vehicles: trips, mean time and waiting, the usual path and its share of the DRAWN trips. As in routesOf, a
   * relocated leg, a zero-length leg and a leg that found the path pool full are trips but not variants: `drawn` + `undrawn` = `trips`, `variants` counts drawable paths only.
   */
  loadedRoutes({ from = -1, to = -1 } = {}, w = this.windowOf('start')) {
    const L = this.legs; const lt = this.legFrom(w); const groups = new Map();
    for (let k = 0; k < L.size; k++) {
      const r = L.at(k);
      if (L.kind[r] !== 1 || L.t0[r] < lt || (from >= 0 && L.from[r] !== from) || (to >= 0 && L.to[r] !== to) || L.from[r] === NONE16) continue;
      const key = L.from[r] * 65536 + L.to[r];
      let g = groups.get(key);
      if (g === undefined) groups.set(key, (g = { from: L.from[r], to: L.to[r], trips: 0, full: 0, dur: 0, wait: 0, disturbed: 0, paths: new Map() }));
      g.trips++;
      if (!(L.flags[r] & FLAG.PARTIAL)) { g.full++; g.dur += L.dur[r]; g.wait += L.wait[r]; }
      if (L.flags[r] & FLAG.RELOCATED) g.disturbed++;
      else g.paths.set(L.path[r], (g.paths.get(L.path[r]) || 0) + 1);
    }
    return [...groups.values()].map((g) => {
      let best = null; let drawn = 0; let variants = 0;
      for (const [id, n] of g.paths) if (id >= 0) { drawn += n; variants++; if (best === null || n > best[1] || (n === best[1] && id < best[0])) best = [id, n]; }
      return {
        from: g.from, to: g.to, trips: g.trips, meanTime: g.full ? g.dur / g.full : null, meanWait: g.full ? g.wait / g.full : null, pathId: best ? best[0] : -1, share: best && drawn ? best[1] / drawn : 0,
        drawn, undrawn: g.trips - drawn, disturbed: g.disturbed, variants, metres: best ? this.pool.len[best[0]] * this.cell : null,
      };
    }).sort((a, b) => b.trips - a.trips || a.from - b.from || a.to - b.to);
  }

  /** Visits to a station by vehicle, from the legs that ended there. */
  visitsTo(st, w = this.windowOf('start')) {
    if (!this.sOk(st)) return { visits: 0, meanApproach: null, meanDockQueue: null, byVehicle: [] };
    const L = this.legs; const lt = this.legFrom(w); const by = new Map(); let n = 0; let dur = 0; let dockWait = 0;
    for (let k = 0; k < L.size; k++) {
      const r = L.at(k);
      if (L.to[r] !== st || L.kind[r] > 1 || L.t0[r] < lt) continue;
      n++; dur += L.dur[r]; dockWait += L.dockWait[r]; by.set(L.veh[r], (by.get(L.veh[r]) || 0) + 1);
    }
    return { visits: n, meanApproach: n ? dur / n : null, meanDockQueue: n ? dockWait / n : null, byVehicle: [...by].map(([veh, c]) => ({ veh, visits: c })).sort((a, b) => b.visits - a.visits) };
  }

  /**
   * The loaded routes of the whole plant by loaded metres (the plant at a glance): the metres of a route are those of the drawable paths of its trips (a relocated leg, a zero-length leg
   * and a leg with no room in the path pool are trips with no metres). `total` = the metres of all routes, `share` that of a route in it.
   */
  busiestRoutes(w = this.windowOf('start'), top = 4) {
    const L = this.legs; const lt = this.legFrom(w); const groups = new Map();
    for (let k = 0; k < L.size; k++) {
      const r = L.at(k);
      if (L.kind[r] !== 1 || L.t0[r] < lt || L.from[r] === NONE16) continue;
      const key = L.from[r] * 65536 + L.to[r];
      let g = groups.get(key);
      if (g === undefined) groups.set(key, (g = { from: L.from[r], to: L.to[r], trips: 0, metres: 0, paths: new Map() }));
      g.trips++;
      const pid = L.path[r];
      if (pid >= 0 && !(L.flags[r] & FLAG.RELOCATED)) { g.metres += this.pool.len[pid] * this.cell; g.paths.set(pid, (g.paths.get(pid) || 0) + 1); }
    }
    const all = [...groups.values()].sort((a, b) => b.metres - a.metres || b.trips - a.trips || a.from - b.from || a.to - b.to);
    const total = all.reduce((s, g) => s + g.metres, 0);
    const usual = (g) => { let best = null; for (const [id, n] of g.paths) if (best === null || n > best[1] || (n === best[1] && id < best[0])) best = [id, n]; return best ? best[0] : -1; };
    return { total, routes: all.slice(0, top).map((g) => ({ from: g.from, to: g.to, trips: g.trips, metres: g.metres, share: total ? g.metres / total : 0, pathId: usual(g) })) };
  }

  /**
   * Legs (loaded, empty and drives to a depot) whose logged path touches any of `nodes`, by kind and flow: key 'loaded|<flow index>', 'empty|<flow index>' or 'depot|65535'. For a selected
   * cell or stretch. The paths through the cells come from the pool's cell index (built on the first call, extended by the next ones), so a call costs one pass over the leg log, not
   * a decoding of every path (37 to 60 ms on every call on a full log of the 100-vehicle plant before the index; now the first call builds the index, about 40 ms for 16,000 paths of 150 cells, and the next ones take about 1 ms).
   */
  cellUse(nodes, w = this.windowOf('start')) {
    const L = this.legs; const lt = this.legFrom(w); const byFlow = new Map();
    const through = this.pool.pathsThrough(nodes);
    let legs = 0;
    if (through.size > 0) {
      for (let k = 0; k < L.size; k++) {
        const r = L.at(k);
        if (L.t0[r] < lt) continue;
        const pid = L.path[r];
        if (pid < 0 || !through.has(pid)) continue;
        legs++;
        const key = `${L.kind[r] === 1 ? 'loaded' : L.kind[r] === 0 ? 'empty' : 'depot'}|${L.flow[r]}`; // a drive to a charger or to park has no flow (65535)
        byFlow.set(key, (byFlow.get(key) || 0) + 1);
      }
    }
    return { legs, byFlow: [...byFlow].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) };
  }

  /** Station figures over a window: sampled shares (1 s), counters, and the event means of Goods in (wait in the output buffer per order, wait in the yard per pallet). */
  stationWindow(i, w = this.windowOf('start')) {
    if (!this.sOk(i)) return { seconds: 0, fill: 0, inQ: 0, outQ: 0, busy: 0, starved: 0, blocked: 0, down: 0, arrivals: 0, produced: 0, consumed: 0, orders: 0, bufferWait: null, pallets: 0, yardWait: null, intakeWait: null };
    const o = i * 7; const row = w.row * this.nS * SFN + i * SFN;
    const get = (k) => Math.max(0, this.sInt[o + k] - (w.zero ? 0 : this.sRing[row + k]));
    const ev = (k) => Math.max(0, this.sEv[i * 5 + k] - (w.zero ? 0 : this.sRing[row + 10 + k]));
    const secs = Math.max(0, this.sSecs - (w.zero ? 0 : this.ringN[w.row]));
    const st = this.stations[i];
    const nm = st.machines ? st.machines.length : 0;
    const base = (k) => this.sBase[i * 3 + k];
    const cnt = (k, cur) => Math.max(0, Math.round(cur - base(k) - (w.zero ? 0 : this.sRing[row + 7 + k])));
    const share = (x, den) => Math.min(1, Math.max(0, x / den));
    const den = Math.max(1, nm) * Math.max(1, secs);
    return {
      seconds: secs, fill: get(0) / Math.max(1, secs), inQ: get(1) / Math.max(1, secs), outQ: get(2) / Math.max(1, secs),
      busy: share(get(3), den), starved: share(get(4), den), blocked: share(get(5), den), down: share(get(6), den),
      arrivals: cnt(0, st.arrivals), produced: cnt(1, st.produced), consumed: cnt(2, st.consumed),
      orders: ev(0), bufferWait: ev(0) > 0 ? ev(1) / ev(0) : null, pallets: ev(2), yardWait: ev(2) > 0 ? ev(3) / ev(2) : null, intakeWait: ev(2) > 0 ? ev(4) / ev(2) : null,
    };
  }

  /** The charge sessions that ended inside the window at depot `d` (a station index), all vehicles: [{ veh, t0, minutes, b0, b1 }]. For the depot page: stops per hour, mean stop length. */
  chargeStopsAt(d, w = this.windowOf('start')) {
    const c = this.charges; const out = [];
    if (!this.sOk(d)) return out;
    for (let k = 0; k < Math.min(c.count, c.cap); k++) if (c.dep[k] === d && c.t0[k] + c.dur[k] >= w.t0 - 1e-9) out.push({ veh: c.veh[k], t0: c.t0[k], minutes: c.dur[k] / 60, b0: c.b0[k], b1: c.b1[k] });
    return out;
  }

  chargeStops(i, w = this.windowOf('start')) {
    const c = this.charges; const out = [];
    for (let k = 0; k < Math.min(c.count, c.cap); k++) if (c.veh[k] === i && c.t0[k] + c.dur[k] >= w.t0 - 1e-9) out.push({ t0: c.t0[k], minutes: c.dur[k] / 60, b0: c.b0[k], b1: c.b1[k] });
    return out;
  }

  /** LIVE (no window): loads that are ready in the output buffers of station `i` and not yet claimed by a vehicle, and how long the oldest has been ready. Complements the
   *  wait of picked-up loads, which cannot see a load that is still waiting. */
  queueNow(i) {
    if (!this.sOk(i)) return { loads: 0, oldest: 0 };
    const st = this.stations[i]; const now = this.sim.time; let loads = 0; let oldest = 0;
    for (const link of st.outLinks || []) {
      const q = link.queue;
      for (let k = link.claimed; k < q.length; k++) { const load = q[k]; if (!(load.readyAt > now)) { loads++; if (now - load.readyAt > oldest) oldest = now - load.readyAt; } }
    }
    return { loads, oldest };
  }

  /** The metres to go on the open route of a driving vehicle, live (nothing is stored). */
  metresToGo(i) {
    if (!this.vOk(i)) return null;
    const vr = this.V[i]; const tv = vr.tv; const route = vr.route;
    if (!route || !tv.driving || tv.edge < 0) return null;
    const k = route.edges.indexOf(tv.edge);
    return k < 0 ? null : Math.max(0, (route.edges.length - k) * this.cell - tv.s);
  }
}
