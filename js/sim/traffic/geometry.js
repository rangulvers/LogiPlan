// Vehicle path geometry for the traffic engine: lane lines, smooth corner / lane-change curves and the
// dead-end U-turn. Pure and DOM-free. See docs/ARCHITECTURE.md §5.2 (requirement 3: lanes and continuity).
//
// A vehicle's position is kept as a 1-D coordinate s along its current edge (edge length = cellSize); this
// module turns (edge, s, previous edge, next edge) into a world pose {x, y, h}.
//
//  * Lane line: edges that have an opposite edge are offset to the right (or left) of the centreline by
//    LANE_OFFSET * cellSize; one-way edges ride the centreline.
//  * Transition curves occupy the half-cells around a node (the last half of the arriving edge and the first half
//    of the leaving edge) and are cubic Beziers parameterised linearly in s, so poses are C1-continuous:
//      - perpendicular turn: the exact quadratic corner between the two lane lines (elevated to a cubic);
//      - same direction, different lane offset (one-way <-> two-way): an S-curve.
//  * A vehicle that starts from rest in another pose than its lane line (parked on the centre line, or in the lane
//    of a different road) first eases into place without moving along the road: `easePose` blends position and
//    heading, the traffic engine decides how long that takes.
//  * U-turn at a dead end: a half-circle-like cubic from the end of the arriving lane to the start of the
//    opposite lane, traversed in time by the traffic engine (the vehicle itself is at rest, v = 0).

import { DX, DY } from '../../util/grid.js';

/** Lateral lane offset as a fraction of the cell size (spec: about 0.22 * cellSize). */
export const LANE_OFFSET = 0.22;

const TWO_THIRDS = 2 / 3;

/** Evaluate a cubic Bezier (flat array [x0,y0,x1,y1,x2,y2,x3,y3]) into out.{x,y,h}. */
function evalCubic(c, t, out, fallbackHeading) {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  out.x = b0 * c[0] + b1 * c[2] + b2 * c[4] + b3 * c[6];
  out.y = b0 * c[1] + b1 * c[3] + b2 * c[5] + b3 * c[7];
  const d0 = 3 * u * u;
  const d1 = 6 * u * t;
  const d2 = 3 * t * t;
  const tx = d0 * (c[2] - c[0]) + d1 * (c[4] - c[2]) + d2 * (c[6] - c[4]);
  const ty = d0 * (c[3] - c[1]) + d1 * (c[5] - c[3]) + d2 * (c[7] - c[5]);
  out.h = tx * tx + ty * ty > 1e-18 ? Math.atan2(ty, tx) : fallbackHeading;
}

/** Arc length of a cubic Bezier (flat array) by polyline approximation. */
function cubicLength(c) {
  const tmp = { x: 0, y: 0, h: 0 };
  let len = 0;
  let px = c[0];
  let py = c[1];
  for (let i = 1; i <= 24; i++) {
    evalCubic(c, i / 24, tmp, 0);
    len += Math.hypot(tmp.x - px, tmp.y - py);
    px = tmp.x;
    py = tmp.y;
  }
  return len;
}

