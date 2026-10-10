// The live demo of the /how page, without a DOM: which plants it offers, the one thing it can change in each, how the real
// simulation is paced, and how the numbers next to the drawing are read from the simulation's own report.
//
// Everything here runs in Node as well as in the browser (tests/how.demo.test.js). The engine (js/sim/engine.js) and the plants
// (js/model/examples.js) are the app's own files, imported by demo.js and passed in; nothing is copied or re-implemented.
//
// Honesty rules of this file:
//  * a number that is shown comes from sim.kpis() (the report the app's Results tab reads) and from nothing else;
//  * what the demo changes in a plant is written down in CHANGES below and applied to a copy of the app's example, so the
//    visitor sees exactly the edit the app's own tip for that example describes;
//  * when the visitor's machine is too slow for the chosen speed the demo drops simulated seconds, never frames, and says so.

import { formatClock, formatDuration, formatNumber, formatPercent } from '../../js/util/format.js';

// ---- the plants the demo offers ---------------------------------------------------------------------------------------

/**
 * `exampleId`  an id of EXAMPLES (js/model/examples.js). `unit` is what the plant's loads are called.
 * `speed`      the speed it starts at (simulated seconds per real second).
 * `scenario`   what is set before the run in BOTH plants (a runtime setting of the app's Simulate tab), if anything.
 * `change`     the one edit of the second plant: `fleet` (id of the plant's fleet) gets `count` vehicles.
 * `show`       the figures next to the drawing, in this order (keys of FIGURES).
 * `seed`       the random seed of every run of this plant: the same seed gives the same run on every machine.
 */
export const DEMOS = Object.freeze([
  {
    id: 'hello-pallet',
    exampleId: 'hello-pallet',
    title: 'Hello, pallet',
    unit: 'pallets',
    speed: 120,
    seed: 1,
    scenario: { demandFactor: 2 },
    scenarioText: 'twice the pallets of the example',
    change: { fleet: 'v1', count: 2, label: 'A second forklift' },
    show: ['delivered', 'perHour', 'lead', 'inPlant', 'busy'],
  },
  {
    id: 'warehouse-first-day',
    exampleId: 'warehouse-first-day',
    title: 'Warehouse: first day',
    unit: 'pallets',
    speed: 120,
    seed: 1,
    scenario: null,
    scenarioText: '',
    change: { fleet: 'v1', count: 5, label: 'A fifth forklift' },
    show: ['gate', 'delivered', 'perHour', 'inPlant', 'busy', 'traffic'],
  },
  {
    id: 'congestion-lab',
    exampleId: 'congestion-lab',
    title: 'Congestion lab',
    unit: 'pallets',
    speed: 600,
    seed: 1,
    scenario: null,
    scenarioText: '',
    change: { fleet: null, count: 6, label: 'Six AGVs instead of nine' },
    show: ['delivered', 'perHour', 'lead', 'traffic', 'busy'],
  },
  {
    id: 'two-lines',
    exampleId: 'two-lines',
    title: 'Two lines and a warehouse',
    unit: 'products',
    speed: 600,
    seed: 1,
    scenario: null,
    scenarioText: '',
    change: { fleet: 'v2', count: 5, label: 'Five AGVs instead of seven' },
    show: ['delivered', 'perHour', 'lead', 'inPlant', 'busy', 'traffic'],
  },
]);

/** A whole shift: eight simulated hours, the run length the planner's own tips talk about. */
export const SHIFT_SECONDS = 8 * 3600;

export const SPEEDS = Object.freeze([10, 60, 120, 600, 1200]);

/** Look a demo up by id; the first one for an unknown id. */
export function demoById(id) {
  return DEMOS.find((d) => d.id === id) || DEMOS[0];
}

/** The simulated seconds every run is rolled forward silently before the first frame: the 10-minute warm-up the engine discards, plus two minutes. */
export function primeSeconds(warmup) {
  const w = Number.isFinite(warmup) && warmup > 0 ? warmup : 0;
  return w + 120;
}

/**
 * The layout one pane runs: a fresh copy of the app's example, with the demo's scenario and (for the changed pane) its one edit.
 * Pure: `build` is the example's own builder, which returns a new layout on every call.
 * @param {object} demo an entry of DEMOS
 * @param {() => object} build the example's build()
 * @param {boolean} changed apply the demo's edit
 */
