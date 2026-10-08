// Overlays drawn between the bricks and the interaction layer: dock notches, traffic / waiting heatmap with
// its legend, pulsing deadlock rings and the scale bar. Heat data is sampled from sim.heat() at ~4 Hz and
// converted into a flat rectangle list, so the per-frame cost is one fillRect per coloured lane segment.

import { perimeterCells, DX, DY } from '../../util/grid.js';
import { formatDuration, formatNumber } from '../../util/format.js';
import { heatColor, HEAT_LEVELS } from '../theme.js';
import { niceScale } from './geometry.js';
import { OCC_ROAD } from './scene.js';
import { fontOf, haloText, roundRectPath } from './draw.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Minimum real-time gap between two reads of sim.heat() (it allocates arrays). */
const HEAT_REFRESH_MS = 250;
const LANE_OFFSET = 0.22; // fraction of a cell; matches the traffic module's lane offset

// ---- docks -----------------------------------------------------------------------------------------------

/** Notches on every road cell that touches the footprint `rect` (cells), coloured like the station. */
export function drawDockNotches(ctx, fr, rect, color) {
  const { scene } = fr;
  const cell = fr.cs * fr.zoom;
  if (cell < 8) return;
  const len = cell * 0.44;
  const depth = clamp(cell * 0.14, 2.5, 7);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = fr.theme.dock;
  ctx.fillStyle = color;
  for (const [cx, cy, dir] of perimeterCells(rect)) {
    if (cx < 0 || cy < 0 || cx >= scene.cols || cy >= scene.rows || !(scene.occ[cy * scene.cols + cx] & OCC_ROAD)) continue;
    const x = fr.ox + cx * cell;
    const y = fr.oy + cy * cell;
    // dir = direction from the road cell into the station: the notch hugs that edge of the road cell
    const horizontal = dir === 0 || dir === 2;
    const nx = horizontal ? x + (cell - len) / 2 : dir === 1 ? x + cell - depth : x;
    const ny = horizontal ? (dir === 2 ? y + cell - depth : y) : y + (cell - len) / 2;
    ctx.beginPath();
    roundRectPath(ctx, nx, ny, horizontal ? len : depth, horizontal ? depth : len, 1.5);
    ctx.fill();
    ctx.stroke();
  }
}

/** Dock notches for all stations (overlay on) or only the picked ones. */
export function drawDocks(ctx, fr) {
  for (const e of fr.scene.stations) {
    const picked = (fr.selKind === 'station' && fr.selIds.includes(e.st.id)) || (fr.hoverKind === 'station' && fr.hoverId === e.st.id);
    if (!fr.overlays.docks && !picked) continue;
    drawDockNotches(ctx, fr, e.cells, (fr.theme.station[e.st.type] || fr.theme.station.process).top);
  }
}

// ---- heatmap -----------------------------------------------------------------------------------------------

/** Mutable cache of the converted heat data; owned by the renderer. */
export function createHeatState() {
  return { sim: null, layout: null, mode: 'off', at: -Infinity, count: 0, rects: new Float32Array(256), levels: new Uint8Array(64), title: '', maxLabel: '' };
}

function pushRect(state, x, y, w, h, level) {
  if ((state.count + 1) * 4 > state.rects.length) {
    const rects = new Float32Array(state.rects.length * 2);
    rects.set(state.rects);
    state.rects = rects;
    const levels = new Uint8Array(state.levels.length * 2);
    levels.set(state.levels);
    state.levels = levels;
  }
  const o = state.count * 4;
  state.rects[o] = x;
  state.rects[o + 1] = y;
  state.rects[o + 2] = w;
  state.rects[o + 3] = h;
  state.levels[state.count++] = level;
}

const levelOf = (value, max) => (value > 0 && max > 0 ? clamp(Math.ceil((value / max) * (HEAT_LEVELS - 1)), 1, HEAT_LEVELS - 1) : 0);

