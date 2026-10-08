// Station bricks: the Lego-style look of stations (rounded body with a darker front edge, lighter top
// face, a grid of studs, name tile with icon) plus the live overlays that appear when a simulation is
// attached (state dot, fill bar, per-machine progress, yard badge, depot bays). Drawn in CSS-pixel space.
//
// Face layout, top to bottom: one header row [yard badge] [name tile] [state dot], centred as a group, then the
// live overlays (machine bars, fill bar / delivered chip / depot bays). The row is laid out as a whole, so the
// dot and the badge can never collide with the name: the tile gets whatever width is left. Studs are left out of
// every stud row that content touches, which keeps the remaining pattern regular.
//
// Everything is derived from `fr` (the renderer's per-frame state) and the runtime station object `rt`
// (StationRT of docs/ARCHITECTURE.md 5.3, or null in edit mode).

import { STATION_TYPES } from '../../model/defaults.js';
import { STATUS_COLORS, STATUS_INK } from '../theme.js';
import { fitText } from './geometry.js';
import { TAU, roundRectPath, fontOf, measure, fillPill } from './draw.js';
import { drawStationIcon, drawStatusMark, drawBolt, drawBox } from './glyphs.js';
import { drawVehicleIcon } from './vehicles.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Largest number of machine bars shown as stacked rows; beyond that they become vertical columns. */
const MAX_ROW_BARS = 4;
const MAX_COLUMN_BARS = 24;
const MAX_BAYS = 48;
/** Smallest icon (px) worth drawing, and the shortest name stubs (visible characters) worth showing. */
const MIN_ICON_PX = 8;
const MIN_STUB_WITH_ICON = 6;
const MIN_STUB_ALONE = 4;
/** Bezel of the state dot (px): light rim around a dark ring around the status colour. */
const DOT_RIM = 1.1;
const DOT_RING = 1.6;
/** Gap between the items of the header row. */
const ROW_GAP = 4;
/** Bricks smaller than this (px, zoomed far out) are drawn as a flat swatch. */
const SWATCH_PX = 5;

/** name -> per-station cache of ellipsised names, two slots (with / without icon): { font, name, keys, texts }. */
const fitCache = new WeakMap();

/**
 * Pixel geometry of a brick whose footprint is the world rectangle (mx, my, mw, mh) in metres:
 * `x, y, w, h` = top face, `bodyH` = top face + front edge, `depth`, `r` radius, `cell` = cell size in px.
 * Edges are snapped to device pixels so bricks stay crisp.
 */
function brickGeometry(fr, mx, my, mw, mh, g = {}) {
  const z = fr.zoom;
  const cell = fr.cs * z;
  const gap = clamp(cell * 0.05, 0.5, 4);
  const sn = (v) => Math.round(v * fr.dpr) / fr.dpr;
  const x0 = sn(fr.ox + mx * z + gap);
  const x1 = sn(fr.ox + (mx + mw) * z - gap);
  const y0 = sn(fr.oy + my * z + gap);
  const y1 = sn(fr.oy + (my + mh) * z - gap);
  g.x = x0;
  g.y = y0;
  g.w = Math.max(0, x1 - x0);
  g.bodyH = Math.max(0, y1 - y0);
  g.depth = Math.min(clamp(cell * 0.1, 2, 8), g.bodyH * 0.25);
  g.h = g.bodyH - g.depth;
  g.r = Math.min(clamp(cell * 0.16, 2, 14), g.w / 2, g.h / 2);
  g.cell = cell;
  g.cols = Math.max(1, Math.round(mw / fr.cs));
  g.rows = Math.max(1, Math.round(mh / fr.cs));
  g.originX = fr.ox + mx * z;
  g.originY = fr.oy + my * z;
  return g;
}

/** Draw all stations of the scene. Expects the CSS-pixel transform. */
export function drawStations(ctx, fr) {
  const vis = fr.vis;
  for (const e of fr.scene.stations) {
    if (e.x > vis.x1 || e.x + e.w < vis.x0 || e.y > vis.y1 || e.y + e.h < vis.y0) continue;
    drawBrick(ctx, fr, e.st.type, e, e.st, fr.rtOf(e.st.id), 1);
  }
}

