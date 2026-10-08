// Path tools of the canvas editor: two-way road, one-way road, speed zone and eraser. They all work the same way:
// press, drag a free-hand path across the grid with a live preview, release to apply it as ONE undo step.
//
// Modifiers: Shift = straight (L-shaped) line from the press point; Alt = erase while a road tool is active, or remove
// the limit while the speed-zone tool is active. A stroke that runs into a station or wall paints only up to it and
// shows the rest in red.

import { paintRoadPath, setRoadLimit, roadAt, cloneLayout } from '../../model/layout.js';
import { extendStroke, straightStroke, clipStroke, uniqueCells, lastDirection } from './paths.js';
import { eraseCells, eraseLabel } from './erase.js';

const DRAWING = new Set(['road', 'oneway']);

/** What a stroke does: the tool's own job, except that Alt turns drawing into erasing and a speed zone into "no limit". */
function strokeKind(tool, alt) {
  if (!alt) return tool;
  return tool === 'speedzone' ? 'clear' : 'erase';
}

const pluralCells = (n) => `${n} ${n === 1 ? 'cell' : 'cells'}`;
const metres = (cells, cellSize) => Math.round(cells * cellSize * 10) / 10;
const BLOCKED_TEXT = 'A station or wall is in the way: the road stops before it.';
const NO_ROAD_TEXT = 'Speed zones apply to road cells: draw a road first.';

/**
 * @param {object} ed the editor host (see editor.js)
 * @param {'road'|'oneway'|'speedzone'|'erase'} tool
 */
export function createPathTool(ed, tool) {
  let stroke = null;

  function addCells(p) {
    const straight = p.shift && DRAWING.has(stroke.kind);
    for (const cell of p.path) {
      if (straight) stroke.cells = straightStroke(stroke.start, cell);
      else extendStroke(stroke.cells, cell);
    }
    if (stroke.kind === 'erase') {
      const hit = ed.hit(p);
      if (hit.kind === 'label') stroke.labels.add(hit.id);
    }
  }

  function preview() {
    const layout = ed.layout();
    const cs = layout.grid.cellSize;
    const { kind, cells } = stroke;
    if (DRAWING.has(kind)) {
      const { paint, blocked } = clipStroke(layout, cells);
      const dir = lastDirection(cells);
      ed.view.paintPreview = { cells: paint.length ? paint : blocked.slice(0, 1), blocked, oneWay: kind === 'oneway', dir: dir >= 0 ? dir : undefined };
      const n = uniqueCells(paint).length;
      const name = kind === 'oneway' ? 'One-way road' : 'Road';
      ed.status(blocked.length ? BLOCKED_TEXT : `${name}: ${pluralCells(n)} (${metres(n, cs)} m)`);
    } else if (kind === 'erase') {
      const unique = uniqueCells(cells);
      ed.view.paintPreview = { cells: unique, blocked: unique };
      ed.status(`Erasing ${pluralCells(unique.length)}`);
    } else {
      const roads = uniqueCells(cells).filter(([cx, cy]) => roadAt(layout, cx, cy));
      ed.view.paintPreview = roads.length ? { cells: roads } : null;
      const verb = kind === 'clear' ? 'Removing the limit on' : 'Speed limit on';
      ed.status(roads.length ? `${verb} ${pluralCells(roads.length)}` : NO_ROAD_TEXT);
    }
    ed.redraw();
  }

  function finish() {
    const { kind, cells, labels } = stroke;
    if (DRAWING.has(kind)) drawRoad(kind, cells);
    else if (kind === 'erase') erase(cells, [...labels]);
    else applySpeed(kind, cells);
  }

  function drawRoad(kind, cells) {
    const oneWay = kind === 'oneway';
    const { paint } = clipStroke(ed.layout(), cells);
    if (!paint.length) {
      ed.toast('Roads cannot be placed on stations or walls.', { kind: 'warn' });
      return;
    }
    ed.commit(oneWay ? 'Draw one-way road' : 'Draw road', (draft) => { paintRoadPath(draft, cells, { oneWay }); });
  }

  function erase(cells, labels) {
    const unique = uniqueCells(cells);
    const label = eraseLabel(eraseCells(cloneLayout(ed.layout()), unique, labels));
    ed.commit(label, (draft) => { eraseCells(draft, unique, labels); });
  }

  function applySpeed(kind, cells) {
    const factor = kind === 'clear' ? 1 : (ed.ui().toolOptions.factor ?? 0.5);
    const unique = uniqueCells(cells);
    ed.commit(factor >= 1 ? 'Clear speed zone' : 'Set speed zone', (draft) => {
      for (const [cx, cy] of unique) setRoadLimit(draft, cx, cy, factor);
    });
  }

  return {
    busy: () => stroke !== null,
    down(p) {
      stroke = { kind: strokeKind(tool, p.alt), start: p.cell, cells: [], labels: new Set() };
      addCells(p);
      preview();
      return true;
    },
    move(p) {
      ed.view.hover = { kind: 'cell', cell: p.cell };
      addCells(p);
      preview();
    },
    modifiers(p) {
      if (stroke) this.move({ ...p, path: [p.cell] });
    },
    up(p) {
      addCells(p);
      finish();
      stroke = null;
      ed.view.paintPreview = null;
    },
    cancel() {
      stroke = null;
      ed.view.paintPreview = null;
    },
    hover(p) {
      ed.view.hover = { kind: 'cell', cell: p.cell };
      ed.hoverStatus(p);
    },
  };
}
