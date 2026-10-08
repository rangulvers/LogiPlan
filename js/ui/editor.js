// Editor: turns pointer and keyboard input on the plant canvas into store commits and renderer.view updates
// (docs/ARCHITECTURE.md 6.3).
//
//   const editor = new Editor({ canvas, store, camera, renderer, ctx });
//   editor.tool                     the active tool name (store.ui.tool is kept in step both ways)
//   editor.setTool(name)            'select' | 'pan' | 'road' | 'oneway' | 'speedzone' | 'erase' | 'source' | 'process' |
//                                   'storage' | 'sink' | 'depot' | 'obstacle' | 'label' | 'flow'
//   editor.setToolOptions(patch)    store.ui.toolOptions: { factor } of the speed-zone tool, { kind } of the obstacle tool
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
// What the editor owns on `renderer.view`: hover, ghost, paintPreview, flowPreview, marquee and resizeHandles. It also
// mirrors selection, tool and overlays from the store into the view and keeps renderer.layout equal to the store's layout,
// so hit tests are never a frame behind a commit. Rendering is left to the app's runner loop; without a `ctx.runner` the
// editor draws a frame itself after every change (harnesses, tests).
//
// Every change to the layout is a single `store.commit` with a human-readable label ("Move station", "Draw road").
// The tools live in editor/: roads.js (road, one-way, speed zone, eraser), place.js (stations, obstacles), select.js,
// flow.js, label.js, pan.js; commands.js holds the keyboard commands; the pure logic in paths.js, snapping.js, resize.js,
// moves.js, marquee.js, erase.js, keys.js and tools.js is unit-tested in Node (tests/ui.editor.*.test.js).
//
// The tool modules talk to the editor through this host surface: layout(), ui(), view, store, camera, renderer, hit(p),
// commit(), setSelection(), toast(), status(), hoverStatus(), cursor(), redraw(), syncView(), setTool(), editText().
// A pointer `p` handed to a tool has: x, y (canvas CSS px), clientX/Y, wx, wy (world metres), ux, uy (fractional cells),
// cx, cy (cell under the pointer, possibly outside the grid), cell and path (grid-clamped cell / cells visited since the
// last event), shift, alt, type ('mouse' | 'pen' | 'touch').

import { roadAt, updateLabel } from '../model/layout.js';
import { clamp } from '../util/format.js';
import { TOOL_NAMES, isStrokeTool, toolCursor, toolHint, nextObstacleKind, nextSpeedFactor } from './editor/tools.js';
import { keyCommand, isTypingTarget, dialogOpen } from './editor/keys.js';
import { clampCell, dragThreshold } from './editor/snapping.js';
import { createPathTool } from './editor/roads.js';
import { createPlaceTool } from './editor/place.js';
import { createSelectTool } from './editor/select.js';
import { createFlowTool } from './editor/flow.js';
import { createLabelTool, openTextBox } from './editor/label.js';
import { createPanTool } from './editor/pan.js';
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
    this.renderQueued = false;
    this.textBox = null;
    this.tools = new Map();
    this.panTool = createPanTool(this);
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

  /** Replace the selection ({ kind: null } clears it). */
  setSelection(sel) {
    if (sel.kind) this.store.select(sel.kind, sel.ids);
    else this.store.clearSelection();
  }

  toast(message, opts) {
    if (this.ctx.toast) this.ctx.toast(message, opts);
  }

  status(text) {
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    if (this.ctx.setStatus) this.ctx.setStatus(text);
  }

  /** Status line while hovering: the cell under the pointer in cells and metres, then `extra` or the tool's hint. */
  hoverStatus(p, extra) {
    const { grid } = this.layout();
    const cs = grid.cellSize;
    const metres = (n) => Math.round(n * cs * 10) / 10;
    const inside = p.cx >= 0 && p.cy >= 0 && p.cx < grid.cols && p.cy < grid.rows;
    const where = inside ? `Cell ${p.cx}, ${p.cy} (${metres(p.cx)} m, ${metres(p.cy)} m)` : 'Outside the plant area';
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

  hint() {
    return toolHint(this.tool, { ...this.ui().toolOptions, pending: this.currentTool.busy() });
  }

  // ---- view state ----

  clearTransient() {
    const view = this.view;
    view.hover = null;
    view.ghost = null;
    view.paintPreview = null;
    view.flowPreview = null;
    view.marquee = null;
  }

  /** Mirror the store into renderer.view and renderer.layout. */
  syncView() {
    const { ui, layout } = this.store.getState();
    const view = this.view;
    if (this.renderer.layout !== layout) this.renderer.layout = layout;
    view.selection = ui.selection;
    view.tool = this.tool;
    view.overlays = ui.overlays;
    view.resizeHandles = this.tool === 'select' && !this.active && isResizableSelection(ui.selection);
  }

  updateCursor() {
    if (this.space || this.tool === 'pan') this.cursor(this.active && this.active.panning ? 'grabbing' : 'grab');
    else this.cursor(toolCursor(this.tool));
  }

  onStore(state, info) {
    if (this.destroyed) return;
    if (state.ui.tool !== this.tool && TOOL_NAMES.includes(state.ui.tool)) this.applyTool(state.ui.tool);
    if (REPLACING_EVENTS.has(info.type)) this.cancelGesture();
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
    return p;
  }

  locate(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const [wx, wy] = this.camera.screenToWorld(x, y);
    const { grid } = this.layout();
    const ux = wx / grid.cellSize;
    const uy = wy / grid.cellSize;
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

  remember(e) {
    this.lastPointer = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey, pointerType: e.pointerType };
  }

  /** The handler a new press goes to: panning for the middle button, Space or the pan tool, else the current tool. */
  handlerFor(e) {
    return e.button === 1 || this.space || this.tool === 'pan' ? this.panTool : this.currentTool;
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
    } else if (e.pointerType !== 'touch') this.hover(this.pointer(e));
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
    this.view.hover = null;
    this.cursor(this.space ? 'grab' : toolCursor(this.tool));
    if (this.space) this.hoverStatus(p, 'Drag to pan the view.');
    else if (this.currentTool.hover) this.currentTool.hover(p);
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
    this.syncView();
    this.updateCursor();
    this.status(this.hint());
    this.redraw();
  }

  /** Public: cancel the gesture in progress and clear every preview. */
  cancel() {
    this.closeTextBox();
    this.cancelGesture();
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

  /** Esc: cancel the gesture, else leave the tool, else clear the selection. */
  escape() {
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
    this.closeTextBox();
    this.clearTransient();
    this.view.resizeHandles = false;
    this.destroyed = true;
    for (const off of this.off.splice(0)) off();
    Object.assign(this.canvas.style, this.saved);
    if (this.ctx.setStatus) this.ctx.setStatus('');
  }
}