/**
 * Draw one brick.
 * @param {object} rect world rectangle {x, y, w, h} in metres
 * @param {object|null} st layout station (for name and params), null for a placement ghost
 * @param {object|null} rt runtime station or null
 * @param {number} alpha 1 for placed bricks, < 1 for ghosts
 */
export function drawBrick(ctx, fr, type, rect, st, rt, alpha) {
  const pal = fr.theme.station[type] || fr.theme.station.process;
  const g = brickGeometry(fr, rect.x, rect.y, rect.w, rect.h, fr.brick);
  if (g.w < SWATCH_PX || g.h < SWATCH_PX) {
    drawSwatch(ctx, fr, pal, rect, alpha);
    return;
  }
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  roundRectPath(ctx, g.x + 1, g.y + g.depth + 2, g.w, g.bodyH, g.r + 1);
  ctx.fillStyle = fr.theme.shadow;
  ctx.fill();
  ctx.beginPath();
  roundRectPath(ctx, g.x, g.y, g.w, g.bodyH, g.r);
  ctx.fillStyle = pal.edge;
  ctx.fill();
  ctx.beginPath();
  roundRectPath(ctx, g.x, g.y, g.w, g.h, g.r);
  ctx.fillStyle = pal.top;
  ctx.fill();
  ctx.beginPath();
  roundRectPath(ctx, g.x + 0.5, g.y + 0.5, g.w - 1, g.h - 1, Math.max(0, g.r - 0.5));
  ctx.lineWidth = 1;
  ctx.strokeStyle = pal.hi;
  ctx.globalAlpha = alpha * 0.55;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  const plan = g.w >= 14 && g.h >= 12 ? planContent(ctx, fr, g, type, st, rt) : null;
  if (g.cell >= 16) drawStuds(ctx, g, pal, plan);
  if (plan) paintContent(ctx, fr, g, pal, type, st, rt, plan);
  ctx.globalAlpha = 1;
}

