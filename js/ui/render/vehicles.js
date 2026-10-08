// Vehicles: pose interpolation, body drawing and the screen-space badges (waiting clock, charging bolt,
// battery bar, id label). This is the hot path of the renderer (100+ vehicles at 60 fps), so the per-frame
// functions allocate nothing: poses go through a reusable typed buffer, colours come from caches and the
// vehicle matrix is set directly with setTransform instead of save/translate/rotate/restore.

import { lerpAngle } from './geometry.js';
import { TAU, roundRectPath, fontOf, haloText } from './draw.js';
import { drawBolt, drawClock } from './glyphs.js';
import { mix, shade, rgba } from '../theme.js';

const DEFAULT_COLOR = '#2d7ff9';
const MIN_LEN_PX = 9; // vehicles are never drawn shorter than this, so they stay visible when zoomed out
const BUF_STRIDE = 4; // x, y, heading, drawn
const MIN_LENGTH_M = 0.2;
const MAX_LENGTH_M = 40;
const MIN_WIDTH_M = 0.1;

const variants = new Map();

/** Cached variants of a fleet colour: translucent sheen for the top highlight and a darker outline colour. */
function variantOf(color) {
  let v = variants.get(color);
  if (!v) {
    v = { sheen: rgba(shade(color, 0.3), 0.6), lo: mix(color, '#000000', 0.3) };
    variants.set(color, v);
  }
  return v;
}

/**
 * Vehicle dimensions in metres written to `out` ({ length, width }) and returned. Lengths are kept in a
 * sane range (0.2 .. 40 m) and the width below one cell, so absurd data cannot blow up the drawing loops.
 */
export function vehicleSize(v, cs, out) {
  const tv = v.tv;
  const raw = tv && tv.length > 0 ? tv.length : v.fleet && v.fleet.length > 0 ? v.fleet.length : 1.2;
  const L = Math.min(MAX_LENGTH_M, Math.max(MIN_LENGTH_M, raw));
  const W = tv && tv.width > 0 ? tv.width : L * 0.55;
  out.length = L;
  out.width = Math.max(MIN_WIDTH_M, Math.min(W, cs * 0.9, L));
  return out;
}

/**
 * Pose of vehicle `v` interpolated between the previous and the current tick by `alpha` (0..1). Headings use
 * the shortest arc and a jump of more than `maxStep` metres (relocation, re-attach) is not interpolated.
 * Reads the VehicleRT mirrors (x, y, heading, prevX, ...) and falls back to the traffic vehicle `v.tv`.
 * Written with plain finite checks (`n - n === 0` is false for NaN, Infinity and undefined) so that the
 * number feedback of the hot loop stays clean and nothing is boxed.
 * @param {Float64Array} out receives x, y, heading at indices 0..2
 * @returns {boolean} false when the vehicle has no usable position
 */
export function vehiclePose(v, alpha, maxStep, out) {
  let x = v.x;
  let y = v.y;
  const tv = v.tv;
  if (!(x - x === 0 && y - y === 0)) {
    if (!tv) return false;
    x = tv.x;
    y = tv.y;
    if (!(x - x === 0 && y - y === 0)) return false;
  }
  let h = v.heading;
  if (!(h - h === 0)) h = tv && tv.heading - tv.heading === 0 ? tv.heading : 0;
  let px = v.prevX;
  let py = v.prevY;
  if (!(px - px === 0 && py - py === 0)) {
    px = tv ? tv.prevX : NaN;
    py = tv ? tv.prevY : NaN;
  }
  const a = alpha > 0 ? (alpha < 1 ? alpha : 1) : 0;
  if (px - px === 0 && py - py === 0 && Math.abs(x - px) <= maxStep && Math.abs(y - py) <= maxStep) {
    let ph = v.prevHeading;
    if (!(ph - ph === 0)) ph = h;
    out[0] = px + (x - px) * a;
    out[1] = py + (y - py) * a;
    out[2] = lerpAngle(ph, h, a);
  } else {
    out[0] = x;
    out[1] = y;
    out[2] = h;
  }
  return true;
}

