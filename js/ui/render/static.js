// Static layer of the plant: baseplate, studs, grid, obstacles, roads (lane markings, one-way chevrons and
// speed-zone hatching). Everything that only changes when the layout, theme, zoom bucket or a toggle changes.
// The renderer draws it into a cached bitmap and blits that every frame; toDataURL() draws it straight into
// the export canvas. Text (free labels, speed-zone badges) is not part of it: labels.js draws it per frame,
// above flows and bricks.
//
// The caller sets the context transform to "world metres -> bitmap pixels" before calling drawStatic().

import { DX, DY } from '../../util/grid.js';
import { OCC_ROAD, OCC_STATION, OCC_OBSTACLE } from './scene.js';
import { TAU, roundRectPath } from './draw.js';

/** Margin around the baseplate that the static layer also covers (shadow and plate thickness), in CSS px. */
const PLATE_MARGIN_PX = 14;
/** ... but never less than this many metres, so the plate edge stays covered when the bitmap is scaled. */
const PLATE_MARGIN_MIN_M = 2.5;

/** Metres of margin around the baseplate that the static layer covers at `zoom` px per metre. */
export const plateMargin = (zoom) => Math.max(PLATE_MARGIN_MIN_M, PLATE_MARGIN_PX / zoom);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Draw the static layer.
 * @param {CanvasRenderingContext2D} ctx transform: world metres -> bitmap px
 * @param {object} scene from getScene()
 * @param {object} theme from getTheme()
 * @param {{ k: number, zoom: number, win: {x0,y0,x1,y1}, studs: boolean, grid: boolean }} o
 *   k = bitmap px per metre; zoom = CSS px per metre (drives level of detail); win = world window being drawn
 */
export function drawStatic(ctx, scene, theme, o) {
  const u = 1 / o.zoom; // metres per CSS pixel
  const cellPx = scene.cs * o.zoom;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  drawBaseplate(ctx, scene, theme, u);
  const range = visibleCells(scene, o.win);
  if (o.studs && cellPx >= 9) drawStuds(ctx, scene, theme, range, cellPx);
  if (o.grid && cellPx >= 5) drawGrid(ctx, scene, theme, range, o, cellPx);
  drawObstacles(ctx, scene, theme, o.win, u, cellPx);
  drawRoads(ctx, scene, theme, o, u);
  drawSpeedZones(ctx, scene, theme, o.win, u);
  drawMarkings(ctx, scene, theme, o.win, u, cellPx);
}

/** Cell index ranges overlapping the window, clamped to the grid. */
function visibleCells(scene, win) {
  const { cs, cols, rows } = scene;
  return {
    c0: Math.max(0, Math.floor(win.x0 / cs)),
    c1: Math.min(cols - 1, Math.floor(win.x1 / cs)),
    r0: Math.max(0, Math.floor(win.y0 / cs)),
    r1: Math.min(rows - 1, Math.floor(win.y1 / cs)),
  };
}

const overlaps = (win, x, y, w, h) => x <= win.x1 && x + w >= win.x0 && y <= win.y1 && y + h >= win.y0;

/** A raised plate: darker slab underneath (the visible thickness) and a lighter top face. */
function plate(ctx, x, y, w, h, depth, r, top, edge) {
  ctx.fillStyle = edge;
  ctx.beginPath();
  roundRectPath(ctx, x, y + depth, w, h, r);
  ctx.fill();
  ctx.fillStyle = top;
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
}

function drawBaseplate(ctx, scene, theme, u) {
  const { width: w, height: h } = scene;
  const depth = 5 * u;
  ctx.fillStyle = theme.shadow;
  ctx.beginPath();
  roundRectPath(ctx, 3 * u, depth + 3 * u, w, h, 4 * u);
  ctx.fill();
  plate(ctx, 0, 0, w, h, depth, 3 * u, theme.baseplate, theme.baseplateSide);
  ctx.strokeStyle = theme.baseplateEdge;
  ctx.lineWidth = 1 * u;
  ctx.beginPath();
  roundRectPath(ctx, 0.5 * u, 0.5 * u, w - u, h - u, 3 * u);
  ctx.stroke();
}