/** A flat rounded square in the brick colour, for bricks too small to show any detail (zoomed far out). */
function drawSwatch(ctx, fr, pal, rect, alpha) {
  const z = fr.zoom;
  const size = Math.max(SWATCH_PX - 1, Math.min(rect.w, rect.h) * z);
  const x = fr.ox + (rect.x + rect.w / 2) * z - size / 2;
  const y = fr.oy + (rect.y + rect.h / 2) * z - size / 2;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  roundRectPath(ctx, x, y, size, size, size * 0.25);
  ctx.fillStyle = pal.top;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = pal.edge;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

let rowSkip = new Uint8Array(64);

/**
 * Studs on the top face, one per cell. A stud row that any content covers is left out as a whole (rather than
 * only the covered studs), so what remains is a regular pattern.
 */
function drawStuds(ctx, g, pal, plan) {
  const r = g.cell * 0.17;
  const cy = (j) => g.originY + (j + 0.5) * g.cell - g.depth * 0.5;
  if (rowSkip.length < g.rows) rowSkip = new Uint8Array(g.rows * 2);
  for (let j = 0; j < g.rows; j++) {
    rowSkip[j] = plan && rowCovered(plan, g, cy(j), r + 2) ? 1 : 0;
  }
  const passes = g.cell >= 26 ? 3 : 2;
  for (let p = 0; p < passes; p++) {
    ctx.fillStyle = p === 0 ? pal.studLo : p === 1 ? pal.stud : pal.studHi;
    const ox = p === 2 ? -r * 0.26 : 0;
    const oy = p === 0 ? r * 0.22 : p === 2 ? -r * 0.3 : 0;
    const rr = p === 2 ? r * 0.36 : r;
    ctx.beginPath();
    for (let j = 0; j < g.rows; j++) {
      if (rowSkip[j] === 1) continue;
      const y = cy(j) + oy;
      for (let i = 0; i < g.cols; i++) {
        const x = g.originX + (i + 0.5) * g.cell + ox;
        ctx.moveTo(x + rr, y);
        ctx.arc(x, y, rr, 0, TAU);
      }
    }
    ctx.fill();
  }
}

/** Does any content block touch the stud row centred at y (stud radius r, any column)? */
function rowCovered(plan, g, y, r) {
  for (const b of plan.blocks) {
    if (y + r <= b.y || y - r >= b.y + b.h) continue;
    for (let i = 0; i < g.cols; i++) {
      const x = g.originX + (i + 0.5) * g.cell;
      if (x + r > b.x && x - r < b.x + b.w) return true;
    }
  }
  return false;
}

// ---- content: header row (badge, name tile, state dot) + live overlays -------------------------------------

/**
 * Lay out the face. Returns the positions of the header row items and of the live overlays beneath, plus the
 * rectangles (`blocks`) the studs must avoid; null items are absent.
 */
export function planContent(ctx, fr, g, type, st, rt) {
  const pad = clamp(g.cell * 0.1, 3, 9);
  const fpx = clamp(g.cell * 0.27, 10, 19);
  const innerW = g.w - 2 * pad;
  const name = st ? st.name : (STATION_TYPES[type] || STATION_TYPES.process).short;
  const dot = planDot(g, rt, pad);
  const badge = planBadge(ctx, fr, g, type, rt, dot, innerW);
  const reserve = (dot ? dot.d + ROW_GAP : 0) + (badge ? badge.w + ROW_GAP : 0);
  const tile = layoutTile(ctx, fr.theme, fpx, innerW - reserve, g, name, fr.overlays.labels !== false, st);
  const items = (badge ? 1 : 0) + (tile.h > 0 ? 1 : 0) + (dot ? 1 : 0);
  const rowH = Math.max(tile.h, dot ? dot.d : 0, badge ? badge.h : 0);
  const rowW = (badge ? badge.w : 0) + tile.w + (dot ? dot.d : 0) + Math.max(0, items - 1) * ROW_GAP;
  const live = planOverlays(type, rt, g, rowH, pad, fpx);
  const gap = live && rowH > 0 ? 5 : 0;
  const total = rowH + gap + (live ? live.h : 0);
  const top = clamp(g.y + (g.h - total) / 2, g.y + Math.min(pad, 3), g.y + g.h);
  const plan = { pad, fpx, innerW, tile, dot, badge, live, top, rowH, liveY: top + rowH + gap, tileX: 0, blocks: [] };
  let x = g.x + (g.w - rowW) / 2;
  if (badge) {
    badge.x = x;
    badge.y = top + (rowH - badge.h) / 2;
    plan.blocks.push({ x: badge.x, y: badge.y, w: badge.w, h: badge.h });
    x += badge.w + ROW_GAP;
  }
  if (tile.h > 0) {
    plan.tileX = x;
    plan.tileY = top + (rowH - tile.h) / 2;
    plan.blocks.push({ x, y: plan.tileY, w: tile.w, h: tile.h });
    x += tile.w + ROW_GAP;
  }
  if (dot) {
    dot.x = x + dot.d / 2;
    dot.y = top + rowH / 2;
    plan.blocks.push({ x, y: top + (rowH - dot.d) / 2, w: dot.d, h: dot.d });
  }
  if (live) plan.blocks.push({ x: g.x + pad, y: plan.liveY, w: innerW, h: live.h });
  return plan;
}

function paintContent(ctx, fr, g, pal, type, st, rt, plan) {
  const { tile, live, dot, badge, pad, fpx, innerW } = plan;
  if (tile.h > 0) drawTile(ctx, fr.theme, pal, type, tile, plan.tileX, plan.tileY, fpx);
  if (badge) drawYardBadge(ctx, fr, badge);
  if (dot) drawStateDot(ctx, fr, dot, rt);
  if (live) drawOverlays(ctx, fr, pal, rt, st, live, g.x + pad, plan.liveY, innerW);
}

/** State dot plan (radius `r`, outer diameter `d` incl. bezel), or null without a runtime station or room. */
function planDot(g, rt, pad) {
  if (!rt) return null;
  const r = clamp(g.cell * 0.14, 4.5, 9);
  const d = 2 * (r + DOT_RIM + DOT_RING);
  if (g.h < d + 4 || g.w < d + 2 * pad + 4) return null;
  return { r, d, x: 0, y: 0 };
}

/** Backlog badge plan of a source with a full output buffer, or null. */
function planBadge(ctx, fr, g, type, rt, dot, innerW) {
  if (type !== 'source' || !rt || !(rt.yard > 0)) return null;
  const h = clamp(g.cell * 0.28, 14, 22);
  const text = String(rt.yard);
  ctx.font = fontOf(fr.theme, 700, h * 0.62);
  const w = h + measure(ctx, text) + 6;
  if (g.h < h + 4 || w + (dot ? dot.d + ROW_GAP : 0) > innerW) return null;
  return { w, h, text, x: 0, y: 0 };
}

/**
 * Size the name tile for `avail` px of width: icon + name, name only, icon + shortened name, shortened name,
 * icon only, or nothing, in that order of preference (a full name beats an icon; a stub of a name is only kept
 * when it still says something). Heights follow the brick so even small bricks keep an icon.
 */
function layoutTile(ctx, theme, fpx, avail, g, name, showText, st) {
  const tile = { w: 0, h: 0, icon: 0, text: '', textW: 0, padX: 0, gap: 0 };
  const padY = clamp(fpx * 0.25, 2.5, 5);
  const padX = clamp(fpx * 0.45, 3, 9);
  const gap = clamp(fpx * 0.4, 3, 8);
  const maxH = g.h - 3;
  const icon = Math.min(clamp(fpx * 1.12, 12, 24), maxH - 2 * padY);
  const canIcon = icon >= MIN_ICON_PX;
  let useIcon = false;
  let text = '';
  if (showText && name && maxH >= fpx + 2 * padY && avail > 0) {
    ctx.font = fontOf(theme, 600, fpx);
    const room = [canIcon ? avail - 2 * padX - icon - gap : -1, avail - 2 * padX];
    const full = measure(ctx, name);
    if (room[0] >= full) { useIcon = true; text = name; } else if (room[1] >= full) text = name;
    else {
      const withIcon = room[0] >= fpx * 1.6 ? fitName(ctx, st, name, room[0], 0) : '';
      const alone = room[1] >= fpx * 1.6 ? fitName(ctx, st, name, room[1], 1) : '';
      if (withIcon.length > MIN_STUB_WITH_ICON) { useIcon = true; text = withIcon; } else if (alone.length > MIN_STUB_ALONE) text = alone;
    }
  }
  if (!text && canIcon && avail >= icon + 4) useIcon = true;
  if (!text && !useIcon) return tile;
  tile.icon = useIcon ? icon : 0;
  tile.text = text;
  tile.textW = text ? measure(ctx, text) : 0;
  tile.gap = gap;
  tile.padX = text ? padX : Math.max(2, Math.min(padX, (avail - icon) / 2));
  tile.w = 2 * tile.padX + tile.icon + (text && useIcon ? gap : 0) + tile.textW;
  tile.h = Math.max(tile.icon, text ? fpx : 0) + 2 * padY;
  return tile;
}

/**
 * Ellipsised station name for `avail` px, cached per station object while font, name and width stay the
 * same. Slot 0 is the with-icon width, slot 1 the without-icon width (two widths per frame must not evict each other).
 */
function fitName(ctx, st, name, avail, slot) {
  const key = Math.round(avail);
  let c = st ? fitCache.get(st) : null;
  if (c && (c.font !== ctx.font || c.name !== name)) c = null;
  if (c && c.keys[slot] === key) return c.texts[slot];
  const text = fitText((s) => measure(ctx, s), name, avail);
  if (st) {
    if (!c) {
      c = { font: ctx.font, name, keys: [-1, -1], texts: ['', ''] };
      fitCache.set(st, c);
    }
    c.keys[slot] = key;
    c.texts[slot] = text;
  }
  return text;
}

function drawTile(ctx, theme, pal, type, tile, x, y, fpx) {
  ctx.beginPath();
  roundRectPath(ctx, x, y, tile.w, tile.h, Math.min(tile.h / 2, 9));
  ctx.fillStyle = theme.tile;
  ctx.fill();
  if (tile.icon > 0) {
    const iconX = tile.text ? x + tile.padX + tile.icon / 2 : x + tile.w / 2;
    drawStationIcon(ctx, type, iconX, y + tile.h / 2, tile.icon, pal.icon);
  }
  if (tile.text) {
    ctx.font = fontOf(theme, 600, fpx);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.tileInk;
    ctx.fillText(tile.text, x + tile.padX + (tile.icon > 0 ? tile.icon + tile.gap : 0), y + tile.h / 2 + 0.5);
  }
}

// ---- live overlays ------------------------------------------------------------------------------------

/**
 * Decide which overlays fit below the header row and how tall they are, or null for none. Depots always
 * show their bays; everything else needs a runtime station. Overlays are dropped in order of importance
 * when the face is too small (machine bars first).
 */
function planOverlays(type, rt, g, rowH, pad, fpx) {
  const room = g.h - 2 * Math.min(pad, 3) - rowH - (rowH > 0 ? 5 : 0);
  const barH = clamp(fpx * 0.85, 9, 14);
  if (type === 'depot') return room >= 16 ? { h: room, bays: true } : null;
  if (!rt) return null;
  if (type === 'sink') return rt.consumed > 0 && room >= barH + 2 ? { h: barH + 2, chip: true, barH } : null;
  const plan = { h: 0, barH, bar: false, machines: 0, machinesH: 0 };
  if (room >= barH) { plan.bar = true; plan.h = barH; }
  const machines = type === 'process' && Array.isArray(rt.machines) ? rt.machines.length : 0;
  const mH = machines <= MAX_ROW_BARS ? machines * clamp(g.cell * 0.085, 3.5, 7) + Math.max(0, machines - 1) * 2 : clamp(g.cell * 0.32, 10, 22);
  if (machines > 0 && room >= plan.h + mH + 4) { plan.machines = machines; plan.machinesH = mH; plan.h += mH + 4; }
  return plan.h > 0 ? plan : null;
}

function drawOverlays(ctx, fr, pal, rt, st, live, x, y, w) {
  if (live.bays) {
    drawBays(ctx, fr, pal, st ? st.params : null, rt, x, y, w, live.h);
    return;
  }
  let cy = y;
  if (live.machines > 0) {
    drawMachines(ctx, pal, rt.machines, x, cy, w, live.machinesH);
    cy += live.machinesH + 4;
  }
  if (live.bar) drawFillBar(ctx, fr, pal, rt, x, cy, w, live.barH);
  if (live.chip) drawCountChip(ctx, fr, pal, rt.consumed, x, cy, w, live.barH);
}

const MACHINE_COLORS = { busy: 'busy', blocked: 'blocked', down: 'down' };

/** One progress bar per machine: green while busy, orange when blocked by a full output, red when down. */
function drawMachines(ctx, pal, machines, x, y, w, h) {
  const n = Math.min(machines.length, MAX_COLUMN_BARS);
  if (machines.length <= MAX_ROW_BARS) {
    const bh = (h - (n - 1) * 2) / n;
    for (let i = 0; i < n; i++) {
      const m = machines[i];
      const by = y + i * (bh + 2);
      ctx.beginPath();
      roundRectPath(ctx, x, by, w, bh, bh / 2);
      ctx.fillStyle = pal.track;
      ctx.fill();
      const frac = machineFill(m);
      if (frac > 0) {
        ctx.beginPath();
        roundRectPath(ctx, x, by, Math.max(bh, w * frac), bh, bh / 2);
        ctx.fillStyle = machineColor(m);
        ctx.fill();
      }
    }
    return;
  }
  const gap = 2;
  const bw = Math.min(14, (w - (n - 1) * gap) / n);
  const total = n * bw + (n - 1) * gap;
  const x0 = x + (w - total) / 2;
  for (let i = 0; i < n; i++) {
    const m = machines[i];
    const bx = x0 + i * (bw + gap);
    ctx.beginPath();
    roundRectPath(ctx, bx, y, bw, h, Math.min(2.5, bw / 2));
    ctx.fillStyle = pal.track;
    ctx.fill();
    const fh = h * machineFill(m);
    if (fh > 0) {
      ctx.beginPath();
      roundRectPath(ctx, bx, y + h - Math.max(fh, bw), bw, Math.max(fh, bw), Math.min(2.5, bw / 2));
      ctx.fillStyle = machineColor(m);
      ctx.fill();
    }
  }
}

function machineFill(m) {
  if (m.state === 'blocked' || m.state === 'down') return 1;
  return m.state === 'busy' ? clamp(Number.isFinite(m.progress) ? m.progress : 0, 0, 1) : 0;
}

function machineColor(m) {
  return STATUS_COLORS[MACHINE_COLORS[m.state] || 'idle'];
}

/** Buffer fill bar with its "3/8" label; turns orange when the buffer is nearly full. */
function drawFillBar(ctx, fr, pal, rt, x, y, w, h) {
  const frac = clamp(Number.isFinite(rt.fill) ? rt.fill : 0, 0, 1);
  const label = typeof rt.fillLabel === 'string' ? rt.fillLabel : '';
  const fpx = clamp(h * 0.85, 9, 13);
  let barW = w;
  let labelW = 0;
  if (label) {
    ctx.font = fontOf(fr.theme, 700, fpx);
    labelW = measure(ctx, label);
    barW = w - labelW - 6;
    if (barW < w * 0.35) { labelW = 0; barW = w; }
  }
  const bh = Math.min(h, 8);
  const by = y + (h - bh) / 2;
  ctx.beginPath();
  roundRectPath(ctx, x, by, barW, bh, bh / 2);
  ctx.fillStyle = pal.track;
  ctx.fill();
  if (frac > 0) {
    ctx.beginPath();
    roundRectPath(ctx, x, by, Math.max(bh, barW * frac), bh, bh / 2);
    ctx.fillStyle = frac >= 0.85 ? STATUS_COLORS.blocked : pal.bar;
    ctx.fill();
  }
  if (labelW > 0) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = pal.ink;
    ctx.fillText(label, x + w, y + h / 2 + 0.5);
  }
}

