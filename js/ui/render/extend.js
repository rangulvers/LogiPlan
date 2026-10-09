// The plan that grows, on the canvas: the translucent block of baseplate an edit would add (view.extension) and the '+' chips
// on the four edges that extend the plan by one block (view.extendChips). Drawn in CSS-pixel space inside the interaction layer, so
// none of it appears in exported pictures. The rules (how many blocks, where the chips sit) live in editor/grow.js.
//
//   view.extension = { left, top, right, bottom, ok, limited, hint } | null
//        cells the plan would gain on each side. The added ground is drawn like the baseplate (studs, grid), but translucent, inside a
//        dashed outline; a sentence-sized label on each added strip says how much ("+8 columns"). `ok: false` (the edit would need more
//        than the largest plan) draws it in the warning colour; `hint: true` (the pointer rests on a chip) draws it lighter.
//   view.extendChips = boolean, view.extendHover = 'left' | 'top' | 'right' | 'bottom' | null
//        the faint strips along the edges with a round '+' chip in the middle of each; the hovered one is filled.

import { edgeChips, chipAt, BLOCK } from '../editor/grow.js';
import { TAU, roundRectPath, fontOf, measure } from './draw.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Most studs drawn on the added ground in one frame; beyond it the studs are left out (the grid still shows). */
const MAX_STUDS = 5000;

/** The view the chip geometry needs, from the frame. */
function chipView(fr) {
  return { ox: fr.ox, oy: fr.oy, cellPx: fr.cs * fr.zoom, cols: fr.scene.cols, rows: fr.scene.rows, w: fr.w, h: fr.h };
}

/**
 * Chips and strips of this frame: empty when they are not offered, when the plan is too small on screen, and while an edit shows the block
 * it would add (the chips would sit on top of its label, and a press there belongs to the edit).
 */
function chipsOf(fr) {
  const ext = fr.view.extension;
  return fr.view.extendChips && fr.scene && !(ext && !ext.hint) ? edgeChips(chipView(fr), { coarse: fr.coarse }) : [];
}

/** The side whose chip is under screen point (px, py), or null. Used by Renderer.hitTest while chips are on. */
export function hitExtendChip(fr, px, py) {
  return chipAt(chipsOf(fr), px, py);
}

/** The added ground: the new outline minus the old plate, as up to four rectangles in cell units relative to the plate. */
function addedRects(ext, cols, rows) {
  const out = [];
  const x0 = -ext.left;
  const y0 = -ext.top;
  const x1 = cols + ext.right;
  const y1 = rows + ext.bottom;
  if (ext.left > 0) out.push({ side: 'left', x: x0, y: y0, w: ext.left, h: y1 - y0 });
  if (ext.right > 0) out.push({ side: 'right', x: cols, y: y0, w: ext.right, h: y1 - y0 });
  if (ext.top > 0) out.push({ side: 'top', x: 0, y: y0, w: cols, h: ext.top });
  if (ext.bottom > 0) out.push({ side: 'bottom', x: 0, y: rows, w: cols, h: ext.bottom });
  return out;
}

