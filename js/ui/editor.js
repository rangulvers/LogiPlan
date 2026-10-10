// Editor: turns pointer and keyboard input on the plant canvas into store commits and renderer.view updates
// (docs/ARCHITECTURE.md 6.3).
//
//   const editor = new Editor({ canvas, store, camera, renderer, ctx });
//   editor.tool                     the active tool name (store.ui.tool is kept in step both ways)
//   editor.setTool(name)            'select' | 'pan' | 'road' | 'oneway' | 'speedzone' | 'erase' | 'source' | 'process' |
//                                   'storage' | 'sink' | 'depot' | 'obstacle' | 'label' | 'flow'
//   editor.setToolOptions(patch)    store.ui.toolOptions: { factor } of the speed-zone tool, { kind } of the obstacle tool, { drawMode } of the
//                                   road, one-way, speed-zone and eraser tools ('smart' | 'straight' | 'free', editor/strokes.js)
//   editor.cancel()                 abandon the gesture in progress (nothing is committed) and clear all previews
//   editor.destroy()                remove every listener and leave no state behind
//
// Input. Pointer Events with pointer capture serve mouse, pen and touch. One finger (or the mouse) uses the current
// tool; two fingers pan and pinch-zoom and abandon whatever the first finger had begun. The wheel (and a trackpad
// pinch, which arrives as ctrl+wheel) zooms at the cursor; Space+drag, the middle button and the pan tool pan; a double
// click on empty ground fits the plant into view and a double click on a label edits its text.
// Keys are handled on `window` but ignored while a text field has focus or a dialog is open; browser shortcuts such as
// Ctrl+R are left alone (see editor/keys.js). The editor owns Ctrl/Cmd+Z, Shift+Z, Y (undo/redo), Ctrl+D, Ctrl+A, Delete,
// the arrows, Esc, the tool letters (V H R O Z E W T F, 1-5) and Space as a pan modifier (it calls preventDefault on those),
// so the app shell must not bind them again. A shell that wants Space = play/pause can act on the keyup of a Space press
// when `editor.spacePanned` is false.
//
// Connecting stations: a selected sender shows a flow handle (view.connectHandle); dragging it, or `editor.startConnect({ fromId })` /
// `({ toId })` followed by a click, adds a flow ('Connect A → B', one undo step). The state machine is editor/connector.js (editor.connector),
// the rules are editor/connect.js. Placing a station shows a toast with a 'Connect' action that calls startConnect.
//
// What the editor owns on `renderer.view`: hover, ghost, paintPreview, flowPreview, marquee, resizeHandles, connectHandle and connect. It also
// mirrors selection, tool and overlays from the store into the view and keeps renderer.layout equal to the store's layout,
// so hit tests are never a frame behind a commit. Rendering is left to the app's runner loop; without a `ctx.runner` the
// editor draws a frame itself after every change (harnesses, tests).
//
// Every change to the layout is a single `store.commit` with a human-readable label ("Move station", "Draw road").
// The tools live in editor/: roads.js (road, one-way, speed zone, eraser), place.js (stations, obstacles), select.js,
// flow.js, label.js, pan.js; commands.js holds the keyboard commands; the pure logic in paths.js, snapping.js, resize.js,
// moves.js, marquee.js, erase.js, keys.js, tools.js and strokes.js (the draw modes of the stroke tools) is unit-tested in Node (tests/ui.editor.*.test.js).
//
// The tool modules talk to the editor through this host surface: layout(), ui(), view, store, camera, renderer, hit(p),
// commit(), setSelection(), toast(), status(), hoverStatus(), cursor(), redraw(), syncView(), setTool(), editText(), clearTransient(),
// hint(), startConnect(), connector (the select, flow and place tools call into it).
// A pointer `p` handed to a tool has: x, y (canvas CSS px), clientX/Y, wx, wy (world metres), ux, uy (fractional cells),
// cx, cy (cell under the pointer, possibly outside the grid), cell and path (grid-clamped cell / cells visited since the
// last event), trail (the fractional-cell positions [ux, uy] since the last event, unclamped), shift, alt, type ('mouse' | 'pen' | 'touch').
//
// The plan grows with the work (editor/grow.js). A gesture that reaches beyond an edge of the baseplate (a road, a brick placed or
// dragged, a label) calls `showGrowth(extent)` while it runs: the editor works out how many blocks of 8 cells the plan would need, shows
// them as a translucent extension (view.extension) and adds a sentence to the status line. On release the tool calls
// `commitGrow(label, extent, (draft, shift) => ...)`: ONE store.commit that grows the plan (growGrid) and makes the edit, so one undo
// takes both back; `shift` = { dx, dy } is how far the content moved when the plan grew on the left or top (the edit is made in the
// coordinates of the plan before the growth and must add it). The camera moves by the same distance, so nothing moves on screen, also on
// undo and redo (the shift is noted with noteGrowth). Coordinates of the pointer outside the plan are real (negative or beyond cols / rows,
// kept within a window the plan could ever grow into): `p.ux`, `p.uy`, `p.cx`, `p.cy`. While the pointer rests near the edge of the canvas
// during a drag the view pans (autoPan), and in Select and the drawing tools the four edges show '+' chips that extend the plan by one block.

