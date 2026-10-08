// Simulation runner (docs/ARCHITECTURE.md 6.4): owns the live Simulation and the animation-frame loop that advances it,
// renders every frame and reports results to the UI.
//
//   const runner = createRunner({ store, renderer, raf, caf, now, document, SimulationClass, loadEngine, onError, speed });
//   runner.sim / .playing / .speed / .limited / .time          read-only state
//   runner.play() -> Promise<boolean>     runner.pause()     runner.toggle() -> Promise<boolean>
//   runner.step(seconds = 1) -> Promise<number>     runner.reset()     runner.setSpeed(x) -> number
//   runner.kpis() / runner.insights()     latest results (cached 250 ms), null while there is no simulation
//   runner.on(event, fn) -> off           'state' | 'frame' | 'kpis' | 'rebuild' | 'error'
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
// changes (counted in frames, so no timer is needed) a NEW simulation replaces the old one and statistics restart at time 0;
// the playing state is kept. 'runtime' (and every later non-structural state) => sim.setRuntime(RUNTIME_KEYS settings) at once.
// 'cosmetic' => nothing. play() and step() apply a pending rebuild first.
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
//  * 'rebuild' fires with { reason: 'create' | 'structural' | 'reset', sim } whenever runner.sim is replaced (sim is null when
//    construction failed). 'state' fires with { playing, speed, limited } on play / pause / speed / limited changes. 'frame'
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

const LAG_CAP_SECONDS = 0.5;
const BEHIND_TICKS = 2;
const MIN_LAG_CAP_TICKS = 4;
const FALLBACK_DT = 0.1;
const REPEAT_ERROR_MS = 1000;
const EVENTS = ['state', 'frame', 'kpis', 'rebuild', 'error'];

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
    if (had) emit('rebuild', { reason, sim: null });
  }

  /** Build a fresh simulation from the store's layout. Returns it, or null (after reporting) if construction failed. */
  function buildSim(reason) {
    const layout = store.getState().layout;
    let next;
    try {
      next = new SimClass(layout);
    } catch (err) {
      fail('create', err);
      dropSim(reason);
      return null;
    }
    endStep();
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
    emit('rebuild', { reason, sim });
    return sim;
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

  /** Carry out a pending (debounced) layout change now. */
  function flushRebuild() {
    if (rebuildDueAt === null) return;
    rebuildDueAt = null;
    if (!sim) return;
    const layout = store.getState().layout;
    if (layoutChangeKind(builtFrom, layout) === 'structural') buildSim('structural');
    else applyRuntime(layout);
  }

  const unsubscribe = store.subscribe((state, info) => {
    if (destroyed || !sim || !info.layoutChanged) return;
    if (layoutChangeKind(builtFrom, state.layout) === 'structural') {
      rebuildDueAt = clock() + REBUILD_DEBOUNCE_MS;
    } else {
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
    if (!playing && !pendingStep && t - lastRenderAt < PAUSED_FRAME_MS) return;
    let alpha = 1;
    if (sim) {
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

  function reset() {
    if (destroyed) return;
    rebuildDueAt = null;
    pause();
    if (sim) buildSim('reset');
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
    play,
    pause,
    toggle,
    step,
    reset,
    setSpeed,
    kpis,
    insights,
    on(name, fn) {
      if (!EVENTS.includes(name)) throw new Error(`Unknown runner event "${name}" (use ${EVENTS.join(', ')})`);
      if (typeof fn !== 'function') throw new TypeError('runner.on(event, fn): fn must be a function');
      handlers[name].add(fn);
      return () => handlers[name].delete(fn);
    },
    destroy,
  };
}