/** One round Lego stud per free cell: shadow, body and a small highlight, each as a single batched path. */
function drawStuds(ctx, scene, theme, range, cellPx) {
  const { cs, cols, occ } = scene;
  const r = cs * 0.2;
  const passes = [[theme.studLo, 0, r * 0.2, 1], [theme.stud, 0, 0, 1], [theme.studHi, -r * 0.28, -r * 0.3, 0.34]];
  const used = cellPx >= 22 ? passes : passes.slice(0, 2);
  for (const [color, ox, oy, scale] of used) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let cy = range.r0; cy <= range.r1; cy++) {
      for (let cx = range.c0; cx <= range.c1; cx++) {
        if (occ[cy * cols + cx] & (OCC_ROAD | OCC_STATION | OCC_OBSTACLE)) continue;
        const x = (cx + 0.5) * cs + ox;
        const y = (cy + 0.5) * cs + oy;
        ctx.moveTo(x + r * scale, y);
        ctx.arc(x, y, r * scale, 0, TAU);
      }
    }
    ctx.fill();
  }
}

/** Cell boundaries as device-pixel-aligned hairlines; every 5th (or 10th when zoomed out) is emphasised. */
function drawGrid(ctx, scene, theme, range, o, cellPx) {
  const { cs, cols, rows } = scene;
  const { k, win } = o;
  const snapX = (v) => win.x0 + (Math.floor((v - win.x0) * k) + 0.5) / k;
  const snapY = (v) => win.y0 + (Math.floor((v - win.y0) * k) + 0.5) / k;
  const major = cellPx >= 8 ? 5 : 10;
  const x0 = range.c0 * cs;
  const x1 = (range.c1 + 1) * cs;
  const y0 = range.r0 * cs;
  const y1 = (range.r1 + 1) * cs;
  ctx.lineWidth = 1 / k;
  ctx.lineCap = 'butt';
  for (const isMajor of [false, true]) {
    if (!isMajor && cellPx < 12) continue;
    ctx.strokeStyle = isMajor ? theme.gridMajor : theme.gridLine;
    ctx.beginPath();
    for (let c = range.c0; c <= range.c1 + 1 && c <= cols; c++) {
      if ((c % major === 0) !== isMajor) continue;
      const x = snapX(c * cs);
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let r = range.r0; r <= range.r1 + 1 && r <= rows; r++) {
      if ((r % major === 0) !== isMajor) continue;
      const y = snapY(r * cs);
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
  }
  ctx.lineCap = 'round';
}

// ---- obstacles -------------------------------------------------------------------------------------

function drawObstacles(ctx, scene, theme, win, u, cellPx) {
  const cs = scene.cs;
  const visible = [];
  for (const o of scene.obstacles) {
    if (overlaps(win, o.x * cs, o.y * cs, o.w * cs, o.h * cs)) visible.push(o);
  }
  const depth = Math.min(3 * u, cs * 0.2);
  // slabs first, so the top face of a neighbouring piece is never covered by this piece's thickness
  for (const o of visible) {
    const pal = theme.obstacle[o.kind] || theme.obstacle.wall;
    ctx.fillStyle = pal.edge;
    ctx.beginPath();
    roundRectPath(ctx, o.x * cs, o.y * cs + depth, o.w * cs, o.h * cs, o.kind === 'column' ? cs * 0.18 : 1.5 * u);
    ctx.fill();
  }
  for (const o of visible) {
    const x = o.x * cs;
    const y = o.y * cs;
    const w = o.w * cs;
    const h = o.h * cs;
    const pal = theme.obstacle[o.kind] || theme.obstacle.wall;
    ctx.fillStyle = pal.fill;
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, o.kind === 'column' ? cs * 0.18 : 1.5 * u);
    ctx.fill();
    if (o.kind === 'rack') drawRackDetail(ctx, theme, pal, x, y, w, h, cs, u, cellPx);
    else if (o.kind === 'column') drawColumnDetail(ctx, pal, x, y, w, h, cs, u);
    else drawWallHatch(ctx, pal, x, y, w, h, u, cellPx);
  }
}

