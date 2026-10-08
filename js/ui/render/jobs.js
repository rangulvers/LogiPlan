// Jobs overlay: where every vehicle is heading and where loads wait for one (docs/ARCHITECTURE.md 6.9). It answers the two
// questions a planner asks while the simulation runs: "which station is this vehicle going to?" and "why is nothing picked
// up here?".
//
//   drawJobLines      a thin dashed line from each vehicle that has an order to the dock it is driving to, with an
//                     arrow head: amber while it drives to PICK UP, blue while it carries the load to DELIVER. Lines fade
//                     with distance so a vehicle far from its target never clutters the plan; a label chip ("→ Goods in 2")
//                     appears when the plan is zoomed in far enough, or for a hovered vehicle / a selected fleet.
//   drawWaitingBadges a badge "3 waiting" on every station that has loads ready and not yet claimed by any vehicle;
//                     it turns red when the output buffer is (nearly) full, because the station then stops producing.
//   drawDockMarkers   a small mark at the station edge of every dock cell (drawn first, under the lines and vehicles): a hollow dot while the
//                     dock is free, a ring while a vehicle is on its way to it (reserved), a filled dot while a vehicle stands on it.
//
// Both read the live simulation only (vehicles: state, order, route; stations: outLinks), never stats.report(), and allocate
// nothing per frame once warmed up: positions go through the frame's pose buffer and a reusable line buffer, text widths
// and truncated names are cached. Switched by `view.overlays.jobs` (default on).

import { vehiclePose, vehicleSize } from './vehicles.js';
import { fontOf, fillPill, TAU } from './draw.js';
import { drawBox } from './glyphs.js';
import { STATUS_COLORS, STATUS_INK } from '../theme.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Below this zoom (px per metre) the lines are left out: at that scale a plant is a map and the lines are noise. */
export const LINE_MIN_ZOOM = 4;
/** From this zoom on every line carries a chip with the name of its target (below it only a hovered vehicle / selected fleet does). */
export const CHIP_MIN_ZOOM = 14;
/** The lowest zoom at which a hovered vehicle or a selected fleet still shows its chip. */
export const CHIP_FOCUS_MIN_ZOOM = 7;
/** From this zoom on the waiting badge says "3 waiting"; below it a round badge shows the bare number. */
export const BADGE_TEXT_MIN_ZOOM = 8;
/** Dock markers appear from this zoom (px per metre) on. */
export const DOCK_MARK_MIN_ZOOM = 8;
/** The badge is red from this share of the output buffer. */
export const HIGH_FILL = 0.8;
/** Most characters of a station name in a chip. */
export const CHIP_NAME_MAX = 16;
/** Lines are at full strength up to this distance (m) and at their faintest from FAR_M on. */
const NEAR_M = 6;
const FAR_M = 40;
const MIN_ALPHA = 0.55;
const MAX_ALPHA = 1;

/** Line colours per theme: heading to pick up (amber) and carrying to deliver (blue). */
const PALETTE = {
  light: Object.freeze({ pickup: '#e08600', drop: '#2b6fe0' }),
  dark: Object.freeze({ pickup: '#ffb224', drop: '#6aa6ff' }),
};
const BADGE_RED = '#c92a2a';
const BADGE_RED_INK = '#ffffff';

// ---- pure helpers (unit-tested in Node) ---------------------------------------------------------------------------

/** Id of the station vehicle `v` is driving to for an order, or null (no order, or not on a pickup / delivery leg). */
export function jobTarget(v) {
  const s = v.state;
  if (s !== 'toPickup' && s !== 'toDrop') return null;
  const order = v.order;
  const id = order ? (s === 'toPickup' ? order.from : order.to) : v.targetId;
  return typeof id === 'string' ? id : null;
}

/** Opacity of a job line of `distM` metres: strong when short, faint when long. */
export function fadeAlpha(distM) {
  const f = clamp((distM - NEAR_M) / (FAR_M - NEAR_M), 0, 1);
  return MAX_ALPHA - (MAX_ALPHA - MIN_ALPHA) * f;
}

/** "Goods in 2" -> "Goods in 2"; names longer than `max` characters are cut with an ellipsis. */
export function shortName(name, max = CHIP_NAME_MAX) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * Where a vehicle at (x, y) metres drives to for station `stationId`: the last cell of its current route when that cell is a
 * dock of the station, else the dock nearest by straight distance, else the middle of the station. Writes metres into `out`.
 * @param {object|null} graph sim.graph (docks: Map stationId -> node ids, x(id), y(id))
 * @param {object} v the VehicleRT (its `route` names the dock it really drives to)
 * @param {object} entry scene entry of the station ({ x, y, w, h } metres)
 * @returns {boolean} true when the point is a dock, false for the station middle
 */
