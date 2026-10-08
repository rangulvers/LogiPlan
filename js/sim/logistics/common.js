// Shared constants and small numeric helpers of the logistics layer (js/sim/logistics.js and its parts).
// Pure, DOM-free. Everything here exists so that valid-but-odd layout values (NaN, negatives, missing
// params) can never make the simulation throw or loop forever.

import { DIST_KINDS } from '../../model/defaults.js';

/** Tolerance for comparing accumulated floating-point times (s). */
export const EPS = 1e-9;
/** Period of the dispatch poll (s of sim time); dispatch also runs on relevant events. */
export const DISPATCH_INTERVAL = 0.5;
/** Congestion-aware route costs are recomputed at most this often (s of sim time). */
export const CONGESTION_REFRESH = 5;
/** Memory budget of the route cache (bytes): a cached search holds a few typed arrays of graph size. */
export const ROUTE_CACHE_BYTES = 96e6;
/**
 * Work, in units of (edges + nodes) of the road graph, that deferrable route searches may use per tick (about 10 ms of search time
 * on a big plant): a plant of 100 x 80 cells gets 8 new searches per tick, the examples more than they ever need (routing.js).
 */
export const SEARCH_WORK_PER_TICK = 100000;
/** Congestion cost = length / limit * (1 + CONGESTION_WEIGHT * vehicles on the edge). */
export const CONGESTION_WEIGHT = 0.6;
/** Smallest gap between two source arrivals (s); guards against zero-length intervals. */
export const MIN_GAP = 1e-3;
/** Smallest machine cycle (s); guards against zero-length cycles. */
export const MIN_CYCLE = 1e-2;
/** Smallest repair duration (s). */
export const MIN_REPAIR = 1e-2;
/** A vehicle that cannot plan its current leg tries again after this many seconds. */
export const RETRY_INTERVAL = 1;
/** A 'park' vehicle without work waits this long before it drives to a depot, so a load that appears right after its job still finds it. */
export const IDLE_GRACE = 20;
/** An idle vehicle makes room once a vehicle has been held up behind it this long (s). */
export const YIELD_AFTER = 2;
/** A broken vehicle gives its not yet picked up order back to the dispatcher after this long (s). */
export const REASSIGN_AFTER = 30;
/** A flow whose oldest ready load has waited this long (s) gains one priority level per period, so no flow starves for ever. */
export const PRIORITY_AGING = 900;
/** After a departure from a depot was blocked the dispatcher looks again after this long (s). */
export const BLOCKED_RETRY = 0.2;
/**
 * Choosing a waiting cell for a vehicle that makes room: the route cost (m) plus these surcharges, in metres, for a junction or
 * dead-end cell, a cell that routes have used so far, a cell on a route that is being driven right now, and a dock.
 * Nothing is excluded for these reasons (in a plant with a single aisle every cell has one of them), but the surcharges
 * make a cell that hinders nobody win.
 */
export const SPOT_PENALTY_CONTROLLED = 40;
export const SPOT_PENALTY_USED = 20;
export const SPOT_PENALTY_BUSY = 100;
export const SPOT_PENALTY_DOCK = 300;
/** A vehicle that found no waiting cell looks again after this long (s). */
export const YIELD_RETRY = 5;
/** Upper bound of back-to-back cycles one machine may complete within a single tick. */
export const MAX_CYCLES_PER_STEP = 1000;
/**
 * Most loads waiting in the yard of one source (memory guard: a source with a 1 s interval, a batch of 100 and ten times the demand
 * would otherwise create a thousand loads per simulated second and fill the memory in an 8-hour run). Arrivals beyond it are dropped.
 */
export const YARD_LIMIT = 100000;
/** Upper bound of parallel machines per workstation and of vehicles per fleet (memory guard). */
export const MAX_MACHINES = 256;
export const MAX_FLEET = 1000;
/** An idle vehicle on the road drains the battery at this share of the working rate. */
export const IDLE_DRAIN_SHARE = 0.2;

// ---- docks (logistics/docks.js: which dock of a station a vehicle drives to) ---------------------------------------------
/**
 * Seconds a dock cell stays taken after service is over: the vehicle reverses out (U-turn at a dead end) or pulls away and the next one
 * can take its place. Measured on the AGV preset (1.2 m long, 2 m cells): 8.5 s between "leaves" and "stands" on a dead-end spur in a
 * saturated queue, about 3.4 s on a dock that lies on a through lane. Longer vehicles take longer (turnaround in docks.js scales with the
 * length relative to DOCK_REFERENCE_LENGTH, the AGV).
 */
