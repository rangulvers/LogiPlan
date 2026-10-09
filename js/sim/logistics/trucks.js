// Trucks and dock doors: the runtime of `station.ops.trucks` on a Goods in (inbound trucks) and a Goods out (outbound trucks)
// (docs/WAREHOUSE-DESIGN.md 6.2.6 and 6.3; docs/ARCHITECTURE.md 5.3). Created only for the stations that have the option; every other station
// keeps `st.trucks === null` and pays one pointer test per tick, so a plant without trucks runs bit for bit as before.
//
// A truck is an EVENT, never a vehicle on the road grid: it arrives, waits at the gate, takes a door, is checked in, is unloaded or loaded
// by the plant's vehicles, is checked out and frees the door. A door is a capacity (a count), not a road cell; the dock cells and the dock
// book are untouched.
//
//   Goods in   arrive (the pallets are created now, createdAt = the arrival time) -> gate (FIFO, at most GATE_LIMIT trucks) -> door while
//              docked < doors -> check-in -> the pallets go to the yard of the station (flushYard moves them to the output buffers as
//              vehicles make room) -> UNLOADING IS EMERGENT: each pickup (finishLoading) takes one pallet off truck.left -> at left = 0
//              check-out -> the door is free.
//   Goods out  arrive (a plan of pallets to take) -> gate -> door -> check-in -> work. The Goods out is a PULL destination: flowSpace
//              (room()) lets vehicles bring only as many pallets as the staging space and the trucks at work can take. A delivered pallet
//              is loaded onto the earliest-docked truck at work with room (completeLoad: that is the moment a pallet leaves the plant), else
//              it waits in `staged`; a truck that finishes check-in takes up to `plan` staged pallets at once. A truck leaves when it is full,
//              or maxDwell after check-in with what it has - but never while reservations are outstanding (inboundTotal > 0): at maxDwell it
//              is marked `closing`, stops counting in room(), and leaves when inboundTotal = 0 or when it is full. Then check-out, door free.
//
// How the trucks come (6.2.6, 5.3): RATE mode - the first truck at params.startDelay (Goods in) or after one gap (Goods out), then
// truckGap() after each arrival, pallets drawn per truck; the demand slider scales the frequency. SCHEDULE mode - each clock day the rows of
// the timetable are expanded into a sorted due list (expandScheduleDay: no-shows, jitter, drawn pallets), merged with what is still due;
// the pallets of a truck are scaled by the demand slider when it arrives (scalePallets: 0 means no truck). All random draws come from forks
// of the station's stream ('trucks', 'trucks:pallets'), so adding a truck station elsewhere never changes the arrival times of another one,
// and the nominal arrival time (truck.at) does not depend on dt: events are APPLIED on the first tick at or after their time (like stepSource).
//
// Memory guards: at most GATE_LIMIT trucks wait at the gate, and the pallets that exist but are not picked up yet (on trucks at the gate or at a
// door, in the yard) stay below YARD_LIMIT like the yard of a legacy source; a truck that would break either is turned away.
//
// Events emitted (payloads carry `station`, `stationId`, `t` = the tick time that handled the event, and `truck` unless said otherwise):
//   truckArrived    the truck joined the gate; `at` is its nominal arrival time
//   truckTurnedAway the gate already holds GATE_LIMIT trucks: no pallets are created (no `truck`: `plan`, `at`)
//   truckNoShow     a timetable row whose truck did not come (no `truck`: `row`, `at`)
//   truckDocked     the truck took door `door`; `wait` = time at the gate
//   truckReady      check-in is over: Goods in - the pallets were released to the yard; Goods out - the truck is ready to be loaded
//   truckDeparted   check-out is over, the door is free: `doorTime` (docked -> free), `turnaround` (arrival -> free), `gateWait`, `short`
//
// Invariants (6.3.5, asserted by tests/helpers/logistics-invariants.js on every tick of the fuzz plants): docked trucks never exceed the
// doors open; the gate is FIFO; a pallet is on at most one truck; loaded <= plan; `left` equals the number of the truck's pallets not yet
// picked up; room() is never negative; staged <= stagingCap; conservation including `pending` and `staged`.

