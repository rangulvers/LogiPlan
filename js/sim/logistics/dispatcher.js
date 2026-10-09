// Demand-driven global greedy dispatch (docs/ARCHITECTURE.md 5.3).
//
// A flow has demand when loads are ready at its origin and there is room for them at its destination.
// A round builds every (available vehicle, flow with demand) pair, picks the best one by priority and then
// by strategy, assigns it (claiming the loads and reserving destination space at once), and repeats with
// the updated availability until no pair is left. Because claims and reservations are applied immediately,
// later pairs always see the reduced availability: no load and no free place is ever promised twice.
//
// Strategies (lower is better):  nearest = pickup route cost, then oldest age;  oldest = oldest-load age
// (descending), then pickup cost;  balanced = cost - 0.5 * age.
// Priority 1-3 comes first, but it ages: for every PRIORITY_AGING seconds the oldest ready load of a flow has
// waited, the flow ranks one level higher, so a flow that a saturating higher-priority flow keeps from the fleet is
// served eventually.
// batchMin is clamped to what can ever be gathered or delivered (vehicle capacity, batchMax, origin and
// destination buffer sizes), so an over-ambitious batchMin cannot starve a flow for ever. maxWait = 0
// means "wait for batchMin without a time limit".
// The docks of a trip are chosen by routing.js (a pickup dock must lead on to the drop, one-way traps come last).
// A round also reports when it should run again (the next load becoming ready, a maxWait running out) and which
// depots had a vehicle with work that could not leave.
// Searches are the expensive part (routing.js): a vehicle whose first search the tick's budget does not allow yet is left out
// of the round, which then runs again in the next tick. In a plant big enough for that to happen (dozens of vehicles on a
// 100 x 80 grid) the vehicles are put to work a few per tick during the first second or two of a run, instead of all in one
// tick that takes a fifth of a second.

import { EPS, PRIORITY_AGING } from './common.js';
import { flowCapacity, flowSpace, readyLoads, reserveInbound } from './stations.js';
import { arrivalEdgeOf, isAvailable, leaveDepot, startLeg } from './vehicles.js';

const TOL = 1e-6;
const cmp = (a, b) => (Math.abs(a - b) <= TOL ? 0 : a < b ? -1 : 1);

/**
 * Run one dispatch round at time t: assign orders to available vehicles.
 * @returns {{ wake: number, blockedDepots: Set<object> }} `wake`: sim time of the next event that may create demand
 *   (Infinity if none is known; t when a vehicle is still waiting for its search); `blockedDepots`: depots a parked vehicle
 *   with work could not leave
 */
export function dispatch(lg, t) {
  const round = { departures: new Map(), blockedDepots: new Set(), wake: Infinity, starved: false };
  const avail = lg.vehicles.filter((vr) => isAvailable(lg, vr));
  if (avail.length === 0) return round;
  const maxCapacity = avail.reduce((m, vr) => Math.max(m, vr.cfg.capacity), 1);
  while (avail.length > 0) {
    const demands = collectDemand(lg, t, maxCapacity, round);
    if (demands.length === 0) break;
    const best = bestPair(lg, avail, demands, t, round);
    if (!best) break;
    avail.splice(avail.indexOf(best.vehicle), 1);
    assign(lg, best, t, round);
  }
  if (round.starved) round.wake = t;
  return round;
}

/** Flows that currently could use a transport, with what a transport may carry. Notes in `round.wake` when more may come. */
function collectDemand(lg, t, maxCapacity, round) {
  const out = [];
  for (const flow of lg.flows) {
    const space = flowSpace(flow);
    if (space < 1) continue;
    const ready = readyLoads(flow, t, maxCapacity);
    round.wake = Math.min(round.wake, ready.next);
    if (ready.count < 1) continue;
    const c = flow.cfg;
    const batchMax = c.batchMax > 0 ? c.batchMax : Infinity;
    const timed = c.maxWait > 0;
    const expired = timed && ready.age >= c.maxWait - EPS;
    if (timed && !expired) round.wake = Math.min(round.wake, ready.oldest + c.maxWait);
    out.push({
      flow,
      count: ready.count,
      age: ready.age,
      space,
      priority: c.priority + Math.floor(ready.age / PRIORITY_AGING),
      batchMax,
      // the smallest worthwhile batch, unless the oldest load has waited long enough
      minBatch: expired
        ? 1
        : Math.max(1, Math.min(c.batchMin, batchMax, flowCapacity(flow), flow.outLink.cap, flow.from.capacity ?? Infinity)),
    });
  }
  return out;
}

