// Resize math for the eight handles of a selected station or obstacle. Pure, no DOM.

import { clamp } from '../../util/format.js';

/** The eight handle names used by the renderer's hit test, clockwise from the top-left corner. */
export const HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

/** Is `name` one of the eight resize handles (and not the renderer's 'move')? */
export const isHandle = (name) => HANDLES.includes(name);

/**
 * Rectangle after dragging `handle` by (dx, dy) cells. Only the edges the handle touches move; the opposite edges stay.
 * The result keeps at least `min` cells per side (the dragged edge stops at the opposite edge) and stays inside the grid, except on an
 * axis where `beyond` = { x, y } says the pointer is beyond the baseplate: there the edge follows it out and the plan will grow.
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {string} handle one of HANDLES
 * @param {{cols:number,rows:number}} grid
 * @param {number} [min]
 * @param {{x:boolean,y:boolean}|null} [beyond]
 */
export function resizeRect(rect, handle, dx, dy, grid, min = 1, beyond = null) {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  const bx = beyond && beyond.x;
  const by = beyond && beyond.y;
  if (handle.includes('w')) left = clamp(left + dx, bx ? -Infinity : 0, right - min);
  if (handle.includes('e')) right = clamp(right + dx, left + min, bx ? Infinity : grid.cols);
  if (handle.includes('n')) top = clamp(top + dy, by ? -Infinity : 0, bottom - min);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min, by ? Infinity : grid.rows);
  return { x: left, y: top, w: right - left, h: bottom - top };
}
