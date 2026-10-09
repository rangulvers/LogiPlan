// js/update-check.js: the watcher that asks the site's version.json whether a newer build is live. fetch, the clock, the timers and the document are
// replaced by fakes, so the tests run without a browser and without waiting. The rules: never more often than every 5 minutes, a development build
// never asks, and every failure (offline, 404, a timeout, junk, a huge body) is silent and leaves the last answer as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateWatcher, CHECK_EVERY_MS, CHECK_TIMEOUT_MS, MAX_BODY_CHARS } from '../js/update-check.js';

const SHA = 'a45ce493dfd9ca7440743e6931042fca39642504';
const NEWER = 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6';
const LIVE = { version: '0.6.0', commit: SHA, shortCommit: 'a45ce49', builtAt: '2026-10-09T15:08:00Z', channel: 'live', repository: null };
const DEV = { version: '0.6.0', commit: 'dev', shortCommit: 'dev', builtAt: null, channel: 'dev', repository: null };
const body = (over = {}) => JSON.stringify({ name: 'logiplan', version: '0.6.0', commit: NEWER, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z', channel: 'live', builtFrom: 'main', ...over });

/** A fetch that answers from a queue (a string is a 200 body, an Error is thrown, a function is called) and remembers its calls. */
function fakeFetch(answers) {
  const queue = [...answers];
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const value = typeof next === 'function' ? await next(options) : next;
    if (value instanceof Error) throw value;
    if (typeof value === 'string') return { ok: true, status: 200, text: async () => value };
    return value;
  };
  fn.calls = calls;
  return fn;
}

function fakeClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, advance(ms) { clock.t += ms; } };
  return clock;
}

function fakeTimers() {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => { list.push({ fn, ms, live: true }); return list.length - 1; },
    clearTimer: (id) => { if (list[id]) list[id].live = false; },
    fire(i = list.length - 1) { if (list[i] && list[i].live) { list[i].live = false; list[i].fn(); } },
  };
}

function make(build, answers, extra = {}) {
  const fetchFn = fakeFetch(answers);
  const clock = fakeClock();
  const timers = fakeTimers();
  const watcher = createUpdateWatcher({ build, fetchFn, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, startDelayMs: 0, ...extra });
  return { watcher, fetchFn, clock, timers };
}

test('a development build never asks the site for anything', async () => {
  const { watcher, fetchFn } = make(DEV, [body()]);
  assert.equal(watcher.enabled, false);
  assert.deepEqual(await watcher.check({ force: true }), { available: false, remote: null, checkedAt: null });
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  watcher.start({ document: doc });
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(fetchFn.calls.length, 0);
  const noFetch = createUpdateWatcher({ build: LIVE, fetchFn: null });
  assert.equal(noFetch.enabled, false, 'a browser without fetch stays silent too');
});

