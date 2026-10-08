// Path tools of the canvas editor: two-way road, one-way road, speed zone and eraser. They all work the same way:
// press, drag a path across the grid with a live preview, release to apply it as ONE undo step.
//
// How the stroke follows the pointer is the draw mode (store.ui.toolOptions.drawMode, editor/strokes.js): smart (default,
// straight by intent), straight (also while Shift is held) or free (every cell the pointer visits). Shift pressed or released
// in the middle of a stroke changes the mode from the current end. Shift+click (no drag) with a road tool draws a line from the
// end of the previous stroke to the clicked cell, like click-to-continue in drawing programs; hovering with Shift held previews it.
// Alt = erase while a road tool is active, or remove the limit while the speed-zone tool is active. A stroke that runs into a
// station or wall paints only up to it and shows the rest in red. The preview carries a length label next to the pointer and, for a
// locked straight line, the axis it is locked to.
//
// Beyond the edge. A road or one-way stroke may start, run and end outside the baseplate: the pointer keeps working there and the plan
// grows to hold the stroke (ed.showGrowth while it runs, ed.commitGrow on release: one undo step, whole blocks of 8 cells, editor/grow.js).
// The eraser and the speed zones only act on what exists, so they stay on the baseplate.

import { paintRoadPath, setRoadLimit, roadAt, cloneLayout } from '../../model/layout.js';
import { clamp } from '../../util/format.js';
import { clipStroke, uniqueCells, lastDirection } from './paths.js';
import { extentOfCells, shiftCells, reachPoint, beyondLimit, limitText } from './grow.js';
import { eraseCells, eraseLabel } from './erase.js';
import { createStroke, effectiveMode, turnThreshold, continueLine, lengthText } from './strokes.js';
import { dragThreshold } from './snapping.js';

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
/** Keeps a clamped pointer position inside the last cell instead of on the line after it. */
const EDGE = 1e-6;

/**
 * @param {object} ed the editor host (see editor.js)
 * @param {'road'|'oneway'|'speedzone'|'erase'} tool
 */