/** Draw the block(s) of baseplate that the edit in progress (or a hovered chip) would add. */
export function drawExtension(ctx, fr, ext) {
  if (!ext || !fr.scene) return;
  const { cols, rows } = fr.scene;
  const rects = addedRects(ext, cols, rows);
  if (rects.length === 0) return;
  const c = fr.cs * fr.zoom; // CSS px per cell
  const theme = fr.theme;
  const warn = ext.ok === false;
  const alpha = ext.hint ? 0.5 : 1;
  const px = (cx) => fr.ox + cx * c;
  const py = (cy) => fr.oy + cy * c;
  ctx.save();
  // ground: the baseplate colour, translucent, only where nothing is yet
  ctx.globalAlpha = (warn ? 0.4 : 0.6) * alpha;
  ctx.fillStyle = warn ? theme.ghostInvalid : theme.baseplate;
  ctx.beginPath();
  for (const r of rects) ctx.rect(px(r.x), py(r.y), r.w * c, r.h * c);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  for (const r of rects) ctx.rect(px(r.x), py(r.y), r.w * c, r.h * c);
  ctx.clip();
  const x0 = -ext.left;
  const y0 = -ext.top;
  const x1 = cols + ext.right;
  const y1 = rows + ext.bottom;
  // grid: a hairline at every cell, stronger at every 5th (counted from the corner of the old plate, like the plate itself)
  if (c >= 5) {
    const vx = { a: Math.max(x0, Math.floor((-fr.ox) / c)), b: Math.min(x1, Math.ceil((fr.w - fr.ox) / c)) }; // the cells in view
    const vy = { a: Math.max(y0, Math.floor((-fr.oy) / c)), b: Math.min(y1, Math.ceil((fr.h - fr.oy) / c)) };
    const major = c >= 8 ? 5 : 10;
    for (const isMajor of [false, true]) {
      if (!isMajor && c < 12) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = isMajor ? theme.gridMajor : theme.gridLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = vx.a; k <= vx.b; k++) {
        if ((((k % major) + major) % major === 0) !== isMajor) continue;
        const x = Math.round(px(k)) + 0.5;
        ctx.moveTo(x, py(vy.a));
        ctx.lineTo(x, py(vy.b));
      }
      for (let k = vy.a; k <= vy.b; k++) {
        if ((((k % major) + major) % major === 0) !== isMajor) continue;
        const y = Math.round(py(k)) + 0.5;
        ctx.moveTo(px(vx.a), y);
        ctx.lineTo(px(vx.b), y);
      }
      ctx.stroke();
    }
  }
  // studs: one round Lego stud per cell, in one path
  if (c >= 9 && !warn) {
    const r = c * 0.2;
    let studs = 0;
    ctx.globalAlpha = 0.9 * alpha;
    ctx.fillStyle = theme.stud;
    ctx.beginPath();
    for (const rect of rects) {
      const ca = Math.max(rect.x, Math.floor((-fr.ox) / c));
      const cb = Math.min(rect.x + rect.w - 1, Math.ceil((fr.w - fr.ox) / c));
      const ra = Math.max(rect.y, Math.floor((-fr.oy) / c));
      const rb = Math.min(rect.y + rect.h - 1, Math.ceil((fr.h - fr.oy) / c));
      for (let cy = ra; cy <= rb && studs < MAX_STUDS; cy++) {
        for (let cx = ca; cx <= cb && studs < MAX_STUDS; cx++, studs++) {
          const x = px(cx + 0.5);
          const y = py(cy + 0.5);
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, TAU);
        }
      }
    }
    ctx.fill();
  }
  ctx.restore();
  // outline of the plan as it would be, dashed, along the new boundary only (not along the edge of the baseplate that stays)
  ctx.globalAlpha = (ext.hint ? 0.6 : 0.95);
  ctx.setLineDash([7, 5]);
  ctx.lineWidth = 2;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = warn ? theme.ghostInvalid : theme.selection;
  ctx.beginPath();
  const edge = (grows, a0, a1, from, to, line) => {
    // the stretches of one side of the new outline: all of it when the plan grows on that side, else the stretches beside the strips
    const spans = grows ? [[a0, a1]] : [[a0, from, ext[line[0]] > 0], [to, a1, ext[line[1]] > 0]].filter((sp) => sp[2]).map((sp) => [sp[0], sp[1]]);
    return spans;
  };
  for (const [a, b] of edge(ext.top > 0, x0, x1, 0, cols, ['left', 'right'])) { ctx.moveTo(px(a), py(y0)); ctx.lineTo(px(b), py(y0)); }
  for (const [a, b] of edge(ext.bottom > 0, x0, x1, 0, cols, ['left', 'right'])) { ctx.moveTo(px(a), py(y1)); ctx.lineTo(px(b), py(y1)); }
  for (const [a, b] of edge(ext.left > 0, y0, y1, 0, rows, ['top', 'bottom'])) { ctx.moveTo(px(x0), py(a)); ctx.lineTo(px(x0), py(b)); }
  for (const [a, b] of edge(ext.right > 0, y0, y1, 0, rows, ['top', 'bottom'])) { ctx.moveTo(px(x1), py(a)); ctx.lineTo(px(x1), py(b)); }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  if (!ext.hint) for (const r of rects) drawAmount(ctx, fr, r, ext, c, warn);
  ctx.restore();
}

