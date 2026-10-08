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
//   store.persist() / restore() / markClean() / destroy(),  store.lastPersistError, store.lastRestoreError
//
// State objects (state, project, scenario entries, ui, selection, overlays) are frozen and replaced, never edited, and a
// part that did not change keeps its identity: a ui-only change leaves state.project and state.layout untouched, a layout
// commit leaves state.ui.overlays untouched. Layouts are immutable by contract (not frozen: that would cost milliseconds
// per commit); caches may key on `state.layout`.
//
// Notifications: info = { type, layoutChanged, kind, label? }. `type` is 'commit' | 'undo' | 'redo' | 'ui' | 'load' (the
// spec's five) plus 'scenario' (add / switch / rename / delete / duplicate), 'project' (renameProject, markClean) and
// 'persist' (autosave started or stopped failing; the state is unchanged). `kind` is layoutChangeKind(previous layout,
// new layout) so the simulation runner knows whether to rebuild; it is 'none' when state.layout kept its identity.
// Listeners run in subscription order; an exception in one goes to onError and never stops the others. A change made
// from inside a listener is delivered to all listeners after the current round, in order, so nobody sees states out of order.
//
// Readings of the spec (also reported to the team):
//  * History keeps references, not copies: commit() clones the layout once into a draft, the mutator edits the draft and
//    the previous layout object (never touched again) goes on the undo stack. 100 steps per scenario; a new commit clears redo.
//  * A commit is atomic: a mutator that returns false, changes nothing (deep-equal result), or throws leaves the store
//    untouched (a throw is re-thrown as it is). A result that breaks checkInvariants is rolled back and throws an Error
//    whose message names the label.
//  * Coalescing: a commit whose `coalesce` key equals that of the previous commit, made at most 800 ms earlier (sliding
//    window, measured with options.now), joins that undo step and keeps its label. If the merged edits end up equal to
//    the layout before the burst, the step disappears (nothing to undo) and that earlier layout object becomes current again.
//  * replaceLayout(layout, { label }) is undoable (an accidental "load example" can be taken back); loadProject, newProject
//    and restore start a new document with empty histories. Every kind of whole-layout replacement (including switching
//    scenarios) clears the selection; commit / undo / redo keep the ids that still exist.
//  * A 'cell' selection id is the road cell key "cx,cy" ([cx, cy] arrays are accepted and stored as keys); it exists while
//    that cell is a road. Unknown selection kinds select nothing.
//  * Scenarios: names are unique (case-insensitive; a clash gets a number: "B" -> "B 2"), at most MAX_SCENARIOS (the limit
//    of serialize.js). addScenario and duplicateScenario make the new scenario active and return its id (null at the limit).
//    Deleting the LAST scenario is refused (returns false, nothing changes): a project always has one, and destroying work
//    silently is worse than a button that does nothing (use newProject to start over).
//  * dirty: true after any change to project content, false after loadProject / newProject / markClean(). It is saved with
//    the autosave, so a restored session that had unsaved work still counts as dirty.
//  * Persistence writes exportProject(project) plus a "session" member { ui: { theme, overlays, rightTab }, dirty } under one
//    key, 400 ms (trailing) after the last change that matters; selection, tool and ephemeral flags are never saved. Call
//    persist() on pagehide to flush. Storage may be missing or throw (quota, privacy mode): the store keeps working and
//    exposes the failure as lastPersistError (null while saving works). restore() returns false for missing or corrupt data
//    and leaves the current state alone.
//  * setUi merges `toolOptions` one level deep and `overlays` per flag; `theme`, `heat`, flags and `followSim` are validated
//    (bad values ignored); `selection` is cleaned against the layout; any other key is stored as given.
//  * toolOptions starts as { factor: 0.5, kind: 'wall' } (speed zone factor, obstacle kind); rightTab as 'properties'.

import { createLayout, normalizeLayout, cloneLayout, layoutChangeKind, checkInvariants, cleanText, cleanId } from '../model/layout.js';
import { exportProject, importProject } from '../model/serialize.js';
import { nextId } from '../util/ids.js';

/** Undo steps kept per scenario. */
export const HISTORY_LIMIT = 100;
/** Commits with the same coalesce key at most this far apart (ms) form one undo step. */
export const COALESCE_MS = 800;
/** Autosave waits this long (ms) after the last change. */
export const PERSIST_DEBOUNCE_MS = 400;
/** Scenarios per project (the limit of serialize.js, so a saved project always loads completely). */
export const MAX_SCENARIOS = 100;
/** Kinds a selection may have. */
export const SELECTION_KINDS = Object.freeze(['station', 'flow', 'fleet', 'obstacle', 'label', 'cell']);

