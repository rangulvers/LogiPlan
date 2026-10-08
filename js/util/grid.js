// Grid & direction helpers shared by model, sim and UI. Pure functions, no DOM.
//
// Coordinate system: cell (cx, cy) with origin at the top-left, +x = East (right),
// +y = South (down). World coordinates are in metres: the centre of cell (cx, cy)
// is ((cx + 0.5) * cellSize, (cy + 0.5) * cellSize).
//
// Directions: 0 = N (up), 1 = E (right), 2 = S (down), 3 = W (left).

export const N = 0;
export const E = 1;
export const S = 2;
export const W = 3;

export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
/** Bit for each direction inside a road cell's `out` mask. */
export const DIR_BIT = [1, 2, 4, 8];
export const DIR_NAMES = ['N', 'E', 'S', 'W'];

/** Opposite direction. */
export const opposite = (d) => (d + 2) & 3;

/** Key used for sparse cell maps: "cx,cy". */
export const cellKey = (cx, cy) => cx + ',' + cy;

/** Inverse of cellKey -> [cx, cy]. */
export function parseKey(key) {
  const i = key.indexOf(',');
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

/** Dense node id of a cell. Many ids are unused (non-road cells). */
export const nodeId = (cx, cy, cols) => cy * cols + cx;
export const nodeCx = (id, cols) => id % cols;
export const nodeCy = (id, cols) => Math.floor(id / cols);

/** Direction from cell 1 to adjacent cell 2, or -1 if they are not 4-neighbours. */
export function dirFromTo(cx1, cy1, cx2, cy2) {
  const dx = cx2 - cx1;
  const dy = cy2 - cy1;
  if (dx === 0 && dy === -1) return N;
  if (dx === 1 && dy === 0) return E;
  if (dx === 0 && dy === 1) return S;
  if (dx === -1 && dy === 0) return W;
  return -1;
}

/** World-space centre [x, y] (metres) of a cell. */
export function cellCenter(cx, cy, cellSize) {
  return [(cx + 0.5) * cellSize, (cy + 0.5) * cellSize];
}

/** True if (cx, cy) lies inside a cols x rows grid. */
export const inBounds = (cx, cy, cols, rows) => cx >= 0 && cy >= 0 && cx < cols && cy < rows;

/** Do two cell rectangles {x,y,w,h} overlap? */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Is cell (cx, cy) inside rectangle {x,y,w,h}? */
export const inRect = (cx, cy, r) => cx >= r.x && cy >= r.y && cx < r.x + r.w && cy < r.y + r.h;

/** Cells (4-neighbourhood) edge-adjacent to a rectangle, as [cx, cy, dirFromCellIntoRect]. */
export function perimeterCells(r) {
  const out = [];
  for (let i = 0; i < r.w; i++) {
    out.push([r.x + i, r.y - 1, S]);
    out.push([r.x + i, r.y + r.h, N]);
  }
  for (let j = 0; j < r.h; j++) {
    out.push([r.x - 1, r.y + j, E]);
    out.push([r.x + r.w, r.y + j, W]);
  }
  return out;
}

/** Cells visited by a straight axis-aligned or L-shaped drag from (x1,y1) to (x2,y2), inclusive.
 *  Horizontal leg first when |dx| >= |dy|, otherwise vertical first. */
export function lPath(x1, y1, x2, y2) {
  const cells = [];
  const horizFirst = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
  const sx = Math.sign(x2 - x1);
  const sy = Math.sign(y2 - y1);
  let x = x1;
  let y = y1;
  cells.push([x, y]);
  const walkX = () => { while (x !== x2) { x += sx; cells.push([x, y]); } };
  const walkY = () => { while (y !== y2) { y += sy; cells.push([x, y]); } };
  if (horizFirst) { walkX(); walkY(); } else { walkY(); walkX(); }
  return cells;
}