/** Broken down, battery dead or otherwise disabled in traffic. */
function isBroken(v) {
  return v.state === 'broken' || v.state === 'dead' || (v.tv !== null && v.tv !== undefined && v.tv.disabled === true);
}

/** The frame's pose buffer, grown (once, when the fleet grows) to hold `n` vehicles. */
function poseBuffer(fr, n) {
  if (fr.poseBuf.length < n * BUF_STRIDE) fr.poseBuf = new Float64Array(n * BUF_STRIDE * 2);
  return fr.poseBuf;
}

/**
 * Draw every visible vehicle of `fr.sim` at the interpolated pose. The context transform is changed
 * (the caller restores it).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} fr frame: theme, zoom, dpr, tx, ty, ox, oy, cs, alpha, vis, showIds, idFont, selFleet, hoverVehicle, pose, size, poseBuf
 */
export function drawVehicles(ctx, fr) {
  const list = fr.sim && fr.sim.vehicles;
  const n = list ? list.length : 0;
  if (n === 0) return;
  const buf = poseBuffer(fr, n);
  const pose = fr.pose;
  const maxStep = fr.cs * 1.5;
  const vis = fr.vis;
  const margin = 3 * fr.cs;
  for (let i = 0; i < n; i++) {
    const v = list[i];
    const o = i * BUF_STRIDE;
    buf[o + 3] = 0;
    if (!v || v.visible === false || !vehiclePose(v, fr.alpha, maxStep, pose)) continue;
    if (pose[0] < vis.x0 - margin || pose[0] > vis.x1 + margin || pose[1] < vis.y0 - margin || pose[1] > vis.y1 + margin) continue;
    buf[o] = pose[0];
    buf[o + 1] = pose[1];
    buf[o + 2] = pose[2];
    buf[o + 3] = 1;
    drawBody(ctx, fr, v, pose[0], pose[1], pose[2]);
  }
  ctx.setTransform(fr.dpr, 0, 0, fr.dpr, 0, 0);
  for (let i = 0; i < n; i++) {
    const o = i * BUF_STRIDE;
    if (buf[o + 3] === 1) drawBadges(ctx, fr, list[i], fr.ox + buf[o] * fr.zoom, fr.oy + buf[o + 1] * fr.zoom);
  }
}

function drawBody(ctx, fr, v, x, y, heading) {
  const { theme, zoom, dpr } = fr;
  const vt = theme.vehicle;
  const size = vehicleSize(v, fr.cs, fr.size);
  const L = size.length;
  const W = size.width;
  const lenPx = L * zoom;
  const boost = lenPx < MIN_LEN_PX ? MIN_LEN_PX / lenPx : 1;
  const base = zoom * dpr;
  const sc = base * boost;
  const cos = Math.cos(heading) * sc;
  const sin = Math.sin(heading) * sc;
  ctx.setTransform(cos, sin, -sin, cos, fr.tx + base * x, fr.ty + base * y);
  const px = 1 / (zoom * boost); // metres per CSS pixel in the vehicle's local frame
  const effPx = lenPx * boost;
  const color = v.color || (v.fleet && v.fleet.color) || DEFAULT_COLOR;
  const col = variantOf(color);
  const r = Math.min(W * 0.3, L * 0.2);
  const broken = isBroken(v);
  const waiting = v.tv !== null && v.tv !== undefined && v.tv.waiting === true && !broken;

  if (effPx >= 40) drawWheels(ctx, vt, L, W);
  ctx.beginPath();
  roundRectPath(ctx, -L / 2, -W / 2, L, W, r);
  ctx.fillStyle = color;
  ctx.fill();
  if (effPx >= 14) {
    ctx.beginPath();
    roundRectPath(ctx, -L / 2 + W * 0.1, -W / 2 + W * 0.1, L - W * 0.2, W * 0.34, r * 0.7);
    ctx.fillStyle = col.sheen;
    ctx.fill();
  }
  if (broken) drawHazard(ctx, vt, L, W, r);
  const loads = v.load ? v.load.length : 0;
  if (loads > 0 && effPx >= 12) drawLoad(ctx, vt, loads, L, W, px);
  drawFront(ctx, vt, L, W, effPx);
  ctx.beginPath();
  roundRectPath(ctx, -L / 2, -W / 2, L, W, r);
  ctx.lineWidth = (waiting ? 2.4 : 1) * px;
  ctx.strokeStyle = waiting ? vt.wait : col.lo;
  ctx.stroke();
  if (fr.selFleet === v.fleetId || fr.hoverVehicle === v.id) {
    const e = 3 * px;
    ctx.beginPath();
    roundRectPath(ctx, -L / 2 - e, -W / 2 - e, L + 2 * e, W + 2 * e, r + e);
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = theme.selection;
    ctx.stroke();
  }
}