export function dockPoint(graph, v, stationId, entry, x, y, out) {
  if (graph && typeof graph.x === 'function') {
    const route = v.route;
    if (route && route.nodes && route.nodes.length > 0) {
      const last = route.nodes[route.nodes.length - 1];
      const at = graph.stationsAt && graph.stationsAt.get(last);
      if (at && at.includes(stationId)) {
        out[0] = graph.x(last);
        out[1] = graph.y(last);
        return true;
      }
    }
    const docks = graph.docks && graph.docks.get(stationId);
    if (docks && docks.length > 0) {
      let best = Infinity;
      for (let i = 0; i < docks.length; i++) {
        const dx = graph.x(docks[i]) - x;
        const dy = graph.y(docks[i]) - y;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          out[0] = graph.x(docks[i]);
          out[1] = graph.y(docks[i]);
        }
      }
      return true;
    }
  }
  out[0] = entry.x + entry.w / 2;
  out[1] = entry.y + entry.h / 2;
  return false;
}

/**
 * Loads waiting for a vehicle at station `rt`: ready (a storage's dwell time is over) and not claimed by an order, summed
 * over all its output queues.
 * @param {object} rt StationRT
 * @param {number} now simulation time (s)
 */
export function waitingLoads(rt, now) {
  const links = rt && rt.outLinks;
  if (!links) return 0;
  let n = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const q = link.queue;
    let free = q.length - link.claimed; // claimed loads are a prefix of the queue
    for (let k = q.length - 1; k >= link.claimed && q[k].readyAt > now + 1e-9; k--) free--; // dwell not over yet
    if (free > 0) n += free;
  }
  return n;
}

/** Size of the output buffer of `rt` in loads (Infinity when it has no limit that is visible here, 0 for none). */
export function bufferSize(rt) {
  if (rt.type === 'storage') return rt.params && rt.params.capacity > 0 ? rt.params.capacity : 0;
  let cap = 0;
  const links = rt.outLinks || [];
  for (let i = 0; i < links.length; i++) cap += links[i].cap;
  return cap;
}

/** Is the waiting count a problem? True from 80 % of the output buffer, or when a source already has a backlog in its yard. */
export function waitingIsHigh(rt, n) {
  if (!(n > 0)) return false;
  if (rt.type === 'source' && rt.yardQ && rt.yardQ.length > 0) return true;
  const cap = bufferSize(rt);
  return cap > 0 && cap !== Infinity && n >= cap * HIGH_FILL;
}

const waitTexts = [];
/** "3 waiting" (cached strings: no allocation per frame). */
export function waitingText(n) {
  if (n > 999) return '999+ waiting';
  return waitTexts[n] || (waitTexts[n] = `${n} waiting`);
}
const countTexts = [];
const countText = (n) => (n > 99 ? '99+' : countTexts[n] || (countTexts[n] = String(n)));

// ---- chips: "→ Goods in 2" ----------------------------------------------------------------------------------------

const chipCache = new WeakMap();

/** { text, w } of the chip for a station, measured once per font. */
function chipOf(ctx, entry) {
  let c = chipCache.get(entry.st);
  if (!c || c.font !== ctx.font || c.name !== entry.st.name) {
    const text = `→ ${shortName(entry.st.name)}`;
    c = { font: ctx.font, name: entry.st.name, text, w: ctx.measureText(text).width };
    chipCache.set(entry.st, c);
  }
  return c;
}

// ---- job lines ----------------------------------------------------------------------------------------------------

const LINE_STRIDE = 8; // sx, sy, ex, ey, alpha, phase (0 pickup, 1 drop), vehicle length px, station index
let lineBuf = new Float64Array(8 * LINE_STRIDE);
let lineEntries = [];
const tmpPoint = [0, 0];

// ---- dock markers -------------------------------------------------------------------------------------------------

