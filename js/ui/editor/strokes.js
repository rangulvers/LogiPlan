// Draw modes of the road, one-way, eraser and speed-zone tools: how the cells of a dragged stroke follow the pointer.
// Pure, no DOM (unit-tested in Node, tests/ui.editor.strokes.test.js).
//
// A planner draws almost only orthogonal aisles, and a hand never moves in a perfect line: a free-hand stroke that
// follows the pointer cell by cell wobbles ("jumps around"). Three modes decide how much of the wobble is kept:
//
//   smart     (default) The stroke follows the pointer but is straight by intent. It has an axis (horizontal or
//             vertical), picked once the pointer is SMART_AXIS_PICK cells away from where it was pressed, and it
//             runs along that axis to the pointer's projection. A TURN happens only when the pointer is clearly off
//             the line (TURN_THRESHOLD cells or more): then ONE corner is placed at the projected cell and the stroke
//             goes on along the other axis. A pointer that wobbles by less than that never makes a jog. Moving the
//             pointer back along the stroke retracts it, also back through corners, segment by segment; a pointer
//             that comes back close to the line of the previous segment straightens the corner out again. Fast
//             jumps are interpolated, so the result depends on where the pointer went, not on how often it was sampled.
//   straight  (hold Shift) One straight line from where the stroke started. The axis locks once the pointer is
//             STRAIGHT_AXIS_LOCK cells away and never changes afterwards, however the pointer swings.
//   free      The old behaviour: every cell the pointer visits, a gap left by a fast pointer is filled with an L-path.
//
// Changing the mode in the middle of a stroke (Shift pressed or released) ends the current run and starts a new one at
// the current end, in the new mode, with the pointer position of that moment as its reference.
//
// A stroke is a list of cells [cx, cy] in which consecutive cells are always 4-neighbours and never equal. A stroke may
// cross or touch itself (closing a loop on its start cell is allowed: the model paints repeated cells harmlessly).
//
//   const s = createStroke({ at: [ux, uy] });   // (ux, uy): pointer position in fractional cells, as p.ux / p.uy
//   s.move(ux, uy);                              // for every pointer sample, in order (coalesced samples included)
//   s.setMode('straight');                       // Shift pressed
//   s.cells                                      // the stroke so far

import { extendStroke } from './paths.js';
import { lPath } from '../../util/grid.js';

/** The draw modes, in the order of the tool-options control. */
export const DRAW_MODES = Object.freeze(['smart', 'straight', 'free']);
/** Mode of a fresh install (store.ui.toolOptions.drawMode). */
export const DEFAULT_DRAW_MODE = 'smart';
/** Cells the pointer must be off the line of a smart stroke (perpendicular offset, whole cells) before the stroke turns. */
export const TURN_THRESHOLD = 2;
/** Cells the pointer must have moved from the press point before a smart stroke picks its axis. */
export const SMART_AXIS_PICK = 1;
/** Cells the pointer must have moved from the press point before a straight stroke locks its axis. */
export const STRAIGHT_AXIS_LOCK = 1.5;
/** Pointer travel (px) a finger needs before a smart stroke may turn: a fingertip wobbles more than a mouse. */
export const TOUCH_TURN_PX = 28;
/** Longest step (cells) between two pointer positions that are fed to the stroke; longer jumps are interpolated. */
export const MAX_STEP = 0.5;

const MAX_STEPS_PER_MOVE = 1024;

/** Is `mode` one of DRAW_MODES? */
export const isDrawMode = (mode) => DRAW_MODES.includes(mode);

/** The mode a stroke starts in: Shift forces 'straight', else the chosen mode (junk becomes the default). */
export function effectiveMode({ shift = false, drawMode } = {}) {
  if (shift) return 'straight';
  return isDrawMode(drawMode) ? drawMode : DEFAULT_DRAW_MODE;
}

/**
 * Whole cells of perpendicular offset after which a smart stroke turns: TURN_THRESHOLD, or more where a cell is so small on
 * screen that this would be less than a fingertip's wobble (touch only).
 * @param {number} cellPx size of a cell on screen in CSS px
 * @param {string} [pointerType] 'mouse' | 'pen' | 'touch'
 */
