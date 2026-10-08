// Headless experiments (docs/ARCHITECTURE.md 5.6): run a layout flat out without a UI, repeat it with different
// seeds, compare variants and sweep one parameter. Everything is asynchronous and cooperative: a run is cut into
// slices of about `yieldEveryMs` of real work, the event loop gets a turn between the slices (so a browser tab stays
// responsive), progress is reported after every slice and an AbortSignal stops the run at the next slice boundary.
//
// How the open points of the spec were resolved:
//  * Replication r of a layout uses the seed (seed0 ?? settings.seed) + r, wrapped to 32 bits. Sweeps and
//    comparisons give every value / scenario the same seeds (common random numbers) unless the scenarios carry
//    different settings.seed values and no seed0 is passed.
//  * The warm-up is `warmup` if given, otherwise settings.warmup, but at most half of the duration, so a short run
//    still measures something. An explicit `warmup` is honoured as given. A run ends at the first tick boundary at
//    or after `duration`.
//  * METRICS are flat numbers in display units (shares are percentages 0..100), so a table can render any metric
//    as `${value.toFixed(digits)} ${unit}`. A metric that cannot be computed (no vehicles, no data) is null.
//  * summary[metricId] = { mean, sd, min, max, n } over the replications that produced a value; sd is the sample
//    standard deviation (n - 1), 0 for a single value; mean / sd / min / max are null (and n is 0) when no run
//    produced a value.
//  * Invalid options (duration, warmup, replications) reject the promise with a RangeError; a layout that is
//    not an object rejects with a TypeError.
//  * Sweep parameters read and change the layout through the model API, so values outside min..max are accepted
//    but clamped by the model to what it allows (e.g. at most 500 vehicles per fleet).

import { cloneLayout, getFleet, getStation, normalizeLayout, updateFleet, updateSettings, updateStation } from '../model/layout.js';
import { Simulation } from './engine.js';

// ---- metrics ----------------------------------------------------------------------------------------------------

/** Finite number or null. */
const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const percent = (fraction) => (finite(fraction) === null ? null : fraction * 100);

/** Weighted mean of (value, weight) pairs with a finite value and a positive weight; null without any. */
function weightedMean(pairs) {
  let sum = 0;
  let weight = 0;
  for (const [value, w] of pairs) {
    if (finite(value) !== null && w > 0) {
      sum += value * w;
      weight += w;
    }
  }
  return weight > 0 ? sum / weight : null;
}

const fleetsOf = (report) => Object.values((report && report.fleets) || {});
const stationsOf = (report, type) => Object.values((report && report.stations) || {}).filter((s) => s.type === type);

/**
 * Flat, comparable numbers of a KpiReport. `better` says which direction is an improvement (null: neither, the
 * number is context), `digits` how many decimals to show, `get(report)` the value in the unit shown (null if unknown).
 * @type {Array<{ id: string, label: string, unit: string, better: 'higher'|'lower'|null, digits: number, get: (report: object) => number|null }>}
 */