import { sanitizeOps } from '../../model/ops.js';
import { makeClock } from '../../model/calendar.js';
import { drawPallets, expandScheduleDay, expansionTime, scalePallets, truckGap } from '../../model/doors.js';
import { EPS, MIN_GAP, YARD_LIMIT, atLeast } from './common.js';
import { flushYard } from './stations.js';

/** At most this many trucks wait at the gate (memory guard, like YARD_LIMIT); a further arrival is turned away and creates no pallets. */
export const GATE_LIMIT = 200;

const GATE = 'gate';
const CHECKIN = 'checkin';
const WORK = 'work';
const CHECKOUT = 'checkout';

/** One truck. All fields are present from the start so that the hidden class never changes. */
export class Truck {
  /**
   * @param {number} id unique within the Logistics (the `tk` of its pallets)
   * @param {number} at arrival time (s), nominal
   * @param {number} plan pallets to unload (Goods in) or to load (Goods out), 1..200 (more after the demand slider in a timetable)
   */
  constructor(id, at, plan) {
    this.id = id;
    this.at = at;
    this.plan = plan;
    /** 'gate' | 'checkin' | 'work' | 'checkout' (a truck whose door is free is gone). */
    this.state = GATE;
    /** Number of the door (0-based, the lowest free one when it docked), -1 at the gate. Doors are a count; this only gives the picture a stable slot. */
    this.door = -1;
    this.dockedAt = -1;
    /** End of check-in, and end of check-out (the door is free then); Infinity until they are known. */
    this.releaseAt = Infinity;
    this.freeAt = Infinity;
    this.freedAt = -1;
    /** Goods in: pallets of this truck no vehicle has picked up yet (they are in `pending`, the yard or the output buffers). */
    this.left = plan;
    /** Goods out: pallets loaded so far. */
    this.loaded = 0;
    /** Goods out: when the truck stops waiting for pallets (maxDwell after check-in), and whether that time has come. */
    this.closeAt = Infinity;
    this.closing = false;
    /** Goods in: the pallets created at the arrival that have not been released to the yard yet (empty afterwards). */
    this.pending = [];
  }
}

const byAt = (a, b) => a.at - b.at;

/** The largest number of pallets a truck of a desk carries before the demand slider: the biggest row / the top of the pallets distribution, at most 200. */
function planMaxOf(cfg) {
  const d = cfg.pallets;
  const top = d.kind === 'const' ? d.mean : d.kind === 'uniform' ? d.mean * (1 + d.spread) : d.kind === 'normal' ? d.mean * (1 + 3 * d.spread) : 200;
  let max = Math.min(200, Math.max(1, Math.ceil(top)));
  if (cfg.mode === 'schedule') {
    max = 1;
    for (const row of cfg.schedule) max = Math.max(max, typeof row.pallets === 'number' ? row.pallets : Math.min(200, Math.max(1, Math.ceil(top))));
  }
  return max;
}

/** The truck desk of one Goods in / Goods out: its gate, its doors, its staging space and its counters. `st.trucks`. */
export class TruckDesk {
  /**
   * @param {object} st the StationRT
   * @param {object} cfg a sanitized `ops.trucks` block (the desk keeps it as `cfg`)
   * @param {object} lg the Logistics (runtime, clock)
   */
  constructor(st, cfg, lg) {
    this.cfg = cfg;
    /** 'in' (Goods in: trucks bring pallets) or 'out' (Goods out: trucks take pallets). */
    this.role = st.type === 'sink' ? 'out' : 'in';
    this.mode = cfg.mode;
    this.doors = cfg.doors;
    this.checkIn = cfg.checkIn;
    this.checkOut = cfg.checkOut;
    /** Goods out only (0 / 0 on a Goods in, whose maxDwell and staging are kept but ignored): the longest wait for pallets and the staging space. */
    this.maxDwell = this.role === 'out' ? cfg.maxDwell : 0;
    this.stagingCap = this.role === 'out' ? cfg.staging * cfg.doors : 0;
    this.rng = st.rng.fork('trucks');
    this.rngPallets = st.rng.fork('trucks:pallets');
    this.clock = lg.clock || makeClock(null);

    /** Trucks waiting for a door (FIFO), trucks at a door (in the order they docked), and the pallets waiting for a truck at a Goods out. */
    this.gate = [];
    this.docked = [];
    this.staged = [];

    /** Rate mode: when the next truck arrives (Infinity: none). Timetable: the due list, a cursor into it and the next clock day to expand. */
    this.nextArrival = Infinity;
    this.made = 0;
    this.due = [];
    this.dueIdx = 0;
    this.dayIdx = 0;
    this.expandAt = Infinity;

    /** Counters since the start of the run (the statistics take their own deltas). */
    this.arrived = 0;
    this.nDocked = 0;
    this.departed = 0;
    this.short = 0;
    this.noShow = 0;
    this.turnedAway = 0;
    this.planned = 0;
    this.loadedTotal = 0;
    /** Goods in: pallets created at an arrival that have not been released to the yard yet (memory guard). */
    this.pendingTotal = 0;
    this.lg = lg;
    /** The largest plan a truck of this desk can have in a rate-mode run or a timetable without the demand slider: what a batch into a Goods out may ever need (flowCapacity). */
    this.planMax = planMaxOf(cfg);

    if (this.mode === 'schedule') {
      this.expandAt = expansionTime(cfg, this.clock, 0);
    } else if (lg.runtime.demandFactor > 0) {
      this.nextArrival = this.role === 'in' ? atLeast(st.params.startDelay, 0, 0) : Math.max(MIN_GAP, truckGap(this.rng, cfg, lg.runtime.demandFactor));
    }
  }

