// Simulation runner (docs/ARCHITECTURE.md 6.4): owns the live Simulation and the animation-frame loop that advances it,
// renders every frame and reports results to the UI.
//
//   const runner = createRunner({ store, renderer, raf, caf, now, document, SimulationClass, loadEngine, onError, speed });
//   runner.sim / .playing / .speed / .limited / .time          read-only state
//   runner.play() -> Promise<boolean>     runner.pause()     runner.toggle() -> Promise<boolean>
//   runner.step(seconds = 1) -> Promise<number>     runner.reset()     runner.setSpeed(x) -> number
//   runner.kpis() / runner.insights()     latest results (cached 250 ms), null while there is no simulation
//   runner.priming / runner.primeProgress / runner.warm     warm restart state (see below)
//   runner.baseline / runner.keepBaseline() / runner.dismissBaseline()     the "before" numbers of the change-impact card
//   runner.on(event, fn) -> off           'state' | 'frame' | 'kpis' | 'rebuild' | 'baseline' | 'priming' | 'error'
//   runner.destroy()
//
// The Simulation is created lazily by the first play() / step() from the store's current layout. Without an injected
// `SimulationClass` the engine module (js/sim/engine.js) is loaded on demand (an import() call) at that moment, so this file loads
// even where the engine does not exist; play() and step() are then asynchronous (they return promises either way, but with an
// injected class everything happens synchronously inside the call).
//
// Layout changes (watched through store.subscribe; the change is classified with layoutChangeKind against the layout the
// simulation was built from, so undoing an edit cancels its rebuild; the compare is cheap because the store's layouts share every
// member an edit did not touch and layoutChangeKind stops at identical objects): 'structural' => after 250 ms without further structural
// changes (counted in frames, so no timer is needed) a NEW simulation replaces the old one; the playing state is kept.
// 'runtime' (and every later non-structural state) => sim.setRuntime(RUNTIME_KEYS settings) at once.
// 'cosmetic' => nothing. play() and step() apply a pending rebuild first.
//
// WARM RESTART (store.ui.warmRestart, default on). A rebuild of a simulation that has already run (sim.time > 0) caused by an edit
// (commit, undo, redo) does not start from an empty plant: the new Simulation is PRE-ROLLED silently, in time slices of
// PRIME_SLICE_MS per animation frame (one slice, then the frame is drawn), up to primeSeconds(settings.warmup) of simulated time
// (warm-up + 10 min, between 10 and 40 min), and only then replaces the old one in a single step. While it is being primed the previous
// simulation stays on screen and stands still (runner.priming is true, runner.primeProgress runs 0..1), so no frame does more than
// one slice of work. A further edit during priming throws the half-primed simulation away and starts again from the newest layout
// (after the usual 250 ms). The pre-roll depends only on the layout and seed, never on how it was cut into slices (the engine steps
// whole ticks), so the result is deterministic. Reset, the first play() of a plant, switching variants and loading another plant
// stay COLD starts from an empty plant. Hidden tabs do not prime (frames stop there anyway); destroy() ends priming at once.
//
// The pre-roll is bounded in WALL-CLOCK time too (PRIME_MAX_MS per phase, counted from the frames that actually primed): a plant too
// big to be pre-rolled in that time swaps in with what is done (the 'rebuild' event says warmedUp: false) instead of freezing the
// displayed simulation for as long as it takes. runner.primeProgress shows how far the pre-roll has come.
//
// BASELINE (the "before" of the change-impact card). When a warm restart replaces a simulation whose measured window was at least
// BASELINE_MIN_SECONDS long, that run becomes the baseline together with the labels of the edits since; later warm restarts keep
// that ORIGINAL baseline and only add labels, until keepBaseline() (the plant as it is now) or dismissBaseline() (drop it).
// runner.baseline is a plain, replaced-never-mutated object or null; it is cleared by every cold start:
//   { report, simTime, labels, edits,    the old run's last KpiReport (its long, cumulative window) and the edits since
//     layout,                            the plant those figures describe (what "Compare properly" offers as a variant)
//     control: { window, report } | null the OLD plant simulated afresh for the same measured `window` as the new one ...
//     after:   { window, report } | null ... and the NEW plant at the end of its pre-roll }
// control and after are the FAIR comparison: the same seed, the same measured window, run side by side, so an edit that changes nothing
// reads exactly +-0 and one that does is not drowned in the run-to-run noise of comparing a short window with a long one. The control
// is a second, silent pre-roll of the old plant (the layout the displayed simulation was built from, with the what-if settings in
// force now) that follows the pre-roll of the new plant; consecutive edits reuse it (it only depends on the old plant and the window).
//
// Frame (every animation frame, also while paused): auto-pause when the tab is hidden (it stays paused when the tab comes
// back); while playing target += min(realDt, 0.1) * speed and sim.advance(target - sim.time, { maxMillis: 10, now });
// then renderer.sim / renderer.layout are kept current and renderer.render(alpha) draws. Paused frames are thinned to ~30 fps.
// Listeners may call destroy() at any point of a frame (also from 'state', 'rebuild' and 'error' events raised inside it):
// the frame stops at the next checkpoint without touching the simulation or the renderer again.
//
// Readings of the spec (also reported to the team):
//  * Interpolation. Simulation.advance rounds a request UP to whole ticks, so the simulation runs up to one tick AHEAD of the
//    display clock `target`; alpha = 1 + (target - sim.time) / dt (clamped to 0..1) places `target` inside the last tick,
//    which is what "leftover / dt" means for such an engine. When the runner is behind (target > sim.time) alpha is 1.
//  * Speed limit. `limited` turns true when the simulation has been more than two ticks behind for over 0.5 s of wall time
//    and false as soon as it catches up. While behind, the backlog is capped at max(0.5 s * speed, 4 ticks) of simulated time
//    BEFORE each request to the engine (so a request never exceeds the cap at the current speed): a slow machine runs at its
//    own pace instead of racing after old time, also when the user lowers the speed afterwards (and after a pause nothing is
//    fast-forwarded).
//  * step(seconds) pauses, then advances the simulation to sim.time + seconds in budgeted chunks (one per frame), so a long step
//    never blocks the page; it resolves with the simulated seconds advanced. A step is as exact as ticks allow (whole ticks of dt).
//    Further step() calls during a step extend it. pause(), play(), reset() and a rebuild end it early.
//  * reset() pauses and builds a fresh simulation at time 0 if one exists (otherwise there is nothing to reset).
//  * 'rebuild' fires with { reason: 'create' | 'structural' | 'reset', sim, warm, label, labels, previous?, baseline } whenever
//    runner.sim is replaced (sim is null, and nothing else is set, when construction failed). `reason` keeps its old meaning
//    (the spec's "reason: lastCommit label" is `label`, the edits joined in words, with `labels` as the list); `warm` is true for
//    a pre-rolled replacement, whose `previous` is { report, simTime } of the simulation it replaced; `baseline` says whether the
//    change-impact card has something to compare against (`paired`: it holds the fair old-versus-new figures; `warmedUp`: the new
//    simulation has finished its warm-up, `warmupLeft` the simulated seconds still to go if not). 'baseline' fires with the new
//    runner.baseline (or null). 'priming' fires
//    with { priming: true, target } when a replacement starts to be pre-rolled (its end is the 'rebuild' event). 'state' fires with { playing, speed, limited } on play / pause / speed / limited changes. 'frame'
//    carries { time, alpha, playing, speed, limited } for every drawn frame. 'kpis' carries the KpiReport, at most every 250 ms
//    and only when the simulation has advanced since the last one. 'error' carries { error, phase } (phase: 'load' | 'create' |
//    'advance' | 'runtime' | 'render' | 'results'); identical errors repeat at most once a second; without an 'error' listener
//    they go to onError. A failing construction or advance leaves the runner paused; the loop never stops.
//  * Options: `loadEngine` (default: an import() call for the engine) and `speed` (default 10) are additions for tests and the shell.

