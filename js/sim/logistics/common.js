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
/** A waiting place for a vehicle that makes room: extra distance (m) charged for a junction/dead-end cell and for a cell already used by routes. */
export const SPOT_PENALTY_CONTROLLED = 40;
export const SPOT_PENALTY_USED = 20;
/** Upper bound of back-to-back cycles one machine may complete within a single tick. */
export const MAX_CYCLES_PER_STEP = 1000;
/** Upper bound of parallel machines per workstation and of vehicles per fleet (memory guard). */
export const MAX_MACHINES = 256;
export const MAX_FLEET = 1000;
/** An idle vehicle on the road drains the battery at this share of the working rate. */
export const IDLE_DRAIN_SHARE = 0.2;

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