/** "n delivered" chip on a sink. */
function drawCountChip(ctx, fr, pal, count, x, y, w, h) {
  const text = String(count);
  const fpx = clamp(h * 0.85, 9, 13);
  ctx.font = fontOf(fr.theme, 700, fpx);
  const tw = measure(ctx, text);
  const cw = Math.min(w, tw + h + 8);
  const cx = x + (w - cw) / 2;
  fillPill(ctx, cx, y, cw, h, pal.track);
  drawBox(ctx, cx + h / 2 + 1, y + h / 2, h * 0.5, pal.bar, pal.edge);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = pal.ink;
  ctx.fillText(text, cx + cw - 5, y + h / 2 + 0.5);
}

/**
 * Vehicle shown in bay `i` of a depot with `slots` bays of which the first `chargers` can charge, or null.
 * Charging vehicles take the charger bays from the front; parked vehicles fill the plain bays first and spill
 * into the charger bays that are free. So the bays show every vehicle the depot holds (up to `slots`).
 * @param {object[]} charging vehicles charging now
 * @param {object[]} parked vehicles parked without charging
 */
export function bayOccupant(i, slots, chargers, charging, parked) {
  const charge = Math.min(charging.length, chargers);
  if (i < charge) return charging[i] || null;
  const index = i >= chargers ? i - chargers : slots - chargers + (i - charge);
  return parked[index] || null;
}