function maxOf(arr, n) {
  let m = 0;
  if (arr) for (let i = 0; i < n && i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/**
 * Re-read sim.heat() when the data is older than HEAT_REFRESH_MS (or the sim, layout or mode changed) and
 * rebuild the rectangle list. Leaves the state empty when the simulation offers no heat data.
 * @param {'traffic'|'waiting'} mode
 */
export function refreshHeat(state, fr, mode, force = false) {
  const sim = fr.sim;
  const fresh = state.sim === sim && state.layout === fr.layout && state.mode === mode && fr.now - state.at < HEAT_REFRESH_MS;
  if (fresh && !force) return;
  state.sim = sim;
  state.layout = fr.layout;
  state.mode = mode;
  state.at = fr.now;
  state.count = 0;
  state.title = '';
  const graph = sim && sim.graph;
  if (!sim || typeof sim.heat !== 'function' || !graph || !graph.edges) return;
  let heat = null;
  try {
    heat = sim.heat();
  } catch {
    return; // the simulation is being rebuilt: show no heat for this refresh rather than break the frame loop
  }
  if (!heat) return;
  if (mode === 'traffic') buildTraffic(state, fr, graph, heat);
  else buildWaiting(state, fr, graph, heat);
}

/** Centre of a node in world metres. */
function nodeCenter(fr, graph, id, out) {
  const cols = graph.cols || fr.scene.cols;
  const cs = graph.cellSize || fr.cs;
  const cx = id % cols;
  out[0] = (cx + 0.5) * cs;
  out[1] = (Math.floor(id / cols) + 0.5) * cs;
}

/** Add the lane strip of one directed edge. */
function pushEdge(state, fr, graph, edge, level, side) {
  const cs = graph.cellSize || fr.cs;
  const a = fr.tmpA;
  const b = fr.tmpB;
  nodeCenter(fr, graph, edge.from, a);
  nodeCenter(fr, graph, edge.to, b);
  const dx = DX[edge.dir];
  const dy = DY[edge.dir];
  const twoWay = edge.rev >= 0;
  const off = twoWay ? side * LANE_OFFSET * cs : 0;
  const t = cs * (twoWay ? 0.3 : 0.44);
  const ox = -dy * off;
  const oy = dx * off;
  if (dx !== 0) pushRect(state, Math.min(a[0], b[0]) - t / 2, a[1] + oy - t / 2, cs + t, t, level);
  else pushRect(state, a[0] + ox - t / 2, Math.min(a[1], b[1]) - t / 2, t, cs + t, level);
}

const handedSide = (fr) => {
  const h = (fr.sim && fr.sim.settings && fr.sim.settings.handedness) || (fr.layout && fr.layout.settings && fr.layout.settings.handedness);
  return h === 'left' ? -1 : 1;
};

function buildTraffic(state, fr, graph, heat) {
  const edges = graph.edges;
  const max = maxOf(heat.edgePasses, edges.length);
  const side = handedSide(fr);
  for (let i = 0; i < edges.length; i++) {
    const level = levelOf(heat.edgePasses ? heat.edgePasses[i] : 0, max);
    if (level > 0) pushEdge(state, fr, graph, edges[i], level, side);
  }
  state.title = 'Traffic';
  state.maxLabel = max > 0 ? `${formatNumber(max)} passes` : 'no traffic yet';
}

function buildWaiting(state, fr, graph, heat) {
  const edges = graph.edges;
  const nodeCount = graph.nodeCount || fr.scene.cols * fr.scene.rows;
  const max = Math.max(maxOf(heat.edgeWait, edges.length), maxOf(heat.nodeWait, nodeCount));
  const side = handedSide(fr);
  for (let i = 0; i < edges.length; i++) {
    const level = levelOf(heat.edgeWait ? heat.edgeWait[i] : 0, max);
    if (level > 0) pushEdge(state, fr, graph, edges[i], level, side);
  }
  const cs = graph.cellSize || fr.cs;
  const c = fr.tmpA;
  for (let id = 0; heat.nodeWait && id < nodeCount && id < heat.nodeWait.length; id++) {
    const level = levelOf(heat.nodeWait[id], max);
    if (level === 0) continue;
    nodeCenter(fr, graph, id, c);
    pushRect(state, c[0] - cs * 0.25, c[1] - cs * 0.25, cs * 0.5, cs * 0.5, level);
  }
  state.title = 'Waiting';
  state.maxLabel = max > 0 ? `${formatDuration(max)} (vehicle time)` : 'no waiting yet';
}

/** Draw the converted heat rectangles. Expects the world (metres) transform. */
export function drawHeat(ctx, state) {
  const r = state.rects;
  for (let i = 0; i < state.count; i++) {
    ctx.fillStyle = heatColor(state.levels[i] / (HEAT_LEVELS - 1));
    ctx.fillRect(r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]);
  }
}

/** Legend panel (bottom-left, above the scale bar). Expects the CSS-pixel transform. */
export function drawHeatLegend(ctx, fr, state) {
  if (!state.title) return;
  const theme = fr.theme;
  const w = 188;
  const h = 46;
  const x = 12;
  const y = fr.h - 12 - 30 - h;
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, 8);
  ctx.fillStyle = theme.panel;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.panelBorder;
  ctx.stroke();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = fontOf(theme, 600, 11);
  ctx.fillStyle = theme.text;
  ctx.fillText(state.title, x + 10, y + 17);
  ctx.font = fontOf(theme, 500, 10.5);
  ctx.fillStyle = theme.textDim;
  ctx.textAlign = 'right';
  ctx.fillText(state.maxLabel, x + w - 10, y + 17);
  const bx = x + 10;
  const bw = w - 20;
  ctx.fillStyle = theme.mode === 'dark' ? '#10141b' : '#434b5a';
  ctx.beginPath();
  roundRectPath(ctx, bx, y + 26, bw, 9, 4.5);
  ctx.fill();
  ctx.save();
  ctx.clip();
  const seg = bw / (HEAT_LEVELS - 1);
  for (let i = 1; i < HEAT_LEVELS; i++) {
    ctx.fillStyle = heatColor(i / (HEAT_LEVELS - 1));
    ctx.fillRect(bx + (i - 1) * seg, y + 26, seg + 0.5, 9);
  }
  ctx.restore();
}

