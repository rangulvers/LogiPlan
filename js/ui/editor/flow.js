// The flow tool: connect two stations with a material flow. Two ways to do it:
//   drag      press on the sending station, drag (a rubber band follows the pointer), release on the receiving station
//   click     click the sending station, move, click the receiving station (Esc or a click on empty ground cancels)
// A pair that already has a flow selects that flow instead of adding a second one.

import { getStation, addFlow } from '../../model/layout.js';
import { dragThreshold } from './snapping.js';
import { flowProblem, FLOW_FROM } from './tools.js';

/** @param {object} ed the editor host (see editor.js) */
export function createFlowTool(ed) {
  let from = null; // id of the sending station while a flow is being drawn
  let press = null; // the current pointer press, if any

  const stationAt = (p) => {
    const hit = ed.hit(p);
    return hit.kind === 'station' ? getStation(ed.layout(), hit.id) : null;
  };

  function reset() {
    from = null;
    press = null;
    ed.view.flowPreview = null;
    ed.view.hover = null;
  }

  function begin(station) {
    const problem = flowProblem(station, null);
    if (problem) {
      ed.toast(problem, { kind: 'warn' });
      return false;
    }
    from = station.id;
    return true;
  }

  /** Follow the pointer with the rubber band; a valid receiving station under it highlights and the band snaps to its middle. */
  function follow(p) {
    const layout = ed.layout();
    const start = getStation(layout, from);
    if (!start) {
      reset();
      return;
    }
    const over = stationAt(p);
    const target = over && over.id !== from && !flowProblem(start, over) ? over : null;
    const cs = layout.grid.cellSize;
    ed.view.hover = target ? { kind: 'station', id: target.id } : null;
    ed.view.flowPreview = { fromId: from, toPoint: target ? [(target.x + target.w / 2) * cs, (target.y + target.h / 2) * cs] : [p.wx, p.wy] };
    ed.status(over && over.id !== from ? (flowProblem(start, over) || `Connect ${start.name} to ${over.name}`) : `From ${start.name}: move over the receiving station`);
    ed.redraw();
  }

  /** Try to connect `from` to the station under the pointer. Returns true when the flow tool is done with this attempt. */
  function connect(p) {
    const layout = ed.layout();
    const start = getStation(layout, from);
    const target = stationAt(p);
    if (!target || !start || target.id === start.id) return false;
    const problem = flowProblem(start, target);
    if (problem) {
      ed.toast(problem, { kind: 'warn' });
      return false;
    }
    const existing = layout.flows.find((f) => f.from === start.id && f.to === target.id);
    if (existing) {
      ed.setSelection({ kind: 'flow', ids: [existing.id] });
      ed.toast(`${start.name} already sends loads to ${target.name}.`, { kind: 'info' });
      return true;
    }
    let id = null;
    const ok = ed.commit('Add flow', (draft) => {
      const flow = addFlow(draft, start.id, target.id);
      id = flow ? flow.id : null;
      return id !== null;
    });
    if (ok) ed.setSelection({ kind: 'flow', ids: [id] });
    return ok;
  }

  return {
    busy: () => from !== null,
    down(p) {
      const station = stationAt(p);
      if (from === null) {
        if (!station || !begin(station)) return false;
        press = { p0: p, first: true };
      } else press = { p0: p, first: false };
      follow(p);
      return true;
    },
    move(p) {
      if (from !== null) follow(p);
    },
    up(p) {
      const { first, p0 } = press;
      press = null;
      const dragged = Math.hypot(p.x - p0.x, p.y - p0.y) >= dragThreshold(p.type);
      if (first && !dragged) {
        follow(p); // a plain click on the sender: wait for the second click
        return;
      }
      const target = stationAt(p);
      const done = connect(p);
      if (done || first || !target || target.id === from) reset();
    },
    cancel: reset,
    hover(p) {
      if (from !== null) {
        follow(p);
        return;
      }
      const station = stationAt(p);
      const valid = station && FLOW_FROM.includes(station.type);
      ed.view.hover = valid ? { kind: 'station', id: station.id } : null;
      ed.cursor(valid ? 'pointer' : 'crosshair');
      ed.hoverStatus(p, station && !valid ? flowProblem(station, null) : '');
    },
  };
}
