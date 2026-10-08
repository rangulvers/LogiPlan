// Connecting stations on the canvas: the flow handle of a selected station and the highlight of the stations a new
// flow may end at (or start from). Drawn in CSS-pixel space inside the interaction layer, so none of it appears in
// exported pictures. The rules (which stations are valid, which edge carries the handle) live in editor/connect.js.
//
//   view.connectHandle = { id, hover?, pressed? } | null
//        the station that shows the handle (select tool, one sender selected). The handle is a round accent button
//        with an arrow, on a short stem, just outside the edge that faces the nearest valid destination.
//   view.connect = { role: 'from'|'to', anchorId, valid: Set<id>, exists: Set<id>, over: id|null, overStatus,
//                    snap: id|null, verb: 'Click'|'Drop' } | null
//        a connect gesture is under way: stations in `valid` glow green, every other station recedes, the station
//        under the pointer (`over`) says what releasing does ("Drop to connect", "Already connected", ...).

import { handleSide, handlePlacement, insideHandle, targetLabel } from '../editor/connect.js';
import { TAU, roundRectPath, fontOf, measure } from './draw.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Handle radius (CSS px) for a mouse (smaller when the plan is zoomed far out, so the handle does not cover the plant) and for a
 * coarse pointer (touch, always large); the pointer target is larger than the drawing.
 */
export const HANDLE_R = 11;
export const HANDLE_R_MIN = 8;
export const HANDLE_R_COARSE = 14;
/** Extra radius while the pointer is over the handle or it is pressed. */
const GROW = 2.5;
/** Gap between the station edge and the handle circle: clear of the 8 px resize handle on that edge. */
const EDGE_GAP = 8;
/** Below this size (px of the shorter side of the brick, zoomed far out) the plan is too small to aim at: no handle. */
const MIN_STATION_PX = 14;
/** Pointer reach beyond the drawn circle (kept small: the resize handle in the middle of the same edge has its own zone). */
const HIT_SLACK = 3;

const sideCache = { layout: null, id: '', side: 'e' };

/** Edge of the station that carries the handle, cached per layout object and station. */
function sideOf(layout, id) {
  if (sideCache.layout !== layout || sideCache.id !== id) {
    sideCache.layout = layout;
    sideCache.id = id;
    sideCache.side = handleSide(layout, id);
  }
  return sideCache.side;
}

/** Screen placement { x, y, angle, edgeX, edgeY, r } of the handle shown by `view.connectHandle`, or null. */
export function handleGeometry(fr) {
  const h = fr.view.connectHandle;
  if (!h || !fr.scene) return null;
  const e = fr.scene.stationById.get(h.id);
  if (!e || Math.min(e.w, e.h) * fr.zoom < MIN_STATION_PX) return null;
  const r = fr.coarse ? HANDLE_R_COARSE : clamp(fr.cs * fr.zoom * 0.45, HANDLE_R_MIN, HANDLE_R);
  const rect = { x: fr.ox + e.x * fr.zoom, y: fr.oy + e.y * fr.zoom, w: e.w * fr.zoom, h: e.h * fr.zoom };
  const g = handlePlacement(rect, sideOf(fr.layout, h.id), r + EDGE_GAP);
  g.r = r;
  return g;
}

/** Id of the station whose handle is under screen point (px, py), or null. */
export function hitConnectHandle(fr, px, py) {
  const g = handleGeometry(fr);
  if (!g || !insideHandle(g, px, py, g.r + GROW + HIT_SLACK)) return null;
  return fr.view.connectHandle.id;
}

