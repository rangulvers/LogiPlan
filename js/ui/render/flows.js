// Material flows as curved arrows between station bricks. A->B and B->A bow to opposite sides (see
// flowCurve), thickness follows the weight (edit mode) or the delivered loads (simulation), and the
// selected / hovered flow is highlighted. Drawn in CSS-pixel space between the static layer and the bricks.

import { quadAngle, quadSpeed } from './geometry.js';
import { fontOf, measure, fillPill } from './draw.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Does `flow` belong to the current selection / hover? */
const isPicked = (fr, flow) => (fr.selKind === 'flow' && fr.selIds.includes(flow.id)) || (fr.hoverKind === 'flow' && fr.hoverId === flow.id);

/** Line width in px for each flow: weight based, or delivered based once the simulation has delivered something. */
function widthOf(fr, entry, maxWeight, maxDelivered) {
  const zoomScale = 0.8 + 0.2 * clamp(fr.zoom / 20, 0.5, 2);
  let share;
  if (maxDelivered > 0) {
    const d = fr.deliveredOf(entry.flow.id);
    share = Number.isFinite(d) ? d / maxDelivered : 0;
  } else {
    share = maxWeight > 0 ? clamp(entry.flow.weight / maxWeight, 0, 1) : 0.5;
  }
  return (1.6 + 3.2 * share) * zoomScale;
}

/** Draw every flow arrow. Expects the CSS-pixel transform. */
export function drawFlows(ctx, fr) {
  const flows = fr.scene.flows;
  if (flows.length === 0) return;
  let maxWeight = 0;
  let maxDelivered = 0;
  for (const e of flows) {
    if (e.flow.weight > maxWeight) maxWeight = e.flow.weight;
    const d = fr.sim ? fr.deliveredOf(e.flow.id) : NaN;
    if (d > maxDelivered) maxDelivered = d;
  }
  for (let pass = 0; pass < 2; pass++) { // picked flows last, so they sit on top
    const highlighted = pass === 1;
    for (const e of flows) {
      if (isPicked(fr, e.flow) !== highlighted) continue;
      drawArrow(ctx, fr, e, widthOf(fr, e, maxWeight, maxDelivered), highlighted);
    }
  }
  if (fr.zoom >= 10) for (const e of flows) drawChip(ctx, fr, e);
}

/** Curve control points converted to CSS px, written into the reusable object `c`. */
function toPx(fr, curve, c) {
  const z = fr.zoom;
  c.ax = fr.ox + curve.ax * z;
  c.ay = fr.oy + curve.ay * z;
  c.qx = fr.ox + curve.qx * z;
  c.qy = fr.oy + curve.qy * z;
  c.bx = fr.ox + curve.bx * z;
  c.by = fr.oy + curve.by * z;
  return c;
}

/** Control point of the curve restricted to [a, b] (the end points are Q(a) and Q(b)). */
const subControl = (p0, p1, p2, a, b) => (1 - a) * (1 - b) * p0 + (a * (1 - b) + b * (1 - a)) * p1 + a * b * p2;
const quadAt = (p0, p1, p2, t) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;

function drawArrow(ctx, fr, entry, width, highlighted) {
  const curve = entry.curve;
  const c = toPx(fr, curve, fr.curvePx);
  const theme = fr.theme;
  const w = highlighted ? width + 1.5 : width;
  const head = clamp(w * 3.4 + 4, 9, 20);
  const tEnd = curve.t1;
  const tBase = Math.max(curve.t0, tEnd - (head * 0.85) / Math.max(quadSpeed(c, tEnd), 1e-6));
  const x0 = quadAt(c.ax, c.qx, c.bx, curve.t0);
  const y0 = quadAt(c.ay, c.qy, c.by, curve.t0);
  const x1 = quadAt(c.ax, c.qx, c.bx, tBase);
  const y1 = quadAt(c.ay, c.qy, c.by, tBase);
  const cx = subControl(c.ax, c.qx, c.bx, curve.t0, tBase);
  const cy = subControl(c.ay, c.qy, c.by, curve.t0, tBase);
  const color = highlighted ? theme.flowSelected : theme.flow;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = highlighted ? 1 : 0.9;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(cx, cy, x1, y1);
  ctx.strokeStyle = theme.flowHalo;
  ctx.lineWidth = w + 3.5;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
  const tipX = quadAt(c.ax, c.qx, c.bx, tEnd);
  const tipY = quadAt(c.ay, c.qy, c.by, tEnd);
  const a = quadAngle(c, tEnd);
  const hw = head * 0.52;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - cos * head - sin * hw, tipY - sin * head + cos * hw);
  ctx.lineTo(tipX - cos * head * 0.78, tipY - sin * head * 0.78);
  ctx.lineTo(tipX - cos * head + sin * hw, tipY - sin * head - cos * hw);
  ctx.closePath();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = theme.flowHalo;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Label at the middle of an arrow: delivered loads in a simulation, the weight for a picked flow in edit mode. */
function drawChip(ctx, fr, entry) {
  let text = '';
  if (fr.sim) {
    const d = fr.deliveredOf(entry.flow.id);
    if (d > 0) text = String(d);
  } else if (isPicked(fr, entry.flow)) {
    text = `× ${entry.flow.weight}`;
  }
  if (!text || entry.curve.length * fr.zoom < 48) return;
  const c = toPx(fr, entry.curve, fr.curvePx);
  const tm = (entry.curve.t0 + entry.curve.t1) / 2;
  const x = quadAt(c.ax, c.qx, c.bx, tm);
  const y = quadAt(c.ay, c.qy, c.by, tm);
  ctx.font = fontOf(fr.theme, 700, 10.5);
  const w = measure(ctx, text) + 10;
  fillPill(ctx, x - w / 2, y - 8, w, 16, fr.theme.flowChip);
  ctx.lineWidth = 1;
  ctx.strokeStyle = isPicked(fr, entry.flow) ? fr.theme.flowSelected : fr.theme.panelBorder;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fr.theme.text;
  ctx.fillText(text, x, y + 0.5);
}

/** Dashed rubber-band arrow from a station to the pointer while a flow is being drawn. */
export function drawFlowPreview(ctx, fr, fromEntry, toX, toY) {
  const theme = fr.theme;
  const z = fr.zoom;
  const sx = fr.ox + (fromEntry.x + fromEntry.w / 2) * z;
  const sy = fr.oy + (fromEntry.y + fromEntry.h / 2) * z;
  const ex = fr.ox + toX * z;
  const ey = fr.oy + toY * z;
  const len = Math.hypot(ex - sx, ey - sy);
  if (!(len > 1)) return;
  const bow = clamp(len * 0.12, 4, 40);
  const qx = (sx + ex) / 2 - ((ey - sy) / len) * bow;
  const qy = (sy + ey) / 2 + ((ex - sx) / len) * bow;
  ctx.lineCap = 'round';
  ctx.setLineDash([7, 5]);
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = theme.selection;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(qx, qy, ex, ey);
  ctx.stroke();
  ctx.setLineDash([]);
  const a = Math.atan2(ey - qy, ex - qx);
  const head = 11;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - Math.cos(a) * head - Math.sin(a) * head * 0.5, ey - Math.sin(a) * head + Math.cos(a) * head * 0.5);
  ctx.lineTo(ex - Math.cos(a) * head + Math.sin(a) * head * 0.5, ey - Math.sin(a) * head - Math.cos(a) * head * 0.5);
  ctx.closePath();
  ctx.fillStyle = theme.selection;
  ctx.fill();
}
