// Placement tools: the five station types and the obstacle. Hovering shows a ghost brick snapped to the grid (green =
// free, red = blocked), a click places a default-size brick centred on the pointer, press-and-drag sizes it between the
// press cell and the pointer cell (at least 1 x 1, clamped to the baseplate). The tool stays active so several bricks
// can be placed in a row; Shift+click places one and returns to Select, Esc leaves the tool.

import { STATION_TYPES } from '../../model/defaults.js';
import { addStation, addObstacle } from '../../model/layout.js';
import { snapRect, dragRect, blockReason, sizeText, dragThreshold } from './snapping.js';
import { plannerName, obstacleName, newStationName } from './tools.js';

/**
 * @param {object} ed the editor host (see editor.js)
 * @param {string} tool a station type or 'obstacle'
 */
export function createPlaceTool(ed, tool) {
  const isObstacle = tool === 'obstacle';
  let press = null;

  const defaultSize = () => (isObstacle ? { w: 1, h: 1 } : STATION_TYPES[tool].size);
  const noun = () => (isObstacle ? obstacleName(ed.ui().toolOptions.kind) : plannerName(tool));

  /** The rectangle a click or drag at pointer `p` would place. */
  function rectFor(p) {
    const grid = ed.layout().grid;
    const sized = press && press.sized;
    if (sized) return dragRect(press.cell, p.cell, grid);
    const { w, h } = defaultSize();
    return snapRect(p.ux, p.uy, w, h, grid);
  }

  function showGhost(p) {
    const layout = ed.layout();
    const rect = rectFor(p);
    const reason = blockReason(layout, rect);
    ed.view.ghost = isObstacle
      ? { kind: 'obstacle', obstacleKind: ed.ui().toolOptions.kind, rect, valid: !reason }
      : { kind: 'station', type: tool, rect, valid: !reason };
    ed.status(reason ? `Cannot place ${noun()} here: ${reason}.` : `${noun()} · ${sizeText(rect, layout.grid.cellSize)}`);
    ed.redraw();
    return { rect, reason };
  }

  /** Create the brick as one undo step, select it and apply the Shift rule. Returns true if something was placed. */
  function place(rect, shift) {
    let id = null;
    const ok = ed.commit(`Add ${noun().toLowerCase()}`, (draft) => {
      const item = isObstacle
        ? addObstacle(draft, { ...rect, kind: ed.ui().toolOptions.kind })
        : addStation(draft, { type: tool, ...rect, name: newStationName(draft, tool) });
      id = item ? item.id : null;
      return id !== null;
    });
    if (ok) ed.setSelection({ kind: isObstacle ? 'obstacle' : 'station', ids: [id] });
    if (ok && shift) ed.setTool('select');
    return ok;
  }

  return {
    busy: () => press !== null,
    hover(p) {
      showGhost(p);
    },
    down(p) {
      press = { x: p.x, y: p.y, cell: p.cell, sized: false, shift: p.shift };
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
      if (reason) ed.toast(`Cannot place ${noun()} here: ${reason}.`, { kind: 'warn' });
      else place(rect, shift);
    },
    cancel() {
      press = null;
      ed.view.ghost = null;
    },
  };
}
