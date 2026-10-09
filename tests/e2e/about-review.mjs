// Independent review of the version display (docs/ARCHITECTURE.md 6.11) from the USER'S side, in the REAL app (index.html + js/main.js) in real Chromium.
// The reviewer played a logistics planner who wants to know "which version am I on?" and then a hostile tester: the chip on a laptop, a Full HD monitor at
// 50 % to 400 % browser zoom, a 390 px and a 320 px phone, light and dark, with a dialog open, while a simulation runs; the About dialog (what it says, how it is
// built, the accessibility tree, focus, contrast, forced colours, reduced motion, touch); the changelog a planner reads; the copy button and its toast; the
// update hint with a version.json that is newer, the same version with another commit, and a host that sends max-age=600 like GitHub Pages; what "Reload now"
// keeps and what it throws away; the report footer; time zones; before/after geometry of the whole window against a copy of the app WITHOUT the chip.
//
// Two kinds of checks (the convention of tests/e2e/doors-review.mjs):
//   ok / eq             GUARDS: things that must hold (no console error, no request outside the app, the top bar did not move, the plant survives a reload ...);
//                       a failed one aborts the run.
//   defect(id, cond, severity, text)   a FINDING of the review: printed as OPEN while `cond` is false and as FIXED once it holds (then turn it into a guard with
//                       `fixed`). severity: high = crash, data loss, a blocked journey or a misleading number; medium = confusing, ugly or inaccessible enough
//                       that a planner would miss it or misread it; low = polish. The run exits with code 1 while any finding is OPEN.
//
// Run: node tests/e2e/about-review.mjs [section]
//   sections: find baseline a11y update reload changelog copy report time
// Screenshots: e2e-output/about-review-*.png (open them and look). Every section asserts that the page logged no console error or warning and made no request
// outside the app (only index.html, css/, js/, assets/, favicon, ./version.json and ./CHANGELOG.md).
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../scripts/serve.mjs';
import { assembleSite } from '../../scripts/build-site.mjs';
import { OUT, ROOT } from './browser.mjs';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const findings = [];
/** A finding that has been fixed: now a guard. */
const fixed = (id, cond, text) => ok(cond, `${id}: ${text}`);
/** A finding of the review: OPEN while `cond` is false. Never aborts. */
const defect = (id, cond, severity, text) => {
  findings.push({ id, severity, open: !cond, text });
  console.log(`   ${cond ? 'FIXED' : 'OPEN '} ${id} [${severity}] ${text}`);
};