test('a newer commit on the site is an update; the request is uncached and carries a changing query', async () => {
  const { watcher, fetchFn, clock } = make(LIVE, [body()]);
  const seen = [];
  watcher.subscribe((state) => seen.push(state));
  const state = await watcher.check();
  assert.equal(state.available, true);
  assert.deepEqual(state.remote, { version: '0.6.0', commit: NEWER, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z' });
  assert.equal(state.checkedAt, clock.t);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, `version.json?t=${clock.t}`);
  assert.equal(fetchFn.calls[0].options.cache, 'no-store');
  assert.equal(fetchFn.calls[0].options.credentials, 'same-origin');
  assert.equal(seen.length, 1, 'subscribers hear about the change once');
  clock.advance(CHECK_EVERY_MS);
  await watcher.check();
  assert.equal(fetchFn.calls[1].url, `version.json?t=${clock.t}`, 'every request is a different address');
  assert.equal(seen.length, 1, 'the same answer again changes nothing, so nobody is told again');
});

test('the same commit, an older version and a rollback', async () => {
  const { watcher, clock } = make(LIVE, [body({ commit: SHA }), body({ version: '0.5.0' }), body(), body({ commit: SHA })]);
  const seen = [];
  watcher.subscribe((s) => seen.push(s.available));
  assert.equal((await watcher.check()).available, false, 'the same commit');
  clock.advance(CHECK_EVERY_MS);
  assert.equal((await watcher.check()).available, false, 'a stale site with an older version');
  clock.advance(CHECK_EVERY_MS);
  assert.equal((await watcher.check()).available, true, 'a newer commit');
  clock.advance(CHECK_EVERY_MS);
  assert.equal((await watcher.check()).available, false, 'the site went back to this build: the hint goes away');
  assert.deepEqual(seen, [true, false]);
});

test('never more often than every 5 minutes, unless forced; two checks at once make one request', async () => {
  const { watcher, fetchFn, clock } = make(LIVE, [body()]);
  await watcher.check();
  clock.advance(CHECK_EVERY_MS - 1);
  await watcher.check();
  assert.equal(fetchFn.calls.length, 1, 'one millisecond too early');
  clock.advance(1);
  await watcher.check();
  assert.equal(fetchFn.calls.length, 2);
  await watcher.check({ force: true });
  assert.equal(fetchFn.calls.length, 3, 'force asks at once');
  clock.advance(CHECK_EVERY_MS);
  const [a, b] = await Promise.all([watcher.check(), watcher.check()]);
  assert.equal(fetchFn.calls.length, 4, 'two callers share one request');
  assert.deepEqual(a, b);
});

test('every kind of failure is silent and keeps the last answer', async () => {
  const failures = [
    new Error('offline'), new TypeError('Failed to fetch'),
    { ok: false, status: 404, text: async () => body() }, { ok: false, status: 500, text: async () => '' }, undefined, null, {},
    { ok: true, text: async () => { throw new Error('body failed'); } },
    'not json', '<html>404</html>', '', '[]', 'null', '"x"', '123', '{"commit":"zz","version":"1.0.0"}', '{"commit":"b3c4d5e","version":"junk"}',
    JSON.stringify({ commit: NEWER, version: 'x'.repeat(MAX_BODY_CHARS) }),
    `{"commit":"${NEWER}","version":"0.9.0","pad":"${'x'.repeat(MAX_BODY_CHARS)}"}`,
    '{"__proto__":{"commit":"b3c4d5e6f708192","version":"9.9.9"}}',
    async () => { throw new DOMException('aborted', 'AbortError'); },
    { ok: true, text: async () => 12345 },
  ];
  for (const failure of failures) {
    const { watcher, clock } = make(LIVE, [body(), failure]);
    const events = [];
    watcher.subscribe((s) => events.push(s.available));
    assert.equal((await watcher.check()).available, true);
    clock.advance(CHECK_EVERY_MS);
    const after = await watcher.check();
    assert.equal(after.available, true, `a failed check keeps "available": ${String(failure).slice(0, 60)}`);
    assert.deepEqual(events, [true]);
    const fresh = make(LIVE, [failure]);
    const quiet = await fresh.watcher.check({ force: true });
    assert.deepEqual([quiet.available, quiet.remote], [false, null]);
  }
});

test('a request that never ends is given up after the timeout', async () => {
  const timers = fakeTimers();
  const fetchFn = (url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
  const watcher = createUpdateWatcher({ build: LIVE, fetchFn, now: fakeClock().now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, startDelayMs: 0 });
  const pending = watcher.check();
  assert.equal(timers.list[0].ms, CHECK_TIMEOUT_MS);
  timers.fire(0);
  assert.deepEqual(await pending, { available: false, remote: null, checkedAt: null });
});

test('start: one check soon, one when the tab becomes visible again, none while it is hidden, and it stops with the signal', async () => {
  const { watcher, fetchFn, clock, timers } = make(LIVE, [body()], { startDelayMs: 1500 });
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const controller = new AbortController();
  watcher.start({ document: doc, signal: controller.signal });
  assert.equal(timers.list[0].ms, 1500, 'the first check waits a moment so that it never competes with the start of the app');
  assert.equal(fetchFn.calls.length, 0);
  timers.fire(0);
  await watcher.check(); // joins the request that the timer started
  assert.equal(fetchFn.calls.length, 1);
  doc.visibilityState = 'hidden';
  clock.advance(CHECK_EVERY_MS * 2);
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(fetchFn.calls.length, 1, 'a hidden tab asks for nothing');
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  await watcher.check();
  assert.equal(fetchFn.calls.length, 2, 'visible again after more than 5 minutes: one request');
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(fetchFn.calls.length, 2, 'and not another one at once');
  controller.abort();
  clock.advance(CHECK_EVERY_MS * 2);
  doc.dispatchEvent(new Event('visibilitychange'));
  await watcher.check({ force: true });
  assert.equal(fetchFn.calls.length, 2, 'after the signal aborted the watcher is stopped for good');
});

test('start does nothing without a document, and a signal that is already aborted stops it at once', async () => {
  const { watcher, fetchFn, timers } = make(LIVE, [body()]);
  watcher.start({ document: null });
  assert.equal(timers.list.length, 0);
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const controller = new AbortController();
  controller.abort();
  watcher.start({ document: doc, signal: controller.signal });
  doc.dispatchEvent(new Event('visibilitychange'));
  await watcher.check();
  assert.equal(fetchFn.calls.length, 0);
});

test('a broken subscriber cannot stop the others, and unsubscribe works', async () => {
  const { watcher } = make(LIVE, [body()]);
  const heard = [];
  watcher.subscribe(() => { throw new Error('broken'); });
  const off = watcher.subscribe((s) => heard.push(s.available));
  const never = [];
  watcher.subscribe((s) => never.push(s))();
  await watcher.check();
  assert.deepEqual(heard, [true]);
  assert.deepEqual(never, []);
  off();
});