export function turnThreshold(cellPx, pointerType = 'mouse') {
  if (pointerType !== 'touch' || !(cellPx > 0)) return TURN_THRESHOLD;
  return Math.max(TURN_THRESHOLD, Math.ceil(TOUCH_TURN_PX / cellPx));
}

/** Number of corners of a stroke: places where the direction of travel changes. */
export function cornerCount(cells) {
  let corners = 0;
  let prev = null;
  for (let i = 1; i < cells.length; i++) {
    const dx = cells[i][0] - cells[i - 1][0];
    const dy = cells[i][1] - cells[i - 1][1];
    if (dx === 0 && dy === 0) continue;
    if (prev && (prev[0] !== dx || prev[1] !== dy)) corners++;
    prev = [dx, dy];
  }
  return corners;
}

/** "24 m · 12 cells": the length label of the live preview. */
export function lengthText(cellCount, cellSize) {
  const metres = Math.round(cellCount * cellSize * 10) / 10;
  return `${metres} m · ${cellCount} ${cellCount === 1 ? 'cell' : 'cells'}`;
}

/** The click-to-continue line (Shift+click): from the end of the previous stroke to the clicked cell, L-shaped along the dominant axis. */
export const continueLine = (from, to) => lPath(from[0], from[1], to[0], to[1]);

// ---- runs: one stroke piece in one mode ---------------------------------------------------------------------------

const cellAt = (u) => [Math.floor(u[0]), Math.floor(u[1])];
const axisName = (axis) => (axis < 0 ? null : axis === 0 ? 'h' : 'v');
const onAxis = (base, axis, along) => (axis === 0 ? [base[0] + along, base[1]] : [base[0], base[1] + along]);

/** Cells of the polyline through `points` (consecutive points share a row or a column). */
function walk(points) {
  const cells = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length; i++) {
    let [x, y] = points[i - 1];
    const [tx, ty] = points[i];
    const sx = Math.sign(tx - x);
    const sy = Math.sign(ty - y);
    while (x !== tx || y !== ty) {
      if (x !== tx) x += sx; else y += sy;
      cells.push([x, y]);
    }
  }
  return cells;
}

/** Smart run: straight by intent, one corner per deliberate turn, retracts. `origin` is the start cell, `originPos` the pointer there. */
function smartRun(origin, originPos, cfg) {
  const vertices = [origin]; // origin, then one point per corner; the segment being drawn starts at the last one
  let axis = -1; // 0 = along x (horizontal), 1 = along y (vertical), -1 = not picked yet
  let end = origin;
  return {
    mode: 'smart',
    origin,
    get end() { return end; },
    get axis() { return axisName(axis); },
    update(q, u) {
      for (let guard = 0; guard < 64; guard++) {
        const base = vertices[vertices.length - 1];
        if (axis < 0) {
          const dx = u[0] - originPos[0];
          const dy = u[1] - originPos[1];
          if (Math.max(Math.abs(dx), Math.abs(dy)) < cfg.pick) {
            end = origin;
            return;
          }
          axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
        }
        const across = 1 - axis;
        const along = q[axis] - base[axis];
        const aside = q[across] - base[across];
        if (Math.abs(aside) < cfg.turn) {
          end = onAxis(base, axis, along); // on the line (or wobbling around it): the end is the pointer's projection
          return;
        }
        // The pointer is off the line. Close to the line of the previous segment (the one that ends here) it is that
        // segment again: this undoes the corner, whether the pointer went back along it or straight on past it. At the
        // start of the stroke there is no previous segment: the first guess of the axis was wrong, or the stroke
        // bends back on itself right away. Either way no stub of a cell or two is kept.
        if (Math.abs(along) < cfg.turn) {
          if (vertices.length > 1) vertices.pop();
          axis = across;
          continue;
        }
        vertices.push(onAxis(base, axis, along)); // a clear turn: one corner at the projected cell
        axis = across;
      }
      end = vertices[vertices.length - 1];
    },
    cells() {
      return walk([...vertices, end]);
    },
  };
}