/** Where the marker of each dock cell sits (metres): on the cell, toward the station it serves, so a vehicle on the cell does not hide it. */
export function dockMarkerPoints(book, graph, scene) {
  const pts = [];
  for (const cell of book.cellList) {
    const x = graph.x(cell.node);
    const y = graph.y(cell.node);
    let ox = 0;
    let oy = 0;
    for (const id of graph.stationsAt.get(cell.node) || []) {
      const e = scene.stationById.get(id);
      if (!e) continue;
      ox = x < e.x ? 1 : x > e.x + e.w ? -1 : 0;
      oy = y < e.y ? 1 : y > e.y + e.h ? -1 : 0;
      break;
    }
    pts.push({ node: cell.node, x: x + ox * 0.36 * graph.cellSize, y: y + oy * 0.36 * graph.cellSize });
  }
  return pts;
}

const markerCache = new WeakMap();

/** The dock markers: free = hollow dot, reserved (a vehicle is on its way) = ring, occupied = filled dot. Expects the CSS-pixel transform. */
export function drawDockMarkers(ctx, fr, sim) {
  const book = sim.logistics && sim.logistics.docks;
  if (!book || !book.cellList || book.cellList.length === 0 || !sim.graph || fr.zoom < DOCK_MARK_MIN_ZOOM) return;
  let cached = markerCache.get(book);
  if (cached === undefined || cached.scene !== fr.scene) {
    cached = { scene: fr.scene, pts: dockMarkerPoints(book, sim.graph, fr.scene) };
    markerCache.set(book, cached);
  }
  const z = fr.zoom;
  const r = clamp(fr.cs * z * 0.085, 2.6, 6);
  book.refreshOccupants(true); // the vehicles have moved since the tick began
  ctx.setLineDash(NO_DASH);
  for (const m of cached.pts) {
    const x = fr.ox + m.x * z;
    const y = fr.oy + m.y * z;
    if (x < -r || x > fr.w + r || y < -r || y > fr.h + r) continue;
    const status = book.status(m.node);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    if (status === 'occupied') {
      ctx.fillStyle = STATUS_COLORS.busy;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = fr.theme.dock;
    } else if (status === 'reserved') {
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = STATUS_COLORS.starved;
    } else {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = fr.theme.dock;
    }
    ctx.stroke();
  }
}

