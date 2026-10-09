// The plan that grows with the work (docs/ARCHITECTURE.md 6.3): the pure logic behind auto-grow, the edge '+' chips and the
// camera that keeps still. No DOM, unit-tested in Node (tests/ui.editor.grow.test.js).
//
// Auto-grow. While a planner draws a road, places a brick or drags something and the pointer is beyond an edge of the baseplate,
// the editor asks `planGrowth(grid, extent)` how the plan would have to grow for the edit to fit. The answer is a number of whole
// BLOCKS (8 cells, the unit of the baseplate) per side, with one cell of room beyond the edit. The renderer shows that as a
// translucent block of baseplate (view.extension); on release the plan grows by exactly that and the edit is made in the same
// store.commit, so one undo takes both back. Growth on the left or top moves the content (growGrid shifts it); the camera is moved by
// the same amount (`growthOf` / `compensation`) so that nothing moves on screen.
//
// Extents and rectangles are in cells, in the coordinates of the plan BEFORE the growth: negative or beyond cols / rows when the edit
// reaches out. An extent is the half-open box { x0, y0, x1, y1 } (x1, y1 exclusive).

import { GRID_LIMITS, GRID_BLOCK } from '../../model/defaults.js';
import { inBounds } from '../../util/grid.js';
import { clamp } from '../../util/format.js';
import { blockReason } from './snapping.js';

/** Cells in one block of baseplate. */
export const BLOCK = GRID_BLOCK;
/** Empty cells that stay free beyond an edit that made the plan grow. */
export const GROW_MARGIN = 1;
/** The four sides, in the order of the result of planGrowth. */
export const SIDES = Object.freeze(['left', 'top', 'right', 'bottom']);
/** Auto-pan: the width of the zone along the viewport edge (CSS px), the fastest and the slowest pan (CSS px / s). */
export const AUTOPAN_ZONE = 24;
export const AUTOPAN_MAX = 900;
export const AUTOPAN_MIN = 60;
/** Chips on the edges: thickness range of the strip, chip radius (mouse / touch), smallest size of a plan on screen that shows them. */
export const STRIP_MIN = 28;
export const STRIP_MAX = 40;
export const CHIP_RADIUS = 13;
export const CHIP_RADIUS_TOUCH = 17;
export const CHIPS_MIN_CELL_PX = 2;
export const CHIPS_MIN_PLAN_PX = 100;

/** "the plan cannot grow beyond 320 × 320 cells": the reason inside a sentence ("Cannot place Storage here: ..."). */
export const limitReason = () => `the plan cannot grow beyond ${GRID_LIMITS.maxCols} × ${GRID_LIMITS.maxRows} cells`;
/** Is this refusal reason (from blockReasonGrowing / checkMove) the limit of the plan? */
export const isLimitReason = (reason) => typeof reason === 'string' && reason.startsWith('the plan cannot grow beyond');

/** "The plan cannot grow beyond 320 × 320 cells." (also the whole toast when a placement, move or resize is refused for it) */
export const limitText = () => `The plan cannot grow beyond ${GRID_LIMITS.maxCols} × ${GRID_LIMITS.maxRows} cells.`;

// ---- extents ---------------------------------------------------------------------------------------------------------

/** The extent of a rectangle { x, y, w, h } (cells). */
export const extentOfRect = (r) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });

/** The extent of a list of cells [[cx, cy], ...]; null for an empty list. */
export function extentOfCells(cells) {
  if (!cells || cells.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [cx, cy] of cells) {
    if (cx < x0) x0 = cx;
    if (cx > x1) x1 = cx;
    if (cy < y0) y0 = cy;
    if (cy > y1) y1 = cy;
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** The extent that holds all the given extents (nulls are skipped); null when there are none. */
export function unionExtent(...extents) {
  let out = null;
  for (const e of extents) {
    if (!e) continue;
    out = out ? { x0: Math.min(out.x0, e.x0), y0: Math.min(out.y0, e.y0), x1: Math.max(out.x1, e.x1), y1: Math.max(out.y1, e.y1) } : { ...e };
  }
  return out;
}

/** The part of a rectangle { x, y, w, h } that lies on the baseplate, or null when none of it does. */
export function clipToGrid(rect, grid) {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(grid.cols, rect.x + rect.w);
  const y1 = Math.min(grid.rows, rect.y + rect.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A rectangle moved by a growth (`shift` = { dx, dy }, the cells the content moved). */
export const shiftRect = (rect, shift) => ({ ...rect, x: rect.x + shift.dx, y: rect.y + shift.dy });

/** Cells moved by a growth. */
export const shiftCells = (cells, shift) => (shift.dx === 0 && shift.dy === 0 ? cells : cells.map(([cx, cy]) => [cx + shift.dx, cy + shift.dy]));

// ---- how much to grow ------------------------------------------------------------------------------------------------------

/**
 * Whole blocks needed to hold `need` cells beyond an edge, with `margin` empty cells to spare. Nothing needed, nothing added.
 * @example blocksFor(1) === 1; blocksFor(7) === 1; blocksFor(8) === 2 (7 + 1 margin = 8 fits one block, 8 + 1 does not)
 */
export function blocksFor(need, { block = BLOCK, margin = GROW_MARGIN } = {}) {
  return need > 0 ? Math.ceil((need + margin) / block) : 0;
}

/** One axis: how to grow `size` cells so that [lo, hi) fits, within `max`. */
function planAxis(size, lo, hi, max, block, margin) {
  const needLow = Math.max(0, -lo);
  const needHigh = Math.max(0, hi - size);
  const wantLow = blocksFor(needLow, { block, margin }) * block;
  const wantHigh = blocksFor(needHigh, { block, margin }) * block;
  const room = Math.max(0, max - size);
  if (needLow + needHigh > room) {
    // the edit cannot be reached: report the most the plan could grow so that the preview shows the limit
    const low = Math.min(wantLow, room);
    return { low, high: Math.min(wantHigh, room - low), ok: false, limited: true };
  }
  if (wantLow + wantHigh <= room) return { low: wantLow, high: wantHigh, ok: true, limited: false };
  // the whole blocks do not fit, the edit itself does: give each side what the edit needs, then the spare room up to its blocks
  let spare = room - needLow - needHigh;
  const addLow = Math.min(spare, wantLow - needLow);
  spare -= addLow;
  const addHigh = Math.min(spare, wantHigh - needHigh);
  return { low: needLow + addLow, high: needHigh + addHigh, ok: true, limited: true };
}

/**
 * How the plan has to grow for an edit to fit.
 * @param {{ cols: number, rows: number }} grid the plan before the edit
 * @param {{ x0: number, y0: number, x1: number, y1: number }|null} extent what the edit touches, in cells of the plan before it
 * @param {{ block?: number, margin?: number, maxCols?: number, maxRows?: number }} [opts]
 * @returns {{ grows: boolean, ok: boolean, limited: boolean, left: number, top: number, right: number, bottom: number,
 *   cols: number, rows: number, reason: (null|'limit') }}
 *   `left` .. `bottom`: cells to add (multiples of the block, except where the limit leaves less); `ok`: false when the edit would need
 *   more than the largest plan (`left` .. `bottom` then hold the most that fits, for the preview); `limited`: the limit cut a side short;
 *   `cols` / `rows`: the size the plan would have
 */
export function planGrowth(grid, extent, opts = {}) {
  const { block = BLOCK, margin = GROW_MARGIN, maxCols = GRID_LIMITS.maxCols, maxRows = GRID_LIMITS.maxRows } = opts;
  const { cols, rows } = grid;
  if (!extent || !Number.isFinite(extent.x0 + extent.y0 + extent.x1 + extent.y1)) {
    return { grows: false, ok: true, limited: false, left: 0, top: 0, right: 0, bottom: 0, cols, rows, reason: null };
  }
  const x = planAxis(cols, extent.x0, extent.x1, maxCols, block, margin);
  const y = planAxis(rows, extent.y0, extent.y1, maxRows, block, margin);
  const ok = x.ok && y.ok;
  return {
    grows: x.low + x.high + y.low + y.high > 0,
    ok,
    limited: x.limited || y.limited,
    left: x.low,
    top: y.low,
    right: x.high,
    bottom: y.high,
    cols: cols + x.low + x.high,
    rows: rows + y.low + y.high,
    reason: ok ? null : 'limit',
  };
}

/** The plan of one block on one side (the click on an edge chip): `ok` false when that side cannot grow at all, `limited` when less than a block fits. */
export function blockPlan(grid, side, { block = BLOCK, maxCols = GRID_LIMITS.maxCols, maxRows = GRID_LIMITS.maxRows } = {}) {
  const horizontal = side === 'left' || side === 'right';
  const room = Math.max(0, (horizontal ? maxCols - grid.cols : maxRows - grid.rows));
  const n = Math.min(block, room);
  const plan = { grows: n > 0, ok: n > 0, limited: n < block, left: 0, top: 0, right: 0, bottom: 0, cols: grid.cols, rows: grid.rows, reason: n > 0 ? null : 'limit' };
  plan[side] = n;
  if (horizontal) plan.cols += n;
  else plan.rows += n;
  return plan;
}

/**
 * The rectangle of size w x h whose centre is nearest to the pointer: like snapRect, but on an axis on which the pointer is beyond the
 * baseplate the rectangle follows it out (the plan will grow); on the other axis it stays inside the grid.
 */
export function snapRectBeyond(ux, uy, w, h, grid) {
  const rw = Math.min(w, grid.cols);
  const rh = Math.min(h, grid.rows);
  const beyond = pointerBeyond(grid, ux, uy);
  const x = Math.round(ux - rw / 2);
  const y = Math.round(uy - rh / 2);
  return {
    x: beyond.x ? x : clamp(x, 0, grid.cols - rw),
    y: beyond.y ? y : clamp(y, 0, grid.rows - rh),
    w: rw,
    h: rh,
  };
}

/** The rectangle spanned by two cells (both included), not clipped to the grid: a corner beyond the baseplate makes the plan grow. */
export function dragRectBeyond(a, b) {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  return { x: x0, y: y0, w: Math.max(a[0], b[0]) - x0 + 1, h: Math.max(a[1], b[1]) - y0 + 1 };
}

/** The extent of the destinations of a move check (editor/moves.js checkMove): rectangles for stations and walls, the cell of the anchor for labels. */
export function extentOfMoves(moves) {
  const boxes = moves.map((m) => (m.to.w === undefined
    ? { x0: Math.floor(m.to.x), y0: Math.floor(m.to.y), x1: Math.floor(m.to.x) + 1, y1: Math.floor(m.to.y) + 1 }
    : extentOfRect(m.to)));
  return unionExtent(...boxes);
}

/**
 * The extent of a label anchored at (x, y) in cells, for the plan to grow to hold it: an anchor on the baseplate (the far edge included,
 * labels may sit on it) needs nothing; beyond it the plan has to reach the cell of the anchor.
 */
export function labelExtent(grid, x, y) {
  const axis = (v, size) => (v < 0 ? [Math.floor(v), 1] : v > size ? [0, Math.ceil(v)] : [0, 1]);
  const [x0, x1] = axis(x, grid.cols);
  const [y0, y1] = axis(y, grid.rows);
  return { x0, y0, x1, y1 };
}

/** The part of a plan the model's growGrid takes: { left, top, right, bottom }. */
export const sidesOf = (plan) => ({ left: plan.left, top: plan.top, right: plan.right, bottom: plan.bottom });

const NOUN = { left: ['column', 'on the left'], right: ['column', 'on the right'], top: ['row', 'above'], bottom: ['row', 'below'] };

/** "8 columns on the right and 8 rows below" for the sides a plan grows on (empty when it does not). */
export function growthParts(plan) {
  const parts = [];
  for (const side of SIDES) {
    const n = plan[side];
    if (n > 0) parts.push(`${n} ${NOUN[side][0]}${n === 1 ? '' : 's'} ${NOUN[side][1]}`);
  }
  return parts;
}

/** Sentence for the status line while an edit would grow the plan: "The plan grows by 8 columns on the right and 8 rows below." */
export function describeGrowth(plan) {
  if (!plan.ok) return limitText();
  const parts = growthParts(plan);
  if (parts.length === 0) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `The plan grows by ${list}.`;
}

/** "48 × 32 cells, 96 × 64 m" */
export function sizeLine(cols, rows, cellSize) {
  const m = (n) => Math.round(n * cellSize * 10) / 10;
  return `${cols} × ${rows} cells, ${m(cols)} × ${m(rows)} m`;
}

// ---- what the pointer may reach ---------------------------------------------------------------------------------------------

/** How far beyond the baseplate a pointer position is kept (cells): the plan could never grow further than the limit anyway. */
export const REACH = GRID_LIMITS.maxCols;

/** A pointer position in fractional cells kept inside the window the plan could ever grow into (so a far pointer cannot make a huge stroke). */
export function reachPoint(ux, uy, grid) {
  return [clamp(ux, -REACH, grid.cols + REACH), clamp(uy, -REACH, grid.rows + REACH)];
}

/** Which axes the pointer is beyond the baseplate on: { x, y } (true = left of / right of, above / below the plan). */
export function pointerBeyond(grid, ux, uy) {
  return { x: ux < 0 || ux >= grid.cols, y: uy < 0 || uy >= grid.rows };
}

/** Is cell [cx, cy] on the baseplate or in the room the plan could still grow into on that side? */
export function inReach(grid, cx, cy, maxCols = GRID_LIMITS.maxCols, maxRows = GRID_LIMITS.maxRows) {
  const roomX = Math.max(0, maxCols - grid.cols);
  const roomY = Math.max(0, maxRows - grid.rows);
  return cx >= -roomX && cx < grid.cols + roomX && cy >= -roomY && cy < grid.rows + roomY;
}

/**
 * Why a rectangle cannot be used when the plan may grow, as a short phrase, or null when it is free. `axes` = { x, y }: the axes on which
 * the rectangle may leave the baseplate (the pointer is beyond an edge there); on another axis it must stay inside, as before.
 * The part outside is empty ground by definition, so only the part on the baseplate is looked at for stations, walls and roads.
 */
export function blockReasonGrowing(layout, rect, ignore = {}, axes = { x: true, y: true }) {
  const { cols, rows } = layout.grid;
  const outX = rect.x < 0 || rect.x + rect.w > cols;
  const outY = rect.y < 0 || rect.y + rect.h > rows;
  if ((outX && !axes.x) || (outY && !axes.y)) return 'it would leave the plant area';
  if (outX || outY) {
    const plan = planGrowth(layout.grid, extentOfRect(rect));
    if (!plan.ok) return limitReason();
  }
  const inside = clipToGrid(rect, layout.grid);
  return inside ? blockReason(layout, inside, ignore) : null;
}

/** A cell for a placement or a stroke start: kept inside the window of reach, not clamped to the baseplate. */
export function reachCell(cx, cy, grid) {
  return [clamp(cx, -REACH, grid.cols + REACH - 1), clamp(cy, -REACH, grid.rows + REACH - 1)];
}

/** Is the cell on the baseplate? */
export const onPlan = (grid, cx, cy) => inBounds(cx, cy, grid.cols, grid.rows);

/** Is the cell beyond what the plan could ever grow to (so a stroke that runs into it stops at the limit, not at a station)? */
export const beyondLimit = (grid, [cx, cy]) => !onPlan(grid, cx, cy) && !inReach(grid, cx, cy);

// ---- auto-pan -----------------------------------------------------------------------------------------------------------------------

/**
 * How fast the view pans while the pointer rests near (or beyond) the edge of the viewport during a drag: the pan in CSS px / s along
 * x and y for `camera.pan` (positive x = the content moves right, i.e. the view looks left). Zero in the middle; within AUTOPAN_ZONE of an
 * edge the speed grows with the square of the proximity from AUTOPAN_MIN to AUTOPAN_MAX and stays at the maximum beyond the edge.
 * @param {number} x pointer position in the viewport (px, from the top-left corner)
 * @param {number} width viewport size
 */
export function autoPanVelocity(x, y, width, height, { zone = AUTOPAN_ZONE, max = AUTOPAN_MAX, min = AUTOPAN_MIN } = {}) {
  const axis = (p, size) => {
    if (!(size > 4 * zone) || !Number.isFinite(p)) return 0;
    const low = zone - p; // > 0 inside the zone at the low edge
    const high = p - (size - zone);
    if (low <= 0 && high <= 0) return 0;
    const near = clamp((low > 0 ? low : high) / zone, 0, 1);
    const speed = min + (max - min) * near * near;
    return low > 0 ? speed : -speed;
  };
  return [axis(x, width), axis(y, height)];
}

// ---- the camera keeps still ------------------------------------------------------------------------------------------------------------------

const growth = new WeakMap();

/**
 * Remember that `layout` (the draft of a store.commit, which becomes the new layout) was made by shifting the content of its predecessor by
 * (dx, dy) cells. The editor reads it back to move the camera by the same distance, on the commit and on undo / redo of it.
 * @param {object} layout the layout the shift belongs to
 * @param {{ dx: number, dy: number }} shift what growGrid / trimGrid returned
 */
export function noteGrowth(layout, shift) {
  if (layout && typeof layout === 'object' && shift && (shift.dx || shift.dy)) growth.set(layout, { dx: shift.dx, dy: shift.dy });
}

/** The shift noted for a layout, or null. */
export const growthOf = (layout) => (layout && typeof layout === 'object' ? growth.get(layout) || null : null);

/**
 * How far the content moved (cells) between the layout the editor saw before and the one it sees now.
 * 'commit' / 'redo': the new layout carries its own shift; 'undo': the layout that was left carries it, reversed.
 * @param {string} type store notification type
 * @param {object} previous layout before the change
 * @param {object} current layout after the change
 * @returns {{ dx: number, dy: number }|null}
 */
export function contentShift(type, previous, current) {
  if (type === 'commit' || type === 'redo') {
    const g = growthOf(current);
    return g ? { dx: g.dx, dy: g.dy } : null;
  }
  if (type === 'undo') {
    const g = growthOf(previous);
    return g ? { dx: 0 - g.dx, dy: 0 - g.dy } : null;
  }
  return null;
}

// ---- the '+' chips on the edges of the baseplate ------------------------------------------------------------------------------------------

/**
 * Strips and chips along the four edges of the baseplate in CSS px, for drawing and hit testing. `v` describes the view: ox, oy (screen
 * position of the plan's top-left corner), cellPx (size of a cell on screen), cols, rows, w, h (viewport). Empty when the plan is too small
 * on screen (cells under CHIPS_MIN_CELL_PX or a plan under CHIPS_MIN_PLAN_PX) or when no edge is in view.
 * Each entry: { side, strip: { x, y, w, h }, chip: { x, y, r }, along } - the strip lies OUTSIDE the plan next to the edge; the chip sits at the
 * middle of the part of the edge that is in view, so it can be reached when the plan is larger than the window.
 * @returns {Array<{ side: string, strip: object, chip: object }>}
 */
export function edgeChips(v, { coarse = false } = {}) {
  const planW = v.cols * v.cellPx;
  const planH = v.rows * v.cellPx;
  if (!(v.cellPx >= CHIPS_MIN_CELL_PX) || Math.min(planW, planH) < CHIPS_MIN_PLAN_PX) return [];
  const t = clamp(v.cellPx * 2, STRIP_MIN, STRIP_MAX);
  const r = coarse ? CHIP_RADIUS_TOUCH : CHIP_RADIUS;
  const left = v.ox;
  const top = v.oy;
  const right = v.ox + planW;
  const bottom = v.oy + planH;
  const out = [];
  const spanX = [Math.max(left, 0), Math.min(right, v.w)];
  const spanY = [Math.max(top, 0), Math.min(bottom, v.h)];
  const add = (side, strip, cx, cy) => {
    if (strip.x + strip.w <= 0 || strip.y + strip.h <= 0 || strip.x >= v.w || strip.y >= v.h) return; // the strip is out of view
    out.push({ side, strip, chip: { x: cx, y: cy, r } });
  };
  if (spanY[1] - spanY[0] >= 2 * r + 4) {
    const cy = (spanY[0] + spanY[1]) / 2;
    add('left', { x: left - t, y: top, w: t, h: planH }, left - t / 2, cy);
    add('right', { x: right, y: top, w: t, h: planH }, right + t / 2, cy);
  }
  if (spanX[1] - spanX[0] >= 2 * r + 4) {
    const cx = (spanX[0] + spanX[1]) / 2;
    add('top', { x: left, y: top - t, w: planW, h: t }, cx, top - t / 2);
    add('bottom', { x: left, y: bottom, w: planW, h: t }, cx, bottom + t / 2);
  }
  // a chip that does not fit into the viewport as a whole (the plan fills the window on that side: zoom out for room) is left out
  const room = r + 2;
  return out.filter((e) => e.chip.x >= room && e.chip.y >= room && e.chip.x <= v.w - room && e.chip.y <= v.h - room);
}

/** The side whose chip contains the point (px, py), with a little slack, or null. */
export function chipAt(chips, px, py, slack = 3) {
  for (const e of chips) {
    if (Math.hypot(px - e.chip.x, py - e.chip.y) <= e.chip.r + slack) return e.side;
  }
  return null;
}

/** The side whose strip contains the point, or null (hover feedback only: a strip does not take clicks). */
export function stripAt(chips, px, py) {
  for (const e of chips) {
    const s = e.strip;
    if (px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h) return e.side;
  }
  return null;
}

/** Tools during which the edge chips are offered: Select and the drawing tools (not the eraser, speed zones, pan or the flow tool). */
export const CHIP_TOOLS = Object.freeze(['select', 'road', 'oneway', 'source', 'process', 'storage', 'sink', 'depot', 'obstacle', 'label']);

/** One block on one side: the argument of growGrid for a click on a chip. */
export const blockOn = (side) => ({ [side]: BLOCK });