/** Signed shortest rotation from angle a to angle b. */
function angleDiff(a, b) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export class Geometry {
  /**
   * @param {object} graph road graph (js/sim/graph.js)
   * @param {'right'|'left'} handedness which side of a two-way road vehicles use
   */
  constructor(graph, handedness = 'right') {
    const { edges, cellSize } = graph;
    this.graph = graph;
    this.L = cellSize;
    this.r = cellSize / 2;
    this.side = handedness === 'left' ? -1 : 1;
    const n = edges.length;
    this.ax = new Float64Array(n); // lane line start (tail node centre + lateral offset)
    this.ay = new Float64Array(n);
    this.ux = new Float64Array(n); // unit direction
    this.uy = new Float64Array(n);
    this.laneOffsetAbs = LANE_OFFSET * cellSize; // distance of a two-way lane line from the centreline
    this.heading = new Float64Array(n);
    this.offset = new Float64Array(n); // signed lateral offset (0 on one-way edges)
    for (const e of edges) {
      const ux = DX[e.dir];
      const uy = DY[e.dir];
      const off = e.rev >= 0 ? this.side * LANE_OFFSET * cellSize : 0;
      this.ux[e.id] = ux;
      this.uy[e.id] = uy;
      this.offset[e.id] = off;
      this.ax[e.id] = graph.x(e.from) - uy * off; // right-hand normal of (ux, uy) is (-uy, ux)
      this.ay[e.id] = graph.y(e.from) + ux * off;
      this.heading[e.id] = Math.atan2(uy, ux);
    }
    this._full = new Map();
    this._turn = new Map();
    this._compression = new Map();
  }

  /** Point on the lane line of edge e at distance s from its tail, written to out.{x,y}. */
  lanePoint(e, s, out) {
    out.x = this.ax[e] + this.ux[e] * s;
    out.y = this.ay[e] + this.uy[e] * s;
  }

  /** Pose of a vehicle parked at the head of `lastEdge` (lane offset kept) or on the node centre (lastEdge -1). */
  parkedPose(out, lastEdge, node, heading) {
    if (lastEdge >= 0) {
      this.lanePoint(lastEdge, this.L, out);
      out.h = this.heading[lastEdge];
    } else {
      out.x = this.graph.x(node);
      out.y = this.graph.y(node);
      out.h = heading;
    }
  }

  /** Is the move p -> a a perpendicular turn / lane change (true) or a plain straight continuation (false)? */
  _sameLane(p, a) {
    const e = this.graph.edges;
    return e[p].dir === e[a].dir && Math.abs(this.offset[p] - this.offset[a]) < 1e-9;
  }

  /** Transition curve through the node between edges p and a (null when straight, or a reversal). */
  fullCurve(p, a) {
    const key = p * this.graph.edges.length + a;
    let c = this._full.get(key);
    if (c !== undefined) return c;
    c = this._buildFull(p, a);
    this._full.set(key, c);
    return c;
  }

  _buildFull(p, a) {
    const edges = this.graph.edges;
    const turn = (edges[a].dir - edges[p].dir) & 3;
    if (turn === 2 || this._sameLane(p, a)) return null;
    const A = {};
    const B = {};
    this.lanePoint(p, this.L - this.r, A);
    this.lanePoint(a, this.r, B);
    if (turn === 0) { // S-curve between two parallel lane lines
      const k = TWO_THIRDS * this.r;
      return [A.x, A.y, A.x + this.ux[p] * k, A.y + this.uy[p] * k, B.x - this.ux[a] * k, B.y - this.uy[a] * k, B.x, B.y];
    }
    const horizontal = this.ux[p] !== 0; // corner = intersection of the two lane lines
    const cx = horizontal ? B.x : A.x;
    const cy = horizontal ? A.y : B.y;
    return [A.x, A.y, A.x + (cx - A.x) * TWO_THIRDS, A.y + (cy - A.y) * TWO_THIRDS,
      B.x + (cx - B.x) * TWO_THIRDS, B.y + (cy - B.y) * TWO_THIRDS, B.x, B.y];
  }

  /**
   * How much shorter the path through the node between edges p and a is than the abstract 2 * r it stands for
   * (tight inner corners; 0 for straight passes and outer corners). Followers add it to their gap so that the
   * bumper-to-bumper distance along the real path, not along the abstract coordinate, stays above the headway.
   */
  compression(p, a) {
    const c = this.fullCurve(p, a);
    if (c === null) return 0;
    const key = p * this.graph.edges.length + a;
    let value = this._compression.get(key);
    if (value === undefined) {
      value = Math.max(0, 2 * this.r - cubicLength(c));
      this._compression.set(key, value);
    }
    return value;
  }

  /** U-turn curve from the end of lane p to the start of lane a (a = reverse of p). Element 8 = arc length. */
  turnCurve(p, a) {
    const key = p * this.graph.edges.length + a;
    let c = this._turn.get(key);
    if (c !== undefined) return c;
    const P0 = {};
    const P3 = {};
    this.lanePoint(p, this.L, P0);
    this.lanePoint(a, 0, P3);
    const k = TWO_THIRDS * Math.hypot(P3.x - P0.x, P3.y - P0.y);
    c = [P0.x, P0.y, P0.x + this.ux[p] * k, P0.y + this.uy[p] * k, P3.x + this.ux[p] * k, P3.y + this.uy[p] * k, P3.x, P3.y, 0];
    c[8] = cubicLength(c);
    this._turn.set(key, c);
    return c;
  }

  /**
   * Pose of a vehicle that eases from the standstill pose (x0, y0, h0) onto the start of lane `a` (and its heading)
   * without moving along the road, at progress u in [0, 1].
   */
  easePose(out, x0, y0, h0, a, u) {
    out.x = x0 + (this.ax[a] - x0) * u;
    out.y = y0 + (this.ay[a] - y0) * u;
    out.h = h0 + angleDiff(h0, this.heading[a]) * u;
  }

  /** Length of that manoeuvre: the shift of the position, or the swing of the heading at a 0.5 m radius. */
  easeLength(x0, y0, h0, a) {
    return Math.max(Math.hypot(this.ax[a] - x0, this.ay[a] - y0), 0.5 * Math.abs(angleDiff(h0, this.heading[a])));
  }

  /** Pose during a dead-end U-turn at progress u in [0, 1]. */
  turnPose(out, p, a, u) {
    evalCubic(this.turnCurve(p, a), Math.min(1, Math.max(0, u)), out, this.heading[p]);
  }

  /**
   * Pose of a vehicle driving on edge `a` at distance s from its tail, on the lane line or on the corner / lane-change
   * curve through the node it has just passed (previous edge p) or is about to pass (next route edge n).
   * @param {object} out receives {x, y, h}
   * @param {number} a current edge     @param {number} s distance from the tail, 0..L
   * @param {number} p previous edge (-1 if none)     @param {number} n next route edge (-1 if none)
   */
  pose(out, a, s, p, n) {
    const { L, r } = this;
    if (s < r && p >= 0) {
      const c = this.fullCurve(p, a);
      if (c !== null) { evalCubic(c, 0.5 + 0.5 * s / r, out, this.heading[a]); return; }
    } else if (s > L - r && n >= 0) {
      const c = this.fullCurve(a, n);
      if (c !== null) { evalCubic(c, 0.5 * (s - (L - r)) / r, out, this.heading[a]); return; }
    }
    this.lanePoint(a, s, out);
    out.h = this.heading[a];
  }

  /** Does moving from edge p onto edge a bend the path (perpendicular turn)? Used for the 50 % corner speed. */
  isCorner(p, a) {
    return p >= 0 && a >= 0 && ((this.graph.edges[a].dir - this.graph.edges[p].dir) & 1) === 1;
  }

  /** Is a the exact reverse of p (dead-end U-turn)? */
  isReversal(p, a) {
    return p >= 0 && a >= 0 && this.graph.edges[p].rev === a;
  }
}