export function layoutFor(demo, build, changed) {
  const layout = build();
  layout.settings = { ...layout.settings, seed: demo.seed, ...(demo.scenario || {}) };
  if (changed && demo.change) {
    const fleets = layout.fleets || [];
    const fleet = demo.change.fleet === null ? fleets[0] : fleets.find((f) => f.id === demo.change.fleet);
    if (!fleet) throw new Error(`demo "${demo.id}": no fleet "${demo.change.fleet}" in the example`);
    fleet.count = demo.change.count;
  }
  return layout;
}

/** The fleet the edit concerns (name and counts), for the labels of the two panes. */
export function changeFacts(demo, layout) {
  const fleets = layout.fleets || [];
  const fleet = demo.change.fleet === null ? fleets[0] : fleets.find((f) => f.id === demo.change.fleet);
  return { fleetName: fleet ? fleet.name : '', from: fleet ? fleet.count : NaN, to: demo.change.count };
}

// ---- where to look ----------------------------------------------------------------------------------------------------

/**
 * The part of the baseplate that holds something (roads, stations, obstacles, labels) plus `marginCells`, in metres, clamped to the plate.
 * The demo points its camera here, so a plant on a big plate is not drawn tiny in the middle of empty studs.
 * @param {object} scene from getScene() (js/ui/render/scene.js)
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function contentRect(scene, marginCells = 2) {
  const cs = scene.cs;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const take = (ax, ay, bx, by) => {
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx);
    y1 = Math.max(y1, by);
  };
  for (const r of scene.roads) take(r.cx * cs, r.cy * cs, (r.cx + 1) * cs, (r.cy + 1) * cs);
  for (const s of scene.stations) take(s.x, s.y, s.x + s.w, s.y + s.h);
  for (const o of scene.obstacles) take(o.x * cs, o.y * cs, (o.x + o.w) * cs, (o.y + o.h) * cs);
  for (const l of scene.labels) take((l.x - 2) * cs, (l.y - l.size) * cs, (l.x + 2) * cs, (l.y + l.size) * cs);
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: scene.width, h: scene.height };
  const m = marginCells * cs;
  const left = Math.max(0, x0 - m);
  const top = Math.max(0, y0 - m);
  const right = Math.min(scene.width, x1 + m);
  const bottom = Math.min(scene.height, y1 + m);
  return { x: left, y: top, w: Math.max(cs, right - left), h: Math.max(cs, bottom - top) };
}

// ---- the figures --------------------------------------------------------------------------------------------------------

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The first truck station that receives trucks ("Goods in"), as the report names it, or null. */
function gateStation(report) {
  const trucks = report && report.ops && report.ops.trucks;
  if (!trucks) return null;
  for (const entry of Object.values(trucks)) if (entry && entry.role === 'in') return entry;
  return null;
}

/** The biggest fleet of the report (by vehicles), or null. */
function mainFleet(report) {
  let best = null;
  for (const fleet of Object.values((report && report.fleets) || {})) if (!best || fleet.count > best.count) best = fleet;
  return best;
}

/**
 * Every figure the demo can show: label, a `read(report, demo)` returning { value, note } as display strings (value '–' when the
 * report has nothing yet) and `hint`, the sentence that says what it means. All values come from the KpiReport (docs/ARCHITECTURE.md 5.4).
 */
export const FIGURES = Object.freeze({
  delivered: {
    label: (demo) => `${capital(demo.unit)} delivered`,
    hint: 'Loads that have left through a Goods out since the end of the warm-up.',
    read: (r) => (r.throughput ? { value: formatNumber(r.throughput.total), note: '' } : none()),
  },
  perHour: {
    label: () => 'Output per hour',
    hint: 'Loads delivered per hour of measured time.',
    read: (r) => (r.throughput && r.window && r.window.duration >= 60 ? { value: formatNumber(r.throughput.perHour, 1), note: 'per hour' } : none()),
  },
  lead: {
    label: () => 'Time in the plant',
    hint: 'Average time from a load being made to its delivery.',
    read: (r) => (r.leadTime && finite(r.leadTime.mean) ? { value: formatDuration(r.leadTime.mean), note: 'on average' } : none()),
  },
  inPlant: {
    label: (demo) => `${capital(demo.unit)} in the plant`,
    hint: 'Work in process right now: loads made and not yet delivered.',
    read: (r) => (r.wip && finite(r.wip.now) ? { value: formatNumber(r.wip.now), note: 'right now' } : none()),
  },
  busy: {
    label: (demo, r) => `${(mainFleet(r) || { name: 'Vehicles' }).name} busy`,
    hint: 'Share of vehicle time spent driving, waiting in traffic, loading or unloading.',
    read: (r) => {
      const fleet = mainFleet(r);
      return fleet && finite(fleet.utilization) ? { value: formatPercent(Math.min(1, fleet.utilization)), note: `${fleet.count} ${fleet.count === 1 ? 'vehicle' : 'vehicles'}` } : none();
    },
  },
  traffic: {
    label: () => 'Waiting in traffic',
    hint: 'Share of driving time vehicles spent held up by other vehicles.',
    read: (r) => (r.traffic && finite(r.traffic.waitShare) ? { value: formatPercent(r.traffic.waitShare), note: 'of driving time' } : none()),
  },
  gate: {
    label: () => 'Truck wait at the gate',
    hint: 'How long a truck waited for a free door, on average.',
    read: (r) => {
      const gate = gateStation(r);
      const mean = gate && gate.gateWait ? gate.gateWait.mean : null;
      return finite(mean) ? { value: mean < 1 ? '0 s' : formatDuration(mean), note: 'on average' } : none();
    },
  },
});