import { RUNTIME_KEYS } from '../model/defaults.js';
import { layoutChangeKind } from '../model/layout.js';

/** Selectable speeds in simulated seconds per real second. */
export const SPEEDS = Object.freeze([1, 2, 5, 10, 30, 60, 120, 300, 600, 1200]);
export const DEFAULT_SPEED = 10;
/** A structural layout change rebuilds the simulation after this long without another one (ms). */
export const REBUILD_DEBOUNCE_MS = 250;
/** Wall-clock budget of sim.advance per frame (ms). */
export const FRAME_BUDGET_MS = 10;
/** Longest real time (s) one frame may contribute to the simulation clock. */
export const MAX_FRAME_SECONDS = 0.1;
/** How long (ms) the simulation must be behind before `limited` is raised. */
export const LIMITED_AFTER_MS = 500;
/** Minimum spacing (ms) of 'kpis' events and lifetime of cached results. */
export const KPI_INTERVAL_MS = 250;
/** Paused frames closer together than this (ms) are skipped (~30 fps). */
export const PAUSED_FRAME_MS = 30;
/** Wall-clock budget of one pre-roll slice (ms): one slice per animation frame, so a frame never does more than this much simulation work. */
export const PRIME_SLICE_MS = 12;
/** Longest wall-clock time (ms) one pre-roll phase (the new plant, then the old plant for the comparison) may take; then it swaps in with what is done. */
export const PRIME_MAX_MS = 4000;
/** A warm restart simulates the warm-up plus this much measured time (s) before it is shown ... */
export const PRIME_MEASURED_SECONDS = 600;
/** ... but never less (s) ... */
export const PRIME_MIN_SECONDS = 600;
/** ... and never more (s) than this. */
export const PRIME_MAX_SECONDS = 2400;
/** A simulation can serve as the baseline of the impact card once it has measured this long (s). */
export const BASELINE_MIN_SECONDS = 600;
/** Constructing a simulation slower than this (ms) uses up the frame: the first slice waits for the next one. */
export const CONSTRUCT_SLOW_MS = 4;
/** Edit labels the runner remembers for the impact card. */
export const MAX_LABELS = 12;

