// Placement tools: the five station types and the obstacle. Hovering shows a ghost brick snapped to the grid (green =
// free, red = blocked), a click places a default-size brick centred on the pointer, press-and-drag sizes it between the
// press cell and the pointer cell (at least 1 x 1, clamped to the baseplate). The tool stays active so several bricks
// can be placed in a row; Shift+click places one and returns to Select, Esc leaves the tool.
//
// Beyond the edge. With the pointer outside the baseplate the ghost follows it out and the plan grows to hold the brick (ed.showGrowth /
// ed.commitGrow, editor/grow.js): placing is still one undo step, the plan grows by whole blocks of 8 cells.

import { STATION_TYPES } from '../../model/defaults.js';
import { addStation, addObstacle } from '../../model/layout.js';
import { sizeText, dragThreshold } from './snapping.js';
import { plannerName, obstacleName, newStationName } from './tools.js';
import { extentOfRect, blockReasonGrowing, snapRectBeyond, dragRectBeyond, shiftRect, isLimitReason, limitText } from './grow.js';

/**
 * @param {object} ed the editor host (see editor.js)
 * @param {string} tool a station type or 'obstacle'
 */
export function createPlaceTool(ed, tool) {
  const isObstacle = tool === 'obstacle';
  let press = null;
  // The cell of the last placement: while the pointer rests there the ghost stays away. Otherwise the new brick would sit under a red
  // "blocked" ghost of itself and look as if the placement had failed.
  let settled = null;

  const defaultSize = () => (isObstacle ? { w: 1, h: 1 } : STATION_TYPES[tool].size);
  const noun = () => (isObstacle ? obstacleName(ed.ui().toolOptions.kind) : plannerName(tool));

  /** The rectangle a click or drag at pointer `p` would place (beyond the baseplate where the pointer is). */
  function rectFor(p) {
    const grid = ed.layout().grid;
    const sized = press && press.sized;
    if (sized) return dragRectBeyond(press.free, [p.cx, p.cy]);
    const { w, h } = defaultSize();
    return snapRectBeyond(p.ux, p.uy, w, h, grid);
  }

  function showGhost(p) {
    const layout = ed.layout();
    const rect = rectFor(p);
    const reason = blockReasonGrowing(layout, rect);
    ed.view.ghost = isObstacle
      ? { kind: 'obstacle', obstacleKind: ed.ui().toolOptions.kind, rect, valid: !reason }
      : { kind: 'station', type: tool, rect, valid: !reason };
    // the plan grows for a brick that reaches beyond it (shown even when the limit refuses, in the warning colour); not for one that is blocked by something
    ed.showGrowth(!reason || isLimitReason(reason) ? extentOfRect(rect) : null);
    ed.status(reason ? `Cannot place ${noun()} here: ${reason}.` : `${noun()} · ${sizeText(rect, layout.grid.cellSize)}`);
    ed.redraw();
    return { rect, reason };
  }

  /** Create the brick as one undo step (growing the plan if it reaches out), select it and apply the Shift rule. Returns true if something was placed. */
  function place(rect, shift, cell) {
    let id = null;
    settled = cell; // before the commit: the store change refreshes the hover at once
    const ok = ed.commitGrow(`Add ${noun().toLowerCase()}`, extentOfRect(rect), (draft, grown) => {
      settled = [cell[0] + grown.dx, cell[1] + grown.dy]; // the plan may have moved the content: the cell under the pointer has another number now
      const at = shiftRect(rect, grown);
      const item = isObstacle
        ? addObstacle(draft, { ...at, kind: ed.ui().toolOptions.kind })
        : addStation(draft, { type: tool, ...at, name: newStationName(draft, tool) });
      id = item ? item.id : null;
      return id !== null;
    });
    if (ok) ed.setSelection({ kind: isObstacle ? 'obstacle' : 'station', ids: [id] });
    if (ok && !isObstacle) ed.connector.afterPlace(id); // toast: "Goods in placed. Next: where do its loads go?" + Connect
    if (!ok) settled = null;
    if (ok && shift) ed.setTool('select');
    return ok;
  }

  return {
    busy: () => press !== null,
    hover(p) {
      if (settled && p.cx === settled[0] && p.cy === settled[1]) {
        ed.view.ghost = null;
        ed.showGrowth(null);
        ed.status(`${noun()} placed. Click elsewhere to place another, or press Esc to stop.`);
        ed.redraw();
        return;
      }
      settled = null;
      showGhost(p);
    },
    down(p) {
      settled = null;
      press = { x: p.x, y: p.y, cell: p.cell, free: [p.cx, p.cy], sized: false, shift: p.shift };
      showGhost(p);
      return true;
    },
    move(p) {
      const far = Math.hypot(p.x - press.x, p.y - press.y) >= dragThreshold(p.type);
      press.sized = press.sized || (far && (p.cell[0] !== press.cell[0] || p.cell[1] !== press.cell[1]));
      press.shift = press.shift || p.shift;
      showGhost(p);
    },
    up(p) {
      const { rect, reason } = showGhost(p);
      const shift = press.shift || p.shift;
      press = null;
      ed.view.ghost = null;
      if (reason && isLimitReason(reason)) ed.toast(limitText(), { kind: 'warn' });
      else if (reason) ed.toast(`Cannot place ${noun()} here: ${reason}.${isObstacle ? '' : /road/.test(reason) ? ' Put it beside the road, not on it.' : /station/.test(reason) ? ' To select or move a station, choose the Select tool (V).' : ''}`, { kind: 'warn' });
      else place(rect, shift, [p.cx, p.cy]);
    },
    autoPan: () => press !== null && press.sized, // dragging a brick to size it: the view follows the pointer to the edge of the canvas
    cancel() {
      press = null;
      settled = null;
      ed.view.ghost = null;
      ed.showGrowth(null);
    },
  };
}
