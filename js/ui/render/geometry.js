// Pure geometry helpers of the plant renderer: angles, flow curves, resize handles, text fitting.
// No DOM and no canvas, so everything here is unit-tested in Node (tests/ui.geometry.test.js).

import { clamp } from '../../util/format.js';

const TAU = Math.PI * 2;

/** Wrap an angle (rad) into (-PI, PI]. Non-finite input gives 0. */
export function wrapAngle(a) {
  if (!Number.isFinite(a)) return 0;
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/** Interpolate between two headings along the shortest arc (t = 0 gives `a`, t = 1 gives `b`). */
export function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

/**
 * Shorten `text` with an ellipsis so that measure(text) <= maxWidth. Returns the text unchanged when it
 * fits and '' when not even the ellipsis fits.
 * @param {(s: string) => number} measure width of a string in px
 */
export function fitText(measure, text, maxWidth) {
  if (!text || !(maxWidth > 0)) return '';
  if (measure(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid).trimEnd() + '…') <= maxWidth) lo = mid; else hi = mid - 1;
  }
  const out = text.slice(0, lo).trimEnd() + '…';
  return lo === 0 && measure(out) > maxWidth ? '' : out;
}

// ---- flow curves -------------------------------------------------------------------------------------

/** Point on the quadratic Bezier of curve `c` (fields ax, ay, qx, qy, bx, by) at parameter t. */
export function quadPoint(c, t, out = [0, 0]) {
  const s = 1 - t;
  out[0] = s * s * c.ax + 2 * s * t * c.qx + t * t * c.bx;
  out[1] = s * s * c.ay + 2 * s * t * c.qy + t * t * c.by;
  return out;
}

/** Direction (rad) of the curve tangent at t. */
export function quadAngle(c, t) {
  const s = 1 - t;
  const dx = 2 * s * (c.qx - c.ax) + 2 * t * (c.bx - c.qx);
  const dy = 2 * s * (c.qy - c.ay) + 2 * t * (c.by - c.qy);
  return Math.atan2(dy, dx);
}

/** Speed |B'(t)| of the parametrisation: metres of curve per unit of t. */
export function quadSpeed(c, t) {
  const s = 1 - t;
  return 2 * Math.hypot(s * (c.qx - c.ax) + t * (c.bx - c.qx), s * (c.qy - c.ay) + t * (c.by - c.qy));
}

const insideRect = (x, y, r, gap) => x > r.x - gap && x < r.x + r.w + gap && y > r.y - gap && y < r.y + r.h + gap;

/** Bisect for the parameter where `inside(t)` flips, given inside(lo) !== inside(hi). */
function bisect(inside, lo, hi) {
  const flipped = inside(hi);
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid) === flipped) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

const SCAN = 64;
/** Arrows shorter than this (metres of visible curve) are drawn as a marker badge instead. */
const MIN_ARROW_M = 0.25;
/** Half length (metres) of the short curve piece that stands for a marker, used for picking. */
const MARKER_HALF_M = 0.15;

/** Length of the visible part (t0..t1) of curve `c`, by 16 chords. */
function visibleLength(c) {
  let len = 0;
  let prevX = 0;
  let prevY = 0;
  const p = [0, 0];
  for (let k = 0; k <= 16; k++) {
    quadPoint(c, c.t0 + ((c.t1 - c.t0) * k) / 16, p);
    if (k > 0) len += Math.hypot(p[0] - prevX, p[1] - prevY);
    prevX = p[0];
    prevY = p[1];
  }
  return len;
}

/**
 * Curved arrow geometry from rectangle `a` to rectangle `b` (both {x, y, w, h} in metres): a quadratic
 * Bezier between the rectangle centres, bowed to the right of the travel direction so that A->B and B->A
 * run on opposite sides and never overlap. Only the part between the two rectangle borders is visible
 * (`t0..t1`); `gapA` / `gapB` keep a little air between the arrow and the bricks.
 *
 * When the bricks touch or are closer than ~0.25 m there is no room for an arrow. The flow is then a
 * `marker`: t0..t1 is a short piece (about 0.3 m) of the curve centred on the gap between the two borders,
 * which the renderer draws as a small direction badge on top of the bricks. A valid flow is never dropped.
 * @returns {{ ax, ay, qx, qy, bx, by, t0, t1, length, marker } | null} null only when the rectangles coincide
 *   or one swallows the other's centre line (stations never overlap in a valid layout)
 */
