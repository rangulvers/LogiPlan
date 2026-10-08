// What vehicles do when they have no order (docs/ARCHITECTURE.md 5.3, "idle behaviour"):
//   * 'park' fleets drive to a depot with a free place once they have been idle for IDLE_GRACE seconds;
//     'stay' fleets wait where their last job ended;
//   * a vehicle with a low battery heads for a free charger (or parks at a depot that has chargers and charges
//     there later); a parked vehicle with a low battery charges in place, or - when its depot has no chargers -
//     drives to a depot that has;
//   * a vehicle that stands still holds up everything behind it. When a vehicle has been waiting behind an idle
//     vehicle for YIELD_AFTER seconds, or a parked vehicle cannot leave a depot because an idle vehicle stands on
//     its gate, the idle vehicle makes room: it parks (if its fleet parks) or drives to a nearby road cell where
//     it hinders nobody (not a dock, not a junction or dead end, not on a route in use).
//
// Idle vehicles are not dispatched while they drive to a depot or a waiting cell (the traffic system cannot
// re-route a moving vehicle), which is why parking is delayed by IDLE_GRACE.

import {
  EPS, IDLE_GRACE, SPOT_PENALTY_CONTROLLED, SPOT_PENALTY_USED, YIELD_AFTER,
} from './common.js';
import {
  arrivalEdgeOf, cancelDepotTrip, leaveDepot, needsCharge, setState, startCharging, startLeg,
} from './vehicles.js';

/** Candidate waiting cells that turn out not to fit are skipped; at most this many are tried. */
const SPOT_TRIES = 64;

/** Standing still on the road with nothing to do (and able to move). */
function isStandingIdle(vr) {
  const tv = vr.tv;
  return vr.state === 'idle' && tv.onRoad && tv.node >= 0 && !tv.driving && !tv.disabled;
}

/**
 * After dispatch: make room where idle vehicles hold others up, then let the remaining vehicles act on their
 * idle policy.
 * @param {Set<object>} blockedDepots depots whose parked vehicles had work but could not leave
 */
export function applyIdlePolicy(lg, t, blockedDepots) {
  makeRoom(lg, t, blockedDepots);
  for (const vr of lg.vehicles) {
    if (vr.state === 'parked') tendParked(lg, vr, t);
    else if (isStandingIdle(vr)) goIdle(lg, vr, t, false);
  }
}

// ---- parking, charging --------------------------------------------------------------------------------------------

/** Heads for a depot when the policy says so (`now`: skip the grace period). True when a trip was started. */
function goIdle(lg, vr, t, now) {
  const mustCharge = needsCharge(vr) && lg.chargerDepots.length > 0;
  if (mustCharge && sendToDepot(lg, vr, t, true)) return true;
  const parks = vr.cfg.idle === 'park' && (now || t - vr.stateSince >= IDLE_GRACE - EPS);
  return (mustCharge || parks) && sendToDepot(lg, vr, t, false);
}

/** A parked vehicle with a low battery charges where it is, or - if its depot cannot charge - goes where it can. */
function tendParked(lg, vr, t) {
  if (!needsCharge(vr)) return;
  const depot = vr.depot;
  if (depot.freeChargers > 0) startCharging(lg, vr, t);
  else if (depot.chargers === 0 && lg.chargerDepots.length > 0) sendToDepot(lg, vr, t, true);
}

/** Would a vehicle drive so long to this depot that it arrives below its low threshold at a depot that cannot charge? */
function tooEmptyFor(lg, vr, depot, dist) {
  const { cfg } = vr;
  if (!cfg.batteryOn || depot.chargers > 0 || lg.chargerDepots.length === 0) return false;
  return vr.battery - (cfg.drain * dist) / (cfg.body.speed * lg.runtime.speedFactor) < cfg.low;
}

/** Route cost and, for a parked vehicle, the dock to leave over, on the way to `depot`; null when there is none. */
function wayToDepot(lg, vr, depot, origin, t) {
  if (origin) {
    const dock = lg.routes.bestDock(origin, depot.id);
    return dock ? { dist: dock.dist, dock: -1 } : null;
  }
  const { best } = lg.routes.departure(vr.depot, t, (entry) => lg.routes.bestDock(entry, depot.id));
  return best ? { dist: best.onward.dist, dock: best.dock } : null;
}

/**
 * Drive to a depot: to charge (a free charger and slot), or to park (a free slot). A vehicle that needs charge but
 * found no free charger parks at a depot that has chargers, so it can charge in place later; so does one that
 * would run below its threshold on the way to a depot without chargers. The home depot is preferred for parking,
 * otherwise the nearest suitable one. Reserves the places. A parked vehicle leaves its depot first.
 */
