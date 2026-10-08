// One tick of vehicle motion, in two phases so the result does not depend on vehicle order:
//   planMotion  - reads the start-of-tick state of everybody, decides each vehicle's end-of-tick speed and advance;
//   applyMotion - moves the vehicle, hands over between edges, updates pose, lane lists and locks, handles arrival.
//
// Speed control per vehicle (docs/ARCHITECTURE.md §5.2, requirement 1 and 2). The end-of-tick speed is the minimum of
//   * accelerate: v + accel * dt, and the cap  vmax * speedFactor * edge.limit;
//   * zone limits ahead: <= 50 % of that cap through corners and controlled cells (reached by braking in time);
//   * stop targets: the final node centre, the dead-end reversal point, the stop line of a controlled cell whose
//     lock is not held (stop at the line, front bumper at the cell boundary);
//   * the leader: v^2 <= 2 * decel * (gap - headway + leader braking distance), i.e. the vehicle could stop in
//     time even if the leader brakes as hard as it can;
// and the advance is hard-clamped to (gap - headway), measured from the start-of-tick leader position, so a vehicle
// can never get closer than the headway however large dt is. Vehicles never decelerate harder than `decel` unless
// that hard clamp or an exact stop snap forces it.

import { brakeLimit, brakeAdvance, stoppingDistance, MOVING_SPEED } from './kinematics.js';
import { stopLineQ, releaseCleared, firstExtensionCell, nodeAhead, needsLock } from './scan.js';

const EPS = 1e-9;

/** brakeLimit, but an infeasible limit (-1) becomes 0: the deceleration floor and the hard clamps take over. */
function limit(v, d, vTarget, dec, dt) {
  const l = brakeLimit(v, d, vTarget, dec, dt);
  return l < 0 ? 0 : l;
}

/** Decide end-of-tick speed (tv._nv) and advance (tv._adv) for a driving vehicle. */
export function planMotion(sys, tv, dt) {
  const { graph, geo, L, r, headway } = sys;
  const edges = graph.edges;
  const route = tv._route;
  const n = route.length;
  const ri = tv._ri;
  const v = tv.v;
  const dec = tv.decel;
  tv._blk = 0;
  tv._blkTv = null;
  tv._blkNode = -1;
  tv._vFree = 0;
  if (tv._turn >= 0) { tv._nv = 0; tv._adv = 0; return; }

  const half = tv.length / 2;
  const q = ri * L + tv.s;
  const vTop = tv.vmax * sys.speedFactor;
  const vCap = vTop * edges[route[ri]].limit;
  const dLook = (vTop * vTop) / (2 * dec) + vTop * dt + 1; // farther constraints cannot bind: it can always stop in time

  let limOther = Infinity; // zone limits and the final / reversal stop
  let limLine = Infinity; // stop line in front of a controlled cell without lock
  let dStop = Infinity; // distance to the nearest stop target
  let lineNode = -1;
  for (let i = ri; i <= n; i++) {
    const node = tv._nodes[i];
    const ctrl = graph.controlled[node] === 1;
    const zoneStart = i * L - r - (ctrl ? half + sys.standoff : 0);
    if (i > ri && zoneStart > q + dLook) break;
    const prev = i > 0 ? route[i - 1] : -1; // the first edge starts on its lane line, after any in-place manoeuvre
    const next = i < n ? route[i] : -1;
    if (ctrl || geo.isCorner(prev, next)) {
      if (q <= i * L + r + (ctrl ? half : 0)) {
        const lp = prev >= 0 ? edges[prev].limit : 1;
        const ln = next >= 0 ? edges[next].limit : 1;
        limOther = Math.min(limOther, limit(v, zoneStart - q, 0.5 * vTop * Math.min(lp, ln), dec, dt));
      }
    }
    if (i > ri && i < n) {
      const le = vTop * edges[route[i]].limit;
      if (le < vTop) limOther = Math.min(limOther, limit(v, i * L - q, le, dec, dt));
    }
    if (i > ri && needsLock(sys, tv, node, i === n)) {
      dStop = stopLineQ(sys, tv, i, q) - q;
      limLine = limit(v, dStop, 0, dec, dt);
      lineNode = node;
      break;
    }
    if (i === n) { // a long vehicle's nose may reach into a controlled cell beyond the final node
      const k = firstExtensionCell(sys, tv);
      if (k >= 0) {
        dStop = stopLineQ(sys, tv, k, q) - q;
        limLine = limit(v, dStop, 0, dec, dt);
        lineNode = nodeAhead(sys, tv, k);
        break;
      }
    }
    if (i === n || (i > ri && geo.isReversal(prev, next))) {
      dStop = i * L - q;
      limOther = Math.min(limOther, limit(v, dStop, 0, dec, dt));
      break;
    }
  }

  let limLead = Infinity;
  let dLead = Infinity;
  if (tv._ldQ !== Infinity) {
    dLead = Math.max(0, tv._ldQ - (q + half) - headway);
    limLead = limit(v, dLead + stoppingDistance(tv._ldV, tv._ldDec), 0, dec, dt);
  }

  const vFloor = Math.max(0, v - dec * dt);
  if (tv.disabled) { // brakes at once and stays; still never crosses a stop target or the leader
    let adv = Math.min(brakeAdvance(v, dec, dt), dLead, dStop);
    if (adv >= dStop - EPS) adv = dStop;
    tv._nv = vFloor;
    tv._adv = adv;
    return;
  }

  const vFree = Math.min(vCap, limOther);
  const vAcc = v + tv.accel * dt;
  let vNew = Math.min(vAcc, vFree, limLead, limLine);
  if (vNew < vFloor) vNew = vFloor;
  tv._vFree = vFree;
  if (Math.min(limLead, limLine) < Math.min(vAcc, vFree) - EPS) { // the vehicle ahead or the junction is what holds it back
    if (limLine < limLead) { tv._blk = 2; tv._blkTv = tv._gate; tv._blkNode = lineNode; } else { tv._blk = 1; tv._blkTv = tv._ldTv; }
  }

  let adv = (v + vNew) * 0.5 * dt;
  if (adv > dLead) {
    adv = dLead;
    vNew = Math.min(vNew, Math.max(0, (2 * adv) / dt - v));
  }
  if (adv >= dStop - EPS) { // reaching the stop target this tick: stop exactly on it
    adv = dStop;
    vNew = 0;
  }
  tv._nv = vNew;
  tv._adv = adv;
}

