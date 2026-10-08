// The connector: everything the canvas editor does to connect stations, besides the pure rules of connect.js.
//   * the flow handle of the selected station (shown through view.connectHandle, hit as 'connect-handle'),
//   * dragging from that handle: a rubber band, valid targets glow, release on one adds the flow,
//   * connect mode (editor.startConnect): click the receiving station (or, for { toId }, the sending one),
//   * highlighting of valid targets for the flow tool,
//   * the hint toast with a 'Connect' action right after a station was placed.
// The editor owns one connector (`editor.connector`); the select and flow tools and the place tool call into it. Every layout
// change is one `ed.commit` with a human label, so it is undoable.

import { addFlow, getStation, stationAt } from '../../model/layout.js';
import {
  HANDLE_HINT, flowCreatedText, anchorOf, classifyTarget, connectLabel, connectPrompt, connectTargets, connectingText, dropTarget, hasHandle, overText,
  placementPrompt, startProblem,
} from './connect.js';

const PROMPT_MS = 9000;

/** The renderer's `view.connect` for `anchor` with the pointer over station `overId` (or null). */
function targetsView(layout, anchor, overId, verb, cache) {
  const a = anchorOf(anchor);
  if (cache.layout !== layout || cache.anchorId !== a.anchorId || cache.role !== a.role) {
    const t = connectTargets(layout, anchor);
    cache.layout = layout;
    cache.anchorId = a.anchorId;
    cache.role = a.role;
    cache.valid = new Set(t.valid);
    cache.exists = new Set(t.exists);
  }
  let overStatus = null;
  let snap = null;
  if (overId && overId !== a.anchorId) {
    overStatus = classifyTarget(layout, anchor, overId).status;
    if (overStatus === 'valid' || overStatus === 'exists') snap = overId; // the rubber band stops at that brick's edge
  } else overId = null;
  return { role: a.role, anchorId: a.anchorId, valid: cache.valid, exists: cache.exists, over: overId, overStatus, snap, verb };
}

/**
 * @param {object} ed the editor host (see editor.js)
 * @returns the connector: see the methods below
 */