import { roadAt, updateLabel, growGrid } from '../model/layout.js';
import { clamp } from '../util/format.js';
import {
  planGrowth, describeGrowth, limitText, sidesOf, noteGrowth, contentShift, reachPoint, autoPanVelocity, blockOn, blockPlan, CHIP_TOOLS,
} from './editor/grow.js';
import { TOOL_NAMES, isStrokeTool, toolCursor, toolHint, nextObstacleKind, nextSpeedFactor } from './editor/tools.js';
import { keyCommand, isTypingTarget, isOperatedControl, isSelectionEdit, dialogOpen } from './editor/keys.js';
import { clampCell, dragThreshold } from './editor/snapping.js';
import { createPathTool } from './editor/roads.js';
import { createPlaceTool } from './editor/place.js';
import { createSelectTool } from './editor/select.js';
import { createFlowTool } from './editor/flow.js';
import { createLabelTool, openTextBox } from './editor/label.js';
import { createPanTool } from './editor/pan.js';
import { createConnector } from './editor/connector.js';
import { deleteSelection, nudgeSelection, duplicateSelection, selectAllStations } from './editor/commands.js';

const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 8;
const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 400;
const WHEEL_MAX_PX = 240;
const WHEEL_ZOOM_RATE = 0.0015;
const PINCH_WHEEL_ZOOM_RATE = 0.01;
/** Store events that replace the document under the pointer: a gesture in progress must not survive them. */
const REPLACING_EVENTS = new Set(['load', 'scenario', 'undo', 'redo']);

const isResizableSelection = (sel) => (sel.kind === 'station' || sel.kind === 'obstacle') && sel.ids.length === 1;
const isButtonLike = (el) => !!el && typeof el.closest === 'function' && el.closest('button, a, summary, [role="button"]') !== null;