export const METRICS = [
  {
    id: 'throughput', label: 'Throughput', unit: 'loads/h', better: 'higher', digits: 1,
    get: (r) => finite(r.throughput && r.throughput.perHour),
  },
  {
    id: 'leadMean', label: 'Mean lead time', unit: 's', better: 'lower', digits: 0,
    get: (r) => finite(r.leadTime && r.leadTime.mean),
  },
  {
    id: 'leadP95', label: 'Lead time, 95th percentile', unit: 's', better: 'lower', digits: 0,
    get: (r) => finite(r.leadTime && r.leadTime.p95),
  },
  {
    id: 'wip', label: 'Work in process (mean)', unit: 'loads', better: 'lower', digits: 1,
    get: (r) => finite(r.wip && r.wip.mean),
  },
  {
    id: 'fleetUtilization', label: 'Fleet utilization (mean)', unit: '%', better: null, digits: 0,
    get: (r) => percent(weightedMean(fleetsOf(r).map((f) => [f.utilization, f.count]))),
  },
  {
    id: 'waitShare', label: 'Vehicle wait share', unit: '%', better: 'lower', digits: 1,
    get: (r) => percent(r.traffic && r.traffic.waitShare),
  },
  {
    id: 'emptyShare', label: 'Empty driving share', unit: '%', better: 'lower', digits: 0,
    get: (r) => percent(weightedMean(fleetsOf(r).map((f) => [f.emptyShare, f.distance]))),
  },
  {
    id: 'deadlocks', label: 'Deadlocks', unit: '', better: 'lower', digits: 0,
    get: (r) => finite(r.traffic && r.traffic.deadlocks),
  },
  {
    id: 'maxBacklog', label: 'Max. backlog at goods in', unit: 'loads', better: 'lower', digits: 0,
    get: (r) => {
      const yards = stationsOf(r, 'source').map((s) => finite(s.yardMax)).filter((v) => v !== null);
      return yards.length > 0 ? Math.max(...yards) : null;
    },
  },
  {
    id: 'bottleneck', label: 'Busiest workstation', unit: '%', better: null, digits: 0,
    get: (r) => {
      const busy = stationsOf(r, 'process').map((s) => finite(s.utilization)).filter((v) => v !== null);
      return busy.length > 0 ? 100 * Math.max(...busy) : null;
    },
  },
  {
    id: 'pickupWait', label: 'Load waits for a vehicle', unit: 's', better: 'lower', digits: 0,
    get: (r) => finite(r.orders && r.orders.avgPickupWait),
  },
  {
    id: 'minBattery', label: 'Lowest battery level', unit: '%', better: 'higher', digits: 0,
    get: (r) => {
      const levels = fleetsOf(r).map((f) => finite(f.minBattery)).filter((v) => v !== null);
      return levels.length > 0 ? 100 * Math.min(...levels) : null;
    },
  },
];

/**
 * All METRICS of one report.
 * @param {object} report a KpiReport
 * @returns {Object<string, number|null>} metric id -> value (null when unknown)
 */
export function summarizeReport(report) {
  const out = {};
  for (const m of METRICS) out[m.id] = report ? finite(m.get(report)) : null;
  return out;
}

