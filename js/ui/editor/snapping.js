// Grid snapping and placement geometry for the editor: where a brick of a given size lands under the pointer, the
// rectangle spanned by a drag, and why a rectangle cannot be used. Pure, no DOM.

import { clamp } from '../../util/format.js';
import { isRectFree } from '../../model/layout.js';
import { rectsOverlap, inBounds } from '../../util/grid.js';

/** Pointer travel (CSS px) before a press counts as a drag, per pointer type. Touch is less precise. */
export const DRAG_PX = Object.freeze({ mouse: 4, pen: 4, touch: 10 });
export const dragThreshold = (pointerType) => DRAG_PX[pointerType] ?? DRAG_PX.mouse;

/** A [cx, cy] cell pulled inside the grid. */
export const clampCell = (cx, cy, grid) => [clamp(cx, 0, grid.cols - 1), clamp(cy, 0, grid.rows - 1)];

/**
 * Rectangle of size w x h whose centre is nearest to the pointer, inside the grid. (ux, uy) is the pointer position in
 * fractional cells, so an odd-sized brick is centred on the pointer cell and an even one snaps to the closest grid line.
 */
export function snapRect(ux, uy, w, h, grid) {
  const rw = Math.min(w, grid.cols);
  const rh = Math.min(h, grid.rows);
  return {
    x: clamp(Math.round(ux - rw / 2), 0, grid.cols - rw),
    y: clamp(Math.round(uy - rh / 2), 0, grid.rows - rh),
    w: rw,
    h: rh,
  };
}

/** The rectangle spanned by two cells (both included), at least 1 x 1, clipped to the grid. */
export function dragRect(a, b, grid) {
  const x0 = clamp(Math.min(a[0], b[0]), 0, grid.cols - 1);
  const y0 = clamp(Math.min(a[1], b[1]), 0, grid.rows - 1);
  const x1 = clamp(Math.max(a[0], b[0]), 0, grid.cols - 1);
  const y1 = clamp(Math.max(a[1], b[1]), 0, grid.rows - 1);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Why `rect` cannot hold a station or obstacle, as a short phrase ("a road is in the way"), or null when it is free.
 * `ignore` names the station / obstacle that is being moved or resized (it does not block itself).
 * @param {{ ignoreStation?: string, ignoreObstacle?: string }} [ignore]
 */
export function blockReason(layout, rect, ignore = {}) {
  const { cols, rows } = layout.grid;
  if (!inBounds(rect.x, rect.y, cols, rows) || !inBounds(rect.x + rect.w - 1, rect.y + rect.h - 1, cols, rows)) return 'it would leave the baseplate';
  if (isRectFree(layout, rect, ignore)) return null;
  if (layout.stations.some((s) => s.id !== ignore.ignoreStation && rectsOverlap(rect, s))) return 'another station is in the way';
  if (layout.obstacles.some((o) => o.id !== ignore.ignoreObstacle && rectsOverlap(rect, o))) return 'a wall or rack is in the way';
  return 'a road is in the way';
}

/** "4 x 3 cells (8 x 6 m)" for the status line while sizing something. */
export function sizeText(rect, cellSize) {
  const m = (n) => String(Math.round(n * cellSize * 10) / 10);
  return `${rect.w} × ${rect.h} cells (${m(rect.w)} × ${m(rect.h)} m)`;
}