export function createPathTool(ed, tool) {
  let stroke = null; // the gesture in progress
  let anchor = null; // { cell: [cx, cy], grid } where this tool's last drawn stroke ended: the start of a Shift+click line (void once the plan changed size or moved)
  let linePreview = false; // view.paintPreview shows the Shift+click line of a pointer that only hovers

  const drawMode = () => ed.ui().toolOptions.drawMode;

  /**
   * A pointer position [ux, uy] (fractional cells) as a stroke of this kind sees it: a road may leave the plant area (the plan grows),
   * every other stroke stops at the edge.
   */
  function inside([ux, uy], kind) {
    const { grid } = ed.layout();
    if (DRAWING.has(kind)) return reachPoint(ux, uy, grid);
    return [clamp(ux, 0, grid.cols - EDGE), clamp(uy, 0, grid.rows - EDGE)];
  }

  /** Where a Shift+click line starts: the end of the previous stroke while that cell is still a road, and not the clicked cell itself. */
  function continuationTo(cell) {
    const layout = ed.layout();
    if (!anchor || anchor.grid !== layout.grid || (anchor.cell[0] === cell[0] && anchor.cell[1] === cell[1])) return null;
    return roadAt(layout, anchor.cell[0], anchor.cell[1]) ? anchor.cell : null;
  }

  /** Feed the pointer positions since the last event (coalesced samples, then the event) to the stroke. */
  function addPoints(p) {
    for (const u of p.trail || [[p.ux, p.uy]]) stroke.builder.move(...inside(u, stroke.kind));
    if (stroke.kind === 'erase') {
      const hit = ed.hit(p);
      if (hit.kind === 'label') stroke.labels.add(hit.id);
    }
  }

  /** A press that waits to become a Shift+click line turns into an ordinary stroke once the pointer has been dragged. */
  function dragged(p) {
    if (stroke.from && Math.hypot(p.x - stroke.press[0], p.y - stroke.press[1]) >= dragThreshold(p.type)) stroke.from = null;
  }

  const cellsOf = () => (stroke.from ? continueLine(stroke.from, stroke.cell) : stroke.builder.cells);

  /**
   * Put `cells` into view.paintPreview: the cells, the blocked tail, one-way chevrons, the length label near `pointer` and
   * the axis `guide` of a locked straight line (label above the pointer when `above`). Returns the status line text that describes it.
   */
  function show(kind, cells, pointer, guide, above = false) {
    const layout = ed.layout();
    const cs = layout.grid.cellSize;
    let n = 0;
    let text;
    if (DRAWING.has(kind)) {
      const { paint, blocked } = clipStroke(layout, cells, { grow: true });
      ed.showGrowth(extentOfCells(paint)); // the plan grows for a stroke that reaches beyond it
      const dir = lastDirection(cells);
      ed.view.paintPreview = { cells: paint.length ? paint : blocked.slice(0, 1), blocked, oneWay: kind === 'oneway', dir: dir >= 0 ? dir : undefined };
      n = uniqueCells(paint).length;
      const name = kind === 'oneway' ? 'One-way road' : 'Road';
      text = blocked.length ? (beyondLimit(layout.grid, blocked[0]) ? `${limitText()} The road stops at its edge.` : BLOCKED_TEXT) : `${name}: ${pluralCells(n)} (${metres(n, cs)} m)`;
    } else if (kind === 'erase') {
      ed.showGrowth(null);
      const unique = uniqueCells(cells);
      ed.view.paintPreview = { cells: unique, blocked: unique };
      n = unique.length;
      text = `Erasing ${pluralCells(n)}`;
    } else {
      ed.showGrowth(null);
      const roads = uniqueCells(cells).filter(([cx, cy]) => roadAt(layout, cx, cy));
      ed.view.paintPreview = roads.length ? { cells: roads } : null;
      n = roads.length;
      const verb = kind === 'clear' ? 'Removing the limit on' : 'Speed limit on';
      text = roads.length ? `${verb} ${pluralCells(roads.length)}` : NO_ROAD_TEXT;
    }
    const preview = ed.view.paintPreview;
    if (preview) {
      preview.guide = guide;
      preview.label = n > 0 ? { text: lengthText(n, cs), ux: pointer[0], uy: pointer[1], above } : null;
    }
    ed.redraw();
    return text;
  }

  function preview() {
    const { builder, kind, from, touch } = stroke;
    ed.status(show(kind, cellsOf(), builder.pointer, !from && builder.locked ? { axis: builder.axis, cell: builder.runStart } : null, touch));
  }

  /** Hovering with Shift held after a stroke: show the line a click would draw. False when there is none to show. */
  function hoverLine(p) {
    const kind = strokeKind(tool, p.alt);
    const at = [p.cx, p.cy]; // not clamped to the plant area: a line may reach beyond it
    const from = DRAWING.has(kind) && p.shift ? continuationTo(at) : null;
    if (!from) return false;
    show(kind, continueLine(from, at), inside([p.ux, p.uy], kind), null);
    linePreview = true;
    ed.hoverStatus(p, 'Click to draw a line from the end of the last stroke.');
    return true;
  }

  function clearLinePreview() {
    if (!linePreview) return;
    linePreview = false;
    ed.view.paintPreview = null;
    ed.showGrowth(null);
    ed.redraw();
  }

  function finish() {
    const { kind, labels } = stroke;
    const cells = cellsOf();
    if (DRAWING.has(kind)) drawRoad(kind, cells);
    else if (kind === 'erase') erase(cells, [...labels]);
    else applySpeed(kind, cells);
  }

  function drawRoad(kind, cells) {
    const oneWay = kind === 'oneway';
    const { paint, blocked } = clipStroke(ed.layout(), cells, { grow: true });
    const atLimit = blocked.length > 0 && beyondLimit(ed.layout().grid, blocked[0]); // the road runs into the edge of the largest plan
    if (!paint.length) {
      ed.toast('Roads cannot be placed on stations or walls.', { kind: 'warn' });
      return;
    }
    let moved = { dx: 0, dy: 0 };
    const done = ed.commitGrow(oneWay ? 'Draw one-way road' : 'Draw road', extentOfCells(paint), (draft, shift) => {
      moved = shift;
      paintRoadPath(draft, shiftCells(cells, shift), { oneWay });
    });
    if (done) {
      const end = paint[paint.length - 1];
      anchor = { cell: [end[0] + moved.dx, end[1] + moved.dy], grid: ed.layout().grid };
      if (atLimit) ed.toast(`${limitText()} The road stops at its edge.`, { kind: 'warn' });
    }
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
    autoPan: () => stroke !== null, // a stroke in progress: the view follows the pointer to the edge of the canvas
    down(p) {
      const kind = strokeKind(tool, p.alt);
      const { cellSize } = ed.layout().grid;
      stroke = {
        kind,
        labels: new Set(),
        cell: DRAWING.has(kind) ? [p.cx, p.cy] : p.cell, // a click-to-continue line may end beyond the plant area
        press: [p.x, p.y],
        touch: p.type === 'touch', // the label goes above the finger
        builder: createStroke({
          at: inside([p.ux, p.uy], kind),
          mode: effectiveMode({ shift: p.shift, drawMode: drawMode() }),
          turn: turnThreshold(cellSize * ed.camera.zoom, p.type),
        }),
        from: DRAWING.has(kind) && p.shift ? continuationTo([p.cx, p.cy]) : null,
      };
      linePreview = false;
      addPoints(p);
      preview();
      return true;
    },
    move(p) {
      ed.view.hover = { kind: 'cell', cell: p.cell };
      dragged(p);
      addPoints(p);
      preview();
    },
    modifiers(p) {
      if (!stroke) return;
      if (!p.shift) stroke.from = null;
      stroke.builder.setMode(effectiveMode({ shift: p.shift, drawMode: drawMode() }));
      preview();
    },
    up(p) {
      dragged(p);
      addPoints(p);
      finish();
      stroke = null;
      ed.view.paintPreview = null;
    },
    cancel() {
      stroke = null;
      anchor = null;
      linePreview = false;
      ed.view.paintPreview = null;
    },
    hover(p) {
      ed.view.hover = { kind: 'cell', cell: p.cell };
      if (hoverLine(p)) return;
      clearLinePreview();
      ed.hoverStatus(p);
    },
  };
}