/** mean / sd / min / max / n of the non-null values. */
function describe(values) {
  const v = values.filter((x) => x !== null);
  if (v.length === 0) return { mean: null, sd: null, min: null, max: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0;
  return { mean, sd: Math.sqrt(variance), min: Math.min(...v), max: Math.max(...v), n: v.length };
}

/** Per-metric statistics over several reports. */
function summarizeRuns(runs) {
  const per = runs.map(summarizeReport);
  const summary = {};
  for (const m of METRICS) summary[m.id] = describe(per.map((p) => p[m.id]));
  return summary;
}

// ---- running ----------------------------------------------------------------------------------------------------

const yieldToEventLoop = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function abortError() {
  const error = new Error('The simulation run was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** Progress callback for item `index` of `total` of a longer job: the item's fraction is scaled into the whole. */
function nested(onProgress, index, total, label) {
  if (typeof onProgress !== 'function') return undefined;
  return (p) => onProgress({ fraction: (index + p.fraction) / total, simTime: p.simTime, label });
}

function positiveOrThrow(name, value) {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new RangeError(`${name} must be a positive number of seconds`);
  return value;
}

/** 32-bit seed `base + offset` (wrapping). */
const seedPlus = (base, offset) => (base + offset) >>> 0;

/**
 * Simulate a layout from the start and return the KPI report of the measured window.
 * @param {object} layout any layout (copied, never modified)
 * @param {{ duration?: number, warmup?: number, seed?: number, onProgress?: (p: { fraction: number, simTime: number, label: string }) => void,
 *   signal?: AbortSignal, yieldEveryMs?: number, label?: string }} [opts]
 *   `duration` and `warmup` in simulated seconds (default settings.duration / settings.warmup, see the file header);
 *   `seed` overrides settings.seed; `yieldEveryMs` real milliseconds of work between two yields to the event loop (30);
 *   `label` is passed through to onProgress.
 * @returns {Promise<object>} KpiReport; rejects with an Error named 'AbortError' when `signal` aborts
 */
export async function runSimulation(layout, opts = {}) {
  const { seed, onProgress, signal, yieldEveryMs = 30, label = '' } = opts;
  throwIfAborted(signal);
  const plant = normalizeLayout(layout);
  const duration = opts.duration === undefined ? plant.settings.duration : positiveOrThrow('duration', opts.duration);
  if (opts.warmup !== undefined) {
    if (!(typeof opts.warmup === 'number' && opts.warmup >= 0 && Number.isFinite(opts.warmup))) throw new RangeError('warmup must be a non-negative number of seconds');
    plant.settings.warmup = opts.warmup;
  } else {
    plant.settings.warmup = Math.min(plant.settings.warmup, duration / 2);
  }
  const sim = new Simulation(plant, { seed });
  const progress = typeof onProgress === 'function' ? () => onProgress({ fraction: Math.min(1, sim.time / duration), simTime: sim.time, label }) : () => {};
  const slice = Number.isFinite(yieldEveryMs) ? Math.max(0, yieldEveryMs) : Infinity;
  progress();
  while (sim.time < duration - sim.dt * 1e-6) {
    sim.advance(duration - sim.time, { maxMillis: slice });
    progress();
    if (sim.time < duration - sim.dt * 1e-6) {
      await yieldToEventLoop();
      throwIfAborted(signal);
    }
  }
  return sim.kpis();
}

/**
 * Repeat a run with consecutive seeds and summarise the metrics.
 * @param {object} layout
 * @param {{ replications?: number, seed0?: number } & Parameters<typeof runSimulation>[1]} [opts] `replications` (default 3);
 *   replication r uses seed (seed0 ?? settings.seed) + r; the other options are those of runSimulation
 * @returns {Promise<{ runs: object[], seeds: number[], summary: Object<string, { mean: number|null, sd: number|null, min: number|null, max: number|null, n: number }> }>}
 */
export async function runReplications(layout, opts = {}) {
  const { replications = 3, seed0, onProgress, label, ...runOpts } = opts;
  if (!Number.isInteger(replications) || replications < 1) throw new RangeError('replications must be a whole number of at least 1');
  throwIfAborted(opts.signal);
  const plant = normalizeLayout(layout);
  const first = typeof seed0 === 'number' && Number.isFinite(seed0) ? Math.trunc(seed0) : plant.settings.seed;
  const runs = [];
  const seeds = [];
  for (let r = 0; r < replications; r++) {
    const seed = seedPlus(first, r);
    seeds.push(seed);
    const name = replications > 1 ? `${label ? `${label}: ` : ''}run ${r + 1} of ${replications}` : label || '';
    runs.push(await runSimulation(plant, { ...runOpts, seed, label: name, onProgress: nested(onProgress, r, replications, name) }));
  }
  return { runs, seeds, summary: summarizeRuns(runs) };
}

// ---- sweep parameters -------------------------------------------------------------------------------------------

const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** A round step that gives about ten steps over `span`. */
function niceStep(span) {
  const wanted = span / 10;
  return STEPS.find((s) => s >= wanted) ?? STEPS[STEPS.length - 1];
}

/** Rounded to 4 decimals: drops floating-point noise such as 0.30000000000000004. */
const r4 = (x) => Math.round(x * 1e4) / 1e4;
/** Rounded to 3 significant digits: clean suggested values (1.125 -> 1.13). */
const sig3 = (x) => Number(x.toPrecision(3));
/** Ascending, de-duplicated values. */
const tidy = (values) => [...new Set(values.map(r4))].sort((a, b) => a - b);
/** The current value plus the suggestions that lie inside the range. */
const suggest = (current, candidates, min, max) => tidy([current, ...candidates.filter((v) => v >= min && v <= max)]);

/** Whole numbers from `from` to `to`, ascending. */
function integers(from, to) {
  const out = [];
  for (let v = from; v <= to; v++) out.push(v);
  return out;
}

/** Sweep parameter from a reader and a writer that edits a layout in place through the model API. */
function parameter(key, label, unit, range, read, write) {
  return {
    key, label, unit, ...range,
    get: (layout) => finite(read(layout)),
    apply(layout, value) {
      const next = cloneLayout(layout);
      if (finite(value) !== null) write(next, value);
      return next;
    },
  };
}

/** Range for a count: whole numbers from `low`, suggestions around the current value. */
function countRange(current, { low = 1, below = 2, above = 3, highest = 500 } = {}) {
  const max = Math.min(highest, Math.max(current * 3, current + 8));
  return { min: Math.min(low, current), max, step: 1, values: suggest(current, integers(current - below, current + above), low, max) };
}

/**
 * Range for a positive quantity around its current value: from a quarter to three times, on a round step grid,
 * with the suggestions `current * factor` (rounded) inside it.
 */
function scaledRange(current, factors, { lo, hi, whole = false }) {
  const rawMin = Math.max(lo, current * 0.25);
  const rawMax = Math.min(hi, current * 3);
  const step = whole ? Math.max(1, niceStep(rawMax - rawMin)) : niceStep(rawMax - rawMin);
  const min = Math.min(Math.max(lo, r4(Math.ceil(rawMin / step) * step)), current);
  const max = Math.max(Math.min(hi, r4(Math.floor(rawMax / step) * step)), current);
  const round = whole ? (x) => Math.max(1, Math.round(x)) : sig3;
  return { min, max, step, values: suggest(current, factors.map((f) => round(current * f)), min, max) };
}

/** Range for a what-if factor (an absolute multiplier). */
function factorRange(current) {
  return { min: 0.25, max: 3, step: 0.05, values: suggest(current, [0.5, 0.75, 1, 1.25, 1.5, 2], 0.25, 3) };
}

const SPEED_FACTORS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const STORAGE_FACTORS = [0.25, 0.5, 1, 1.5, 2, 4];

function fleetParameters(fleet) {
  const name = fleet.name || fleet.id;
  const read = (key) => (layout) => getFleet(layout, fleet.id)?.[key];
  const write = (key) => (layout, value) => updateFleet(layout, fleet.id, { [key]: value });
  const capacityMax = Math.min(100, Math.max(6, fleet.capacity * 4));
  return [
    parameter(`fleet.${fleet.id}.count`, `${name}: number of vehicles`, 'vehicles', countRange(fleet.count, { low: fleet.count > 0 ? 1 : 0 }), read('count'), write('count')),
    parameter(`fleet.${fleet.id}.speed`, `${name}: speed`, 'm/s', scaledRange(fleet.speed, SPEED_FACTORS, { lo: 0.1, hi: 15 }), read('speed'), write('speed')),
    parameter(`fleet.${fleet.id}.capacity`, `${name}: capacity per vehicle`, 'loads', {
      min: 1, max: capacityMax, step: 1, values: suggest(fleet.capacity, [1, 2, 3, 4, fleet.capacity * 2], 1, capacityMax),
    }, read('capacity'), write('capacity')),
  ];
}

function stationParameters(station) {
  const name = station.name || station.id;
  const param = (key) => (layout) => getStation(layout, station.id)?.params[key];
  const setParam = (key) => (layout, value) => updateStation(layout, station.id, { params: { [key]: value } });
  if (station.type === 'process') {
    return [parameter(`station.${station.id}.machines`, `${name}: parallel machines`, 'machines',
      countRange(station.params.machines, { below: 1, above: 3, highest: 100 }), param('machines'), setParam('machines'))];
  }
  if (station.type === 'storage') {
    return [parameter(`station.${station.id}.capacity`, `${name}: capacity`, 'loads',
      scaledRange(station.params.capacity, STORAGE_FACTORS, { lo: 1, hi: 100000, whole: true }), param('capacity'), setParam('capacity'))];
  }
  if (station.type === 'source') {
    const mean = station.params.interArrival.mean;
    return [parameter(`station.${station.id}.interArrival`, `${name}: time between arrivals`, 's',
      scaledRange(mean, SPEED_FACTORS, { lo: 1, hi: 1e6, whole: mean >= 10 }),
      (layout) => getStation(layout, station.id)?.params.interArrival.mean,
      (layout, value) => updateStation(layout, station.id, { params: { interArrival: { mean: value } } }))];
  }
  return [];
}

/** Road cells that carry a slow-zone limit. */
const slowCells = (layout) => Object.values(layout.roads || {}).filter((cell) => cell && cell.limit < 1);

/**
 * The parameters of THIS layout that are worth sweeping: one entry per fleet (vehicles, speed, capacity), the global
 * speed / demand / process-time factors, machines per workstation, storage capacities, arrival intervals per source
 * and the slow-zone factor when slow zones exist.
 * @param {object} layout
 * @returns {Array<{ key: string, label: string, unit: string, min: number, max: number, step: number, values: number[],
 *   get: (layout: object) => number|null, apply: (layout: object, value: number) => object }>}
 *   `values` are suggestions inside min..max that include the current value where it is a sensible grid point;
 *   `get` reads the current value from any layout (null if that layout lacks the entity); `apply` returns a modified
 *   deep copy and leaves its input alone
 */
export function listSweepParameters(layout) {
  const plant = normalizeLayout(layout);
  const params = [];
  for (const fleet of plant.fleets) params.push(...fleetParameters(fleet));
  if (plant.fleets.length > 0) {
    params.push(parameter('speedFactor', 'All vehicles: speed factor', '×', factorRange(plant.settings.speedFactor),
      (l) => l.settings?.speedFactor, (l, v) => updateSettings(l, { speedFactor: v })));
  }
  if (plant.stations.some((s) => s.type === 'source')) {
    params.push(parameter('demandFactor', 'Demand factor', '×', factorRange(plant.settings.demandFactor),
      (l) => l.settings?.demandFactor, (l, v) => updateSettings(l, { demandFactor: v })));
  }
  if (plant.stations.some((s) => s.type === 'process')) {
    params.push(parameter('processFactor', 'Process time factor', '×', factorRange(plant.settings.processFactor),
      (l) => l.settings?.processFactor, (l, v) => updateSettings(l, { processFactor: v })));
  }
  for (const station of plant.stations) params.push(...stationParameters(station));
  const zones = slowCells(plant);
  if (zones.length > 0) {
    params.push(parameter('slowZones', 'Slow zones: speed factor', '×', { min: 0.1, max: 1, step: 0.05, values: [0.3, 0.5, 0.7, 0.85, 1] },
      (l) => Math.min(1, ...slowCells(l).map((cell) => cell.limit)),
      (l, v) => {
        for (const [key, cell] of Object.entries(l.roads)) {
          if (!(cell.limit < 1)) continue;
          if (v >= 1) delete l.roads[key].limit;
          else cell.limit = Math.max(0.1, v);
        }
      }));
  }
  return params;
}

// ---- sweeps and comparisons ---------------------------------------------------------------------------------------

/**
 * Run the layout once per value of a parameter (each with `replications` seeds, the same seeds for every value).
 * @param {object} layout
 * @param {object|string} param an entry of listSweepParameters(layout), or its key
 * @param {number[]} values
 * @param {Parameters<typeof runReplications>[1]} [opts] options of runReplications
 * @returns {Promise<Array<{ value: number, summary: object, runs: object[] }>>}
 */
export async function sweep(layout, param, values, opts = {}) {
  const parameterObject = typeof param === 'string' ? listSweepParameters(layout).find((p) => p.key === param) : param;
  if (!parameterObject || typeof parameterObject.apply !== 'function') throw new TypeError(`sweep: unknown parameter ${String(typeof param === 'string' ? param : '')}`.trim());
  if (!Array.isArray(values)) throw new TypeError('sweep: values must be an array of numbers');
  const { onProgress, label, ...rest } = opts;
  const results = [];
  for (let i = 0; i < values.length; i++) {
    const name = `${parameterObject.label} = ${values[i]}${parameterObject.unit ? ` ${parameterObject.unit}` : ''}`;
    const { runs, summary } = await runReplications(parameterObject.apply(layout, values[i]), { ...rest, label: name, onProgress: nested(onProgress, i, values.length, name) });
    results.push({ value: values[i], summary, runs });
  }
  return results;
}

/**
 * Run several scenarios (variants of a plant) the same way and return their summaries side by side.
 * @param {Array<{ id: string, name: string, layout: object }>} scenarios
 * @param {Parameters<typeof runReplications>[1]} [opts] options of runReplications
 * @returns {Promise<Array<{ id: string, name: string, summary: object, runs: object[] }>>}
 */
export async function compareScenarios(scenarios, opts = {}) {
  if (!Array.isArray(scenarios)) throw new TypeError('compareScenarios: scenarios must be an array');
  const { onProgress, label, ...rest } = opts;
  const results = [];
  for (let i = 0; i < scenarios.length; i++) {
    const { id, name, layout } = scenarios[i];
    const { runs, summary } = await runReplications(layout, { ...rest, label: name, onProgress: nested(onProgress, i, scenarios.length, name) });
    results.push({ id, name, summary, runs });
  }
  return results;
}
