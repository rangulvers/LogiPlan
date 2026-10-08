// The select tool: click to select, Shift+click to extend, drag a selected item to move it, drag a handle to resize it,
// drag empty space for a rubber-band selection. Every gesture is one undo step and can be cancelled with Esc.
//
// A press is decided on the first pointer movement beyond the drag threshold: before that it is a click (selection
// changes that must wait for the release, such as "Shift+click on a selected item removes it", happen in `onClick`).
// What a press on a thing does:
//   station / obstacle / label   select it (Shift toggles); dragging moves the whole selection of that kind
//   resize handle                resize the single selected station or obstacle
//   flow handle                  drag to another station to connect them with a flow; a click starts connect mode (connector.js)
//   flow curve / vehicle         click selects the flow / the vehicle's fleet; dragging draws a marquee
//   road cell or empty space     click selects the road cell (or clears the selection); dragging draws a marquee

import { roadAt, getStation, resizeStation, updateObstacle } from '../../model/layout.js';
import { cellKey } from '../../util/grid.js';
import { isHandle, resizeRect } from './resize.js';
import { checkMove, applyMove, isMovable, itemsText, selectionBounds, selectedItems, MOVABLE_KINDS } from './moves.js';
import { rectFromPoints, marqueeHits, pickMarquee, addToSelection, toggleInSelection, isSelected } from './marquee.js';
import { blockReason, sizeText, dragThreshold } from './snapping.js';
import { plannerName, obstacleName, HANDLE_CURSORS } from './tools.js';
import { HANDLE_HINT } from './connect.js';

const NONE = Object.freeze({ kind: null, ids: Object.freeze([]) });

/** Single selected station or obstacle: the only selection that has resize handles. */
const isResizable = (sel) => (sel.kind === 'station' || sel.kind === 'obstacle') && sel.ids.length === 1;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "Move by +3, −2 cells (+6, −4 m)" for the status line. */
function moveText(dx, dy, cellSize) {
  const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `\u2212${-n}` : '0');
  const metres = (n) => sign(Math.round(n * cellSize * 10) / 10);
  return `Move by ${sign(dx)}, ${sign(dy)} cells (${metres(dx)}, ${metres(dy)} m)`;
}

/** The renderer's hover state for a hit, or null when nothing selectable is under the pointer. */
function hoverOf(layout, hit) {
  if (['station', 'obstacle', 'label', 'flow', 'vehicle'].includes(hit.kind)) return { kind: hit.kind, id: hit.id };
  return roadAt(layout, hit.cell[0], hit.cell[1]) ? { kind: 'cell', cell: hit.cell } : null;
}

/** One-line description of what the pointer is over, for the status line. */
function describeHit(layout, hit) {
  const cs = layout.grid.cellSize;
  if (hit.kind === 'station') {
    const s = getStation(layout, hit.id);
    return s ? `${s.name} (${plannerName(s.type)}, ${sizeText(s, cs)})` : '';
  }
  if (hit.kind === 'obstacle') {
    const o = layout.obstacles.find((e) => e.id === hit.id);
    return o ? `${obstacleName(o.kind)} (${sizeText(o, cs)})` : '';
  }
  if (hit.kind === 'label') {
    const l = layout.labels.find((e) => e.id === hit.id);
    return l ? `Label “${l.text}”. Double-click to edit.` : '';
  }
  if (hit.kind === 'flow') {
    const f = layout.flows.find((e) => e.id === hit.id);
    const from = f && getStation(layout, f.from);
    const to = f && getStation(layout, f.to);
    return from && to ? `Flow ${from.name} → ${to.name}` : '';
  }
  if (hit.kind === 'vehicle') return `Vehicle ${hit.id}. Click to select its fleet.`;
  const road = roadAt(layout, hit.cell[0], hit.cell[1]);
  if (!road) return '';
  return road.limit < 1 ? `Road cell, speed limit ${Math.round(road.limit * 100)} %` : 'Road cell';
}