const NAME_MAX = 80;
const HEAT_MODES = ['off', 'traffic', 'waiting'];
const THEMES = ['auto', 'light', 'dark'];
const OVERLAY_FLAGS = ['grid', 'studs', 'flows', 'docks', 'ids', 'labels'];
const PREF_KEYS = ['theme', 'overlays', 'rightTab'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CELL_KEY_RE = /^\d+,\d+$/;

const frozen = Object.freeze;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NO_SELECTION = frozen({ kind: null, ids: frozen([]) });
const NO_COMMIT = frozen({ label: '', kind: 'none' });

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
    toolOptions: frozen({ factor: 0.5, kind: 'wall' }),
    selection: NO_SELECTION,
    overlays: frozen({ grid: true, studs: true, flows: true, docks: false, heat: 'off', ids: false, labels: true }),
    rightTab: 'properties',
    theme: 'auto',
    followSim: false,
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
  const list = { station: layout.stations, flow: layout.flows, fleet: layout.fleets, obstacle: layout.obstacles, label: layout.labels }[kind];
  const ids = new Set(list.map((item) => item.id));
  return (id) => ids.has(id);
}

/** A selection reduced to what exists in `layout`: valid kind, unique ids, nothing selected when nothing is left. */
function cleanSelection(selection, layout) {
  const kind = isObj(selection) && SELECTION_KINDS.includes(selection.kind) ? selection.kind : null;
  if (!kind) return NO_SELECTION;
  const raw = Array.isArray(selection.ids) ? selection.ids : (selection.ids == null ? [] : [selection.ids]);
  const exists = existenceTest(kind, layout);
  const ids = [];
  for (const candidate of raw) {
    const id = kind === 'cell' ? cellId(candidate) : candidate;
    if (id !== null && !ids.includes(id) && exists(id)) ids.push(id);
  }
  return ids.length ? frozen({ kind, ids: frozen(ids) }) : NO_SELECTION;
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
        if (typeof value === 'boolean') set(key, value);
        break;
      case 'toolOptions':
        if (isObj(value)) set(key, frozen({ ...current.toolOptions, ...value }));
        break;
      case 'overlays':
        if (isObj(value)) set(key, mergeOverlays(current.overlays, value));
        break;
      case 'selection':
        set(key, cleanSelection(value, layout));
        break;
      default:
        set(key, value);
    }
  }
  return next === current ? current : frozen(next);
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
  return { name: cleanText(raw.name, NAME_MAX, scenarios[0].layout.name), scenarios, activeId: active.id };
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

  let projectName;
  let scenarios;
  let activeId;
  let ui = defaultUi();
  let dirty = false;
  let version = 0;
  let lastCommit = NO_COMMIT;
  let project;
  let state;
  let histories = new Map(); // scenario id -> { undo: [{ label, layout }], redo: [...], mark: { key, at, entry } | null }
  let persistTimer = null;
  let lastPersistError = storage ? null : new Error('No browser storage is available, so changes are not saved automatically.');
  let lastRestoreError = null;
  const listeners = new Set();
  const queue = [];
  let delivering = false;

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

  function notify(snapshot, info) {
    queue.push([snapshot, info]);
    if (delivering) return;
    delivering = true;
    try {
      while (queue.length) {
        const [s, i] = queue.shift();
        for (const fn of [...listeners]) {
          if (!listeners.has(fn)) continue;
          try {
            fn(s, i);
          } catch (err) {
            reportError(err, { listener: fn, info: i });
          }
        }
      }
    } finally {
      delivering = false;
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
    scenarios = scenarios.map((s) => (s.id === activeId ? scenarioEntry(s.id, s.name, layout) : s));
  }

  /** Install a sanitized project as a new document: empty histories, clean, nothing selected. */
  function install(next, { dirtyFlag = false } = {}) {
    projectName = next.name;
    scenarios = next.scenarios;
    activeId = next.activeId;
    histories = new Map();
    dirty = dirtyFlag;
  }

  // ---- persistence ----

  function sessionText() {
    const prefs = {};
    for (const key of PREF_KEYS) prefs[key] = ui[key];
    return `${exportProject(project).slice(0, -1)},"session":${JSON.stringify({ ui: prefs, dirty })}}`;
  }

  function schedulePersist() {
    if (!storage) return;
    if (persistTimer !== null) clearTimer(persistTimer);
    persistTimer = setTimer(() => {
      persistTimer = null;
      persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Save now (cancels the pending autosave). True if written; false without storage or on failure (see lastPersistError). */
  function persist() {
    if (persistTimer !== null) {
      clearTimer(persistTimer);
      persistTimer = null;
    }
    if (!storage) return false;
    let failure = null;
    try {
      storage.setItem(storageKey, sessionText());
    } catch (err) {
      failure = err || new Error('Saving failed.');
    }
    const flipped = (failure === null) !== (lastPersistError === null);
    lastPersistError = failure;
    if (flipped) notify(state, { type: 'persist', layoutChanged: false, kind: 'none' });
    return failure === null;
  }

  /** Load the autosaved session. True if restored; false (state untouched) when nothing usable is stored. */
  function restore() {
    lastRestoreError = null;
    if (!storage) return false;
    try {
      const text = storage.getItem(storageKey);
      if (typeof text !== 'string' || text === '') return false;
      const restored = sanitizeProject(importProject(text));
      const session = readSession(text);
      if (persistTimer !== null) {
        clearTimer(persistTimer);
        persistTimer = null;
      }
      install(restored, { dirtyFlag: session.dirty === true });
      const prefs = {};
      if (isObj(session.ui)) for (const key of PREF_KEYS) if (session.ui[key] !== undefined) prefs[key] = session.ui[key];
      ui = mergeUi(ui, prefs, activeLayout());
      publish('load', { selection: 'clear', persist: false });
      return true;
    } catch (err) {
      lastRestoreError = err;
      return false;
    }
  }

  // ---- layout edits ----

  /**
   * Edit the layout as one undoable step: `mutator(draft)` gets a deep copy. Returns true if the layout changed; false if the
   * mutator returned false or left everything as it was. Throws (state untouched) if the mutator throws or its result breaks
   * the model invariants.
   * @param {string} label shown in the undo tooltip ("Move station")
   * @param {(draft: object) => (void|false)} mutator
   * @param {{ coalesce?: string }} [opts] edits with the same key within COALESCE_MS share one undo step
   */
  function commit(label, mutator, opts) {
    if (typeof mutator !== 'function') throw new TypeError('store.commit(label, mutator): the mutator must be a function');
    const name = cleanText(label, NAME_MAX, 'Edit');
    const before = activeLayout();
    const draft = cloneLayout(before);
    if (mutator(draft) === false) return false;
    const kind = layoutChangeKind(before, draft);
    if (kind === 'none') return false;
    const problems = checkInvariants(draft);
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
    install({ name: cleanText(name, NAME_MAX, first.name), scenarios: [scenarioEntry('sc1', 'A', first)], activeId: 'sc1' });
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
    const id = nextId('sc', scenarios.map((s) => s.id));
    scenarios = [...scenarios, scenarioEntry(id, name, layout)];
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
    scenarios = scenarios.map((s) => (s.id === id ? scenarioEntry(s.id, finalName, s.layout) : s));
    dirty = true;
    publish('scenario');
    return true;
  }

  /** Delete a scenario and its history. The active one is replaced by its left neighbour. Refuses the last one (false). */
  function deleteScenario(id) {
    const index = scenarios.findIndex((s) => s.id === id);
    if (index < 0 || scenarios.length === 1) return false;
    const wasActive = id === activeId;
    scenarios = scenarios.filter((s) => s.id !== id);
    histories.delete(id);
    if (wasActive) activeId = (scenarios[index - 1] || scenarios[index]).id;
    dirty = true;
    publish('scenario', wasActive ? { selection: 'clear' } : {});
    return true;
  }

  // ---- public object ----

  install(sanitizeProject({ scenarios: [{ id: 'sc1', name: 'A', layout: createLayout() }] }));
  state = buildState();

  return {
    getState: () => state,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('store.subscribe(fn): fn must be a function');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    commit,
    undo: () => travel('undo', 'undo', 'redo'),
    redo: () => travel('redo', 'redo', 'undo'),
    replaceLayout,
    setUi,
    select: (kind, ids) => setUi({ selection: { kind, ids } }),
    clearSelection: () => setUi({ selection: NO_SELECTION }),
    loadProject,
    newProject,
    renameProject,
    addScenario,
    switchScenario,
    renameScenario,
    deleteScenario,
    duplicateScenario,
    persist,
    restore,
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
  };
}