/** Simulated seconds a warm restart pre-rolls for a given warm-up (s). */
export function primeSeconds(warmup) {
  const w = Number.isFinite(warmup) && warmup > 0 ? warmup : 0;
  return Math.min(PRIME_MAX_SECONDS, Math.max(PRIME_MIN_SECONDS, w + PRIME_MEASURED_SECONDS));
}

/** Has this report measured long enough (and finished its warm-up) to be compared against? Tolerates the rounding of tick sums. */
export function isMeasured(report) {
  const w = report && report.window;
  return Boolean(w) && w.warmingUp !== true && Number.isFinite(w.duration) && w.duration + 1 >= BASELINE_MIN_SECONDS;
}

/** `labels` appended to `list`, without repeats, at most MAX_LABELS (the oldest are kept: the first edit explains the baseline best). */
function mergeLabels(list, labels) {
  const out = list.slice();
  for (const label of labels) if (label && !out.includes(label) && out.length < MAX_LABELS) out.push(label);
  return out;
}

/** The label of an edit as the impact card names it: undo and redo say so. */
function editLabel(info, state) {
  const base = String(info.label ?? (state.lastCommit && state.lastCommit.label) ?? '').trim();
  if (!base) return '';
  if (info.type === 'undo') return `Undo ${base}`;
  if (info.type === 'redo') return `Redo ${base}`;
  return base;
}

const LAG_CAP_SECONDS = 0.5;
const BEHIND_TICKS = 2;
const MIN_LAG_CAP_TICKS = 4;
const FALLBACK_DT = 0.1;
const REPEAT_ERROR_MS = 1000;
const EVENTS = ['state', 'frame', 'kpis', 'rebuild', 'baseline', 'priming', 'error'];

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const defaultOnError = (err) => {
  if (typeof console !== 'undefined') console.error(err);
};

/** The allowed speed closest to `x` (on a log scale), or null if `x` is not a positive finite number. */
function snapSpeed(x) {
  const v = Number(x);
  if (!(v > 0) || !Number.isFinite(v)) return null;
  let best = SPEEDS[0];
  for (const s of SPEEDS) if (Math.abs(Math.log(s / v)) < Math.abs(Math.log(best / v))) best = s;
  return best;
}

/** The RUNTIME_KEYS settings of a layout. */
function runtimeOf(layout) {
  const patch = {};
  for (const key of RUNTIME_KEYS) patch[key] = layout.settings[key];
  return patch;
}

const sameRuntime = (a, b) => RUNTIME_KEYS.every((key) => a[key] === b[key]);

/** requestAnimationFrame / cancelAnimationFrame, or a 16 ms timer pair where the page has none (headless use). */
function defaultFrameFunctions(clock) {
  if (typeof globalThis.requestAnimationFrame === 'function' && typeof globalThis.cancelAnimationFrame === 'function') {
    return { raf: (cb) => globalThis.requestAnimationFrame(cb), caf: (id) => globalThis.cancelAnimationFrame(id) };
  }
  return { raf: (cb) => globalThis.setTimeout(() => cb(clock()), 16), caf: (id) => globalThis.clearTimeout(id) };
}

/**
 * Create the runner and start its frame loop.
 * @param {object} options
 * @param {object} options.store the app store (getState / subscribe)
 * @param {object} options.renderer the Renderer (layout, sim, render(alpha))
 * @param {(cb: Function) => any} [options.raf] requestAnimationFrame
 * @param {(handle: any) => void} [options.caf] cancelAnimationFrame
 * @param {() => number} [options.now] clock in milliseconds (default performance.now)
 * @param {{ hidden: boolean, addEventListener: Function, removeEventListener: Function }} [options.document] page visibility source
 * @param {Function} [options.SimulationClass] class to build simulations with (default: the engine, loaded on demand)
 * @param {() => Promise<{ Simulation: Function }>} [options.loadEngine] how to load the engine module
 * @param {(err: unknown, context: object) => void} [options.onError] sink for listener errors and unobserved 'error' events
 * @param {number} [options.speed] initial speed, snapped to SPEEDS
 */
