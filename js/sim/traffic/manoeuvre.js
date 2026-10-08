// In-place manoeuvres of the traffic engine: the U-turn at a dead end and the ease onto the lane line when a route
// starts from the centre line or from the lane of another road. A vehicle at rest turns / shifts on the spot, so
// its body sweeps an area that the lane logic knows nothing about (lanes only guard the road ahead and behind).
// The manoeuvre therefore only advances while that area is free:
//   * the final pose keeps the headway to whatever is ahead on the new route (the leader scan of the tick), and
//   * the swept bodies stay clear of every other vehicle's body - for vehicles that move, of the stretch of road
//     they can cover before the manoeuvre is over, but never farther than their own free road ahead.
// A vehicle that has to wait is "waiting" for the vehicle that is in its way (docs/ARCHITECTURE.md §5.2, req. 5).

const EPS = 1e-9;
const CLEARANCE = 0.1; // m of free space that must remain between the swept body and any other body
const SAMPLES = 12; // poses checked over a complete manoeuvre (a corner of the body moves at most ~0.2 m between two)
const MAX_HORIZON = 10; // s: longest manoeuvre time looked ahead (a manoeuvre at a crawl would otherwise see forever)

// scratch space (the engine is single-threaded and this runs once per manoeuvring vehicle and tick)
const POSES = new Float64Array(3 * (SAMPLES + 1));
const MINE = new Float64Array(8);
const THEIRS = new Float64Array(8);
const POSE = { x: 0, y: 0, h: 0 };

/** Progress per second of a manoeuvre (U-turn: 0.5 x the speed limit along the half circle; ease: same speed). */
export function turnRate(sys, tv) {
  const length = tv._prev >= 0 && sys.geo.isReversal(tv._prev, tv.edge)
    ? sys.geo.turnCurve(tv._prev, tv.edge)[8]
    : sys.geo.easeLength(tv._x0, tv._y0, tv._h0, tv.edge);
  const speed = Math.max(1e-3, 0.5 * tv.vmax * sys.speedFactor * sys.graph.edges[tv.edge].limit);
  return speed / length;
}

/** Pose {x, y, h} of a vehicle in the middle of a manoeuvre at progress u (0 = where it stands, 1 = on the lane line). */
export function manoeuvrePose(sys, tv, out, u) {
  if (tv._prev >= 0 && sys.geo.isReversal(tv._prev, tv.edge)) sys.geo.turnPose(out, tv._prev, tv.edge, u);
  else sys.geo.easePose(out, tv._x0, tv._y0, tv._h0, tv.edge, u);
}

/** Corners of a rectangle centred on (x, y) with heading h that reaches `back` behind and `front` ahead of the centre. */
function corners(out, x, y, h, back, front, halfWidth) {
  const c = Math.cos(h);
  const s = Math.sin(h);
  out[0] = x + c * front - s * halfWidth; out[1] = y + s * front + c * halfWidth;
  out[2] = x + c * front + s * halfWidth; out[3] = y + s * front - c * halfWidth;
  out[4] = x - c * back + s * halfWidth; out[5] = y - s * back - c * halfWidth;
  out[6] = x - c * back - s * halfWidth; out[7] = y - s * back + c * halfWidth;
}

/** Largest gap on a separating axis of two rectangles (flat corner arrays): > 0 apart, < 0 overlapping. */
function separation(pa, pb) {
  let best = -Infinity;
  for (let side = 0; side < 2; side++) {
    const poly = side === 0 ? pa : pb;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const nx = poly[2 * i + 1] - poly[2 * j + 1];
      const ny = poly[2 * j] - poly[2 * i];
      const norm = Math.hypot(nx, ny);
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (let k = 0; k < 4; k++) {
        const a = (pa[2 * k] * nx + pa[2 * k + 1] * ny) / norm;
        const b = (pb[2 * k] * nx + pb[2 * k + 1] * ny) / norm;
        if (a < minA) minA = a;
        if (a > maxA) maxA = a;
        if (b < minB) minB = b;
        if (b > maxB) maxB = b;
      }
      best = Math.max(best, minB - maxA, minA - maxB);
    }
  }
  return best;
}