/** Remove `tv` from a lane list (it is normally the front-most entry). */
export function laneRemove(list, tv) {
  if (list[0] === tv) { list.shift(); return; }
  const i = list.indexOf(tv);
  if (i >= 0) list.splice(i, 1);
}

/** Progress per second of an in-place manoeuvre (dead-end U-turn, or easing onto the lane line). */
function turnRate(sys, tv) {
  const length = tv._prev >= 0 && sys.geo.isReversal(tv._prev, tv.edge)
    ? sys.geo.turnCurve(tv._prev, tv.edge)[8]
    : sys.geo.easeLength(tv._x0, tv._y0, tv._h0, tv.edge);
  const speed = Math.max(1e-3, 0.5 * tv.vmax * sys.speedFactor * sys.graph.edges[tv.edge].limit);
  return speed / length;
}

/** Pose of a vehicle in the middle of an in-place manoeuvre at progress u. */
function manoeuvrePose(sys, tv, out, u) {
  if (tv._prev >= 0 && sys.geo.isReversal(tv._prev, tv.edge)) sys.geo.turnPose(out, tv._prev, tv.edge, u);
  else sys.geo.easePose(out, tv._x0, tv._y0, tv._h0, tv.edge, u);
}

/** Move the vehicle by its plan. Pushes the vehicle to sys._arrived when its route ends. */
export function applyMotion(sys, tv, dt) {
  const { geo, L } = sys;
  const route = tv._route;
  const n = route.length;
  if (tv._turn >= 0) { // in-place manoeuvre (dead-end U-turn / easing into the lane): at rest, v = 0
    if (!tv.disabled) tv._turn += dt * turnRate(sys, tv);
    if (tv._turn >= 1) tv._turn = -1;
    const out = sys._pose;
    if (tv._turn >= 0) manoeuvrePose(sys, tv, out, tv._turn);
    else geo.pose(out, tv.edge, 0, tv._ri > 0 ? route[tv._ri - 1] : -1, tv._ri + 1 < n ? route[tv._ri + 1] : -1);
    setPose(tv, out);
    tv.v = 0;
    tv.moving = false;
    return;
  }
  tv.v = tv._nv;
  tv.moving = tv.v > MOVING_SPEED;
  if (tv._adv <= 0) return;
  tv.odometer += tv._adv;
  let s = tv.s + tv._adv;
  let ri = tv._ri;
  let arrived = false;
  while (s >= L - EPS) {
    if (ri === n - 1) { s = L; arrived = true; break; }
    const from = route[ri];
    const to = route[++ri];
    laneRemove(sys._lanes[from], tv);
    sys._lanes[to].push(tv);
    s = Math.max(0, s - L);
    tv._prev = from;
    tv.edge = to;
    tv.lastEdge = to;
    tv._lane = to;
    sys.stats.edgePasses[to]++;
    if (geo.isReversal(from, to)) { // arrived at the dead-end reversal point: turn around before moving on
      s = 0;
      tv.v = 0;
      tv.moving = false;
      tv._turn = 0;
      break;
    }
  }
  tv._ri = ri;
  tv.s = s;
  tv._ls = s;
  if (tv._held.length > 0) releaseCleared(sys, tv, ri * L + s);
  if (arrived) { park(sys, tv, n); return; }
  const out = sys._pose;
  if (tv._turn >= 0) manoeuvrePose(sys, tv, out, 0);
  else geo.pose(out, tv.edge, s, ri > 0 ? route[ri - 1] : -1, ri + 1 < n ? route[ri + 1] : -1);
  setPose(tv, out);
}

function setPose(tv, p) {
  tv.x = p.x;
  tv.y = p.y;
  tv.heading = p.h;
}

/** The route is complete: the vehicle rests exactly on the final node centre (lane offset of the last edge). */
function park(sys, tv, n) {
  const last = tv._route[n - 1];
  tv.node = tv._nodes[n];
  tv.edge = -1;
  tv.s = 0;
  tv._ls = sys.L;
  tv.v = 0;
  tv.moving = false;
  tv.driving = false;
  tv._route = null;
  tv._nodes = null;
  tv._ext = [];
  tv._ri = 0;
  tv._turn = -1;
  sys.geo.parkedPose(sys._pose, last, tv.node, tv.heading);
  setPose(tv, sys._pose);
  sys._arrived.push(tv);
}