export function createRunner(options = {}) {
  const { store, renderer } = options;
  if (!store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') throw new TypeError('createRunner: a store is required');
  if (!renderer || typeof renderer.render !== 'function') throw new TypeError('createRunner: a renderer is required');
  const clock = options.now ?? (() => performance.now());
  const frames = options.raf ? { raf: options.raf, caf: options.caf ?? (() => {}) } : defaultFrameFunctions(clock);
  const doc = Object.hasOwn(options, 'document') ? options.document : globalThis.document;
  const loadEngine = options.loadEngine ?? (() => import('../sim/engine.js'));
  const onError = options.onError ?? defaultOnError;

  let SimClass = options.SimulationClass ?? null;
  let loading = null;
  let sim = null;
  let builtFrom = null;
  let runtimeApplied = null;
  let playing = false;
  let limited = false;
  let speed = snapSpeed(options.speed ?? DEFAULT_SPEED) ?? DEFAULT_SPEED;
  let target = 0;
  let lastT = null;
  let lastRenderAt = -Infinity;
  let behindSince = null;
  let rebuildDueAt = null;
  let pendingStep = null;
  let lastKpiAt = -Infinity;
  let kpiSeen = { sim: null, time: NaN };
  let lastFailure = { key: '', at: -Infinity };
  let frameHandle = null;
  let destroyed = false;
  let priming = null; // the replacement being pre-rolled behind the displayed one, see startPriming
  let pendingLabels = []; // labels of the structural edits since the displayed simulation was built
  let coldPending = false; // a plant was loaded or a variant switched since then: the next rebuild starts from an empty plant
  let baseline = null; // { report, simTime, labels, edits } or null, see the header
  let warmInfo = null; // { preRoll } of the displayed simulation, null after a cold start
  const cache = { kpis: null, insights: null };
  const handlers = Object.fromEntries(EVENTS.map((name) => [name, new Set()]));

  // ---- events ----

  /** Hand a problem to the error sink; a sink that throws must not take the runner down. */
  function reportError(err, context) {
    try {
      onError(err, context);
    } catch {
      // nothing left to do
    }
  }

  function emit(name, payload) {
    for (const fn of [...handlers[name]]) {
      try {
        fn(payload);
      } catch (err) {
        reportError(err, { event: name });
      }
    }
  }

  const emitState = () => emit('state', { playing, speed, limited });

  /** Report a failure as an 'error' event (rate limited: a render error would otherwise repeat 60 times a second). */
  function fail(phase, err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const key = `${phase}:${error.message}`;
    const t = clock();
    if (key === lastFailure.key && t - lastFailure.at < REPEAT_ERROR_MS) return;
    lastFailure = { key, at: t };
    if (handlers.error.size) emit('error', { error, phase });
    else reportError(error, { phase });
  }

  // ---- play state ----

  function setLimited(value) {
    if (limited === value) return;
    limited = value;
    emitState();
  }

  function startPlaying() {
    if (playing) return;
    playing = true;
    target = sim ? sim.time : 0;
    behindSince = null;
    emitState();
  }

  function stopPlaying() {
    if (!playing) return;
    playing = false;
    limited = false;
    behindSince = null;
    emitState();
  }

  /** Auto-pause: the page is hidden (animation frames stop and nobody is watching). */
  function pauseIfHidden() {
    if (playing && doc && doc.hidden) stopPlaying();
  }

  // ---- the simulation object ----

  /** End a step early or complete: resolve everybody waiting with the simulated seconds advanced. */
  function endStep() {
    if (!pendingStep) return;
    const { start, waiters } = pendingStep;
    pendingStep = null;
    const advanced = sim ? Math.max(0, sim.time - start) : 0;
    for (const resolve of waiters) resolve(advanced);
  }

  /** Replace the baseline (null: none) and tell the listeners. */
  function setBaseline(next) {
    if (next === baseline) return;
    baseline = next;
    emit('baseline', baseline);
  }

  /** Forget everything that belonged to the simulation being replaced by a cold one: priming, edit labels, the baseline. */
  function forgetEdits() {
    priming = null;
    pendingLabels = [];
    coldPending = false;
    warmInfo = null;
    setBaseline(null);
  }

  function dropSim(reason) {
    endStep();
    const had = sim !== null;
    sim = null;
    builtFrom = null;
    runtimeApplied = null;
    renderer.sim = null;
    cache.kpis = null;
    cache.insights = null;
    stopPlaying();
    forgetEdits();
    if (had) emit('rebuild', { reason, sim: null });
  }

  /** Build a fresh simulation from the store's layout (a cold start). Returns it, or null (after reporting) if construction failed. */
  function buildSim(reason) {
    const layout = store.getState().layout;
    const labels = pendingLabels;
    let next;
    try {
      next = new SimClass(layout);
    } catch (err) {
      fail('create', err);
      dropSim(reason);
      return null;
    }
    endStep();
    forgetEdits();
    sim = next;
    builtFrom = layout;
    runtimeApplied = runtimeOf(layout);
    target = sim.time;
    behindSince = null;
    cache.kpis = null;
    cache.insights = null;
    renderer.sim = sim;
    if (limited) {
      limited = false;
      emitState();
    }
    emit('rebuild', { reason, sim, warm: false, label: labelsText(labels), labels: labels.slice(), baseline: false });
    return sim;
  }

  /** "Add fleet, Connect Goods in 2 → Assembly": the edits in one line (three at most). */
  function labelsText(labels) {
    if (labels.length <= 3) return labels.join(', ');
    return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
  }

  // ---- warm restart ----

  /** Is a rebuild now to be a warm restart? Only edits to a plant that has already run; never a load or a variant switch. */
  const warmWanted = () => Boolean(sim) && sim.time > 0 && !coldPending && store.getState().ui.warmRestart !== false;

  /** Throw away the half-primed simulation (an edit made it stale, the runner is reset or destroyed). */
  function cancelPriming() {
    priming = null;
  }

  /** The plant the displayed simulation runs: the layout it was built from with the what-if settings in force now. */
  const plantNow = () => ({ ...builtFrom, settings: { ...builtFrom.settings, ...runtimeApplied } });

  /** Does the baseline already hold the old plant's figures for a measured window of `seconds`? (They depend on nothing else.) */
  const controlFits = (seconds, dt) => Boolean(baseline && baseline.control && Math.abs(baseline.control.window - seconds) <= (dt > 0 ? dt : FALLBACK_DT) / 2);

  /** A report of `simulation`, or null (reported) if it cannot be computed. */
  function reportOf(simulation) {
    try {
      return simulation.kpis();
    } catch (err) {
      fail('results', err);
      return null;
    }
  }

  /**
   * Start pre-rolling a new simulation for `layout` behind the displayed one. `priming` is
   *   { sim, layout, target, fresh, constructMs, elapsed /* ms of frames spent in this phase */, phase: 'main' | 'control',
   *     pair /* the old plant to simulate for the fair comparison, or null */, window, extra /* simulated s the comparison still needs */, control }
   * Phase 'main' pre-rolls the new plant; phase 'control' (only when there is a baseline or the old run was long enough to become one, and
   * the new plant got past its warm-up) then simulates the OLD plant for the same measured window. Both end in swapIn.
   */
  function startPriming(layout) {
    const began = clock();
    let next;
    try {
      next = new SimClass(layout);
    } catch (err) {
      fail('create', err);
      dropSim('structural');
      return;
    }
    const target = primeSeconds(layout.settings.warmup);
    const window = target - layout.settings.warmup;
    const pair = baseline || isMeasured(kpis()) ? { before: (baseline && baseline.layout) || plantNow() } : null;
    const extra = pair && window > 0 && !controlFits(window, next.dt) ? pair.before.settings.warmup + window : 0;
    priming = { sim: next, layout, target, fresh: true, constructMs: clock() - began, elapsed: 0, phase: 'main', pair, window, extra, control: null };
    emit('priming', { priming: true, target });
  }

  /**
   * The baseline after a warm restart that replaces a simulation whose last report is `previous`. `before` is the plant that report
   * describes, `paired` the fair figures { control, after } of this restart (null: there are none). Returns whether there is a baseline now.
   */
  function recordBaseline(previous, labels, before, paired) {
    const control = paired ? paired.control : null;
    const after = paired ? paired.after : null;
    if (baseline) setBaseline({ ...baseline, labels: mergeLabels(baseline.labels, labels), edits: baseline.edits + 1, control: control || baseline.control, after });
    else if (isMeasured(previous.report)) {
      setBaseline({ report: previous.report, simTime: previous.simTime, labels: mergeLabels([], labels), edits: 1, layout: before, control, after });
    }
    return baseline !== null;
  }

  /** The primed simulation `p` takes the place of the displayed one, in one step. `control` = { window, report } of the old plant, or null. */
  function swapIn(p, control = null) {
    priming = null;
    const old = sim;
    const previous = { report: cached('kpis', computeKpis, true), simTime: old.time };
    const labels = pendingLabels;
    pendingLabels = [];
    const arrived = reportOf(p.sim);
    const warmup = p.layout.settings.warmup;
    const warmedUp = arrived && arrived.window ? arrived.window.warmingUp !== true : p.sim.time >= warmup;
    const paired = p.pair && control && arrived && warmedUp ? { control, after: { window: Math.max(0, p.sim.time - warmup), report: arrived } } : null;
    const hasBaseline = recordBaseline(previous, labels, p.pair ? p.pair.before : null, paired);
    if (pendingStep) { // a step() asked for during priming goes on in the new simulation
      const remaining = Math.max(0, pendingStep.target - old.time);
      pendingStep.start = p.sim.time;
      pendingStep.target = p.sim.time + remaining;
    }
    sim = p.sim;
    builtFrom = p.layout;
    runtimeApplied = runtimeOf(p.layout);
    warmInfo = { preRoll: sim.time };
    target = sim.time;
    behindSince = null;
    cache.kpis = null;
    cache.insights = null;
    kpiSeen = { sim: null, time: NaN };
    renderer.sim = sim;
    if (limited) {
      limited = false;
      emitState();
    }
    applyRuntime(store.getState().layout); // a runtime-only change made while priming
    emit('rebuild', {
      reason: 'structural', sim, warm: true, label: labelsText(labels), labels: labels.slice(), previous, baseline: hasBaseline,
      paired: paired !== null, warmedUp, warmupLeft: warmedUp ? 0 : Math.max(0, warmup - sim.time),
    });
  }

  /** One slice of `part` ({ sim, target, fresh, constructMs }): 'working', 'done' (target reached) or 'stuck' (the engine cannot go further). */
  function slice(part) {
    if (part.fresh) {
      part.fresh = false;
      if (part.constructMs > CONSTRUCT_SLOW_MS) return 'working'; // building took the frame: the first slice comes with the next one
    }
    const dt = part.sim.dt > 0 ? part.sim.dt : FALLBACK_DT;
    const before = part.sim.time;
    if (part.target - before > dt * 1e-6) part.sim.advance(part.target - before, { maxMillis: PRIME_SLICE_MS, now: clock });
    if (part.target - part.sim.time <= dt * 1e-6) return 'done';
    return part.sim.time <= before ? 'stuck' : 'working';
  }

  /** The new plant is as far as it will get (target reached, engine stuck or out of time): simulate the old one for the same window, or swap. */
  function finishMain(p) {
    const window = p.sim.time - p.layout.settings.warmup;
    if (!p.pair || !(window > 0)) swapIn(p);
    else if (controlFits(window, p.sim.dt)) swapIn(p, baseline.control);
    else {
      p.phase = 'control';
      p.elapsed = 0;
      p.window = window;
    }
  }

  function stepMain(p) {
    let state;
    try {
      state = slice(p);
    } catch (err) {
      fail('advance', err);
      dropSim('structural');
      return;
    }
    if (state === 'working' && p.elapsed < PRIME_MAX_MS) return;
    finishMain(p);
  }

  /** One slice of the old plant's run for the fair comparison; any trouble here costs the comparison, never the restart. */
  function stepControl(p) {
    if (!p.control) {
      const began = clock();
      try {
        const old = new SimClass(p.pair.before);
        p.control = { sim: old, target: old.settings.warmup + p.window, fresh: true, constructMs: clock() - began };
      } catch (err) {
        fail('create', err);
        swapIn(p);
        return;
      }
    }
    let state;
    try {
      state = slice(p.control);
    } catch (err) {
      fail('advance', err);
      swapIn(p);
      return;
    }
    if (state === 'working' && p.elapsed < PRIME_MAX_MS) return;
    const report = state === 'done' ? reportOf(p.control.sim) : null;
    swapIn(p, report ? { window: p.window, report } : null);
  }

  /** One pre-roll slice. Called once per frame while priming; the frame does nothing else with a simulation. */
  function stepPriming(frameMs) {
    const p = priming;
    if (!p || (doc && doc.hidden)) return;
    p.elapsed += Math.min(frameMs, MAX_FRAME_SECONDS * 1000);
    if (p.phase === 'control') stepControl(p);
    else stepMain(p);
  }

  function ensureEngine() {
    if (!loading) {
      loading = Promise.resolve().then(loadEngine).then((mod) => {
        if (!mod || typeof mod.Simulation !== 'function') throw new Error('The simulation engine module does not export Simulation.');
        SimClass = mod.Simulation;
      });
      loading.catch(() => {
        loading = null; // a later play() may try again
      });
    }
    return loading;
  }

  /** The simulation, built now if the class is known; null if there is none (not loadable yet, or construction failed). */
  const simNow = () => sim || (SimClass ? buildSim('create') : null);

  function applyRuntime(layout) {
    const patch = runtimeOf(layout);
    if (sameRuntime(patch, runtimeApplied)) return;
    try {
      sim.setRuntime(patch);
      runtimeApplied = patch;
    } catch (err) {
      fail('runtime', err);
    }
  }

  /** Carry out a pending (debounced) layout change now: pre-roll a replacement (warm restart) or build a cold one. */
  function flushRebuild() {
    if (rebuildDueAt === null) return;
    rebuildDueAt = null;
    if (!sim) return;
    const layout = store.getState().layout;
    if (layoutChangeKind(builtFrom, layout) !== 'structural') {
      pendingLabels = [];
      coldPending = false;
      applyRuntime(layout);
    } else if (warmWanted()) startPriming(layout);
    else buildSim('structural');
  }

  const unsubscribe = store.subscribe((state, info) => {
    if (destroyed || !sim || !info.layoutChanged) return;
    if (layoutChangeKind(builtFrom, state.layout) === 'structural') {
      if (info.type === 'load' || info.type === 'scenario') coldPending = true; // another plant, not an edit of this one
      const label = info.kind === 'structural' ? editLabel(info, state) : '';
      if (label) pendingLabels = mergeLabels(pendingLabels, [label]);
      // A primed simulation survives edits that cannot change a result (the plant's name, a label on the plan).
      if (priming && ['none', 'cosmetic'].includes(layoutChangeKind(priming.layout, state.layout))) return;
      cancelPriming(); // otherwise it is stale: start again from the newest layout
      rebuildDueAt = clock() + REBUILD_DEBOUNCE_MS;
    } else {
      // back at the layout the displayed simulation was built from (an undo), or only a runtime or cosmetic difference
      cancelPriming();
      pendingLabels = [];
      coldPending = false;
      rebuildDueAt = null;
      applyRuntime(state.layout);
    }
  });

  // ---- results ----

  /**
   * Result of `compute` for the current simulation, cached: fresh for 250 ms, or for as long as the simulation has not moved.
   * `force` recomputes (used by the 'kpis' event, which is rate limited itself and must reflect the state it announces).
   */
  function cached(slot, compute, force = false) {
    if (!sim) return null;
    const t = clock();
    const hit = cache[slot];
    if (!force && hit && hit.sim === sim && (t - hit.at < KPI_INTERVAL_MS || hit.time === sim.time)) return hit.value;
    let value = null;
    try {
      value = compute();
    } catch (err) {
      fail('results', err);
    }
    cache[slot] = { sim, at: t, time: sim.time, value };
    return value;
  }

  const computeKpis = () => sim.kpis();
  const kpis = () => cached('kpis', computeKpis);
  const insights = () => cached('insights', () => sim.insights(kpis() ?? undefined));

  /** Emit 'kpis' (outside the simulation loop, after drawing) if 250 ms have passed and the simulation has moved. */
  function emitKpis(t) {
    if (!sim || t - lastKpiAt < KPI_INTERVAL_MS || (kpiSeen.sim === sim && kpiSeen.time === sim.time)) return;
    lastKpiAt = t;
    kpiSeen = { sim, time: sim.time };
    const report = cached('kpis', computeKpis, true);
    if (report) emit('kpis', report);
  }

  // ---- the frame ----

  /**
   * Advance towards the display clock within the frame budget. Returns the interpolation alpha. The backlog cap is applied
   * before the request, with the speed of THIS frame: after a slow phase the old backlog is never worked off at a new,
   * lower speed in one go. Listeners of 'state' run last (one of them may destroy the runner).
   */
  function advanceLive(realDt, t) {
    const dt = sim.dt > 0 ? sim.dt : FALLBACK_DT;
    const cap = Math.max(speed * LAG_CAP_SECONDS, MIN_LAG_CAP_TICKS * dt);
    target = Math.min(target + Math.min(realDt, MAX_FRAME_SECONDS) * speed, sim.time + cap);
    const want = target - sim.time;
    if (want > 0) sim.advance(want, { maxMillis: FRAME_BUDGET_MS, now: clock });
    const lag = target - sim.time;
    const behind = lag > BEHIND_TICKS * dt;
    if (!behind) behindSince = null;
    else if (behindSince === null) behindSince = t;
    const alpha = clamp01(1 + lag / dt);
    setLimited(behind && t - behindSince > LIMITED_AFTER_MS);
    return alpha;
  }

  /** One budgeted chunk of a step(). */
  function advanceStep() {
    const dt = sim.dt > 0 ? sim.dt : FALLBACK_DT;
    const epsilon = dt * 1e-6;
    if (pendingStep.target - sim.time <= epsilon) {
      endStep();
      return;
    }
    const before = sim.time;
    sim.advance(pendingStep.target - sim.time, { maxMillis: FRAME_BUDGET_MS, now: clock });
    if (pendingStep.target - sim.time <= epsilon || sim.time <= before) endStep();
  }

  function frame(t) {
    const realDt = lastT === null ? 0 : Math.max(0, (t - lastT) / 1000);
    lastT = t;
    pauseIfHidden();
    if (rebuildDueAt !== null && t >= rebuildDueAt) flushRebuild();
    // While a replacement is being primed the displayed simulation stands still and the frame's work is one pre-roll slice.
    const wasPriming = priming !== null;
    if (wasPriming) {
      stepPriming();
      target = sim ? sim.time : 0;
      behindSince = null;
    }
    if (!playing && !pendingStep && !wasPriming && t - lastRenderAt < PAUSED_FRAME_MS) return;
    let alpha = 1;
    if (sim && !wasPriming) {
      try {
        if (playing) alpha = advanceLive(realDt, t);
        else if (pendingStep) advanceStep();
      } catch (err) {
        fail('advance', err);
        stopPlaying();
        endStep();
      }
    }
    if (destroyed) return; // a 'state', 'rebuild' or 'error' listener may have destroyed the runner: nothing left to draw or announce
    const layout = store.getState().layout;
    if (renderer.layout !== layout) renderer.layout = layout;
    if (renderer.sim !== sim) renderer.sim = sim;
    try {
      renderer.render(alpha);
    } catch (err) {
      fail('render', err);
    }
    lastRenderAt = t;
    emit('frame', { time: sim ? sim.time : 0, alpha, playing, speed, limited });
    emitKpis(t);
  }

  function onFrame() {
    frameHandle = null;
    if (destroyed) return;
    frameHandle = frames.raf(onFrame);
    try {
      frame(clock());
    } catch (err) {
      fail('frame', err);
    }
  }

  // ---- public actions ----

  /** Pause a running step too. */
  function pause() {
    stopPlaying();
    endStep();
  }

  function play() {
    if (destroyed) return Promise.resolve(false);
    flushRebuild();
    endStep();
    if (simNow()) {
      startPlaying();
      return Promise.resolve(true);
    }
    if (SimClass) return Promise.resolve(false);
    startPlaying();
    return ensureEngine().then(
      () => {
        if (destroyed || !playing) return false;
        if (!sim && !buildSim('create')) return false;
        target = sim.time;
        return true;
      },
      (err) => {
        fail('load', err);
        stopPlaying();
        return false;
      },
    );
  }

  function beginStep(seconds) {
    return new Promise((resolve) => {
      if (!pendingStep) pendingStep = { start: sim.time, target: sim.time, waiters: [] };
      pendingStep.target += seconds;
      pendingStep.waiters.push(resolve);
    });
  }

  function step(seconds = 1) {
    if (destroyed || !(seconds > 0) || !Number.isFinite(seconds)) return Promise.resolve(0);
    flushRebuild();
    stopPlaying();
    if (simNow()) return beginStep(seconds);
    if (SimClass) return Promise.resolve(0);
    return ensureEngine().then(
      () => (!destroyed && (sim || buildSim('create')) ? beginStep(seconds) : 0),
      (err) => {
        fail('load', err);
        return 0;
      },
    );
  }

  /** Play when paused, pause when playing. Resolves with the new playing state. */
  function toggle() {
    if (!playing) return play();
    pause();
    return Promise.resolve(false);
  }

  /** Back to an empty plant at 0:00 (a cold start: nothing is pre-rolled, the baseline of the impact card is dropped). */
  function reset() {
    if (destroyed) return;
    rebuildDueAt = null;
    cancelPriming();
    pause();
    if (sim) buildSim('reset');
  }

  /** The current numbers become the baseline of the impact card (and the card goes away). False without usable numbers. */
  function keepBaseline() {
    const report = sim && !priming ? kpis() : null;
    if (!report || !isMeasured(report)) { // numbers that are not reliable yet cannot serve as a reference
      dismissBaseline();
      return false;
    }
    setBaseline({ report, simTime: sim.time, labels: [], edits: 0 });
    return true;
  }

  /** Stop comparing: the next warm restart takes the last numbers of the simulation it replaces as its baseline. */
  function dismissBaseline() {
    if (!baseline) return false;
    setBaseline(null);
    return true;
  }

  function setSpeed(x) {
    const next = snapSpeed(x);
    if (next !== null && next !== speed) {
      speed = next;
      emitState();
    }
    return speed;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (frameHandle !== null) frames.caf(frameHandle);
    frameHandle = null;
    unsubscribe();
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', pauseIfHidden);
    playing = false;
    endStep();
    priming = null;
    sim = null;
    renderer.sim = null;
    for (const set of Object.values(handlers)) set.clear();
  }

  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', pauseIfHidden);
  frameHandle = frames.raf(onFrame);

  return {
    get sim() {
      return sim;
    },
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    get limited() {
      return limited;
    },
    /** Simulated seconds on the clock (0 without a simulation). */
    get time() {
      return sim ? sim.time : 0;
    },
    /** True while a replacement for the displayed simulation is being pre-rolled after an edit (warm restart). */
    get priming() {
      return priming !== null;
    },
    /** How far the pre-roll has come, 0..1 (0 when nothing is being primed). */
    get primeProgress() {
      return priming ? clamp01(priming.sim.time / priming.target) : 0;
    },
    /** { preRoll } (simulated seconds run silently before the simulation was shown) of a warm-restarted simulation, else null. */
    get warm() {
      return warmInfo;
    },
    /** { report, simTime, labels, edits } the impact card compares against, or null. Replaced, never mutated. */
    get baseline() {
      return baseline;
    },
    play,
    pause,
    toggle,
    step,
    reset,
    setSpeed,
    kpis,
    insights,
    keepBaseline,
    dismissBaseline,
    on(name, fn) {
      if (!EVENTS.includes(name)) throw new Error(`Unknown runner event "${name}" (use ${EVENTS.join(', ')})`);
      if (typeof fn !== 'function') throw new TypeError('runner.on(event, fn): fn must be a function');
      handlers[name].add(fn);
      return () => handlers[name].delete(fn);
    },
    destroy,
  };
}
