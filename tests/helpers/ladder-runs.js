// Test helper of the ladder examples (docs/EXAMPLES-DESIGN.md 8.3, 8.4; the six files tests/sim.examples.<id>.test.js): runs an example and edited
// copies of it for several seeds on a small pool of worker threads (this file is also the worker script) and returns plain numbers.
//
//   runVariants(variants, { seeds, hours, snapshots })   variants = { name: { example, edit?, hours?, snapshots?, hourly? } } -> { name: [one record per seed] }
//   checkClaims(claims, results)                          -> the claims that do not hold (an empty list when every figure of every tip is reproduced)
//
// A variant is plain data (it travels to a worker): `example` is the id of a ladder example, `edit` the name of one of the edits in
// tests/helpers/ladder/<id>.js (plain layout.js mutator calls, exactly what the tip says to do; no `edit` is the example as shipped), `hours` the length
// of the run (default: the argument of runVariants, 8 hours, the default run length of the app), `snapshots` more hours at which the cumulative figures
// are recorded on the way, `hourly` a number of hours for which the mean lead time of the pallets that left in each hour is recorded.
// A record: { seed, at: { [hour]: metrics }, hourly?: { lead: [...], wip: [...] } }. metrics = what `metricsOf` returns (the figures of the Results tab
// as flat numbers, see there) plus `ins` (the findings that are not "good": [{ id, severity, title }]).

import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { EXAMPLES } from '../../js/model/examples.js';
import { Simulation } from '../../js/sim/engine.js';

/** The ids of the six ladder examples: a worker loads the edits of `./ladder/<id>.js` for these and no other name. */
export const LADDER_IDS = Object.freeze(['hello-pallet', 'charging-corner', 'yard-shuttle', 'morning-peak', 'components-plant', 'twin-plants']);

/** Short key of a fleet or station name: letters and digits only, at most 12 characters ("Tugger trains" -> "Tuggertrains"). */
const shortName = (n) => { const c = n.replace(/[^A-Za-z0-9]/g, ''); return c.length > 12 ? c.slice(0, 4) + c.slice(-7) : c; };

/**
 * The figures of a report as flat numbers. thr = pallets an hour; leadMean / leadP95 minutes; wipNow loads in the plant; wait = share of driving time
 * spent waiting in traffic (percent); `<fleet>_util|chg|park|wt` percent of the time busy / charging / parked / waiting, `<fleet>_pw` seconds a load waits
 * for a pickup, `<fleet>_trips` loaded trips per vehicle and hour; `<station>_u|st|bl` process busy / starved / blocked percent, `_fill|_fmax` storage average
 * and highest fill, `_yardMax` loads waiting at a source; `<gate>_gate|gmax|door|dutil|gq|short` for stations with trucks (minutes, minutes, minutes,
 * percent, trucks at the gate at once, trucks that left short); `dead` vehicles with a flat battery; `dl` deadlocks.
 */
export function metricsOf(sim, report) {
  const m = {};
  m.thr = report.throughput.perHour;
  m.leadMean = report.leadTime.mean === null ? NaN : report.leadTime.mean / 60;
  m.leadP95 = report.leadTime.p95 === null ? NaN : report.leadTime.p95 / 60;
  m.wipNow = report.wip.now;
  m.wait = report.traffic.waitShare * 100;
  m.dl = report.traffic.deadlocks;
  for (const f of Object.values(report.fleets)) {
    const k = shortName(f.name);
    m[`${k}_util`] = f.utilization * 100;
    m[`${k}_chg`] = f.shares.charging * 100;
    m[`${k}_park`] = f.shares.parked * 100;
    m[`${k}_wt`] = f.shares.waiting * 100;
    m[`${k}_pw`] = f.avgPickupWait;
    m[`${k}_trips`] = f.tripsPerVehicleHour;
  }
  for (const st of Object.values(report.stations)) {
    const k = shortName(st.name);
    if (st.type === 'process') { m[`${k}_u`] = st.utilization * 100; m[`${k}_st`] = st.starved * 100; m[`${k}_bl`] = st.blocked * 100; }
    if (st.type === 'storage') { m[`${k}_fill`] = st.avgFill * 100; m[`${k}_fmax`] = st.maxFill * 100; }
    if (st.type === 'source') m[`${k}_yardMax`] = st.yardMax;
  }
  if (report.ops && report.ops.trucks) {
    for (const k of Object.values(report.ops.trucks)) {
      const n = shortName(k.name);
      m[`${n}_gate`] = (k.gateWait.mean ?? 0) / 60;
      m[`${n}_gmax`] = (k.gateWait.max ?? 0) / 60;
      m[`${n}_door`] = (k.doorTime.mean ?? 0) / 60;
      m[`${n}_dutil`] = k.doorUtilization * 100;
      m[`${n}_gq`] = k.gateQueue.max;
      m[`${n}_short`] = k.trucks.short;
    }
  }
  m.dead = sim.vehicles.filter((v) => v.state === 'dead').length;
  return m;
}

