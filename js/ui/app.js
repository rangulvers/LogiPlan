// App shell (docs/ARCHITECTURE.md 6.7 and 6.8): builds the store, camera, renderer, runner and editor, assembles the shared
// `ctx`, and builds the chrome around the plan: top bar, tool palette, floating simulation and display controls, the tabbed
// right panel, status line and toasts. index.html holds the empty skeleton (regions marked data-region); this file fills it.
//
//   const app = createApp(document.getElementById('app'));   // { store, runner, ctx, editor, camera, renderer, destroy() }
//
// Update flow. Everything the planner sees is a function of store.getState() plus the runner: the store notifies, the shell
// coalesces the notifications into one update per animation frame and calls update(state) on the chrome and on the VISIBLE
// panel only (a hidden panel is brought up to date when its tab opens). While a simulation runs the runner's 'kpis' event
// (about 4 Hz) triggers the same update, so live panels follow without a timer of their own. The clock, the run state chip and the
// speed hint follow the runner's frames directly and only touch the DOM when their text changes.
//
// Robustness. Every panel is created and updated inside a guard: when one throws, its tab shows an error card with a
// "Reload panel" button, the error goes to console.error once, and nothing else is affected. A file dropped on the page opens
// the dialog for project files instead of making the browser leave the app.
//
// Readings of the spec (also listed in the report):
//  * ctx.issues() / ctx.graph() are cached per layout object (WeakMap). Called while the panels update (a store change per frame
//    during a drag), issues() recomputes at most every ISSUES_INTERVAL_MS: in between it hands out the previous result and
//    schedules one late recomputation that asks for a new update; called from anywhere else (reports, tests), after a load or a
//    variant switch, or when the last computation is older than that, it is exact.
//  * Leaving the page with unsaved changes warns only when the autosave cannot hold them (store.persist() failed). With a working
//    autosave nothing is lost on reload, and a warning on every reload would teach planners to ignore it.
//  * ctx.actions.loadExample() and newProject() resolve true when the plant was replaced and false when the planner declined to
//    lose unsaved work. fitView({ animate }) takes an optional argument; a view that is still the latest whole-plant fit follows
//    the size of the stage, a view the planner moved does not.
//  * index.html has no dialog root: dialogs.js appends its own backdrop to <body>.
//  * Space plays and pauses unless the planner is typing or has put the keyboard focus on a control (Tab). A button, tab or select
//    the mouse just clicked does not count: Space then plays, instead of pressing that control a second time.
//  * The plan shows a focus frame only after Tab moved the focus there (data-tabbed), not after a shortcut key or when a dialog
//    hands the keyboard back to the plan (which it does after loading a plant).
//  * On compact screens (narrow, or a phone held sideways) the display options sit behind a "Display" button and the plan is fitted
//    into the part of the stage the floating controls leave free.
//  * The plant name is one name: the project name of the top bar. The Properties tab edits it, the file, window and report use it.

import { h } from '../util/dom.js';
import { clamp, formatClock, formatDuration } from '../util/format.js';
import { createStore } from '../store/store.js';
import { buildGraph } from '../sim/graph.js';
import { validateLayout } from '../model/validate.js';
import { getStation, getFlow, getFleet } from '../model/layout.js';
import { EXAMPLES } from '../model/examples.js';
import { OBSTACLE_KINDS } from '../model/defaults.js';
import { icon } from './icons.js';
import { Camera } from './camera.js';
import { Renderer } from './renderer.js';
import { resolveThemeMode } from './theme.js';
import { createRunner, SPEEDS } from './runner.js';
import { Editor } from './editor.js';
import { TOOL_KEYS, SPEED_ZONE_FACTORS, toolHint, obstacleName } from './editor/tools.js';
import { DRAW_MODES } from './editor/strokes.js';
import { isTypingTarget, dialogOpen } from './editor/keys.js';
import { createDialogs, isTouchOnly } from './dialogs.js';
import { downloadReport, printReport, exportLayoutPng, exportLayoutJson } from './report.js';
import { callout, emptyState } from './panels/fields.js';
import { createInspectorPanel } from './panels/inspector.js';
import { createFleetPanel } from './panels/fleet.js';
import { createStatsDock, refsOf } from './panels/stats-dock.js';
import { createFlowsPanel } from './panels/flows.js';
import { createSimulatePanel } from './panels/simulate.js';
import { createChecksPanel } from './panels/checks.js';
import { createGuideChip } from './panels/nextsteps.js';
import { createVersionChip } from './about.js';
import { createImpactHint } from './panels/impact.js';
import { createDayHint } from './panels/day-hint.js';
import { createDashboard } from './dashboard.js';
import { createCompare } from './compare.js';
import { clockChip, clockStart, coldRestartText, isDayPlant, shouldShowColdRestartToast } from './day-plant.js';

// ---------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------

/** Tabs of the right-hand panel, in order. `id` is what store.ui.rightTab holds. */
export const RIGHT_TABS = Object.freeze([
  { id: 'properties', label: 'Properties', icon: 'sliders', create: createInspectorPanel },
  { id: 'fleet', label: 'Fleet', icon: 'truck', create: createFleetPanel },
  { id: 'flows', label: 'Flows', icon: 'route', create: createFlowsPanel },
  { id: 'simulate', label: 'Simulate', icon: 'settings', create: createSimulatePanel },
  { id: 'results', label: 'Results', icon: 'chart', create: createDashboard },
  { id: 'experiments', label: 'Experiments', icon: 'flask', create: createCompare },
  { id: 'checks', label: 'Checks', icon: 'check', create: createChecksPanel },
]);

/** Tool palette: groups separated by a rule. [tool, planner name]. */
const TOOL_GROUPS = Object.freeze([
  [['select', 'Select'], ['pan', 'Pan']],
  [['road', 'Road'], ['oneway', 'One-way road'], ['speedzone', 'Slow zone'], ['erase', 'Eraser']],
  [['source', 'Goods in'], ['process', 'Workstation'], ['storage', 'Storage'], ['sink', 'Goods out'], ['depot', 'Parking']],
  [['obstacle', 'Obstacle'], ['label', 'Label'], ['flow', 'Flow']],
]);

/** Display toggles over the plan: [overlay flag, button text, what it does]. */
const OVERLAY_FLAGS = Object.freeze([
  ['grid', 'Grid', 'Show the grid lines'],
  ['studs', 'Studs', 'Show the studs of the baseplate'],
  ['flows', 'Flows', 'Show the material flows between stations'],
  ['docks', 'Docks', 'Mark the road cells where vehicles load and unload'],
  ['jobs', 'Jobs', 'While the simulation runs: show where each vehicle is heading and where loads wait for pickup'],
  ['routes', 'Routes', 'Draw the usual trips of the selected vehicle or item on the plan while its statistics are open'],
  ['labels', 'Labels', 'Show station names and text labels'],
  ['ids', 'Vehicle IDs', 'Write a number on every vehicle'],
]);
const HEAT_MODES = Object.freeze([
  ['off', 'Off', 'No heatmap'],
  ['traffic', 'Traffic', 'Colour roads by how many vehicles drove over them'],
  ['waiting', 'Waiting', 'Colour roads by how long vehicles waited there'],
]);

