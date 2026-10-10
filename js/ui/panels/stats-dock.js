// The Statistics dock (docs/ENTITY-INSIGHTS-DESIGN.md 2, 7 and 9.1; SHELL part): the overlay over the bottom of the plan that opens when the
// planner clicks an item, with its header, window switch, states (compact, open, closed), the phone sheet and the rules for when it may open.
// What it shows inside (six numbers, three blocks, the sentences) is the MODEL builder's: js/ui/panels/stats-model.js and stats-view.js.
//
//   const dock = createStatsDock(ctx, { stage, editor, cameraControl, rectOf });   // dock.el, dock.open(), dock.close(), dock.toggle(), dock.destroy() ...
//
// THE DOCK IS AN OVERLAY, NOT A GRID ROW. It is `position: absolute` in the stage cell, so the canvas is never resized: the camera never
// re-fits and the world point under a held pointer never moves (design 2.1; a dock that resizes the stage made the first drag after a
// select-click jump a station by 4.7 cells). The floating controls of the stage move up by `--dock-covered` (set on the stage), the camera
// is told how much is covered (`coveredAtBottom`, js/ui/app.js createCameraControl).
//
// WHEN IT OPENS (design 2.1, S1.7). Never on `pointerdown`: pressing an unselected station selects it (select.js armMove), but the dock waits
// for the gesture to END and does not open at all when the gesture was a drag, a resize or a marquee. `watchClicks` below decides this on
// the bubble-phase `pointerup`, which runs AFTER the editor's own `pointerup` handler (the editor listens on the canvas, this listens on the
// stage around it), so the editor has finished the gesture (`ed.active` is null, the select tool is no longer busy). A capture listener
// would see the tool still busy and a design that waited for `!busy()` there would never open. Other ways to open: `I` (whatever the
// preference says), `[` and `]` (cycle the selection), the selection that `ctx.actions.focus()` makes for insights and checks, and the
// vehicle buttons of the Fleet tab (`ctx.actions.showStatistics()`). A selection made by anything else (a focused fleet card, a duplicated
// station) does not open the dock; it follows the selection once it is open. Preference `ui.statsDock`: 'data' (default: the runner has
// measured at least 30 s), 'always', 'never' applies to clicks and to focus(); below the threshold a click says "Press play to see
// statistics for AGVs 1" in the status line instead.
//
// STATES. closed (nothing selected, a wall or label selected, or dismissed with X until the next click-select), compact (header and the
// strip of six numbers, about 150 px; the default the first time), open (the blocks too; height up to 44 vh, the grip drags it). The state and
// height are remembered per viewer in localStorage['logiplan:stats-dock'] (every access in try/catch: the dock works without it). Below 900 px
// the same element is a bottom sheet with three snap points (peek: as high as its content, the design says 96 px; half 54 %, full 86 % of the stage; the grip taps to the next one
// and swipes). While a tool gesture runs on the plan the dock is dimmed to 50 % and takes no pointer. There is NO aria-live inside the
// dock (the live line changes every 100 ms at 600x); the one polite announcement of a changed selection goes to a visually hidden status
// element NEXT TO the dock.
//
// THE CONTRACT WITH THE MODEL BUILDER (agreed here because the design names the files, not their functions; the shell loads them lazily on
// the first open and shows a clearly marked PLACEHOLDER view while they are missing or broken):
//
//   js/ui/panels/stats-model.js   export function buildStatsModel(input) -> model | null            (pure; the only place with sentences)
//     input = { selection: { kind, ids }, layout, runner, sim, detail, report, insights, window: 'start' | 'last30', routes: boolean,
//               state: 'compact' | 'open' (peek | half | full on a phone), narrow: boolean }
//       sim = runner.sim (null before the first play); detail = runner.detail() (the collector or null); report = runner.kpis();
//       insights = runner.insights() (both null / [] without a simulation).
//     model = { signature: string,          changes only when the view's DOM has to be rebuilt (a different item or layout of tiles)
//               header?: { chip?: { icon?, label, tone? }, title?, crumb?: { text, title?, select?: { kind, ids } },
//                          live?: { tone?, strong, rest? } },                       what the shell draws in the header (it has defaults)
//               ariaLabel?: string, announce?: string,      region label and the one polite sentence on a changed selection
//               bounds?: { x, y, w, h },                     world rectangle (metres) to bring out from under the dock (the routes' box)
//               windows?: { last30: boolean, note?: string },   last30 false = this item has no 30-minute figure: the switch is disabled with `note`, and when the
//                                                               planner had chosen 'last30' the dock asks again with window 'start' (the choice is kept for the next item)
//               routes?: boolean (offer the "Routes on plan" switch, default true),
//               ...everything else belongs to the view }
//   js/ui/panels/stats-view.js    export function createStatsView(host) -> { el, update(model, { state, window }), destroy?(), escape?() }
//     el holds the strip (`.insight__strip`, six `.tile`) and the body (`.insight__body`, three `.insight__block`); css/stats.css ports the
//     class names of the mock-ups (insight.css, final.css). The body is hidden by CSS in the compact state, tiles 4 to 6 in the phone's peek.
//     escape() returns true when it used the Esc key (it unpinned a route); then the editor does not clear the selection.
//     The shell itself shows "Statistics stopped: <reason>" (with a Count again button) when the collector failed (sim.detailError): the view need not.
//     host = { window(), setWindow(kind), state(), select(kind, ids), showOnPlan(rect), focusRoute(id | null, { pinned }), announce(text) }
//
// WITH THE OVERLAY BUILDER (js/ui/render/routes.js): the shell keeps `renderer.view.stats = { open, window, focus }` current -- `open` is true
// in every state but closed (the routes are drawn in compact too), `window` is the shown window, `focus` the route the planner hovers or has
// pinned ({ id, pinned } or null). The "Routes on plan" switch is the overlay flag `routes` of the store (ui.overlays.routes).

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { plannerName } from '../editor/tools.js';
import { dragThreshold } from '../editor/snapping.js';
import { isTypingTarget, dialogOpen } from '../editor/keys.js';
import { vehicleName } from '../editor/select.js';
import { getStation, getFlow, getFleet } from '../../model/layout.js';

// ---------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------

export const DOCK_MEMORY_KEY = 'logiplan:stats-dock';
/** Selection kinds that have a dock. Walls ('obstacle') and text labels ('label') have none; selecting one closes the dock. */
export const DOCK_KINDS = Object.freeze(['station', 'flow', 'fleet', 'vehicle', 'cell']);
export const NO_DOCK_KINDS = Object.freeze(['obstacle', 'label']);
/** The simulation "has data" for the preference 'data' once it has measured this long (s, warm-up excluded). */
export const MIN_MEASURED_SECONDS = 30;
/** The length of the window "Last 30 min" (s): below this much measured time it is the same as "Since start". */
export const LAST30_SECONDS = 1800;
export const WINDOWS = Object.freeze(['start', 'last30']);
export const SNAPS = Object.freeze(['peek', 'half', 'full']);
/** Heights (px, or share of the stage on a phone) of the dock: the open state may not grow beyond 44 % of the viewport (css max-height 44vh). */
export const OPEN_MAX_SHARE = 0.44;
export const OPEN_MIN_PX = 200;
export const OPEN_DEFAULT_PX = 360; // only the fallback of the grip; an open dock starts at its cap (44 vh) so that as much of the body as possible is on the screen (openHeight)
/** Dragging the grip lower than the compact height plus this much (px) minimises to compact. */
export const COMPACT_SLACK_PX = 28;
export const SNAP_PEEK_PX = 136; // nominal height of the peek snap point for dragging and for the nearest snap (the design says 96); the sheet itself is as high as its content there (css)
export const SNAP_SHARES = Object.freeze({ half: 0.54, full: 0.86 });
/** A growing sheet brings the item out from under it only when it leaves at least this much (px) of the stage free. */
export const SNAP_FREE_MIN_PX = 120;
/** On a very short stage (a phone held sideways, 300 % zoom) half and full are never lower than this (css/stats.css has the same numbers), so that they are never lower than the peek. */
export const SNAP_MIN_PX = Object.freeze({ half: 260, full: 300 });
export const NO_STATS_TEXT = 'Walls and labels have no statistics.';
export const NARROW_QUERY = '(max-width: 899.98px)';