export function createConnector(ed) {
  let mode = null; // connect mode: { anchor, role, anchorId } while the planner picks the other station by clicking
  let drag = null; // a drag from the flow handle: { anchor }
  let pressed = null; // id of the station whose flow handle is held down
  let handle = null; // the object behind view.connectHandle (stable while the same station stays selected)
  let prompt = null; // the hint toast shown after placing a station
  let promptAnchor = null; // what that toast asks about: { fromId } or { toId } (null when it only says what to add)
  let modePrompt = null; // the toast with a Cancel button that says what connect mode wants (touch screens and narrow windows only)
  const cache = { layout: null, anchorId: '', role: '', valid: null, exists: null };

  const centre = (s) => { const cs = ed.layout().grid.cellSize; return [(s.x + s.w / 2) * cs, (s.y + s.h / 2) * cs]; };

  // ---- what the renderer shows ----

  /** Draw the targets (and the rubber band, when there is a pointer) for the gesture in progress. `p` may be null. */
  function show(anchor, p, verb) {
    const layout = ed.layout();
    const a = anchorOf(anchor);
    const here = p ? stationAt(layout, p.cx, p.cy) : null;
    const view = targetsView(layout, anchor, here ? here.id : null, verb, cache);
    ed.view.connect = view;
    if (p) {
      const target = view.snap ? getStation(layout, view.snap) : null;
      const point = target ? centre(target) : [p.wx, p.wy];
      ed.view.flowPreview = a.role === 'from' ? { fromId: a.anchorId, toPoint: point } : { toId: a.anchorId, fromPoint: point };
      ed.status(here && here.id !== a.anchorId ? overText(layout, anchor, here.id, verb) : connectingText(layout, anchor));
      ed.cursor(view.overStatus === 'valid' ? 'pointer' : view.overStatus ? 'not-allowed' : 'crosshair');
    } else {
      ed.view.flowPreview = null;
      ed.status(connectingText(layout, anchor));
    }
    ed.redraw();
  }

  function clearVisuals() {
    ed.view.connect = null;
    ed.view.flowPreview = null;
  }

  /** The visuals follow the state: connect mode first, then a drag, else nothing. */
  function refresh(p) {
    if (mode) show(mode.anchor, p || null, 'Click');
    else if (drag) show(drag.anchor, p || null, 'Drop');
    else clearVisuals();
  }

  // ---- finishing a gesture ----

  /** Add the flow `r` (a dropTarget result) as one undo step, select it and say so. True when it was added. */
  function commitFlow(r) {
    let id = null;
    const ok = ed.commit(r.label, (draft) => {
      const flow = addFlow(draft, r.fromId, r.toId);
      id = flow ? flow.id : null;
      return id !== null;
    });
    if (ok) {
      ed.setSelection({ kind: 'flow', ids: [id] });
      ed.toast(flowCreatedText(ed.layout(), ed.layout().flows.find((f) => f.id === id)), { kind: 'success' });
    } else ed.toast('That flow could not be added. Check the two stations and try again.', { kind: 'warn' });
    return ok;
  }

  /**
   * Act on a release / click at pointer `p`. Returns 'done' (a flow was added or the existing one selected), 'retry' (a station that
   * cannot be the other end: say why and keep going) or 'cancel' (nothing there).
   */
  function resolve(anchor, p, verb) {
    const r = dropTarget(ed.layout(), anchor, [p.cx, p.cy], verb);
    if (r.outcome === 'connect') return commitFlow(r) ? 'done' : 'cancel';
    if (r.outcome === 'exists') {
      ed.setSelection({ kind: 'flow', ids: [r.flowId] });
      ed.toast(r.message, { kind: 'info' });
      return 'done';
    }
    if (r.outcome === 'self' && verb === 'Click') return 'retry'; // a click on the station it started from: keep waiting, say nothing
    ed.toast(r.message, { kind: r.outcome === 'invalid' ? 'warn' : 'info' });
    return r.outcome === 'invalid' ? 'retry' : 'cancel';
  }

  function endMode() {
    if (!mode) return;
    mode = null;
    if (modePrompt) { modePrompt.close(); modePrompt = null; }
    clearVisuals();
    ed.cursor('default');
    ed.status(ed.hint());
    ed.syncView();
    ed.redraw();
  }

  // ---- connect mode: click the other station ----

  const modeHandler = {
    busy: () => mode !== null,
    down(p) {
      refresh(p);
      return true;
    },
    move(p) {
      refresh(p);
    },
    up(p) {
      if (!mode) return;
      const result = resolve(mode.anchor, p, 'Click');
      if (result === 'retry') refresh(p);
      else endMode();
    },
    cancel() {},
    hover(p) {
      refresh(p);
    },
  };

  /** Escape, a tool change or the end of the editor: leave connect mode and any drag from the handle. */
  function cancel() {
    drag = null;
    pressed = null;
    if (mode) endMode();
    else {
      clearVisuals();
      ed.syncView();
      ed.redraw();
    }
  }

  return {
    /** The pointer handler of connect mode, or null while not connecting. */
    get handler() {
      return mode ? modeHandler : null;
    },
    /** Is connect mode on? */
    get mode() {
      return mode !== null;
    },
    /** The anchor of connect mode: { fromId } or { toId }, or null. */
    get anchor() {
      return mode ? mode.anchor : null;
    },

    /**
     * Start connect mode from a station: { fromId } asks where its loads go, { toId } what feeds it. The next click on a valid
     * station adds the flow; Esc cancels. Switches to the Select tool. Returns false (and says why) when it cannot start.
     */
    startConnect(opts) {
      const anchor = opts && typeof opts.fromId === 'string' ? { fromId: opts.fromId } : opts && typeof opts.toId === 'string' ? { toId: opts.toId } : null;
      const problem = anchor ? startProblem(ed.layout(), anchor) : 'Choose a station to connect first.';
      if (problem) {
        ed.toast(problem, { kind: 'warn' });
        return false;
      }
      if (prompt) { prompt.close(); prompt = null; }
      if (ed.tool !== 'select') ed.setTool('select');
      cancel();
      mode = { anchor, ...anchorOf(anchor) };
      ed.clearTransient();
      ed.setSelection({ kind: 'station', ids: [mode.anchorId] });
      refresh(null);
      ed.cursor('crosshair');
      ed.syncView();
      ed.refreshHover();
      // With a finger there is no Esc key, and on a narrow screen the status line cuts the question off: say it in a toast that stays
      if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse), (max-width: 640px)').matches) {
        const handleToast = ed.toast(connectPrompt(ed.layout(), anchor), { kind: 'info', ms: Infinity, action: { label: 'Cancel', onClick: () => { modePrompt = null; cancel(); } } });
        modePrompt = handleToast && typeof handleToast.close === 'function' ? handleToast : null;
      }
      return true;
    },

    /** Status line text while connect mode is on, else null. */
    hint() {
      return mode ? connectingText(ed.layout(), mode.anchor) : null;
    },

    cancel,

    /** Check that the stations of the gesture still exist (after any store change); ends it otherwise. */
    sync() {
      // "Goods out placed. What feeds it?" is answered once a flow reaches (leaves) that station: the question must not hang on
      if (prompt && promptAnchor) {
        const layout = ed.layout();
        const a = anchorOf(promptAnchor);
        const answered = !getStation(layout, a.anchorId) || layout.flows.some((f) => (a.role === 'from' ? f.from : f.to) === a.anchorId);
        if (answered) { prompt.close(); prompt = null; promptAnchor = null; }
      }
      const gone = (a) => !a || !getStation(ed.layout(), a.anchorId);
      if (mode && gone(anchorOf(mode.anchor))) endMode();
      if (drag && gone(anchorOf(drag.anchor))) { drag = null; pressed = null; clearVisuals(); }
    },

    /** The pointer left the canvas: drop the rubber band, keep the glowing targets. */
    pointerLeft() {
      this.hoverHandle(false);
      if (mode) { ed.view.flowPreview = null; if (ed.view.connect) ed.view.connect = { ...ed.view.connect, over: null, overStatus: null, snap: null }; }
    },

    // ---- the flow handle ----

    /** `view.connectHandle` for the current selection and tool, or null when no handle is shown. */
    handleView() {
      const sel = ed.ui().selection;
      if (ed.tool !== 'select' || mode || ed.space || sel.kind !== 'station' || sel.ids.length !== 1) return null;
      const id = sel.ids[0];
      if (!hasHandle(getStation(ed.layout(), id))) return null;
      if (ed.active && pressed !== id) return null;
      if (!handle || handle.id !== id) handle = { id, hover: false, pressed: false };
      handle.pressed = pressed === id;
      return handle;
    },

    /** The pointer is (not) over the handle: grow it, set the tooltip, preview the stations it can connect to. */
    hoverHandle(on) {
      if (handle && handle.hover !== on) {
        handle.hover = on;
        if (on) this.previewTargets({ fromId: handle.id });
        else this.clearTargets();
        ed.redraw();
      }
      const title = on ? HANDLE_HINT : '';
      if (ed.canvas.title !== title) ed.canvas.title = title;
    },

    /** A press landed on the handle of station `id` (select tool). */
    press(id) {
      pressed = id;
      ed.syncView();
    },

    /** The handle was dragged: the rubber band follows the pointer `p`. */
    dragMove(id, p) {
      drag = { anchor: { fromId: id } };
      show(drag.anchor, p, 'Drop');
    },

    /** The handle was released at `p`: connect, or cancel with a hint. */
    dragDrop(id, p) {
      drag = { anchor: { fromId: id } };
      resolve(drag.anchor, p, 'Drop');
      drag = null;
      pressed = null;
      clearVisuals();
    },

    /** A drag or press from the handle ended (also by Esc or a store change): clear what it showed, unless connect mode took over. */
    endDrag() {
      drag = null;
      pressed = null;
      if (mode) refresh(null);
      else clearVisuals();
    },

    // ---- the flow tool ----

    /** Add the flow `fromId` -> `toId` exactly as the handle and connect mode do (label "Connect A → B", selected, toast). True when added. */
    connectStations(fromId, toId) {
      return commitFlow({ fromId, toId, label: connectLabel(ed.layout(), fromId, toId) });
    },

    /** The flow tool has a sender: glow its valid receivers, label the station under the pointer. */
    showTargets(anchor, overId, verb) {
      const layout = ed.layout();
      ed.view.connect = targetsView(layout, anchor, overId, verb, cache);
    },

    /** Hovering a sender (its flow handle, or the Flow tool before the first click): glow where it could send loads, if anywhere. */
    previewTargets(anchor) {
      const view = targetsView(ed.layout(), anchor, null, 'Click', cache);
      if (view.valid.size > 0) ed.view.connect = view;
      else this.clearTargets();
    },

    clearTargets() {
      if (!mode && !drag) ed.view.connect = null;
    },

    // ---- after placing a station ----

    /** Show the hint toast for the station just placed: "Goods in placed. Next: where do its loads go?" with a Connect action. */
    afterPlace(stationId) {
      const info = placementPrompt(ed.layout(), stationId);
      if (prompt) { prompt.close(); prompt = null; }
      promptAnchor = null;
      if (!info) return;
      const opts = { kind: 'info', ms: info.anchor ? PROMPT_MS : undefined };
      if (info.anchor) opts.action = { label: 'Connect', onClick: () => { prompt = null; this.startConnect(info.anchor); } };
      const handleToast = ed.toast(info.text, opts);
      prompt = handleToast && typeof handleToast.close === 'function' ? handleToast : null;
      promptAnchor = prompt ? info.anchor : null;
    },

    destroy() {
      cancel();
      if (prompt) prompt.close();
      prompt = null;
      promptAnchor = null;
      handle = null;
      ed.canvas.title = '';
    },
  };
}