/** Dashed lines from vehicles to the docks they drive to, then the chips. Expects the CSS-pixel transform. */
export function drawJobLines(ctx, fr) {
  const sim = fr.sim;
  if (!sim || fr.overlays.jobs === false || fr.zoom < LINE_MIN_ZOOM) return;
  drawDockMarkers(ctx, fr, sim);
  const list = sim.vehicles;
  const n = list ? list.length : 0;
  if (n === 0) return;
  const pal = fr.theme.mode === 'dark' ? PALETTE.dark : PALETTE.light;
  const graph = sim.graph || null;
  const z = fr.zoom;
  const pose = fr.pose;
  const size = fr.size;
  const maxStep = fr.cs * 1.5;
  if (lineBuf.length < n * LINE_STRIDE) lineBuf = new Float64Array(n * LINE_STRIDE * 2);
  if (lineEntries.length < n) lineEntries = new Array(n * 2).fill(null);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = list[i];
    if (!v || v.visible === false) continue;
    const target = jobTarget(v);
    if (target === null) continue;
    const entry = fr.scene.stationById.get(target);
    if (!entry || !vehiclePose(v, fr.alpha, maxStep, pose)) continue;
    dockPoint(graph, v, target, entry, pose[0], pose[1], tmpPoint);
    const sx = fr.ox + pose[0] * z;
    const sy = fr.oy + pose[1] * z;
    const ex = fr.ox + tmpPoint[0] * z;
    const ey = fr.oy + tmpPoint[1] * z;
    if (Math.max(sx, ex) < 0 || Math.min(sx, ex) > fr.w || Math.max(sy, ey) < 0 || Math.min(sy, ey) > fr.h) continue;
    const lenPx = Math.hypot(ex - sx, ey - sy);
    if (lenPx < 8) continue; // standing at the dock: nothing left to show
    const focus = fr.hoverVehicle === v.id || (fr.selFleet !== null && fr.selFleet === v.fleetId);
    const o = count * LINE_STRIDE;
    lineBuf[o] = sx;
    lineBuf[o + 1] = sy;
    lineBuf[o + 2] = ex;
    lineBuf[o + 3] = ey;
    lineBuf[o + 4] = focus ? 1 : fadeAlpha(lenPx / z);
    lineBuf[o + 5] = v.state === 'toPickup' ? 0 : 1;
    vehicleSize(v, fr.cs, size);
    lineBuf[o + 6] = Math.max(size.length * z, 9);
    lineBuf[o + 7] = focus ? 2 : 0; // 2 = this vehicle is in focus: thicker line, chip at lower zoom
    lineEntries[count] = entry;
    count++;
  }
  if (count === 0) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // many vehicles at work: a plain, lighter line each keeps the plan readable and the frame cheap (strokes are the cost here)
  const crowd = count > CROWD_SOLID ? 2 : count > CROWD_NO_CASING ? 1 : 0;
  const thin = crowd === 2 ? clamp(CROWD_SOLID / count, 0.4, 1) : 1;
  for (let k = 0; k < count; k++) drawLine(ctx, fr, lineBuf, k * LINE_STRIDE, pal, crowd, thin);
  if (z >= CHIP_FOCUS_MIN_ZOOM) {
    ctx.font = fontOf(fr.theme, 600, z >= 40 ? 12 : 10.5);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    chipCount = 0;
    for (let pass = 0; pass < 2; pass++) { // the chips of hovered / selected vehicles first: they win when chips would overlap
      for (let k = 0; k < count; k++) {
        const o = k * LINE_STRIDE;
        const focus = lineBuf[o + 7] === 2;
        if (focus === (pass === 0) && (z >= CHIP_MIN_ZOOM || focus)) drawChip(ctx, fr, lineBuf, o, lineEntries[k], pal);
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash(NO_DASH);
}

function drawLine(ctx, fr, buf, o, pal, crowd, thin) {
  const sx = buf[o];
  const sy = buf[o + 1];
  const ex = buf[o + 2];
  const ey = buf[o + 3];
  const focus = buf[o + 7] === 2;
  const color = buf[o + 5] === 0 ? pal.pickup : pal.drop;
  const z = fr.zoom;
  const width = (focus ? 2.7 : 1.7) + clamp(z / 45, 0, 1.3); // a little heavier when zoomed in, where everything else is bigger
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const head = (focus ? 9.5 : 8) + clamp(z / 60, 0, 1.5);
  const bx = ex - ux * head * 0.8; // the dashes end where the arrow head begins
  const by = ey - uy * head * 0.8;
  const plain = crowd === 2 && !focus; // lots of lines: no dashes, no casing
  // casing first: a solid, wider stroke in the halo colour keeps the dashes readable on roads, bricks and studs
  if (crowd === 0 || focus) {
    ctx.globalAlpha = 0.5 + buf[o + 4] * 0.4;
    ctx.setLineDash(NO_DASH);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(bx, by);
    ctx.lineWidth = width + 2.4;
    ctx.strokeStyle = fr.theme.flowHalo;
    ctx.stroke();
  }
  ctx.globalAlpha = plain ? buf[o + 4] * thin : buf[o + 4];
  ctx.lineCap = 'butt'; // square dash ends: a dashed stroke with round caps costs several times more to rasterise
  ctx.setLineDash(plain ? NO_DASH : z < 12 ? DASH_SMALL : z < 40 ? DASH : DASH_LARGE);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(bx, by);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
  ctx.lineCap = 'round';
  const hw = head * 0.52;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - ux * head - uy * hw, ey - uy * head + ux * hw);
  ctx.lineTo(ex - ux * head + uy * hw, ey - uy * head - ux * hw);
  ctx.closePath();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = fr.theme.flowHalo;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
}
/** More lines than this: no casing / no dashes either. */
const CROWD_NO_CASING = 24;
const CROWD_SOLID = 64;
const NO_DASH = [];
const DASH_SMALL = [4, 3];
const DASH = [6, 4];
const DASH_LARGE = [9, 6];

/** Rectangles (x0, y0, x1, y1) of the chips drawn so far this frame: a chip that would cover another is left out. */
let chipRects = new Float64Array(4 * 16);
let chipCount = 0;

/** Draw the chip of one line unless it does not fit on the line or would cover a chip drawn before. */
function drawChip(ctx, fr, buf, o, entry, pal) {
  const chip = chipOf(ctx, entry);
  const w = chip.w + 14;
  const h = fr.zoom >= 40 ? 19 : 17;
  const sx = buf[o];
  const sy = buf[o + 1];
  const dx = buf[o + 2] - sx;
  const dy = buf[o + 3] - sy;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // the chip sits on the line just ahead of the vehicle: clear of the vehicle body, and never past the middle of a short line
  const reach = Math.abs(ux) * w / 2 + Math.abs(uy) * h / 2;
  const d = buf[o + 6] / 2 + reach + 5;
  if (d + reach + 10 > len) return;
  const cx = sx + ux * d;
  const cy = sy + uy * d;
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  for (let i = 0; i < chipCount; i++) {
    const r = i * 4;
    if (x0 < chipRects[r + 2] && x0 + w > chipRects[r] && y0 < chipRects[r + 3] && y0 + h > chipRects[r + 1]) return;
  }
  if ((chipCount + 1) * 4 > chipRects.length) {
    const grown = new Float64Array(chipRects.length * 2);
    grown.set(chipRects);
    chipRects = grown;
  }
  const r = chipCount++ * 4;
  chipRects[r] = x0;
  chipRects[r + 1] = y0;
  chipRects[r + 2] = x0 + w;
  chipRects[r + 3] = y0 + h;
  ctx.globalAlpha = Math.min(1, buf[o + 4] + 0.25);
  fillPill(ctx, x0, y0, w, h, fr.theme.flowChip);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = buf[o + 5] === 0 ? pal.pickup : pal.drop;
  ctx.stroke();
  ctx.fillStyle = fr.theme.text;
  ctx.fillText(chip.text, cx, cy + 0.5);
}

// ---- waiting badges -----------------------------------------------------------------------------------------------

/** "n waiting" badge on every station with loads waiting for a vehicle. Expects the CSS-pixel transform. */
export function drawWaitingBadges(ctx, fr) {
  const sim = fr.sim;
  if (!sim || fr.overlays.jobs === false || fr.zoom < LINE_MIN_ZOOM) return;
  const now = Number.isFinite(sim.time) ? sim.time : Infinity;
  const z = fr.zoom;
  const vis = fr.vis;
  let fontSet = false;
  for (const e of fr.scene.stations) {
    const type = e.st.type;
    if (type !== 'source' && type !== 'process' && type !== 'storage') continue;
    if (e.x > vis.x1 || e.x + e.w < vis.x0 || e.y > vis.y1 || e.y + e.h < vis.y0) continue;
    const rt = fr.rtOf(e.st.id);
    if (!rt) continue;
    const n = waitingLoads(rt, now);
    if (n < 1) continue;
    if (!fontSet) {
      ctx.font = fontOf(fr.theme, 700, 11);
      ctx.textBaseline = 'middle';
      fontSet = true;
    }
    drawBadge(ctx, fr, e, n, waitingIsHigh(rt, n), z);
  }
}

function drawBadge(ctx, fr, e, n, high, z) {
  const right = fr.ox + (e.x + e.w) * z;
  const top = fr.oy + e.y * z;
  const fill = high ? BADGE_RED : STATUS_COLORS.starved;
  const ink = high ? BADGE_RED_INK : STATUS_INK;
  const h = 19;
  if (z < BADGE_TEXT_MIN_ZOOM) { // a round badge with the bare number: the plan is too small for words
    const r = h / 2;
    const cx = right - r;
    const cy = top - 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1.5, 0, TAU);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = ink;
    ctx.fillText(countText(n), cx, cy + 0.5);
    return;
  }
  const text = waitingText(n);
  const tw = measureCached(ctx, text);
  const w = tw + h + 8; // icon cell + text + padding
  const x = right - w;
  const y = top - h - 3;
  fillPill(ctx, x - 1.5, y - 1.5, w + 3, h + 3, '#ffffff');
  fillPill(ctx, x, y, w, h, fill);
  if (high) drawExclaim(ctx, x + h / 2 + 1, y + h / 2, h * 0.34, ink, fill);
  else drawBox(ctx, x + h / 2 + 1, y + h / 2, h * 0.5, '#ffe9bd', '#7a4a00');
  ctx.textAlign = 'left';
  ctx.fillStyle = ink;
  ctx.fillText(text, x + h + 4, y + h / 2 + 0.5);
}

/** A "!" in a circle: the colour-independent mark of a badge that has turned red. */
function drawExclaim(ctx, cx, cy, r, ink, fill) {
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2, 0, TAU);
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.fillRect(cx - 0.9, cy - r * 0.95, 1.8, r * 1.15);
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.78, 1.1, 0, TAU);
  ctx.fill();
}

const widthCache = new Map();
/** Text width in the current font, cached per string (the strings are the few "n waiting" texts). */
function measureCached(ctx, text) {
  let perFont = widthCache.get(ctx.font);
  if (!perFont) {
    if (widthCache.size > 16) widthCache.clear();
    perFont = new Map();
    widthCache.set(ctx.font, perFont);
  }
  let w = perFont.get(text);
  if (w === undefined) {
    w = ctx.measureText(text).width;
    perFont.set(text, w);
  }
  return w;
}