const TOAST_GAP_PX = 8; // between a toast and the top edge of the dock
const KEY_STEP_PX = 24;
const KEY_STEP_BIG_PX = 96;
const GRIP_TAP_PX = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const reported = new Set();
/** console.error once per message: a failure that repeats at 4 Hz must not flood the console. */
function reportOnce(scope, err) {
  const key = `${scope}: ${err && err.message ? err.message : err}`;
  if (reported.has(key)) return;
  reported.add(key);
  if (typeof console !== 'undefined') console.error(`[LogiPlan] ${scope}`, err);
}

// ---------------------------------------------------------------------------------------------------------
// Pure rules (tested in Node: tests/ui.stats-dock.test.js)
// ---------------------------------------------------------------------------------------------------------

/** The kind of the selection when it has a dock, else null. */
export function dockKind(selection) {
  return selection && DOCK_KINDS.includes(selection.kind) && selection.ids && selection.ids.length > 0 ? selection.kind : null;
}

/** A string that changes when the selection does (a cheap identity for "did the planner pick something else?"). */
export const selectionKey = (selection) => (selection && selection.kind ? `${selection.kind}:${selection.ids.join('|')}` : '');

/** Has the simulation measured long enough (and finished its warm-up) for the preference 'data'? `report` is runner.kpis(). */
export function hasStatisticsData(report) {
  const w = report && report.window;
  return Boolean(w) && w.warmingUp !== true && Number.isFinite(w.duration) && w.duration >= MIN_MEASURED_SECONDS;
}

/**
 * May this trigger open the dock? Clicks and the selection of `ctx.actions.focus()` obey the preference `ui.statsDock`; the key `I`, `[` and
 * `]` and the vehicle buttons of the Fleet tab are explicit requests and always open it. -> { open, reason? } (reason: 'never' | 'nodata').
 */
export function openDecision({ trigger, pref, report }) {
  if (trigger !== 'click' && trigger !== 'focus') return { open: true };
  if (pref === 'never') return { open: false, reason: 'never' };
  if (pref === 'data' && !hasStatisticsData(report)) return { open: false, reason: 'nodata' };
  return { open: true };
}

/** The planner's words for a selection: { title, kindLabel, icon, tone, crumb }. Used by the header (the model may overwrite any of it) and the status line. */
export function identityOf(selection, layout, sim = null) {
  const kind = selection ? selection.kind : null;
  const ids = selection && selection.ids ? selection.ids : [];
  const base = { title: '', kindLabel: '', icon: 'info', tone: null, crumb: null };
  if (!kind || ids.length === 0) return base;
  if (ids.length > 1) {
    const noun = { station: 'station', flow: 'flow', fleet: 'fleet', vehicle: 'vehicle', cell: 'road cell' }[kind] || 'item';
    return { ...base, title: plural(ids.length, noun), kindLabel: 'Several', icon: 'select' };
  }
  const id = ids[0];
  if (kind === 'station') {
    const st = getStation(layout, id);
    return st ? { ...base, title: st.name, kindLabel: plannerName(st.type), icon: st.type, tone: st.type } : { ...base, title: String(id), kindLabel: 'Station' };
  }
  if (kind === 'flow') {
    const f = getFlow(layout, id);
    const a = f && getStation(layout, f.from);
    const b = f && getStation(layout, f.to);
    return { ...base, title: a && b ? `${a.name} → ${b.name}` : String(id), kindLabel: 'Flow', icon: 'flow' };
  }
  if (kind === 'fleet') {
    const fl = getFleet(layout, id);
    return { ...base, title: fl ? fl.name : String(id), kindLabel: 'Fleet', icon: fl && fl.preset === 'forklift' ? 'forklift' : 'truck' };
  }
  if (kind === 'vehicle') {
    const at = String(id).lastIndexOf('#');
    const fl = at > 0 ? getFleet(layout, id.slice(0, at)) : null;
    return {
      ...base, title: vehicleName(layout, sim, id), kindLabel: 'Vehicle', icon: fl && fl.preset === 'forklift' ? 'forklift' : 'truck',
      crumb: fl ? { prefix: 'in', text: fl.name, title: `${plural(fl.count, 'vehicle')}: show the fleet`, select: { kind: 'fleet', ids: [fl.id] } } : null,
    };
  }
  const [cx, cy] = String(id).split(',');
  return { ...base, title: `Road cell ${cx}, ${cy}`, kindLabel: 'Road', icon: 'road' };
}

/** "Press play to see statistics for AGVs 1": what a click says while the simulation has measured nothing yet. */
export function pressPlayText(selection, layout, sim = null) {
  const n = selection && selection.ids ? selection.ids.length : 0;
  const what = n > 1 ? `these ${selection.kind === 'cell' ? 'road cells' : `${selection.kind}s`}` : identityOf(selection, layout, sim).title;
  return `Press play to see statistics for ${what}.`;
}

/** "a few seconds", "about 45 s", "about 3 min": a wait in real seconds, as roughly as it is known. */
export function roughly(seconds) {
  if (!(seconds >= 10)) return 'a few seconds';
  if (seconds < 90) return `about ${Math.max(10, Math.round(seconds / 5) * 5)} s`;
  return `about ${Math.max(2, Math.round(seconds / 60))} min`;
}

/** From this speed on a vehicle moves too far between the press and the release of a click to be hit (docs/ENTITY-INSIGHTS-DESIGN.md 2.4). */
export const FAST_CLICK_SPEED = 60;

/** What the status line adds when a click on a road cell lands while the plant plays fast: the vehicle that was aimed at has moved on. '' at lower speeds and while paused. */
export function fastClickText(run) {
  if (!run || run.playing !== true || !(run.speed >= FAST_CLICK_SPEED)) return '';
  return `At ${Math.round(run.speed)}x a vehicle moves too far between the press and the release to be clicked: pause (Space) first, or choose it in the Fleet tab.`;
}

/**
 * What a click says while there is nothing to show yet. Paused: "Press play to see statistics for AGVs 1." Playing, where "press play" would be the wrong
 * advice: the numbers start once the warm-up is over and `MIN_MEASURED_SECONDS` are measured, and the planner is told when ("Statistics for Assembly start
 * in about 1 min: the plant is warming up first."). `run` = { playing, speed } of the runner; `report` = runner.kpis(); the warm-up is `sim.settings.warmup`.
 */
export function waitText(selection, layout, sim, report, run) {
  const w = report && report.window;
  const speed = run && Number.isFinite(run.speed) && run.speed > 0 ? run.speed : 0;
  if (!run || run.playing !== true || !w || !speed) return pressPlayText(selection, layout, sim);
  const n = selection && selection.ids ? selection.ids.length : 0;
  const what = n > 1 ? `these ${selection.kind === 'cell' ? 'road cells' : `${selection.kind}s`}` : identityOf(selection, layout, sim).title;
  const warming = w.warmingUp === true;
  const warmup = sim && sim.settings && Number.isFinite(sim.settings.warmup) ? sim.settings.warmup : 0;
  const time = sim && Number.isFinite(sim.time) ? sim.time : 0;
  const simSeconds = warming ? Math.max(0, warmup - time) + MIN_MEASURED_SECONDS : Math.max(0, MIN_MEASURED_SECONDS - (Number.isFinite(w.duration) ? w.duration : 0));
  return `Statistics for ${what} start in ${roughly(simSeconds / speed)}${warming ? ': the plant is warming up first' : ''}.`;
}

