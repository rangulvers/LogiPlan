// "Is a newer LogiPlan live?" (docs/ARCHITECTURE.md 6.11). A page that has been open for hours, or that the browser served from its cache, can be an older
// build than the one on the site. The watcher looks at the site's own version.json (written by scripts/build-site.mjs) and says whether it names a newer
// deploy than the build that is running. It only RECORDS the answer: it never reloads, never shows a dialog and never makes a sound, so a running
// simulation or an edit is never interrupted; the chip of the app shows the answer and the planner decides.
//
//   const watcher = createUpdateWatcher({ build: BUILD });
//   watcher.subscribe((state) => ...);             // state: { available, remote: { version, shortCommit, builtAt } | null, checkedAt }
//   watcher.start({ document, signal });          // one check soon after start, then when the tab becomes visible again and every 30 minutes while it stays in front
//                                                 // (never more often than every 5 minutes)
//   await watcher.check({ force: true });         // for tests and a "check now" button
//
// Silent by design: a development build (it has nothing to compare with), a request that fails (offline, 404, a timeout), an answer that is not JSON or
// not a version.json, a body that is too large, and an answer that is not newer all leave the state as it was. The decision itself is the pure
// function updateVerdict() of js/version.js; everything the outside world is (fetch, the clock, the timers, the document) is injected, so the tests run
// without a browser. No DOM here.

import { BUILD } from './build-info.js';
import { isReleaseBuild, normalizeBuild, updateVerdict } from './version.js';

/** The shortest time between two requests of one page. */
export const CHECK_EVERY_MS = 5 * 60 * 1000;
/** A request that takes longer than this is given up (silently). */
export const CHECK_TIMEOUT_MS = 10_000;
/** The first check comes this long after start, so that it never competes with the start of the app. */
export const START_DELAY_MS = 1500;
/** A tab that stays in front asks again this often (quietly): a planner who keeps LogiPlan open all day learns of a deploy without switching tabs. */
export const VISIBLE_EVERY_MS = 30 * 60 * 1000;
/** A version.json is a few hundred bytes; anything larger than this many characters is not one. */
export const MAX_BODY_CHARS = 20_000;

/**
 * @param {{ build?: object, fetchFn?: Function, now?: () => number, url?: string, setTimer?: Function, clearTimer?: Function,
 *   startDelayMs?: number, timeoutMs?: number, everyMs?: number, repeatMs?: number }} [opts]
 */
export function createUpdateWatcher({
  build = BUILD, fetchFn = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null, now = () => Date.now(), url = 'version.json',
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), startDelayMs = START_DELAY_MS, timeoutMs = CHECK_TIMEOUT_MS, everyMs = CHECK_EVERY_MS,
  repeatMs = VISIBLE_EVERY_MS,
} = {}) {
  const mine = normalizeBuild(build);
  const enabled = isReleaseBuild(mine) && typeof fetchFn === 'function';
  const listeners = new Set();
  let state = { available: false, remote: null, checkedAt: null };
  let lastAttempt = null;
  let inflight = null;
  let stopped = false;
  let stopWatching = () => {};

  const snapshot = () => ({ ...state });
  const setState = (next) => {
    const changed = next.available !== state.available || (next.remote && next.remote.commit) !== (state.remote && state.remote.commit);
    state = next;
    if (changed) for (const fn of [...listeners]) { try { fn(snapshot()); } catch { /* one broken listener must not stop the others */ } }
  };

  async function request() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimer(() => controller.abort(), timeoutMs) : null;
    try {
      // `no-store` skips the browser cache; the query makes every request a different address, so a cache in front of the site cannot answer either
      const res = await fetchFn(`${url}?t=${now()}`, { cache: 'no-store', credentials: 'same-origin', signal: controller ? controller.signal : undefined });
      if (!res || !res.ok) return undefined;
      const text = await res.text();
      if (typeof text !== 'string' || text.length > MAX_BODY_CHARS) return undefined;
      return JSON.parse(text);
    } catch {
      return undefined; // offline, aborted, not JSON: nothing to say
    } finally {
      if (timer !== null) clearTimer(timer);
    }
  }

  async function run() {
    const fetched = await request();
    if (stopped || fetched === undefined) return snapshot();
    const verdict = updateVerdict(mine, fetched);
    if (verdict.reason === 'unreadable') return snapshot(); // an answer that is no version.json says nothing, so the last verdict stands
    setState({ available: verdict.available, remote: verdict.available ? verdict.remote : null, checkedAt: now() });
    return snapshot();
  }

  /** Ask the site now (unless the last request is less than 5 minutes old and `force` is not set). Never rejects. */
  function check({ force = false } = {}) {
    if (!enabled || stopped) return Promise.resolve(snapshot());
    if (inflight) return inflight;
    const t = now();
    // a clock that was set back (NTP step, a virtual machine resumed from a snapshot) makes the age of the last request negative: that counts as old, or
    // the page would not look again until the clock had caught up
    if (!force && lastAttempt !== null && t >= lastAttempt && t - lastAttempt < everyMs) return Promise.resolve(snapshot());
    lastAttempt = t;
    inflight = run().catch(() => snapshot()).finally(() => { inflight = null; });
    return inflight;
  }

  /**
   * Check soon, every time the tab becomes visible again, and every 30 minutes while it stays in front. `doc` needs addEventListener, removeEventListener and visibilityState (the document).
   * Stops when `signal` aborts or stop() is called. Does nothing for a development build.
   */
  function start({ document: doc = globalThis.document, signal } = {}) {
    if (!enabled || !doc || stopped) return;
    const visible = () => doc.visibilityState !== 'hidden';
    const onVisible = () => { if (visible()) void check(); };
    doc.addEventListener('visibilitychange', onVisible);
    // the first check after the start delay, then one every 30 minutes while the tab stays in front (a hidden tab waits for visibilitychange instead)
    let timer = null;
    const arm = (delay) => {
      timer = setTimer(() => { timer = null; if (stopped) return; onVisible(); arm(repeatMs); }, delay);
      if (delay === repeatMs && timer && typeof timer.unref === 'function') timer.unref(); // the tests' Node process is not kept alive for 30 minutes by this (a browser's id is a number)
    };
    arm(startDelayMs);
    const stopAll = () => { if (timer !== null) clearTimer(timer); timer = null; doc.removeEventListener('visibilitychange', onVisible); stop(); };
    if (signal) { if (signal.aborted) stopAll(); else signal.addEventListener('abort', stopAll, { once: true }); }
    stopWatching = stopAll;
  }

  function stop() {
    stopped = true;
    listeners.clear();
  }

  return {
    /** Does this build check at all? (false for a development build) */
    enabled,
    build: mine,
    state: snapshot,
    check,
    start,
    stop: () => stopWatching(),
    /** Call `fn(state)` whenever the answer changes; returns the function that stops it. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
