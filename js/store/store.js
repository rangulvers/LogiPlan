// Application state store (docs/ARCHITECTURE.md 6.1): the single editing document and everything the UI needs to
// remember about it. DOM-free; every outside dependency (storage, clock, timers, error sink) is injectable.
//
//   const store = createStore({ storageKey, storage, now, setTimeout, clearTimeout, onError });
//   store.getState() -> { project: { name, scenarios: [{ id, name, layout }], activeId }, layout, ui, version, dirty,
//                         canUndo, canRedo, undoLabel, redoLabel, lastCommit: { label, kind } }
//   store.subscribe(fn) -> unsubscribe              fn(state, info), called synchronously after every change
//   store.commit(label, mutator, { coalesce })      the only way to edit the layout (undoable)
//   store.undo() / redo() / replaceLayout() / setUi() / select() / clearSelection()
//   store.loadProject() / newProject() / addScenario() / switchScenario() / renameScenario() / deleteScenario() /
//         duplicateScenario() / renameProject()
//   store.persist() / restore() / hasBackup() / restoreBackup() / markClean() / destroy(),
//   store.lastPersistError, store.lastRestoreError, store.lastRestoreWarnings
//
// State objects (state, project, scenario entries, ui, selection, overlays) are frozen and replaced, never edited, and a
// part that did not change keeps its identity: a ui-only change leaves state.project and state.layout untouched, a layout
// commit leaves state.ui.overlays untouched. Layouts are immutable by contract (not frozen: that would cost milliseconds
// per commit); caches may key on `state.layout`, and also on its members, which keep their identity until an edit changes them.
//
// Notifications: info = { type, layoutChanged, kind, label? }. `type` is 'commit' | 'undo' | 'redo' | 'ui' | 'load' (the
// spec's five) plus 'scenario' (add / switch / rename / delete / duplicate), 'project' (renameProject, markClean) and
// 'persist' (autosave started or stopped failing, or it kept an older save as a backup: info.backedUp; the state is
// unchanged). `kind` is layoutChangeKind(previous layout, new layout) so the simulation runner knows whether to rebuild;
// it is 'none' when state.layout kept its identity. Listeners run in subscription order; an exception in one goes to
// onError and never stops the others. A change made from inside a listener is delivered to all listeners after the
// current round, in order, so nobody sees states out of order. When a chain of listener-made changes reaches
// NOTIFY_CHAIN_LIMIT notifications, every listener that answers with yet another change is unsubscribed and reported
// through onError (the others keep hearing everything), so a buggy panel cannot freeze the tab or bury the user's undo
// history under its own commits.
//
// Readings of the spec (also reported to the team):
//  * Drafts and history share structure. commit() hands the mutator a draft whose big members (roads, stations, ...) are
//    copied the first time the mutator reads or writes them; afterwards every member that was never opened, or ended up
//    equal to the original, is replaced by the ORIGINAL object. Layouts are immutable by contract, so consecutive layouts and
//    the history entries share everything an edit did not touch: a rename or slider commit on a 300 KB plant costs
//    about a millisecond and one undo step costs memory in proportion to the edit, not to the plant. The previous layout
//    object (never touched again) goes on the undo stack: 100 steps per scenario; a new commit clears redo.
//  * A commit is atomic: a mutator that returns false, changes nothing (deep-equal result), or throws leaves the store
//    untouched (a throw is re-thrown as it is). A result that breaks checkInvariants is rolled back and throws an Error
//    whose message names the label. The road part of that check is skipped when the roads, the grid size and the
//    rectangles of stations and obstacles are those of the (valid) layout before the edit.
//  * Everything that replaces or moves the document (commit, undo, redo, replaceLayout, loadProject, newProject,
//    restore, scenario changes) throws if it is called from inside a mutator: the outer commit would silently overwrite it.
//  * Coalescing: a commit whose `coalesce` key equals that of the previous commit, made at most 800 ms earlier (sliding
//    window, measured with options.now), joins that undo step and keeps its label. If the merged edits end up equal to
//    the layout before the burst, the step disappears (nothing to undo) and that earlier layout object becomes current again.
//    Adding, duplicating and switching scenarios end the burst of the scenario that is left.
//  * replaceLayout(layout, { label }) is undoable (an accidental "load example" can be taken back); loadProject, newProject
//    and restore start a new document with empty histories. Every kind of whole-layout replacement (including switching
//    scenarios) clears the selection; commit / undo / redo keep the ids that still exist.
//  * A 'cell' selection id is the road cell key "cx,cy" ([cx, cy] arrays are accepted and stored as keys); it exists while
//    that cell is a road. Unknown selection kinds select nothing.
//  * A 'vehicle' selection id is "<fleetId>#<n>", the id of the simulation's vehicle (docs/ENTITY-INSIGHTS-DESIGN.md 3.1); it exists while the fleet
//    exists and 1 <= n <= the fleet's count, so it survives a warm restart (the layout does not change) and an edit that keeps the vehicle. When an
//    edit (commit, undo, redo) removes the vehicle but not its fleet, the selection falls back to that fleet instead of being dropped.
//  * `detail` (default true: collect the statistics of clicked items, the optional collector js/sim/detail.js) and `statsDock` ('data' | 'always' |
//    'never': when a click opens the Statistics dock) are view preferences like `warmRestart`: saved with the session, not part of the plant.
//  * Scenarios: names are unique (case-insensitive; a clash gets a number: "B" -> "B 2"), at most MAX_SCENARIOS (the limit
//    of serialize.js). addScenario and duplicateScenario make the new scenario active and return its id (null at the limit).
//    Ids are never reused while a document lives ("sc4" after "sc3" was deleted), so caches keyed by scenario id (experiment
//    results, charts) cannot show the data of a deleted scenario for a new one.
//    Deleting the LAST scenario is refused (returns false, nothing changes): a project always has one, and destroying work
//    silently is worse than a button that does nothing (use newProject to start over).
//  * dirty: true after any change to project content, false after loadProject / newProject / markClean(). It is saved with
//    the autosave, so a restored session that had unsaved work still counts as dirty.
//  * Persistence writes exportProject(project) plus a "session" member { ui: { theme, overlays, rightTab, warmRestart, toolOptions, detail, statsDock }, dirty } under one
//    key, 400 ms (trailing) after the last change that matters but at the latest PERSIST_MAX_WAIT_MS after the first unsaved
//    change (continuous editing still saves); selection, tool and ephemeral flags are never saved. Call persist() on
//    pagehide to flush. Storage may be missing or throw (quota, privacy mode): the store keeps working and exposes the
//    failure as lastPersistError (null while saving works). restore() returns false for missing or corrupt data and leaves
//    the current state alone.
//  * Several tabs share one storage key. Before a save replaces text that this tab did not write or read itself (another
//    tab's project, the previous session's when restore() was not used, a save that restore() had to downgrade), that text
//    is copied to `${storageKey}:backup`; hasBackup() / restoreBackup() bring it back, and a restoreBackup() followed by the
//    next save swaps the two, so nothing is ever lost to a second tab. If the copy cannot be stored the save is refused
//    (lastPersistError) rather than destroying the other version.
//  * When the whole project no longer fits the storage quota the scenario on screen is saved alone (lastPersistError then
//    says so): losing the older variants is better than losing the work in progress. restore() keeps importProject's
//    warnings in lastRestoreWarnings.
//  * setUi merges `toolOptions` one level deep and `overlays` per flag; `theme`, `heat`, flags and `followSim` are validated
//    (bad values ignored); `selection` is cleaned against the layout; any other key is stored as given.
//  * toolOptions starts as { factor: 0.5, kind: 'wall', drawMode: 'smart' } (speed zone factor, obstacle kind, how the road, one-way, speed-zone and
//    eraser tools follow the pointer: 'smart' | 'straight' | 'free', see ui/editor/strokes.js; any other drawMode is ignored); rightTab as 'properties'.