/** What `ctx.actions.focus` / the dock should bring into view: refs for app.js focusRect(). */
export function refsOf(selection) {
  const ids = selection && selection.ids ? [...selection.ids] : [];
  switch (selection && selection.kind) {
    case 'station': return { stationIds: ids };
    case 'flow': return { flowIds: ids };
    case 'fleet': return { fleetIds: ids };
    case 'vehicle': return { vehicleIds: ids };
    case 'cell': return { cells: ids.map((key) => key.split(',').map(Number)) };
    default: return {};
  }
}

/**
 * The next item of the same kind after the first selected one (`direction` 1) or before it (-1), wrapping around: the keys `]` and `[`.
 * Stations, flows and fleets in the order of the plant; vehicles fleet by fleet; road cells by row then column. null when there is nothing to cycle.
 */
export function cycleSelection(layout, selection, direction) {
  const kind = selection && selection.kind;
  if (!kind || !DOCK_KINDS.includes(kind) || !selection.ids.length) return null;
  let list;
  if (kind === 'station') list = layout.stations.map((s) => s.id);
  else if (kind === 'flow') list = layout.flows.map((f) => f.id);
  else if (kind === 'fleet') list = layout.fleets.map((f) => f.id);
  else if (kind === 'vehicle') list = layout.fleets.flatMap((f) => Array.from({ length: f.count }, (_, i) => `${f.id}#${i + 1}`));
  else list = Object.keys(layout.roads).sort((a, b) => { const [ax, ay] = a.split(',').map(Number); const [bx, by] = b.split(',').map(Number); return ay - by || ax - bx; });
  if (!list.length) return null;
  const at = list.indexOf(selection.ids[0]);
  const next = list[(at < 0 ? (direction > 0 ? 0 : list.length - 1) : (at + (direction > 0 ? 1 : -1) + list.length) % list.length)];
  return { kind, ids: [next] };
}

/** The remembered dock state, from anything that was stored: { state: 'compact' | 'open', height: number | null, snap: 'peek' | 'half' | 'full' }. */
export function cleanDockMemory(raw) {
  const m = isObj(raw) ? raw : {};
  return {
    state: m.state === 'open' ? 'open' : 'compact',
    height: Number.isFinite(m.height) && m.height >= OPEN_MIN_PX && m.height <= 4000 ? Math.round(m.height) : null,
    snap: SNAPS.includes(m.snap) ? m.snap : 'peek',
  };
}

/** Read the remembered state; any problem (no storage, blocked, junk) gives the defaults. */
export function readDockMemory(storage) {
  try {
    const text = storage ? storage.getItem(DOCK_MEMORY_KEY) : null;
    return cleanDockMemory(typeof text === 'string' ? JSON.parse(text) : null);
  } catch {
    return cleanDockMemory(null);
  }
}

/** Remember the state; false (and no exception) when the storage is missing, full or blocked. */
export function writeDockMemory(storage, memory) {
  try {
    if (!storage) return false;
    storage.setItem(DOCK_MEMORY_KEY, JSON.stringify(cleanDockMemory(memory)));
    return true;
  } catch {
    return false;
  }
}

/**
 * The remembered state after the planner did something to the dock.
 *   { type: 'expand' | 'minimise' | 'toggle' }
 *   { type: 'resize', height, compact, max }   the grip: `height` is the wanted height in px, `compact` the height of the compact dock, `max` the largest height
 *   { type: 'snap', snap }                     the phone sheet
 */
export function nextDockMemory(memory, action) {
  switch (action.type) {
    case 'expand': return { ...memory, state: 'open' };
    case 'minimise': return { ...memory, state: 'compact' };
    case 'toggle': return { ...memory, state: memory.state === 'open' ? 'compact' : 'open' };
    case 'snap': return SNAPS.includes(action.snap) ? { ...memory, snap: action.snap } : memory;
    case 'resize': {
      if (!Number.isFinite(action.height)) return memory;
      if (action.height < (action.compact || 0) + COMPACT_SLACK_PX) return { ...memory, state: 'compact' };
      const max = Math.max(OPEN_MIN_PX, action.max || OPEN_DEFAULT_PX);
      return { ...memory, state: 'open', height: Math.round(clamp(action.height, OPEN_MIN_PX, max)) };
    }
    default: return memory;
  }
}

/** The height (px) of an open dock: the remembered one, else the largest there may be (the first time it shows as much as it may), never more than 44 % of the viewport. */
export function openHeight(memory, viewportHeight) {
  const max = Math.max(OPEN_MIN_PX, Math.floor(viewportHeight * OPEN_MAX_SHARE));
  return Math.min(max, memory.height || max);
}

/** The snap point after a tap on the grip of the phone sheet (peek -> half -> full -> peek) or a step with the arrow keys (`direction` 1 = up). */
export function nextSnap(snap, direction = 1, wrap = true) {
  const at = Math.max(0, SNAPS.indexOf(snap));
  const next = at + direction;
  if (next >= SNAPS.length) return wrap ? SNAPS[0] : SNAPS[SNAPS.length - 1];
  return SNAPS[Math.max(0, next)];
}

/** The pixel height of a snap point on a stage `stageHeight` px high. */
export const snapHeight = (snap, stageHeight) => (snap === 'peek' ? SNAP_PEEK_PX : Math.max(Math.round(stageHeight * SNAP_SHARES[snap]), Math.min(stageHeight, SNAP_MIN_PX[snap])));

/** The snap point nearest to a dragged height. */
export function nearestSnap(height, stageHeight) {
  return SNAPS.reduce((best, snap) => (Math.abs(snapHeight(snap, stageHeight) - height) < Math.abs(snapHeight(best, stageHeight) - height) ? snap : best), SNAPS[0]);
}

// ---------------------------------------------------------------------------------------------------------
// The click rule: watch the pointer gestures on the plan
// ---------------------------------------------------------------------------------------------------------

/**
 * Watch the pointer on the plan and report clean clicks. A press that never travelled beyond the drag threshold, with the select tool, left
 * button, no second finger and no pan (Space, middle button), is a click; it is reported by `onClick` AFTER the editor has handled the same
 * `pointerup` (see the header). `onDrag` fires when a gesture becomes a drag, `onEnd` when any gesture is over.
 * @param {{ canvas: EventTarget, upTarget?: EventTarget, editor: object, onClick: Function, onDrag?: Function, onEnd?: Function }} o
 *   upTarget: where `pointerup` is heard in the bubble phase (the stage around the canvas; default the canvas, which must then be listened to after the editor)
 * @returns {{ destroy(): void, gesture(): object | null }}
 */