  /** Doors that can take a truck now. The calendar of M2 changes this over the day; today it is the count. */
  doorsOpen() {
    return this.doors;
  }

  /** 0..1 fill of the staging space of a Goods out (the `fill` of the station). */
  get stagedFill() {
    return this.stagingCap > 0 ? Math.min(1, this.staged.length / this.stagingCap) : 0;
  }

  /**
   * Goods out: how many more pallets vehicles may be sent with now (what `flowSpace` answers): the free staging space plus the room of the
   * trucks at work that are not closing, minus the places already promised to orders on their way; never below 0. A truck in check-in does not
   * count (the dispatcher wakes when it is ready); with staging 0 pallets are only fetched while a truck is ready to take them.
   */
  room(st) {
    let room = this.stagingCap - this.staged.length;
    const docked = this.docked;
    for (let i = 0; i < docked.length; i++) {
      const truck = docked[i];
      if (truck.state === WORK && !truck.closing) room += truck.plan - truck.loaded;
    }
    room -= st.inboundTotal;
    return room > 0 ? room : 0;
  }

  /**
   * Goods out: the most pallets that could ever be on their way here at once (what `flowCapacity` answers): the staging space and the biggest truck
   * at every door. A flow's minimum batch is clamped to it, so a batch size that no truck could ever take does not starve the flow.
   */
  capacity() {
    const demand = this.mode === 'schedule' && this.lg.runtime.demandFactor > 1 ? this.lg.runtime.demandFactor : 1;
    return this.stagingCap + this.doors * Math.max(1, Math.round(this.planMax * demand));
  }

  /** One tick for the station at time t (before the dispatcher, after the vehicles' phase A). */
  step(st, t, lg) {
    this.arrivals(st, t, lg);
    this.serve(st, t, lg);
    this.dock(st, t, lg);
    if (this.role === 'in') flushYard(st, t, lg);
  }

  // ---- arrivals -----------------------------------------------------------------------------------------------

  arrivals(st, t, lg) {
    if (this.mode === 'rate') {
      while (this.nextArrival <= t + EPS) {
        const at = this.nextArrival;
        this.arrive(st, at, drawPallets(this.rngPallets, this.cfg.pallets), t, lg);
        this.made++;
        this.nextArrival = at + Math.max(MIN_GAP, truckGap(this.rng, this.cfg, lg.runtime.demandFactor));
      }
      return;
    }
    while (this.expandAt <= t + EPS) this.expandDay();
    const due = this.due;
    while (this.dueIdx < due.length && due[this.dueIdx].at <= t + EPS) {
      const entry = due[this.dueIdx++];
      if (entry.noShow) {
        this.noShow++;
        lg.emit('truckNoShow', { station: st, stationId: st.id, row: entry.row, at: entry.at, t });
        continue;
      }
      const plan = scalePallets(entry.pallets, lg.runtime.demandFactor);
      if (plan > 0) this.arrive(st, entry.at, plan, t, lg);
    }
  }

