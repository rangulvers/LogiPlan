// Test helper of tests/sim.examples.warehouse.test.js: runs the two warehouse examples (Dock lab, Warehouse: first day) and edited copies of them
// for several seeds on a small pool of worker threads (this file is also the worker script) and returns plain numbers.
//
//   runVariants(variants, { seeds, hours })   variants = { name: { example, variant?, fleet?, doors?, ... } } -> { name: [one record per seed] }
//
// A variant is plain data (it travels to a worker): `example` 'dock-lab' | 'warehouse-first-day', `variant` 'bays' | 'row' (Dock lab), and the
// edits the tips describe, applied through the layout.js mutators: `forklifts` (count of the one fleet), `doorsIn` (doors of Goods in).
// A record: { seed, shares (visits of the docks of Goods in, as fractions, in dock order), gate / door (mean minutes at the gate / at a door of Goods in),
// doorUtilization, gateQueueMax, fleetUtilization, waitShare (traffic), throughput (pallets an hour), short (Goods out trucks that left short),
// outDoor, insights (ids), unbalanced (the detail of the docks-unbalanced insight of Goods in or '') }.

import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildDockLab, buildWarehouseFirstDay } from '../../js/model/examples.js';
import { updateFleet, updateStation } from '../../js/model/layout.js';
import { Simulation } from '../../js/sim/engine.js';

/** The layout of a variant (a fresh copy, edited through the model API). */
export function layoutOf(variant) {
  const layout = variant.example === 'dock-lab' ? buildDockLab(variant.variant || 'bays') : buildWarehouseFirstDay();
  if (variant.forklifts !== undefined) updateFleet(layout, layout.fleets[0].id, { count: variant.forklifts });
  if (variant.doorsIn !== undefined) {
    const goodsIn = layout.stations.find((s) => s.type === 'source');
    updateStation(layout, goodsIn.id, { ops: { trucks: { doors: variant.doorsIn } } });
  }
  return layout;
}

/** Run one variant for one seed. */
export function runOne(variant, seed, hours) {
  const sim = new Simulation(layoutOf(variant), { seed });
  sim.advance(hours * 3600);
  const report = sim.kpis();
  const goodsIn = sim.stations.find((s) => s.type === 'source');
  const visits = sim.logistics.docks.counters(goodsIn.id).map((d) => d.visits);
  const total = visits.reduce((a, b) => a + b, 0);
  const trucks = Object.values(report.ops.trucks);
  const inbound = trucks.find((t) => t.role === 'in');
  const outbound = trucks.find((t) => t.role === 'out');
  const insights = sim.insights(report);
  const unbalanced = insights.find((i) => i.id === `docks-unbalanced:${goodsIn.id}`);
  return {
    seed,
    shares: visits.map((v) => (total > 0 ? v / total : 0)),
    gate: (inbound.gateWait.mean ?? 0) / 60,
    door: (inbound.doorTime.mean ?? 0) / 60,
    doorUtilization: inbound.doorUtilization,
    gateQueueMax: inbound.gateQueue.max,
    fleetUtilization: Object.values(report.fleets)[0].utilization,
    waitShare: report.traffic.waitShare,
    throughput: report.throughput.perHour,
    short: outbound.trucks.short,
    insights: insights.filter((i) => i.severity !== 'good').map((i) => i.id),
    unbalanced: unbalanced ? unbalanced.detail : '',
    skewReason: report.stations[goodsIn.id].dockSkew ? report.stations[goodsIn.id].dockSkew.reason : null,
  };
}

if (!isMainThread && workerData && workerData.warehouseRunsWorker === true) {
  parentPort.on('message', (msg) => {
    try {
      parentPort.postMessage({ id: msg.id, result: runOne(msg.variant, msg.seed, msg.hours) });
    } catch (error) {
      parentPort.postMessage({ id: msg.id, error: String((error && error.stack) || error) });
    }
  });
}

/**
 * Run every variant for every seed; results come back per variant, in the order of `seeds`.
 * @param {Record<string, object>} variants
 * @param {{seeds?: number[], hours?: number}} [options] the default run length of the app is 8 simulated hours
 * @returns {Promise<Record<string, object[]>>}
 */
export async function runVariants(variants, { seeds = [1, 2, 3, 4, 5], hours = 8 } = {}) {
  const names = Object.keys(variants);
  const jobs = names.flatMap((name) => seeds.map((seed) => ({ name, seed })));
  const results = new Array(jobs.length);
  let next = 0;
  const size = Math.max(1, Math.min(4, availableParallelism(), jobs.length));
  const pool = Array.from({ length: size }, () => new Worker(new URL(import.meta.url), { workerData: { warehouseRunsWorker: true } }));
  try {
    await Promise.all(pool.map((worker) => new Promise((resolve, reject) => {
      worker.on('error', reject);
      const feed = () => {
        if (next >= jobs.length) { resolve(); return; }
        const id = next++;
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

/** Mean of a numeric field over the records of a variant. */
export const meanOf = (records, pick) => records.reduce((sum, r) => sum + (typeof pick === 'function' ? pick(r) : r[pick]), 0) / records.length;