/** The layout of a variant: a fresh build of the example, edited through the layout.js mutators by the named edit of tests/helpers/ladder/<id>.js. */
export async function layoutOf(variant) {
  if (!LADDER_IDS.includes(variant.example)) throw new Error(`ladder-runs: unknown example "${variant.example}"`);
  const layout = EXAMPLES.find((e) => e.id === variant.example).build();
  if (variant.edit) {
    const { edits } = await import(`./ladder/${variant.example}.js`);
    if (typeof edits[variant.edit] !== 'function') throw new Error(`ladder-runs: ${variant.example} has no edit "${variant.edit}"`);
    edits[variant.edit](layout);
  }
  return layout;
}

/** Run one variant for one seed. */
export async function runOne(variant, seed, defaultHours) {
  const hours = variant.hours ?? defaultHours;
  const stops = [...new Set([...(variant.snapshots ?? []), hours])].sort((a, b) => a - b);
  const sim = new Simulation(await layoutOf(variant), { seed });
  const hourly = variant.hourly ? { lead: Array.from({ length: variant.hourly }, () => []), wip: [] } : null;
  if (hourly) {
    sim.on('loadCompleted', (p) => { const b = Math.floor(p.t / 3600); if (b < variant.hourly) hourly.lead[b].push(p.leadTime / 60); });
  }
  const at = {};
  let hourlyDone = 0;
  for (const h of stops) {
    if (hourly) {
      // step through whole hours so the loads in the plant are read at the end of each one
      for (; hourlyDone + 1 <= Math.min(h, variant.hourly); hourlyDone++) {
        sim.advance((hourlyDone + 1) * 3600 - sim.time);
        hourly.wip.push(sim.kpis().wip.now);
      }
    }
    sim.advance(h * 3600 - sim.time);
    const report = sim.kpis();
    at[h] = metricsOf(sim, report);
    at[h].ins = sim.insights(report).filter((i) => i.severity !== 'good').map((i) => ({ id: i.id, severity: i.severity, title: i.title }));
  }
  return { seed, at, ...(hourly ? { hourly: { lead: hourly.lead.map(mean), wip: hourly.wip } } : {}) };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

if (!isMainThread && workerData && workerData.ladderRunsWorker === true) {
  parentPort.on('message', async (msg) => {
    try {
      parentPort.postMessage({ id: msg.id, result: await runOne(msg.variant, msg.seed, msg.hours) });
    } catch (error) {
      parentPort.postMessage({ id: msg.id, error: String((error && error.stack) || error) });
    }
  });
}

/**
 * Run every variant for every seed; results come back per variant, in the order of `seeds`. At most min(4, cores) workers, all terminated when the
 * runs are over or one of them fails (no leaked worker: acceptance E36).
 * @param {Record<string, object>} variants
 * @param {{seeds?: number[], hours?: number}} [options] the default run length of the app is 8 simulated hours
 * @returns {Promise<Record<string, object[]>>}
 */
export async function runVariants(variants, { seeds = [1, 2, 3, 4, 5], hours = 8 } = {}) {
  const names = Object.keys(variants);
  const jobs = names.flatMap((name) => seeds.map((seed) => ({ name, seed })));
  // the longest runs first, so the pool does not end with one long run on one worker
  const order = jobs.map((_, i) => i).sort((a, b) => (variants[jobs[b].name].hours ?? hours) - (variants[jobs[a].name].hours ?? hours));
  const results = new Array(jobs.length);
  let next = 0;
  const size = Math.max(1, Math.min(4, availableParallelism(), jobs.length));
  const pool = Array.from({ length: size }, () => new Worker(new URL(import.meta.url), { workerData: { ladderRunsWorker: true } }));
  try {
    await Promise.all(pool.map((worker) => new Promise((resolve, reject) => {
      worker.on('error', reject);
      const feed = () => {
        if (next >= order.length) { resolve(); return; }
        const id = order[next++];
        worker.once('message', (msg) => {
          if (msg.error) reject(new Error(msg.error));
          else { results[msg.id] = msg.result; feed(); }
        });
        worker.postMessage({ id, variant: variants[jobs[id].name], seed: jobs[id].seed, hours });
      };
      feed();
    })));
  } finally {
    await Promise.all(pool.map((worker) => worker.terminate()));
  }
  const out = {};
  names.forEach((name) => { out[name] = []; });
  jobs.forEach((job, i) => out[job.name].push(results[i]));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The claims of a tip (docs/EXAMPLES-DESIGN.md 8.4): every figure a tip prints, with the variant and the metric it was measured on.
// ---------------------------------------------------------------------------------------------------------------------------

/** Mean of a metric over the seeds of a run set at an hour (records without the number are left out). */
export function meanMetric(records, metric, hour = 8) {
  const v = records.map((r) => r.at[hour][metric]).filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (v.length === 0) throw new Error(`no figure "${metric}" at hour ${hour}`);
  return v.reduce((s, x) => s + x, 0) / v.length;
}

/** Smallest and largest value over the seeds. */
export function rangeMetric(records, metric, hour = 8) {
  const v = records.map((r) => r.at[hour][metric]).filter((x) => typeof x === 'number' && !Number.isNaN(x));
  return [Math.min(...v), Math.max(...v)];
}

// Constructors of claims (plain data). `text` is the figure exactly as the tip prints it, `d` the digits after the decimal point it has (-1: rounded to tens).
//   a: the mean of one metric; m: the mean of a metric in seconds, printed in minutes; r: the relative change of a against b in percent;
//   b: a band ("4 to 5": the smallest and the largest value over the seeds lie within 10 % of the printed ends).
export const a = (tip, run, metric, d, text, label, hour = 8) => ({ tip, kind: 'a', run, metric, d, text, label, hour });
export const m = (tip, run, metric, d, text, label, hour = 8) => ({ tip, kind: 'm', run, metric, d, text, label, hour });
export const r = (tip, [runA, metricA], [runB, metricB], text, label) => ({ tip, kind: 'r', a: [runA, metricA], b: [runB, metricB], text, label });
export const b = (tip, run, metric, text, lo, hi, label) => ({ tip, kind: 'b', run, metric, text, lo, hi, label });

/** Metrics that are a share of time in percent: the tolerance of a figure is then at least 2 points (8.4). */
const isShare = (metric) => /(_util|_chg|_park|_wt|_u|_st|_bl)$|^wait$/.test(metric);

/** The tolerance of a printed figure: half a unit of its last digit, 4 % of it, 2 points for a share of time. */
export function tolerance(claim) {
  const printed = Math.abs(Number(claim.text));
  const unit = claim.d >= 0 ? 10 ** -claim.d : 10 ** -claim.d;
  return Math.max(unit / 2, 0.04 * printed, isShare(claim.metric) ? 2 : 0);
}

/**
 * The claims that do not hold against the measured runs: a list of strings, empty when every figure of the tips is reproduced. `results` is what
 * runVariants returned (one entry per run name that a claim uses); `tips` are the tips of the example, each claim must occur in its tip.
 */
export function checkClaims(claims, results, tips) {
  const bad = [];
  for (const c of claims) {
    const where = `tip ${c.tip} [${c.kind} ${c.run ?? `${c.a.join(' ')} against ${c.b.join(' ')}`} ${c.metric ?? ''}] "${c.text}" (${c.label})`;
    const tip = tips[c.tip - 1] ?? '';
    if (!tip.includes(c.text)) { bad.push(`${where}: the text is not in the tip`); continue; }
    const need = (run) => { if (!results[run]) throw new Error(`claim ${where} needs the run "${run}"`); return results[run]; };
    if (c.kind === 'a' || c.kind === 'm') {
      const got = meanMetric(need(c.run), c.metric, c.hour) / (c.kind === 'm' ? 60 : 1);
      const diff = Math.abs(got - Number(c.text));
      if (!(diff <= tolerance(c))) bad.push(`${where}: measured ${got.toFixed(2)} (off by ${diff.toFixed(2)}, tolerance ${tolerance(c).toFixed(2)})`);
    } else if (c.kind === 'r') {
      const x = meanMetric(need(c.a[0]), c.a[1]);
      const y = meanMetric(need(c.b[0]), c.b[1]);
      const got = ((x - y) / y) * 100;
      if (!(Math.abs(got - Number(c.text)) <= 3)) bad.push(`${where}: measured ${got.toFixed(1)} % (tolerance 3 points)`);
    } else if (c.kind === 'b') {
      const [lo, hi] = rangeMetric(need(c.run), c.metric);
      if (!(Math.abs(lo - c.lo) <= 0.1 * c.lo + 0.5 && Math.abs(hi - c.hi) <= 0.1 * c.hi + 0.5)) bad.push(`${where}: measured ${lo.toFixed(1)} to ${hi.toFixed(1)}`);
    } else throw new Error(`unknown claim kind ${c.kind}`);
  }
  return bad;
}

/** Number of seeds of a run set in which `pick(record at hour)` is true. */
export const seedsWith = (records, pick, hour = 8) => records.filter((rec) => pick(rec.at[hour])).length;

/**
 * True when the findings of a record contain one of rule `rule` (its id is `rule` or `rule:ref`), optionally of a given severity and with a given text
 * in its title ("Paint shop is the bottleneck").
 */
export const hasFinding = (metrics, rule, { severity = null, text = null } = {}) => metrics.ins.some((i) => (i.id === rule || i.id.startsWith(`${rule}:`))
  && (severity === null || i.severity === severity) && (text === null || i.title.includes(text)));

/** The findings of a record that are not "info" (what a reader sees as a warning). */
export const warnings = (metrics) => metrics.ins.filter((i) => i.severity !== 'info');
