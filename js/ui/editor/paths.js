// Stroke building for the road, one-way, speed-zone and eraser tools: appending pointer cells to a free-hand
// path, the Shift straight line, and cutting a stroke where a blocked cell stops it. Pure, no DOM.

import { lPath, dirFromTo, cellKey } from '../../util/grid.js';
import { isCellFree } from '../../model/layout.js';

const sameCell = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * Append cell `to` to a free-hand stroke (in place). A pointer that moved several cells between two events leaves a
 * gap; it is filled with the L-shaped lPath, so consecutive cells are always 4-neighbours.
 * @param {number[][]} cells the stroke so far
 * @param {number[]} to [cx, cy]
 */
export function extendStroke(cells, to) {
  const last = cells[cells.length - 1];
  if (!last) cells.push([to[0], to[1]]);
  else if (!sameCell(last, to)) cells.push(...lPath(last[0], last[1], to[0], to[1]).slice(1));
  return cells;
}

/** The Shift stroke: a straight or L-shaped line from the stroke start to the pointer cell. */
export function straightStroke(start, to) {
  return lPath(start[0], start[1], to[0], to[1]);
}

/** The cells of a stroke without repeats, in order of first visit. */
export function uniqueCells(cells) {
  const seen = new Set();
  const out = [];
  for (const c of cells) {
    const key = cellKey(c[0], c[1]);
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

/**
 * Split a stroke where the model would stop painting it: at the first cell that is off the baseplate or covered by a
 * station or obstacle (the same test as paintRoadPath). `blocked` holds that cell and every later one (they are not painted).
 * @returns {{ paint: number[][], blocked: number[][] }}
 */
export function clipStroke(layout, cells) {
  const i = cells.findIndex(([cx, cy]) => !isCellFree(layout, cx, cy));
  if (i < 0) return { paint: cells, blocked: [] };
  return { paint: cells.slice(0, i), blocked: uniqueCells(cells.slice(i)) };
}

/** Direction (0..3) of the last step of a stroke, -1 while it has fewer than two different cells. */
export function lastDirection(cells) {
  for (let i = cells.length - 1; i > 0; i--) {
    const d = dirFromTo(cells[i - 1][0], cells[i - 1][1], cells[i][0], cells[i][1]);
    if (d >= 0) return d;
  }
  return -1;
}