const THEME_CHOICES = Object.freeze([
  ['auto', 'Automatic (system)'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]);

const SIDE_WIDTH_KEY = 'logiplan:side-width';
const SIDE_DEFAULT = 360;
const SIDE_MIN = 300;
const SIDE_MAX = 720;
const SIDE_KEY_STEP = 16;
const NARROW_QUERY = '(max-width: 899.98px)';
/** Screens where the floating controls sit over the plan: a narrow one (the panel is a drawer) or a short one (a phone held sideways). */
const COMPACT_QUERY = '(max-width: 899.98px), (max-height: 520px)';

const FIT_PADDING = 56;
const FIT_PADDING_MIN = 16;
const FIT_MARGIN_SHARE = 0.06;
const FOCUS_PADDING = 96;
const FOCUS_MARGIN = 64;
const FOCUS_MAX_ZOOM = 30;
const FOCUS_MS = 150;
const REVEAL_MARGIN = 24; // px kept free around an item that revealMinimal pans into view
const ZOOM_STEP = 1.25;
const STEP_SECONDS = 1;
const ISSUES_INTERVAL_MS = 200;
const PRIME_PROGRESS_AFTER_MS = 600; // a pre-roll that takes longer than this shows how far it has come
const MAX_VARIANTS_HINT = 'A project can hold at most 100 variants.';

const TOAST_ICONS = Object.freeze({ info: 'info', success: 'check', warn: 'warning', error: 'error' });
const TOAST_MAX = 3;
const TOAST_MIN_MS = 3500;
const TOAST_MAX_MS = 12000;
const TOAST_MS_PER_CHAR = 55;
const TOAST_RESUME_MS = 1500;

const MOD = /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl';
const ROVING_STEPS = Object.freeze({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 });
const CHIP_CLASS = Object.freeze({ running: 'chip chip--good', warming: 'chip chip--info', paused: 'chip', ready: 'chip' });
const LIMITED_HINT = 'This computer cannot keep up with the chosen speed, so the simulation runs as fast as it can. Choose a lower speed for smooth motion.';

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (exported for the tests in tests/e2e/app.mjs)
// ---------------------------------------------------------------------------------------------------------

/** The panel width to use for a wish of `px` on a viewport `viewportWidth` px wide (never more than 60 % of it). */
export function clampSideWidth(px, viewportWidth) {
  const max = Math.max(SIDE_MIN, Math.min(SIDE_MAX, viewportWidth * 0.6));
  return Math.round(clamp(Number.isFinite(px) ? px : SIDE_DEFAULT, SIDE_MIN, max));
}

/** Ease in and out, 0..1 -> 0..1. */
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

/** What ctx.actions.focus selects on the plan: stations first, then flows, fleets, road cells. null when refs name nothing. */
export function selectionFor(refs) {
  const r = refs || {};
  for (const [kind, key] of [['station', 'stationIds'], ['flow', 'flowIds'], ['fleet', 'fleetIds']]) {
    if (r[key] && r[key].length) return { kind, ids: [...r[key]] };
  }
  if (r.cells && r.cells.length) return { kind: 'cell', ids: r.cells.map(([cx, cy]) => `${cx},${cy}`) };
  return null;
}

/**
 * The smallest pan (px) that brings a box {x0, y0, x1, y1} (screen px) into a free area {left, top, right, bottom}: none when it is inside, the distance to
 * the nearest edge when it sticks out on one side. A box bigger than the area cannot be shown whole: it stays where it is while part of it is in the area
 * (a planner zoomed in on a big station who clicks it sees no jump) and is centred only when none of it is.
 */
export function minimalPan(box, free) {
  const along = (a, b, lo, hi) => {
    if (b - a > hi - lo) return b <= lo || a >= hi ? (lo + hi) / 2 - (a + b) / 2 : 0;
    return a < lo ? lo - a : b > hi ? hi - b : 0;
  };
  return { dx: along(box.x0, box.x1, free.left, free.right), dy: along(box.y0, box.y1, free.top, free.bottom) };
}

/** The smallest rectangle {x, y, w, h} in metres that holds everything `refs` points at, or null. */
export function focusRect(layout, refs, vehicles = []) {
  const cs = layout.grid.cellSize;
  const boxes = [];
  const cellBox = (x, y, w, hgt) => boxes.push({ x: x * cs, y: y * cs, w: w * cs, h: hgt * cs });
  const stationBox = (id) => {
    const s = getStation(layout, id);
    if (s) cellBox(s.x, s.y, s.w, s.h);
  };
  const fleetBoxes = (id) => {
    const mine = vehicles.filter((v) => v.fleetId === id && v.visible !== false && Number.isFinite(v.x) && Number.isFinite(v.y));
    for (const v of mine) boxes.push({ x: v.x - cs / 2, y: v.y - cs / 2, w: cs, h: cs });
    const fleet = getFleet(layout, id);
    if (!mine.length && fleet && fleet.home) stationBox(fleet.home);
  };
  for (const id of refs.stationIds || []) stationBox(id);
  for (const id of refs.flowIds || []) {
    const flow = getFlow(layout, id);
    if (flow) { stationBox(flow.from); stationBox(flow.to); }
  }
  for (const id of refs.fleetIds || []) fleetBoxes(id);
  for (const id of refs.vehicleIds || []) { // single vehicles (the Statistics dock): the cell the vehicle is on; none while it is not on the road
    const v = vehicles.find((x) => x.id === id);
    if (v && v.visible !== false && Number.isFinite(v.x) && Number.isFinite(v.y)) boxes.push({ x: v.x - cs / 2, y: v.y - cs / 2, w: cs, h: cs });
  }
  for (const [cx, cy] of refs.cells || []) cellBox(cx, cy, 1, 1);
  return unionOf(boxes);
}

function unionOf(boxes) {
  if (!boxes.length) return null;
  const e = boxes.reduce((a, b) => ({
    x0: Math.min(a.x0, b.x), y0: Math.min(a.y0, b.y), x1: Math.max(a.x1, b.x + b.w), y1: Math.max(a.y1, b.y + b.h),
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  return { x: e.x0, y: e.y0, w: e.x1 - e.x0, h: e.y1 - e.y0 };
}

/** The run state chip: Ready (never started), Warming up, Running or Paused. */
export function runChip({ playing, time, warmup, started, priming = false, primeProgress = null }) {
  // an edit: the new plant is pre-rolled behind the one on screen; a slow plant shows how far it has come (in steps, so a screen reader is not flooded)
  if (priming) return { key: 'warming', label: primeProgress === null ? 'Updating…' : `Updating… ${Math.round(primeProgress * 100)} %` };
  if (playing) return time < warmup ? { key: 'warming', label: 'Warming up' } : { key: 'running', label: 'Running' };
  return started && time > 0 ? { key: 'paused', label: 'Paused' } : { key: 'ready', label: 'Ready' };
}

/** The next simulation speed up (direction 1) or down (-1) from SPEEDS, or the same one at the ends. */
export function stepSpeed(speed, direction) {
  const at = SPEEDS.findIndex((s) => s >= speed);
  const from = at < 0 ? SPEEDS.length - 1 : at;
  return SPEEDS[clamp(from + direction, 0, SPEEDS.length - 1)];
}

/**
 * What a key press means to the shell, or null. Only keys the editor does not own (Space is handled on key up).
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean }} e
 * @returns {null | 'save' | 'step' | 'faster' | 'slower' | 'help' | 'fit'}
 */
export function shortcutFor(e) {
  const key = e.key || ''; // browser autofill sends key events without a key
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return !e.shiftKey && key.toLowerCase() === 's' ? 'save' : null;
  switch (key) {
    case '.': return 'step';
    case '+': case '=': return 'faster';
    case '-': case '_': return 'slower';
    case '?': return 'help';
    case '0': return 'fit';
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------------------------------------

const reportedErrors = new Set();

/** console.error once per scope and message: a failure that repeats every frame must not flood the console. */
function reportOnce(scope, err) {
  const key = `${scope}: ${err && err.message ? err.message : err}`;
  if (reportedErrors.has(key)) return;
  reportedErrors.add(key);
  console.error(`[LogiPlan] ${scope}`, err);
}

/** An icon-only button. `tip` is the CSS tooltip (put the shortcut in it), `label` the accessible name. */
function iconButton(name, label, { tip = label, tipPos = 'bottom', onclick, className = '', size = 18 } = {}) {
  return h('button', {
    class: `btn btn--icon ${className}`.trim(), type: 'button', 'aria-label': label, 'data-tip': tip, 'data-tip-pos': tipPos, onclick,
  }, icon(name, { size }));
}

/** A top-bar button with an icon and a label that gives way to the icon alone on medium windows. */
function labelledButton(iconName, label, { onclick, tip = label, tipPos = 'bottom', caret = false } = {}) {
  return h('button', {
    class: 'btn btn--ghost btn--labelled', type: 'button', 'aria-label': label, 'data-tip': tip, 'data-tip-pos': tipPos, onclick,
  }, icon(iconName, { size: 18 }), h('span', { class: 'btn__label' }, label), caret ? icon('chevron-down', { size: 14, class: 'btn__caret' }) : null);
}

/** Run `fn` on every change of a media query (and once now); returns the query. */
function watchMedia(query, fn, signal) {
  const mq = globalThis.matchMedia(query);
  mq.addEventListener('change', () => fn(mq.matches), { signal });
  fn(mq.matches);
  return mq;
}

/** Arrow keys, Home and End move focus between the items of a toolbar or tab strip (and stay away from the plan editor). */
function enableRoving(container, selector, onFocus) {
  container.addEventListener('keydown', (e) => {
    const step = ROVING_STEPS[e.key];
    if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...container.querySelectorAll(selector)].filter((el) => !el.disabled && !el.hidden);
    const at = items.indexOf(e.target.closest(selector));
    if (at < 0) return;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + step + items.length) % items.length;
    e.preventDefault();
    e.stopPropagation(); // the editor would nudge the selection with these keys
    items[next].focus();
    if (onFocus) onFocus(items[next]);
  });
}

/** Roving tabindex: only `active` is a tab stop of the group. */
function setRoving(container, selector, active) {
  for (const el of container.querySelectorAll(selector)) el.tabIndex = el === active ? 0 : -1;
}

/** Scroll `container` sideways just far enough to show `el`. (scrollIntoView would also move the starting point of Tab.) */
function revealX(container, el) {
  const box = container.getBoundingClientRect();
  const at = el.getBoundingClientRect();
  if (at.left < box.left) container.scrollLeft -= box.left - at.left + 8;
  else if (at.right > box.right) container.scrollLeft += at.right - box.right + 8;
}

/** Set a property on first use and after every change of `value` only. */
function changed(cache, key, value, apply) {
  if (cache[key] === value) return;
  cache[key] = value;
  apply(value);
}

// ---------------------------------------------------------------------------------------------------------
// Menus (kit .dropdown / .menu)
// ---------------------------------------------------------------------------------------------------------

function menuItem(item, close) {
  if (item.separator) return h('div', { class: 'menu__sep', role: 'separator' });
  if (item.heading) return h('div', { class: 'menu__label', role: 'presentation' }, item.heading);
  const checkable = item.checked !== undefined;
  return h('button', {
    class: `menu__item${item.danger ? ' menu__item--danger' : ''}`,
    type: 'button',
    role: checkable ? 'menuitemradio' : 'menuitem',
    'aria-checked': checkable ? String(Boolean(item.checked)) : null,
    disabled: item.disabled,
    onclick: () => { close(); item.run(); },
  }, icon(checkable ? 'check' : item.icon || 'chevron-right', { size: 16, class: 'menu__icon' }),
  h('span', null, item.label),
  item.kbd ? h('span', { class: 'menu__kbd' }, item.kbd) : null);
}

/**
 * A menu button. `items()` is called each time the menu opens, so labels and disabled states are fresh:
 * [{ label, icon, run, kbd, danger, disabled, checked }] | { separator: true } | { heading: 'Text' }.
 * Keys: Down/Up/Home/End move, Enter or Space choose, Esc closes and returns focus to the button, Tab leaves.
 */
function createDropdown({ trigger, items, end = false }) {
  const wrap = h('div', { class: 'dropdown' }, trigger);
  let menu = null;
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  function close(restoreFocus = true) {
    if (!menu) return;
    menu.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (restoreFocus) trigger.focus();
  }

  function onOutside(e) {
    if (!wrap.contains(e.target)) close(false);
  }

  function onKey(e) {
    const list = [...menu.querySelectorAll('.menu__item:not(:disabled)')];
    const at = list.indexOf(document.activeElement);
    const go = (i) => { e.preventDefault(); list[(i + list.length) % list.length].focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Tab') close();
    e.stopPropagation(); // letters and arrows must not reach the plan editor while a menu is open
  }

  function open() {
    if (menu) return;
    const name = trigger.getAttribute('aria-label') || trigger.textContent.trim();
    menu = h('div', { class: `menu dropdown__menu${end ? ' dropdown__menu--end' : ''}`, role: 'menu', 'aria-label': name }, items().map((item) => menuItem(item, close)));
    menu.addEventListener('keydown', onKey);
    wrap.append(menu);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.menu__item:not(:disabled)'))?.focus();
  }

  trigger.addEventListener('click', () => (menu ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' || menu) return;
    e.preventDefault();
    e.stopPropagation();
    open();
  });
  return { el: wrap, close, get isOpen() { return menu !== null; } };
}

// ---------------------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------------------

/** ctx.toast(message, { kind, ms, action }) writing into the live region `region`. */
function createToaster(region) {
  const live = new Set();

  function remove(entry) {
    clearTimeout(entry.timer);
    live.delete(entry);
    entry.el.remove();
  }

  function arm(entry, ms) {
    clearTimeout(entry.timer);
    if (Number.isFinite(ms)) entry.timer = setTimeout(() => remove(entry), ms);
  }

  function build(text, type, action, entry) {
    const close = h('button', { class: 'toast__close', type: 'button', 'aria-label': 'Dismiss', onclick: () => remove(entry) }, icon('close', { size: 14 }));
    const act = action ? h('button', { class: 'toast__action', type: 'button', onclick: () => { remove(entry); action.onClick(); } }, action.label) : null;
    return h('div', { class: `toast${type === 'info' ? '' : ` toast--${type}`}`, role: type === 'error' ? 'alert' : 'status' },
      icon(TOAST_ICONS[type], { size: 16, class: 'toast__icon' }), h('span', { class: 'toast__msg' }, text), act, close);
  }

  return function toast(message, { kind = 'info', ms, action = null } = {}) {
    const text = String(message ?? '').trim();
    const type = TOAST_ICONS[kind] ? kind : 'info';
    if (!text) return { close() {} };
    const duration = ms ?? clamp(text.length * TOAST_MS_PER_CHAR, TOAST_MIN_MS, TOAST_MAX_MS);
    const same = [...live].find((t) => t.text === text && t.type === type);
    if (same) {
      arm(same, duration);
      return same.handle;
    }
    const entry = { text, type, timer: 0 };
    entry.el = build(text, type, action, entry);
    entry.handle = { close: () => remove(entry) };
    const pause = () => clearTimeout(entry.timer);
    const resume = () => arm(entry, TOAST_RESUME_MS);
    entry.el.addEventListener('pointerenter', pause);
    entry.el.addEventListener('pointerleave', resume);
    entry.el.addEventListener('focusin', pause);
    entry.el.addEventListener('focusout', resume);
    live.add(entry);
    region.append(entry.el);
    if (live.size > TOAST_MAX) remove(live.values().next().value);
    arm(entry, duration);
    return entry.handle;
  };
}

// ---------------------------------------------------------------------------------------------------------
// ctx.graph() and ctx.issues()
// ---------------------------------------------------------------------------------------------------------

/**
 * Road graph and validation issues of the layout on screen, cached per layout object. `whileUpdating(fn)` marks the panel
 * update loop: inside it issues() hands out the previous result when the layout just changed and recomputes later (see the header).
 */
function createAnalysis(store, onSettled) {
  const graphs = new WeakMap();
  const issueLists = new WeakMap();
  let previous = null;
  let computedAt = -Infinity;
  let pending = 0;
  let updating = false;

  function graphOf(layout) {
    if (!graphs.has(layout)) graphs.set(layout, buildGraph(layout));
    return graphs.get(layout);
  }

  function compute(layout) {
    let found = [];
    try {
      found = validateLayout(layout, { graph: graphOf(layout) });
    } catch (err) {
      reportOnce('checking the plant', err);
    }
    issueLists.set(layout, found);
    previous = found;
    computedAt = performance.now();
    return found;
  }

  /** A late, single recomputation for the layout that is current by then. */
  function settleSoon() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = 0;
      const { layout } = store.getState();
      if (!issueLists.has(layout)) compute(layout);
      onSettled();
    }, ISSUES_INTERVAL_MS);
  }

  return {
    graph: () => graphOf(store.getState().layout),
    issues() {
      const { layout } = store.getState();
      if (issueLists.has(layout)) return issueLists.get(layout);
      if (updating && previous && performance.now() - computedAt < ISSUES_INTERVAL_MS) {
        settleSoon();
        return previous;
      }
      return compute(layout);
    },
    /** A different document (load, variant switch) must never show the issues of the old one. */
    forget() {
      previous = null;
    },
    whileUpdating(fn) {
      updating = true;
      try {
        fn();
      } finally {
        updating = false;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Camera control: fit, zoom, glide to a target
// ---------------------------------------------------------------------------------------------------------

function createCameraControl({ camera, canvas, store, coveredAtTop, coveredAtBottom = () => 0 }) {
  let frame = 0;
  let pendingFit = false;
  let lastFit = null; // the view of the latest fit: while the camera still shows it, a resized stage re-fits

  const size = () => [canvas.clientWidth, canvas.clientHeight];
  const reducedMotion = () => globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function jump(target) {
    stop();
    camera.x = target.x;
    camera.y = target.y;
    camera.zoom = target.zoom;
  }

  function glide(target) {
    if (reducedMotion()) { jump(target); return; }
    stop();
    const from = { x: camera.x, y: camera.y, zoom: camera.zoom };
    const t0 = performance.now();
    const tick = (now) => {
      const k = clamp((now - t0) / FOCUS_MS, 0, 1);
      const e = easeInOut(k);
      camera.x = from.x + (target.x - from.x) * e;
      camera.y = from.y + (target.y - from.y) * e;
      camera.zoom = from.zoom * (target.zoom / from.zoom) ** e;
      frame = k < 1 ? requestAnimationFrame(tick) : 0;
    };
    frame = requestAnimationFrame(tick);
  }

  /** Show the whole baseplate. Before the canvas has a size the fit waits for it (resized()). */
  function fit({ animate = false } = {}) {
    const [w, hgt] = size();
    if (!(w > 0 && hgt > 0)) { pendingFit = true; return; }
    pendingFit = false;
    const margin = clamp(Math.round(Math.min(w, hgt) * FIT_MARGIN_SHARE), FIT_PADDING_MIN, FIT_PADDING); // less on a phone
    const top = Math.min(coveredAtTop(), hgt / 2); // the plan goes into the free part below the floating controls ...
    const bottom = Math.min(coveredAtBottom(), hgt / 2); // ... and above the Statistics dock, which is an overlay (the canvas keeps its size)
    const target = camera.clone().fit(store.getState().layout, w, hgt - top - bottom, margin);
    target.y -= (top - bottom) / 2 / target.zoom; // fitted into the free part, whose centre lies (top - bottom) / 2 below the centre of the canvas
    camera.setViewport(w, hgt);
    lastFit = { x: target.x, y: target.y, zoom: target.zoom };
    if (animate) glide(target); else jump(target);
  }

  /** Bring a world rectangle into view; nothing moves when it is already comfortably visible. The part under the Statistics dock does not count as visible. */
  function reveal(rect) {
    const [w, hgt] = size();
    if (!rect || !(w > 0 && hgt > 0)) return;
    const bottom = Math.min(coveredAtBottom(), hgt / 2);
    const view = camera.visibleRect();
    view.y1 -= bottom / camera.zoom;
    const m = FOCUS_MARGIN / camera.zoom;
    const inside = rect.x >= view.x0 + m && rect.y >= view.y0 + m && rect.x + rect.w <= view.x1 - m && rect.y + rect.h <= view.y1 - m;
    if (inside) return;
    const target = camera.clone().fitRect(rect, w, hgt - bottom, FOCUS_PADDING, FOCUS_MAX_ZOOM);
    target.y += bottom / 2 / target.zoom; // the free part is centred bottom / 2 above the centre of the canvas
    glide(target);
  }

  /**
   * Pan by the LEAST that brings a world rectangle out from under the top controls and the Statistics dock; never zooms. Does nothing when the
   * rectangle is already in the free part. (A rectangle bigger than the free part stays while part of it shows, else it is centred: see minimalPan.) True when the camera is moving.
   */
  function revealMinimal(rect) {
    const [w, hgt] = size();
    if (!rect || !(w > 0 && hgt > 0)) return false;
    const top = Math.min(coveredAtTop(), hgt / 2);
    const bottom = Math.min(coveredAtBottom(), hgt / 2);
    const m = REVEAL_MARGIN;
    const [x0, y0] = camera.worldToScreen(rect.x, rect.y);
    const x1 = x0 + rect.w * camera.zoom;
    const y1 = y0 + rect.h * camera.zoom;
    const { dx, dy } = minimalPan({ x0, y0, x1, y1 }, { left: m, top: top + m, right: w - m, bottom: hgt - bottom - m });
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return false;
    glide({ x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom, zoom: camera.zoom });
    return true;
  }

  /** Fit a world rectangle into the free part of the canvas (this one may zoom): "Show route on plan" of the dock. */
  function showRect(rect) {
    const [w, hgt] = size();
    if (!rect || !(w > 0 && hgt > 0)) return;
    const top = Math.min(coveredAtTop(), hgt / 2);
    const bottom = Math.min(coveredAtBottom(), hgt / 2);
    const target = camera.clone().fitRect(rect, w, Math.max(1, hgt - top - bottom), FOCUS_PADDING, FOCUS_MAX_ZOOM);
    target.y -= (top - bottom) / 2 / target.zoom;
    glide(target);
  }

  function zoomBy(factor) {
    stop();
    const [w, hgt] = size();
    camera.zoomAt(factor, w / 2, hgt / 2);
  }

  // The planner taking over (wheel, press) ends a glide at once instead of fighting it.
  canvas.addEventListener('wheel', stop, { passive: true, capture: true });
  canvas.addEventListener('pointerdown', stop, { capture: true });

  /** The stage changed size: a view that is still the whole-plant fit follows it, one the planner moved stays. */
  function resized() {
    const untouched = lastFit && Math.abs(camera.x - lastFit.x) < 1e-6 && Math.abs(camera.y - lastFit.y) < 1e-6 && Math.abs(camera.zoom - lastFit.zoom) < 1e-9;
    if (pendingFit || untouched) fit();
  }

  return { fit, reveal, revealMinimal, showRect, zoomBy, stop, resized };
}

// ---------------------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------------------

function createThemeControl(renderer) {
  const html = document.documentElement;
  const system = globalThis.matchMedia('(prefers-color-scheme: dark)');
  let applied = null;

  /** Keep the browser's address-bar colour in step with the page. */
  function paintMeta() {
    const bg = getComputedStyle(html).getPropertyValue('--bg').trim();
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', bg);
  }

  function apply(mode) {
    if (mode === applied) return;
    applied = mode;
    if (mode === 'auto') delete html.dataset.theme; else html.dataset.theme = mode;
    renderer.theme = mode;
    paintMeta();
  }

  system.addEventListener('change', () => {
    if (applied !== 'auto') return;
    renderer.theme = 'auto';
    paintMeta();
  });
  return { apply, resolved: () => resolveThemeMode(applied || 'auto') };
}

// ---------------------------------------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------------------------------------

function createStatusLine({ textEl, metaEl, store }) {
  let text = '';
  const cache = {};
  const idleHint = () => { const ui = store.getState().ui; return toolHint(ui.tool, ui.toolOptions); };
  const paint = () => changed(cache, 'text', text || idleHint(), (t) => { textEl.textContent = t; });
  return {
    set(next) { text = typeof next === 'string' ? next : ''; paint(); },
    update(state) {
      const { cols, rows, cellSize } = state.layout.grid;
      const metres = (n) => Math.round(n * cellSize * 10) / 10;
      changed(cache, 'meta', `${cols} × ${rows} cells · ${metres(cols)} × ${metres(rows)} m`, (t) => { metaEl.textContent = t; });
      paint();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Tool palette and tool options
// ---------------------------------------------------------------------------------------------------------

function createPalette(nav, { editor }) {
  const keyOf = Object.fromEntries(Object.entries(TOOL_KEYS).map(([key, tool]) => [tool, key.toUpperCase()]));
  const buttons = new Map();
  const bar = h('div', { class: 'toolbar toolbar--vertical', role: 'toolbar', 'aria-label': 'Drawing tools' });
  TOOL_GROUPS.forEach((group, i) => {
    if (i) bar.append(h('div', { class: 'toolbar__sep', role: 'separator' }));
    bar.append(h('div', { class: 'toolbar__group', role: 'group' }, group.map(([tool, name]) => {
      const button = h('button', {
        class: 'btn btn--icon', type: 'button', dataset: { tool }, 'aria-label': name, 'aria-pressed': 'false', 'aria-keyshortcuts': keyOf[tool],
        'data-tip': `${name} (${keyOf[tool]})`, 'data-tip-pos': 'right', onclick: () => editor.chooseTool(tool),
      }, icon(tool, { size: 20 }), h('span', { class: 'tool__label' }, name));
      buttons.set(tool, button);
      return button;
    })));
  });
  enableRoving(bar, 'button');
  nav.append(bar);
  const narrow = globalThis.matchMedia(NARROW_QUERY);
  let shown = null;
  return {
    update(state) {
      const active = buttons.get(state.ui.tool) || buttons.get('select');
      for (const [tool, button] of buttons) button.setAttribute('aria-pressed', String(tool === state.ui.tool));
      setRoving(bar, 'button', active);
      bar.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
      if (shown !== active && narrow.matches) revealX(nav, active);
      shown = active;
    },
  };
}

/** What the three draw modes of the stroke tools are called and what each one does (store.ui.toolOptions.drawMode). */
const DRAW_MODE_LABELS = Object.freeze({
  smart: ['Smart', 'Follows the pointer but stays straight: a small wobble is ignored, a clear turn makes one corner.'],
  straight: ['Straight', 'Every stroke is one straight line, as if Shift were held.'],
  free: ['Free', 'Follows the pointer exactly, cell by cell.'],
});
/** Tools that paint along a dragged path and so have a draw mode. */
const STROKE_TOOLS = new Set(['road', 'oneway', 'speedzone', 'erase']);

/** The options of the slow-zone, obstacle and drawing tools, over the bottom of the plan; hidden for every other tool. */
function createToolOptions(region, { editor }) {
  const choice = (label, entries, choose) => {
    const buttons = entries.map(([value, text, tip]) => h('button', { class: 'segmented__item', type: 'button', title: tip, dataset: { value: String(value) }, onclick: () => choose(value) }, text));
    const el = h('div', { class: 'segmented segmented--sm', role: 'group', 'aria-label': label }, buttons);
    return { el, set: (v) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(v)))) };
  };
  const zone = choice('Speed limit of the slow zone', [...SPEED_ZONE_FACTORS].sort((a, b) => a - b).map((f) => [f, `${Math.round(f * 100)} %`]), (factor) => editor.setToolOptions({ factor }));
  const kind = choice('Obstacle type', OBSTACLE_KINDS.map((k) => [k, obstacleName(k)]), (value) => editor.setToolOptions({ kind: value }));
  const mode = choice('Draw mode', DRAW_MODES.map((m) => [m, ...DRAW_MODE_LABELS[m]]), (drawMode) => editor.setToolOptions({ drawMode }));
  const titles = { speedzone: 'Speed limit', obstacle: 'Type' };
  const title = h('span', { class: 'overlays__label' });
  const sep = h('div', { class: 'toolbar__sep', role: 'separator' });
  const hint = h('span', { class: 'drawmode__hint' }, h('kbd', { class: 'kbd' }, 'Shift'), ' = straight line');
  const draw = h('div', { class: 'drawmode', role: 'group', 'aria-label': 'How the stroke follows the pointer' }, h('span', { class: 'overlays__label' }, 'Draw'), mode.el, hint);
  region.append(h('div', { class: 'toolbar toolbar--panel stagebar', role: 'group', 'aria-label': 'Tool options' }, title, zone.el, kind.el, sep, draw));
  return {
    update(state) {
      const { tool, toolOptions } = state.ui;
      const strokes = STROKE_TOOLS.has(tool);
      region.hidden = !strokes && !Object.hasOwn(titles, tool);
      if (region.hidden) return;
      title.hidden = !Object.hasOwn(titles, tool);
      title.textContent = titles[tool] || '';
      zone.el.hidden = tool !== 'speedzone';
      kind.el.hidden = tool !== 'obstacle';
      sep.hidden = tool !== 'speedzone';
      draw.hidden = !strokes;
      zone.set(toolOptions.factor);
      kind.set(toolOptions.kind);
      mode.set(toolOptions.drawMode);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Floating controls over the plan: simulation bar, display toggles, zoom
// ---------------------------------------------------------------------------------------------------------

function createSimBar({ runner, store }) {
  const play = h('button', { class: 'btn btn--icon btn--primary', type: 'button', 'data-tip-pos': 'bottom', onclick: () => { void runner.toggle(); } });
  const speed = h('select', {
    class: 'input input--sm simbar__speed', 'aria-label': 'Simulation speed', title: 'Simulation speed: simulated seconds per real second',
    onchange: () => runner.setSpeed(Number(speed.value)),
  }, SPEEDS.map((s) => h('option', { value: String(s) }, `${s}×`)));
  const clock = h('span', { class: 'simbar__clock tnum', role: 'timer', 'aria-label': 'Simulated time', title: 'Simulated time (hours:minutes:seconds)' }, '0:00:00');
  const dayText = h('span', { class: 'tnum' });
  const dayChip = h('span', { class: 'chip chip--info simbar__day', hidden: true, role: 'timer', 'aria-label': 'Time of day in the plant', 'data-role': 'day-clock' }, icon('clock', { size: 14 }), dayText); // a plant that follows a truck timetable: "Mon 06:42"
  const chip = h('span', { class: 'chip', role: 'status' });
  const limited = h('span', { class: 'chip chip--warn', hidden: true, title: LIMITED_HINT }, icon('warning', { size: 14 }), h('span', { class: 'simbar__limited-text' }, 'Speed limited'));
  const el = h('div', { class: 'toolbar toolbar--panel stagebar simbar', role: 'group', 'aria-label': 'Simulation controls' },
    iconButton('reset', 'Reset simulation', { tip: 'Reset to time 0', onclick: () => runner.reset() }),
    play,
    iconButton('step', `Step forward ${STEP_SECONDS} second`, { tip: `Step ${STEP_SECONDS} s (.)`, onclick: () => { void runner.step(STEP_SECONDS); } }),
    h('div', { class: 'toolbar__sep', role: 'separator' }), speed, clock, dayChip, chip, limited);
  const cache = {};
  let primingSince = null; // when the current pre-roll was first seen (ms), for the progress in the chip

  /** Bring the bar up to date with the runner; cheap enough to call on every frame. */
  function sync() {
    const state = store.getState();
    const warmup = runner.sim?.settings?.warmup ?? state.layout.settings.warmup ?? 0;
    changed(cache, 'playing', runner.playing, (playing) => {
      play.replaceChildren(icon(playing ? 'pause' : 'play', { size: 18 }));
      play.setAttribute('aria-label', playing ? 'Pause simulation' : 'Run simulation');
      play.dataset.tip = playing ? 'Pause (Space)' : 'Run (Space)';
    });
    changed(cache, 'speed', runner.speed, (s) => { if (document.activeElement !== speed) speed.value = String(s); });
    changed(cache, 'clock', formatClock(runner.time), (t) => { clock.textContent = t; });
    const day = clockChip(state.layout, runner.time);
    changed(cache, 'day', day ? day.label : '', (label) => { dayChip.hidden = !label; dayText.textContent = label; dayChip.title = day ? day.title : ''; });
    // a pre-roll that takes longer than a moment shows its progress in steps of 20 %
    const stamp = performance.now();
    if (!runner.priming) primingSince = null;
    else if (primingSince === null) primingSince = stamp;
    const showProgress = primingSince !== null && stamp - primingSince > PRIME_PROGRESS_AFTER_MS;
    const run = runChip({
      playing: runner.playing, time: runner.time, warmup, started: Boolean(runner.sim), priming: runner.priming,
      primeProgress: showProgress ? Math.min(0.95, Math.floor(runner.primeProgress * 5) / 5) : null,
    });
    changed(cache, 'chip', run.key, (key) => { chip.className = CHIP_CLASS[key]; });
    changed(cache, 'chipText', run.label, (t) => { chip.textContent = t; });
    changed(cache, 'limited', runner.limited && runner.playing, (on) => { limited.hidden = !on; });
  }

  sync();
  return { el, sync };
}

function createOverlayBar(store) {
  const flagButtons = OVERLAY_FLAGS.map(([flag, text, title]) => h('button', {
    class: 'btn btn--sm', type: 'button', title, dataset: { overlay: flag }, 'aria-pressed': 'false',
    onclick: () => store.setUi({ overlays: { [flag]: !store.getState().ui.overlays[flag] } }),
  }, text));
  const heatButtons = HEAT_MODES.map(([mode, text, title]) => h('button', {
    class: 'segmented__item', type: 'button', title, dataset: { heat: mode }, 'aria-pressed': 'false',
    onclick: () => store.setUi({ overlays: { heat: mode } }),
  }, text));
  // On a phone the nine display buttons would cover a third of the plan: there they sit behind one "Display" button (CSS shows
  // the toggle and hides the body of a closed bar only on compact screens; on a desktop screen the bar is always open).
  const body = h('div', { class: 'overlays__body', id: 'overlays-body' },
    h('div', { class: 'overlays__group' }, flagButtons),
    h('div', { class: 'overlays__group overlays__group--heat' },
      h('span', { class: 'overlays__label', id: 'heat-label' }, 'Heatmap'),
      h('div', { class: 'segmented segmented--sm', role: 'group', 'aria-labelledby': 'heat-label' }, heatButtons)));
  const toggle = h('button', {
    class: 'btn btn--sm overlays__toggle', type: 'button', 'aria-controls': 'overlays-body', 'aria-expanded': 'false', title: 'Show or hide the display options of the plan',
    onclick: () => { const open = el.dataset.open !== 'true'; el.dataset.open = String(open); toggle.setAttribute('aria-expanded', String(open)); },
  }, icon('layers', { size: 16 }), 'Display');
  const el = h('div', { class: 'toolbar toolbar--panel stagebar overlays', role: 'toolbar', 'aria-label': 'Plan display options', dataset: { open: 'false' } }, toggle, body);
  enableRoving(body, 'button');
  return {
    el,
    update(state) {
      const { overlays } = state.ui;
      for (const b of flagButtons) b.setAttribute('aria-pressed', String(Boolean(overlays[b.dataset.overlay])));
      for (const b of heatButtons) b.setAttribute('aria-pressed', String(b.dataset.heat === overlays.heat));
      setRoving(body, 'button', flagButtons[0]);
    },
  };
}

function createZoomBar({ zoomBy, fit }) {
  return h('div', { class: 'toolbar toolbar--panel toolbar--vertical', role: 'group', 'aria-label': 'Zoom' },
    iconButton('zoomin', 'Zoom in', { tip: 'Zoom in', tipPos: 'left', onclick: () => zoomBy(ZOOM_STEP) }),
    iconButton('zoomout', 'Zoom out', { tip: 'Zoom out', tipPos: 'left', onclick: () => zoomBy(1 / ZOOM_STEP) }),
    iconButton('fit', 'Fit the whole plant into view', { tip: 'Fit plant (0)', tipPos: 'left', onclick: () => fit({ animate: true }) }));
}

/** The card over an empty plan. */
function createEmptyHint(region, ctx) {
  const examples = h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => ctx.dialogs.openWelcome() }, icon('folder', { size: 14 }), 'Open an example');
  region.append(emptyState({
    iconName: 'road',
    title: 'Your plant is empty',
    text: `${isTouchOnly() ? 'Draw roads with the Road tool and place stations with the station tools.' : 'Draw roads with the Road tool (R) and place stations with the keys 1 to 5.'} Or open an example to see how a plant works.`,
    actions: [examples],
  }));
  return {
    update(state) {
      const l = state.layout;
      region.hidden = !(l.stations.length === 0 && l.obstacles.length === 0 && l.labels.length === 0 && Object.keys(l.roads).length === 0);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------------------------------------

function createProjectName(store) {
  const input = h('input', { class: 'input input--sm topbar__name', type: 'text', maxlength: '80', 'aria-label': 'Project name', spellcheck: 'false', autocomplete: 'off' });
  const current = () => store.getState().project.name;
  input.addEventListener('change', () => { if (!store.renameProject(input.value)) input.value = current(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { input.value = current(); input.blur(); }
  });
  return { el: input, update(state) { if (document.activeElement !== input) input.value = state.project.name; } };
}

function createSaveChip(store, ctx) {
  const dot = h('span', { class: 'dot' });
  const text = h('span', { class: 'savechip__text' });
  const el = h('button', { class: 'btn btn--ghost btn--sm savechip', type: 'button', onclick: () => ctx.actions.exportJson() }, dot, text);
  const cache = {};
  function describe(state) {
    const failure = state.dirty ? store.lastPersistError : null; // with nothing changed there is nothing to lose
    if (failure) return { tone: 'down', label: 'Not saved', title: `${failure.message} Click to download the project file instead.` };
    if (state.dirty) return { tone: 'starved', label: 'Unsaved', title: 'Your changes are kept in this browser automatically. Click to also download them as a project file.' };
    return { tone: 'busy', label: 'Saved', title: 'Nothing has changed since the project was opened or downloaded.' };
  }
  return {
    el,
    update(state) {
      const d = describe(state);
      changed(cache, 'tone', d.tone, (tone) => { dot.className = `dot tone-${tone}`; });
      changed(cache, 'label', d.label, (label) => { text.textContent = label; el.setAttribute('aria-label', `Project status: ${label}`); });
      changed(cache, 'title', d.title, (title) => { el.title = title; });
    },
  };
}

function createHistoryButtons(store) {
  const undo = iconButton('undo', 'Undo', { className: 'btn--ghost', onclick: () => store.undo() });
  const redo = iconButton('redo', 'Redo', { className: 'btn--ghost', onclick: () => store.redo() });
  const cache = {};
  const paint = (button, key, name, enabled, label, keys) => {
    button.disabled = !enabled;
    changed(cache, key, `${enabled}|${label}`, () => {
      const text = enabled ? [name, label].filter(Boolean).join(' ') : `Nothing to ${name.toLowerCase()}`;
      button.setAttribute('aria-label', text);
      button.dataset.tip = enabled ? `${text} (${keys})` : text;
    });
  };
  return {
    el: h('div', { class: 'topbar__group' }, undo, redo),
    update(state) {
      paint(undo, 'undo', 'Undo', state.canUndo, state.undoLabel || '', `${MOD}+Z`);
      paint(redo, 'redo', 'Redo', state.canRedo, state.redoLabel || '', `${MOD}+Shift+Z`);
    },
  };
}

/** Variant tabs (A, B, ...) with "add" and a small menu for the active one. */
function createVariants(ctx) {
  const { store, dialogs, toast } = ctx;
  const tabs = h('div', { class: 'variants__tabs', role: 'tablist', 'aria-label': 'Plant variants' });
  const add = iconButton('plus', 'Add a variant: a copy of the current one', {
    className: 'btn--sm btn--ghost', tip: 'Add a variant (copy of this one)',
    onclick: () => {
      const from = store.getState().project;
      const name = from.scenarios.find((s) => s.id === from.activeId).name;
      if (!store.addScenario('')) { toast(MAX_VARIANTS_HINT, { kind: 'warn' }); return; }
      toast(`Added a copy of “${name}”. Changes you make now only affect the new variant.`);
    },
  });
  const more = iconButton('chevron-down', 'Variant options', { className: 'btn--sm btn--ghost', tip: 'Rename, copy or delete this variant', size: 16 });
  const active = () => { const p = store.getState().project; return p.scenarios.find((s) => s.id === p.activeId); };

  async function rename(scenario = active()) {
    const name = await dialogs.prompt({ title: 'Rename variant', label: 'Name', value: scenario.name, confirmLabel: 'Rename' });
    if (name) store.renameScenario(scenario.id, name);
  }

  async function remove() {
    const scenario = active();
    const ok = await dialogs.confirm({
      title: `Delete variant “${scenario.name}”?`, text: 'Its plan and its undo history are removed. This cannot be undone.', confirmLabel: 'Delete variant', danger: true,
    });
    if (ok) store.deleteScenario(scenario.id);
  }

  const menu = createDropdown({
    trigger: more,
    items: () => [
      { label: 'Rename…', icon: 'edit', run: () => { void rename(); } },
      { label: 'Duplicate', icon: 'copy', run: () => { if (!store.duplicateScenario(active().id)) toast(MAX_VARIANTS_HINT, { kind: 'warn' }); } },
      { separator: true },
      { label: 'Delete…', icon: 'trash', danger: true, disabled: store.getState().project.scenarios.length < 2, run: () => { void remove(); } },
    ],
  });
  enableRoving(tabs, '[role="tab"]', (tab) => store.switchScenario(tab.dataset.id));

  const tabFor = new Map();
  let shown = null;
  function tabOf(scenario) {
    if (!tabFor.has(scenario.id)) {
      const label = h('span', null);
      const tab = h('button', {
        class: 'btn btn--sm btn--ghost variants__tab', type: 'button', role: 'tab', dataset: { id: scenario.id },
        onclick: () => store.switchScenario(scenario.id), ondblclick: () => { void rename(scenario); },
      }, label);
      tabFor.set(scenario.id, { tab, label });
    }
    return tabFor.get(scenario.id);
  }

  function rebuild(project) {
    const hadFocus = tabs.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    const keep = new Set(project.scenarios.map((s) => s.id));
    for (const id of [...tabFor.keys()]) if (!keep.has(id)) tabFor.delete(id);
    const elements = project.scenarios.map((s) => {
      const { tab, label } = tabOf(s);
      const on = s.id === project.activeId;
      label.textContent = s.name;
      tab.title = `Variant ${s.name}${on ? '' : ' (click to open)'}`;
      tab.setAttribute('aria-selected', String(on));
      tab.classList.toggle('is-active', on);
      tab.tabIndex = on ? 0 : -1;
      return tab;
    });
    tabs.replaceChildren(...elements);
    if (hadFocus && tabFor.has(hadFocus)) tabFor.get(hadFocus).tab.focus();
    revealX(tabs, tabFor.get(project.activeId).tab);
  }

  return {
    el: h('div', { class: 'variants' }, tabs, add, menu.el),
    update(state) {
      if (shown === state.project) return;
      shown = state.project;
      rebuild(state.project);
    },
  };
}

/** Menu entries shared by the desktop buttons and the narrow-screen menu. */
function appMenus({ ctx, store }) {
  const { actions, dialogs } = ctx;
  const exportItems = () => [
    { label: 'Project file (JSON)', icon: 'save', kbd: `${MOD}+S`, run: actions.exportJson },
    { label: 'Layout picture (PNG)', icon: 'download', run: actions.exportPng },
    { label: 'Report (HTML)', icon: 'chart', run: actions.exportReport },
    { label: 'Print or save as PDF…', icon: 'export', run: actions.print },
    { separator: true },
    { label: 'Open a project file…', icon: 'upload', run: actions.importFile },
  ];
  const themeItems = () => THEME_CHOICES.map(([mode, label]) => ({ label, checked: store.getState().ui.theme === mode, run: () => store.setUi({ theme: mode }) }));
  const moreItems = () => [
    { label: 'Examples', icon: 'folder', run: () => dialogs.openWelcome() },
    { label: 'Share', icon: 'share', run: actions.shareLink },
    { label: 'Help', icon: 'help', kbd: '?', run: () => dialogs.openHelp() },
    { label: 'About and what is new', icon: 'info', run: () => dialogs.openAbout() },
    { separator: true },
    { heading: 'Export' }, ...exportItems(),
    { separator: true },
    { heading: 'Colour theme' }, ...themeItems(),
  ];
  return { exportItems, themeItems, moreItems };
}

function createTopBar(region, { ctx, store, drawer, themeControl }) {
  const menus = appMenus({ ctx, store });
  const name = createProjectName(store);
  const saved = createSaveChip(store, ctx);
  const variants = createVariants(ctx);
  const history = createHistoryButtons(store);
  const themeButton = iconButton('sun', 'Colour theme', { className: 'btn--ghost', tip: 'Colour theme', tipPos: 'left' });
  const themeMenu = createDropdown({ trigger: themeButton, items: menus.themeItems, end: true });
  const exportButton = labelledButton('export', 'Export', { tip: 'Export, print or open a file', caret: true });
  const exportMenu = createDropdown({ trigger: exportButton, items: menus.exportItems, end: true });
  const moreButton = iconButton('more', 'More actions', { className: 'btn--ghost topbar__more' });
  const moreMenu = createDropdown({ trigger: moreButton, items: menus.moreItems, end: true });
  const panelToggle = h('button', {
    class: 'btn btn--ghost topbar__panel-toggle', type: 'button', 'aria-label': 'Details panel', title: 'Show or hide the details panel', 'aria-controls': 'side', 'aria-expanded': 'false', onclick: drawer.toggle,
  }, icon('sliders', { size: 18 }));
  drawer.attachToggle(panelToggle);
  const desktop = h('div', { class: 'topbar__group topbar__desktop' },
    labelledButton('folder', 'Examples', { tip: 'Open an example or start an empty plant', onclick: () => ctx.dialogs.openWelcome() }),
    labelledButton('share', 'Share', { tip: 'Create a link to share this plant', onclick: ctx.actions.shareLink }),
    exportMenu.el,
    labelledButton('help', 'Help', { tip: 'Help and keyboard shortcuts (?)', tipPos: 'left', onclick: () => ctx.dialogs.openHelp() }),
    themeMenu.el);
  region.append(name.el, saved.el, variants.el, h('span', { class: 'topbar__spacer' }), history.el, desktop, moreMenu.el, panelToggle);
  const parts = [name, saved, variants, history];
  const cache = {};
  return {
    update(state) {
      for (const part of parts) part.update(state);
      changed(cache, 'theme', themeControl.resolved(), (mode) => { themeButton.replaceChildren(icon(mode === 'dark' ? 'moon' : 'sun', { size: 18 })); });
      changed(cache, 'title', state.project.name, (n) => { document.title = `${n} – LogiPlan`; });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Right panel: tabs and guarded panels
// ---------------------------------------------------------------------------------------------------------

function createPanelHost({ ctx, tabbar, body, onSelect }) {
  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Panels' });
  tabbar.prepend(tabsEl);
  const entries = RIGHT_TABS.map((def) => {
    const badge = h('span', { class: 'badge badge--warn', hidden: true });
    const tab = h('button', {
      class: 'tab', type: 'button', role: 'tab', id: `tab-${def.id}`, 'aria-controls': `panel-${def.id}`, 'aria-selected': 'false', tabindex: '-1', title: def.label, 'aria-label': def.label,
      dataset: { tab: def.id }, onclick: () => onSelect(def.id),
    }, icon(def.icon, { size: 16 }), h('span', { class: 'tab__label' }, def.label), badge);
    const host = h('div', { class: 'side__panel', role: 'tabpanel', id: `panel-${def.id}`, 'aria-labelledby': `tab-${def.id}`, hidden: true });
    return { def, tab, badge, host, panel: null, failure: null };
  });
  tabsEl.append(...entries.map((e) => e.tab));
  body.append(...entries.map((e) => e.host));
  enableRoving(tabsEl, '[role="tab"]', (tab) => onSelect(tab.dataset.tab));
  let current = null;

  function errorCard(entry) {
    const reload = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => reloadPanel(entry) }, icon('reset', { size: 14 }), 'Reload panel');
    return h('div', { class: 'panel-error' }, callout({
      severity: 'error', title: `The ${entry.def.label} panel stopped working`, text: 'Your plant is not affected. Reloading the panel usually fixes this.', actions: h('div', { style: { marginTop: '8px' } }, reload),
    }));
  }

  function fail(entry, phase, err) {
    reportOnce(`${entry.def.label} panel (${phase})`, err);
    entry.failure = err;
    if (entry.panel) { try { entry.panel.destroy(); } catch { /* it already failed once */ } }
    entry.panel = null;
    entry.host.replaceChildren(errorCard(entry));
  }

  /** Create the panel on first use, then bring it up to date. Any exception turns into the error card. */
  function update(entry, state) {
    if (entry.failure) return;
    try {
      if (!entry.panel) {
        entry.panel = entry.def.create(ctx);
        entry.host.replaceChildren(entry.panel.el);
      }
      entry.panel.update(state);
    } catch (err) {
      fail(entry, 'update', err);
    }
  }

  function reloadPanel(entry) {
    entry.failure = null;
    update(entry, ctx.store.getState());
    setVisible(entry, true);
  }

  function setVisible(entry, visible) {
    try {
      if (entry.panel && entry.panel.setVisible) entry.panel.setVisible(visible);
    } catch (err) {
      fail(entry, 'show', err);
    }
  }

  return {
    /** Make `id` the visible tab. Returns true when the tab changed. */
    show(id, state) {
      const next = entries.find((e) => e.def.id === id) || entries[0];
      if (next === current) return false;
      if (current) {
        current.host.hidden = true;
        current.tab.setAttribute('aria-selected', 'false');
        setVisible(current, false);
      }
      current = next;
      next.host.hidden = false;
      next.tab.setAttribute('aria-selected', 'true');
      setRoving(tabsEl, '[role="tab"]', next.tab);
      revealX(tabsEl, next.tab);
      update(next, state);
      setVisible(next, true);
      return true;
    },
    refresh(state) { if (current) update(current, state); },
    setBadge(id, count, severity) {
      const entry = entries.find((e) => e.def.id === id);
      entry.badge.hidden = count === 0;
      entry.badge.textContent = String(count);
      entry.badge.className = `badge badge--${severity}`;
      const label = count === 0 ? entry.def.label : `${entry.def.label}, ${count} ${count === 1 ? 'problem' : 'problems'}`;
      entry.tab.setAttribute('aria-label', label);
      entry.tab.title = label;
    },
    focusActiveTab() { if (current) current.tab.focus(); },
    destroy() {
      for (const entry of entries) {
        try { entry.panel?.destroy(); } catch (err) { reportOnce(`${entry.def.label} panel (destroy)`, err); }
      }
    },
  };
}

/** The draggable left edge of the right panel: pointer, keyboard (arrow keys, Home, End), double click to reset. */
function createPanelResizer({ handle, app, signal }) {
  let width = SIDE_DEFAULT;
  try {
    width = Number(globalThis.localStorage.getItem(SIDE_WIDTH_KEY)) || SIDE_DEFAULT;
  } catch {
    // storage blocked: the default width applies
  }
  const remember = () => {
    try {
      globalThis.localStorage.setItem(SIDE_WIDTH_KEY, String(width));
    } catch {
      // not remembered this time
    }
  };
  function apply(px) {
    width = clampSideWidth(px, window.innerWidth);
    app.style.setProperty('--side-w', `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuemax', String(clampSideWidth(Infinity, window.innerWidth)));
  }
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the side panel');
  handle.setAttribute('aria-valuemin', String(SIDE_MIN));
  handle.tabIndex = 0;
  handle.title = 'Drag to resize. Double click to reset.';
  const dragTo = (e) => apply(app.getBoundingClientRect().right - e.clientX);
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
  });
  handle.addEventListener('pointermove', (e) => { if (handle.hasPointerCapture(e.pointerId)) dragTo(e); });
  const end = () => { handle.classList.remove('is-dragging'); document.body.classList.remove('is-resizing'); remember(); };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { apply(SIDE_DEFAULT); remember(); });
  handle.addEventListener('keydown', (e) => {
    const next = { ArrowLeft: width + SIDE_KEY_STEP, ArrowRight: width - SIDE_KEY_STEP, Home: SIDE_MIN, End: Infinity, Enter: SIDE_DEFAULT }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    apply(next);
    remember();
  });
  window.addEventListener('resize', () => apply(width), { signal });
  apply(width);
}

/** On narrow screens the right panel is a drawer opened from the top bar. */
function createDrawer({ app, side, scrim, closeButton, onOpen, signal }) {
  let toggle = null;
  let narrow = false;
  const isOpen = () => app.classList.contains('is-drawer-open');

  function setOpen(open, restoreFocus = true) {
    if (open && !narrow) return false;
    app.classList.toggle('is-drawer-open', open);
    scrim.hidden = !open;
    toggle?.setAttribute('aria-expanded', String(open));
    if (open) onOpen();
    if (!open && restoreFocus && side.contains(document.activeElement)) toggle?.focus();
    return true;
  }

  watchMedia(NARROW_QUERY, (matches) => { narrow = matches; if (!matches) setOpen(false, false); }, signal);
  scrim.addEventListener('click', () => setOpen(false));
  closeButton.addEventListener('click', () => setOpen(false));
  return {
    attachToggle(button) { toggle = button; },
    toggle: () => setOpen(!isOpen()),
    open: () => setOpen(true),
    close: (restoreFocus) => setOpen(false, restoreFocus),
    get isOpen() { return isOpen(); },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Keyboard shortcuts the editor does not own
// ---------------------------------------------------------------------------------------------------------

const BUTTON_LIKE = 'button, a, summary, select, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="separator"]';
const SPACE_OWNERS = '[role="menuitem"], [role="menuitemradio"], [role="separator"]';

function installShortcuts({ ctx, editor, drawer, signal }) {
  const { runner, actions, dialogs } = ctx;
  let spaceArmed = false;

  // Who owns the Space key? Menu items always do. A button, link or select does while it was focused with the keyboard: Space
  // then means "press it" or "open it". One the mouse just clicked keeps focus too, but nobody means to press it a second time
  // (the speed select sits right next to Play), so there Space is the simulation's play / pause, as the toasts and the help
  // promise. (:focus-visible cannot tell the two apart: the browser turns it on as soon as any key is pressed, Space included.)
  let pointerFocus = null; // the control pressed by the mouse or a finger last, for as long as it keeps the focus
  document.addEventListener('pointerdown', (e) => { pointerFocus = e.target.closest ? e.target.closest(BUTTON_LIKE) : null; }, { capture: true, signal });
  document.addEventListener('focusin', (e) => { if (e.target !== pointerFocus) pointerFocus = null; }, { signal });
  const claimsSpace = (el) => {
    const control = el.closest ? el.closest(BUTTON_LIKE) : null;
    return control !== null && (control.matches(SPACE_OWNERS) || control !== pointerFocus);
  };
  const plain = (e) => !isTypingTarget(e.target) && !dialogOpen(document) && !claimsSpace(e.target);

  const run = {
    save: () => actions.exportJson(),
    step: () => { void runner.step(STEP_SECONDS); },
    faster: () => runner.setSpeed(stepSpeed(runner.speed, 1)),
    slower: () => runner.setSpeed(stepSpeed(runner.speed, -1)),
    help: () => dialogs.openHelp(),
    fit: () => actions.fitView({ animate: true }),
  };

  // Esc closes the drawer before the editor can use it to clear the selection.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drawer.isOpen || dialogOpen(document)) return;
    e.preventDefault();
    e.stopPropagation();
    drawer.close();
  }, { capture: true, signal });

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      spaceArmed = !e.repeat ? plain(e) : spaceArmed;
      if (spaceArmed) e.preventDefault(); // a button the mouse clicked must not be pressed again by this Space
      return;
    }
    const command = shortcutFor(e);
    if (!command) return;
    if (command === 'save') {
      e.preventDefault();
      if (!dialogOpen(document)) run.save();
    } else if (!e.defaultPrevented && !isTypingTarget(e.target) && !dialogOpen(document)) {
      e.preventDefault();
      run[command]();
    }
  }, { signal });

  // Space plays or pauses on key UP, and only when it was not used to pan the plan (hold Space and drag).
  window.addEventListener('keyup', (e) => {
    if (e.key !== ' ' || !spaceArmed) return;
    spaceArmed = false;
    e.preventDefault();
    if (!editor.spacePanned && plain(e)) void runner.toggle();
  }, { signal });
  window.addEventListener('blur', () => { spaceArmed = false; }, { signal });
}

/** Mark the app (data-tabbed) while the planner moves focus with the Tab key; any press of the mouse or a finger ends it. */
function trackTabbing(app, signal) {
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') app.dataset.tabbed = ''; }, { capture: true, signal });
  document.addEventListener('pointerdown', () => { delete app.dataset.tabbed; }, { capture: true, signal });
}

// ---------------------------------------------------------------------------------------------------------
// Files dropped on the page
// ---------------------------------------------------------------------------------------------------------

/**
 * A file dropped anywhere but on a drop area would make the browser leave the app for the file. Refuse that, and send the
 * planner to the import dialog, whose drop area does the real work.
 */
function installFileDrop({ ctx, signal }) {
  const hasFiles = (e) => Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  }, { signal });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.target.closest && e.target.closest('[role="dialog"]')) return;
    ctx.dialogs.openImportExport();
    ctx.toast('To open a project file, drop it on the dashed area of this window.', { kind: 'info' });
  }, { signal });
}

// ---------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------

function findRegions(root) {
  const find = (name) => {
    const el = root.querySelector(`[data-region="${name}"]`);
    if (!el) throw new Error(`LogiPlan: index.html has no "${name}" region.`);
    return el;
  };
  const names = ['skip', 'topbar', 'palette', 'stage', 'canvas', 'loading', 'empty', 'floating', 'zoom', 'options', 'side', 'resize', 'tabbar', 'panels', 'statusbar', 'status-text', 'status-meta', 'scrim', 'toasts'];
  return Object.fromEntries(names.map((name) => [name, find(name)]));
}

/** Ask before replacing unsaved work. Resolves true when it is fine to go on. */
async function confirmReplace(ctx, { title, confirmLabel }) {
  if (!ctx.store.getState().dirty) return true;
  return ctx.dialogs.confirm({ title, text: 'The plant you are working on is replaced. Changes you have not downloaded are lost.', confirmLabel, danger: true });
}

function createActions(ctx, parts) {
  const { store, toast } = ctx; // ctx.dialogs does not exist yet: it is read when an action runs
  return {
    fitView: (options) => parts.cameraControl.fit(options),
    focus(refs) {
      const target = selectionFor(refs);
      if (!target) return;
      store.select(target.kind, target.ids);
      parts.statsDock?.request('focus', { reveal: false }); // an insight or a check pointing at an item: its statistics open too (preference "Statistics on click")
      parts.cameraControl.reveal(focusRect(store.getState().layout, refs || {}, ctx.runner.sim?.vehicles || []));
      parts.drawer.close(false);
    },
    /** Open the Statistics dock for the selection (the vehicle buttons of the Fleet tab): an explicit request, whatever "Statistics on click" says. */
    showStatistics(opts) {
      if (!parts.statsDock?.open({ reveal: 'always', ...opts })) return false; // the vehicle may be anywhere on the plan: bring it out from under the dock
      parts.drawer.close(false);
      return true;
    },
    setTool: (name) => parts.editor.setTool(name),
    /** Start connecting on the plan: { fromId } asks where a station's loads go, { toId } what feeds it (editor.startConnect). */
    startConnect(opts) {
      const started = parts.editor.startConnect(opts);
      if (started) parts.drawer.close(false); // on a narrow screen the panel must not cover the plan
      return started;
    },
    setRightTab(name) {
      if (!RIGHT_TABS.some((tab) => tab.id === name)) return;
      store.setUi({ rightTab: name });
      parts.drawer.open();
    },
    async loadExample(id) {
      const example = EXAMPLES.find((e) => e.id === id);
      if (!example) { toast('That example is not available.', { kind: 'error' }); return false; }
      if (!(await confirmReplace(ctx, { title: 'Open this example?', confirmLabel: 'Open example' }))) return false;
      store.newProject(example.build());
      toast(`Opened the example “${example.name}”. Press ${isTouchOnly() ? 'the' : 'Space or the'} play button to run it.`, { kind: 'success' });
      return true;
    },
    async newProject() {
      if (!(await confirmReplace(ctx, { title: 'Start a new plant?', confirmLabel: 'Start new plant' }))) return false;
      store.newProject();
      toast('Started a new, empty plant.', { kind: 'success' });
      return true;
    },
    exportPng() { if (exportLayoutPng(ctx)) toast('The layout picture was saved as a PNG file.', { kind: 'success' }); },
    exportReport() { downloadReport(ctx); },
    exportJson() {
      if (!exportLayoutJson(ctx)) return;
      store.markClean();
      toast('The project file was downloaded. You can open it again with Export > Open a project file.', { kind: 'success' });
    },
    print() { printReport(ctx); },
    importFile() { ctx.dialogs.openImportExport(); },
    shareLink() { ctx.dialogs.openShare(); },
  };
}

/**
 * The engine room: store, camera, renderer, runner, editor, the shared ctx and the services behind it. `parts` is how the pieces
 * that are built later (the panel host, the update loop) are reached by the ones built earlier.
 */
function createCore(region, signal) {
  const canvas = region.canvas;
  const store = createStore();
  const camera = new Camera();
  const renderer = new Renderer(canvas, { camera, theme: 'auto' });
  const runner = createRunner({ store, renderer });
  const status = createStatusLine({ textEl: region['status-text'], metaEl: region['status-meta'], store });
  const compact = globalThis.matchMedia(COMPACT_QUERY);
  const coveredAtTop = () => (compact.matches ? Math.max(0, region.floating.getBoundingClientRect().bottom - canvas.getBoundingClientRect().top) : 0);
  const coveredAtBottom = () => (parts.statsDock ? parts.statsDock.covered() : 0); // the Statistics dock is an overlay of the stage: it covers the bottom of the canvas
  const parts = { cameraControl: createCameraControl({ camera, canvas, store, coveredAtTop, coveredAtBottom }), editor: null, host: null, statsDock: null, refresh: () => {} };
  const analysis = createAnalysis(store, () => parts.refresh());
  const drawerClose = iconButton('close', 'Close the details panel', { className: 'btn--ghost side__close', tip: 'Close' });
  region.tabbar.append(drawerClose);
  parts.drawer = createDrawer({ app: region.app, side: region.side, scrim: region.scrim, closeButton: drawerClose, onOpen: () => parts.host.focusActiveTab(), signal });
  const ctx = {
    store, runner, renderer, camera, canvas, toast: createToaster(region.toasts), setStatus: status.set, graph: analysis.graph, issues: analysis.issues, dialogs: null, actions: null,
  };
  ctx.actions = createActions(ctx, parts);
  ctx.dialogs = createDialogs(ctx);
  parts.editor = new Editor({ canvas, store, camera, renderer, ctx });
  return { ctx, parts, analysis, status, themeControl: createThemeControl(renderer) };
}

/** Everything the planner sees around the plan. `update(state)` brings all of it up to date, the panel host included. */
function createChrome(region, core, signal) {
  const { ctx, parts, analysis, status, themeControl } = core;
  const { store, runner } = ctx;
  const { editor, drawer, cameraControl } = parts;
  const palette = createPalette(region.palette, { editor });
  const toolOptions = createToolOptions(region.options, { editor });
  const simBar = createSimBar({ runner, store });
  const overlayBar = createOverlayBar(store);
  const emptyHint = createEmptyHint(region.empty, ctx);
  const guideChip = createGuideChip(ctx); // "2 steps to finish" over the plan, bottom-left
  region.stage.append(guideChip.el);
  region.statusbar.append(createVersionChip(ctx, { signal }).el); // "v0.6.0" at the right end of the status line; opens the About dialog (js/ui/about.js)
  const topBar = createTopBar(region.topbar, { ctx, store, drawer, themeControl });
  const host = createPanelHost({ ctx, tabbar: region.tabbar, body: region.panels, onSelect: (id) => { store.setUi({ rightTab: id }); } });
  parts.host = host;
  const impactHint = createImpactHint(ctx); // "Before → after" under the simulation bar while an edit is being compared
  const dayHint = createDayHint(ctx); // "Time of day matters. Compare whole days." in its place for a plant that follows a timetable
  region.floating.append(h('div', { class: 'simcol' }, simBar.el, impactHint.el, dayHint.el), overlayBar.el);
  region.zoom.append(createZoomBar({ zoomBy: cameraControl.zoomBy, fit: cameraControl.fit }));
  parts.statsDock = createStatsDock(ctx, { stage: region.stage, editor, cameraControl, rectOf: (selection) => focusRect(store.getState().layout, refsOf(selection), runner.sim?.vehicles || []) });
  createPanelResizer({ handle: region.resize, app: region.app, signal });
  installShortcuts({ ctx, editor, drawer, signal });
  installFileDrop({ ctx, signal });

  function updateBadge() {
    const problems = analysis.issues().filter((i) => i.severity === 'error' || i.severity === 'warning');
    host.setBadge('checks', problems.length, problems.some((i) => i.severity === 'error') ? 'bad' : 'warn');
  }

  return {
    simBar,
    update(state) {
      analysis.whileUpdating(() => {
        try {
          for (const part of [palette, toolOptions, overlayBar, emptyHint, topBar, status, guideChip, impactHint, dayHint]) part.update(state);
          simBar.sync();
          updateBadge();
        } catch (err) {
          reportOnce('updating the toolbars', err);
        }
        if (!host.show(state.ui.rightTab, state)) host.refresh(state);
      });
    },
  };
}

/**
 * The update flow: the store and the runner ask for an update, at most one is made per animation frame. Returns what to call to
 * update at once, and a function that unsubscribes everything.
 */
function startUpdateLoop(core, chrome) {
  const { ctx, parts, analysis, themeControl } = core;
  const { store, runner } = ctx;
  let queued = false;

  function refreshNow() {
    chrome.update(store.getState());
  }

  function refresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; refreshNow(); });
  }
  parts.refresh = refresh;

  const unsubscribe = store.subscribe((state, info) => {
    themeControl.apply(state.ui.theme);
    if (info.type === 'load' || info.type === 'scenario') analysis.forget();
    if (info.type === 'load') parts.cameraControl.fit();
    refresh();
  });
  // A change of the plant itself (a station moved, a road drawn) replaces the simulation. A warm restart (the runner pre-rolls the new
  // plant behind the old one) says what changed and where to see the effect; a cold one (warm restart switched off) and the Reset
  // button say that the plant starts empty at 0:00 - the planner must be told why the clock jumped back. Edits that follow each
  // other merge into one message when the text is the same.
  let clockBeforeRebuild = 0;
  const offRunner = [
    runner.on('state', () => { chrome.simBar.sync(); refresh(); }),
    runner.on('frame', ({ time }) => { clockBeforeRebuild = time; chrome.simBar.sync(); }),
    runner.on('kpis', refresh),
    runner.on('rebuild', ({ reason, sim, warm, label, baseline, paired, warmedUp = true, warmupLeft = 0 }) => {
      if (sim && warm) {
        const what = label ? `Plant changed: ${label}. ` : 'Plant changed. ';
        if (!warmedUp) {
          // a warm-up longer than the quick pre-run: say so instead of promising numbers (Results show the warm-up progress)
          ctx.toast(`${what}Updated simulation is still warming up (about ${formatDuration(warmupLeft)} to go); Results show figures after that.`);
        } else if (baseline) {
          ctx.toast(`${what}Updated simulation is warmed up${paired ? ' – see Results for the effect.' : '. The old plant could not be compared in time – see Results.'}`, { action: { label: paired ? 'See effect' : 'See Results', onClick: () => ctx.actions.setRightTab('results') } });
        } else ctx.toast(`${what}Updated simulation is warmed up.`);
      } else if (sim && reason === 'reset') {
        ctx.toast('Simulation reset to an empty plant at 0:00.');
      } else if (sim && reason === 'structural' && sim.time < clockBeforeRebuild) {
        const layout = store.getState().layout;
        const again = isDayPlant(layout) // a day plant starts again at its clock; the first time the toast explains why (copy 7 of 7.6)
          ? (shouldShowColdRestartToast() ? coldRestartText(layout) : `The simulation starts again at ${clockStart(layout)}, because time of day matters.`)
          : 'Simulation reset to an empty plant at 0:00.';
        ctx.toast(`${label ? `Plant changed: ${label}. ` : ''}${again}`, isDayPlant(layout) ? { action: { label: 'Compare whole days', onClick: () => ctx.actions.setRightTab('experiments') } } : undefined);
      }
      clockBeforeRebuild = 0;
      refresh();
    }),
    runner.on('baseline', refresh),
    runner.on('priming', refresh), // the impact card says "Updating…" while the replacement is being pre-rolled
    runner.on('error', ({ error, phase }) => {
      reportOnce(`simulation (${phase})`, error);
      ctx.toast(`The simulation stopped because of an error (${error.message}). Your plant is not changed.`, { kind: 'error' });
    }),
  ];
  return { refreshNow, stop() { unsubscribe(); offRunner.forEach((off) => off()); } };
}

/**
 * Build the whole app inside `root` (the #app element of index.html).
 * @param {HTMLElement} root
 * @returns {{ store: object, runner: object, ctx: object, editor: Editor, camera: Camera, renderer: Renderer, destroy(): void }}
 */
export function createApp(root) {
  const region = { ...findRegions(root), app: root };
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const core = createCore(region, signal);
  const { ctx, parts, themeControl } = core;
  region.skip.addEventListener('click', (e) => { e.preventDefault(); region.canvas.focus(); }); // without leaving #plant in the address
  const chrome = createChrome(region, core, signal);
  trackTabbing(root, signal);
  const loop = startUpdateLoop(core, chrome);

  // Resizing a canvas clears it, and the browser paints right after this callback: without an immediate redraw every step of a
  // window or panel resize would flash a blank plan for one frame.
  const resizeObserver = new ResizeObserver(() => { ctx.renderer.resize(); parts.cameraControl.resized(); ctx.renderer.render(1); });
  resizeObserver.observe(region.stage);
  installLifecycle(ctx.store, signal);
  themeControl.apply(ctx.store.getState().ui.theme);
  parts.cameraControl.fit();
  loop.refreshNow();
  region.loading.remove();
  root.dataset.state = 'ready';

  return {
    store: ctx.store, runner: ctx.runner, ctx, editor: parts.editor, camera: ctx.camera, renderer: ctx.renderer,
    destroy() {
      lifetime.abort();
      loop.stop();
      resizeObserver.disconnect();
      parts.statsDock?.destroy();
      parts.editor.destroy();
      ctx.runner.destroy();
      parts.host.destroy();
      ctx.store.destroy();
    },
  };
}

/** Save when the page goes away; warn about leaving only if the autosave could not keep the changes. */
function installLifecycle(store, signal) {
  const flush = () => { store.persist(); };
  window.addEventListener('pagehide', flush, { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); }, { signal });
  window.addEventListener('beforeunload', (e) => {
    if (store.getState().dirty && !store.persist()) {
      e.preventDefault();
      e.returnValue = '';
    }
  }, { signal });
}