export const DOCK_TURNAROUND_DEAD_END = 8;
export const DOCK_TURNAROUND_THROUGH = 3;
export const DOCK_REFERENCE_LENGTH = 1.2;
/** Time (s) a vehicle that stands somewhere for no known reason (waiting for a retry, just relocated) is expected to hold the cell. */
export const DOCK_SHORT_STOP = 2;
/** What a dead vehicle's dock or lane counts as (s): it never frees up, but the estimates stay finite numbers. */
export const DOCK_DEAD_WAIT = 7200;
/** A vehicle drives this share of its top speed on average (corners, junctions, acceleration); turns a route cost into a travel time. */
export const DOCK_CRUISE_SHARE = 0.75;
/** A reservation that is expected this much later than a new vehicle (s) still counts as ahead of it in the queue. */
export const DOCK_AHEAD_SLACK = 1;
/**
 * The dock choice (docks.js) ranks the docks by the time until service starts PLUS what the dock costs on the way out:
 *   * a dock that lies farther than the nearest one is driven to and away from again, so its extra route counts DOCK_EXIT_WEIGHT times
 *     once more (the estimate holds the way in; 1 = the way out is as long as the way in);
 *   * a wait for a dock that lies one cell off a junction (a spur of one cell off the main road) is spent ON the junction and holds up everybody
 *     who wants to pass, so each second of it counts DOCK_BLOCK_WEIGHT seconds; on a spur of two or more cells the vehicle waits out of the way;
 *   * the cheapest dock is only left for a gain of more than DOCK_MIN_GAIN seconds.
 * Without the first and the last a dock that was better by a tenth of a second won although it lay 6 m farther away, and the vehicles delivered
 * up to 10 % less than with the old static dock on plants with deeper spurs; without the second the junction in front of one-cell spurs stays jammed.
 * The values were found by sweeping 144 comb plants (2, 3 and 5 spurs of 1 to 4 cells, 2 to 8 vehicles, 8 and 20 s loads) against the old rule.
 */
export const DOCK_EXIT_WEIGHT = 1;
export const DOCK_BLOCK_WEIGHT = 2;
export const DOCK_MIN_GAIN = 3;
/** A vehicle that still drives to its dock looks for a better one this often (s of sim time)... */
export const REBIND_INTERVAL = 2;
/** ...and switches when that saves more than this many seconds AND this share of its own estimate (hysteresis against flapping). */
export const REBIND_MIN_GAIN = 8;
export const REBIND_GAIN_SHARE = 0.25;
/** A vehicle switches docks at most this often per approach (per leg). */
export const REBIND_MAX_SWITCHES = 1;

export const VEHICLE_STATES = [
  'idle', 'parked', 'toPickup', 'loading', 'toDrop', 'unloading', 'toCharger', 'charging', 'toPark', 'broken', 'dead',
];
/** States in which the vehicle is driving (or about to drive) a route toward `targetId`. */
export const DRIVING_STATES = new Set(['toPickup', 'toDrop', 'toCharger', 'toPark']);

/** `v` when it is a finite number, else `fallback`. */
export const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** Finite number >= min (fallback for junk). */
export const atLeast = (v, min, fallback = min) => Math.max(min, num(v, fallback));
/** Integer >= min (fallback for junk, fractions floored). */
export const whole = (v, min, fallback = min) => Math.max(min, Math.floor(num(v, fallback)));

/** Copy of a time distribution with a valid kind, a finite non-negative mean and spread in 0..1. */
export function cleanDist(d, fallback) {
  const src = d && typeof d === 'object' ? d : fallback;
  return {
    kind: DIST_KINDS.includes(src.kind) ? src.kind : fallback.kind,
    mean: atLeast(src.mean, 0, fallback.mean),
    spread: Math.min(1, atLeast(src.spread, 0, 0)),
  };
}

/** Remove every element of `set` from `queue` in place, keeping the order of the rest. */
export function removeFromQueue(queue, set) {
  let w = 0;
  for (let r = 0; r < queue.length; r++) if (!set.has(queue[r])) queue[w++] = queue[r];
  queue.length = w;
}