const DESKTOP = { width: 1440, height: 900 };
const SHA = 'a45ce493dfd9ca7440743e6931042fca39642504';
const NEWER = 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6';
const BUILT_AT_EPOCH = '1791558480'; // 2026-10-09T15:08:00Z, 17:08 in Berlin
const LATER_EPOCH = '1791640000'; // a deploy of the next day
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// ---- servers: the repository (development build), the assembled site (live build), a copy of the app without the chip (the "before"), and a host that
//      sends max-age=600 and ETags like GitHub Pages ----------------------------------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };
/** A static server for `dir()` (a function, so that the folder can change under it). `pagesLike` adds the cache headers of GitHub Pages. */
function siteServer(dir, { pagesLike = false } = {}) {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
    const root = dir();
    const file = path.resolve(root, `.${rel}`);
    try {
      if (!file.startsWith(root + path.sep)) throw new Error('outside');
      const body = readFileSync(file);
      const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
      if (pagesLike) {
        const etag = `"${createHash('md5').update(body).digest('hex')}"`;
        Object.assign(headers, { 'cache-control': 'max-age=600', etag });
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
      } else headers['cache-control'] = 'no-store';
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const tmp = mkdtempSync(path.join(tmpdir(), 'logiplan-about-review-'));
const buildSite = (name, env = {}) => {
  const out = path.join(tmp, name);
  assembleSite({ out, env: { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: 'rangulvers/LogiPlan', SOURCE_DATE_EPOCH: BUILT_AT_EPOCH, ...env } });
  return out;
};
const siteA = buildSite('A');
const siteB = buildSite('B', { GITHUB_SHA: NEWER, SOURCE_DATE_EPOCH: LATER_EPOCH }); // the next deploy: another commit, the same version number

/** The app as it was before the chip: the same files, the one line that adds the chip to the status line removed. null when the line is not found. */
function chiplessCopy() {
  const out = path.join(tmp, 'before');
  for (const name of ['index.html', 'css', 'js', 'assets', 'favicon.svg']) cpSync(path.join(ROOT, name), path.join(out, name), { recursive: true });
  const file = path.join(out, 'js/ui/app.js');
  const text = readFileSync(file, 'utf8');
  const line = /^.*createVersionChip\(ctx, \{ signal \}\)\.el.*\n/m;
  if (!line.test(text)) return null;
  writeFileSync(file, text.replace(line, ''));
  return out;
}

let pagesDir = siteA;
const devServer = createServer();
const liveServer = siteServer(() => siteA);
const pagesServer = siteServer(() => pagesDir, { pagesLike: true });
const baseDir = chiplessCopy();
const baseServer = baseDir ? siteServer(() => baseDir) : null;
const devPort = await listen(devServer);
const livePort = await listen(liveServer);
const pagesPort = await listen(pagesServer);
const basePort = baseServer ? await listen(baseServer) : 0;
const DEV = `http://127.0.0.1:${devPort}`;
const LIVE = `http://logiplan.test:${livePort}`; // not localhost: "Live site"; not a secure context: no navigator.clipboard
const PAGES = `http://logiplan.test:${pagesPort}`;
const BASE = `http://127.0.0.1:${basePort}`;
const OWN_HOSTS = new Set([`127.0.0.1:${devPort}`, `logiplan.test:${livePort}`, `logiplan.test:${pagesPort}`, `127.0.0.1:${basePort}`]);
const APP_PATH = /^\/(?:index\.html|css\/[^/]+\.css|js\/.+\.js|assets\/.+|favicon\.(?:svg|ico)|version\.json|CHANGELOG\.md)?$/;

const browser = await chromium.launch({ args: ['--no-sandbox', '--host-resolver-rules=MAP logiplan.test 127.0.0.1'] });
const errors = [];
const foreign = [];
const requests = [];
let expectFailures = false;

try {
  // ---- plumbing ---------------------------------------------------------------------------------------------------------------------------------------

  /** A new visitor: own context (storage), a page that records errors and requests. */
  async function visit(origin, { viewport = DESKTOP, scheme = 'light', scale = 1, extra = {} } = {}) {
    const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: scale, timezoneId: 'Europe/Berlin', locale: 'en-GB', ...extra });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('console', (m) => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      if (expectFailures && /Failed to load resource/.test(m.text())) return;
      errors.push(`[console.${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => { if (!expectFailures) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`); });
    page.on('request', (r) => {
      if (/^(data|blob):/.test(r.url())) return;
      const u = new URL(r.url());
      requests.push(u.pathname + (u.search ? '?' : ''));
      if (!OWN_HOSTS.has(u.host) || !APP_PATH.test(u.pathname)) foreign.push(r.url());
    });
    return { context, page };
  }
  const ready = (page) => page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
  /** Open the app and dismiss the welcome dialog of a first visit. */
  async function openApp(origin, opts = {}) {
    const s = await visit(origin, opts);
    if (opts.route) await s.context.route(...opts.route);
    await s.page.goto(`${origin}/index.html`);
    await ready(s.page);
    await s.page.locator('[role=dialog]').first().waitFor();
    await s.page.keyboard.press('Escape');
    await s.page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await s.page.waitForTimeout(250);
    return s;
  }
  const versionJson = (over = {}) => ({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ name: 'logiplan', version: '0.7.0', commit: NEWER, shortCommit: NEWER.slice(0, 7), builtAt: '2026-10-12T08:00:00Z', channel: 'live', builtFrom: 'main', ...over }),
  });
  /** Open the app on the live site while version.json says what `over` says. */
  const openWithUpdate = (opts = {}, over = {}) => openApp(LIVE, { ...opts, route: ['**/version.json*', (route) => route.fulfill(versionJson(over))] });

  const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => { const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve()); next(count); }), n);
  /** Wait until the dialog has finished sliding in, so that it is measured and photographed where it stays. */
  const settle = (page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  const snap = async (page, name, opts = {}) => {
    await settle(page);
    await page.waitForTimeout(120);
    return page.screenshot({ path: path.join(OUT, `about-review-${name}.png`), ...opts });
  };
  const noErrors = (what) => {
    eq(errors.splice(0), [], `${what}: console errors, warnings or failed requests`);
    eq(foreign.splice(0), [], `${what}: requests outside the app`);
  };
  const run = async (name, fn) => {
    if (only && only !== name) return;
    const t0 = Date.now();
    console.log(`-- ${name}`);
    await fn();
    noErrors(name);
    console.log(`   (${Math.round((Date.now() - t0) / 100) / 10} s, load average ${loadavg()[0].toFixed(1)})`);
  };

  const chipOf = (page) => page.locator('.statusbar .versionchip');
  /** What the chip looks like to a pair of eyes: is it there, where, how big, how readable. */
  const chipMetrics = (page) => page.evaluate(() => {
    const chip = document.querySelector('.versionchip');
    const r = chip.getBoundingClientRect();
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 1]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
    const over = (t, b) => { const a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1]; };
    const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor)); let bg = [255, 255, 255, 1]; for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg); return bg; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const bg = bgOf(chip);
    const contrastOf = (el) => ratio(over(parse(getComputedStyle(el).color), bg), bg);
    const dot = chip.querySelector('.versionchip__dot');
    const hint = chip.querySelector('.versionchip__hint');
    return {
      visible: chip.getClientRects().length > 0,
      inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      w: Math.round(r.width), h: Math.round(r.height), fontPx: parseFloat(getComputedStyle(chip).fontSize),
      text: chip.innerText.replace(/\s+/g, ' ').trim(),
      textContrast: Math.round(contrastOf(chip) * 100) / 100,
      hintContrast: hint && !hint.hidden ? Math.round(contrastOf(hint) * 100) / 100 : null,
      dotContrast: dot && !dot.hidden ? Math.round(ratio(parse(getComputedStyle(dot).backgroundColor), bg) * 100) / 100 : null,
      hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  /** Is there a visible button or menu entry whose name matches `re` (name = aria-label, else the text)? */
  const hasControl = (page, re) => page.evaluate((src) => {
    const re2 = new RegExp(src, 'i');
    return [...document.querySelectorAll('button, [role=menuitem], a')].some((b) => b.getClientRects().length > 0 && re2.test(b.getAttribute('aria-label') || b.textContent || ''));
  }, re.source);
  const facts = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[role=dialog] dl.kv dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])));

  // ==============================================================================================================================================================
  // find: can a planner find the version at once? Windows, zoom, themes, dialogs.
  // ==============================================================================================================================================================
  await run('find', async () => {
    // the chip in the common windows, light and dark
    const windows = [['desktop', 1440, 900], ['laptop', 1366, 650], ['tablet', 768, 1024], ['phone', 390, 844], ['small-phone', 320, 568]];
    for (const scheme of ['light', 'dark']) {
      for (const [id, w, h] of windows) {
        const { context, page } = await openApp(LIVE, { viewport: { width: w, height: h }, scheme });
        const m = await chipMetrics(page);
        ok(m.visible && m.inside, `${id} ${scheme}: the chip is on screen (${JSON.stringify(m)})`);
        eq(m.text, `v${VERSION}`, `${id} ${scheme}: a deployed build reads "v${VERSION}" and nothing else`);
        ok(m.h >= 24 && m.w >= 24, `${id} ${scheme}: the target is at least 24 x 24 CSS px (${m.w} x ${m.h})`);
        ok(m.textContrast >= 4.5, `${id} ${scheme}: the text reaches 4.5:1 (${m.textContrast})`);
        ok(m.hscroll <= 0, `${id} ${scheme}: nothing scrolls sideways`);
        if (scheme === 'light' ? ['desktop', 'phone'].includes(id) : ['desktop', 'phone', 'small-phone'].includes(id)) await snap(page, `find-${id}-${scheme}`);
        if (id === 'small-phone' && scheme === 'dark') {
          await chipOf(page).hover();
          await page.waitForTimeout(500);
          await snap(page, 'find-tooltip-small-phone-dark', { clip: { x: 0, y: h - 160, width: w, height: 160 } });
        }
        await context.close();
      }
    }

    // is the version reachable at once in every window? (chip on screen, or a More menu that has the entry)
    const reach = [];
    for (const zoom of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]) reach.push([`Full HD monitor at ${Math.round(zoom * 100)} % zoom`, Math.round(1920 / zoom), Math.round(970 / zoom), zoom]);
    for (const [w, h] of [[1093, 494], [1280, 500], [1366, 520], [1366, 521]]) reach.push([`laptop window ${w} x ${h}`, w, h, 1]);
    const unreachable = [];
    for (const [id, w, h, scale] of reach) {
      const { context, page } = await openApp(LIVE, { viewport: { width: w, height: h }, scale });
      const m = await chipMetrics(page);
      const more = await hasControl(page, /more actions/);
      ok(m.hscroll <= 0, `${id}: nothing scrolls sideways`);
      if (!m.visible && !more) unreachable.push(`${id} (${w} x ${h} CSS px)`);
      if (w === 960) await snap(page, 'find-zoom200');
      await context.close();
    }
    console.log(`   no chip and no More menu in ${unreachable.length} of ${reach.length} windows: ${unreachable.join('; ')}`);
    defect('ABT-1', unreachable.length === 0, 'medium',
      `the version is not on screen at 200 % browser zoom on a Full HD monitor (960 x 485 CSS px) nor in any window lower than 521 px that is wider than 899 px (a 1366 x 768 laptop at 125 % scaling is 1093 x 494): the status line is hidden by the app's own max-height:520px rule and the More menu only exists below 900 px, so the chip has no stand-in; the only way is Help (?) > "About and what is new" at the bottom left of the Help dialog. Affected here: ${unreachable.join('; ')}`);

    // the stand-in that exists: Help > About, from a window without the chip
    {
      const { context, page } = await openApp(LIVE, { viewport: { width: 960, height: 485 }, scale: 2 });
      await page.getByRole('button', { name: 'Help' }).first().click();
      await page.locator('[role=dialog]').waitFor();
      await settle(page);
      const about = page.locator('[data-role=help-about]');
      ok(await about.isVisible(), 'Help has the button "About and what is new"');
      await snap(page, 'find-help-zoom200');
      await about.click();
      await page.locator('[role=dialog] .about__name').waitFor();
      eq(await page.locator('[role=dialog] .modal__title').innerText(), 'About LogiPlan', 'it opens the About dialog');
      eq((await facts(page)).Version, VERSION);
      await snap(page, 'find-about-zoom200');
      const closeBox = await page.locator('[role=dialog] .modal__footer button', { hasText: 'Close' }).boundingBox();
      ok(closeBox && closeBox.y + closeBox.height <= 485, 'the Close button of the dialog is on screen at 200 % zoom');
      await page.keyboard.press('Escape');
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
      await context.close();
    }

    // the dialog itself in the four combinations: inside the window, nothing sideways, every text readable, Close on screen
    for (const scheme of ['light', 'dark']) {
      for (const [id, w, h] of [['desktop', 1440, 900], ['phone', 390, 844], ['small-phone', 320, 568]]) {
        const { context, page } = await openApp(LIVE, { viewport: { width: w, height: h }, scheme });
        await chipOf(page).click();
        await page.locator('[role=dialog] .about__entry').first().waitFor();
        await settle(page);
        const d = await page.evaluate(() => {
          const dlg = document.querySelector('[role=dialog]');
          const r = dlg.getBoundingClientRect();
          const body = dlg.querySelector('.modal__body');
          const close = dlg.querySelector('.modal__footer button:last-child').getBoundingClientRect();
          const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 1]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
          const over = (t, b) => { const a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1]; };
          const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor)); let bg = [255, 255, 255, 1]; for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg); return bg; };
          const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
          const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
          const low = [];
          const walker = document.createTreeWalker(dlg, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n.textContent.trim(); if (!t) continue;
            const el = n.parentElement; const q = el.getBoundingClientRect(); if (!q.width || !q.height) continue;
            const bg = bgOf(el); const rt = ratio(over(parse(getComputedStyle(el).color), bg), bg);
            if (rt < 4.5) low.push(`${t.slice(0, 30)} ${rt.toFixed(2)}:1`);
          }
          return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 1, sideways: Math.max(0, body.scrollWidth - body.clientWidth), closeOn: close.bottom <= innerHeight + 1 && close.right <= innerWidth, low };
        });
        ok(d.inside && d.sideways === 0 && d.closeOn, `${id} ${scheme}: the dialog is inside the window, does not scroll sideways, Close is on screen (${JSON.stringify(d)})`);
        eq(d.low, [], `${id} ${scheme}: every text of the dialog reaches 4.5:1`);
        if (scheme === 'dark' || id === 'desktop') await snap(page, `find-dialog-${id}-${scheme}`);
        if (id === 'phone' && scheme === 'light') {
          // turned sideways with the dialog open (a phone is rotated while reading)
          await page.setViewportSize({ width: 844, height: 390 });
          await settle(page);
          await page.waitForTimeout(300);
          const r = await page.evaluate(() => { const dlg = document.querySelector('[role=dialog]'); const q = dlg.getBoundingClientRect(); const c = dlg.querySelector('.modal__footer button:last-child').getBoundingClientRect(); return { top: Math.round(q.top), bottom: Math.round(q.bottom), closeBottom: Math.round(c.bottom), vh: innerHeight }; });
          ok(r.top >= 0 && r.bottom <= r.vh + 1 && r.closeBottom <= r.vh + 1, `rotated to 844 x 390 with the dialog open: still inside, Close on screen (${JSON.stringify(r)})`);
          await snap(page, 'find-dialog-rotated');
        }
        await context.close();
      }
    }

    // a phone: More > About and what is new, and the Help footer next to Close at 320 px
    {
      const { context, page } = await openApp(LIVE, { viewport: { width: 320, height: 568 } });
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: /About and what is new/ }).click();
      await page.locator('[role=dialog] .about__name').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
      ok(await page.evaluate(() => Boolean(document.activeElement && document.activeElement.getAttribute('aria-label') === 'More actions')), 'More > About: after Escape the keyboard is back on the More button');
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: /^Help/ }).click();
      await page.locator('[role=dialog] [data-role=help-about]').waitFor();
      await settle(page);
      const rects = await page.evaluate(() => { const a = document.querySelector('[data-role=help-about]').getBoundingClientRect(); const c = [...document.querySelectorAll('[role=dialog] .modal__footer button')].pop().getBoundingClientRect(); return { a: [Math.round(a.left), Math.round(a.right), Math.round(a.top), Math.round(a.bottom)], c: [Math.round(c.left), Math.round(c.right), Math.round(c.top), Math.round(c.bottom)], vw: innerWidth }; });
      ok(rects.a[1] <= rects.c[0] || rects.a[3] <= rects.c[2] || rects.c[3] <= rects.a[2], `Help footer at 320 px: "About and what is new" and Close do not overlap (${JSON.stringify(rects)})`);
      ok(rects.a[0] >= 0 && rects.c[1] <= rects.vw, 'and both are inside the window');
      await snap(page, 'find-help-footer-320');
      await context.close();
    }

    // with another dialog open, and on the first visit: the chip is behind the scrim; the welcome window does not mention the version
    for (const [id, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
      const { context, page } = await visit(LIVE, { viewport: { width: w, height: h } });
      await page.goto(`${LIVE}/index.html`);
      await ready(page);
      await page.locator('[role=dialog]').first().waitFor();
      await snap(page, `find-welcome-${id}`);
      const dialogText = await page.locator('[role=dialog]').first().innerText();
      ok(!/\bv?0\.6\.0\b/.test(dialogText), `${id}: the welcome window does not show the version (fine: the chip is dimmed behind it)`);
      eq(await page.evaluate(() => { const c = document.querySelector('.versionchip').getBoundingClientRect(); const top = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2); return top.closest('.versionchip') !== null; }), false, `${id}: while a dialog is open the chip cannot be clicked`);
      await page.keyboard.press('Escape');
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
      await context.close();
    }
  });

  // ==============================================================================================================================================================
  // baseline: did the chip move anything? The app with the chip against a copy of it without.
  // ==============================================================================================================================================================
  await run('baseline', async () => {
    if (!baseDir) { console.log('   skipped: the line that adds the chip (js/ui/app.js) was not found, so there is no "before" to compare with'); return; }
    const geometry = async (origin, [w, h], scheme, touch) => {
      const { context, page } = await openApp(origin, { viewport: { width: w, height: h }, scheme, scale: touch ? 3 : 1, extra: touch ? { hasTouch: true, isMobile: true } : {} });
      const data = await page.evaluate(() => {
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
        const out = {};
        for (const sel of ['.topbar', '.palette', '.stage', '.stage__canvas', '.side', '.simcol', '.stage__zoom']) out[sel] = rect(document.querySelector(sel));
        out.topbar = [...document.querySelectorAll('.topbar *')].filter((e) => e.getClientRects().length).map((e) => `${e.tagName}.${e.className?.baseVal ?? e.className} ${JSON.stringify(rect(e))}`);
        out.status = rect(document.querySelector('.statusbar'));
        out.statusText = rect(document.querySelector('.statusbar__text'));
        out.statusMeta = rect(document.querySelector('.statusbar__meta'));
        return out;
      });
      await context.close();
      return data;
    };
    const views = [[1440, 900], [1280, 720], [1024, 768], [900, 700], [768, 1024], [390, 844], [360, 640], [320, 568], [844, 390], [720, 450]];
    for (const view of views) {
      for (const scheme of ['light', 'dark']) {
        const before = await geometry(BASE, view, scheme, false);
        const after = await geometry(LIVE, view, scheme, false);
        eq(after.topbar, before.topbar, `${view.join('x')} ${scheme}: every element of the top bar is where it was`);
        for (const sel of ['.topbar', '.palette', '.stage', '.stage__canvas', '.side', '.simcol', '.stage__zoom', 'status']) {
          eq(after[sel], before[sel], `${view.join('x')} ${scheme}: ${sel} did not move or change size`);
        }
      }
    }
    // the one thing the chip costs: width in the status line, which belongs to the hint on how to use the tool
    const widthOf = async (origin, [w, h], route) => {
      const { context, page } = await openApp(origin, { viewport: { width: w, height: h }, route });
      if (route) await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      const width = await page.evaluate(() => Math.round(document.querySelector('.statusbar__text').getBoundingClientRect().width));
      await context.close();
      return width;
    };
    const w390 = { before: await widthOf(BASE, [390, 844]), after: await widthOf(LIVE, [390, 844]), update: await widthOf(LIVE, [390, 844], ['**/version.json*', (route) => route.fulfill(versionJson())]) };
    const w320 = { before: await widthOf(BASE, [320, 568]), after: await widthOf(LIVE, [320, 568]), update: await widthOf(LIVE, [320, 568], ['**/version.json*', (route) => route.fulfill(versionJson())]) };
    console.log(`   the status hint: 390 px ${JSON.stringify(w390)}, 320 px ${JSON.stringify(w320)}`);
    defect('ABT-6', w390.after >= 0.75 * w390.before, 'low',
      `the chip takes ${Math.round((1 - w390.after / w390.before) * 100)} % of the room of the status hint ("Click to select. Drag to move. ...") on a phone: at 390 px ${w390.before} px before, ${w390.after} px with "v0.6.0" and ${w390.update} px with the Update mark; at 320 px ${w320.before}, ${w320.after} and ${w320.update} px, so it reads "Click to s..." and with the Update mark nothing is left of it; the cells and metres next to it keep their width`);
    // touch: the chip makes the status line taller
    {
      const before = await geometry(BASE, [390, 844], 'light', true);
      const after = await geometry(LIVE, [390, 844], 'light', true);
      eq(after.topbar, before.topbar, 'touch: the top bar is where it was');
      console.log(`   touch (coarse pointer) 390 x 844: status line ${before.status[3]} px before, ${after.status[3]} px with the chip; stage ${before['.stage'][3]} -> ${after['.stage'][3]} px high`);
      defect('ABT-16', after['.stage'][3] === before['.stage'][3], 'low',
        `on a touch screen the chip (min-height 32 px) makes the status line ${after.status[3] - before.status[3]} px taller, so the plan, the toolbar and the zoom buttons all move up by that much (stage ${before['.stage'][3]} -> ${after['.stage'][3]} px)`);
    }
  });

  // ==============================================================================================================================================================
  // a11y: names, roles, focus, forced colours, reduced motion
  // ==============================================================================================================================================================
  await run('a11y', async () => {
    const { context, page } = await openWithUpdate();
    const chip = chipOf(page);
    await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
    const tree = await chip.ariaSnapshot();
    eq(tree.includes('button "LogiPlan version 0.6.0. An update is available.'), true, `the chip is a button with a name: ${tree}`);
    eq(await chip.getAttribute('aria-haspopup'), 'dialog');
    eq(await page.locator('.versionchip__dot').getAttribute('aria-hidden'), 'true', 'the dot is decoration, not read');
    const footer = await page.evaluate(() => { const f = document.querySelector('footer.statusbar'); return { role: f.getAttribute('role'), live: f.getAttribute('aria-live'), inMain: !!f.closest('main') }; });
    eq(footer, { role: null, live: null, inMain: false }, 'the chip sits in the page footer (contentinfo landmark), which is not a live region');

    // WCAG 2.5.3 Label in Name: what the eye reads is what a voice command must be able to say
    const label = (await chip.getAttribute('aria-label')).toLowerCase();
    const visible = (await chipMetrics(page)).text;
    const missing = visible.split(' ').filter((word) => !label.includes(word.toLowerCase()));
    defect('ABT-4', missing.length === 0, 'medium',
      `the chip shows "${visible}" but its accessible name is "${await chip.getAttribute('aria-label')}": the visible text "${missing.join('", "')}" is not part of the name (WCAG 2.5.3 Label in Name, level A), so "click v0.6.0" by voice control or a speech-recognition user finds no such button; start the name with the visible text ("v0.6.0, update available. LogiPlan version information and what is new")`);

    // the dialog
    await chip.click();
    const dialog = page.locator('[role=dialog]');
    await page.locator('[role=dialog] .about__entry').first().waitFor();
    eq(await dialog.getAttribute('aria-modal'), 'true');
    eq(await dialog.getAttribute('aria-labelledby'), await page.locator('[role=dialog] .modal__title').getAttribute('id'), 'the dialog is named by its title');
    eq(await page.evaluate(() => document.activeElement.textContent.trim()), 'Close', 'the keyboard starts on Close');
    const aria = await dialog.ariaSnapshot();
    ok(/dialog "About LogiPlan"/.test(aria) && /term: Version/.test(aria) && /definition: 0\.6\.0/.test(aria), 'the facts are a list of terms and definitions');
    ok(/region "What is new"/.test(aria), 'what is new is a labelled region');
    ok(await page.evaluate(() => [...document.querySelectorAll('[role=dialog] .about__toggle')].every((b) => b.hasAttribute('aria-expanded') && document.getElementById(b.getAttribute('aria-controls')))), 'every version is a disclosure button with aria-expanded and aria-controls');
    ok(await page.evaluate(() => document.querySelector('.about__update').getAttribute('aria-live') === 'polite'), 'the update box is a polite live region');
    // a screen-reader user who jumps from heading to heading
    const structure = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] h2, [role=dialog] h3, [role=dialog] h4, [role=dialog] .about__toggle')].map((e) => `${e.tagName === 'BUTTON' ? 'button' : e.tagName.toLowerCase()} ${e.textContent.replace(/\s+/g, ' ').trim().slice(0, 28)}`));
    const versionsAreHeadings = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] .about__toggle')].every((b) => b.closest('h2, h3, h4, h5, [role=heading]')));
    const repeated = structure.filter((s) => /^h4 (Added|Improved|Fixed)$/.test(s)).length;
    defect('ABT-11', versionsAreHeadings, 'low',
      `in the changelog the version names are plain buttons while "Added", "Improved" and "Fixed" are headings (${repeated} of them for 6 versions): jumping from heading to heading says "Added, Improved, Fixed, Added, Improved ..." with no version in between (wrap each version button in a heading, e.g. h4, and make the sections h5)`);

    // focus: the trap, Escape, focus back, a visible ring, the tooltip on the keyboard
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      ok(await page.evaluate(() => Boolean(document.activeElement.closest('[role=dialog]'))), `Tab ${i + 1} stays in the dialog`);
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    ok(await page.evaluate(() => document.activeElement.classList.contains('versionchip')), 'Escape gives the keyboard back to the chip');
    const ring = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.versionchip')); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
    ok(ring.style !== 'none' && ring.width >= 2, `the focus ring is at least 2 px wide (${JSON.stringify(ring)})`);
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => Number(getComputedStyle(document.querySelector('.versionchip'), '::after').opacity) > 0.9), 'the tooltip also shows when the chip has the keyboard focus');
    // the keys of the editor while the chip has the keyboard: Delete and Backspace must not delete the selected station
    await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); });
    await page.evaluate(() => { const { store } = window.__logiplan; const s = store.getState().layout.stations[0]; store.select('station', [s.id]); });
    const stations = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.length);
    await chip.focus();
    for (const key of ['Delete', 'Backspace', 'r', 'f']) await page.keyboard.press(key);
    eq(await page.evaluate(() => window.__logiplan.store.getState().layout.stations.length), stations, 'Delete and Backspace on the focused chip leave the selected station alone');
    eq(await page.locator('[role=dialog]').count(), 0, 'and no key but Enter and Space opens the dialog');
    // where is the chip in the tab order of the page? (the last stop: after the whole plant and the details panel)
    await page.evaluate(() => document.body.focus());
    let presses = 0;
    for (; presses < 200; presses++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement.classList.contains('versionchip'))) break;
    }
    console.log(`   Tab presses from the start of the page to the chip: ${presses + 1}`);
    ok(presses < 200, 'the chip can be reached with Tab');
    await context.close();

    // forced colours (Windows high contrast): the dot is gone, the word stays
    {
      const s = await openWithUpdate({ extra: { forcedColors: 'active' } });
      await s.page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      const m = await chipMetrics(s.page);
      eq(m.text, `v${VERSION} Update`, 'forced colours: the word "Update" is there for those who lose the colour of the dot');
      await snap(s.page, 'a11y-forced-colors', { clip: { x: DESKTOP.width - 420, y: DESKTOP.height - 60, width: 420, height: 60 } });
      await s.context.close();
    }
    // reduced motion: nothing moves
    {
      const s = await openApp(LIVE, { extra: { reducedMotion: 'reduce' } });
      await chipOf(s.page).click();
      await s.page.locator('[role=dialog] .about__entry').first().waitFor();
      await settle(s.page);
      eq(await s.page.evaluate(() => ({ running: document.getAnimations().length, chevron: getComputedStyle(document.querySelector('.about__toggle .icon')).transitionDuration })), { running: 0, chevron: '0s' }, 'prefers-reduced-motion: no animation and no transition in the dialog');
      await s.context.close();
    }
  });

  // ==============================================================================================================================================================
  // update: what the hint says, whether it nags, how often it looks
  // ==============================================================================================================================================================
  await run('update', async () => {
    // a newer version number: the wording, no nagging
    {
      const { context, page } = await openWithUpdate();
      await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); window.__logiplan.runner.play(); });
      await page.waitForFunction(() => window.__logiplan.runner.playing && window.__logiplan.runner.time > 0);
      const toastsBefore = await page.locator('.toast').count();
      const t0 = await page.evaluate(() => window.__logiplan.runner.time);
      await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      eq(await page.locator('[role=dialog]').count(), 0, 'no dialog came up by itself');
      ok((await page.locator('.toast').count()) <= toastsBefore, 'no new toast either');
      ok(await page.evaluate((t) => window.__logiplan.runner.playing && window.__logiplan.runner.time > t, t0), 'the simulation runs on');
      const m = await chipMetrics(page);
      eq(m.text, `v${VERSION} Update`, 'the chip says "v0.6.0 Update"');
      ok(m.hintContrast >= 4.5, `the word Update reaches 4.5:1 in light (${m.hintContrast})`);
      ok(m.dotContrast >= 3, `the dot reaches 3:1 against the status line in light (${m.dotContrast}); WCAG 1.4.11`);
      await snap(page, 'update-chip-light', { clip: { x: DESKTOP.width - 420, y: DESKTOP.height - 60, width: 420, height: 60 } });
      // ignoring it: close the dialog, carry on; the mark stays, nothing else happens
      await chipOf(page).click();
      await page.locator('[role=dialog] .callout--info').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      ok(await chipOf(page).evaluate((el) => el.classList.contains('is-update')), 'ignored: the mark stays (it cannot be dismissed)');
      ok((await page.locator('.toast').count()) <= toastsBefore, 'ignored: still no new toast');
      await context.close();
      // dark theme: the dot and the word
      const dark = await openWithUpdate({ scheme: 'dark' });
      await dark.page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      const d = await chipMetrics(dark.page);
      ok(d.hintContrast >= 4.5 && d.dotContrast >= 3, `dark: the word ${d.hintContrast}:1, the dot ${d.dotContrast}:1`);
      await snap(dark.page, 'update-chip-dark', { clip: { x: DESKTOP.width - 420, y: DESKTOP.height - 60, width: 420, height: 60 } });
      await dark.context.close();
    }

    // the same version number, another commit: what almost every deploy looks like (the number is bumped by hand, a deploy is every merge)
    {
      const { context, page } = await openWithUpdate({}, { version: VERSION, builtAt: '2026-10-09T18:30:00Z' });
      await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      const tip = await chipOf(page).getAttribute('data-tip');
      await chipOf(page).click();
      await page.locator('[role=dialog] .callout--info').waitFor();
      const box = await page.locator('[role=dialog] .callout--info').innerText();
      await page.locator('[role=dialog] .about__entry').first().waitFor();
      await snap(page, 'update-same-version-dialog');
      console.log(`   same version, other commit: tooltip "${tip}"; box "${box.replace(/\s+/g, ' ')}"`);
      defect('ABT-2', !(/A newer version is available/.test(box) && /Version 0\.6\.0 \(build \w+\) is on the site; this page is version 0\.6\.0/.test(box)) && !/Update available \(v0\.6\.0\)/.test(tip), 'medium',
        'when the site has a new build with the SAME version number (every deploy that is not a release) the box says "A newer version is available. Version 0.6.0 (build b3c4d5e) is on the site; this page is version 0.6.0." and the tooltip "Update available (v0.6.0)": two equal numbers called newer; say "A newer build of 0.6.0 is available (b3c4d5e; yours is a45ce49)" and say what changed, or show the build id next to the number');
      defect('ABT-8', (tip.match(/click/gi) || []).length <= 1, 'low',
        `the tooltip of the chip in the update state says "click" twice and "what is new" twice: "${tip}"`);
      await context.close();
    }

    // the update mark where there is no chip: a window without a status line
    {
      const { context, page } = await openWithUpdate({ viewport: { width: 960, height: 485 }, scale: 2 });
      await page.waitForTimeout(2600); // the check runs 1.5 s after the start
      const anyHint = await page.evaluate(() => [...document.querySelectorAll('button, [role=menuitem], a')].some((b) => b.getClientRects().length > 0 && /update/i.test((b.getAttribute('aria-label') || '') + (b.title || '') + (b.textContent || ''))));
      defect('ABT-15', anyHint, 'low', 'in a window without a status line (zoom 200 %, a short laptop window, a phone held sideways) the update is invisible: the Help button and the About entry of the More menu carry no mark, so such a planner learns of a new build only by opening Help > About');
      await context.close();
    }

    // how often does it look? A fake clock: three hours with the tab in front, then the tab leaves and comes back
    {
      const hits = [];
      const { context, page } = await visit(LIVE);
      await context.route('**/version.json*', (route) => { hits.push(route.request().url()); route.fulfill(versionJson({ version: VERSION, commit: SHA, shortCommit: SHA.slice(0, 7), builtAt: '2026-10-09T15:08:00Z' })); });
      await page.clock.install({ time: new Date('2026-10-09T10:00:00Z') });
      await page.goto(`${LIVE}/index.html`);
      await ready(page);
      await page.clock.runFor(2000);
      await page.waitForTimeout(500);
      eq(hits.length, 1, 'one check right after the start');
      await page.clock.fastForward('03:00:00');
      await page.waitForTimeout(800);
      const afterHours = hits.length;
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.clock.fastForward('00:06:00');
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForTimeout(800);
      eq(hits.length, 2, 'coming back to the tab asks again (after the 5 minutes)');
      defect('ABT-7', afterHours > 1, 'low',
        `a tab that stays in front never asks again: ${afterHours} request for version.json in 3 hours (a planner who keeps LogiPlan open on a second monitor all day only learns of a deploy when the tab goes to the background and comes back); a quiet check every 30 minutes while visible would not nag`);
      await context.close();
    }
  });

  // ==============================================================================================================================================================
  // reload: what "Reload now" keeps, what it throws away, and whether it brings the new build
  // ==============================================================================================================================================================
  await run('reload', async () => {
    // the plant, the variants and the file name survive; the run does not
    {
      const { context, page } = await openWithUpdate();
      await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); });
      await page.evaluate(async () => { window.__logiplan.store.commit('rename', (l) => { l.name = 'My edited plant'; }); });
      await page.getByRole('button', { name: 'Add a variant: a copy of the current one' }).click();
      await frames(page, 4);
      await page.evaluate(() => window.__logiplan.runner.setSpeed(600));
      await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
      await page.waitForFunction(() => window.__logiplan.runner.time > 1800, null, { timeout: 120000 });
      await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      await chipOf(page).click();
      await page.locator('[role=dialog] .callout--info').waitFor();
      const t1 = await page.evaluate(() => window.__logiplan.runner.time);
      await page.waitForTimeout(1200);
      ok(await page.evaluate((t) => window.__logiplan.runner.time > t, t1), 'the simulation keeps running behind the open About dialog');
      const boxText = await page.locator('[role=dialog] .callout--info').innerText();
      const before = await page.evaluate(() => ({ name: window.__logiplan.store.getState().layout.name, variants: document.querySelectorAll('.variants__tab').length }));
      ok(before.variants === 2, `two variants before the reload (${before.variants})`);
      await Promise.all([page.waitForNavigation(), page.locator('[role=dialog] button', { hasText: 'Reload now' }).click()]);
      await ready(page);
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => ({ name: window.__logiplan.store.getState().layout.name, variants: document.querySelectorAll('.variants__tab').length, time: window.__logiplan.runner.time, playing: window.__logiplan.runner.playing }));
      eq([after.name, after.variants], [before.name, before.variants], 'the plant and its variants are there after "Reload now", as the box promises');
      eq([after.time, after.playing], [0, false], 'the run is gone: the simulation starts again at 0:00');
      await snap(page, 'reload-after');
      defect('ABT-9', /simulation|run|results/i.test(boxText), 'low',
        `"Reload now" ends a running simulation and throws away its results (and an Experiments comparison and the undo history) without a word: the box promises only "Your plant is saved in this browser and is still there afterwards"; the Help page says "Nothing is lost". A comparison of ten repetitions is minutes of work. Say what is not kept, or ask when a run or results are on screen`);
      await context.close();
    }

    // a host with max-age=600 (GitHub Pages): the page was opened a few minutes ago, a deploy happened, the planner clicks "Reload now"
    {
      pagesDir = siteA;
      const { context, page } = await visit(PAGES);
      await page.goto(`${PAGES}/index.html`);
      await ready(page);
      await page.keyboard.press('Escape');
      const running = () => page.evaluate(() => import('./js/build-info.js').then((m) => m.BUILD.shortCommit));
      eq(await running(), SHA.slice(0, 7), 'the page runs build A');
      pagesDir = siteB; // the deploy
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForTimeout(100);
      // the watcher asks only every 5 minutes: let the page think it is later (the first check came 1.5 s after the start)
      await page.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 6 * 60 * 1000; });
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForSelector('.versionchip.is-update', { timeout: 15000 });
      await chipOf(page).click();
      await Promise.all([page.waitForNavigation(), page.locator('[role=dialog] button', { hasText: 'Reload now' }).click()]);
      await ready(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(3200);
      const commit = await running();
      const stillUpdate = await chipOf(page).evaluate((el) => el.classList.contains('is-update'));
      console.log(`   after "Reload now" on a host with max-age=600: the page runs ${commit}, the new build is ${NEWER.slice(0, 7)}, the Update mark is ${stillUpdate ? 'still there' : 'gone'}`);
      defect('ABT-3', commit === NEWER.slice(0, 7), 'medium',
        `"Reload now" does not bring the new build when the modules are still fresh in the browser cache (GitHub Pages sends max-age=600): the reload revalidates index.html (304) but js/*.js come from the cache, the page runs ${commit} again and the Update mark is ${stillUpdate ? 'still there' : 'gone'}. This is exactly what the product owner does after a deploy (open the site, merge, reload within ten minutes). The box only suggests Ctrl+Shift+R, jargon for a planner ("without the cache"). "Reload now" could refresh the cached files first (fetch each loaded file with cache: 'reload', the list is in performance.getEntriesByType('resource')), then reload`);
      await context.close();
    }
  });

  // ==============================================================================================================================================================
  // changelog: what a planner reads
  // ==============================================================================================================================================================
  await run('changelog', async () => {
    const text = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const { parseChangelog, compareVersions } = await import('../../js/version.js');
    const entries = parseChangelog(text);
    ok(entries.length >= 3, 'the changelog has entries');
    const released = entries.filter((e) => !e.unreleased);
    eq(entries[0].unreleased, true, 'the unreleased changes come first');
    ok(released.every((e, i) => i === 0 || compareVersions(released[i - 1].version, e.version) > 0), 'the versions run from new to old');
    ok(released.every((e, i) => i === 0 || released[i - 1].date >= e.date), 'and so do the dates');
    ok(released.every((e) => e.date && e.date <= '2026-10-10'), 'no version is dated in the future');
    ok(!/\*\*\*|\]\(|<[a-z]/.test(entries.flatMap((e) => e.sections.flatMap((s) => s.items)).join('\n').replace(/\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`/g, '')), 'nothing but bold, italic and code is used in the lines (the dialog reads only those)');

    // words a planner has no use for: how the project is tested and built, file names
    const noise = entries.flatMap((e) => e.sections.flatMap((s) => s.items.map((item) => ({ version: e.version, item }))))
      .filter(({ item }) => /automatic (checks|tests)|run in parallel|docs\/[A-Z-]+\.md|the script is part of the project|design document/i.test(item));
    console.log(`   lines that are about the project, not the plant: ${noise.length}\n${noise.map((n) => `      ${n.version}: ${n.item.slice(0, 110)}`).join('\n')}`);
    defect('ABT-10', noise.length === 0, 'low',
      `${noise.length} lines of the changelog are about how LogiPlan is built, not about what a planner can do (${noise.map((n) => n.version).join(', ')}): "the automatic checks of every change run in parallel", "New automatic tests compare the results ...", "(the script is part of the project)", "A design document ... (docs/WAREHOUSE-DESIGN.md)"; a planner skims past them and learns to skim the whole list`);

    // the running build and "Latest changes": which of these are in my build?
    {
      const { context, page } = await openApp(LIVE);
      await chipOf(page).click();
      await page.locator('[role=dialog] .about__entry').first().waitFor();
      const heads = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] .about__toggle')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()));
      eq(heads[0], 'Latest changes not in a numbered version yet', 'the first entry');
      ok(heads.some((h) => /Version 0\.6\.0 .*Your version/.test(h)), `the running version is marked: ${heads.join(' | ')}`);
      defect('ABT-5', /in this build|in your build|in your copy|this build has|you have/i.test(heads[0]), 'low',
        'the top entry says "Latest changes - not in a numbered version yet" while the chip says v0.6.0 and "Your version" sits on 0.6.0 below it: a planner cannot tell whether these latest changes are in the copy on the screen (on the live site they are, on a page that has been open for days they are not). The number alone does not change with a deploy (all deploys since 0.6.0 read "v0.6.0"): say "included in this build" or "not in this build" per build, e.g. by comparing the entry with the build date');
      await context.close();
    }

    // the headers of the entries at phone widths: one line each
    for (const [w, h] of [[390, 844], [320, 568]]) {
      const { context, page } = await openApp(LIVE, { viewport: { width: w, height: h }, scheme: 'dark' });
      await chipOf(page).click();
      await page.locator('[role=dialog] .about__entry').first().waitFor();
      const m = await page.evaluate(() => {
        const d = document.querySelector('[role=dialog]');
        const body = d.querySelector('.modal__body');
        return {
          toggles: [...d.querySelectorAll('.about__toggle')].map((b) => ({ name: b.innerText.replace(/\s+/g, ' ').trim(), h: Math.round(b.getBoundingClientRect().height) })),
          horizontal: Math.max(0, body.scrollWidth - body.clientWidth),
        };
      });
      const tall = m.toggles.filter((t) => t.h > 44);
      console.log(`   ${w} px: ${tall.length} of ${m.toggles.length} version headers wrap${tall.length ? `: ${tall.map((t) => `${t.name} (${t.h} px)`).join('; ')}` : ''}`);
      eq(m.horizontal, 0, `${w} px: the dialog does not scroll sideways`);
      await page.locator('[role=dialog] .modal__body').evaluate((e) => { e.scrollTop = e.scrollHeight; });
      await snap(page, `changelog-end-${w}-dark`);
      await context.close();
    }

    // a changelog that grows: many versions, a very long word
    {
      let big = '# Changelog\n\n## [Unreleased]\n\n### Added\n- A thing.\n\n';
      for (let i = 40; i >= 1; i--) big += `## [1.${i}.0] - 2026-0${(i % 9) + 1}-${String((i % 27) + 1).padStart(2, '0')}\n\n### Added\n- **Feature ${i}.** What it does for the planner, in a sentence that is long enough to wrap on a phone. Details: https://example.com/changes/${'a'.repeat(80)}\n\n### Fixed\n- Something ${i}.\n\n`;
      const { context, page } = await openApp(LIVE, { viewport: { width: 390, height: 700 }, route: ['**/CHANGELOG.md', (route) => route.fulfill({ status: 200, contentType: 'text/markdown', body: big })] });
      await chipOf(page).click();
      await page.locator('[role=dialog] .about__entry').first().waitFor();
      await settle(page);
      const m = await page.evaluate(() => {
        const body = document.querySelector('[role=dialog] .modal__body');
        return { scrolls: body.scrollHeight > body.clientHeight, sideways: body.scrollWidth - body.clientWidth, footer: document.querySelector('[role=dialog] .modal__footer').getBoundingClientRect().bottom <= innerHeight + 1, entries: document.querySelectorAll('[role=dialog] .about__entry').length };
      });
      ok(m.scrolls && m.footer && m.entries === 41, `a long list scrolls inside the dialog and the Close button stays on screen (${JSON.stringify(m)})`);
      // keyboard scrolling: with the focus on a disclosure button the page keys work
      await page.locator('[role=dialog] .about__toggle').first().focus();
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(500);
      ok(await page.locator('[role=dialog] .modal__body').evaluate((e) => e.scrollTop) > 0, 'PageDown scrolls the list when the focus is in it');
      await page.locator('[role=dialog] .modal__body').evaluate((e) => { e.scrollTop = 0; });
      await page.locator('[role=dialog] .about__toggle').nth(3).scrollIntoViewIfNeeded();
      await snap(page, 'changelog-long-url-390');
      defect('ABT-12', m.sideways <= 0, 'low',
        `a changelog line with a long unbroken word (a link, a file name) makes the dialog scroll sideways by ${m.sideways} px at 390 px: the list items have no overflow-wrap (the real changelog has no such line yet, "Keep a Changelog" files usually link their issues)`);
      await context.close();
    }
  });

  // ==============================================================================================================================================================
  // copy: select and copy the version line, and the toast that follows
  // ==============================================================================================================================================================
  await run('copy', async () => {
    for (const [id, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
      const { context, page } = await openApp(DEV, { viewport: { width: w, height: h }, extra: { permissions: ['clipboard-read', 'clipboard-write'] } });
      await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); });
      await chipOf(page).click();
      await page.locator('[role=dialog] .about__entry').first().waitFor();
      const line = await page.locator('[data-role=about-line]').innerText();
      // one click selects the whole line, Ctrl+C copies it
      await page.locator('[data-role=about-line]').click();
      eq(await page.evaluate(() => getSelection().toString().trim()), line, `${id}: one click selects the whole version line`);
      await page.keyboard.press('Control+c');
      eq(await page.evaluate(() => navigator.clipboard.readText()), line, `${id}: Ctrl+C copies it (the plant was not touched: no station was copied instead)`);
      // the button
      await page.evaluate(() => navigator.clipboard.writeText('something else'));
      await page.locator('[role=dialog] button', { hasText: 'Copy version info' }).click();
      await page.locator('.toast', { hasText: 'The version information was copied' }).waitFor();
      eq(await page.evaluate(() => navigator.clipboard.readText()), line, `${id}: the button copies exactly the line that is shown`);
      eq(await page.locator('[data-role=about-copied]').innerText(), 'Copied.', `${id}: and says so next to it`);
      await page.waitForTimeout(400);
      // does the toast cover the dialog's own Close button?
      const overlap = await page.evaluate(() => {
        const close = document.querySelector('[role=dialog] .modal__footer button:last-child').getBoundingClientRect();
        const cover = [...document.querySelectorAll('[data-region=toasts] > *')].map((t) => {
          const r = t.getBoundingClientRect();
          const w = Math.min(close.right, r.right) - Math.max(close.left, r.left);
          const h = Math.min(close.bottom, r.bottom) - Math.max(close.top, r.top);
          return w > 0 && h > 0 ? Math.round((w * h) / (close.width * close.height) * 100) : 0;
        });
        const centre = document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2);
        return { percent: Math.max(0, ...cover), centreIsButton: centre && centre.closest('button') === document.querySelector('[role=dialog] .modal__footer button:last-child') };
      });
      await snap(page, `copy-toast-${id}`);
      console.log(`   ${id}: toasts cover ${overlap.percent} % of the Close button; its centre ${overlap.centreIsButton ? 'is' : 'is not'} clickable`);
      if (id === 'desktop') {
        defect('ABT-13', overlap.percent === 0, 'low',
          `after "Copy version info" a toast ("The version information was copied. Paste it into your bug report.") slides in over the lower part of the dialog and covers ${overlap.percent} % of its Close button for several seconds, although "Copied." already stands under the line; show one of the two (the toast is redundant inside the dialog) or lift the toasts above the dialog footer`);
      }
      await context.close();
    }
    // a browser that refuses: the line is selected and the dialog says what to press
    {
      const { context, page } = await openApp(LIVE);
      await chipOf(page).click();
      await page.locator('[role=dialog] .about__entry').first().waitFor();
      await page.evaluate(() => { document.execCommand = () => false; });
      await page.locator('[role=dialog] button', { hasText: 'Copy version info' }).click();
      await page.locator('.toast', { hasText: 'did not allow copying' }).waitFor();
      ok(/Ctrl\+C/.test(await page.locator('[data-role=about-copied]').innerText()), 'a refused copy says what to press');
      eq(await page.evaluate(() => getSelection().toString().trim()), await page.locator('[data-role=about-line]').innerText(), 'and the line is selected');
      await context.close();
    }
  });

  // ==============================================================================================================================================================
  // report: the HTML report footer
  // ==============================================================================================================================================================
  await run('report', async () => {
    for (const [origin, label, expected] of [[LIVE, 'live', `Generated with LogiPlan v${VERSION} (${SHA.slice(0, 7)})`], [DEV, 'development', `Generated with LogiPlan v${VERSION} (development build)`]]) {
      const { context, page } = await openApp(origin, { extra: { acceptDownloads: true } });
      await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); });
      await page.getByRole('button', { name: /^Export/ }).first().click();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Report/ }).click()]);
      const file = path.join(tmp, `report-${label}.html`);
      await download.saveAs(file);
      const html = readFileSync(file, 'utf8');
      const footer = /<footer>(.*?)<\/footer>/s.exec(html);
      ok(footer, `${label}: the report has a footer`);
      ok(footer[1].includes(expected), `${label}: the footer says "${expected}": ${footer[1].replace(/<[^>]+>/g, ' | ')}`);
      const shot = await context.newPage();
      await shot.setViewportSize({ width: 900, height: 700 });
      await shot.goto(`file://${file}`);
      await shot.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await shot.waitForTimeout(200);
      await shot.screenshot({ path: path.join(OUT, `about-review-report-footer-${label}.png`) });
      await context.close();
    }
  });

  // ==============================================================================================================================================================
  // time: how the build time reads for a viewer in another time zone
  // ==============================================================================================================================================================
  await run('time', async () => {
    const seen = {};
    for (const timezoneId of ['America/New_York', 'Asia/Tokyo']) {
      const { context, page } = await openApp(LIVE, { extra: { timezoneId } });
      const tip = await chipOf(page).getAttribute('data-tip');
      await chipOf(page).click();
      await page.locator('[role=dialog] .about__entry').first().waitFor();
      const f = await facts(page);
      const day = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] .about__toggle')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()).find((t) => /^Version 0\.6\.0/.test(t)));
      seen[timezoneId] = { built: f.Built, tip, day };
      await context.close();
    }
    console.log(`   ${JSON.stringify(seen)}`);
    ok(/\(2026-10-09 15:08 UTC\)/.test(seen['America/New_York'].built) && /\(2026-10-09 15:08 UTC\)/.test(seen['Asia/Tokyo'].built), 'UTC is always shown next to the local time');
    defect('ABT-14', !/GMT[+-]\d/.test(seen['America/New_York'].built) && /9 Oct/.test(seen['Asia/Tokyo'].tip), 'low',
      `the build time is written in the viewer's zone with "GMT-4" instead of "EDT" for New York ("${seen['America/New_York'].built}"), and for Tokyo the tooltip says "${seen['Asia/Tokyo'].tip}" while the changelog dates the same version "${(seen['Asia/Tokyo'].day || '').replace(/^Version 0\.6\.0 /, '').replace(/ Your version$/, '')}"; the two are right but a planner compares them`);
  });

  const open = findings.filter((d) => d.open);
  const bySeverity = (s) => open.filter((d) => d.severity === s).map((d) => d.id).join(', ');
  console.log(`\n${checks} guard checks passed; ${open.length} of ${findings.length} findings OPEN`);
  for (const s of ['high', 'medium', 'low']) if (bySeverity(s)) console.log(`   ${s}: ${bySeverity(s)}`);
  if (open.length) process.exitCode = 1;
} finally {
  await browser.close();
  for (const server of [devServer, liveServer, pagesServer, baseServer]) if (server) await new Promise((resolve) => server.close(resolve));
}