function bestPair(lg, avail, demands, t, round) {
  let best = null;
  for (const vehicle of avail) {
    for (const demand of demands) {
      const cand = evaluate(lg, vehicle, demand, t, round);
      if (cand && (best === null || better(cand, best, lg.runtime.dispatch))) best = cand;
    }
  }
  return best;
}

/** Can `vehicle` serve `demand`? Returns the candidate (qty, pickup cost, ...) or null. */
function evaluate(lg, vehicle, demand, t, round) {
  const { flow } = demand;
  if (flow.cfg.fleetId !== null && flow.cfg.fleetId !== vehicle.fleetId) return null;
  const capacity = vehicle.cfg.capacity;
  const qty = Math.min(capacity, demand.batchMax, demand.count, demand.space);
  if (qty < Math.min(demand.minBatch, capacity)) return null;

  let pickup;
  let dock = -1;
  if (vehicle.state === 'parked') {
    const dep = departure(lg, vehicle.depot, flow, t, round);
    if (!dep) return null;
    ({ best: pickup, dock } = dep);
  } else {
    const entry = lg.routes.get(vehicle.tv.node, arrivalEdgeOf(lg, vehicle), t, true);
    if (entry === null) { round.starved = true; return null; }
    pickup = lg.routes.pickupDock(entry, flow.from.id, flow.to.id);
    if (!pickup) return null;
  }
  return { vehicle, demand, qty, cost: pickup.dist, age: demand.age, dock };
}

/** Best attachable dock of a depot for a trip along `flow` (cached per round; a dock frees up as vehicles leave). */
function departure(lg, depot, flow, t, round) {
  let perFlow = round.departures.get(depot);
  if (perFlow === undefined) round.departures.set(depot, (perFlow = new Map()));
  if (perFlow.has(flow.id)) return perFlow.get(flow.id);
  const { attachable, pending, best } = lg.routes.departure(depot, t, (entry) => lg.routes.pickupDock(entry, flow.from.id, flow.to.id));
  if (!attachable) round.blockedDepots.add(depot);
  if (pending) round.starved = true;
  const result = best ? { dock: best.dock, best: best.onward } : null;
  perFlow.set(flow.id, result);
  return result;
}

/** Is candidate a strictly better than b? Equal candidates keep the first one found (vehicle, then flow order). */
function better(a, b, strategy) {
  if (a.demand.priority !== b.demand.priority) return a.demand.priority > b.demand.priority;
  switch (strategy) {
    case 'oldest': return (cmp(b.age, a.age) || cmp(a.cost, b.cost)) < 0;
    case 'balanced': return cmp(a.cost - 0.5 * a.age, b.cost - 0.5 * b.age) < 0;
    default: return (cmp(a.cost, b.cost) || cmp(b.age, a.age)) < 0;
  }
}

/** Commit a pair: claim loads, reserve destination space, take the vehicle out of its depot, start driving. */
function assign(lg, cand, t, round) {
  const { vehicle, demand, qty } = cand;
  const { flow } = demand;
  if (vehicle.state === 'parked') {
    const depot = vehicle.depot;
    if (!leaveDepot(lg, vehicle, cand.dock)) { round.blockedDepots.add(depot); return; }
    round.departures.delete(depot);
  }
  const link = flow.outLink;
  const loads = link.queue.slice(link.claimed, link.claimed + qty);
  for (const load of loads) load.claimed = true;
  link.claimed += qty;
  reserveInbound(flow, qty);
  vehicle.order = lg.openOrder(flow, vehicle, loads, t);
  startLeg(lg, vehicle, 'toPickup', flow.from.id, t);
}
