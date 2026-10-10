// The landing page /how/ in real Chromium (docs/HOW-PAGE-DESIGN.md, acceptance H3 to H15). Run: node tests/e2e/how.mjs
//
//   main        1440 px, light: no console output or failed request, no request to another origin, the first view loads only the boot script, the demo
//               loads when the section is near (loading -> playing), the canvas changes while it plays, the clock stands still when scrolled away, hidden
//               or paused, Space / arrows, 44 px targets, the figures against an independent run of the same engine and seed, a whole shift, the change
//               switch, the keyboard walk, layout shift over a full scroll, bytes of the demo's own scripts
//   reduced     prefers-reduced-motion: the demo waits paused on a frame, Play works, nothing on the page moves by itself
//   blocked     demo.js cannot be loaded: data-state="unavailable", the still and a sentence stay
//   no JS       JavaScript off: all copy, the still, the noscript note
//   viewports   320, 390, 768, 1024, 1440, 3840 px wide, light and dark: no horizontal scroll, screenshots in e2e-output/how-*.png
//   print, forced colours, more contrast
//   throttle    4x CPU: long tasks while scrolling through the page and running the demo
//   prefix      the assembled site served under /LogiPlan/: no failed request, the demo reaches "playing"
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../scripts/serve.mjs';
import { assembleSite } from '../../scripts/build-site.mjs';
import { OUT } from './browser.mjs';

mkdirSync(OUT, { recursive: true });
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.log(`  FAIL ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (name) => console.log(`- ${name}`);

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });

/** Prefix server: the assembled site under /LogiPlan/, like GitHub Pages. */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown' };
async function prefixServer() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'logiplan-how-e2e-'));
  assembleSite({ out: dir, env: {}, now: new Date('2026-01-01T00:00:00Z') });
  const s = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith('/LogiPlan/')) { res.writeHead(404).end(); return; }
    let rel = p.slice('/LogiPlan/'.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${s.address().port}`, close: () => { s.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A page with everything logged: console problems, failed requests, status >= 400, requests, long tasks, layout shifts, demo state changes. */
async function open({ viewport = { width: 1440, height: 900 }, colorScheme = 'light', reducedMotion = 'no-preference', javaScriptEnabled = true, forcedColors, contrast } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion, javaScriptEnabled, forcedColors, contrast, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const log = { problems: [], requests: [], bytes: new Map(), responses: [] };
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.problems.push(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => log.problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => log.problems.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('request', (r) => log.requests.push(r.url()));
  page.on('response', async (r) => {
    log.responses.push(r.url());
    if (r.status() >= 400) log.problems.push(`[status ${r.status()}] ${r.url()}`);
    if (/\/js\/|\/css\//.test(r.url())) log.bytes.set(r.url(), (await r.body().catch(() => Buffer.alloc(0))).length);
  });
  await page.addInitScript(() => {
    window.__long = [];
    window.__cls = 0;
    window.__states = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch { /* no long task API */ }
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch { /* no layout shift API */ }
    document.addEventListener('DOMContentLoaded', () => {
      const m = document.querySelector('[data-mount="demo"]');
      if (!m) return;
      const note = () => { const s = m.getAttribute('data-state'); if (s && window.__states[window.__states.length - 1] !== s) window.__states.push(s); };
      new MutationObserver(note).observe(m, { attributes: true, attributeFilter: ['data-state'] });
      note();
    });
  });
  return { context, page, log };
}

const state = (page) => page.evaluate(() => document.querySelector('[data-mount="demo"]').getAttribute('data-state'));
const demoTime = (page) => page.evaluate(() => document.querySelector('[data-mount="demo"]').lpDemo?.core.time ?? -1);
const waitState = (page, want, timeout = 30000) => page.waitForFunction((w) => [].concat(w).includes(document.querySelector('[data-mount="demo"]').getAttribute('data-state')), want, { timeout, polling: 100 });
const scrollToLive = (page) => page.evaluate(() => document.getElementById('live').scrollIntoView({ block: 'start', behavior: 'instant' }));
const canvasHash = (page) => page.evaluate(() => {
  const c = document.querySelector('.lp-demo__canvas');
  const d = c.toDataURL();
  let h = 0;
  for (let i = 0; i < d.length; i += 7) h = (h * 31 + d.charCodeAt(i)) | 0;
  return h;
});
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** Scroll through the whole page in steps so lazy images load and layout shifts show. */
async function scrollThrough(page, step = 500, wait = 60) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += step) { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(wait); }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(wait);
}
const settleImages = (page) => page.evaluate(async () => { await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))); });
const noProblems = (log, what) => eq(log.problems, [], `${what}: no console error or warning, failed request or error status`);