/** @param {object} ed the editor host (see editor.js) */
export function createSelectTool(ed) {
  let g = null;

  const selection = () => ed.ui().selection;
  const travel = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  // ---- press: decide what the gesture could become ----

  function armMove(p, hit) {
    const sel = selection();
    const selected = isSelected(sel, hit.kind, hit.id);
    if (p.shift) {
      const next = toggleInSelection(sel, hit.kind, hit.id);
      if (selected) g.onClick = () => ed.setSelection(next);
      else ed.setSelection(next);
    } else if (!selected) ed.setSelection({ kind: hit.kind, ids: [hit.id] });
    else if (sel.ids.length > 1) g.onClick = () => ed.setSelection({ kind: hit.kind, ids: [hit.id] });
    g.arm = 'move';
    g.anchor = [p.ux, p.uy];
  }

  function armResize(p, hit) {
    const sel = selection();
    const item = selectedItems(ed.layout(), sel)[0];
    if (!item) return;
    g.arm = 'resize';
    g.anchor = [p.ux, p.uy];
    g.handle = hit.handle;
    g.sel = sel;
    g.rect0 = { x: item.x, y: item.y, w: item.w, h: item.h };
  }

  /** A flow curve or a vehicle: a click selects it (its fleet, for a vehicle), a drag from it is a marquee like on empty ground. */
  function armPick(p, hit) {
    const kind = hit.kind === 'flow' ? 'flow' : 'fleet';
    const id = kind === 'flow' ? hit.id : fleetOf(hit.id);
    g.arm = 'marquee';
    g.onClick = () => ed.setSelection(p.shift ? toggleInSelection(selection(), kind, id) : { kind, ids: [id] });
  }

  /** The fleet a vehicle belongs to: from the running simulation, else from the "<fleetId>#<n>" id format. */
  function fleetOf(vehicleId) {
    const sim = ed.renderer.sim;
    const vehicle = sim && sim.vehicles && sim.vehicles.find((v) => v.id === vehicleId);
    return vehicle && vehicle.fleetId ? vehicle.fleetId : String(vehicleId).split('#')[0];
  }

  /** The flow handle of the selected station: a drag connects, a click starts connect mode. */
  function armConnect(hit) {
    g.arm = 'connect';
    g.fromId = hit.id;
    g.onClick = () => ed.startConnect({ fromId: hit.id });
    ed.connector.press(hit.id);
  }

  function armArea(p, hit) {
    g.arm = 'marquee';
    g.onClick = () => {
      if (roadAt(ed.layout(), hit.cell[0], hit.cell[1])) {
        const key = cellKey(hit.cell[0], hit.cell[1]);
        ed.setSelection(p.shift ? toggleInSelection(selection(), 'cell', key) : { kind: 'cell', ids: [key] });
      } else if (!p.shift) ed.setSelection(NONE);
    };
  }

  /** The pointer travelled far enough: turn the armed gesture into a drag. False when there is nothing to drag. */
  function beginDrag() {
    if (g.arm === 'move') {
      g.sel = selection();
      if (!isMovable(g.sel)) {
        g.arm = null;
        return false;
      }
    }
    if (g.arm !== 'marquee') ed.view.resizeHandles = false;
    g.mode = g.arm;
    return true;
  }

  // ---- drag: move ----

  /** Whole cells the pointer has travelled since the press: the item snaps to the nearest grid position. */
  function cellDelta(p) {
    return [Math.round(p.ux - g.anchor[0]) + 0, Math.round(p.uy - g.anchor[1]) + 0];
  }

  function updateMove(p) {
    const [dx, dy] = cellDelta(p);
    const layout = ed.layout();
    const check = checkMove(layout, g.sel, dx, dy);
    g.delta = [dx, dy];
    g.check = check;
    ed.view.ghost = null;
    ed.view.marquee = null;
    if (g.sel.kind === 'label') showLabelTarget(layout, check);
    else if (g.sel.ids.length === 1) showRectGhost(g.sel.kind, check.moves[0], check.ok);
    else showGroupBox(layout, dx, dy);
    ed.status(check.ok ? moveText(dx, dy, layout.grid.cellSize) : `Cannot move here: ${check.reason}.`);
    ed.redraw();
  }

  function showRectGhost(kind, move, valid) {
    if (kind === 'station') ed.view.ghost = { kind: 'station', type: move.type, rect: move.to, valid };
    else ed.view.ghost = { kind: 'obstacle', obstacleKind: move.obstacleKind, rect: move.to, valid };
  }

  /** Several items move: the renderer has one ghost slot, so the group's bounding box stands for them. */
  function showGroupBox(layout, dx, dy) {
    const box = selectionBounds(layout, g.sel);
    const cs = layout.grid.cellSize;
    ed.view.marquee = { x: (box.x + dx) * cs, y: (box.y + dy) * cs, w: box.w * cs, h: box.h * cs };
  }

  /** Labels have no ghost: a one-cell outline marks where the anchor would land. */
  function showLabelTarget(layout, check) {
    const cs = layout.grid.cellSize;
    const to = check.moves[0].to;
    ed.view.marquee = { x: (to.x - 0.5) * cs, y: (to.y - 0.5) * cs, w: cs, h: cs };
  }

  function finishMove(p) {
    updateMove(p);
    const [dx, dy] = g.delta;
    if (dx === 0 && dy === 0) return;
    if (!g.check.ok) {
      ed.toast(`Cannot move here: ${g.check.reason}.`, { kind: 'warn' });
      return;
    }
    const { sel } = g;
    ed.commit(`Move ${itemsText(ed.layout(), sel)}`, (draft) => applyMove(draft, sel, dx, dy));
  }

  // ---- drag: resize ----

  function updateResize(p) {
    const layout = ed.layout();
    const { sel } = g;
    const [dx, dy] = cellDelta(p);
    const rect = resizeRect(g.rect0, g.handle, dx, dy, layout.grid);
    const ignore = sel.kind === 'station' ? { ignoreStation: sel.ids[0] } : { ignoreObstacle: sel.ids[0] };
    const reason = blockReason(layout, rect, ignore);
    g.rect = rect;
    g.reason = reason;
    if (sel.kind === 'station') ed.view.ghost = { kind: 'station', type: getStation(layout, sel.ids[0]).type, rect, valid: !reason };
    else ed.view.ghost = { kind: 'obstacle', obstacleKind: layout.obstacles.find((o) => o.id === sel.ids[0]).kind, rect, valid: !reason };
    ed.status(reason ? `Cannot resize here: ${reason}.` : `Size ${sizeText(rect, layout.grid.cellSize)}`);
    ed.redraw();
  }

  function finishResize(p) {
    updateResize(p);
    const { rect, rect0, reason, sel } = g;
    if (['x', 'y', 'w', 'h'].every((k) => rect[k] === rect0[k])) return;
    if (reason) {
      ed.toast(`Cannot resize here: ${reason}.`, { kind: 'warn' });
      return;
    }
    const id = sel.ids[0];
    ed.commit(`Resize ${itemsText(ed.layout(), sel)}`, (draft) => (sel.kind === 'station' ? resizeStation(draft, id, rect) : updateObstacle(draft, id, rect)));
  }

  // ---- drag: marquee ----

  function updateMarquee(p) {
    const cs = ed.layout().grid.cellSize;
    const r = rectFromPoints(g.p0.wx, g.p0.wy, p.wx, p.wy);
    ed.view.marquee = r;
    const hits = marqueeHits(ed.layout(), rectFromPoints(g.p0.wx / cs, g.p0.wy / cs, p.wx / cs, p.wy / cs));
    const picked = pickMarquee(hits);
    ed.status(picked.kind ? `${plural(picked.ids.length, picked.kind, `${picked.kind}s`)} in the area` : 'Drag over stations, walls or labels to select them.');
    ed.redraw();
  }

  function finishMarquee(p) {
    const cs = ed.layout().grid.cellSize;
    const hits = marqueeHits(ed.layout(), rectFromPoints(g.p0.wx / cs, g.p0.wy / cs, p.wx / cs, p.wy / cs));
    const next = pickMarquee(hits);
    ed.setSelection(p.shift ? addToSelection(selection(), next) : next);
  }

  function clearTransient() {
    ed.view.ghost = null;
    ed.view.marquee = null;
    ed.connector.endDrag();
  }

  return {
    busy: () => g !== null,
    down(p) {
      const hit = ed.hit(p);
      g = { mode: 'press', p0: p, arm: null, onClick: null };
      if (hit.kind === 'connect-handle') armConnect(hit);
      else if (isHandle(hit.handle) && isResizable(selection())) armResize(p, hit);
      else if (MOVABLE_KINDS.includes(hit.kind)) armMove(p, hit);
      else if (hit.kind === 'flow' || hit.kind === 'vehicle') armPick(p, hit);
      else armArea(p, hit);
      return true;
    },
    move(p) {
      if (g.mode === 'press') {
        if (!g.arm || travel(g.p0, p) < dragThreshold(p.type) || !beginDrag()) return;
      }
      if (g.mode === 'move') updateMove(p);
      else if (g.mode === 'resize') updateResize(p);
      else if (g.mode === 'marquee') updateMarquee(p);
      else if (g.mode === 'connect') ed.connector.dragMove(g.fromId, p);
    },
    up(p) {
      if (g.mode === 'press') g.onClick?.();
      else if (g.mode === 'move') finishMove(p);
      else if (g.mode === 'resize') finishResize(p);
      else if (g.mode === 'marquee') finishMarquee(p);
      else if (g.mode === 'connect') ed.connector.dragDrop(g.fromId, p);
      g = null;
      clearTransient();
    },
    cancel() {
      g = null;
      clearTransient();
    },
    hover(p) {
      const layout = ed.layout();
      const hit = ed.hit(p);
      const onHandle = hit.kind === 'connect-handle';
      ed.connector.hoverHandle(onHandle);
      if (onHandle) {
        ed.view.hover = null;
        ed.cursor('crosshair');
        ed.hoverStatus(p, HANDLE_HINT);
        return;
      }
      ed.view.hover = hoverOf(layout, hit);
      if (isHandle(hit.handle) && isResizable(selection())) ed.cursor(HANDLE_CURSORS[hit.handle]);
      else if (hit.handle === 'move') ed.cursor('move');
      else ed.cursor(ed.view.hover ? 'pointer' : 'default');
      ed.hoverStatus(p, describeHit(layout, hit));
    },
  };
}