const NO_VEHICLES = Object.freeze([]);

/**
 * Parking bays of a depot: `slots` portrait bays, the first `chargers` carry a bolt. With a runtime
 * station the parked / charging vehicles are drawn as silhouettes in their fleet colour (see bayOccupant);
 * the bolt lights up in a bay whose vehicle is actually charging.
 */
function drawBays(ctx, fr, pal, params, rt, x, y, w, h) {
  const slots = clamp(Math.floor(rt && Number.isFinite(rt.slots) ? rt.slots : (params && params.slots) || 0), 0, MAX_BAYS);
  const chargers = Math.min(slots, Math.max(0, Math.floor(rt && Number.isFinite(rt.chargers) ? rt.chargers : (params && params.chargers) || 0)));
  if (slots === 0 || w < 12 || h < 12) return;
  const gap = clamp(fr.cs * fr.zoom * 0.04, 3, 6);
  const cap = clamp(fr.cs * fr.zoom * 0.42, 14, 64); // bays grow with the brick but stay bay-sized
  let best = null;
  for (let cols = 1; cols <= slots; cols++) {
    const rows = Math.ceil(slots / cols);
    const bw = Math.min((w - (cols - 1) * gap) / cols, ((h - (rows - 1) * gap) / rows) * 0.7, cap);
    if (!best || bw > best.bw - 0.01) best = { cols, rows, bw }; // ties go to the wider arrangement
  }
  const bw = Math.max(5, best.bw);
  const bh = bw / 0.7;
  const rowW = best.cols * bw + (best.cols - 1) * gap;
  const gridH = best.rows * bh + (best.rows - 1) * gap;
  const x0 = x + (w - rowW) / 2;
  const y0 = y + Math.max(0, (h - gridH) / 2);
  const charging = rt && Array.isArray(rt.charging) ? rt.charging : NO_VEHICLES;
  const parked = rt && Array.isArray(rt.parked) ? rt.parked : NO_VEHICLES;
  const charge = Math.min(charging.length, chargers);
  for (let i = 0; i < slots; i++) {
    const bx = x0 + (i % best.cols) * (bw + gap);
    const by = y0 + Math.floor(i / best.cols) * (bh + gap);
    const occupant = bayOccupant(i, slots, chargers, charging, parked);
    ctx.beginPath();
    roundRectPath(ctx, bx, by, bw, bh, 2.5);
    ctx.fillStyle = pal.track;
    ctx.fill();
    if (!occupant) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = pal.inkDim;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      drawVehicleIcon(ctx, fr.theme, occupant.color, bx + bw / 2, by + bh / 2, bh * 0.82, bw * 0.74);
    }
    if (i < chargers && bw >= 9) {
      const active = i < charge;
      drawBolt(ctx, bx + bw / 2, by + bh - bw * 0.3, bw * 0.62, active ? fr.theme.vehicle.bolt : pal.inkDim, active ? fr.theme.vehicle.badgeFill : null);
    }
  }
}

