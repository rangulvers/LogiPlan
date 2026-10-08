// Interaction visuals: selection outlines and resize handles, hover highlight, placement ghosts, road
// paint preview and the marquee. All drawn in CSS-pixel space on top of everything else. Also exposes the
// screen rectangle of selectable items, which hit testing shares so what you see is what you can click.

import { parseKey, DX, DY } from '../../util/grid.js';
import { HANDLE_NAMES, handlePoint } from './geometry.js';
import { drawBrick } from './bricks.js';
import { drawDockNotches } from './overlays.js';
import { labelFontPx } from './labels.js';
import { roundRectPath, fontOf, measure } from './draw.js';

const HANDLE_SIZE = 8;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Metre rectangle -> CSS px rectangle. */
const toPx = (fr, x, y, w, h) => ({ x: fr.ox + x * fr.zoom, y: fr.oy + y * fr.zoom, w: w * fr.zoom, h: h * fr.zoom });

/** Is `c` a [cx, cy] pair of finite numbers? */
const isCell = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);

/** Cell id of a 'cell' selection: "cx,cy" or [cx, cy]. */
function cellOf(id) {
  if (typeof id === 'string') return parseKey(id);
  return Array.isArray(id) ? id : [NaN, NaN];
}

/**
 * Screen rectangle {x, y, w, h} (CSS px) of a selectable item, or null if it does not exist.
 * Labels need a context for text measuring.
 * @param {'station'|'obstacle'|'label'|'cell'} kind
 */
export function itemRectPx(ctx, fr, kind, id) {
  const cs = fr.cs;
  if (kind === 'station') {
    const e = fr.scene.stationById.get(id);
    return e ? toPx(fr, e.x, e.y, e.w, e.h) : null;
  }
  if (kind === 'obstacle') {
    const o = fr.scene.obstacleById.get(id);
    return o ? toPx(fr, o.x * cs, o.y * cs, o.w * cs, o.h * cs) : null;
  }
  if (kind === 'label') {
    const l = fr.scene.labelById.get(id);
    if (!l) return null;
    const px = Math.max(labelFontPx(l, fr.zoom, cs), 10);
    ctx.font = fontOf(fr.theme, 600, px);
    const w = measure(ctx, l.text) + 8;
    const h = px * 1.35;
    return { x: fr.ox + l.x * cs * fr.zoom - w / 2, y: fr.oy + l.y * cs * fr.zoom - h / 2, w, h };
  }
  if (kind === 'cell') {
    const [cx, cy] = cellOf(id);
    return Number.isFinite(cx) && Number.isFinite(cy) ? toPx(fr, cx * cs, cy * cs, cs, cs) : null;
  }
  return null;
}