/**
 * Road a moving vehicle can still cover within `horizon` seconds: its speed and acceleration, but not beyond the
 * obstacle its own leader scan found this tick (it has to stop behind that one, whatever happens here).
 */
function reachOf(sys, o, horizon) {
  if (!o.driving || o.disabled || o._turn >= 0) return 0;
  const free = o._ldQ === Infinity ? Infinity : Math.max(0, o._ldQ - (o._ri * sys.L + o.s + o.length / 2) - sys.headway);
  const cap = o.vmax * sys.speedFactor * horizon;
  const push = o.waiting ? 0 : 0.5 * o.accel * horizon * horizon;
  return Math.min(free, cap, o.v * horizon + push);
}

/**
 * The vehicle that keeps the manoeuvre of `tv` from advancing this tick, or null if it may go on. Needs the leader
 * scan of the tick (tv._ldQ) and runs in the planning phase, so it reads only the start-of-tick state of everybody.
 * @param {number} dt tick length in s
 */
export function manoeuvreBlocker(sys, tv, dt) {
  const half = tv.length / 2;
  if (tv._ldTv !== null && tv._ldQ - (tv._ri * sys.L + tv.s + half) < sys.headway - EPS) return tv._ldTv;

  const horizon = Math.min(MAX_HORIZON, (1 - tv._turn) / turnRate(sys, tv)) + dt;
  const halfWidth = tv.width / 2;
  // nobody beyond this distance (centre to centre) can be touched: the farthest the body gets from where it stands
  // (its centre moves along the manoeuvre, its corners swing round it), the other body, and how far that one can drive
  const sweep = manoeuvreLength(sys, tv) + Math.hypot(half, halfWidth) + CLEARANCE;
  const farReach = sys._maxSpeed * sys.speedFactor * horizon;
  let posed = false;
  for (const o of sys.vehicles) {
    if (o === tv || !o.onRoad) continue;
    const dx = o.x - tv.x;
    const dy = o.y - tv.y;
    const far = sweep + (o.length + o.width) / 2 + farReach;
    if (dx * dx + dy * dy > far * far) continue;
    const reach = reachOf(sys, o, horizon);
    const near = sweep + Math.hypot(o.length / 2, o.width / 2) + reach;
    if (dx * dx + dy * dy > near * near) continue;
    if (!posed) {
      samplePoses(sys, tv);
      posed = true;
    }
    corners(THEIRS, o.x, o.y, o.heading, o.length / 2, o.length / 2 + reach, o.width / 2);
    for (let k = 0; k < POSES.length; k += 3) {
      corners(MINE, POSES[k], POSES[k + 1], POSES[k + 2], half, half, halfWidth);
      if (separation(MINE, THEIRS) < CLEARANCE) return o;
    }
  }
  return null;
}

/** Upper bound of the distance the centre of the vehicle moves from where it stands during the manoeuvre. */
function manoeuvreLength(sys, tv) {
  if (tv._prev >= 0 && sys.geo.isReversal(tv._prev, tv.edge)) return sys.geo.turnCurve(tv._prev, tv.edge)[8];
  return Math.hypot(sys.geo.ax[tv.edge] - tv._x0, sys.geo.ay[tv.edge] - tv._y0);
}

/** Poses of the vehicle over the rest of its manoeuvre, into POSES. */
function samplePoses(sys, tv) {
  for (let k = 0; k <= SAMPLES; k++) {
    manoeuvrePose(sys, tv, POSE, tv._turn + ((1 - tv._turn) * k) / SAMPLES);
    POSES[3 * k] = POSE.x;
    POSES[3 * k + 1] = POSE.y;
    POSES[3 * k + 2] = POSE.h;
  }
}