  /** The timetable of the next clock day joins the due list (a jittered truck may come before an earlier day's last one: merged by time). */
  expandDay() {
    const entries = expandScheduleDay(this.cfg, this.clock, this.dayIdx, this.rng);
    this.dayIdx++;
    this.expandAt = expansionTime(this.cfg, this.clock, this.dayIdx);
    if (this.dueIdx > 0) {
      this.due.splice(0, this.dueIdx);
      this.dueIdx = 0;
    }
    if (entries.length > 0) {
      for (const entry of entries) this.due.push(entry);
      this.due.sort(byAt); // stable: equal times keep their order, an earlier day first
    }
  }

  /** A truck arrives at `at`: it joins the gate, and a Goods in creates its pallets now (createdAt = the arrival time). */
  arrive(st, at, plan, t, lg) {
    if (this.gate.length >= GATE_LIMIT || (this.role === 'in' && this.pendingTotal + st.yardQ.length + plan > YARD_LIMIT)) {
      this.turnedAway++;
      lg.emit('truckTurnedAway', { station: st, stationId: st.id, plan, at, t });
      return;
    }
    const truck = new Truck(++lg.truckSeq, at, plan);
    if (this.role === 'in') {
      for (let i = 0; i < plan; i++) {
        const load = lg.createLoad(st, at, t, 'source');
        load.tk = truck.id;
        truck.pending.push(load);
      }
      st.produced += plan;
      st.arrivals++;
      this.pendingTotal += plan;
    }
    this.arrived++;
    this.gate.push(truck);
    lg.emit('truckArrived', { station: st, stationId: st.id, truck, at, t });
  }

  // ---- doors ----------------------------------------------------------------------------------------------------

  /** Take the trucks that are due: check-in over, pallets released, full or closing, check-out over. Departed trucks leave `docked`. */
  serve(st, t, lg) {
    const docked = this.docked;
    for (let i = 0; i < docked.length; i++) {
      const truck = docked[i];
      this.progress(st, truck, t, lg);
      if (truck.state === CHECKOUT && truck.freeAt <= t + EPS) {
        docked.splice(i, 1);
        i--;
        this.depart(st, truck, t, lg);
      }
    }
  }

  /** Trucks from the gate take free doors, first come first served. */
  dock(st, t, lg) {
    const gate = this.gate;
    const docked = this.docked;
    while (gate.length > 0 && docked.length < this.doorsOpen()) {
      const truck = gate.shift();
      truck.state = CHECKIN;
      truck.door = this.freeDoor();
      truck.dockedAt = t;
      truck.releaseAt = t + this.checkIn;
      docked.push(truck);
      this.nDocked++;
      lg.emit('truckDocked', { station: st, stationId: st.id, truck, door: truck.door, wait: t - truck.at, t });
      this.progress(st, truck, t, lg); // a check-in of 0 s is over at once
    }
  }

  /** The lowest door number no docked truck uses. */
  freeDoor() {
    const docked = this.docked;
    for (let door = 0; door < this.doors; door++) {
      let used = false;
      for (let i = 0; i < docked.length && !used; i++) used = docked[i].door === door;
      if (!used) return door;
    }
    return docked.length;
  }

  /** Move one docked truck on as far as time and state allow (check-in over -> work; Goods out: closing, full -> check-out). */
  progress(st, truck, t, lg) {
    if (truck.state === CHECKIN && truck.releaseAt <= t + EPS) this.ready(st, truck, t, lg);
    if (truck.state === WORK && this.role === 'out') {
      if (!truck.closing && truck.closeAt <= t + EPS) truck.closing = true;
      if (truck.loaded >= truck.plan || (truck.closing && st.inboundTotal === 0)) this.beginCheckout(truck, t);
    }
  }

  /** Check-in is over. Goods in: the pallets go to the yard. Goods out: the truck takes the staged pallets and starts waiting for more. */
  ready(st, truck, t, lg) {
    truck.state = WORK;
    if (this.role === 'in') {
      const yard = st.yardQ;
      for (let i = 0; i < truck.pending.length; i++) yard.push(truck.pending[i]);
      this.pendingTotal -= truck.pending.length;
      truck.pending.length = 0;
    } else {
      truck.closeAt = this.maxDwell > 0 ? t + this.maxDwell : Infinity;
      const take = Math.min(truck.plan, this.staged.length);
      if (take > 0) {
        const loads = this.staged.splice(0, take);
        for (let i = 0; i < loads.length; i++) {
          truck.loaded++;
          lg.completeLoad(loads[i], st, t);
        }
      }
      lg.markDirty(); // the truck's room is new demand for the dispatcher
    }
    lg.emit('truckReady', { station: st, stationId: st.id, truck, t });
  }