function drawWallHatch(ctx, pal, x, y, w, h, u, cellPx) {
  if (cellPx < 8) return;
  const spacing = 7 * u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = pal.hatch;
  ctx.lineWidth = 1.1 * u;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  // world-aligned diagonals (x - y = n * spacing) so hatching continues across neighbouring wall pieces
  for (let n = Math.floor((x - (y + h)) / spacing); n <= Math.ceil((x + w - y) / spacing); n++) {
    const sx = n * spacing + y;
    ctx.moveTo(sx, y);
    ctx.lineTo(sx + h, y + h);
  }
  ctx.stroke();
  ctx.restore();
}

function drawRackDetail(ctx, theme, pal, x, y, w, h, cs, u, cellPx) {
  const horizontal = w >= h;
  const long = horizontal ? w : h;
  const short = horizontal ? h : w;
  const bays = Math.max(1, Math.round(long / (cs * 0.5)));
  const bay = long / bays;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = pal.shelf;
  ctx.lineWidth = Math.max(0.8 * u, Math.min(1.4 * u, cs * 0.04));
  ctx.beginPath();
  for (let i = 1; i < bays; i++) {
    if (horizontal) { ctx.moveTo(x + i * bay, y + short * 0.08); ctx.lineTo(x + i * bay, y + short * 0.92); }
    else { ctx.moveTo(x + short * 0.08, y + i * bay); ctx.lineTo(x + short * 0.92, y + i * bay); }
  }
  if (horizontal) { ctx.moveTo(x + long * 0.01, y + short / 2); ctx.lineTo(x + long * 0.99, y + short / 2); }
  else { ctx.moveTo(x + short / 2, y + long * 0.01); ctx.lineTo(x + short / 2, y + long * 0.99); }
  ctx.stroke();
  if (cellPx >= 16 && short >= cs * 0.9) {
    ctx.fillStyle = pal.box;
    ctx.beginPath();
    const bw = bay * 0.62;
    const bh = short * 0.3;
    for (let i = 0; i < bays; i++) {
      for (let side = 0; side < 2; side++) {
        if ((i * 7 + side * 3) % 5 === 0) continue; // a few empty shelf slots look natural and are deterministic
        const along = (i + 0.5) * bay - bw / 2;
        const across = side === 0 ? short * 0.5 - bh - short * 0.06 : short * 0.5 + short * 0.06;
        if (horizontal) roundRectPath(ctx, x + along, y + across, bw, bh, 1 * u);
        else roundRectPath(ctx, x + across, y + along, bh, bw, 1 * u);
      }
    }
    ctx.fill();
  }
  ctx.restore();
}