function sendToDepot(lg, vr, t, charge) {
  const chargerOnly = charge || needsCharge(vr);
  const parked = vr.state === 'parked';
  const origin = parked ? null : lg.routes.get(vr.tv.node, arrivalEdgeOf(lg, vr), t);
  const home = lg.stationById.get(vr.cfg.home);
  let pick = null;
  for (const depot of chargerOnly ? lg.chargerDepots : lg.depots) {
    if (!(depot.freeSlots > 0) || (charge && !(depot.freeChargers > 0)) || (parked && depot === vr.depot)) continue;
    const way = wayToDepot(lg, vr, depot, origin, t);
    if (!way || (!chargerOnly && tooEmptyFor(lg, vr, depot, way.dist))) continue;
    if (!charge && depot === home) { pick = { depot, way }; break; }
    if (pick === null || way.dist < pick.way.dist) pick = { depot, way };
  }
  if (pick === null) return false;
  const { depot, way } = pick;
  if (parked && !leaveDepot(lg, vr, way.dock)) return false;
  depot.reservedSlots++;
  if (charge) depot.reservedChargers++;
  if (startLeg(lg, vr, charge ? 'toCharger' : 'toPark', depot.id, t)) return true;
  cancelDepotTrip(lg, vr);
  vr.targetId = null;
  setState(vr, 'idle', t);
  return false;
}

// ---- making room ----------------------------------------------------------------------------------------------------

/** Is the vehicle at, or next to, a dock of the depot? (It then holds up a parked vehicle that wants to leave.) */
function nearDock(lg, vr, depot) {
  const { graph } = lg;
  const node = vr.tv.node;
  return (graph.docks.get(depot.id) || []).some((dock) => dock === node || graph.edgeBetween(dock, node) >= 0 || graph.edgeBetween(node, dock) >= 0);
}

/**
 * Idle vehicles that hold others up: the one a vehicle has been waiting behind for YIELD_AFTER seconds (the vehicles
 * further back in the queue wait behind that one, so looking at the vehicle directly behind is enough), or the occupant
 * of a depot gate.
 */
function findBlockers(lg, blockedDepots) {
  const found = new Set();
  for (const vr of lg.vehicles) {
    const tv = vr.tv;
    if (!tv.onRoad || !tv.waiting || !(tv.waitTime >= YIELD_AFTER)) continue;
    const owner = tv.blockedBy && tv.blockedBy.owner;
    if (owner && owner.lg === lg && isStandingIdle(owner)) found.add(owner);
  }
  for (const depot of blockedDepots) for (const vr of lg.vehicles) if (isStandingIdle(vr) && nearDock(lg, vr, depot)) found.add(vr);
  return lg.vehicles.filter((vr) => found.has(vr));
}

function makeRoom(lg, t, blockedDepots) {
  const blockers = findBlockers(lg, blockedDepots);
  if (blockers.length === 0) return;
  const busy = new Uint8Array(lg.graph.nodeCount);
  for (const vr of lg.vehicles) if (vr.route && vr.tv.driving) for (const node of vr.route.nodes) busy[node] = 1;
  const taken = new Set(lg.vehicles.filter((vr) => vr.spot >= 0).map((vr) => vr.spot));
  for (const vr of blockers) {
    if (goIdle(lg, vr, t, true)) continue;
    const spot = pickSpot(lg, vr, lg.routes.get(vr.tv.node, arrivalEdgeOf(lg, vr), t), busy, taken);
    if (spot < 0) continue;
    taken.add(spot);
    if (!startLeg(lg, vr, 'toPark', null, t, spot)) {
      vr.spot = -1;
      setState(vr, 'idle', t);
    }
  }
}

/**
 * The best road cell to wait on, or -1: reachable, free, not a dock, not on a route in use or promised to another
 * vehicle; the nearest wins, with a surcharge for junction/dead-end cells and for cells that routes have used.
 */
function pickSpot(lg, vr, entry, busy, taken) {
  const { graph } = lg;
  const candidates = [];
  for (const node of graph.nodes) {
    if (node === vr.tv.node || busy[node] || taken.has(node) || graph.stationsAt.has(node)) continue;
    const dist = entry.search.dist(node);
    if (dist === Infinity) continue;
    const score = dist + (graph.controlled[node] ? SPOT_PENALTY_CONTROLLED : 0) + (lg.routeUse[node] > 0 ? SPOT_PENALTY_USED : 0);
    candidates.push({ node, score });
  }
  candidates.sort((a, b) => (a.score - b.score) || (a.node - b.node));
  for (let i = 0; i < candidates.length && i < SPOT_TRIES; i++) if (lg.traffic.canAttach(candidates[i].node)) return candidates[i].node;
  return -1;
}