import { createLayout, normalizeLayout, cloneLayout, layoutChangeKind, checkInvariants, cleanText, cleanId } from '../model/layout.js';
import { exportProject, importProject } from '../model/serialize.js';
import { nextId } from '../util/ids.js';

/** Undo steps kept per scenario. */
export const HISTORY_LIMIT = 100;
/** Commits with the same coalesce key at most this far apart (ms) form one undo step. */
export const COALESCE_MS = 800;
/** Autosave waits this long (ms) after the last change ... */
export const PERSIST_DEBOUNCE_MS = 400;
/** ... but never longer than this (ms) after the first change that is not saved yet. */
export const PERSIST_MAX_WAIT_MS = 5000;
/** Notifications in a row (the first plus those caused by listeners) after which the listener causing more is cut off. */
export const NOTIFY_CHAIN_LIMIT = 1000;
/** Scenarios per project (the limit of serialize.js, so a saved project always loads completely). */
export const MAX_SCENARIOS = 100;
/** Kinds a selection may have. A 'vehicle' id is "<fleetId>#<n>" (the id of the simulation's vehicle): it exists while the fleet does and 1 <= n <= its count. */
export const SELECTION_KINDS = Object.freeze(['station', 'flow', 'fleet', 'obstacle', 'label', 'cell', 'vehicle']);
/** When the statistics dock opens on a click (ui.statsDock): once the simulation has measured long enough, always, or never. */
export const STATS_DOCK_MODES = Object.freeze(['data', 'always', 'never']);