/** State dot with its bezel and a mark inside, so the state is not conveyed by colour alone. */
function drawStateDot(ctx, fr, dot, rt) {
  const theme = fr.theme;
  const state = typeof rt.state === 'string' ? rt.state : 'idle';
  const { x, y, r } = dot;
  ctx.beginPath();
  ctx.arc(x, y, r + DOT_RING + DOT_RIM, 0, TAU);
  ctx.fillStyle = theme.dotRim;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r + DOT_RING, 0, TAU);
  ctx.fillStyle = theme.dotRing;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = theme.statusColor(state);
  ctx.fill();
  if (r >= 5) drawStatusMark(ctx, state, x, y, r, STATUS_INK);
}

/** Orange backlog badge of a source whose output buffer is full. */
function drawYardBadge(ctx, fr, badge) {
  const { x, y, w, h, text } = badge;
  ctx.font = fontOf(fr.theme, 700, h * 0.62);
  fillPill(ctx, x, y, w, h, '#ffffff');
  fillPill(ctx, x + 1.5, y + 1.5, w - 3, h - 3, STATUS_COLORS.blocked);
  drawBox(ctx, x + h / 2 + 0.5, y + h / 2, h * 0.46, '#ffe3cf', '#8a3a05');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x + h + 0.5, y + h / 2 + 0.5);
}
