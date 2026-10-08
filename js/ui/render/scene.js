// Scene: the renderer's read-only index of one layout snapshot. Built once per layout object (layouts are
// immutable snapshots, so a WeakMap keyed on identity is a valid cache) and shared by the static layer, the
// per-frame drawing and hit testing. Pure and DOM-free.
//
//   cols, rows, cs, width, height     grid and baseplate size (cells / metres)
//   occ[cy*cols+cx]                   OCC_ROAD | OCC_STATION | OCC_OBSTACLE bits
//   out[cy*cols+cx], limit[...]       road exit mask and speed factor (1 = none) of road cells
//   roads                             [{cx, cy}] of all in-bounds road cells
//   twoWay / oneWay                   flat [cx, cy, dir, ...]; two-way pairs once (dir E or S), one-way links A->B
//   zones                             speed zones: connected road cells with the same limit, one label cell each
//   stations                          [{ st, cells, x, y, w, h }]: `cells` is the footprint in grid cells, x..h the
//                                     same rectangle in metres (stations with a non-finite or empty rectangle are
//                                     left out, huge ones are cut to the grid size so no drawing loop can run away)
//   stationById                       Map id -> entry of `stations`
//   obstacles                         [{ id, kind, x, y, w, h }] in cells, sanitised the same way
//   flows                             [{ flow, curve }] for flows that have a visible curve (see flowCurve)

import { DX, DY, DIR_BIT, E, S, parseKey } from '../../util/grid.js';
import { flowCurve } from './geometry.js';

export const OCC_ROAD = 1;
export const OCC_STATION = 2;
export const OCC_OBSTACLE = 4;

const DEFAULT_GRID = { cols: 48, rows: 32, cellSize: 2 };
const cache = new WeakMap();

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/** {x, y, w, h} in cells with finite numbers, positive size, at most grid-sized; null if unusable. */
function sanitizeRect(r, cols, rows) {
  if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) return null;
  return { x: r.x, y: r.y, w: Math.min(r.w, cols), h: Math.min(r.h, rows) };
}

/** The scene of `layout` (cached by object identity). Returns null for a missing layout. */
export function getScene(layout) {
  if (!layout || typeof layout !== 'object') return null;
  let scene = cache.get(layout);
  if (!scene) {
    scene = buildScene(layout);
    cache.set(layout, scene);
  }
  return scene;
}

function markRect(occ, cols, rows, r, bit) {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(cols, Math.ceil(r.x + r.w));
  const y1 = Math.min(rows, Math.ceil(r.y + r.h));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) occ[y * cols + x] |= bit;
}

function readRoads(layout, scene) {
  const { cols, rows, out, limit, occ, roads } = scene;
  for (const [key, cell] of Object.entries(layout.roads || {})) {
    const [cx, cy] = parseKey(key);
    if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
    const id = cy * cols + cx;
    occ[id] |= OCC_ROAD;
    out[id] = (cell && cell.out | 0) & 15;
    const lim = cell && Number(cell.limit);
    limit[id] = Number.isFinite(lim) && lim > 0 && lim < 1 ? Math.max(0.05, lim) : 1;
    roads.push({ cx, cy });
  }
}

/** Classify every link between two road cells as one-way or (once per pair) two-way. */
function readLinks(scene) {
  const { cols, rows, out, occ, roads, twoWay, oneWay } = scene;
  for (const { cx, cy } of roads) {
    const mask = out[cy * cols + cx];
    for (let d = 0; d < 4; d++) {
      if (!(mask & DIR_BIT[d])) continue;
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || !(occ[ny * cols + nx] & OCC_ROAD)) continue;
      const back = out[ny * cols + nx] & DIR_BIT[(d + 2) & 3];
      if (!back) oneWay.push(cx, cy, d);
      else if (d === E || d === S) twoWay.push(cx, cy, d);
    }
  }
}

/** Group road cells with equal speed limits into connected zones; the label sits on the cell nearest the centroid. */
function readZones(scene) {
  const { cols, rows, limit, occ, roads, zones } = scene;
  const seen = new Uint8Array(cols * rows);
  for (const { cx, cy } of roads) {
    const start = cy * cols + cx;
    if (seen[start] || limit[start] >= 1) continue;
    const lim = Math.round(limit[start] * 100);
    const cells = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const id = stack.pop();
      cells.push(id);
      const x = id % cols;
      const y = (id - x) / cols;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nid = ny * cols + nx;
        if (seen[nid] || !(occ[nid] & OCC_ROAD) || Math.round(limit[nid] * 100) !== lim) continue;
        seen[nid] = 1;
        stack.push(nid);
      }
    }
    let sx = 0;
    let sy = 0;
    for (const id of cells) { sx += id % cols; sy += Math.floor(id / cols); }
    sx /= cells.length;
    sy /= cells.length;
    let best = cells[0];
    let bestD = Infinity;
    for (const id of cells) {
      const d = Math.hypot((id % cols) - sx, Math.floor(id / cols) - sy);
      if (d < bestD) { bestD = d; best = id; }
    }
    zones.push({ limit: lim / 100, cx: best % cols, cy: Math.floor(best / cols), cells: cells.length });
  }
}

/** Build the scene for a layout. Tolerates missing optional collections. Prefer getScene() (cached). */
export function buildScene(layout) {
  const grid = layout.grid || DEFAULT_GRID;
  const cols = Math.max(1, Math.floor(num(grid.cols, DEFAULT_GRID.cols)));
  const rows = Math.max(1, Math.floor(num(grid.rows, DEFAULT_GRID.rows)));
  const cs = num(grid.cellSize, DEFAULT_GRID.cellSize) > 0 ? grid.cellSize : DEFAULT_GRID.cellSize;
  const scene = {
    layout, cols, rows, cs, width: cols * cs, height: rows * cs,
    occ: new Uint8Array(cols * rows), out: new Uint8Array(cols * rows), limit: new Float32Array(cols * rows).fill(1),
    roads: [], twoWay: [], oneWay: [], zones: [], stations: [], stationById: new Map(), obstacles: [], flows: [],
  };
  readRoads(layout, scene);
  readLinks(scene);
  readZones(scene);
  for (const o of layout.obstacles || []) {
    const r = sanitizeRect(o, cols, rows);
    if (!r) continue;
    markRect(scene.occ, cols, rows, r, OCC_OBSTACLE);
    scene.obstacles.push({ id: o.id, kind: o.kind, ...r });
  }
  for (const st of layout.stations || []) {
    const cells = sanitizeRect(st, cols, rows);
    if (!cells) continue;
    markRect(scene.occ, cols, rows, cells, OCC_STATION);
    const entry = { st, cells, x: cells.x * cs, y: cells.y * cs, w: cells.w * cs, h: cells.h * cs };
    scene.stations.push(entry);
    scene.stationById.set(st.id, entry);
  }
  for (const flow of layout.flows || []) {
    const a = scene.stationById.get(flow.from);
    const b = scene.stationById.get(flow.to);
    const curve = a && b && a !== b ? flowCurve(a, b) : null;
    if (curve) scene.flows.push({ flow, curve });
  }
  return scene;
}