/** Straight run: one line from the origin along an axis that locks once and stays. */
function straightRun(origin, originPos, cfg) {
  let axis = -1;
  let end = origin;
  return {
    mode: 'straight',
    origin,
    get end() { return end; },
    get axis() { return axisName(axis); },
    update(q, u) {
      if (axis < 0) {
        const dx = u[0] - originPos[0];
        const dy = u[1] - originPos[1];
        if (Math.max(Math.abs(dx), Math.abs(dy)) < cfg.lock) return;
        axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
      }
      end = axis === 0 ? [q[0], origin[1]] : [origin[0], q[1]];
    },
    cells() {
      return walk([origin, end]);
    },
  };
}

/** Free run: every cell the pointer visits, gaps filled with an L-path. */
function freeRun(origin) {
  const list = [[origin[0], origin[1]]];
  return {
    mode: 'free',
    origin,
    get end() { return list[list.length - 1]; },
    get axis() { return null; },
    update(q) {
      extendStroke(list, q);
    },
    cells() {
      return list;
    },
  };
}

function makeRun(mode, origin, originPos, cfg) {
  if (mode === 'free') return freeRun(origin);
  if (mode === 'straight') return straightRun(origin, originPos, cfg);
  return smartRun(origin, originPos, cfg);
}

// ---- the stroke ---------------------------------------------------------------------------------------------------

/**
 * Start a stroke.
 * @param {{ at: number[], mode?: string, turn?: number, pick?: number, lock?: number }} opts
 *   at: the pointer position when it was pressed, in fractional cells [ux, uy] (the start cell is its floor)
 *   mode: 'smart' | 'straight' | 'free'; turn / pick / lock: the thresholds above (cells; defaults are the constants)
 */
export function createStroke({ at, mode = DEFAULT_DRAW_MODE, turn = TURN_THRESHOLD, pick = SMART_AXIS_PICK, lock = STRAIGHT_AXIS_LOCK }) {
  const cfg = { turn: Math.max(1, Math.round(turn)), pick, lock };
  let last = [at[0], at[1]]; // the latest pointer position
  const done = []; // cells of the finished runs, without the cell that starts the next one
  let run = makeRun(isDrawMode(mode) ? mode : DEFAULT_DRAW_MODE, cellAt(last), last, cfg);
  let cached = null;

  const feed = (u) => {
    run.update(cellAt(u), u);
    cached = null;
  };

  return {
    /** Feed the next pointer position (fractional cells). A jump longer than MAX_STEP is interpolated; non-numbers are ignored. */
    move(ux, uy) {
      if (!Number.isFinite(ux) || !Number.isFinite(uy)) return;
      if (run.mode === 'free') {
        feed([ux, uy]);
      } else {
        const n = Math.min(MAX_STEPS_PER_MOVE, Math.max(1, Math.ceil(Math.max(Math.abs(ux - last[0]), Math.abs(uy - last[1])) / MAX_STEP)));
        for (let i = 1; i < n; i++) feed([last[0] + ((ux - last[0]) * i) / n, last[1] + ((uy - last[1]) * i) / n]);
        feed([ux, uy]);
      }
      last = [ux, uy];
    },
    /** Continue in another mode from the current end (Shift pressed or released mid-stroke). True when the mode changed. */
    setMode(next) {
      if (!isDrawMode(next) || next === run.mode) return false;
      const cells = run.cells();
      done.push(...cells.slice(0, -1));
      run = makeRun(next, cells[cells.length - 1], last, cfg);
      cached = null;
      return true;
    },
    /** The cells of the stroke so far (do not modify). */
    get cells() {
      if (!cached) cached = done.length ? [...done, ...run.cells()] : run.cells();
      return cached;
    },
    /** The last cell. */
    get end() { return run.end; },
    /** The mode the stroke is in now. */
    get mode() { return run.mode; },
    /** The axis of the segment being drawn, 'h' or 'v', or null while it is not picked (and always for free). */
    get axis() { return run.axis; },
    /** True while a straight stroke has locked its axis. */
    get locked() { return run.mode === 'straight' && run.axis !== null; },
    /** The cell the current run started at (the anchor of the axis guide). */
    get runStart() { return run.origin; },
    /** The latest pointer position fed in, in fractional cells. */
    get pointer() { return last; },
  };
}