function strokeRect(ctx, r, color, width, pad, radius) {
  ctx.beginPath();
  roundRectPath(ctx, r.x - pad, r.y - pad, r.w + 2 * pad, r.h + 2 * pad, radius);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

const radiusOf = (fr, kind) => (kind === 'station' ? clamp(fr.cs * fr.zoom * 0.2, 3, 16) : 3);

/** Hover highlight for a station / obstacle / label / cell (vehicles and flows highlight themselves). */
export function drawHover(ctx, fr) {
  const hover = fr.view.hover;
  if (!hover || hover.kind === 'vehicle' || hover.kind === 'flow') return;
  if (hover.kind === 'cell' && hover.cell) {
    const r = toPx(fr, hover.cell[0] * fr.cs, hover.cell[1] * fr.cs, fr.cs, fr.cs);
    ctx.fillStyle = fr.theme.selectionFill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    strokeRect(ctx, r, fr.theme.hover, 1.5, -0.75, 2);
    return;
  }
  const r = itemRectPx(ctx, fr, hover.kind, hover.id);
  if (!r) return;
  strokeRect(ctx, r, fr.theme.hover, 2, 1.5, radiusOf(fr, hover.kind));
}

/** Selection outlines for every selected item and the eight resize handles of a single selected rectangle. */
export function drawSelection(ctx, fr) {
  const sel = fr.view.selection;
  if (!sel || !sel.kind || !Array.isArray(sel.ids) || sel.ids.length === 0) return;
  const theme = fr.theme;
  for (const id of sel.ids) {
    const r = itemRectPx(ctx, fr, sel.kind, id);
    if (!r) continue;
    const radius = radiusOf(fr, sel.kind);
    if (sel.kind !== 'station') {
      ctx.beginPath();
      roundRectPath(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, radius);
      ctx.fillStyle = theme.selectionFill;
      ctx.fill();
    }
    strokeRect(ctx, r, theme.selection, 5, 2, radius + 1);
    ctx.globalAlpha = 0.35;
    strokeRect(ctx, r, theme.selection, 5, 2, radius + 1);
    ctx.globalAlpha = 1;
    strokeRect(ctx, r, theme.selection, 2, 2, radius + 1);
    if (sel.kind === 'label') {
      ctx.setLineDash([4, 3]);
      strokeRect(ctx, r, theme.selection, 1.5, 2, 3);
      ctx.setLineDash([]);
    }
  }
  const handles = handleRect(ctx, fr);
  if (handles) drawHandles(ctx, fr, handles);
}

/** The rectangle that carries resize handles (single selected station / obstacle with resizeHandles on), or null. */
export function handleRect(ctx, fr) {
  const sel = fr.view.selection;
  if (!fr.view.resizeHandles || !sel || (sel.kind !== 'station' && sel.kind !== 'obstacle') || !Array.isArray(sel.ids) || sel.ids.length !== 1) return null;
  return itemRectPx(ctx, fr, sel.kind, sel.ids[0]);
}

function drawHandles(ctx, fr, r) {
  const theme = fr.theme;
  const p = [0, 0];
  const s = HANDLE_SIZE;
  ctx.lineWidth = 1.75;
  for (const name of HANDLE_NAMES) {
    handlePoint(name, r.x, r.y, r.w, r.h, p);
    ctx.beginPath();
    roundRectPath(ctx, p[0] - s / 2, p[1] - s / 2, s, s, 2);
    ctx.fillStyle = theme.handleFill;
    ctx.fill();
    ctx.strokeStyle = theme.handleStroke;
    ctx.stroke();
  }
}

/**
 * Placement ghost: a translucent brick (or obstacle) in green when the spot is free, red when blocked.
 * `ghost.obstacleKind` ('wall' | 'rack' | 'column', default wall) picks the obstacle look.
 */
export function drawGhost(ctx, fr, ghost) {
  if (!ghost || !ghost.rect) return;
  const cs = fr.cs;
  const { x, y, w, h } = ghost.rect;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return;
  const rc = { x: Math.round(x), y: Math.round(y), w: clamp(Math.round(w), 1, fr.scene.cols), h: clamp(Math.round(h), 1, fr.scene.rows) };
  const color = ghost.valid ? fr.theme.ghostValid : fr.theme.ghostInvalid;
  const r = toPx(fr, rc.x * cs, rc.y * cs, rc.w * cs, rc.h * cs);
  const radius = clamp(cs * fr.zoom * 0.18, 3, 14);
  if (ghost.kind === 'station') {
    drawBrick(ctx, fr, ghost.type, { x: rc.x * cs, y: rc.y * cs, w: rc.w * cs, h: rc.h * cs }, null, null, 0.7);
    const pal = fr.theme.station[ghost.type] || fr.theme.station.process;
    drawDockNotches(ctx, fr, rc, pal.top);
  } else {
    const pal = fr.theme.obstacle[ghost.obstacleKind] || fr.theme.obstacle.wall;
    ctx.beginPath();
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 3);
    ctx.fillStyle = pal.fill;
    ctx.globalAlpha = 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  roundRectPath(ctx, r.x, r.y, r.w, r.h, radius);
  ctx.fillStyle = color;
  ctx.globalAlpha = ghost.valid ? 0.1 : 0.38;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.setLineDash([6, 4]);
  strokeRect(ctx, r, color, 2.25, 1, radius);
  ctx.setLineDash([]);
}

/**
 * Road paint preview: highlighted cells, direction chevrons for one-way strokes, a dashed centre line for
 * two-way strokes. `preview.blocked` (optional [[cx, cy]]) marks cells that stop the stroke, in red.
 * Optional: `preview.guide` = { axis: 'h' | 'v', cell: [cx, cy] } draws the axis a straight line is locked to across the plant,
 * `preview.label` = { text, ux, uy, above? } puts a short label (the length) next to the pointer (ux, uy in fractional cells).
 */
export function drawPaintPreview(ctx, fr, preview) {
  if (!preview || !Array.isArray(preview.cells)) return;
  const cells = preview.cells.filter(isCell);
  if (cells.length === 0) return;
  const theme = fr.theme;
  const cell = fr.cs * fr.zoom;
  drawAxisGuide(ctx, fr, preview.guide, cell);
  ctx.fillStyle = theme.road;
  ctx.globalAlpha = 0.72;
  ctx.beginPath();
  for (const [cx, cy] of cells) ctx.rect(fr.ox + cx * cell, fr.oy + cy * cell, cell, cell);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = theme.selection;
  ctx.beginPath();
  for (const [cx, cy] of cells) ctx.rect(fr.ox + cx * cell + 0.75, fr.oy + cy * cell + 0.75, cell - 1.5, cell - 1.5);
  ctx.stroke();
  const centre = (c) => [fr.ox + (c[0] + 0.5) * cell, fr.oy + (c[1] + 0.5) * cell];
  if (preview.oneWay) drawPreviewChevrons(ctx, fr, cells, preview.dir, cell, centre);
  else if (cells.length > 1) {
    ctx.setLineDash([cell * 0.2, cell * 0.14]);
    ctx.lineWidth = clamp(cell * 0.035, 1, 2.4);
    ctx.strokeStyle = theme.roadMark;
    ctx.beginPath();
    cells.forEach((c, i) => {
      const [x, y] = centre(c);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const [cx, cy] of Array.isArray(preview.blocked) ? preview.blocked.filter(isCell) : []) {
    const x = fr.ox + cx * cell;
    const y = fr.oy + cy * cell;
    ctx.fillStyle = theme.ghostInvalid;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, y, cell, cell);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.ghostInvalid;
    ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
  }
  drawStrokeLabel(ctx, fr, preview.label, cell);
}

/** The axis a straight line is locked to: a dashed accent line through the middle of the start cell, across the whole plant. */
function drawAxisGuide(ctx, fr, guide, cell) {
  if (!guide || !isCell(guide.cell) || (guide.axis !== 'h' && guide.axis !== 'v')) return;
  const horizontal = guide.axis === 'h';
  const length = (horizontal ? fr.scene.cols : fr.scene.rows) * cell;
  if (!(length > 0)) return;
  ctx.save();
  ctx.setLineDash([clamp(cell * 0.4, 4, 14), clamp(cell * 0.3, 3, 10)]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = fr.theme.selection;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  if (horizontal) {
    const y = fr.oy + (guide.cell[1] + 0.5) * cell;
    ctx.moveTo(fr.ox, y);
    ctx.lineTo(fr.ox + length, y);
  } else {
    const x = fr.ox + (guide.cell[0] + 0.5) * cell;
    ctx.moveTo(x, fr.oy);
    ctx.lineTo(x, fr.oy + length);
  }
  ctx.stroke();
  ctx.restore();
}

/** A small pill with the length of the stroke ("24 m · 12 cells") below and right of the pointer (above it for a finger), kept inside the canvas. */
function drawStrokeLabel(ctx, fr, label, cell) {
  if (!label || typeof label.text !== 'string' || !label.text || !Number.isFinite(label.ux) || !Number.isFinite(label.uy)) return;
  const theme = fr.theme;
  ctx.save();
  ctx.font = fontOf(theme, 700, 11.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = measure(ctx, label.text) + 18;
  const h = 22;
  const px = fr.ox + label.ux * cell;
  const py = fr.oy + label.uy * cell;
  const x = clamp(px + 14, 6, Math.max(6, fr.w - w - 6));
  let y = label.above ? py - 14 - h - 22 : py + 16;
  if (y + h > fr.h - 6) y = py - h - 16;
  y = clamp(y, 6, Math.max(6, fr.h - h - 6));
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = theme.panel;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = theme.panelBorder;
  ctx.stroke();
  ctx.fillStyle = theme.text;
  ctx.fillText(label.text, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
}

function drawPreviewChevrons(ctx, fr, cells, fallbackDir, cell, centre) {
  const s = cell * 0.18;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = clamp(cell * 0.06, 1.5, 3.5);
  ctx.strokeStyle = fr.theme.roadChevron;
  ctx.beginPath();
  for (let i = 0; i < cells.length; i++) {
    const next = cells[i + 1] || null;
    const prev = cells[i - 1] || null;
    let dx;
    let dy;
    if (next) { dx = next[0] - cells[i][0]; dy = next[1] - cells[i][1]; }
    else if (prev) { dx = cells[i][0] - prev[0]; dy = cells[i][1] - prev[1]; }
    else if (Number.isInteger(fallbackDir)) { dx = DX[fallbackDir]; dy = DY[fallbackDir]; }
    else continue;
    if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
    const [x, y] = centre(cells[i]);
    ctx.moveTo(x - dx * s - dy * s * 1.1, y - dy * s - dx * s * 1.1);
    ctx.lineTo(x + dx * s, y + dy * s);
    ctx.lineTo(x - dx * s + dy * s * 1.1, y - dy * s + dx * s * 1.1);
  }
  ctx.stroke();
}

/** Rubber-band selection rectangle given in world metres (or CSS px with `space: 'screen'`). */
export function drawMarquee(ctx, fr, marquee) {
  if (!marquee) return;
  const r = marquee.space === 'screen' ? marquee : toPx(fr, marquee.x, marquee.y, marquee.w, marquee.h);
  if (!(Math.abs(r.w) > 0) || !(Math.abs(r.h) > 0)) return;
  const x = r.w < 0 ? r.x + r.w : r.x;
  const y = r.h < 0 ? r.y + r.h : r.y;
  ctx.fillStyle = fr.theme.marqueeFill;
  ctx.fillRect(x, y, Math.abs(r.w), Math.abs(r.h));
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = fr.theme.marquee;
  ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(r.w) - 1, Math.abs(r.h) - 1);
  ctx.setLineDash([]);
}
