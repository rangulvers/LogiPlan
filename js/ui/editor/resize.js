// Resize math for the eight handles of a selected station or obstacle. Pure, no DOM.

import { clamp } from '../../util/format.js';

/** The eight handle names used by the renderer's hit test, clockwise from the top-left corner. */
export const HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

/** Is `name` one of the eight resize handles (and not the renderer's 'move')? */
export const isHandle = (name) => HANDLES.includes(name);

/**
 * Rectangle after dragging `handle` by (dx, dy) cells. Only the edges the handle touches move; the opposite edges stay.
 * The result keeps at least `min` cells per side (the dragged edge stops at the opposite edge) and stays inside the grid.
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {string} handle one of HANDLES
 * @param {{cols:number,rows:number}} grid
 */
export function resizeRect(rect, handle, dx, dy, grid, min = 1) {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - min);
  if (handle.includes('e')) right = clamp(right + dx, left + min, grid.cols);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - min);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min, grid.rows);
  return { x: left, y: top, w: right - left, h: bottom - top };
}