  beginCheckout(truck, t) {
    truck.state = CHECKOUT;
    truck.freeAt = t + this.checkOut;
  }

  /** The door is free again. */
  depart(st, truck, t, lg) {
    truck.freedAt = t;
    this.departed++;
    const short = this.role === 'out' && truck.loaded < truck.plan;
    if (this.role === 'out') {
      this.planned += truck.plan;
      this.loadedTotal += truck.loaded;
      if (short) this.short++;
    }
    lg.emit('truckDeparted', {
      station: st, stationId: st.id, truck, short, doorTime: t - truck.dockedAt, turnaround: t - truck.at, gateWait: truck.dockedAt - truck.at, t,
    });
  }

  // ---- pallets ----------------------------------------------------------------------------------------------------

  /** Goods in: vehicles picked up `loads` (finishLoading). The truck of each pallet has one less to wait for; the last one starts check-out. */
  pickedUp(loads, t) {
    const docked = this.docked;
    for (let i = 0; i < loads.length; i++) {
      const id = loads[i].tk;
      if (id < 0) continue;
      for (let k = 0; k < docked.length; k++) {
        const truck = docked[k];
        if (truck.id !== id) continue;
        if (--truck.left === 0 && truck.state === WORK) this.beginCheckout(truck, t);
        break;
      }
    }
  }

  /** Goods out: vehicles delivered `loads` (acceptLoads). Each is loaded onto the earliest-docked truck at work with room, else it is staged. */
  receive(st, loads, t, lg) {
    const docked = this.docked;
    for (let i = 0; i < loads.length; i++) {
      let target = null;
      for (let k = 0; k < docked.length; k++) {
        const truck = docked[k];
        if (truck.state === WORK && truck.loaded < truck.plan) { target = truck; break; }
      }
      if (target === null) {
        this.staged.push(loads[i]);
      } else {
        target.loaded++;
        lg.completeLoad(loads[i], st, t);
      }
    }
  }

  // ---- what-if ---------------------------------------------------------------------------------------------------

  /**
   * demandFactor changed. Rate mode: the pending arrival keeps its place in the (rescaled) arrival process, exactly as rescaleArrivals does for a
   * legacy source (the first arrival is a fixed offset, not part of that process). Timetable: appointments do not move and the demand scales the
   * pallets of a truck when it arrives, so there is nothing to rescale.
   */
  rescale(st, oldFactor, newFactor, now, lg) {
    if (this.mode !== 'rate') return;
    // the first truck of a Goods in comes at startDelay, a fixed offset; the first truck of a Goods out is the first draw of the process
    const fixedFirst = this.role === 'in' && this.made === 0;
    if (!(newFactor > 0)) { this.nextArrival = Infinity; return; }
    if (!(oldFactor > 0)) {
      this.nextArrival = fixedFirst ? Math.max(atLeast(st.params.startDelay, 0, 0), now) : now + Math.max(MIN_GAP, truckGap(this.rng, this.cfg, newFactor));
      return;
    }
    if (fixedFirst) return;
    this.nextArrival = now + Math.max(0, this.nextArrival - now) * (oldFactor / newFactor);
  }
}

/**
 * Give every Goods in / Goods out that has `ops.trucks` its truck desk (`st.trucks`) and the plant its truck sequence. Called once by Logistics
 * after the runtime settings and the clock exist. The block is sanitized again here, so a hand-made layout that did not go through normalizeLayout
 * cannot put junk into the run.
 * @param {object} lg the Logistics
 * @returns {boolean} whether any station has trucks
 */
export function setupTrucks(lg) {
  let any = false;
  for (const st of lg.stations) {
    if (st.type !== 'source' && st.type !== 'sink') continue;
    const ops = sanitizeOps(st.type, st.def.ops);
    if (!ops || !ops.trucks) continue;
    st.trucks = new TruckDesk(st, ops.trucks, lg);
    if (st.type === 'source') st.nextArrival = Infinity; // the legacy arrival loop never runs for a station with trucks
    any = true;
  }
  return any;
}
