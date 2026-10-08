// Route-ahead scans for the traffic engine: nearest obstacle ahead ("leader") and controlled-cell lock requests.
// All functions take the TrafficSystem `sys` and only READ vehicle state from the start of the tick, so the result
// does not depend on the order in which vehicles are processed.
//
// Route coordinate Q: distance along the vehicle's own route, Q = routeIndex * cellSize + s. Node i of the route
// sits at Q = i * cellSize; its cell spans [i*L - L/2, i*L + L/2]. A vehicle's footprint is [Q - len/2, Q + len/2].

const EPS = 1e-9;
/**
 * Followers add this multiple of the corner shortening to their gap: the rigid bodies of two vehicles in a tight
 * corner come closer than their centres, by about as much again (measured on one-way loops, see the traffic tests).
 */
const CORNER_SAFETY = 2;

/** Edge j of the route, or (beyond the end) of the straight-line extension; -1 if none. */
function edgeAhead(tv, j) {
  const n = tv._route.length;
  if (j < n) return tv._route[j];
  const k = j - n;
  return k < tv._ext.length ? tv._ext[k] : -1;
}

/** Node i of the route (i = 0 is the start node), or of the extension beyond the end; -1 if none. */
export function nodeAhead(sys, tv, i) {
  const n = tv._route.length;
  if (i <= n) return tv._nodes[i];
  const k = i - n - 1;
  return k < tv._ext.length ? sys.graph.edges[tv._ext[k]].to : -1;
}

/**
 * Does the vehicle need the lock of `node` before it may enter? Controlled cells always do. Any other cell does
 * while somebody else holds it (a vehicle parked on a bend), and a final node on a bend does so that the parked
 * vehicle cannot be hit by traffic turning through the same small cell.
 */
export function needsLock(sys, tv, node, isFinal) {
  const holder = sys._lock[node];
  if (sys.graph.controlled[node] === 1 || holder !== null) return holder !== tv;
  return isFinal && sys._bend[node] === 1;
}

/** A vehicle that is in, leaving or about to enter the cell of `node` from a lane other than `ownEdge`, or null. */
function cellOccupant(sys, tv, node, ownEdge) {
  const { graph, L, r } = sys;
  const lanes = sys._lanes;
  for (const e of graph.in[node]) {
    if (e === ownEdge) continue;
    for (const x of lanes[e]) {
      if (x === tv) continue;
      const committed = sys.standoff + (x.v * x.v) / (2 * x.decel) + 0.5 * x.v; // cannot stop before the cell any more
      if (x._ls + x.length / 2 >= L - r - committed) return x;
    }
  }
  for (const e of graph.out[node]) {
    for (const x of lanes[e]) if (x !== tv && x._ls - x.length / 2 <= r) return x;
  }
  const parked = sys._fresh[node];
  return parked === undefined ? null : parked[0];
}

/**
 * Centre coordinate of the stop line in front of route node i: the front bumper stays `sys.standoff` before the cell
 * boundary (one headway to whatever is inside the cell, plus the overhang of the longest vehicle beyond a cell),
 * never behind the vehicle itself.
 */
export function stopLineQ(sys, tv, i, q) {
  return Math.max(i * sys.L - sys.r - tv.length / 2 - sys.standoff, q);
}

/**
 * Does the body of `x`, standing on route edge j of `tv`, lie in tv's lane? A vehicle that has just entered the edge
 * from a different direction (a merge or crossing) still has its rear back in the other street; the cell lock
 * covers that conflict, so it must not be taken for a leader.
 */
function bodyInLane(tv, j, x) {
  if (x._ls - x.length / 2 >= 0 || x._prev < 0) return true;
  return x._prev === (j > 0 ? edgeAhead(tv, j - 1) : tv._prev);
}

/**
 * Index (> route length) of the first cell beyond the end of the route that needs a lock and that the vehicle's
 * nose reaches into once it rests on its final node, and whose lock it does not hold; -1 if none. Only vehicles
 * longer than one cell have such cells.
 */
export function firstExtensionCell(sys, tv) {
  if (tv._ext.length === 0 || tv.length / 2 <= sys.r) return -1; // the nose stays within its own cell
  const n = tv._route.length;
  const finalQ = n * sys.L;
  for (let k = n + 1; k <= n + tv._ext.length; k++) {
    if (k * sys.L - sys.r - tv.length / 2 >= finalQ - EPS) return -1;
    if (needsLock(sys, tv, nodeAhead(sys, tv, k), false)) return k;
  }
  return -1;
}

/** Record `x` as the nearest obstacle if its rear coordinate `q` is smaller than the current best. */
function offer(tv, q, x) {
  if (q < tv._ldQ) { tv._ldQ = q; tv._ldTv = x; }
}

