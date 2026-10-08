// Moving, nudging and duplicating the selection: which items can move, whether a move is valid, applying it to a
// layout draft, and where copies go. Pure functions on plain layouts, no DOM (unit-tested in Node).
//
// A selection holds ids of ONE kind (the store's contract), so a move is a set of stations, or of obstacles, or of
// labels, translated by the same whole number of cells.

import { addFlow, addObstacle, addLabel, duplicateStation, updateLabel } from '../../model/layout.js';
import { blockReason } from './snapping.js';

/** Selection kinds the select tool can move. */
export const MOVABLE_KINDS = Object.freeze(['station', 'obstacle', 'label']);

const LISTS = { station: 'stations', obstacle: 'obstacles', label: 'labels' };

/** The layout items a selection refers to (ids that no longer exist are skipped). */
export function selectedItems(layout, selection) {
  const list = layout[LISTS[selection && selection.kind]];
  if (!list) return [];
  const wanted = new Set(selection.ids);
  return list.filter((item) => wanted.has(item.id));
}

/** Can this selection be moved or duplicated by the select tool? */
export const isMovable = (selection) => !!selection && MOVABLE_KINDS.includes(selection.kind) && selection.ids.length > 0;

/**
 * Check translating the selection by (dx, dy) cells. Stations and obstacles must land inside the grid on free ground
 * (they may take the place of items that move along with them); labels must stay on the baseplate.
 * @returns {{ ok: boolean, reason: string|null, moves: Array<{ id: string, type?: string, obstacleKind?: string, from: object, to: object }> }}
 *   `moves[i].from/to` are {x,y,w,h} for stations and obstacles and {x,y} for labels.
 */
export function checkMove(layout, selection, dx, dy) {
  const items = selectedItems(layout, selection);
  const kind = selection && selection.kind;
  const moving = new Set(items.map((i) => i.id));
  const rest = {
    ...layout,
    stations: kind === 'station' ? layout.stations.filter((s) => !moving.has(s.id)) : layout.stations,
    obstacles: kind === 'obstacle' ? layout.obstacles.filter((o) => !moving.has(o.id)) : layout.obstacles,
  };
  let reason = items.length ? null : 'nothing to move';
  const moves = items.map((item) => {
    const to = kind === 'label' ? { x: item.x + dx, y: item.y + dy } : { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h };
    const why = kind === 'label' ? labelBlock(layout, to) : blockReason(rest, to);
    if (why && !reason) reason = why;
    const from = kind === 'label' ? { x: item.x, y: item.y } : { x: item.x, y: item.y, w: item.w, h: item.h };
    return { id: item.id, type: item.type, obstacleKind: kind === 'obstacle' ? item.kind : undefined, from, to };
  });
  return { ok: reason === null, reason, moves };
}

function labelBlock(layout, p) {
  return p.x >= 0 && p.y >= 0 && p.x <= layout.grid.cols && p.y <= layout.grid.rows ? null : 'it would leave the baseplate';
}

/**
 * Translate the selection in a layout draft by (dx, dy) cells. Returns false (draft untouched) when checkMove refuses.
 * Positions are assigned directly: moving the items one by one through moveStation could stumble over a neighbour that
 * is about to move too, although the finished arrangement is valid.
 */
export function applyMove(draft, selection, dx, dy) {
  if (!checkMove(draft, selection, dx, dy).ok) return false;
  for (const item of selectedItems(draft, selection)) {
    if (selection.kind === 'label') updateLabel(draft, item.id, { x: item.x + dx, y: item.y + dy });
    else { item.x += dx; item.y += dy; }
  }
  return true;
}

/** Bounding box {x,y,w,h} (cells) of the items of a selection, or null when empty. Labels count as the cell of their anchor. */
export function selectionBounds(layout, selection) {
  const items = selectedItems(layout, selection);
  if (!items.length) return null;
  const rects = items.map((i) => (selection.kind === 'label' ? { x: Math.floor(i.x), y: Math.floor(i.y), w: 1, h: 1 } : i));
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Where copies of the selection go: the first offset (right, below, left, above, then the diagonals; one empty cell
 * between original and copy so a road fits) at which every copy lands on free ground. Labels simply move one cell down.
 * @returns {[number, number]|null} null when there is no room around the selection
 */
export function duplicateOffset(layout, selection) {
  if (selection.kind === 'label') return [0, 1];
  const box = selectionBounds(layout, selection);
  if (!box) return null;
  const gx = box.w + 1;
  const gy = box.h + 1;
  const candidates = [[gx, 0], [0, gy], [-gx, 0], [0, -gy], [gx, gy], [-gx, gy], [gx, -gy], [-gx, -gy]];
  return candidates.find(([dx, dy]) => duplicateFits(layout, selection, dx, dy)) || null;
}

/** Do copies of the selection fit at offset (dx, dy)? Unlike a move, the originals stay where they are. */
function duplicateFits(layout, selection, dx, dy) {
  return selectedItems(layout, selection).every((item) => !blockReason(layout, { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h }));
}

/**
 * Copy the selection in a layout draft, offset by `offset` ([dx, dy]; null = nearest free spot, single station only).
 * Stations keep their settings; flows between two copied stations are copied between the copies.
 * @returns {{ kind: string, ids: string[] }|null} selection of the copies, null when nothing could be copied
 */
export function applyDuplicate(draft, selection, offset) {
  const items = selectedItems(draft, selection);
  const [dx, dy] = offset || [1, 1];
  const created = [];
  const copyOf = new Map();
  for (const item of items) {
    const copy = copyItem(draft, selection.kind, item, dx, dy);
    if (!copy) continue;
    created.push(copy.id);
    copyOf.set(item.id, copy.id);
  }
  if (selection.kind === 'station') copyInternalFlows(draft, copyOf);
  return created.length ? { kind: selection.kind, ids: created } : null;
}

function copyItem(draft, kind, item, dx, dy) {
  if (kind === 'station') return duplicateStation(draft, item.id, { dx, dy });
  if (kind === 'obstacle') return addObstacle(draft, { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h, kind: item.kind });
  return addLabel(draft, { x: item.x + dx, y: item.y + dy, text: item.text, size: item.size });
}

/** Flows whose two ends were both copied are repeated between the copies (with the same settings). */
function copyInternalFlows(draft, copyOf) {
  for (const flow of draft.flows.filter((f) => copyOf.has(f.from) && copyOf.has(f.to))) {
    const { id, from, to, ...settings } = flow;
    addFlow(draft, copyOf.get(from), copyOf.get(to), settings);
  }
}

/** Number of items and what they are called in an undo step: "station", "3 items". */
export function itemsText(layout, selection) {
  const n = selection.ids.length;
  if (n !== 1) return `${n} items`;
  if (selection.kind === 'obstacle') {
    const o = selectedItems(layout, selection)[0];
    return o ? o.kind : 'obstacle';
  }
  return { station: 'station', label: 'label', flow: 'flow', cell: 'road' }[selection.kind] || 'item';
}
