// Route-ahead scans for the traffic engine: nearest obstacle ahead ("leader"), controlled-cell lock requests (chains,
// bends, swing of long vehicles) and the locks a long vehicle needs to turn on the spot.
// All functions take the TrafficSystem `sys` and only READ vehicle state from the start of the tick, so the result
// does not depend on the order in which vehicles are processed.
//
// Route coordinate Q: distance along the vehicle's own route, Q = routeIndex * cellSize + s. Node i of the route
// sits at Q = i * cellSize; its cell spans [i*L - L/2, i*L + L/2]. A vehicle's footprint is [Q - len/2, Q + len/2].

const EPS = 1e-9;
const SWING_CLEARANCE = 0.1; // m that must be free between the swing disk of a turning long vehicle and another vehicle
/**
 * Extra gap (m) a follower keeps when corners lie between it and its leader, on top of the exact shortening of the
 * path (centre to centre): rigid bodies in a tight corner come a little closer than the lane distance of their centres
 * (measured on one-way loops, see the traffic tests). It is capped and not charged per corner - the deficit belongs to
 * the corner the bodies are in - so a long run of corners between two vehicles cannot make a follower stop behind a
 * leader that is physically far away (two vehicles in a small loop would block each other).
 */
const CORNER_EXTRA = 0.1;

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
 * Is the vehicle one whose body swings wide of its lane when it turns (longer than a cell) and does its route turn
 * at route node i? Such a vehicle takes the lock of the cell it turns in: the rear of a rigid body sweeps into the
 * opposite lane there, beyond what the lane separation of a two-way road leaves free.
 */
function swingsAt(sys, tv, i) {
  return tv.length > sys.swingLength && i >= 1 && sys.geo.isCorner(edgeAhead(tv, i - 1), edgeAhead(tv, i));
}

/**
 * Does the vehicle need the lock of `node` (route node i, `isFinal` = the last one) before it may enter? Controlled
 * cells always do. Any other cell does while somebody else holds it (a vehicle parked on a bend), a final node on a
 * bend does so that the parked vehicle cannot be hit by traffic turning through the same small cell, and so does a
 * bend in which the vehicle swings (see swingsAt).
 */