export function flowCurve(a, b, gapA = 0.1, gapB = 0.18) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return null;
  const bow = 2 * clamp(len * 0.07, 0.3, 2);
  const c = { ax, ay, qx: (ax + bx) / 2 - (dy / len) * bow, qy: (ay + by) / 2 + (dx / len) * bow, bx, by, t0: 0, t1: 1, length: 0, marker: false };
  const insideA = (t) => { const p = quadPoint(c, t); return insideRect(p[0], p[1], a, gapA); };
  const insideB = (t) => { const p = quadPoint(c, t); return insideRect(p[0], p[1], b, gapB); };
  let i = 0;
  while (i <= SCAN && insideA(i / SCAN)) i++;
  let j = SCAN;
  while (j >= 0 && insideB(j / SCAN)) j--;
  if (i > SCAN || j < 0) return null;
  const exit = i === 0 ? 0 : bisect(insideA, (i - 1) / SCAN, i / SCAN);
  const entry = j === SCAN ? 1 : bisect(insideB, j / SCAN, (j + 1) / SCAN);
  if (entry > exit) {
    c.t0 = exit;
    c.t1 = entry;
    c.length = visibleLength(c);
    if (c.length >= MIN_ARROW_M) return c;
  }
  const tm = clamp((exit + entry) / 2, 0, 1);
  const half = clamp(MARKER_HALF_M / Math.max(quadSpeed(c, tm), 1e-6), 0, Math.min(tm, 1 - tm));
  c.t0 = tm - half;
  c.t1 = tm + half;
  c.length = visibleLength(c);
  c.marker = true;
  return c;
}

/** Shortest distance from (px, py) to the visible part (t0..t1) of a flow curve, same units as the curve. */
export function distToCurve(c, px, py, steps = 24) {
  let best = Infinity;
  const p = [0, 0];
  quadPoint(c, c.t0, p);
  let x0 = p[0];
  let y0 = p[1];
  for (let i = 1; i <= steps; i++) {
    quadPoint(c, c.t0 + ((c.t1 - c.t0) * i) / steps, p);
    const x1 = p[0];
    const y1 = p[1];
    const vx = x1 - x0;
    const vy = y1 - y0;
    const l2 = vx * vx + vy * vy;
    const u = l2 > 0 ? clamp(((px - x0) * vx + (py - y0) * vy) / l2, 0, 1) : 0;
    const d = Math.hypot(px - (x0 + vx * u), py - (y0 + vy * u));
    if (d < best) best = d;
    x0 = x1;
    y0 = y1;
  }
  return best;
}

// ---- resize handles -------------------------------------------------------------------------------------

/** The eight resize handles, clockwise from the top-left corner. */
export const HANDLE_NAMES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

const HANDLE_FRAC = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

/** Position of a handle on the rectangle (x, y, w, h). */
export function handlePoint(name, x, y, w, h, out = [0, 0]) {
  const f = HANDLE_FRAC[name];
  out[0] = x + w * f[0];
  out[1] = y + h * f[1];
  return out;
}

/**
 * Which handle of rectangle (x, y, w, h) lies within `radius` of (px, py)? Corners win over edges; null if none.
 * @returns {string|null}
 */
export function hitHandle(x, y, w, h, px, py, radius) {
  let best = null;
  let bestD = radius;
  for (let i = 0; i < HANDLE_NAMES.length; i++) {
    const f = HANDLE_FRAC[HANDLE_NAMES[i]];
    const d = Math.max(Math.abs(px - (x + w * f[0])), Math.abs(py - (y + h * f[1])));
    if (d <= bestD) { best = HANDLE_NAMES[i]; bestD = d; }
  }
  return best;
}

/** Is (x, y) inside the half-open rectangle {x, y, w, h}? */
export const pointInRect = (x, y, r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

// ---- scale bar -----------------------------------------------------------------------------------------

const NICE_STEPS = [1, 2, 5];

/**
 * Pick a round length (1, 2, 5, 10, 20, 50 ... metres) whose on-screen length is the longest not exceeding
 * `maxPx`, for the scale bar. Returns { metres, px }; { metres: 0, px: 0 } when nothing sensible fits.
 */
export function niceScale(pxPerMetre, maxPx) {
  if (!(pxPerMetre > 0) || !(maxPx > 0)) return { metres: 0, px: 0 };
  const budget = maxPx / pxPerMetre;
  const decade = 10 ** Math.floor(Math.log10(budget));
  let best = 0;
  for (const d of [decade / 10, decade]) {
    for (const s of NICE_STEPS) if (s * d <= budget && s * d > best) best = s * d;
  }
  if (!(best > 0)) return { metres: 0, px: 0 };
  return { metres: best, px: best * pxPerMetre };
}