const NAME_MAX = 80;
const HEAT_MODES = ['off', 'traffic', 'waiting'];
const THEMES = ['auto', 'light', 'dark'];
const OVERLAY_FLAGS = ['grid', 'studs', 'flows', 'docks', 'jobs', 'ids', 'labels', 'routes'];
const PREF_KEYS = ['theme', 'overlays', 'rightTab', 'warmRestart', 'toolOptions', 'detail', 'statsDock'];
/** Draw modes of the stroke tools (the same list as ui/editor/strokes.js DRAW_MODES: the store may not import from ui/). */
const DRAW_MODES = ['smart', 'straight', 'free'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CELL_KEY_RE = /^\d+,\d+$/;
const SCENARIO_ID_RE = /^sc(\d+)$/;
const VEHICLE_ID_RE = /^([A-Za-z0-9_-]{1,32})#([1-9]\d{0,5})$/;

const frozen = Object.freeze;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NO_SELECTION = frozen({ kind: null, ids: frozen([]) });
const NO_COMMIT = frozen({ label: '', kind: 'none' });
const NO_ROADS = frozen({});

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const defaultOnError = (err) => {
  if (typeof console !== 'undefined') console.error(err);
};

/** The browser's localStorage, or undefined where it is missing or access is denied (sandboxed frames, blocked cookies). */
function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Structural equality for the small JSON-like values of the ui state. */
function same(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

// ---------------------------------------------------------------------------------------------------------
// ui state
// ---------------------------------------------------------------------------------------------------------

function defaultUi() {
  return frozen({
    tool: 'select',
    toolOptions: frozen({ factor: 0.5, kind: 'wall', drawMode: 'smart' }),
    selection: NO_SELECTION,
    overlays: frozen({ grid: true, studs: true, flows: true, docks: false, jobs: true, heat: 'off', ids: false, labels: true, routes: true }),
    rightTab: 'properties',
    theme: 'auto',
    followSim: false,
    warmRestart: true,
    detail: true, // collect the statistics of clicked items (Simulate tab): the optional collector of the simulation, js/sim/detail.js
    statsDock: 'data', // when a click opens the Statistics dock: 'data' (the simulation has measured), 'always' or 'never'
  });
}

/** Canonical form of a 'cell' selection id ("cx,cy"), or null. */
function cellId(id) {
  if (typeof id === 'string') return CELL_KEY_RE.test(id) ? id : null;
  return Array.isArray(id) && id.length === 2 && id.every(Number.isInteger) ? `${id[0]},${id[1]}` : null;
}

/** Does the selectable thing exist in the layout? */
function existenceTest(kind, layout) {
  if (kind === 'cell') return (key) => Object.hasOwn(layout.roads, key);
  if (kind === 'vehicle') {
    const counts = new Map(layout.fleets.map((f) => [f.id, f.count]));
    return (id) => {
      const m = typeof id === 'string' ? VEHICLE_ID_RE.exec(id) : null;
      return m !== null && counts.has(m[1]) && Number(m[2]) <= counts.get(m[1]);
    };
  }
  const list = { station: layout.stations, flow: layout.flows, fleet: layout.fleets, obstacle: layout.obstacles, label: layout.labels }[kind];
  const ids = new Set(list.map((item) => item.id));
  return (id) => ids.has(id);
}

/**
 * A selection reduced to what exists in `layout`: valid kind, unique ids, nothing selected when nothing is left. With `pruning` (an edit
 * of the plant, not a new choice), vehicles that no longer exist fall back to their fleets when those still exist: a fleet cut to fewer
 * vehicles keeps the planner on the item instead of dropping the selection (the shell says so in a toast).
 */
function cleanSelection(selection, layout, pruning = false) {
  const kind = isObj(selection) && SELECTION_KINDS.includes(selection.kind) ? selection.kind : null;
  if (!kind) return NO_SELECTION;
  const raw = Array.isArray(selection.ids) ? selection.ids : (selection.ids == null ? [] : [selection.ids]);
  const exists = existenceTest(kind, layout);
  const ids = [];
  const seen = new Set();
  for (const candidate of raw) {
    const id = kind === 'cell' ? cellId(candidate) : candidate;
    if (id === null || seen.has(id) || !exists(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length) return frozen({ kind, ids: frozen(ids) });
  if (kind === 'vehicle' && pruning) {
    const fleets = new Set(layout.fleets.map((f) => f.id));
    const back = [...new Set(raw.map((id) => (typeof id === 'string' ? VEHICLE_ID_RE.exec(id) : null)).filter((m) => m !== null && fleets.has(m[1])).map((m) => m[1]))];
    if (back.length) return frozen({ kind: 'fleet', ids: frozen(back) });
  }
  return NO_SELECTION;
}

function mergeOverlays(current, patch) {
  const next = { ...current };
  for (const flag of OVERLAY_FLAGS) if (typeof patch[flag] === 'boolean') next[flag] = patch[flag];
  if (HEAT_MODES.includes(patch.heat)) next.heat = patch.heat;
  return frozen(next);
}

/** `current` with `patch` applied; the very same object when nothing changed. Untouched parts keep their identity. */
function mergeUi(current, patch, layout) {
  let next = current;
  const set = (key, value) => {
    if (same(current[key], value)) return;
    if (next === current) next = { ...current };
    if (value === undefined) delete next[key];
    else next[key] = value;
  };
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    switch (key) {
      case 'tool':
      case 'rightTab':
        if (typeof value === 'string' && value) set(key, value);
        break;
      case 'theme':
        if (THEMES.includes(value)) set(key, value);
        break;
      case 'followSim':
      case 'warmRestart':
      case 'detail':
        if (typeof value === 'boolean') set(key, value);
        break;
      case 'statsDock':
        if (STATS_DOCK_MODES.includes(value)) set(key, value);
        break;
      case 'toolOptions':
        if (isObj(value)) {
          const options = { ...current.toolOptions, ...value };
          if (!DRAW_MODES.includes(options.drawMode)) options.drawMode = current.toolOptions.drawMode;
          set(key, frozen(options));
        }
        break;
      case 'overlays':
        if (isObj(value)) set(key, mergeOverlays(current.overlays, value));
        break;
      case 'selection':
        set(key, cleanSelection(value, layout, value === current.selection)); // the very same object: the plan was edited under the selection (publish 'prune')
        break;
      default:
        set(key, value);
    }
  }
  return next === current ? current : frozen(next);
}

// ---------------------------------------------------------------------------------------------------------
// drafts: what a mutator edits
// ---------------------------------------------------------------------------------------------------------

/** Make `key` of `draft` a plain data property holding `value`. Returns the value. */
function setOwn(draft, key, value) {
  Object.defineProperty(draft, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

/**
 * The working copy of `base` that a mutator edits. It has the members of `base`, but every object-valued one (roads,
 * stations, ...) is a getter that deep-copies the member the first time the mutator reads it, and a setter for
 * replacing it; afterwards it is an ordinary property. A mutator that only renames the plant never pays for the roads.
 */
function openDraft(base) {
  const draft = {};
  for (const key of Object.keys(base)) {
    const value = base[key];
    if (value === null || typeof value !== 'object') {
      draft[key] = value;
      continue;
    }
    Object.defineProperty(draft, key, {
      enumerable: true,
      configurable: true,
      get: () => setOwn(draft, key, structuredClone(value)),
      set: (next) => { setOwn(draft, key, next); },
    });
  }
  return draft;
}

/**
 * Finish a draft in place: members the mutator never opened, and members it opened but left equal, become the very objects
 * of `base` again (layouts are immutable, so consecutive layouts can share them). Returns the draft, now a plain object.
 */
function closeDraft(draft, base) {
  for (const key of Object.keys(draft)) {
    const { get, value } = Object.getOwnPropertyDescriptor(draft, key);
    const original = Object.hasOwn(base, key) ? base[key] : undefined;
    const untouched = Boolean(get) || (value !== original && same(value, original));
    setOwn(draft, key, untouched ? original : value);
  }
  return draft;
}

const sameRect = (p, q) => isObj(p) && isObj(q) && p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h;
const sameRects = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((r, i) => sameRect(r, b[i])));

/**
 * Do the road checks of checkInvariants have nothing new to find? They depend on the roads, the grid size and the rectangles
 * of stations and obstacles only, and `before` is a valid layout (everything the store holds is).
 */
function roadsStillValid(before, draft) {
  return draft.roads === before.roads && isObj(draft.grid) && draft.grid.cols === before.grid.cols && draft.grid.rows === before.grid.rows
    && sameRects(draft.stations, before.stations) && sameRects(draft.obstacles, before.obstacles);
}

// ---------------------------------------------------------------------------------------------------------
// projects and scenarios
// ---------------------------------------------------------------------------------------------------------

/** `wanted`, or `wanted` with a number appended / incremented, so that it is not in `taken` (lower-case names). */
function uniqueName(wanted, taken) {
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const m = /^(.*\S)\s+(\d+)$/.exec(wanted);
  const base = m ? m[1] : wanted;
  for (let n = m ? Number(m[2]) + 1 : 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = cleanText(base.slice(0, NAME_MAX - suffix.length) + suffix, NAME_MAX);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** First of A, B, ... Z, S27, S28, ... that is not taken. */
function letterName(taken) {
  for (let i = 0; ; i++) {
    const name = i < 26 ? String.fromCharCode(65 + i) : `S${i + 1}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

const namesOf = (scenarios, exceptId) => new Set(scenarios.filter((s) => s.id !== exceptId).map((s) => s.name.toLowerCase()));
const scenarioEntry = (id, name, layout) => frozen({ id, name, layout });

/**
 * A project as the store keeps it, from anything project-shaped: layouts normalized, ids valid and unique, names clean and
 * unique, at most MAX_SCENARIOS, activeId one of the ids. Entries without a layout are skipped. Throws if nothing is left.
 */
function sanitizeProject(raw) {
  if (!isObj(raw) || !Array.isArray(raw.scenarios)) throw new Error('A project needs a list of scenarios.');
  const scenarios = [];
  const ids = new Set();
  const names = new Set();
  for (const src of raw.scenarios.slice(0, MAX_SCENARIOS)) {
    if (!isObj(src) || !isObj(src.layout)) continue;
    let id = cleanId(src.id);
    if (!id || ids.has(id)) id = nextId('sc', ids);
    ids.add(id);
    const clean = cleanText(src.name, NAME_MAX, '');
    const name = clean ? uniqueName(clean, names) : letterName(names);
    names.add(name.toLowerCase());
    scenarios.push(scenarioEntry(id, name, normalizeLayout(src.layout)));
  }
  if (!scenarios.length) throw new Error('A project needs at least one scenario with a layout.');
  const active = scenarios.find((s) => s.id === raw.activeId) || scenarios[0];
  return { name: cleanText(raw.name, NAME_MAX, scenarios[0].layout.name), scenarios: frozen(scenarios), activeId: active.id };
}

/** The "session" member written next to the project export (see the header). */
function readSession(text) {
  try {
    const session = JSON.parse(text).session;
    return isObj(session) ? session : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------------------

/**
 * Create a store holding one empty project (scenario "A"). Nothing is read from storage until restore() is called.
 * @param {{ storageKey?: string, storage?: object, now?: () => number, setTimeout?: Function, clearTimeout?: Function,
 *   onError?: (err: unknown, context: object) => void }} [options]
 *   `storage` is localStorage-like (getItem / setItem); pass undefined for none. Default: the browser's localStorage if usable.
 * @returns {object} the store (all methods work detached from the object)
 */
export function createStore(options = {}) {
  const storageKey = options.storageKey ?? 'logiplan:v1';
  const rawStorage = Object.hasOwn(options, 'storage') ? options.storage : defaultStorage();
  const storage = rawStorage && typeof rawStorage.getItem === 'function' && typeof rawStorage.setItem === 'function' ? rawStorage : null;
  const now = options.now ?? defaultNow;
  const onError = options.onError ?? defaultOnError;
  const setTimer = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const backupKey = `${storageKey}:backup`;

  let projectName;
  let scenarios;
  let activeId;
  let ui = defaultUi();
  let dirty = false;
  let version = 0;
  let lastCommit = NO_COMMIT;
  let project;
  let state;
  // scenario id -> { undo: [{ label, layout }], redo: [...], mark: { key, at, entry } | null }. Only the active scenario can hold a
  // live coalescing mark: whatever makes another scenario active (switch, add, duplicate) clears the mark of the one it leaves.
  let histories = new Map();
  let persistTimer = null;
  let unsavedSince = null; // time of the first change the autosave has not written yet
  let lastSeen = null; // the saved text this tab loaded or wrote itself: replacing it loses nothing (null: none yet)
  let lastPersistError = storage ? null : new Error('No browser storage is available, so changes are not saved automatically.');
  let lastRestoreError = null;
  let lastRestoreWarnings = frozen([]);
  let scenarioSeq = 0; // numeric part of the newest scenario id
  let editing = false; // a mutator is running
  const listeners = new Set(); // of { fn }: one entry per subscription, so the same function may subscribe twice
  const queue = [];
  let delivering = false;
  let chain = 0; // notifications queued by listeners during the current delivery
  let running = null; // the listener entry being called

  const activeScenario = () => scenarios.find((s) => s.id === activeId);
  const activeLayout = () => activeScenario().layout;
  const historyOf = (id) => {
    if (!histories.has(id)) histories.set(id, { undo: [], redo: [], mark: null });
    return histories.get(id);
  };
  const history = () => historyOf(activeId);
  const top = (list) => (list.length ? list[list.length - 1] : null);

  // ---- notification ----

  function reportError(err, context) {
    try {
      onError(err, context);
    } catch {
      // a failing error sink must not break the store
    }
  }

  /** Unsubscribe a listener that keeps answering notifications with new changes (see NOTIFY_CHAIN_LIMIT). */
  function cutOff(entry) {
    if (!listeners.delete(entry)) return;
    reportError(new Error(`A store listener kept answering notifications by changing the store again (${NOTIFY_CHAIN_LIMIT} in a row), so it was unsubscribed.`), { listener: entry.fn });
  }

  function notify(snapshot, info) {
    queue.push([snapshot, info]);
    if (delivering) {
      chain += 1;
      if (chain >= NOTIFY_CHAIN_LIMIT && running) cutOff(running);
      return;
    }
    delivering = true;
    chain = 0;
    try {
      while (queue.length) {
        const [s, i] = queue.shift();
        for (const entry of [...listeners]) {
          if (!listeners.has(entry)) continue;
          running = entry;
          try {
            entry.fn(s, i);
          } catch (err) {
            reportError(err, { listener: entry.fn, info: i });
          }
        }
        running = null;
      }
    } finally {
      delivering = false;
      running = null;
    }
  }

  // ---- state assembly ----

  function buildState() {
    if (!project || project.scenarios !== scenarios || project.name !== projectName || project.activeId !== activeId) {
      project = frozen({ name: projectName, scenarios, activeId });
    }
    const hist = history();
    version += 1;
    return frozen({
      project,
      layout: activeLayout(),
      ui,
      version,
      dirty,
      canUndo: hist.undo.length > 0,
      canRedo: hist.redo.length > 0,
      undoLabel: hist.undo.length ? top(hist.undo).label : null,
      redoLabel: hist.redo.length ? top(hist.redo).label : null,
      lastCommit,
    });
  }

  /**
   * Make the working variables the new state and tell the listeners.
   * meta.selection 'clear' | 'prune'; meta.kind the already computed change kind; meta.label of an edit;
   * meta.persist false when the change is not worth an autosave.
   */
  function publish(type, meta = {}) {
    const prev = state;
    const layout = activeLayout();
    const layoutChanged = layout !== prev.layout;
    if (meta.selection === 'clear') ui = mergeUi(ui, { selection: NO_SELECTION }, layout);
    else if (meta.selection === 'prune' && layoutChanged) ui = mergeUi(ui, { selection: ui.selection }, layout);
    const kind = meta.kind ?? (layoutChanged ? layoutChangeKind(prev.layout, layout) : 'none');
    if (type === 'commit' || type === 'undo' || type === 'redo') lastCommit = frozen({ label: meta.label, kind });
    else if (type === 'load' || (type === 'scenario' && layoutChanged)) lastCommit = NO_COMMIT;
    state = buildState();
    if (meta.persist !== false) schedulePersist();
    const info = { type, layoutChanged, kind };
    if (meta.label !== undefined) info.label = meta.label;
    notify(state, info);
  }

  function setActiveLayout(layout) {
    scenarios = frozen(scenarios.map((s) => (s.id === activeId ? scenarioEntry(s.id, s.name, layout) : s)));
  }

  /** Install a sanitized project as a new document: empty histories, clean, nothing selected. */
  function install(next, { dirtyFlag = false } = {}) {
    projectName = next.name;
    scenarios = next.scenarios;
    activeId = next.activeId;
    histories = new Map();
    dirty = dirtyFlag;
    scenarioSeq = next.scenarios.reduce((newest, sc) => {
      const m = SCENARIO_ID_RE.exec(sc.id);
      return m ? Math.max(newest, Number(m[1])) : newest;
    }, 0);
  }

  // ---- persistence ----

  /** The text that is saved: the project export plus the "session" member (see the header). */
  function sessionText(source) {
    const prefs = {};
    for (const key of PREF_KEYS) prefs[key] = ui[key];
    return `${exportProject(source).slice(0, -1)},"session":${JSON.stringify({ ui: prefs, dirty })}}`;
  }

  function cancelAutosave() {
    if (persistTimer !== null) clearTimer(persistTimer);
    persistTimer = null;
    unsavedSince = null;
  }

  /** (Re)start the autosave timer: 400 ms after the last change, but no later than PERSIST_MAX_WAIT_MS after the first one. */
  function schedulePersist() {
    if (!storage) return;
    const t = now();
    if (unsavedSince === null) unsavedSince = t;
    if (persistTimer !== null) clearTimer(persistTimer);
    const wait = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, unsavedSince + PERSIST_MAX_WAIT_MS - t));
    persistTimer = setTimer(() => {
      persistTimer = null;
      persist();
    }, wait);
  }

  /**
   * Before a save replaces text this tab did not write or read itself, keep that text under the backup key.
   * Returns true if a copy was made; throws if the copy cannot be stored (the save must then not go ahead).
   */
  function keepForeignSave() {
    let stored;
    try {
      stored = storage.getItem(storageKey);
    } catch {
      return false; // unreadable: nothing to protect that we could see
    }
    if (typeof stored !== 'string' || stored === '' || stored === lastSeen) return false;
    try {
      storage.setItem(backupKey, stored);
    } catch (err) {
      throw new Error('Another browser tab (or an earlier session) saved a different version of this project and there is no room to keep a copy of it, so this tab did not overwrite it. Export your project to a file.', { cause: err });
    }
    return true;
  }

  /**
   * Write the session. If the whole project does not fit, write the scenario on screen alone and return the error to report;
   * return null when everything was written. Throws if nothing could be written.
   */
  function writeSession() {
    const text = sessionText(project);
    try {
      storage.setItem(storageKey, text);
      lastSeen = text;
      return null;
    } catch (err) {
      if (scenarios.length === 1) throw err;
      const smaller = sessionText({ name: projectName, scenarios: [activeScenario()], activeId });
      try {
        storage.setItem(storageKey, smaller);
      } catch {
        throw err;
      }
      lastSeen = smaller;
      return new Error('The whole project is too big for the browser storage, so only the scenario on screen was saved. Export the project to a file to keep the others.', { cause: err });
    }
  }

  /**
   * Save now (cancels the pending autosave). True if something was written; false without storage or when saving failed (see
   * lastPersistError, which is also set when only the scenario on screen fitted).
   */
  function persist() {
    cancelAutosave();
    if (!storage) return false;
    let saved = false;
    let failure = null;
    let backedUp = false;
    try {
      backedUp = keepForeignSave();
      failure = writeSession();
      saved = true;
    } catch (err) {
      failure = err || new Error('Saving failed.');
    }
    const flipped = (failure === null) !== (lastPersistError === null);
    lastPersistError = failure;
    if (flipped || backedUp) {
      notify(state, { type: 'persist', layoutChanged: false, kind: 'none', ...(backedUp ? { backedUp } : {}) });
    }
    return saved;
  }

  /** Load the session stored under `key`. True if loaded; false (state untouched) when nothing usable is stored there. */
  function load(key) {
    lastRestoreError = null;
    lastRestoreWarnings = frozen([]);
    if (!storage) return false;
    try {
      const text = storage.getItem(key);
      if (typeof text !== 'string' || text === '') return false;
      const imported = importProject(text);
      const restored = sanitizeProject(imported);
      const session = readSession(text);
      cancelAutosave();
      install(restored, { dirtyFlag: session.dirty === true });
      const prefs = {};
      if (isObj(session.ui)) for (const pref of PREF_KEYS) if (session.ui[pref] !== undefined) prefs[pref] = session.ui[pref];
      ui = mergeUi(ui, prefs, activeLayout());
      lastRestoreWarnings = frozen(imported.warnings ?? []);
      // a text that was only partly understood must not be overwritten unseen: the next save keeps it as a backup
      lastSeen = lastRestoreWarnings.length ? null : text;
      publish('load', { selection: 'clear', persist: false });
      return true;
    } catch (err) {
      lastRestoreError = err;
      return false;
    }
  }

  /** Is there a saved copy of an older or other-tab version of the project to bring back with restoreBackup()? */
  function hasBackup() {
    if (!storage) return false;
    try {
      const text = storage.getItem(backupKey);
      return typeof text === 'string' && text !== '';
    } catch {
      return false;
    }
  }

  // ---- layout edits ----

  /**
   * Edit the layout as one undoable step: `mutator(draft)` gets a private copy (copied lazily, see openDraft) and must not keep
   * it. Returns true if the layout changed; false if the mutator returned false or left everything as it was. Throws (state
   * untouched) if the mutator throws or its result breaks the model invariants.
   * @param {string} label shown in the undo tooltip ("Move station")
   * @param {(draft: object) => (void|false)} mutator
   * @param {{ coalesce?: string }} [opts] edits with the same key within COALESCE_MS share one undo step
   */
  function commit(label, mutator, opts) {
    if (typeof mutator !== 'function') throw new TypeError('store.commit(label, mutator): the mutator must be a function');
    const name = cleanText(label, NAME_MAX, 'Edit');
    const before = activeLayout();
    const draft = openDraft(before);
    let result;
    editing = true;
    try {
      result = mutator(draft);
    } finally {
      editing = false;
    }
    if (result === false) return false;
    closeDraft(draft, before);
    const kind = layoutChangeKind(before, draft);
    if (kind === 'none') return false;
    const problems = checkInvariants(roadsStillValid(before, draft) ? { ...draft, roads: NO_ROADS } : draft);
    if (problems.length) {
      const shown = problems.slice(0, 3).join('; ');
      throw new Error(`Edit "${name}" was rolled back because it left the layout invalid: ${shown}${problems.length > 3 ? '; ...' : ''}`);
    }
    const hist = history();
    const key = opts && typeof opts.coalesce === 'string' && opts.coalesce ? opts.coalesce : null;
    const t = now();
    const mark = hist.mark;
    let next = draft;
    if (key && mark && mark.key === key && t - mark.at <= COALESCE_MS && top(hist.undo) === mark.entry) {
      mark.at = t;
      if (layoutChangeKind(mark.entry.layout, draft) === 'none') {
        hist.undo.pop();
        hist.mark = null;
        next = mark.entry.layout;
      }
    } else {
      const entry = { label: name, layout: before };
      hist.undo.push(entry);
      if (hist.undo.length > HISTORY_LIMIT) hist.undo.shift();
      hist.mark = key ? { key, at: t, entry } : null;
    }
    hist.redo = [];
    setActiveLayout(next);
    dirty = true;
    publish('commit', { label: name, kind, selection: 'prune' });
    return true;
  }

  /** Undo / redo one step: `from` is the stack to pop, `to` the stack that receives the layout being left. False if empty. */
  function travel(type, from, to) {
    const hist = history();
    const entry = hist[from].pop();
    if (!entry) return false;
    hist[to].push({ label: entry.label, layout: activeLayout() });
    if (to === 'undo' && hist.undo.length > HISTORY_LIMIT) hist.undo.shift();
    hist.mark = null;
    setActiveLayout(entry.layout);
    dirty = true;
    publish(type, { label: entry.label, selection: 'prune' });
    return true;
  }

  /** Swap the active scenario's layout for `layout` (normalized) as one undoable step. False if it equals the current one. */
  function replaceLayout(layout, opts) {
    const next = normalizeLayout(layout);
    const before = activeLayout();
    const kind = layoutChangeKind(before, next);
    if (kind === 'none') return false;
    const name = cleanText(opts && opts.label, NAME_MAX, 'Replace layout');
    const hist = history();
    hist.undo.push({ label: name, layout: before });
    if (hist.undo.length > HISTORY_LIMIT) hist.undo.shift();
    hist.redo = [];
    hist.mark = null;
    setActiveLayout(next);
    dirty = true;
    publish('commit', { label: name, kind, selection: 'clear' });
    return true;
  }

  // ---- ui ----

  /** Merge a ui patch (see the header). True if anything changed; unchanged patches notify nobody. */
  function setUi(patch) {
    if (!isObj(patch)) return false;
    const next = mergeUi(ui, patch, activeLayout());
    if (next === ui) return false;
    const prefsChanged = PREF_KEYS.some((key) => next[key] !== ui[key]);
    ui = next;
    publish('ui', { persist: prefsChanged });
    return true;
  }

  // ---- projects ----

  /** Replace everything with `raw` (a project as importProject returns it). Throws if it holds no usable scenario. */
  function loadProject(raw) {
    install(sanitizeProject(raw));
    publish('load', { selection: 'clear' });
    return true;
  }

  /** Start over with one scenario "A" holding `layout` (normalized; default: an empty plant). */
  function newProject(layout, name) {
    const first = layout == null ? createLayout() : normalizeLayout(layout);
    install({ name: cleanText(name, NAME_MAX, first.name), scenarios: frozen([scenarioEntry('sc1', 'A', first)]), activeId: 'sc1' });
    publish('load', { selection: 'clear' });
    return true;
  }

  /** Rename the project (not undoable). False for an empty or unchanged name. */
  function renameProject(name) {
    const clean = cleanText(name, NAME_MAX, '');
    if (!clean || clean === projectName) return false;
    projectName = clean;
    dirty = true;
    publish('project');
    return true;
  }

  /** Call after the project has been exported or shared: clears the dirty flag. */
  function markClean() {
    if (!dirty) return false;
    dirty = false;
    publish('project');
    return true;
  }

  // ---- scenarios ----

  /** Append a scenario with `layout`, make it active. Returns its id, or null at MAX_SCENARIOS. */
  function appendScenario(wanted, layout) {
    if (scenarios.length >= MAX_SCENARIOS) return null;
    const taken = namesOf(scenarios);
    const clean = cleanText(wanted, NAME_MAX, '');
    const name = clean ? uniqueName(clean, taken) : letterName(taken);
    let id;
    do id = `sc${++scenarioSeq}`; while (scenarios.some((s) => s.id === id));
    history().mark = null;
    scenarios = frozen([...scenarios, scenarioEntry(id, name, layout)]);
    activeId = id;
    dirty = true;
    publish('scenario', { selection: 'clear' });
    return id;
  }

  /** Add a scenario (a copy of the current layout unless `layout` is given) and make it active. Returns its id or null. */
  const addScenario = (name, layout = null) => appendScenario(name, layout == null ? cloneLayout(activeLayout()) : normalizeLayout(layout));

  /** Copy scenario `id` ("B" -> "B copy") and make the copy active. Returns the new id or null. */
  function duplicateScenario(id) {
    const source = scenarios.find((s) => s.id === id);
    return source ? appendScenario(`${source.name} copy`, cloneLayout(source.layout)) : null;
  }

  /** Make scenario `id` active (each keeps its own undo history). False if unknown or already active. */
  function switchScenario(id) {
    if (id === activeId || !scenarios.some((s) => s.id === id)) return false;
    history().mark = null;
    activeId = id;
    publish('scenario', { selection: 'clear' });
    return true;
  }

  /** Rename a scenario; a name another scenario uses gets a number. False if unknown, empty or unchanged. */
  function renameScenario(id, name) {
    const clean = cleanText(name, NAME_MAX, '');
    const target = scenarios.find((s) => s.id === id);
    if (!target || !clean) return false;
    const finalName = uniqueName(clean, namesOf(scenarios, id));
    if (finalName === target.name) return false;
    scenarios = frozen(scenarios.map((s) => (s.id === id ? scenarioEntry(s.id, finalName, s.layout) : s)));
    dirty = true;
    publish('scenario');
    return true;
  }

  /** Delete a scenario and its history. The active one is replaced by its left neighbour. Refuses the last one (false). */
  function deleteScenario(id) {
    const index = scenarios.findIndex((s) => s.id === id);
    if (index < 0 || scenarios.length === 1) return false;
    const wasActive = id === activeId;
    scenarios = frozen(scenarios.filter((s) => s.id !== id));
    histories.delete(id);
    if (wasActive) activeId = (scenarios[index - 1] || scenarios[index]).id;
    dirty = true;
    publish('scenario', wasActive ? { selection: 'clear' } : {});
    return true;
  }

  // ---- public object ----

  /** `fn`, but refused (with an Error) while a mutator runs: the commit in progress would silently overwrite its effect. */
  const outsideMutators = (name, fn) => (...args) => {
    if (editing) throw new Error(`store.${name}() cannot be called from inside a commit mutator: the mutator may only edit the draft it is given.`);
    return fn(...args);
  };

  install(sanitizeProject({ scenarios: [{ id: 'sc1', name: 'A', layout: createLayout() }] }));
  state = buildState();

  return {
    getState: () => state,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('store.subscribe(fn): fn must be a function');
      const entry = { fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    commit: outsideMutators('commit', commit),
    undo: outsideMutators('undo', () => travel('undo', 'undo', 'redo')),
    redo: outsideMutators('redo', () => travel('redo', 'redo', 'undo')),
    replaceLayout: outsideMutators('replaceLayout', replaceLayout),
    setUi,
    select: (kind, ids) => setUi({ selection: { kind, ids } }),
    clearSelection: () => setUi({ selection: NO_SELECTION }),
    loadProject: outsideMutators('loadProject', loadProject),
    newProject: outsideMutators('newProject', newProject),
    renameProject,
    addScenario: outsideMutators('addScenario', addScenario),
    switchScenario: outsideMutators('switchScenario', switchScenario),
    renameScenario,
    deleteScenario: outsideMutators('deleteScenario', deleteScenario),
    duplicateScenario: outsideMutators('duplicateScenario', duplicateScenario),
    persist,
    restore: outsideMutators('restore', () => load(storageKey)),
    hasBackup,
    restoreBackup: outsideMutators('restoreBackup', () => load(backupKey)),
    markClean,
    /** Save pending changes, stop the autosave timer and drop all listeners. */
    destroy() {
      if (persistTimer !== null) persist();
      listeners.clear();
    },
    get lastPersistError() {
      return lastPersistError;
    },
    get lastRestoreError() {
      return lastRestoreError;
    },
    get lastRestoreWarnings() {
      return lastRestoreWarnings;
    },
  };
}