export function needsLock(sys, tv, node, i, isFinal) {
  const holder = sys._lock[node];
  if (sys.graph.controlled[node] === 1 || holder !== null) return holder !== tv;
  return sys._bend[node] === 1 && (isFinal || swingsAt(sys, tv, i));
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
 * Another vehicle in the way of a long vehicle that turns in the cell `node`: its body sweeps round the corner (rear
 * on the road it comes from, nose on the road it leaves by), reaching up to half a cell plus half its length from the
 * centre of the cell. Vehicles waiting for the lock stand outside this distance (see TrafficSystem._standoff).
 */
function swingOccupant(sys, tv, node) {
  const gx = sys.graph.x(node);
  const gy = sys.graph.y(node);
  const clearance = Math.min(SWING_CLEARANCE, sys.headway / 2);
  for (const o of sys.vehicles) {
    if (o === tv || !o.onRoad) continue;
    const reach = sys.r + (tv.length + o.length) / 2 + clearance;
    const dx = o.x - gx;
    const dy = o.y - gy;
    if (dx * dx + dy * dy < reach * reach) return o;
  }
  return null;
}

/**
 * A long vehicle that already holds the lock of the cell it turns in next (it took it with an earlier request, or
 * with the nose of its previous stop) must still not swing into another vehicle: if one is in the way, the vehicle
 * stops at the stop line of that cell (tv._swingNode) and waits for it (tv._gate).
 */
function checkHeldSwing(sys, tv, q, dReq) {
  const half = tv.length / 2;
  for (let i = tv._ri + 1; i < tv._route.length; i++) {
    if (i * sys.L - sys.r - half - sys.standoff - q > dReq) return;
    const node = tv._nodes[i];
    if (sys._lock[node] !== tv || !swingsAt(sys, tv, i)) continue;
    const occupant = swingOccupant(sys, tv, node);
    if (occupant !== null) {
      tv._swingNode = node;
      tv._gate = occupant;
    }
    return;
  }
}

/**
 * A long vehicle that turns on the spot (the dead-end U-turn, or easing onto its lane line) sweeps a disk that
 * reaches into every cell next to its node, and ends up with its body along another road than the one it parked on.
 * Before it starts it therefore needs the locks of all junctions and bends around the node (the request is granted
 * by grantLocks like any other; tv._req >= 0 until then). Cells on the route are held until the rear has passed
 * them, the others are let go as soon as the vehicle moves.
 */
export function evaluateSpin(sys, tv) {
  if (tv.length / 2 <= sys.r) { // the body stays within its own cell
    cancelRequest(sys, tv);
    return;
  }
  const wanted = [];
  for (const m of sys._neighbours(tv._nodes[tv._ri])) if (sys._lockable[m] === 1 && sys._lock[m] !== tv) wanted.push(m);
  if (wanted.length === 0) {
    cancelRequest(sys, tv);
    return;
  }
  if (tv._req !== wanted[0]) {
    cancelRequest(sys, tv);
    tv._req = wanted[0];
    sys._pending.push(tv);
  }
  tv._chainN.length = 0;
  tv._chainQ.length = 0;
  let gate = null;
  for (const m of wanted) {
    tv._chainN.push(m);
    tv._chainQ.push(m === tv._nodes[tv._ri + 1] ? (tv._ri + 1) * sys.L + sys.r : tv._ri * sys.L - sys.r);
    const holder = sys._lock[m];
    if (gate === null && holder !== null) gate = holder;
  }
  tv._gate = gate;
  tv._elig = gate === null;
}

/**
 * Centre coordinate of the stop line in front of route node i: the front bumper stays `sys.standoff` before the cell
 * boundary (one headway to whatever is inside the cell, plus the reach of the nose of the longest vehicle that swings
 * round the cell), never behind the vehicle itself.
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
 * Index (> route length) of the first cell beyond the end of the route that can be locked (a junction or a bend) and
 * that the vehicle's nose reaches into once it rests on its final node, and whose lock it does not hold; -1 if none.
 * Only vehicles longer than one cell have such cells.
 */
export function firstExtensionCell(sys, tv) {
  if (tv._ext.length === 0 || tv.length / 2 <= sys.r) return -1; // the nose stays within its own cell
  const n = tv._route.length;
  const finalQ = n * sys.L;
  for (let k = n + 1; k <= n + tv._ext.length; k++) {
    if (k * sys.L - sys.r - tv.length / 2 >= finalQ - EPS) return -1;
    const nd = nodeAhead(sys, tv, k);
    if (sys._lockable[nd] === 1 && sys._lock[nd] !== tv) return k;
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
 * Sets tv._ldRaw (rear coordinate of the obstacle on the route, Infinity if none), tv._ldQ (the same, shortened by the
 * corners in between: the gap to keep along the real path), tv._ldTv, tv._ldV and tv._ldDec.
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
  tv._ldRaw = tv._ldQ;
  if (x !== null) tv._ldQ -= gapAllowance(sys, tv, x);
}

/**
 * How far a body lags behind its route coordinate while its centre is in the corner zone of its own route
 * (0 on straights): the part of Geometry.compression the centre has passed. A vehicle that has already turned off
 * onto another branch than the one the observer takes lags by its own corner.
 */
function centreLag(sys, x) {
  const { L, r, geo } = sys;
  if (!x.driving || x._route === null || x._turn >= 0) return 0;
  const i = x.s >= r ? x._ri + 1 : x._ri;
  const prev = i > 0 ? edgeAhead(x, i - 1) : x._prev;
  const next = edgeAhead(x, i);
  if (!geo.isCorner(prev, next)) return 0;
  return (geo.compression(prev, next) * Math.min(2 * r, Math.max(0, x._ri * L + x.s - (i * L - r)))) / (2 * r);
}

/**
 * Extra gap the follower `tv` keeps behind its leader `x` for the corners in between. A body sits where its centre
 * is, so the corners between the two centres count, along the follower's route and, for the corner the leader is in
 * right now, along the leader's own.
 */
function gapAllowance(sys, tv, x) {
  const own = pathCompression(sys, tv, tv._ri * sys.L + tv.s, tv._ldQ + x.length / 2);
  const lag = centreLag(sys, x);
  const total = lag > own ? Math.max(own, lag - centreLag(sys, tv)) : own;
  return total + Math.min(total, CORNER_EXTRA);
}

/** Leader scan only (no lock request): for a vehicle that manoeuvres in place and needs to know what is ahead of it. */
export function scanAhead(sys, tv, dLimit) {
  scanLeader(sys, tv, dLimit);
}

/**
 * Shortening of the path caused by the corners (see Geometry.compression) of the follower's route between route
 * coordinates a and b: the gap along the road between two bodies is shorter than the difference of their coordinates.
 */
function pathCompression(sys, tv, a, b) {
  const { L, r, geo } = sys;
  let total = 0;
  for (let i = tv._ri; i * L - r < b; i++) {
    const lo = Math.max(a, i * L - r);
    const hi = Math.min(b, i * L + r);
    if (hi <= lo) continue;
    const prev = i > 0 ? edgeAhead(tv, i - 1) : -1;
    const next = edgeAhead(tv, i);
    if (geo.isCorner(prev, next)) total += (geo.compression(prev, next) * (hi - lo)) / (2 * r);
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
 * needs to see the room beyond the exit). The target is the first cell on the route that needs a lock the vehicle
 * does not hold, once its stop line is within `dReq`. Besides the cell itself the request covers every further cell
 * that can be locked (junctions and bends) which the vehicle could still be waiting in front of while its rear is
 * inside the last cell of the request: a vehicle never holds a cell while it waits for another one (no
 * hold-and-wait), so two vehicles can never each hold half of a row of adjacent cells, and nobody can dock in a bend
 * the vehicle is about to cross. The request is eligible only if
 *   * no foreign lock lies in the chain and no vehicle docked in, or committed to, a bend where the vehicle will stop,
 *   * no vehicle is within the swing of a long vehicle that turns in one of the cells (see swingOccupant), and
 *   * nothing stands in the room beyond the exit of the LAST cell that the vehicle needs to come to rest
 *     (length + headway): no box-blocking.
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
    if ((lockable[node] === 1 || sys._lock[node] !== null) && needsLock(sys, tv, node, i, i === n)) { target = i; break; }
  }
  if (target < 0) {
    const k = firstExtensionCell(sys, tv);
    if (k >= 0 && stopLineQ(sys, tv, k, q) - q <= dReq) target = k;
  }
  tv._swingNode = -1;
  if (target < 0) {
    scanLeader(sys, tv, dShort);
    if (tv._req >= 0) cancelRequest(sys, tv);
    if (tv.length > sys.swingLength) checkHeldSwing(sys, tv, q, dReq);
    return;
  }
  const node = nodeAhead(sys, tv, target);
  if (tv._req !== node) {
    cancelRequest(sys, tv);
    tv._req = node;
    sys._pending.push(tv);
  }
  tv._chainN.length = 0;
  tv._chainQ.length = 0;
  let lastExit = target * L + r;
  let gate = null;
  for (let k = target; ; k++) {
    const lineQ = k * L - r - half - sys.standoff;
    if (k > target && (lineQ - half >= lastExit - EPS || (k > n && k * L - r >= n * L + half - EPS))) break; // or beyond the nose at rest
    const nd = nodeAhead(sys, tv, k);
    if (nd < 0) break;
    if (k !== target && sys._lockable[nd] !== 1) continue; // plain road cannot be locked
    const holder = sys._lock[nd];
    tv._chainN.push(nd);
    tv._chainQ.push(k * L + r);
    lastExit = k * L + r;
    if (gate === null && holder !== null && holder !== tv) gate = holder;
    if (gate === null && k >= n && sys._bend[nd] === 1 && graph.controlled[nd] !== 1) gate = cellOccupant(sys, tv, nd, k > 0 ? edgeAhead(tv, k - 1) : -1);
    if (gate === null && swingsAt(sys, tv, k)) gate = swingOccupant(sys, tv, nd);
  }
  const zoneEnd = Math.min(lastExit + tv.length, n * L + half);
  scanLeader(sys, tv, Math.max(dShort, zoneEnd + headway - (q + half) + 1)); // must see the room beyond the exit
  if (gate === null && roomBeyond(sys, tv, lastExit) < zoneEnd + headway - EPS) gate = tv._ldTv;
  tv._gate = gate;
  tv._elig = gate === null;
}

/**
 * Route coordinate of the nearest obstacle ahead as far as the room beyond route coordinate `exitQ` is concerned: the
 * corners between the exit and the obstacle count (the follower comes to rest earlier), those before it do not. The
 * measure must not depend on where the vehicle turns inside the cells it is about to take, or two requests for the
 * same cell and the same exit would not be equally eligible and the younger could overtake the older.
 */
function roomBeyond(sys, tv, exitQ) {
  if (tv._ldRaw === Infinity) return Infinity;
  const total = pathCompression(sys, tv, exitQ, tv._ldRaw);
  return tv._ldRaw - total - Math.min(total, CORNER_EXTRA);
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
      const at = tv._held.indexOf(chain[c]);
      if (at < 0) {
        tv._held.push(chain[c]);
        tv._heldQ.push(tv._chainQ[c]);
      } else if (tv._chainQ[c] > tv._heldQ[at]) {
        tv._heldQ[at] = tv._chainQ[c]; // the route visits a cell the vehicle already holds again: keep it until then
      }
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