function drawColumnDetail(ctx, pal, x, y, w, h, cs, u) {
  const inset = cs * 0.2;
  ctx.strokeStyle = pal.ring;
  ctx.lineWidth = 1.2 * u;
  ctx.beginPath();
  roundRectPath(ctx, x + inset, y + inset, w - 2 * inset, h - 2 * inset, cs * 0.08);
  ctx.moveTo(x + inset, y + inset);
  ctx.lineTo(x + w - inset, y + h - inset);
  ctx.moveTo(x + w - inset, y + inset);
  ctx.lineTo(x + inset, y + h - inset);
  ctx.globalAlpha = 0.65;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ---- roads -----------------------------------------------------------------------------------------------

function drawRoads(ctx, scene, theme, o, u) {
  const { cs, cols, rows, occ } = scene;
  const win = o.win;
  const e = 0.4 / o.k; // plates overlap by under half a device pixel so no seams show between cells
  const rim = 1.3 * u;
  const isRoad = (cx, cy) => cx >= 0 && cy >= 0 && cx < cols && cy < rows && (occ[cy * cols + cx] & OCC_ROAD) !== 0;
  const cells = scene.roads.filter(({ cx, cy }) => overlaps(win, cx * cs, cy * cs, cs, cs));
  ctx.fillStyle = theme.road;
  ctx.beginPath();
  for (const { cx, cy } of cells) ctx.rect(cx * cs - e, cy * cs - e, cs + 2 * e, cs + 2 * e);
  ctx.fill();
  // exposed plate edges: light on the north / west sides, dark on the south / east sides
  ctx.lineCap = 'butt';
  ctx.lineWidth = rim;
  for (const hiSide of [true, false]) {
    ctx.strokeStyle = hiSide ? theme.roadEdgeHi : theme.roadEdgeLo;
    ctx.beginPath();
    for (const { cx, cy } of cells) {
      const x = cx * cs;
      const y = cy * cs;
      const h = rim / 2;
      if (hiSide) {
        if (!isRoad(cx, cy - 1)) { ctx.moveTo(x, y + h); ctx.lineTo(x + cs, y + h); }
        if (!isRoad(cx - 1, cy)) { ctx.moveTo(x + h, y); ctx.lineTo(x + h, y + cs); }
      } else {
        if (!isRoad(cx, cy + 1)) { ctx.moveTo(x, y + cs - h); ctx.lineTo(x + cs, y + cs - h); }
        if (!isRoad(cx + 1, cy)) { ctx.moveTo(x + cs - h, y); ctx.lineTo(x + cs - h, y + cs); }
      }
    }
    ctx.stroke();
  }
  ctx.lineCap = 'round';
}

function drawSpeedZones(ctx, scene, theme, win, u) {
  const { cs, cols, limit, roads } = scene;
  const slow = roads.filter(({ cx, cy }) => limit[cy * cols + cx] < 1 && overlaps(win, cx * cs, cy * cs, cs, cs));
  if (!slow.length) return;
  ctx.save();
  ctx.beginPath();
  for (const { cx, cy } of slow) ctx.rect(cx * cs, cy * cs, cs, cs);
  ctx.fillStyle = theme.zoneFill;
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = theme.zoneHatch;
  ctx.lineWidth = 1.3 * u;
  ctx.lineCap = 'butt';
  const spacing = 7 * u;
  const y0 = Math.max(win.y0, 0);
  const y1 = Math.min(win.y1, scene.height);
  const x0 = Math.max(win.x0, 0);
  const x1 = Math.min(win.x1, scene.width);
  ctx.beginPath();
  for (let n = Math.floor((x0 - y1) / spacing); n <= Math.ceil((x1 - y0) / spacing); n++) {
    ctx.moveTo(n * spacing + y0, y0);
    ctx.lineTo(n * spacing + y1, y1);
  }
  ctx.stroke();
  ctx.restore();
}

/** Dashed centre lines on two-way links and chevrons on one-way links. */
function drawMarkings(ctx, scene, theme, win, u, cellPx) {
  if (cellPx < 7) return;
  const { cs, twoWay, oneWay } = scene;
  const half = cs / 2;
  const inWin = (cx, cy) => overlaps(win, (cx - 1) * cs, (cy - 1) * cs, 3 * cs, 3 * cs);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = theme.roadMark;
  ctx.lineWidth = clamp(cellPx * 0.035, 1, 2.4) * u;
  ctx.setLineDash([cs * 0.2, cs * 0.14]);
  ctx.beginPath();
  for (let i = 0; i < twoWay.length; i += 3) {
    const cx = twoWay[i];
    const cy = twoWay[i + 1];
    if (!inWin(cx, cy)) continue;
    const d = twoWay[i + 2];
    ctx.moveTo(cx * cs + half, cy * cs + half);
    ctx.lineTo((cx + DX[d]) * cs + half, (cy + DY[d]) * cs + half);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (cellPx < 9) return;
  ctx.lineCap = 'round';
  ctx.strokeStyle = theme.roadChevron;
  ctx.lineWidth = clamp(cellPx * 0.05, 1.3, 3) * u;
  const s = cs * 0.16;
  ctx.beginPath();
  for (let i = 0; i < oneWay.length; i += 3) {
    const cx = oneWay[i];
    const cy = oneWay[i + 1];
    if (!inWin(cx, cy)) continue;
    const dx = DX[oneWay[i + 2]];
    const dy = DY[oneWay[i + 2]];
    const mx = (cx + 0.5 + dx / 2) * cs;
    const my = (cy + 0.5 + dy / 2) * cs;
    // tip ahead of the border, tails behind it and to both sides
    ctx.moveTo(mx - dx * s - dy * s * 1.1, my - dy * s - dx * s * 1.1);
    ctx.lineTo(mx + dx * s, my + dy * s);
    ctx.lineTo(mx - dx * s + dy * s * 1.1, my - dy * s + dx * s * 1.1);
  }
  ctx.stroke();
}