/**
 * Obstacles around the node at the head of route edge e (route index j): vehicles parked on its centre, vehicles
 * still easing into the other lane, and vehicles that came over e but turned off (their tail is still in the lane).
 */
function scanHead(sys, tv, e, j) {
  const edge = sys._edges[e];
  const head = edge.to;
  const parked = sys._fresh[head];
  if (parked !== undefined) for (const f of parked) offer(tv, (j + 1) * sys.L - f.length / 2, f);

  const lanes = sys._lanes;
  const outs = sys._out[head];
  const route = tv._route;
  const next = j + 1 < route.length ? route[j + 1] : edgeAhead(tv, j + 1);
  for (let k = 0; k < outs.length; k++) {
    const sib = outs[k];
    const list = lanes[sib];
    if (list.length === 0) continue;
    const f = list[list.length - 1];
    if (sib === edge.rev) {
      if (f._turn >= 0) offer(tv, (j + 1) * sys.L - f.length / 2, f); // manoeuvring in place on the node centre
    } else if (sib !== next && f._prev === e) { // came over this edge but turned off: its tail is still in our lane
      const rear = f._ls - f.length / 2;
      // ... until it has cleared the point where the two lane lines cross
      if (rear < sys.geo.laneOffsetAbs + (f.width + tv.width) / 2) offer(tv, (j + 1) * sys.L + Math.min(rear, 0), f);
    }
  }
}

/**
 * Find the nearest obstacle ahead of `tv` within `dLimit` metres of its front: the rear-most vehicle of each edge on
 * the route (and on its straight continuation), parked vehicles on node centres, and vehicles that have turned off
 * onto a sibling edge but whose rear still sticks back into the lane the observer is driving in.
 * Sets tv._ldQ (rear coordinate, Infinity if none), tv._ldTv, tv._ldV and tv._ldDec.
 */
function scanLeader(sys, tv, dLimit) {
  const L = sys.L;
  const lanes = sys._lanes;
  const route = tv._route;
  const ri = tv._ri;
  const maxQ = ri * L + tv.s + tv.length / 2 + dLimit;
  tv._ldQ = Infinity;
  tv._ldTv = null;
  for (let j = ri; ; j++) {
    const base = j * L;
    if (base - sys._maxLength / 2 > Math.min(tv._ldQ, maxQ)) break;
    const e = j < route.length ? route[j] : edgeAhead(tv, j);
    if (e < 0) break;
    const list = lanes[e];
    let x = null;
    if (j === ri) {
      const i = list.indexOf(tv);
      if (i > 0) x = list[i - 1];
    } else if (list.length > 0) x = list[list.length - 1];
    if (x !== null && bodyInLane(tv, j, x)) offer(tv, base + x._ls - x.length / 2, x);
    scanHead(sys, tv, e, j);
  }
  const x = tv._ldTv;
  tv._ldV = x === null ? 0 : x.v;
  tv._ldDec = x === null ? 1 : x.decel;
  if (x !== null) tv._ldQ -= pathCompression(sys, tv, ri * L + tv.s + tv.length / 2, tv._ldQ);
}

/** Extra gap needed for the corners (see Geometry.compression) of the route between route coordinates a and b. */
function pathCompression(sys, tv, a, b) {
  const { L, r, geo } = sys;
  let total = 0;
  for (let i = tv._ri; i * L - r < b; i++) {
    const lo = Math.max(a, i * L - r);
    const hi = Math.min(b, i * L + r);
    if (hi <= lo) continue;
    const prev = i > 0 ? edgeAhead(tv, i - 1) : -1;
    const next = edgeAhead(tv, i);
    if (prev >= 0 && next >= 0) total += (CORNER_SAFETY * geo.compression(prev, next) * (hi - lo)) / (2 * r);
  }
  return total;
}

/** Withdraw a pending lock request. */
export function cancelRequest(sys, tv) {
  if (tv._req < 0) return;
  const i = sys._pending.indexOf(tv);
  if (i >= 0) sys._pending.splice(i, 1);
  tv._req = -1;
  tv._gate = null;
  tv._elig = false;
}

/**
 * Update the vehicle's lock request and look for the nearest obstacle ahead (`dShort` metres, more if the request
 * needs to see the room beyond the exit). The target is the first controlled cell on the route whose lock the vehicle
 * does not hold, once its stop line is within `dReq`. Besides the cell itself the request covers every further
 * controlled cell the vehicle would still overlap while clearing it (atomic acquisition, so two vehicles can never
 * each hold half of a pair of adjacent cells). It is eligible only if nothing stands in the room beyond the exit
 * that the vehicle needs to come to rest (length + headway): no box-blocking.
 */