/** Arrow glyph (shaft and head) of length ~1.3 r centred on (x, y), pointing along `angle`. */
function arrowGlyph(ctx, x, y, r, angle, color) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const L = r * 0.62;
  const W = r * 0.5;
  const shaft = r * 0.16;
  const pt = (f, l) => [x + c * f - s * l, y + s * f + c * l];
  ctx.beginPath();
  const pts = [pt(L, 0), pt(0.02 * r, W), pt(0.02 * r, shaft), pt(-L, shaft), pt(-L, -shaft), pt(0.02 * r, -shaft), pt(0.02 * r, -W)];
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** The flow handle of the selected station. Expects the CSS-pixel transform. */
export function drawConnectHandle(ctx, fr) {
  const g = handleGeometry(fr);
  if (!g) return;
  const h = fr.view.connectHandle;
  const theme = fr.theme;
  const r = g.r + (h.hover || h.pressed ? GROW : 0);
  // stem from the edge to the circle
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(g.edgeX, g.edgeY);
  ctx.lineTo(g.x, g.y);
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = theme.accent;
  ctx.stroke();
  // soft shadow, white ring, accent disc, arrow
  ctx.beginPath();
  ctx.arc(g.x, g.y + 1.5, r + 2.5, 0, TAU);
  ctx.fillStyle = 'rgba(8,14,28,0.30)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(g.x, g.y, r + 2, 0, TAU);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(g.x, g.y, r, 0, TAU);
  ctx.fillStyle = h.pressed ? theme.selection : theme.accent;
  ctx.fill();
  arrowGlyph(ctx, g.x, g.y, r, g.angle, '#ffffff');
}

// ---- targets ----------------------------------------------------------------------------------------------------

const radiusOf = (fr) => clamp(fr.cs * fr.zoom * 0.2, 3, 16);

function brickPath(ctx, fr, e, pad) {
  const z = fr.zoom;
  ctx.beginPath();
  roundRectPath(ctx, fr.ox + e.x * z - pad, fr.oy + e.y * z - pad, e.w * z + 2 * pad, e.h * z + 2 * pad, radiusOf(fr) + pad);
}

/**
 * Pill with a short sentence centred above the station, or below it when the gesture started above (the rubber band arrives
 * from there and its arrow head must stay visible) or when there is no room above.
 */
function drawTargetPill(ctx, fr, e, text, status, below) {
  const theme = fr.theme;
  const z = fr.zoom;
  ctx.font = fontOf(theme, 700, 11.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = measure(ctx, text) + 20;
  const h = 22;
  const cx = fr.ox + (e.x + e.w / 2) * z;
  const x = clamp(cx - w / 2, 6, Math.max(6, fr.w - w - 6));
  let y = below ? fr.oy + (e.y + e.h) * z + 8 : fr.oy + e.y * z - h - 8;
  if (y < 6) y = fr.oy + (e.y + e.h) * z + 8;
  else if (y + h > fr.h - 6) y = fr.oy + e.y * z - h - 8;
  const good = status === 'valid';
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = good ? theme.ghostValid : theme.panel;
  ctx.fill();
  ctx.lineWidth = good ? 2 : 1.5;
  ctx.strokeStyle = good ? '#ffffff' : status === 'exists' ? theme.panelBorder : theme.ghostInvalid;
  ctx.stroke();
  ctx.fillStyle = good ? '#07210f' : theme.text;
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
}

/**
 * Highlight the stations a new flow may reach: green outline for valid ones, a veil over the others, and a label on the
 * one under the pointer. Expects the CSS-pixel transform.
 */
export function drawConnectTargets(ctx, fr) {
  const c = fr.view.connect;
  if (!c || !fr.scene) return;
  const theme = fr.theme;
  const anchor = fr.scene.stationById.get(c.anchorId);
  let over = null;
  for (const e of fr.scene.stations) {
    const id = e.st.id;
    if (id === c.anchorId) continue;
    if (id === c.over) over = e;
    if (c.valid && c.valid.has(id)) {
      const hot = id === c.over;
      brickPath(ctx, fr, e, 1.5);
      ctx.fillStyle = theme.ghostValid;
      ctx.globalAlpha = hot ? 0.26 : 0.12;
      ctx.fill();
      ctx.globalAlpha = hot ? 0.38 : 0.26;
      ctx.lineWidth = hot ? 9 : 7;
      ctx.strokeStyle = theme.ghostValid;
      ctx.stroke();
      ctx.globalAlpha = 1;
      brickPath(ctx, fr, e, 1.5);
      ctx.lineWidth = hot ? 3 : 2.25;
      ctx.stroke();
    } else {
      brickPath(ctx, fr, e, 0);
      ctx.fillStyle = theme.bg;
      ctx.globalAlpha = 0.58;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  if (over) {
    const below = !!anchor && anchor.y + anchor.h / 2 < over.y + over.h / 2; // the gesture comes from above
    drawTargetPill(ctx, fr, over, targetLabel(c.overStatus, c.verb, c.role), c.overStatus, below);
  }
}