// ---- deadlocks -----------------------------------------------------------------------------------------------

const PULSE_MS = 1200;

/** One deadlock marker: a steady ring with a faint disc and two expanding, fading rings. */
function drawRing(ctx, fr, node, cols, phase) {
  if (!Number.isInteger(node) || node < 0) return;
  const cell = fr.cs * fr.zoom;
  const x = fr.ox + ((node % cols) + 0.5) * cell;
  const y = fr.oy + (Math.floor(node / cols) + 0.5) * cell;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = fr.theme.deadlock;
  ctx.fillStyle = fr.theme.deadlock;
  ctx.globalAlpha = 0.14;
  ctx.beginPath();
  ctx.arc(x, y, cell * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.stroke();
  for (let i = 0; i < 2; i++) {
    const p = (phase + i * 0.5) % 1;
    ctx.globalAlpha = (1 - p) * 0.85;
    ctx.beginPath();
    ctx.arc(x, y, cell * (0.42 + 0.6 * p), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Pulsing red rings on the nodes of active deadlocks (`sim.traffic.activeDeadlocks`, optional). */
export function drawDeadlocks(ctx, fr) {
  const list = fr.sim && fr.sim.traffic && fr.sim.traffic.activeDeadlocks;
  if (!list || typeof list[Symbol.iterator] !== 'function') return;
  const phase = fr.reducedMotion ? 0.3 : (fr.now % PULSE_MS) / PULSE_MS; // reduced motion: rings stand still
  const graph = fr.sim.graph;
  const cols = (graph && graph.cols) || fr.scene.cols;
  for (const item of list) {
    if (typeof item === 'number') drawRing(ctx, fr, item, cols, phase);
    else if (item && Array.isArray(item.nodes)) for (const node of item.nodes) drawRing(ctx, fr, node, cols, phase);
    else if (item && typeof item.node === 'number') drawRing(ctx, fr, item.node, cols, phase);
  }
}

// ---- scale bar -----------------------------------------------------------------------------------------------

let scaleLabelMetres = -1;
let scaleLabelText = '';

/** "10 m" label, cached for the last length so the per-frame path builds no strings. */
function scaleLabel(metres) {
  if (metres !== scaleLabelMetres) {
    scaleLabelMetres = metres;
    scaleLabelText = `${formatNumber(metres)} m`;
  }
  return scaleLabelText;
}

function strokeBar(ctx, color, width, x, y, px) {
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 4);
  ctx.stroke();
}

/** Scale bar in the bottom-left corner. Expects the CSS-pixel transform. */
export function drawScaleBar(ctx, fr) {
  const { metres, px } = niceScale(fr.zoom, 130);
  if (metres === 0) return;
  const theme = fr.theme;
  const x = 16;
  const y = fr.h - 20;
  ctx.lineCap = 'butt';
  strokeBar(ctx, theme.labelHalo, 5, x, y, px);
  strokeBar(ctx, theme.text, 2, x, y, px);
  ctx.font = fontOf(theme, 600, 11);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  haloText(ctx, scaleLabel(metres), x, y - 6, theme.text, theme.labelHalo, 3);
}