export function evaluateRequest(sys, tv, dReq, dShort) {
  const { graph, L, r, headway } = sys;
  const n = tv._route.length;
  const q = tv._ri * L + tv.s;
  const half = tv.length / 2;
  const nodes = tv._nodes;
  const lockable = sys._lockable;
  let target = -1;
  for (let i = tv._ri + 1; i <= n; i++) {
    if (i * L - r - half - sys.standoff - q > dReq) break;
    const node = nodes[i];
    if ((lockable[node] === 1 || sys._lock[node] !== null) && needsLock(sys, tv, node, i === n)) { target = i; break; }
  }
  if (target < 0) {
    const k = firstExtensionCell(sys, tv);
    if (k >= 0 && stopLineQ(sys, tv, k, q) - q <= dReq) target = k;
  }
  if (target < 0) {
    scanLeader(sys, tv, dShort);
    if (tv._req >= 0) cancelRequest(sys, tv);
    return;
  }
  const node = nodeAhead(sys, tv, target);
  if (tv._req !== node) {
    cancelRequest(sys, tv);
    tv._req = node;
    sys._pending.push(tv);
  }
  const exitQ = target * L + r;
  const zoneEnd = Math.min(exitQ + tv.length, n * L + half);
  tv._chainN.length = 0;
  tv._chainQ.length = 0;
  let gate = null;
  for (let k = target; ; k++) {
    // A later cell is part of the request if the vehicle could end up waiting at its stop line while its rear is
    // still inside the first cell - otherwise it would hold one cell while waiting for the next (hold and wait).
    const lineQ = k * L - r - half - sys.standoff;
    if (k > target && (lineQ - half >= exitQ - EPS || lineQ >= n * L - EPS)) break;
    const nd = nodeAhead(sys, tv, k);
    if (nd < 0) break;
    const holder = sys._lock[nd];
    if (k !== target && graph.controlled[nd] !== 1 && (holder === null || holder === tv)) continue;
    tv._chainN.push(nd);
    tv._chainQ.push(k * L + r);
    if (gate === null && holder !== null && holder !== tv) gate = holder;
  }
  if (gate === null && sys._bend[node] === 1 && graph.controlled[node] !== 1) {
    gate = cellOccupant(sys, tv, node, target > 0 ? edgeAhead(tv, target - 1) : -1);
  }
  scanLeader(sys, tv, Math.max(dShort, zoneEnd + headway - (q + half) + 1)); // must see the room beyond the exit
  if (gate === null && tv._ldQ < zoneEnd + headway - EPS) gate = tv._ldTv;
  tv._gate = gate;
  tv._elig = gate === null;
}

/** Grant pending requests in FIFO order to every vehicle that is eligible and whose whole cell chain is free. */
export function grantLocks(sys) {
  const pending = sys._pending;
  for (let k = 0; k < pending.length;) {
    const tv = pending[k];
    if (!tv._elig || tv.disabled) { k++; continue; }
    const chain = tv._chainN;
    let blocker = null;
    for (let c = 0; c < chain.length && blocker === null; c++) {
      const holder = sys._lock[chain[c]];
      if (holder !== null && holder !== tv) blocker = holder;
    }
    if (blocker !== null) { tv._gate = blocker; k++; continue; }
    for (let c = 0; c < chain.length; c++) {
      sys._lock[chain[c]] = tv;
      if (!tv._held.includes(chain[c])) { tv._held.push(chain[c]); tv._heldQ.push(tv._chainQ[c]); }
    }
    tv._req = -1;
    tv._gate = null;
    tv._elig = false;
    pending.splice(k, 1);
  }
}

/**
 * Release every held cell whose exit the vehicle's rear has passed (route coordinate q of the centre). A cell the
 * route visits again (a dead-end turn-around) is kept, and its release point moved to the later visit, as soon
 * as the vehicle's front overlaps it again.
 */
export function releaseCleared(sys, tv, q) {
  const { L, r } = sys;
  const rear = q - tv.length / 2;
  const front = q + tv.length / 2;
  const last = tv._route.length + tv._ext.length;
  for (let k = tv._held.length - 1; k >= 0; k--) {
    if (rear < tv._heldQ[k] - EPS) continue;
    const node = tv._held[k];
    let again = -1;
    for (let j = Math.round((tv._heldQ[k] - r) / L) + 1; j <= last && j * L - r <= front + EPS; j++) {
      if (nodeAhead(sys, tv, j) === node) { again = j; break; }
    }
    if (again >= 0) { tv._heldQ[k] = again * L + r; continue; }
    if (sys._lock[node] === tv) sys._lock[node] = null;
    tv._held.splice(k, 1);
    tv._heldQ.splice(k, 1);
  }
}

/** Release all locks held by `tv` (detach / remove / relocate). */
export function releaseAll(sys, tv) {
  for (const node of tv._held) if (sys._lock[node] === tv) sys._lock[node] = null;
  tv._held.length = 0;
  tv._heldQ.length = 0;
}
