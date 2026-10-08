// The eraser: removes road cells, obstacle cells and labels. An obstacle is cut cell by cell (erasing one cell of a
// long wall leaves two shorter walls), so a planner can open a gap in a wall without deleting the whole thing.
// Pure functions on a layout draft, no DOM (unit-tested in Node).

import { inRect } from '../../util/grid.js';
import { eraseRoadCell, updateObstacle, removeObstacle, addObstacle, removeLabel } from '../../model/layout.js';

/**
 * Rectangles that remain when cell (cx, cy) is cut out of `rect` (the cell must lie inside it): the part to the left,
 * the part to the right (both full height), then the cells above and below in the same column.
 * @returns {Array<{x:number,y:number,w:number,h:number}>} 0 to 4 rectangles
 */
export function carveRect(rect, cx, cy) {
  const pieces = [
    { x: rect.x, y: rect.y, w: cx - rect.x, h: rect.h },
    { x: cx + 1, y: rect.y, w: rect.x + rect.w - cx - 1, h: rect.h },
    { x: cx, y: rect.y, w: 1, h: cy - rect.y },
    { x: cx, y: cy + 1, w: 1, h: rect.y + rect.h - cy - 1 },
  ];
  return pieces.filter((p) => p.w > 0 && p.h > 0);
}

/** Cut one cell out of every obstacle covering it. Returns the kinds ('wall', 'rack', 'column') of the obstacles touched. */
function carveObstacles(draft, cx, cy) {
  const kinds = [];
  for (const o of draft.obstacles.filter((e) => inRect(cx, cy, e))) {
    const [first, ...rest] = carveRect(o, cx, cy);
    if (first) updateObstacle(draft, o.id, first);
    else removeObstacle(draft, o.id);
    for (const piece of rest) addObstacle(draft, { ...piece, kind: o.kind });
    kinds.push(o.kind);
  }
  return kinds;
}

/**
 * Erase everything under the given cells and the given labels in a layout draft.
 * @param {number[][]} cells [cx, cy] pairs (repeats are harmless)
 * @param {string[]} labelIds labels to delete
 * @returns {{ roads: number, obstacles: number, labels: number, kinds: string[] }} what was removed (`kinds`: the
 *   distinct obstacle kinds that were cut)
 */
export function eraseCells(draft, cells, labelIds = []) {
  const result = { roads: 0, obstacles: 0, labels: 0, kinds: [] };
  for (const [cx, cy] of cells) {
    if (eraseRoadCell(draft, cx, cy)) result.roads++;
    for (const kind of carveObstacles(draft, cx, cy)) {
      result.obstacles++;
      if (!result.kinds.includes(kind)) result.kinds.push(kind);
    }
  }
  for (const id of labelIds) if (removeLabel(draft, id)) result.labels++;
  return result;
}

/** Undo-step name for an erase: "Erase road", "Erase wall" (or rack, column; "Erase obstacle" for several kinds), "Erase label", or "Erase" for a mix. */
export function eraseLabel(result) {
  const parts = ['roads', 'obstacles', 'labels'].filter((k) => result[k] > 0);
  if (parts.length !== 1) return 'Erase';
  if (parts[0] === 'roads') return 'Erase road';
  if (parts[0] === 'labels') return 'Erase label';
  return result.kinds.length === 1 ? `Erase ${result.kinds[0]}` : 'Erase obstacle';
}