function drawWheels(ctx, vt, L, W) {
  ctx.fillStyle = vt.wheel;
  ctx.beginPath();
  const wl = L * 0.2;
  const wh = W * 0.17;
  roundRectPath(ctx, -L * 0.3 - wl / 2, -W / 2 - wh * 0.45, wl, wh, wh / 3);
  roundRectPath(ctx, L * 0.3 - wl / 2, -W / 2 - wh * 0.45, wl, wh, wh / 3);
  roundRectPath(ctx, -L * 0.3 - wl / 2, W / 2 - wh * 0.55, wl, wh, wh / 3);
  roundRectPath(ctx, L * 0.3 - wl / 2, W / 2 - wh * 0.55, wl, wh, wh / 3);
  ctx.fill();
}

/** Windshield at the front (the heading cue); at tiny sizes an arrow-shaped notch instead. */
function drawFront(ctx, vt, L, W, effPx) {
  ctx.fillStyle = vt.windshield;
  ctx.beginPath();
  if (effPx < 18) {
    ctx.moveTo(L * 0.1, -W * 0.3);
    ctx.lineTo(L * 0.42, 0);
    ctx.lineTo(L * 0.1, W * 0.3);
    ctx.closePath();
  } else {
    roundRectPath(ctx, L * 0.12, -W * 0.37, L * 0.24, W * 0.74, W * 0.1);
  }
  ctx.fill();
  if (effPx >= 40) {
    ctx.fillStyle = vt.headlight;
    ctx.beginPath();
    roundRectPath(ctx, L / 2 - L * 0.055, -W * 0.36, L * 0.045, W * 0.18, W * 0.04);
    roundRectPath(ctx, L / 2 - L * 0.055, W * 0.18, L * 0.045, W * 0.18, W * 0.04);
    ctx.fill();
  }
}

/** Cargo crates on the rear half: one big crate, two in a row, or a 2 x 2 grid (max 4 shown). */
function drawLoad(ctx, vt, count, L, W, px) {
  const n = count > 4 ? 4 : count;
  const cols = n > 1 ? 2 : 1;
  const rows = n > 2 ? 2 : 1;
  const areaW = L * 0.5;
  const areaH = W * 0.74;
  const cell = Math.min(areaW / cols, areaH / rows);
  const box = cell * 0.88;
  const cx0 = -L * 0.15 - (cols * cell) / 2 + cell / 2;
  const cy0 = -(rows * cell) / 2 + cell / 2;
  ctx.fillStyle = vt.load;
  ctx.strokeStyle = vt.loadEdge;
  ctx.lineWidth = Math.min(1 * px, box * 0.14);
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    roundRectPath(ctx, cx0 + (i % cols) * cell - box / 2, cy0 + Math.floor(i / cols) * cell - box / 2, box, box, box * 0.12);
    ctx.fill();
    ctx.stroke();
  }
}

