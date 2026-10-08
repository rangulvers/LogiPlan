// Deadlock analysis for the traffic engine: wait-for graph cycles and victim choice. Pure functions.
//
// Every waiting vehicle points to the vehicle that blocks it (tv.blockedBy), so the wait-for graph has out-degree
// <= 1 and a deadlock is simply a cycle of waiting vehicles that is followed all the way round.

/**
 * Find all cycles in the wait-for graph.
 * @param {TV[]} vehicles
 * @returns {TV[][]} cycles in discovery order (vehicle array order), each in blocking order
 */
export function findWaitCycles(vehicles) {
  const cycles = [];
  const position = new Map(); // vehicle -> index in the path being followed, -1 once fully explored
  for (const start of vehicles) {
    if (!start.waiting || position.has(start)) continue;
    const path = [];
    let cur = start;
    while (cur && cur.waiting && !position.has(cur)) {
      position.set(cur, path.length);
      path.push(cur);
      cur = cur.blockedBy;
    }
    if (cur && position.get(cur) >= 0 && path[position.get(cur)] === cur) cycles.push(path.slice(position.get(cur)));
    for (const tv of path) position.set(tv, -1);
  }
  return cycles;
}

/** Order-independent identity of a cycle (creation sequence numbers of its members). */
export function cycleKey(cycle) {
  return cycle.map((tv) => tv._seq).sort((a, b) => a - b).join(',');
}

/** Has every member of the cycle stood still and waited for at least `minWait` seconds (a slowly creeping ring is no deadlock)? */
export const isStandingDeadlock = (cycle, minWait) => cycle.every((tv) => tv.waitTime >= minWait && !tv.moving);

/**
 * Victim to relocate: the longest-waiting member; among equally long waiters (within 1 s) the one that holds up
 * the fewest other vehicles; final tie-break = creation order.
 * @param {TV[]} cycle   @param {TV[]} vehicles all vehicles (to count hindrances)
 */
export function pickVictim(cycle, vehicles) {
  const hindrances = new Map(cycle.map((tv) => [tv, 0]));
  for (const tv of vehicles) {
    if (tv.waiting && hindrances.has(tv.blockedBy)) hindrances.set(tv.blockedBy, hindrances.get(tv.blockedBy) + 1);
  }
  const longest = Math.max(...cycle.map((tv) => tv.waitTime));
  let best = null;
  for (const tv of cycle) {
    if (tv.waitTime < longest - 1) continue;
    if (best === null || hindrances.get(tv) < hindrances.get(best)
      || (hindrances.get(tv) === hindrances.get(best) && tv._seq < best._seq)) best = tv;
  }
  return best;
}