function none() {
  return { value: '–', note: '' };
}

function capital(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The figures of one pane, from its report. `window.warmingUp` (the engine is still in its discarded warm-up) shows no figures at all.
 * @returns {{ clock: string, warmingUp: boolean, items: Array<{ key: string, label: string, value: string, note: string, hint: string }> }}
 */
export function readFigures(demo, report, simTime) {
  const warmingUp = !report || !report.window || report.window.warmingUp === true;
  const items = demo.show.map((key) => {
    const fig = FIGURES[key];
    const got = warmingUp ? none() : fig.read(report, demo);
    return { key, label: fig.label(demo, report || {}), value: got.value, note: got.note, hint: fig.hint };
  });
  return { clock: formatClock(simTime), warmingUp, items };
}

/**
 * A few sentences per pane for people who do not see the drawing; the page updates it every few seconds, not on every frame.
 * Says only what the report says: "The example, simulated time 8:00:00: Pallets delivered 257; Time in the plant 80.7 min on average; ...".
 */
export function describeFigures(paneName, figures) {
  const head = `${paneName}, simulated time ${figures.clock}`;
  if (figures.warmingUp) return `${head}: the plant is still filling up; figures count from minute 10.`;
  const parts = figures.items.filter((i) => i.value !== '–').map((i) => {
    const note = i.note && i.note !== 'per hour' ? (/^\d/.test(i.note) ? ` (${i.note})` : ` ${i.note}`) : '';
    return `${i.label} ${i.value}${note}`;
  });
  return `${head}: ${parts.length ? parts.join('; ') : 'no figures yet'}.`;
}

// ---- pacing: the speed governor ------------------------------------------------------------------------------------------

/** Longest real time (s) one frame may add to the simulated clock (a tab that was in the background does not fast-forward). */
export const MAX_FRAME_SECONDS = 0.1;
/** The simulation may lag its clock by this much real time (s) at the chosen speed; beyond that simulated seconds are dropped. */
export const LAG_CAP_SECONDS = 0.5;
/** Lag (in ticks) that counts as "behind". */
export const BEHIND_TICKS = 2;
/** Behind for this long (ms) and the page says the machine cannot keep up. */
export const LIMITED_AFTER_MS = 500;
/** Whole-frame work the demo aims at (ms): simulation and drawing together, well under the 50 ms of a long task. */
export const FRAME_WORK_MS = 12;
export const MIN_SIM_BUDGET_MS = 3;
export const MAX_SIM_BUDGET_MS = 9;
/** Simulated seconds one chunk of lock-step advances, so two runs never drift apart by more than this. */
export const LOCKSTEP_SECONDS = 1;
/** Per frame decay of the rate estimate (about 60 frames, one second). */
const RATE_DECAY = 0.985;

/** Wall-clock budget (ms) for the simulation in the next frame, given what drawing cost last frame. */
export function simBudget(drawMs) {
  const spare = FRAME_WORK_MS - (Number.isFinite(drawMs) ? Math.max(0, drawMs) : 0);
  return Math.min(MAX_SIM_BUDGET_MS, Math.max(MIN_SIM_BUDGET_MS, spare));
}

/**
 * The pacer turns real time into simulated time. It owns the display clock `target` and decides, per frame, how far the
 * simulation has to go. It never skips drawing: a slow machine runs the plant slower than asked (and `limited` says so).
 */
export class Pacer {
  constructor() {
    this.target = 0;
    this.behindSince = null;
    this.limited = false;
    /** Simulated seconds per real second actually achieved (smoothed), 0 until measured. */
    this.effective = 0;
    this._adv = 0;
    this._real = 0;
  }

  /** Start from simulated time `time` (play pressed, a new plant). */
  reset(time) {
    this.target = time;
    this.behindSince = null;
    this.limited = false;
    this.effective = 0;
    this._adv = 0;
    this._real = 0;
  }

  /**
   * Seconds of simulated time to ask the engine for this frame.
   * @param {number} realDt real seconds since the last frame
   * @param {number} simTime where the simulation is
   * @param {number} dt tick length of the simulation (s)
   * @param {number} speed simulated seconds per real second
   */
  want(realDt, simTime, dt, speed) {
    const cap = Math.max(speed * LAG_CAP_SECONDS, 4 * dt);
    const step = Math.min(Math.max(0, realDt), MAX_FRAME_SECONDS) * speed;
    // the backlog is cut BEFORE the request: simulated seconds are dropped, frames never are
    this.target = Math.min(this.target + step, simTime + cap);
    return Math.max(0, this.target - simTime);
  }

  /**
   * After the engine has run: interpolation alpha for the drawing, and the `limited` flag.
   * @returns {number} alpha 0..1 (where the display clock lies inside the last tick)
   */
  settle(simTime, dt, realDt, advanced, nowMs) {
    const lag = this.target - simTime;
    const behind = lag > BEHIND_TICKS * dt;
    if (!behind) this.behindSince = null;
    else if (this.behindSince === null) this.behindSince = nowMs;
    this.limited = behind && nowMs - this.behindSince > LIMITED_AFTER_MS;
    if (realDt > 0) {
      // a decaying sum of simulated seconds over a decaying sum of real seconds: the rate over roughly the last second, weighted by time
      this._adv = this._adv * RATE_DECAY + advanced;
      this._real = this._real * RATE_DECAY + realDt;
      this.effective = this._adv / this._real;
    }
    const alpha = 1 + lag / dt;
    return alpha > 0 ? (alpha < 1 ? alpha : 1) : 0;
  }
}

// ---- the core: one or two runs of the real engine, paced together ------------------------------------------------------------

/**
 * One demo plant: `panes[0]` is the plant as the app's example has it (plus the scenario), `panes[1]` (only when `compare`) the same plant
 * with the demo's one edit. Both run on the same seed, advance in lock-step chunks and are read at the same simulated time.
 */
export class DemoCore {
  /**
   * @param {{ Simulation: Function, examples: Array<{id: string, build: () => object}>, now?: () => number }} deps
   */
  constructor({ Simulation, examples, now = () => performance.now() }) {
    this.Simulation = Simulation;
    this.examples = examples;
    this.now = now;
    this.pacer = new Pacer();
    this.demo = null;
    this.compare = false;
    this.panes = [];
    this.speed = DEMOS[0].speed;
    this.playing = false;
    this.primed = false;
    this.error = null;
    this.shift = null;
    this._reports = [];
    this._reportAt = -Infinity;
    this._reportTime = NaN;
  }

  /** Build the runs of `demo` from scratch (a cold start, nothing run yet). Throws if the engine or the example cannot be built. */
  load(demo, { compare = false } = {}) {
    const example = this.examples.find((e) => e.id === demo.exampleId);
    if (!example) throw new Error(`demo "${demo.id}": the example "${demo.exampleId}" does not exist`);
    const panes = [];
    for (const changed of compare ? [false, true] : [false]) {
      const layout = layoutFor(demo, example.build, changed);
      const sim = new this.Simulation(layout);
      panes.push({ changed, layout, sim, target: primeSeconds(sim.settings.warmup) });
    }
    this.demo = demo;
    this.compare = compare;
    this.panes = panes;
    this.speed = demo.speed;
    this.playing = false;
    this.primed = false;
    this.error = null;
    this.shift = null;
    this.pacer.reset(0);
    this._reports = [];
    this._reportAt = -Infinity;
    this._reportTime = NaN;
    return this;
  }

  /** The simulated time of the runs (the slower one, should they differ by a chunk). */
  get time() {
    return this.panes.length ? Math.min(...this.panes.map((p) => p.sim.time)) : 0;
  }

  get dt() {
    return this.panes.length ? this.panes[0].sim.dt : 0.1;
  }

  /**
   * Roll the runs forward to the end of the silent start (the warm-up and two minutes) within `maxMillis`.
   * @returns {boolean} true when every run is there
   */
  prime(maxMillis) {
    const began = this.now();
    for (const pane of this.panes) {
      const left = pane.target - pane.sim.time;
      if (left <= pane.sim.dt * 1e-6) continue;
      const spent = this.now() - began;
      if (spent >= maxMillis && pane !== this.panes[0]) break;
      pane.sim.advance(left, { maxMillis: Math.max(1, maxMillis - spent), now: this.now });
    }
    this.primed = this.panes.every((p) => p.target - p.sim.time <= p.sim.dt * 1e-6);
    if (this.primed) this.pacer.reset(this.time);
    return this.primed;
  }

  play() {
    if (!this.primed) return false;
    if (!this.playing) {
      this.playing = true;
      this.pacer.reset(this.time);
    }
    return true;
  }

  pause() {
    this.playing = false;
    this.pacer.limited = false;
  }

  setSpeed(speed) {
    if (SPEEDS.includes(speed)) {
      this.speed = speed;
      this.pacer.limited = false;
      this.pacer.behindSince = null;
    }
    return this.speed;
  }

  /**
   * One frame of the live view: advance the runs towards the display clock within the wall-clock budget.
   * @param {number} realDt real seconds since the previous frame
   * @param {number} drawMs what drawing took in the previous frame
   * @returns {{ alpha: number, advanced: number, limited: boolean }}
   */
  frame(realDt, drawMs = 0) {
    if (!this.playing || !this.primed) return { alpha: 1, advanced: 0, limited: false };
    const dt = this.dt;
    const want = this.pacer.want(realDt, this.time, dt, this.speed);
    const began = this.now();
    const budget = simBudget(drawMs);
    const before = this.time;
    // chunks of LOCKSTEP_SECONDS, alternating between the runs: two runs are never more than a chunk apart
    let left = want;
    while (left > dt * 1e-6) {
      const chunk = Math.min(LOCKSTEP_SECONDS, left);
      const behind = this.panes.reduce((a, p) => (p.sim.time < a.sim.time ? p : a), this.panes[0]);
      const stop = behind.sim.time + chunk;
      for (const pane of this.panes) {
        const need = stop - pane.sim.time;
        if (need > dt * 1e-6) pane.sim.advance(need);
      }
      left = this.pacer.target - this.time;
      if (this.now() - began >= budget) break;
    }
    const advanced = this.time - before;
    const alpha = this.pacer.settle(this.time, dt, realDt, advanced, this.now());
    return { alpha, advanced, limited: this.pacer.limited };
  }

  /**
   * Start a whole shift: the runs (fresh, nothing rolled forward) are advanced as fast as the machine allows, `seconds` of simulated time in all,
   * a slice per frame. `shiftFrame()` does the work and adds up the time spent computing, so the page can say how long this machine took.
   */
  beginShift(seconds) {
    this.pause();
    this.primed = true;
    this.pacer.reset(this.time);
    this.shift = { target: seconds, from: this.time, computeMs: 0, done: false };
    return this.shift;
  }

  cancelShift() {
    this.shift = null;
  }

  /**
   * One slice of the shift within `maxMillis` of wall-clock time.
   * @returns {{ done: boolean, progress: number, computeMs: number }}
   */
  shiftFrame(maxMillis) {
    const shift = this.shift;
    if (!shift) return { done: false, progress: 0, computeMs: 0 };
    const dt = this.dt;
    const began = this.now();
    while (shift.target - this.time > dt * 1e-6) {
      const behind = this.panes.reduce((a, p) => (p.sim.time < a.sim.time ? p : a), this.panes[0]);
      const stop = Math.min(shift.target, behind.sim.time + LOCKSTEP_SECONDS * 20);
      for (const pane of this.panes) {
        const need = stop - pane.sim.time;
        if (need > dt * 1e-6) pane.sim.advance(need);
      }
      if (this.now() - began >= maxMillis) break;
    }
    shift.computeMs += this.now() - began;
    shift.done = shift.target - this.time <= dt * 1e-6;
    const span = shift.target - shift.from;
    return { done: shift.done, progress: shift.done || !(span > 0) ? 1 : Math.min(1, (this.time - shift.from) / span), computeMs: shift.computeMs };
  }

  /**
   * The reports of the runs, at most every 250 ms real time unless the clock moved and `force`.
   * @returns {object[]} KpiReports, one per pane
   */
  reports(force = false) {
    const t = this.now();
    if (!force && this._reports.length === this.panes.length && (t - this._reportAt < 250 || this._reportTime === this.time)) return this._reports;
    this._reports = this.panes.map((p) => p.sim.kpis());
    this._reportAt = t;
    this._reportTime = this.time;
    return this._reports;
  }

  /** The figures of every pane at the current time. */
  figures(force = false) {
    const reports = this.reports(force);
    return this.panes.map((pane, i) => readFigures(this.demo, reports[i], pane.sim.time));
  }
}