/** The canvas editor: see the header for what it does and what it expects from the app. */
export class Editor {
  /**
   * @param {{ canvas: HTMLCanvasElement, store: object, camera: object, renderer: object, ctx?: object }} opts
   *   ctx: the shared app context (toast, setStatus, actions.fitView, runner); every member is optional
   */
  constructor({ canvas, store, camera, renderer, ctx = {} }) {
    this.canvas = canvas;
    this.store = store;
    this.camera = camera;
    this.renderer = renderer;
    this.ctx = ctx;
    this.doc = canvas.ownerDocument;
    this.win = this.doc.defaultView;
    this.destroyed = false;
    this.active = null; // the pointer gesture in progress: { handler, pointerId, p0, tool, panning }
    this.touches = new Map(); // pointerId -> { x, y } of every finger on the canvas
    this.pinch = null; // { x, y, dist } of the two-finger gesture in progress (client px)
    this.ignoreTouch = false; // after a pinch the remaining finger does nothing until all fingers are up
    this.space = false; // Space is held: a drag pans
    this.spacePanned = false; // the current or last Space hold was used to pan (a clean Space tap leaves it false)
    this.lastPointer = null; // last pointer event (for refreshing the hover after keys, undo, zoom)
    this.lastTap = null;
    this.lastStatus = null;
    this.statusText = ''; // what status() was last asked to show, without the growth sentence
    this.growNote = ''; // sentence about the growth the gesture in progress would cause, appended to the status line
    this.growPlan = null; // planGrowth() result for the gesture in progress (null: nothing to grow)
    this.seenLayout = store.getState().layout; // the layout the last store notification brought, to tell how far the content moved on undo
    this.pointerIn = false; // the mouse is over the canvas (the edge chips show)
    this.gestureShown = false; // the canvas carries data-gesture (a tool gesture is in progress)
    this.panFrame = 0; // requestAnimationFrame id of the auto-pan loop (0: not running)
    this.panLast = 0;
    this.renderQueued = false;
    this.textBox = null;
    this.tools = new Map();
    this.panTool = createPanTool(this);
    this.connector = createConnector(this); // flow handle, connect mode, valid-target highlighting (editor/connector.js)
    this.off = [];
    const initial = store.getState().ui.tool;
    this.tool = TOOL_NAMES.includes(initial) ? initial : 'select';
    this.saved = { touchAction: canvas.style.touchAction, userSelect: canvas.style.userSelect, cursor: canvas.style.cursor };
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e));
    this.listen(canvas, 'pointercancel', (e) => this.onPointerCancel(e));
    this.listen(canvas, 'lostpointercapture', (e) => this.onPointerCancel(e));
    this.listen(canvas, 'pointerleave', (e) => this.onPointerLeave(e));
    this.listen(canvas, 'mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll on the middle button
    this.listen(canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.listen(this.win, 'keydown', (e) => this.onKeyDown(e));
    this.listen(this.win, 'keyup', (e) => this.onKeyUp(e));
    this.listen(this.win, 'blur', () => this.onWindowBlur());
    this.off.push(store.subscribe((state, info) => this.onStore(state, info)));
    if (initial !== this.tool) store.setUi({ tool: this.tool });
    this.syncView();
    this.updateCursor();
    this.status(this.hint());
  }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.off.push(() => target.removeEventListener(type, fn, opts));
  }

  // ---- host surface used by the tool modules ----

  layout() {
    return this.store.getState().layout;
  }

  ui() {
    return this.store.getState().ui;
  }

  /** The renderer's view state (read fresh: the app may replace the object). */
  get view() {
    return this.renderer.view;
  }

  /** What is under the pointer (renderer.hitTest). */
  hit(p) {
    return this.renderer.hitTest(p.x, p.y);
  }

  /** store.commit, but a mutator that throws becomes an error toast instead of a broken gesture. */
  commit(label, mutate, opts) {
    try {
      return this.store.commit(label, mutate, opts);
    } catch (err) {
      console.error(err);
      this.toast('That change could not be applied.', { kind: 'error' });
      return false;
    }
  }

  /**
   * A gesture reaches `extent` (cells of the plan as it is now, possibly beyond its edges): work out how the plan would have to grow,
   * show it (view.extension, a sentence on the status line) and return the plan (see planGrowth). Pass null when the gesture no longer
   * reaches beyond the plan. Call it BEFORE status() in the same step, so the sentence is part of that status.
   */
  showGrowth(extent) {
    const plan = planGrowth(this.layout().grid, extent);
    const shown = plan.grows || !plan.ok ? plan : null;
    const note = shown ? describeGrowth(shown) : '';
    if (note !== this.growNote) {
      this.growNote = note;
      this.lastStatus = null; // the sentence is part of the status line: say it again
      this.status(this.statusText);
    }
    this.growPlan = shown;
    const view = this.view;
    const same = (a, b) => (!a && !b) || (a && b && ['left', 'top', 'right', 'bottom', 'ok', 'limited', 'hint'].every((k) => a[k] === b[k]));
    const next = shown ? { left: shown.left, top: shown.top, right: shown.right, bottom: shown.bottom, ok: shown.ok, limited: shown.limited, hint: false } : null;
    if (!same(view.extension, next)) view.extension = next;
    return plan;
  }

  /**
   * ONE undo step that makes an edit which may reach beyond the plan: grows the plan for `extent` (see showGrowth; null = no growth) and calls
   * `mutate(draft, shift)` on the grown draft, where `shift` = { dx, dy } is how far the content moved (0 unless the plan grew on the left or top).
   * Coordinates the tool took from the pointer are those of the plan before the growth; add `shift` to them (grow.js: shiftRect, shiftCells).
   * Returns false, with a toast, when the plan cannot grow far enough; false when the mutator refuses. The camera follows the content.
   */
  commitGrow(label, extent, mutate, opts) {
    const plan = extent ? planGrowth(this.layout().grid, extent) : null;
    if (plan && !plan.ok) {
      this.toast(limitText(), { kind: 'warn' });
      return false;
    }
    if (!plan || !plan.grows) return this.commit(label, (draft) => mutate(draft, { dx: 0, dy: 0 }), opts);
    return this.commit(label, (draft) => {
      const shift = growGrid(draft, sidesOf(plan));
      noteGrowth(draft, shift);
      return mutate(draft, shift);
    }, opts);
  }

  /** Extend the plan by one block on a side ('left' | 'top' | 'right' | 'bottom'): the click on an edge chip. One undo step, "Extend plan". */
  extendSide(side) {
    const before = this.layout().grid;
    const done = this.commit('Extend plan', (draft) => {
      const shift = growGrid(draft, blockOn(side));
      if (draft.grid.cols === before.cols && draft.grid.rows === before.rows) return false;
      noteGrowth(draft, shift);
      return undefined;
    });
    if (!done) this.toast(limitText(), { kind: 'warn' });
    return done;
  }

  /** Replace the selection ({ kind: null } clears it). */
  setSelection(sel) {
    if (sel.kind) this.store.select(sel.kind, sel.ids);
    else this.store.clearSelection();
  }

  /** Show a toast through the app. Returns the app's handle ({ close() }) or null when there is no toast function. */
  toast(message, opts) {
    return this.ctx.toast ? this.ctx.toast(message, opts) || null : null;
  }

  /**
   * Public: start connecting from a station. `{ fromId }` asks where its loads go (click the receiving station), `{ toId }` what
   * feeds it (click the sending station). Switches to Select; Esc cancels; the flow is one undo step. False when it cannot start.
   */
  startConnect(opts) {
    return this.connector.startConnect(opts);
  }

  status(text) {
    this.statusText = text;
    const shown = this.growNote ? (text ? `${text} · ${this.growNote}` : this.growNote) : text; // a gesture that makes the plan grow says so
    if (shown === this.lastStatus) return;
    this.lastStatus = shown;
    if (this.ctx.setStatus) this.ctx.setStatus(shown);
  }

  /** Status line while hovering: the cell under the pointer in cells and metres, then `extra` or the tool's hint. */
  hoverStatus(p, extra) {
    const { grid } = this.layout();
    const cs = grid.cellSize;
    const metres = (n) => Math.round(n * cs * 10) / 10;
    const inside = p.cx >= 0 && p.cy >= 0 && p.cx < grid.cols && p.cy < grid.rows;
    const roadTool = this.tool === 'road' || this.tool === 'oneway'; // a road may start or end beyond the edge: the plan grows to hold it
    const where = inside ? `Cell ${p.cx}, ${p.cy} (${metres(p.cx)} m, ${metres(p.cy)} m)` : roadTool ? 'Beyond the edge: a road drawn here extends the plan' : 'Outside the plant area';
    this.status(`${where} · ${extra || this.hint()}`);
  }

  cursor(css) {
    if (this.canvas.style.cursor !== css) this.canvas.style.cursor = css;
  }

  /** Ask for a new frame. The app's runner draws every frame itself; without one the editor does. */
  redraw() {
    if (this.ctx.runner || this.renderQueued || this.destroyed) return;
    this.renderQueued = true;
    this.win.requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.destroyed) this.renderer.render(1);
    });
  }

  /** Open the inline text box (one at a time) at a viewport position. */
  editText({ clientX, clientY, value = '', onSubmit }) {
    this.closeTextBox();
    this.textBox = openTextBox(this.doc, {
      x: clientX,
      y: clientY,
      value,
      onSubmit: (text) => { this.textBox = null; onSubmit(text); },
      onCancel: () => { this.textBox = null; },
    });
  }

  closeTextBox() {
    if (this.textBox) this.textBox.close();
    this.textBox = null;
  }

  // ---- tools ----

  get currentTool() {
    return this.toolObject(this.tool);
  }

  toolObject(name) {
    if (!this.tools.has(name)) this.tools.set(name, this.createTool(name));
    return this.tools.get(name);
  }

  createTool(name) {
    if (name === 'select') return createSelectTool(this);
    if (name === 'pan') return this.panTool;
    if (name === 'flow') return createFlowTool(this);
    if (name === 'label') return createLabelTool(this);
    return isStrokeTool(name) ? createPathTool(this, name) : createPlaceTool(this, name);
  }

  /** Switch tool and tell the store (buttons elsewhere call store.setUi({ tool }) and arrive in onStore). */
  setTool(name) {
    if (!TOOL_NAMES.includes(name)) return false;
    this.applyTool(name);
    this.store.setUi({ tool: name });
    return true;
  }

  /** Set options of the speed-zone ({ factor }) or obstacle ({ kind }) tool. */
  setToolOptions(patch) {
    this.store.setUi({ toolOptions: patch });
  }

  applyTool(name) {
    if (name === this.tool) return;
    this.cancelGesture();
    this.connector.cancel();
    this.closeTextBox();
    this.tool = name;
    this.clearTransient();
    this.syncView();
    this.updateCursor();
    this.refreshHover();
  }

  /** Pressing the key of the active tool again switches its option: the obstacle type, the speed-zone limit. */
  chooseTool(name) {
    if (name !== this.tool) return this.setTool(name);
    const options = this.ui().toolOptions;
    if (name === 'obstacle') this.setToolOptions({ kind: nextObstacleKind(options.kind) });
    else if (name === 'speedzone') this.setToolOptions({ factor: nextSpeedFactor(options.factor) });
    return true;
  }

  /** The tool that gets the pointer: connect mode (editor.startConnect) takes over from whatever tool is active. */
  get pointerTool() {
    return this.connector.handler || this.currentTool;
  }

  hint() {
    return this.connector.hint() || toolHint(this.tool, { ...this.ui().toolOptions, pending: this.currentTool.busy() });
  }

  // ---- view state ----

  clearTransient() {
    const view = this.view;
    view.hover = null;
    view.ghost = null;
    view.paintPreview = null;
    view.flowPreview = null;
    view.marquee = null;
    view.connect = null;
    view.extension = null;
    view.extendHover = null;
    this.growPlan = null;
    if (this.growNote) {
      this.growNote = '';
      this.status(this.statusText);
    }
  }

  /** Are the '+' chips on the edges of the baseplate offered now: Select or a drawing tool, nothing in progress, the pointer over the canvas (always on a touch screen)? */
  chipsOn() {
    if (!CHIP_TOOLS.includes(this.tool) || this.active || this.pinch || this.connector.mode || this.space) return false;
    if (this.pointerIn) return true;
    try {
      return this.win.matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  }

  /** Mirror the store into renderer.view and renderer.layout. */
  syncView() {
    const { ui, layout } = this.store.getState();
    const view = this.view;
    if (this.renderer.layout !== layout) this.renderer.layout = layout;
    view.selection = ui.selection;
    view.tool = this.tool;
    view.overlays = ui.overlays;
    view.resizeHandles = this.tool === 'select' && !this.active && !this.connector.mode && isResizableSelection(ui.selection);
    this.connector.sync();
    view.connectHandle = this.connector.handleView();
    view.extendChips = this.chipsOn();
    if (!view.extendChips) view.extendHover = null;
    const gesture = !!this.active && !this.active.panning;
    if (gesture !== this.gestureShown && typeof this.canvas.toggleAttribute === 'function') { // (the unit-test canvases are bare objects)
      this.gestureShown = gesture;
      this.canvas.toggleAttribute('data-gesture', gesture); // the card of an empty plan steps aside while a stroke is drawn (css/layout.css)
    }
  }

  updateCursor() {
    if (this.space || this.tool === 'pan') this.cursor(this.active && this.active.panning ? 'grabbing' : 'grab');
    else this.cursor(toolCursor(this.tool));
  }

  /**
   * The plan grew or shrank on its left or top (an edit that reached out, an edge chip, Plant settings, and the undo or redo of those):
   * everything moved in plan coordinates, so the view moves with it and nothing moves on screen.
   */
  keepViewStill(type, previous, current) {
    const shift = contentShift(type, previous, current);
    if (!shift) return;
    const cs = current.grid.cellSize;
    this.camera.translate(shift.dx * cs, shift.dy * cs);
  }

  onStore(state, info) {
    if (this.destroyed) return;
    const previous = this.seenLayout;
    this.seenLayout = state.layout;
    if (state.layout !== previous) this.keepViewStill(info.type, previous, state.layout);
    if (state.ui.tool !== this.tool && TOOL_NAMES.includes(state.ui.tool)) this.applyTool(state.ui.tool);
    if (REPLACING_EVENTS.has(info.type)) {
      this.cancelGesture();
      this.connector.cancel();
    }
    this.syncView();
    if (!this.active) this.refreshHover();
    this.redraw();
  }

  // ---- pointer input ----

  /** Pointer description handed to the tools (see the header). */
  pointer(e) {
    const p = this.locate(e.clientX, e.clientY);
    p.clientX = e.clientX;
    p.clientY = e.clientY;
    p.shift = !!e.shiftKey;
    p.alt = !!e.altKey;
    p.type = e.pointerType || 'mouse';
    p.path = this.pathOf(e, p);
    p.trail = this.trailOf(e, p);
    return p;
  }

  locate(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const [wx, wy] = this.camera.screenToWorld(x, y);
    const { grid } = this.layout();
    const [ux, uy] = reachPoint(wx / grid.cellSize, wy / grid.cellSize, grid); // beyond the plan, but never further than it could grow
    const cx = Math.floor(ux);
    const cy = Math.floor(uy);
    return { x, y, wx, wy, ux, uy, cx, cy, cell: clampCell(cx, cy, grid) };
  }

  /** The grid cells the pointer visited since the previous event (coalesced events give the true path of a fast stroke). */
  pathOf(e, p) {
    const cells = [];
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const s of samples) {
      const cell = this.locate(s.clientX, s.clientY).cell;
      const last = cells[cells.length - 1];
      if (!last || last[0] !== cell[0] || last[1] !== cell[1]) cells.push(cell);
    }
    const last = cells[cells.length - 1];
    if (!last || last[0] !== p.cell[0] || last[1] !== p.cell[1]) cells.push(p.cell);
    return cells;
  }

  /** The pointer positions since the previous event as [ux, uy] in fractional cells, unclamped: the coalesced samples, then the event itself (the stroke modes of editor/strokes.js read these). */
  trailOf(e, p) {
    const trail = [];
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const s of samples) {
      const at = this.locate(s.clientX, s.clientY);
      trail.push([at.ux, at.uy]);
    }
    const last = trail[trail.length - 1];
    if (!last || last[0] !== p.ux || last[1] !== p.uy) trail.push([p.ux, p.uy]);
    return trail;
  }

  remember(e) {
    this.lastPointer = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey, pointerType: e.pointerType };
  }

  /** The handler a new press goes to: panning for the middle button, Space or the pan tool, else the current tool. */
  handlerFor(e) {
    return e.button === 1 || this.space || this.tool === 'pan' ? this.panTool : this.pointerTool;
  }

  onPointerDown(e) {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2) {
        this.startPinch();
        return;
      }
      if (this.ignoreTouch) return;
    }
    if (this.active || this.pinch || (e.button !== 0 && e.button !== 1)) return;
    if (e.button === 0 && this.pressChip(e)) return;
    this.remember(e);
    const handler = this.handlerFor(e);
    const p = this.pointer(e);
    this.capture(e.pointerId);
    if (!handler.down(p)) {
      this.release(e.pointerId);
      return;
    }
    this.active = { handler, pointerId: e.pointerId, p0: p, tool: this.tool, panning: handler === this.panTool };
    if (this.space && this.active.panning) this.spacePanned = true;
    this.view.hover = null;
    this.syncView();
    this.updateCursor();
  }

  onPointerMove(e) {
    this.remember(e);
    if (e.pointerType === 'touch') {
      if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch) {
        this.movePinch();
        return;
      }
    }
    if (this.active) {
      if (e.pointerId === this.active.pointerId && this.active.handler.move) this.active.handler.move(this.pointer(e));
      this.kickAutoPan();
    } else if (e.pointerType !== 'touch') this.hover(this.pointer(e));
  }

  // ---- auto-pan: the view follows a drag that reaches the edge of the canvas ----

  /** The pan (px / s) the gesture in progress asks for because the pointer is near the edge of the canvas, or null. */
  autoPanVelocity() {
    const g = this.active;
    if (!g || g.panning || !this.lastPointer || !g.handler.autoPan || !g.handler.autoPan()) return null;
    const rect = this.canvas.getBoundingClientRect();
    const [vx, vy] = autoPanVelocity(this.lastPointer.clientX - rect.left, this.lastPointer.clientY - rect.top, rect.width, rect.height);
    return vx || vy ? [vx, vy] : null;
  }

  /** Start the auto-pan loop if the pointer of a growable drag is in the edge zone (it stops itself when the pointer leaves it). */
  kickAutoPan() {
    if (this.panFrame || this.destroyed || !this.autoPanVelocity()) return;
    this.panLast = 0;
    this.panFrame = this.win.requestAnimationFrame((t) => this.autoPanStep(t));
  }

  autoPanStep(now) {
    this.panFrame = 0;
    const v = this.autoPanVelocity();
    if (!v || this.destroyed) return;
    const dt = this.panLast ? Math.min(0.05, Math.max(0, (now - this.panLast) / 1000)) : 1 / 60;
    this.panLast = now;
    this.camera.pan(v[0] * dt, v[1] * dt);
    // the world moved under a pointer that rests: the gesture sees it at its new place
    if (this.active.handler.move) this.active.handler.move(this.pointer(this.lastPointer));
    this.redraw();
    this.panFrame = this.win.requestAnimationFrame((t) => this.autoPanStep(t));
  }

  // ---- the '+' chips on the edges of the baseplate ----

  /** A press on an edge chip extends the plan by one block and starts no gesture. */
  pressChip(e) {
    if (!this.view.extendChips) return false;
    const at = this.locate(e.clientX, e.clientY);
    const hit = this.renderer.hitTest(at.x, at.y);
    if (hit.kind !== 'extend') return false;
    this.extendSide(hit.id);
    return true;
  }

  /** Hovering: is the pointer on an edge chip? Shows the block it would add. Returns the side or null. */
  hoverChip(p) {
    const view = this.view;
    view.extendChips = this.chipsOn();
    let side = null;
    if (view.extendChips) {
      const hit = this.renderer.hitTest(p.x, p.y);
      if (hit.kind === 'extend') side = hit.id;
    }
    view.extendHover = side;
    if (!side) {
      if (view.extension && view.extension.hint) view.extension = null;
      return null;
    }
    const plan = blockPlan(this.layout().grid, side);
    view.hover = null;
    view.ghost = null;
    view.extension = { left: plan.left, top: plan.top, right: plan.right, bottom: plan.bottom, ok: plan.ok, limited: plan.limited, hint: true };
    this.cursor('pointer');
    const n = plan[side];
    this.status(plan.ok ? `Click to extend the plan ${side === 'top' ? 'upwards' : side === 'bottom' ? 'downwards' : `to the ${side}`} by ${n} ${side === 'left' || side === 'right' ? 'columns' : 'rows'} (then ${plan.cols} × ${plan.rows} cells).` : limitText());
    return side;
  }

  onPointerUp(e) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinch && this.touches.size < 2) this.pinch = null;
      if (this.touches.size === 0) this.ignoreTouch = false;
      if (this.ignoreTouch) return;
    }
    const gesture = this.active;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    this.remember(e);
    const p = this.pointer(e);
    try {
      gesture.handler.up(p);
    } finally {
      this.active = null;
      this.release(e.pointerId);
      this.showGrowth(null);
    }
    this.syncView();
    this.updateCursor();
    if (gesture.tool === 'select' && !gesture.panning) this.registerTap(gesture.p0, p, e.timeStamp);
    if (p.type === 'touch') this.leave();
    else this.refreshHover();
  }

  onPointerCancel(e) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinch && this.touches.size < 2) this.pinch = null;
      if (this.touches.size === 0) this.ignoreTouch = false;
    }
    if (this.active && e.pointerId === this.active.pointerId) this.cancelGesture();
  }

  onPointerLeave(e) {
    this.lastPointer = null;
    if (!this.active && e.pointerType !== 'touch') this.leave();
  }

  /** The pointer left the canvas without a gesture: drop the hover feedback. */
  leave() {
    const view = this.view;
    view.hover = null;
    view.ghost = null;
    view.paintPreview = null; // the Shift+click line preview of the road tools
    this.pointerIn = false;
    view.extendChips = this.chipsOn();
    view.extendHover = null;
    this.showGrowth(null); // a brick or label that hovered beyond the edge showed its block: the pointer is gone, so is the block
    this.connector.pointerLeft();
    this.status('');
    this.redraw();
  }

  capture(pointerId) {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      // synthetic or already finished pointers cannot be captured; the gesture still works while the pointer is over the canvas
    }
  }

  release(pointerId) {
    try {
      if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    } catch {
      // nothing captured
    }
  }

  hover(p) {
    this.pointerIn = true;
    this.view.hover = null;
    this.cursor(this.space ? 'grab' : toolCursor(this.tool));
    if (this.hoverChip(p)) {
      this.redraw();
      return;
    }
    const tool = this.pointerTool;
    if (this.space) this.hoverStatus(p, 'Drag to pan the view.');
    else if (tool.hover) tool.hover(p);
    this.redraw();
  }

  /** Re-run the hover feedback at the last known pointer position (after a key, undo, zoom or tool change). */
  refreshHover() {
    if (!this.lastPointer || this.active || this.destroyed || this.lastPointer.pointerType === 'touch') {
      if (!this.lastPointer) this.status(this.hint());
      return;
    }
    this.hover(this.pointer(this.lastPointer));
  }

  /** Abandon the gesture in progress (also a flow that waits for its second click). Nothing is committed. */
  cancelGesture() {
    const gesture = this.active;
    this.active = null;
    if (gesture) {
      this.release(gesture.pointerId);
      if (gesture.handler.cancel) gesture.handler.cancel();
    }
    if (this.currentTool.cancel) this.currentTool.cancel();
    this.showGrowth(null);
    this.syncView();
    this.updateCursor();
    this.status(this.hint());
    this.redraw();
  }

  /** Public: cancel the gesture in progress and clear every preview. */
  cancel() {
    this.closeTextBox();
    this.cancelGesture();
    this.connector.cancel();
    this.clearTransient();
  }

  // ---- clicks ----

  /** Remember a click (a press that hardly moved) of the select tool; the second one within 400 ms is a double click. */
  registerTap(p0, p, time) {
    if (Math.hypot(p.x - p0.x, p.y - p0.y) >= dragThreshold(p.type)) {
      this.lastTap = null;
      return;
    }
    const prev = this.lastTap;
    const quick = prev && time - prev.time <= DOUBLE_CLICK_MS && Math.hypot(p.x - prev.x, p.y - prev.y) <= DOUBLE_CLICK_PX;
    this.lastTap = quick ? null : { x: p.x, y: p.y, time };
    if (quick) this.onDoubleClick(p);
  }

  onDoubleClick(p) {
    const layout = this.layout();
    const hit = this.hit(p);
    if (hit.kind === 'label') {
      const label = layout.labels.find((l) => l.id === hit.id);
      if (label) this.editLabel(label, p);
    } else if (hit.kind === 'cell' && !roadAt(layout, hit.cell[0], hit.cell[1])) this.fitView();
  }

  editLabel(label, p) {
    this.editText({
      clientX: p.clientX,
      clientY: p.clientY,
      value: label.text,
      onSubmit: (text) => { this.commit('Edit label', (draft) => updateLabel(draft, label.id, { text })); },
    });
  }

  fitView() {
    const actions = this.ctx.actions;
    if (actions && actions.fitView) actions.fitView();
    else this.camera.fit(this.layout(), this.canvas.clientWidth, this.canvas.clientHeight);
    this.redraw();
  }

  // ---- zoom and two-finger pan ----

  onWheel(e) {
    e.preventDefault();
    const p = this.locate(e.clientX, e.clientY);
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    const delta = clamp(e.deltaY * unit, -WHEEL_MAX_PX, WHEEL_MAX_PX);
    const rate = e.ctrlKey ? PINCH_WHEEL_ZOOM_RATE : WHEEL_ZOOM_RATE;
    if (this.camera.zoomAt(Math.exp(-delta * rate), p.x, p.y)) {
      this.refreshHover();
      this.redraw();
    }
  }

  /** The first two fingers as a centre point and a distance (client px). */
  fingers() {
    const [a, b] = [...this.touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  startPinch() {
    this.cancelGesture();
    this.clearTransient();
    this.ignoreTouch = true;
    this.pinch = this.fingers();
  }

  movePinch() {
    const now = this.fingers();
    const before = this.pinch;
    this.camera.pan(now.x - before.x, now.y - before.y);
    if (before.dist > 0 && now.dist > 0) {
      const c = this.locate(now.x, now.y);
      this.camera.zoomAt(now.dist / before.dist, c.x, c.y);
    }
    this.pinch = now;
    this.redraw();
  }

  // ---- keyboard ----

  onKeyDown(e) {
    if (this.destroyed || e.defaultPrevented || isTypingTarget(e.target) || dialogOpen(this.doc)) return;
    if (e.key === ' ') {
      if (!this.space) {
        this.space = true;
        this.spacePanned = false;
        this.updateCursor();
      }
      if (!isButtonLike(e.target)) e.preventDefault();
      return;
    }
    if (e.key === 'Shift' || e.key === 'Alt') {
      this.setModifiers(e);
      return;
    }
    const command = keyCommand(e);
    if (isSelectionEdit(command) && isOperatedControl(e.target)) return; // Delete / arrows on a focused button belong to the button, not to the selected station
    if (command && this.run(command, e)) e.preventDefault();
  }

  onKeyUp(e) {
    if (e.key === ' ' && this.space) {
      this.space = false;
      this.updateCursor();
      this.refreshHover();
    } else if (e.key === 'Shift' || e.key === 'Alt') this.setModifiers(e);
  }

  /** Shift or Alt changed while the pointer rests: redraw the gesture preview (or hover) for the new modifier. */
  setModifiers(e) {
    if (!this.lastPointer) return;
    this.lastPointer.shiftKey = e.shiftKey;
    this.lastPointer.altKey = e.altKey;
    if (this.active && this.active.handler.modifiers) this.active.handler.modifiers(this.pointer(this.lastPointer));
    else this.refreshHover();
  }

  onWindowBlur() {
    this.space = false;
    this.cancelGesture();
  }

  /** Execute a key command. Returns true when the key was ours (the caller then stops the browser acting on it). */
  run(command, e) {
    switch (command.cmd) {
      case 'undo':
        if (!this.active) this.store.undo();
        return true;
      case 'redo':
        if (!this.active) this.store.redo();
        return true;
      case 'tool': return e.repeat ? true : this.chooseTool(command.tool);
      case 'escape': return this.escape();
      case 'delete': return !this.active && deleteSelection(this);
      case 'nudge': return !this.active && nudgeSelection(this, command.dx, command.dy);
      case 'duplicate': return !this.active && duplicateSelection(this);
      case 'selectAll': return !this.active && selectAllStations(this);
      default: return false;
    }
  }

  /** Esc: cancel connecting or the gesture, else leave the tool, else clear the selection. */
  escape() {
    if (this.connector.mode) {
      this.cancelGesture();
      this.connector.cancel();
      return true;
    }
    if (this.active || this.currentTool.busy()) {
      this.cancelGesture();
      return true;
    }
    if (this.tool !== 'select') return this.setTool('select');
    if (this.ui().selection.kind) {
      this.store.clearSelection();
      return true;
    }
    return false;
  }

  // ---- teardown ----

  destroy() {
    if (this.destroyed) return;
    this.cancelGesture();
    this.connector.destroy();
    this.closeTextBox();
    this.clearTransient();
    this.view.resizeHandles = false;
    this.view.connectHandle = null;
    this.view.extendChips = false;
    if (this.panFrame) this.win.cancelAnimationFrame(this.panFrame);
    this.panFrame = 0;
    this.destroyed = true;
    for (const off of this.off.splice(0)) off();
    Object.assign(this.canvas.style, this.saved);
    if (this.ctx.setStatus) this.ctx.setStatus('');
  }
}