export function watchClicks({ canvas, upTarget = canvas, editor, onClick, onDrag = () => {}, onEnd = () => {} }) {
  let g = null;
  const finish = () => {
    if (g === null) return;
    g = null;
    onEnd();
  };
  const down = (e) => {
    if (g !== null) {
      g.multi = true; // a second finger or button: a pinch or a pan, never a click
      return;
    }
    if (e.button !== 0 && e.button !== undefined) return;
    // `connecting`: the press ends a connection in connect mode (the click that picks the receiving station): that click makes a flow, it does not ask for statistics
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType || 'mouse', tool: editor.tool, moved: false, multi: false, panning: Boolean(editor.space), connecting: Boolean(editor.connector && editor.connector.mode) };
  };
  const move = (e) => {
    if (g === null || e.pointerId !== g.id || g.moved) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) >= dragThreshold(g.type)) {
      g.moved = true;
      onDrag();
    }
  };
  const downAfter = (e) => {
    if (g !== null && e.pointerId === g.id && !editor.active) finish(); // the editor took no gesture (an edge chip, a pan it refused): not a click on the plan
  };
  const up = (e) => {
    if (g === null || e.pointerId !== g.id) return;
    const done = g;
    const idle = !editor.active && !(editor.pointerTool && editor.pointerTool.busy && editor.pointerTool.busy()) && !(editor.connector && editor.connector.mode);
    finish();
    if (!done.moved && !done.multi && !done.panning && !done.connecting && done.tool === 'select' && idle) onClick({ pointerType: done.type });
  };
  const cancel = (e) => {
    if (g !== null && e.pointerId === g.id) finish();
  };
  canvas.addEventListener('pointerdown', down, { capture: true });
  canvas.addEventListener('pointermove', move, { capture: true });
  upTarget.addEventListener('pointerdown', downAfter);
  upTarget.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', cancel);
  return {
    gesture: () => g,
    destroy() {
      canvas.removeEventListener('pointerdown', down, { capture: true });
      canvas.removeEventListener('pointermove', move, { capture: true });
      upTarget.removeEventListener('pointerdown', downAfter);
      upTarget.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('lostpointercapture', cancel);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The placeholder view (stands in for the MODEL builder's stats-view.js while it is missing or broken)
// ---------------------------------------------------------------------------------------------------------

/**
 * PLACEHOLDER. Marked `data-placeholder`: it shows no statistics, only that the dock opens, follows the selection and changes state.
 * Replaced by the real view as soon as js/ui/panels/stats-model.js and stats-view.js load (see the contract in the header).
 */
function createPlaceholderView(host) {
  const tile = (n) => h('div', { class: 'tile' }, h('div', { class: 'tile__label' }, `Number ${n}`), h('div', { class: 'tile__value' }, '–'), h('div', { class: 'tile__ref' }, ' '));
  const strip = h('div', { class: 'insight__strip' }, [1, 2, 3, 4, 5, 6].map(tile));
  const line = h('p', { class: 'how', 'data-role': 'placeholder-text' });
  const block = (title, ...children) => h('div', { class: 'insight__block' }, h('h3', null, title), ...children);
  const body = h('div', { class: 'insight__body' },
    block('Where the time goes', line),
    block('Worth knowing', h('p', { class: 'how' }, 'Placeholder: the statistics view is not part of this build yet.')),
    block('Trips', h('p', { class: 'how' }, 'Placeholder.')));
  const el = h('div', { class: 'insight__placeholder', 'data-placeholder': '' }, strip, body);
  return {
    el,
    update(model) {
      const text = (model && model.placeholder) || `Placeholder for the statistics of the selected item. State: ${host.state()}, window: ${host.window() === 'start' ? 'since start' : 'last 30 min'}.`;
      if (line.textContent !== text) line.textContent = text;
    },
    destroy() {},
  };
}

/** Load the MODEL builder's two modules (lazily, on the first open). Rejects when they are missing or do not export what the contract says. */
async function defaultLoadContent() {
  const [model, view] = await Promise.all([import('./stats-model.js'), import('./stats-view.js')]);
  if (typeof model.buildStatsModel !== 'function' || typeof view.createStatsView !== 'function') {
    const err = new Error('stats-model.js must export buildStatsModel and stats-view.js createStatsView.');
    err.contract = true; // the files are there but do not match the contract: unlike a missing file (the browser logs that) this must be loud
    throw err;
  }
  return { buildStatsModel: model.buildStatsModel, createStatsView: view.createStatsView };
}

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };

// ---------------------------------------------------------------------------------------------------------
// The dock
// ---------------------------------------------------------------------------------------------------------

/**
 * Create the dock and put it into the stage. Nothing is loaded and nothing is drawn until the first open.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): store, runner, toast, setStatus, renderer (optional)
 * @param {object} options
 * @param {HTMLElement} options.stage the stage cell the dock overlays (position: relative)
 * @param {object} options.editor the Editor (tool, active, space, pointerTool, connector, canvas)
 * @param {{ revealMinimal(rect): boolean, showRect?(rect): void }} [options.cameraControl] app.js createCameraControl
 * @param {(selection: object) => (object | null)} [options.rectOf] the world rectangle {x, y, w, h} (metres) of a selection
 * @param {object} [options.storage] localStorage-like (default: the browser's, if usable)
 * @param {() => Promise<{ buildStatsModel: Function, createStatsView: Function }>} [options.loadContent] how to load the model and view (tests inject one)
 */
export function createStatsDock(ctx, options = {}) {
  const { store, runner } = ctx;
  const { stage, editor } = options;
  const doc = globalThis.document;
  const win = options.win || globalThis.window || globalThis;
  const raf = options.raf || ((fn) => globalThis.requestAnimationFrame(fn));
  const storage = Object.hasOwn(options, 'storage') ? options.storage : defaultStorage();
  const loadContent = options.loadContent || defaultLoadContent;
  const cameraControl = options.cameraControl || null;
  const rectOf = options.rectOf || (() => null);
  const matchMedia = options.matchMedia || (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia.bind(globalThis) : null);
  const narrowQuery = matchMedia ? matchMedia(NARROW_QUERY) : null;
  const offs = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    offs.push(() => target.removeEventListener(type, fn, opts));
  };

  let memory = readDockMemory(storage);
  let opened = false; // the planner (or a command) asked for the dock for the current selection and has not closed it
  let windowKind = 'start'; // the planner's choice; it is remembered while an item without a 30-minute figure is shown
  let shownWindow = 'start'; // the window the numbers are really about: windowKind, but 'start' while the model says there is no 'last30' for this item
  let destroyed = false;
  let refreshQueued = false;
  let content = null; // { buildStatsModel, createStatsView } once loaded
  let contentState = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
  let contentError = null;
  let view = null;
  let viewKey = '';
  let lastModel = null;
  let lastSel = store.getState().ui.selection;
  let lastSelKey = selectionKey(lastSel);
  let announcedKey = '';
  let headerKey = '';
  let coveredPx = 0;
  let closedByUndockable = false; // a wall or label was selected while the dock was open: it closed, and the status line says why
  let pinned = null; // the route the planner pinned or hovers: { id, pinned } | null (shared with the overlay through renderer.view.stats)
  let noteAsked = false; // the planner tapped "Last 30 min" where the item has none: the sentence says why, until the next item
  let snapSeen = null; // the snap point of the phone sheet at the last refresh: a sheet that grows brings the item out from under it

  const narrow = () => Boolean(narrowQuery && narrowQuery.matches);
  const viewportHeight = () => Number(win.innerHeight) || 900;
  const stageHeight = () => (stage && typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect().height : 0) || viewportHeight() * 0.7;
  const say = (text) => { if (typeof ctx.setStatus === 'function') ctx.setStatus(text); };
  const remember = (next) => {
    if (next === memory) return;
    memory = next;
    writeDockMemory(storage, memory);
  };

  // ---- the element ----

  const iconButton = (name, label, tip, onclick, className = '') => h('button', {
    class: `btn btn--icon btn--sm btn--ghost ${className}`.trim(), type: 'button', 'aria-label': label, 'data-tip': tip, 'data-tip-pos': 'top', onclick,
  }, icon(name, { size: 16 }));

  const grip = h('div', { class: 'insight__grip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize statistics', tabindex: '0' });
  const chip = h('span', { class: 'chip chip--outline' });
  const titleText = h('span', { class: 'truncate' });
  const crumb = h('span', { class: 'insight__crumb', hidden: true });
  const live = h('div', { class: 'insight__live', hidden: true });
  // The window that an item has no figure for stays focusable and answers a tap or Enter with a visible sentence (`aria-disabled`, not `disabled`: a disabled
  // button cannot be focused and says nothing on a touch screen); `windowNote` is that sentence, and the short explanation of "Last 30 min" before 30 minutes exist.
  const windowButtons = [['start', 'Since start'], ['last30', 'Last 30 min']].map(([kind, text]) => h('button', {
    class: 'segmented__item', type: 'button', 'aria-pressed': 'false', dataset: { window: kind }, onclick: () => setWindow(kind),
  }, text));
  const windowNote = h('div', { class: 'insight__note', 'data-role': 'window-note', id: 'stats-window-note', hidden: true });
  const routesInput = h('input', {
    class: 'switch__input', type: 'checkbox', checked: true, 'data-role': 'routes',
    onchange: () => store.setUi({ overlays: { routes: Boolean(routesInput.checked) } }),
  });
  const routesSwitch = h('label', { class: 'switch', title: 'Draw the usual trips of this item on the plan' }, routesInput, h('span', { class: 'switch__track' }), h('span', null, 'Routes on plan'));
  const detailsButton = iconButton('chevron-up', 'Show details', 'Details', () => apply({ type: 'expand' }), 'insight__details');
  detailsButton.setAttribute('aria-expanded', 'false');
  const minimiseButton = iconButton('chevron-down', 'Minimise statistics', 'Minimise', () => apply({ type: 'minimise' }), 'insight__minimise');
  const closeButton = iconButton('close', 'Close statistics', 'Close (Esc)', () => close(), 'insight__close');
  const head = h('div', { class: 'insight__head' }, // a div, not a header: the page has exactly one header landmark (tests/e2e/app.mjs)
    h('h2', { class: 'insight__title' }, chip, titleText, crumb), live, h('span', { class: 'spacer' }),
    h('div', { class: 'segmented segmented--sm', role: 'group', 'aria-label': 'Time window' }, windowButtons),
    routesSwitch, detailsButton, minimiseButton, closeButton);
  const contentHost = h('div', { class: 'insight__content' });
  // "Statistics stopped": the collector failed and the engine dropped it (sim.detailError); the simulation runs on (docs/ENTITY-INSIGHTS-DESIGN.md 6.6). Says so here, whatever the view shows.
  const stoppedText = h('span', { class: 'insight__notice-text' });
  const stoppedButton = h('button', {
    class: 'link', type: 'button', 'data-role': 'count-again',
    onclick: () => { store.setUi({ detail: false }); store.setUi({ detail: true }); }, // off and on: the runner starts a new collector, counting from now
  }, 'Count again');
  // the planner switched "Collect statistics for clicked items" off: the numbers are the report's and there are no routes on the plan; say so, with the way back
  const turnOnButton = h('button', { class: 'link', type: 'button', 'data-role': 'turn-on', hidden: true, onclick: () => store.setUi({ detail: true }) }, 'Turn on');
  const stopped = h('div', { class: 'insight__notice', 'data-role': 'stopped', hidden: true }, stoppedText, stoppedButton, turnOnButton);
  const el = h('section', {
    class: 'insight stats-dock', role: 'region', 'aria-label': 'Statistics', tabindex: '-1', hidden: true, dataset: { state: memory.state, snap: memory.snap },
  }, grip, head, windowNote, stopped, contentHost);
  // the one polite announcement of a changed selection: a visually hidden status NEXT TO the dock (the dock itself has no aria-live)
  const announcer = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', dataset: { role: 'stats-announce' } });
  if (stage) stage.append(el, announcer);

  // ---- what the view may ask of the shell ----

  const host = {
    window: () => shownWindow,
    setWindow: (kind) => setWindow(kind),
    state: () => (narrow() ? memory.snap : memory.state),
    select: (kind, ids) => store.select(kind, ids),
    showOnPlan: (rect) => { if (rect && cameraControl && cameraControl.showRect) cameraControl.showRect(rect); },
    focusRoute: (id, { pinned: isPinned = false } = {}) => {
      pinned = id === null || id === undefined ? null : { id, pinned: isPinned };
      publishViewState();
    },
    announce: (text) => announce(text),
  };

  // ---- the state of the view for the overlay (renderer.view.stats) ----

  let published = null;
  function publishViewState() {
    const view_ = ctx.renderer && ctx.renderer.view;
    if (!view_) return;
    const visible = !el.hidden;
    const next = { open: visible, window: shownWindow, focus: pinned };
    if (published && published.open === next.open && published.window === next.window && published.focus === next.focus) return;
    published = next;
    view_.stats = next;
  }

  // ---- covering ----

  function covered() {
    if (el.hidden || !stage || typeof stage.getBoundingClientRect !== 'function' || typeof el.getBoundingClientRect !== 'function') return 0;
    return Math.max(0, Math.round(stage.getBoundingClientRect().bottom - el.getBoundingClientRect().top));
  }

  function syncCovered() {
    syncLift();
    const px = covered();
    if (px === coveredPx) return;
    coveredPx = px;
    if (stage) stage.style.setProperty('--dock-covered', `${px}px`);
  }

  /**
   * How far above the bottom of the window the dock's top edge is (plus a gap), on the page's root as `--dock-lift`: the toasts, which are not inside the stage, stand
   * above the dock instead of over its numbers (css/stats.css). 0 while the dock is closed.
   */
  let liftPx = -1;
  function syncLift() {
    const root = doc && doc.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
    const px = !el.hidden && typeof el.getBoundingClientRect === 'function' ? Math.max(0, Math.round(viewportHeight() - el.getBoundingClientRect().top)) + TOAST_GAP_PX : 0;
    if (px === liftPx) return;
    liftPx = px;
    root.style.setProperty('--dock-lift', `${px}px`);
  }

  // ---- announcements ----

  function announce(text) {
    if (!text) return;
    announcer.textContent = '';
    raf(() => { announcer.textContent = text; });
  }

  // ---- loading the model and the view ----

  function ensureContent() {
    if (contentState !== 'idle') return;
    contentState = 'loading';
    Promise.resolve().then(loadContent).then((loaded) => {
      content = loaded;
      contentState = 'ready';
      schedule();
    }, (err) => {
      contentState = 'failed';
      contentError = err;
      if (err && err.contract) reportOnce('the statistics view does not match what the dock expects', err);
      schedule();
    });
  }

  function destroyView() {
    if (view && typeof view.destroy === 'function') {
      try { view.destroy(); } catch (err) { reportOnce('closing the statistics view', err); }
    }
    view = null;
    viewKey = '';
  }

  function buildModel(input) {
    if (!content) return null;
    try {
      return content.buildStatsModel(input) || null;
    } catch (err) {
      reportOnce('building the statistics', err);
      return null;
    }
  }

  // ---- the refresh: bring everything up to date with the store and the runner ----

  function hide() {
    if (!el.hidden) {
      const hadFocus = doc && el.contains && el.contains(doc.activeElement);
      el.hidden = true;
      if (hadFocus && editor && editor.canvas && typeof editor.canvas.focus === 'function') editor.canvas.focus({ preventScroll: true });
    }
    pinned = null;
    snapSeen = null;
    moreSeen = null;
    el.removeAttribute('data-more');
    syncCovered();
    if (stage && stage.hasAttribute('data-dock')) stage.removeAttribute('data-dock'); // (a closed dock refreshes at every runner event: no DOM write when nothing changes)
    publishViewState();
  }

  function paintHeader(ident, model) {
    const header = (model && model.header) || {};
    const chipInfo = header.chip || { icon: ident.icon, label: ident.kindLabel, tone: ident.tone };
    const crumbInfo = header.crumb !== undefined ? header.crumb : ident.crumb;
    const title = header.title || ident.title;
    const liveInfo = header.live || null;
    const key = JSON.stringify([chipInfo, crumbInfo && [crumbInfo.prefix, crumbInfo.text, crumbInfo.title], title, liveInfo]);
    if (key === headerKey) return;
    headerKey = key;
    chip.className = `chip chip--outline${chipInfo.tone ? ` chip--${chipInfo.tone}` : ''}`;
    chip.replaceChildren(...(chipInfo.icon ? [icon(chipInfo.icon, { size: 14 })] : []), chipInfo.label || '');
    setText(titleText, title);
    if (crumbInfo) {
      crumb.hidden = false;
      const button = h('button', { class: 'link', type: 'button', title: crumbInfo.title || '', onclick: () => { if (crumbInfo.select) store.select(crumbInfo.select.kind, crumbInfo.select.ids); } }, crumbInfo.text);
      crumb.replaceChildren(`${crumbInfo.prefix || 'in'} `, crumbInfo.select ? button : crumbInfo.text);
    } else {
      crumb.hidden = true;
      crumb.replaceChildren();
    }
    if (liveInfo) {
      live.hidden = false;
      live.replaceChildren(...(liveInfo.tone ? [h('span', { class: `dot tone-${liveInfo.tone}`, 'aria-hidden': 'true' })] : []), h('span', null, h('strong', null, liveInfo.strong || ''), liveInfo.rest ? ` ${liveInfo.rest}` : '')); // one line, so that it ends in one ellipsis
    } else {
      live.hidden = true;
      live.replaceChildren();
    }
  }

  /** Has this model no figure for the 30-minute window? */
  const noLast30 = (model) => Boolean(model && model.windows && model.windows.last30 === false);
  const NO_LAST30_TEXT = 'There is no 30-minute figure for this item.';

  function paintControls(model, overlays) {
    for (const button of windowButtons) {
      const kind = button.dataset.window;
      button.setAttribute('aria-pressed', String(kind === shownWindow));
      const unavailable = kind === 'last30' && noLast30(model);
      if (unavailable) {
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute('aria-describedby', windowNote.id);
      } else {
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-describedby');
      }
      button.title = unavailable ? (model.windows.note || NO_LAST30_TEXT) : '';
    }
    const offered = !(model && model.routes === false);
    routesSwitch.hidden = !offered;
    if (routesInput.checked !== (overlays.routes !== false)) routesInput.checked = overlays.routes !== false;
    const isNarrow = narrow();
    detailsButton.setAttribute('aria-expanded', String(memory.state === 'open'));
    detailsButton.hidden = isNarrow || memory.state === 'open';
    minimiseButton.hidden = isNarrow || memory.state !== 'open';
  }

  const SNAP_WORDS = { peek: 'Peek', half: 'Half height', full: 'Full height' };

  /**
   * The notice above the numbers. Two cases, both said in plain words: the planner switched "Collect statistics for clicked items" off (the numbers are the report's,
   * there are no routes on the plan: "Turn on" is the way back), and "Statistics stopped: ..." while the planner wants statistics (ui.detail), the simulation
   * exists and its collector is gone with a reason (the simulation is not affected: "Count again").
   */
  function paintStopped(sim, wanted) {
    if (!wanted) {
      stopped.hidden = false;
      stopped.dataset.mode = 'off';
      stoppedButton.hidden = true;
      turnOnButton.hidden = false;
      setText(stoppedText, 'Statistics for single items are switched off: there are no routes on the plan, and the numbers come from the report only.');
      return;
    }
    stopped.dataset.mode = 'failed';
    turnOnButton.hidden = true;
    stoppedButton.hidden = false;
    const err = sim && !sim.detail ? sim.detailError : null;
    stopped.hidden = !err;
    if (!err) return;
    const reason = String((err && err.message) || err || 'an internal error').replace(/\s+/g, ' ').slice(0, 160);
    setText(stoppedText, `Statistics stopped: ${reason}. The simulation is not affected.`);
  }

  /**
   * One visible sentence about the window, only when there is something to explain: "Last 30 min" shown before 30 minutes have been measured (it is the same as
   * Since start), and the reason an item has no 30-minute figure once the planner has asked for it (a tap or Enter on the dimmed button).
   * @returns {string} the sentence ('' when there is none)
   */
  function windowNoteText(model, report) {
    if (noLast30(model)) return noteAsked ? (model.windows.note || NO_LAST30_TEXT) : '';
    const measured = report && report.window && report.window.warmingUp !== true && Number.isFinite(report.window.duration) ? report.window.duration : null;
    if (shownWindow === 'last30' && measured !== null && measured < LAST30_SECONDS - 1) {
      const min = measured / 60;
      return `Under 30 minutes have been measured (${min < 10 ? min.toFixed(1) : Math.round(min)} min), so Last 30 min is the same as Since start.`;
    }
    return '';
  }

  function paintWindowNote(model, report) {
    const text = windowNoteText(model, report);
    windowNote.hidden = text === '';
    // the description of the dimmed button is there for a screen reader whether or not it is on the screen
    if (text !== '') setText(windowNote, text);
    else if (noLast30(model)) setText(windowNote, model.windows.note || NO_LAST30_TEXT);
    else setText(windowNote, '');
  }

  function paintSize() {
    el.dataset.state = memory.state;
    el.dataset.snap = memory.snap;
    if (!narrow()) el.style.setProperty('--dock-h', `${openHeight(memory, viewportHeight())}px`);
    if (stage) stage.dataset.dock = narrow() ? memory.snap : memory.state;
    // a focusable separator is a widget: it says where it stands (ARIA window splitter): the snap point of the phone sheet, else 0 (compact) to 100 (44 vh)
    let now;
    let text;
    let max = 100;
    if (narrow()) {
      max = SNAPS.length - 1;
      now = SNAPS.indexOf(memory.snap);
      text = SNAP_WORDS[memory.snap];
    } else if (memory.state === 'open') {
      const height = openHeight(memory, viewportHeight());
      const top = Math.max(OPEN_MIN_PX, Math.floor(viewportHeight() * OPEN_MAX_SHARE));
      now = Math.round((100 * (height - OPEN_MIN_PX)) / Math.max(1, top - OPEN_MIN_PX));
      text = `Open, ${height} px high`;
    } else {
      now = 0;
      text = 'Compact';
    }
    setAttr(grip, 'aria-valuemin', '0');
    setAttr(grip, 'aria-valuemax', String(max));
    setAttr(grip, 'aria-valuenow', String(clamp(now, 0, max)));
    setAttr(grip, 'aria-valuetext', text);
  }

  function refresh() {
    refreshQueued = false;
    if (destroyed) return;
    const state = store.getState();
    const selection = state.ui.selection;
    const kind = dockKind(selection);
    if (!opened || kind === null) {
      hide();
      return;
    }
    // a keyboard planner's focus inside the dock (a trip row, the link to the fleet): a rebuild of the view or the header throws the focused element away, and the
    // focus would fall to the page; it stays in the dock (on the region) instead
    const focusInside = Boolean(doc && typeof el.contains === 'function' && doc.activeElement && doc.activeElement !== el && el.contains(doc.activeElement));
    el.hidden = false;
    ensureContent();
    const sim = runner ? runner.sim : null;
    const input = {
      selection, layout: state.layout, runner, sim, detail: sim && typeof runner.detail === 'function' ? runner.detail() : null,
      report: sim && typeof runner.kpis === 'function' ? runner.kpis() : null, insights: sim && typeof runner.insights === 'function' ? runner.insights() : [],
      window: windowKind, routes: state.ui.overlays.routes !== false, state: narrow() ? memory.snap : memory.state, narrow: narrow(),
    };
    let model = buildModel(input);
    shownWindow = windowKind;
    if (windowKind === 'last30' && model && model.windows && model.windows.last30 === false) { // "since start only" (a dock cell, a road): ask again for the window that is shown, never a 30-minute label over since-start numbers
      shownWindow = 'start';
      model = buildModel({ ...input, window: 'start' }) || model;
    }
    lastModel = model;
    const ident = identityOf(selection, state.layout, sim);
    paintHeader(ident, model);
    paintControls(model, state.ui.overlays);
    paintWindowNote(model, input.report);
    paintStopped(sim, state.ui.detail !== false);
    paintSize();
    setAttr(el, 'aria-label', (model && model.ariaLabel) || `Statistics for ${(model && model.header && model.header.title) || ident.title}`);
    el.dataset.kind = kind;
    const key = model ? `real:${model.signature ?? selectionKey(selection)}` : 'placeholder';
    if (key !== viewKey) {
      destroyView();
      try {
        view = model ? content.createStatsView(host) : createPlaceholderView(host);
      } catch (err) {
        reportOnce('building the statistics view', err);
        view = createPlaceholderView(host);
      }
      viewKey = key;
      contentHost.replaceChildren(view.el);
    }
    try {
      view.update(model, { state: narrow() ? memory.snap : memory.state, window: shownWindow });
    } catch (err) {
      reportOnce('updating the statistics', err);
    }
    const selKey = selectionKey(selection);
    if (selKey !== announcedKey && (contentState === 'ready' || contentState === 'failed')) { // wait for the model's sentence; the refresh after loading says it
      announcedKey = selKey;
      announce((model && model.announce) || `${ident.title} selected. Statistics are open.`);
    }
    if (focusInside && doc.activeElement !== el && !el.contains(doc.activeElement) && typeof el.focus === 'function') el.focus({ preventScroll: true });
    syncCovered();
    publishViewState();
    syncMore();
    followSnap();
  }

  /**
   * Is there more of the body below what is on the screen? `data-more` on the dock makes css/stats.css fade the bottom edge of the body, so that the open dock, which is
   * lower than its content on most screens (44 vh at most), says that it scrolls. Read again at every refresh, resize and scroll.
   */
  let moreSeen = null;
  function syncMore() {
    const body = !el.hidden && typeof el.querySelector === 'function' ? el.querySelector('.insight__body') : null;
    const more = Boolean(body) && body.scrollHeight - body.scrollTop - body.clientHeight > 2;
    if (more === moreSeen) return;
    moreSeen = more;
    if (more) el.setAttribute('data-more', 'true');
    else el.removeAttribute('data-more');
  }

  /**
   * The sheet of a phone that grows (peek -> half -> full) covers more of the plan: the item (the vehicle that was clicked, the point of the whole thing) is brought out
   * from under it by the smallest pan, once per change of the snap point, never a zoom and never while a gesture runs. Where the sheet leaves hardly any plan (full),
   * nothing is shoved about for it.
   */
  function followSnap() {
    const snap = narrow() && !el.hidden ? memory.snap : null;
    const grew = snap !== null && snapSeen !== null && SNAPS.indexOf(snap) > SNAPS.indexOf(snapSeen);
    snapSeen = snap;
    if (!grew || stageHeight() - covered() < SNAP_FREE_MIN_PX) return;
    revealSelection();
  }

  function schedule() {
    if (refreshQueued || destroyed) return;
    refreshQueued = true;
    raf(() => { if (refreshQueued) refresh(); });
  }

  // ---- opening, closing, resizing ----

  function revealSelection() {
    if (!cameraControl || typeof cameraControl.revealMinimal !== 'function') return false;
    if (editor && (editor.active || (editor.pointerTool && editor.pointerTool.busy && editor.pointerTool.busy()))) return false; // never while a gesture runs
    const rect = (lastModel && lastModel.bounds) || rectOf(store.getState().ui.selection);
    return rect ? cameraControl.revealMinimal(rect) : false;
  }

  /**
   * Open the dock for the current selection. `reveal`: bring the item out from under it by the smallest pan (never a zoom): `true` when the dock was closed (a click
   * on an item that is on screen), `'always'` also when it was open already (the keys [ and ] and the Fleet tab choose an item that may be anywhere), `false` never.
   * `focus`: put the keyboard focus on the dock (the Fleet tab does after Enter, so that Tab leads into the dock). False when nothing with statistics is selected.
   */
  function open({ reveal = true, focus = false } = {}) {
    const selection = store.getState().ui.selection;
    if (dockKind(selection) === null) {
      say(NO_DOCK_KINDS.includes(selection.kind) ? NO_STATS_TEXT : 'Select an item first, then press I for its statistics.');
      return false;
    }
    const wasVisible = !el.hidden;
    opened = true;
    announcedKey = wasVisible ? announcedKey : '';
    refresh();
    if (reveal === 'always' || (reveal && !wasVisible)) revealSelection();
    if (focus && typeof el.focus === 'function') el.focus({ preventScroll: true });
    return true;
  }

  function close() {
    if (!opened && el.hidden) return false;
    opened = false;
    refresh();
    return true;
  }

  function toggle() {
    return !el.hidden ? close() : open();
  }

  function apply(action) {
    remember(nextDockMemory(memory, action));
    refresh();
  }

  function setWindow(kind) {
    if (!WINDOWS.includes(kind)) return;
    if (kind === 'last30' && noLast30(lastModel)) { // the dimmed button answers a tap or Enter with its reason; the planner's choice is not changed
      noteAsked = true;
      refresh();
      return;
    }
    if (kind === windowKind) return;
    windowKind = kind;
    refresh();
  }

  // ---- the grip: resize on desktop, snap points on the phone ----

  let dragging = null;
  /** The height the dock has without its body (the compact height): measured, else a safe default. */
  const compactHeight = () => {
    if (typeof el.getBoundingClientRect !== 'function') return 150;
    const body = memory.state === 'open' ? el.querySelector('.insight__body') : null;
    const bodyHeight = body && typeof body.getBoundingClientRect === 'function' ? body.getBoundingClientRect().height : 0;
    return Math.max(120, Math.round(el.getBoundingClientRect().height - bodyHeight)) || 150;
  };

  /** Start a drag of the dock from `target` (the grip, or on a phone the title row, where a thumb lands first); `tap`: a press without a move taps to the next snap point. */
  const startDrag = (e, target, tap) => {
    dragging = { id: e.pointerId, y: e.clientY, height: typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().height : 0, moved: false, compact: compactHeight(), narrow: narrow(), target, tap };
    try { target.setPointerCapture(e.pointerId); } catch { /* synthetic pointers cannot be captured */ }
  };
  listen(grip, 'pointerdown', (e) => {
    if (e.button !== 0 && e.button !== undefined) return;
    startDrag(e, grip, true);
    e.preventDefault();
  });
  // the sheet of a phone also swipes from its title row (not from the buttons in it): the 40 px grip is not the only handle
  listen(head, 'pointerdown', (e) => {
    if (!narrow() || (e.button !== 0 && e.button !== undefined) || dragging) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('button, a, input, label, select, [role="separator"]')) return;
    startDrag(e, head, false);
  });
  const onMove = (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const dy = dragging.y - e.clientY;
    if (!dragging.moved && Math.abs(dy) < GRIP_TAP_PX) return;
    dragging.moved = true;
    el.classList.add('is-resizing');
    const wanted = dragging.height + dy;
    if (dragging.narrow) {
      el.style.height = `${Math.round(clamp(wanted, SNAP_PEEK_PX, snapHeight('full', stageHeight())))}px`;
    } else {
      const max = Math.floor(viewportHeight() * OPEN_MAX_SHARE);
      if (wanted < dragging.compact + COMPACT_SLACK_PX) {
        if (memory.state !== 'compact') { el.style.height = ''; memory = nextDockMemory(memory, { type: 'minimise' }); paintSize(); }
      } else {
        const h_ = Math.round(clamp(wanted, OPEN_MIN_PX, max));
        memory = nextDockMemory(memory, { type: 'resize', height: h_, compact: dragging.compact, max });
        paintSize();
        el.style.setProperty('--dock-h', `${h_}px`);
      }
    }
    syncCovered();
  };
  listen(grip, 'pointermove', onMove);
  listen(head, 'pointermove', onMove);
  const endDrag = (e) => {
    if (!dragging || (e && e.pointerId !== dragging.id)) return;
    const d = dragging;
    dragging = null;
    el.classList.remove('is-resizing');
    try { d.target.releasePointerCapture(e.pointerId); } catch { /* nothing captured */ }
    if (d.narrow) {
      if (d.moved) {
        const snap = nearestSnap(parseFloat(el.style.height) || d.height, stageHeight());
        el.style.height = '';
        remember(nextDockMemory(memory, { type: 'snap', snap }));
      } else if (d.tap) remember(nextDockMemory(memory, { type: 'snap', snap: nextSnap(memory.snap, 1) })); // a tap on the grip: the next snap point
    } else if (d.moved) writeDockMemory(storage, memory);
    refresh();
  };
  listen(grip, 'pointerup', endDrag);
  listen(grip, 'pointercancel', endDrag);
  listen(head, 'pointerup', endDrag);
  listen(head, 'pointercancel', endDrag);
  listen(grip, 'dblclick', () => { if (!narrow()) apply({ type: 'toggle' }); });
  listen(grip, 'keydown', (e) => {
    const step = e.shiftKey ? KEY_STEP_BIG_PX : KEY_STEP_PX;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const up = e.key === 'ArrowUp';
      if (narrow()) remember(nextDockMemory(memory, { type: 'snap', snap: nextSnap(memory.snap, up ? 1 : -1, false) }));
      else if (memory.state === 'compact') {
        if (up) remember(nextDockMemory(memory, { type: 'expand' })); // the compact dock has no height to step: up opens it
      } else {
        remember(nextDockMemory(memory, { type: 'resize', height: openHeight(memory, viewportHeight()) + (up ? step : -step), compact: compactHeight(), max: Math.floor(viewportHeight() * OPEN_MAX_SHARE) }));
      }
    } else if (e.key === 'Home') remember(nextDockMemory(memory, narrow() ? { type: 'snap', snap: 'peek' } : { type: 'minimise' }));
    else if (e.key === 'End') remember(nextDockMemory(memory, narrow() ? { type: 'snap', snap: 'full' } : { type: 'expand' }));
    else if (e.key === 'Enter' || e.key === ' ') remember(nextDockMemory(memory, narrow() ? { type: 'snap', snap: nextSnap(memory.snap, 1) } : { type: 'toggle' }));
    else return;
    e.preventDefault();
    e.stopPropagation();
    refresh();
  });

  // Esc inside the dock closes the smallest thing first: a counting rule that is open (the button the focus is on, as a disclosure should), then a route that is
  // pinned (the view); only then does the editor clear the selection (and the dock closes).
  listen(el, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    const t = e.target;
    const ruleOpen = t && typeof t.getAttribute === 'function' && t.getAttribute('aria-expanded') === 'true' && typeof t.click === 'function' && t !== detailsButton;
    if (ruleOpen) t.click();
    if (ruleOpen || (view && typeof view.escape === 'function' && view.escape())) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // ---- the keyboard ----

  /**
   * Is this keydown one of ours? `I`, `[` and `]` without a modifier. [ and ] are typed with AltGr (Ctrl+Alt on Windows) on German, Nordic and many other
   * keyboards and with Option on a Mac: the `key` is the character that came out, so a bracket with Alt (or AltGr) is ours; a bracket with Ctrl alone (the
   * browser's) or with Cmd is not.
   */
  const ownKey = (e) => {
    if (e.metaKey) return false;
    if (e.key === '[' || e.key === ']') return !e.ctrlKey || e.altKey;
    return !e.ctrlKey && !e.altKey;
  };

  function onKey(e) {
    if (destroyed || e.defaultPrevented || !ownKey(e) || e.repeat || e.isComposing) return;
    if (isTypingTarget(e.target) || (doc && dialogOpen(doc))) return;
    if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      toggle();
    } else if (e.key === '[' || e.key === ']') {
      const next = cycleSelection(store.getState().layout, store.getState().ui.selection, e.key === ']' ? 1 : -1);
      if (!next) return;
      e.preventDefault();
      store.select(next.kind, next.ids);
      open({ reveal: 'always' });
    }
  }
  listen(win, 'keydown', onKey);

  // ---- the click rule ----

  const clicks = editor && editor.canvas ? watchClicks({
    canvas: editor.canvas,
    upTarget: stage || editor.canvas,
    editor,
    onDrag: () => el.classList.add('is-dragging'),
    onEnd: () => el.classList.remove('is-dragging'),
    onClick: () => {
      const state = store.getState();
      const selection = state.ui.selection;
      if (closedByUndockable && NO_DOCK_KINDS.includes(selection.kind)) say(NO_STATS_TEXT); // after the editor's own status text, which it wrote at the same pointerup
      closedByUndockable = false;
      if (dockKind(selection) === null) return;
      const report = runner && runner.sim && typeof runner.kpis === 'function' ? runner.kpis() : null;
      const run = runner ? { playing: runner.playing, speed: runner.speed } : null;
      const decision = openDecision({ trigger: 'click', pref: state.ui.statsDock, report });
      if (!decision.open) {
        // nothing measured yet: "Press play ..." while paused, "... start in about 1 min: the plant is warming up first" while it runs
        if (decision.reason === 'nodata') say(waitText(selection, state.layout, runner ? runner.sim : null, report, run));
        return;
      }
      open({ reveal: true });
      if (selection.kind === 'cell' && selection.ids.length === 1) { const hint = fastClickText(run); if (hint) say(hint); } // a click aimed at a fast vehicle that landed on the road under it
    },
  }) : null;

  // ---- the store and the runner ----

  offs.push(store.subscribe((state, info) => {
    const selection = state.ui.selection;
    const key = selectionKey(selection);
    if (key !== lastSelKey) {
      const before = lastSel;
      lastSel = selection;
      lastSelKey = key;
      noteAsked = false;
      if (before.kind === 'vehicle' && selection.kind === 'fleet' && info.layoutChanged && typeof ctx.toast === 'function') {
        ctx.toast('That vehicle no longer exists, so its fleet is selected.');
      }
      if (opened && dockKind(selection) === null) {
        opened = false;
        closedByUndockable = NO_DOCK_KINDS.includes(selection.kind);
        if (closedByUndockable) say(NO_STATS_TEXT);
      }
    }
    schedule();
  }));
  if (runner && typeof runner.on === 'function') {
    for (const name of ['kpis', 'rebuild', 'state']) offs.push(runner.on(name, schedule));
  }

  listen(contentHost, 'scroll', syncMore, true); // scroll events do not bubble: caught on the way down to the body
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => { syncCovered(); syncMore(); });
    observer.observe(el);
    if (stage) observer.observe(stage);
    offs.push(() => observer.disconnect());
  }
  if (narrowQuery && typeof narrowQuery.addEventListener === 'function') listen(narrowQuery, 'change', () => { el.style.height = ''; refresh(); });

  return {
    el,
    host,
    open,
    close,
    toggle,
    /** Redraw now (the dock otherwise refreshes once per animation frame). */
    refreshNow: refresh,
    /** Open from a click-like trigger ('click' or 'focus'): obeys the preference ui.statsDock. True when it opened. */
    request(trigger = 'focus', opts = {}) {
      const state = store.getState();
      const decision = openDecision({ trigger, pref: state.ui.statsDock, report: runner && runner.sim && typeof runner.kpis === 'function' ? runner.kpis() : null });
      if (!decision.open) return false;
      return open(opts);
    },
    /** Pixels of the stage the dock covers at its bottom (0 when closed): the camera fits and reveals into the rest. */
    covered,
    isOpen: () => !el.hidden,
    state: () => ({ ...memory, window: shownWindow, open: !el.hidden, opened }),
    setWindow,
    get contentError() { return contentError; },
    get contentState() { return contentState; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (clicks) clicks.destroy();
      for (const off of offs.splice(0)) off();
      destroyView();
      el.remove();
      announcer.remove();
      if (stage) { stage.style.setProperty('--dock-covered', '0px'); stage.removeAttribute('data-dock'); }
      const root = doc && doc.documentElement;
      if (root && root.style && typeof root.style.removeProperty === 'function') root.style.removeProperty('--dock-lift');
    },
  };
}