/** "+8 columns" at the start of the part of an added strip that is in view (centred across the strip, near its top or left end). */
function drawAmount(ctx, fr, r, ext, c, warn) {
  const horizontal = r.side === 'left' || r.side === 'right';
  const n = horizontal ? r.w : r.h;
  const text = `${warn ? 'Limit: ' : ''}+${n} ${horizontal ? 'columns' : 'rows'}`;
  const theme = fr.theme;
  const sx0 = fr.ox + r.x * c;
  const sy0 = fr.oy + r.y * c;
  const vx0 = clamp(sx0, 0, fr.w);
  const vx1 = clamp(sx0 + r.w * c, 0, fr.w);
  const vy0 = clamp(sy0, 0, fr.h);
  const vy1 = clamp(sy0 + r.h * c, 0, fr.h);
  if (vx1 - vx0 < 8 || vy1 - vy0 < 8) return;
  ctx.font = fontOf(theme, 700, 11.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = measure(ctx, text) + 18;
  const h = 22;
  // At the start of the strip along its length (the top of a strip on the left or right, the left end of one above or below), not in the middle:
  // a road drawn through the middle of the plan, the pointer and the length label that follows it all pass there and would hide this one.
  const inset = 8;
  const x = clamp((horizontal ? (vx0 + vx1) / 2 - w / 2 : vx0 + inset), 6, Math.max(6, fr.w - w - 6));
  const y = clamp((horizontal ? vy0 + inset : (vy0 + vy1) / 2 - h / 2), 6, Math.max(6, fr.h - h - 6));
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = theme.panel;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = warn ? theme.ghostInvalid : theme.panelBorder;
  ctx.stroke();
  ctx.fillStyle = theme.text;
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
}

/** The faint strips along the edges of the baseplate and the round '+' chip in the middle of each. */
export function drawEdgeChips(ctx, fr) {
  const chips = chipsOf(fr);
  if (chips.length === 0) return;
  const theme = fr.theme;
  const hover = fr.view.extendHover;
  ctx.save();
  for (const e of chips) {
    const on = hover === e.side;
    const s = e.strip;
    ctx.beginPath();
    roundRectPath(ctx, s.x + 0.75, s.y + 0.75, s.w - 1.5, s.h - 1.5, 6);
    ctx.globalAlpha = on ? 1 : 0.7;
    ctx.fillStyle = theme.selectionFill;
    ctx.fill();
    ctx.globalAlpha = on ? 0.9 : 0.4;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = theme.selection;
    ctx.stroke();
    ctx.setLineDash([]);
    const { x, y, r } = e.chip;
    const rr = on ? r + 2 : r;
    ctx.globalAlpha = 1;
    if (on) {
      ctx.beginPath();
      ctx.arc(x, y, rr + 4, 0, TAU);
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = theme.selection;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.fillStyle = on ? theme.selection : theme.handleFill;
    ctx.fill();
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = theme.handleStroke;
    ctx.stroke();
    const arm = rr * 0.45;
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.25;
    ctx.strokeStyle = on ? '#ffffff' : theme.handleStroke;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
  }
  ctx.restore();
}

/** Words for a chip, for a tooltip or the status line: "8 more columns on the left". */
export const chipText = (side) => `${BLOCK} more ${side === 'left' || side === 'right' ? 'columns' : 'rows'} ${side === 'top' ? 'above' : side === 'bottom' ? 'below' : `on the ${side}`}`;