// ---------------------------------------------------------------------------------------------------------------------------------------------
section('main: 1440 px, light');
{
  const { context, page, log } = await open();
  await page.goto(`${ORIGIN}/how/`, { waitUntil: 'load' });
  await sleep(500);
  ok((await page.title()).length > 10, 'the page has a title');
  ok(await page.evaluate(() => document.cookie === '' && localStorage.length === 0 && sessionStorage.length === 0), 'no cookies, no stored data');
  ok(log.requests.every((u) => u.startsWith(ORIGIN)), `every request goes to our own origin: ${log.requests.filter((u) => !u.startsWith(ORIGIN)).join(' ')}`);
  const firstJs = log.requests.filter((u) => /\.m?js(\?|$)/.test(u)).map((u) => u.replace(ORIGIN, ''));
  eq(firstJs, ['/how/js/demo-boot.js'], 'the first view loads one script and nothing of the engine');
  eq(await page.evaluate(() => window.__states), [], 'no demo state before its section is near');

  // links to the planner
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a.btn')].map((a) => a.href));
  ok(hrefs.some((h) => h === `${ORIGIN}/`), 'a button opens the planner');
  ok(hrefs.some((h) => h === `${ORIGIN}/?welcome`), 'a button opens the planner on its examples');
  for (const u of ['/', '/?welcome']) { const r = await context.request.get(ORIGIN + u); ok(r.status() === 200, `${u} answers`); }
  ok((await context.request.get(`${ORIGIN}/how`, { maxRedirects: 0 })).status() === 301, '/how redirects to /how/');

  // the demo wakes up when its section is near
  await scrollToLive(page);
  await waitState(page, 'playing');
  const states = await page.evaluate(() => window.__states);
  ok(states.indexOf('loading') >= 0 && states.indexOf('playing') > states.indexOf('loading'), `states run loading -> playing: ${states.join(' > ')}`);
  ok(await page.evaluate(() => document.querySelector('[data-demo-fallback]').hidden || getComputedStyle(document.querySelector('[data-demo-fallback]')).display === 'none' || document.querySelector('.lp-demo__canvas') !== null), 'the live frame is there');
  await sleep(900);
  const h1 = await canvasHash(page); await sleep(700); const h2 = await canvasHash(page);
  ok(h1 !== h2, 'the picture changes while it plays (vehicles move)');
  const t1 = await demoTime(page); await sleep(700); const t2 = await demoTime(page);
  ok(t2 > t1, `simulated time advances while playing (${t1} -> ${t2})`);

  // off screen: the clock stands still
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const a1 = await demoTime(page); await sleep(900); const a2 = await demoTime(page);
  eq(a2, a1, 'scrolled away, the clock stands still');
  await scrollToLive(page);
  await sleep(700);
  ok((await demoTime(page)) > a2, 'back in view it runs again');

  // controls
  const play = page.locator('.lp-demo .btn--play');
  eq((await play.innerText()).trim(), 'Pause', 'the button says Pause while playing');
  await play.focus();
  await page.keyboard.press('Space');
  await sleep(400);
  eq(await state(page), 'paused', 'Space on the button pauses');
  const p1 = await demoTime(page); await sleep(800); eq(await demoTime(page), p1, 'paused, the clock stands still');
  eq((await play.innerText()).trim(), 'Play', 'the button says Play');
  await page.keyboard.press('Space');
  await sleep(400);
  eq(await state(page), 'playing', 'Space plays again');
  await page.keyboard.press('Enter');
  eq(await state(page), 'paused', 'Enter pauses');
  await page.keyboard.press('Enter');

  // hidden tab: the clock stands still
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(300);
  const v1 = await demoTime(page); await sleep(700); eq(await demoTime(page), v1, 'tab hidden: the clock stands still');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(500);
  ok((await demoTime(page)) > v1, 'tab visible again: it runs');

  // speed by arrow keys
  const speed0 = await page.evaluate(() => document.querySelector('[data-mount="demo"]').lpDemo.core.speed);
  const radios = await page.locator('.lp-demo input[type=radio]').count();
  ok(radios >= 5, `speed and plant choices are radio inputs (${radios})`);
  const focusedSpeed = await page.evaluate(() => {
    const checked = [...document.querySelectorAll('.lp-demo input[type=radio]:checked')].find((r) => /^\d/.test(r.parentElement.textContent.trim()));
    checked.focus();
    return checked.parentElement.textContent.trim();
  });
  await page.keyboard.press('ArrowRight');
  await sleep(200);
  const speed1 = await page.evaluate(() => document.querySelector('[data-mount="demo"]').lpDemo.core.speed);
  ok(speed1 !== speed0, `ArrowRight changes the speed (${focusedSpeed}: ${speed0} -> ${speed1})`);

  // targets of at least 44 px
  const small = await page.evaluate(() => {
    const out = [];
    for (const n of document.querySelectorAll('.btn, header nav a, .lp-demo button, .lp-demo__chip span, .lp-demo__switch, .lp-demo__seg span, .lp-demo summary')) {
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) out.push(`${(n.textContent || '').trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
  eq(small, [], 'every button, nav link and demo control is at least 44 px');

  // the figures are those of the engine: an independent run of the same plant, seed and time
  await play.focus();
  if ((await state(page)) === 'playing') await page.keyboard.press('Space');
  await sleep(900);
  const check = await page.evaluate(async () => {
    const mount = document.querySelector('[data-mount="demo"]');
    const core = mount.lpDemo.core;
    const logic = await import('/how/js/demo-logic.js');
    const { Simulation } = await import('/js/sim/engine.js');
    const { EXAMPLES } = await import('/js/model/examples.js');
    const demo = core.demo;
    const example = EXAMPLES.find((e) => e.id === demo.exampleId);
    const sim = new Simulation(logic.layoutFor(demo, example.build, false));
    const t = core.panes[0].sim.time;
    sim.advance(t);
    const want = logic.readFigures(demo, sim.kpis(), sim.time);
    const text = mount.querySelector('.lp-demo__figs').textContent;
    return { t, simT: sim.time, want: want.items.map((i) => [i.label, i.value]), warming: want.warmingUp, text };
  });
  ok(check.t > 600, `the demo has run (${Math.round(check.t)} simulated seconds)`);
  eq(check.simT, check.t, 'the independent run reached the same simulated time');
  ok(!check.warming && check.want.length >= 4, 'past the warm-up there are figures');
  for (const [label, value] of check.want) ok(check.text.includes(label) && check.text.includes(value), `the page shows "${label}: ${value}" like the engine's own report (page: ${check.text.replace(/\s+/g, ' ').slice(0, 220)})`);

  // the change switch: a second plant beside the first
  await page.locator('.lp-demo__switch').click();
  await sleep(1200);
  ok((await page.locator('.lp-demo__figs em').count()) >= 2, 'with the change on, the figures show the example and the changed plant');
  await page.locator('.lp-demo__switch').click();
  await sleep(600);

  // a whole shift
  const shiftBtn = page.locator('.lp-demo__bar button', { hasText: 'Run a whole shift' });
  await shiftBtn.click();
  await waitState(page, ['shift', 'paused', 'playing'], 5000);
  await page.waitForFunction(() => /\d/.test(document.querySelector('.lp-demo__shift')?.textContent || '') && !document.querySelector('.lp-demo__shift').hidden, null, { timeout: 90000, polling: 250 });
  const shiftText = await page.locator('.lp-demo__shift').innerText();
  ok(/second|minute|ms|s\b/.test(shiftText), `the shift reports the measured time: "${shiftText}"`);

  // layout shift over a full scroll, bytes, problems
  await page.evaluate(() => window.scrollTo(0, 0));
  await scrollThrough(page);
  await settleImages(page);
  const cls = await page.evaluate(() => window.__cls);
  ok(cls < 0.02, `layout shift over the page and the demo is ${cls.toFixed(4)} (budget 0.02)`);
  const own = [...log.bytes].filter(([u]) => u.includes('/how/js/')).reduce((n, [, b]) => n + b, 0);
  ok(own > 0 && own <= 400 * 1024, `the demo's own scripts are ${own} bytes (budget 409600)`);
  ok(log.requests.every((u) => u.startsWith(ORIGIN)), 'still only our own origin after the whole page');
  noProblems(log, 'main');
  await page.close();

  // keyboard walk from the top: skip link first, then in order; a visible focus indicator everywhere
  const k = await open();
  await k.page.goto(`${ORIGIN}/how/`, { waitUntil: 'load' });
  await k.page.keyboard.press('Tab');
  const first = await k.page.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return { text: a.textContent.trim(), href: a.getAttribute('href'), visible: r.width > 0 && r.top >= 0 && r.top < 200 }; });
  ok(first.href === '#main' && first.visible, `the first Tab lands on a visible skip link: ${JSON.stringify(first)}`);
  await k.page.keyboard.press('Enter');
  ok(await k.page.evaluate(() => location.hash === '#main'), 'the skip link goes to main');
  const noRing = [];
  let reachedPlay = false;
  // Tab to "Run a plant right here" (it jumps to the demo section, which wakes the demo), then on to the Play button
  for (let i = 0; i < 12; i++) {
    await k.page.keyboard.press('Tab');
    if (await k.page.evaluate(() => document.activeElement.getAttribute('href') === '#live')) break;
  }
  await k.page.keyboard.press('Enter');
  await k.page.waitForFunction(() => document.querySelector('.lp-demo__bar'), null, { timeout: 30000 });
  await sleep(500);
  for (let i = 0; i < 40 && !reachedPlay; i++) {
    await k.page.keyboard.press('Tab');
    const f = await k.page.evaluate(() => {
      const a = document.activeElement; const cs = getComputedStyle(a);
      const label = a.tagName === 'INPUT' ? getComputedStyle(a.nextElementSibling || a) : cs;
      const ring = a.tagName === 'BODY' || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' || (label.outlineStyle !== 'none' && parseFloat(label.outlineWidth) > 0);
      return { tag: a.tagName, text: (a.textContent || a.getAttribute('aria-label') || '').trim().slice(0, 30), ring, play: a.classList.contains('btn--play') };
    });
    if (!f.ring) noRing.push(`${f.tag} ${f.text}`);
    if (f.play) reachedPlay = true;
  }
  eq(noRing, [], 'every element Tab reaches shows a focus indicator');
  ok(reachedPlay, 'Tab reaches the Play button of the demo');
  await k.page.waitForFunction(() => document.querySelector('[data-mount="demo"]').getAttribute('data-state') === 'playing', null, { timeout: 30000 }).catch(() => {});
  noProblems(k.log, 'keyboard walk');
  await k.context.close();
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
section('reduced motion: the demo waits');
{
  const { context, page, log } = await open({ reducedMotion: 'reduce' });
  await page.goto(`${ORIGIN}/how/`, { waitUntil: 'load' });
  eq(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming?.().iterations !== 1).length), 0, 'nothing on the page animates by itself');
  eq(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto', 'no smooth scrolling');
  await scrollToLive(page);
  await waitState(page, 'paused');
  await sleep(1200);
  const t1 = await demoTime(page); await sleep(900); eq(await demoTime(page), t1, 'paused on a still frame, the clock stands still');
  ok(t1 > 0, 'the plant was run up before it was shown');
  const g1 = await canvasHash(page); await sleep(500); eq(await canvasHash(page), g1, 'the picture stands still');
  eq((await page.locator('.lp-demo .btn--play').innerText()).trim(), 'Play', 'the button offers Play');
  await page.screenshot({ path: path.join(OUT, 'how-reduced-demo.png') });
  await page.locator('.lp-demo .btn--play').click();
  await waitState(page, 'playing');
  await sleep(800);
  ok((await demoTime(page)) > t1, 'Play starts it');
  noProblems(log, 'reduced motion');
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
section('blocked demo.js: the still stays');
{
  const { context, page } = await open();
  await page.route('**/how/js/demo.js', (route) => route.abort());
  await page.goto(`${ORIGIN}/how/`, { waitUntil: 'load' });
  await scrollToLive(page);
  await waitState(page, 'unavailable');
  ok(await page.evaluate(() => { const i = document.querySelector('[data-demo-fallback] img'); const r = i.getBoundingClientRect(); return r.width > 100 && r.height > 60; }), 'the still is visible');
  ok(/still picture/i.test(await page.locator('[data-demo-note]').innerText()), 'a sentence says why');
  await page.screenshot({ path: path.join(OUT, 'how-demo-unavailable.png') });
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
section('JavaScript off');
{
  const { context, page, log } = await open({ javaScriptEnabled: false });
  await page.goto(`${ORIGIN}/how/`, { waitUntil: 'load' });
  const h2s = await page.locator('h2').count();
  ok(h2s >= 8, `all sections are in the page (${h2s} headings)`);
  ok(/Watch your plant run/i.test(await page.locator('h1').innerText()), 'the headline is there');
  ok(await page.evaluate(() => { const i = document.querySelector('[data-demo-fallback] img'); return i && i.getBoundingClientRect().width > 100; }), 'the still shows instead of the demo');
  ok(/JavaScript is off/.test(await page.locator('.demo__note').innerText()), 'the noscript note says so');
  eq(await overflow(page), 0, 'no horizontal scroll');
  await page.screenshot({ path: path.join(OUT, 'how-nojs.png'), fullPage: true });
  noProblems(log, 'JavaScript off');
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
section('viewports x colour schemes');
for (const scheme of ['light', 'dark']) {
  for (const [w, h] of [[320, 640], [390, 844], [768, 1024], [1024, 768], [1440, 900], [3840, 2160]]) {
    const { context, page, log } = await open({ viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto(`${ORIGIN}/how/`, { waitUntil: 'load' });
    eq(await overflow(page), 0, `${w} px ${scheme}: no horizontal scroll at the top`);
    await scrollThrough(page, Math.round(h * 0.8), 40);
    await settleImages(page);
    eq(await overflow(page), 0, `${w} px ${scheme}: no horizontal scroll after the scroll`);
    const wide = await page.evaluate(() => [...document.querySelectorAll('main *, header *, footer *')].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.right > document.documentElement.clientWidth + 1 && !n.closest('nav, .nav, [data-scroll-x]'); }).slice(0, 5).map((n) => `${n.tagName}.${n.className}`));
    eq(wide, [], `${w} px ${scheme}: nothing sticks out of the page`);
    await scrollToLive(page);
    await waitState(page, 'paused', 60000);
    await sleep(600);
    eq(await overflow(page), 0, `${w} px ${scheme}: no horizontal scroll with the demo running`);
    await page.locator('#live').screenshot({ path: path.join(OUT, `how-live-${w}-${scheme}.png`) });
    if (w !== 3840 || scheme === 'light') {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, `how-${w}-${scheme}.png`), fullPage: true });
    }
    noProblems(log, `${w} ${scheme}`);
    await context.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
section('print, forced colours, more contrast');
{
  const { context, page, log } = await open();
  await page.goto(`${ORIGIN}/how/`, { waitUntil: 'load' });
  await scrollThrough(page, 600, 30);
  await settleImages(page);
  await page.waitForFunction(() => document.querySelector('.lp-demo__canvas'), null, { timeout: 30000 });
  await sleep(800);
  await page.emulateMedia({ media: 'print' });
  const pr = await page.evaluate(() => ({ live: getComputedStyle(document.querySelector('.lp-demo')).display, still: getComputedStyle(document.querySelector('[data-demo-fallback]')).display, header: getComputedStyle(document.querySelector('header')).display === 'none' ? 'none' : getComputedStyle(document.querySelector('header')).position, bg: getComputedStyle(document.body).backgroundColor, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, demo: getComputedStyle(document.querySelector('[data-mount="demo"]')).display }));
  ok(pr.header !== 'sticky' && pr.header !== 'fixed', `print: the header does not stick (${pr.header})`);
  ok(/255, 255, 255|0, 0, 0, 0/.test(pr.bg), `print: light background (${pr.bg})`);
  ok(pr.live === 'none' && pr.still !== 'none', `print: the still instead of the live demo (${pr.live}, ${pr.still})`);
  const pdf = await page.pdf({ format: 'A4' });
  ok(pdf.length > 20000, `print: a PDF is made (${pdf.length} bytes)`);
  await page.emulateMedia({ media: 'screen', forcedColors: 'active' });
  await page.evaluate(() => window.scrollTo(0, 0));
  eq(await overflow(page), 0, 'forced colours: no horizontal scroll');
  ok(await page.evaluate(() => { const h = document.querySelector('h1'); const r = h.getBoundingClientRect(); const c = getComputedStyle(h); return r.height > 20 && c.color !== c.backgroundColor && c.webkitTextFillColor !== 'rgba(0, 0, 0, 0)'; }), 'forced colours: the headline is readable');
  await page.screenshot({ path: path.join(OUT, 'how-forced-colors.png') });
  await page.emulateMedia({ forcedColors: 'none', contrast: 'more' });
  eq(await overflow(page), 0, 'more contrast: no horizontal scroll');
  await page.screenshot({ path: path.join(OUT, 'how-contrast-more.png') });
  noProblems(log, 'media emulation');
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
section('4x CPU throttle: long tasks');
{
  const { context, page, log } = await open({ viewport: { width: 1280, height: 800 } });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`${ORIGIN}/how/`, { waitUntil: 'load' });
  await sleep(1500);
  const loadTasks = await page.evaluate(() => window.__long.slice());
  console.log(`  page load long tasks: ${JSON.stringify(loadTasks)}`);
  ok(loadTasks.every((t) => t.ms < 200), `the page itself: no task of 200 ms or more at 4x, which is 50 ms on the machine itself (${JSON.stringify(loadTasks)})`);
  const before = (await page.evaluate(() => window.__long.length));
  // reading: scroll to the demo, let it start
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const liveY = await page.evaluate(() => document.getElementById('live').offsetTop);
  for (let y = 0; y < liveY - 200; y += 400) { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(70); }
  await scrollToLive(page);
  await waitState(page, 'playing', 60000);
  await sleep(1500);
  const startTasks = (await page.evaluate((n) => window.__long.slice(n), before));
  console.log(`  demo start long tasks: ${JSON.stringify(startTasks)}`);
  // steady play, then scroll the rest of the page
  const steady = await page.evaluate(() => window.__long.length);
  await sleep(2000);
  for (let y = liveY; y < height; y += 300) { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(70); }
  const steadyTasks = (await page.evaluate((n) => window.__long.slice(n), steady));
  console.log(`  steady play + scrolling long tasks: ${JSON.stringify(steadyTasks)}`);
  ok(startTasks.every((t) => t.ms < 450), `starting the demo: no task over 450 ms at 4x (${JSON.stringify(startTasks)})`);
  eq(steadyTasks.filter((t) => t.ms >= 50), [], 'steady play and scrolling at 4x: no task of 50 ms or more');
  noProblems(log, 'throttled');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
section('served under /LogiPlan/');
{
  const px = await prefixServer();
  const { context, page, log } = await open();
  await page.goto(`${px.origin}/LogiPlan/how/`, { waitUntil: 'load' });
  await scrollToLive(page);
  await waitState(page, 'playing');
  await sleep(800);
  ok((await demoTime(page)) > 0, 'the demo plays under the prefix');
  ok(log.requests.every((u) => u.startsWith(`${px.origin}/LogiPlan/`)), `every request is inside the prefix: ${log.requests.filter((u) => !u.startsWith(`${px.origin}/LogiPlan/`)).join(' ')}`);
  await scrollThrough(page);
  await settleImages(page);
  const href = await page.evaluate(() => document.querySelector('a.btn').href);
  eq(href, `${px.origin}/LogiPlan/`, 'Open the planner points to the app under the prefix');
  noProblems(log, 'prefix');
  await page.locator('a.btn', { hasText: 'Open the planner' }).first().click();
  await page.waitForLoadState('load');
  ok(page.url() === `${px.origin}/LogiPlan/`, `the button lands on the planner (${page.url()})`);
  ok((await page.locator('canvas').count()) > 0, 'the planner is there');
  await context.close();
  px.close();
}

await browser.close();
await new Promise((r) => server.close(r));
if (failures.length) {
  console.log(`\n${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`\nall browser checks passed (${checks} checks)`);