/** Amber / dark diagonal stripes over the body (breakdown, dead battery). */
function drawHazard(ctx, vt, L, W, r) {
  ctx.save();
  ctx.beginPath();
  roundRectPath(ctx, -L / 2, -W / 2, L, W, r);
  ctx.clip();
  ctx.fillStyle = vt.hazard;
  ctx.fillRect(-L / 2, -W / 2, L, W);
  ctx.strokeStyle = vt.hazardInk;
  ctx.lineWidth = W * 0.26;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  const step = W * 0.62;
  for (let x = -L / 2 - W; x < L / 2 + W; x += step) {
    ctx.moveTo(x, W / 2);
    ctx.lineTo(x + W, -W / 2);
  }
  ctx.stroke();
  ctx.restore();
}

const BATTERY_OK = '#2fb36b';
const BATTERY_LOW = '#f5a524';
const BATTERY_CRITICAL = '#e5484d';

/** Screen-space marks around the vehicle centre (sx, sy in CSS px). */
function drawBadges(ctx, fr, v, sx, sy) {
  const { theme, zoom } = fr;
  const vt = theme.vehicle;
  const size = vehicleSize(v, fr.cs, fr.size);
  const lenPx = Math.max(size.length * zoom, 9);
  const widPx = Math.max(size.width * zoom, 9 * (size.width / size.length));
  const reach = 0.5 * Math.hypot(lenPx, widPx); // radius of the circle around the vehicle
  const tv = v.tv;
  if (v.state === 'charging') {
    const r = Math.min(8.5, Math.max(5.5, lenPx * 0.2));
    drawBadgeDisc(ctx, vt, sx + reach * 0.75, sy - reach * 0.75, r);
    drawBolt(ctx, sx + reach * 0.75, sy - reach * 0.75, r * 1.5, vt.bolt, null);
  } else if (tv && tv.waiting === true && !isBroken(v)) {
    drawClock(ctx, sx + reach * 0.75, sy - reach * 0.75, Math.min(8, Math.max(4.5, lenPx * 0.17)), vt.badgeFill, vt.wait, vt.badgeInk);
  }
  const battery = v.fleet && v.fleet.battery && v.fleet.battery.enabled === true ? v.battery : 1;
  if (battery < 1 && battery >= 0) {
    const w = Math.min(34, Math.max(14, lenPx * 0.9));
    const y = sy + reach + 3;
    ctx.fillStyle = vt.batteryTrack;
    ctx.fillRect(sx - w / 2, y, w, 3.5);
    ctx.fillStyle = battery > 0.5 ? BATTERY_OK : battery > 0.25 ? BATTERY_LOW : BATTERY_CRITICAL;
    ctx.fillRect(sx - w / 2, y, w * battery, 3.5);
  }
  if (fr.showIds) {
    ctx.font = fr.idFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    haloText(ctx, v.id, sx, sy - reach - 2, theme.label, theme.labelHalo, 3);
  }
}

function drawBadgeDisc(ctx, vt, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = vt.badgeFill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = vt.bolt;
  ctx.stroke();
}

/**
 * Small top-down vehicle silhouette in CSS-pixel space (parked in a depot bay), pointing up.
 * Not part of the per-frame hot path: it may save / restore.
 */
export function drawVehicleIcon(ctx, theme, color, cx, cy, length, width) {
  const col = variantOf(color || DEFAULT_COLOR);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 2);
  ctx.beginPath();
  roundRectPath(ctx, -length / 2, -width / 2, length, width, Math.min(width * 0.3, length * 0.2));
  ctx.fillStyle = color || DEFAULT_COLOR;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = col.lo;
  ctx.stroke();
  ctx.fillStyle = theme.vehicle.windshield;
  ctx.beginPath();
  roundRectPath(ctx, length * 0.12, -width * 0.36, length * 0.24, width * 0.72, width * 0.1);
  ctx.fill();
  ctx.restore();
}

/** Font used for vehicle id labels (set once per frame by the renderer). */
const ID_FONT_PX = 10;
export const idFontOf = (theme) => fontOf(theme, 600, ID_FONT_PX);
