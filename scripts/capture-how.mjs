#!/usr/bin/env node
// Captures the pictures of the /how/ page from the REAL planner (index.html + js/main.js) in headless Chromium and writes them to how/img/.
//
//   node scripts/capture-how.mjs [slot ...]        (npm run capture:how)       slots: see SLOTS below, plus "examples", "demo-still", "og"
//   node scripts/capture-how.mjs --check           re-takes nothing; verifies that how/img/manifest.json matches the files on disk
//
// Deterministic by construction: every plant is one of the planner's own examples with its own seed (layout.settings.seed), the simulated time is reached with
// runner.step(seconds) (exact whole ticks, no wall clock), the window size and the pixel ratio are fixed, motion is reduced, and nothing on the screen is a
// date, a clock of the machine or a random value. Running the script twice gives the same files byte for byte (the manifest has no timestamps).
//
// What is "staged" (and nothing else): the welcome dialog is not shown, the first-run aids (toasts, the "Getting started" and "Next steps" cards, the chip
// over the plan) are hidden, the version in the status bar is hidden (it would go stale), the camera is moved, a tab is chosen, something is selected.
// Everything else is the planner as it is. Pictures are cut to the region that matters (a full window is unreadable at the size the page shows it).
//
// Output files: <slot>.light.webp / <slot>.dark.webp (1600 x 1000), ex-<id>.<theme>.webp (640 x 400), demo-still.dark.webp (the first frame of the page's
// live demo, taken from the demo itself), og.png (1200 x 630) and manifest.json. Encoding is the browser's own canvas WebP encoder (no external tools).
//
// Needs Playwright with Chromium (as tests/e2e/browser.mjs does); no network.
import { chromium } from 'playwright';
import { createServer } from './serve.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'how/img');
const MANIFEST = path.join(OUT, 'manifest.json');

const THEMES = ['light', 'dark'];
const LARGE = { w: 1600, h: 1000 };
const THUMB = { w: 640, h: 400 };
const BUDGET = { large: 96 * 1024, thumb: 22 * 1024, still: 120 * 1024, og: 160 * 1024 };
const PIXEL_RATIO = 3; // screenshots are taken at 3x and scaled down to the slot size: crisp text

/**
 * The alt texts of the large slots. how/index.html carries the same words (tests/how.visuals.test.js compares them): change both together, and keep them
 * true to what the picture shows.
 */
export const ALT = {
  build: 'The LogiPlan editor: a tool palette on the left, a plant on the baseplate with roads, coloured station bricks and flow arrows, and the details panel of the selected station on the right.',
  flows: 'A flow from a storage station to a workstation selected on the plan, and the Flows tab with the split of the storage output and the settings of that flow: its share and the loads per cycle.',
  fleet: 'The Fleet tab: a fleet of forklifts with its count, speed, capacity and what its vehicles are doing right now, next to the plan.',
  run: 'The plant running: vehicles on the roads, loads waiting in front of several stations, and the simulation clock and speed control above the plan.',
  results: 'The Results tab: throughput, lead time, work in progress and fleet utilisation, with a plain-language finding that names the station that waits for its input.',
  traffic: 'A traffic heatmap laid over the plan: the busiest road cells glow in warm colours, with the colour scale in the corner.',
  stats: 'A forklift selected on the plan, its usual routes drawn as lines of different widths, and the Statistics panel showing how its time is spent.',
  docks: 'A warehouse with dock doors: the Results tab lists, for the goods-in doors, trucks served, gate wait, door time and how busy the doors are.',
  compare: 'Two variants of one plant compared side by side: the Experiments tab with the key figures of both from repeated runs and the range of each.',
  'demo-still': 'A still frame of the demo plant, a small pallet warehouse: Goods in with trucks waiting at its doors, a Storage, a Goods out, a forklift park and forklifts on the road loop, with the pallets that wait shown on each station.',
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the slots
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const hold = (page, ms = 500) => page.waitForTimeout(ms);
const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => { const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve()); next(count); }), n);
const settle = async (page) => { await frames(page, 4); await hold(page, 700); await frames(page, 2); };
const tab = (page, id) => page.evaluate((x) => window.__logiplan.ctx.actions.setRightTab(x), id);
const select = (page, kind, ids) => page.evaluate(([k, i]) => window.__logiplan.store.select(k, i), [kind, ids]);
const overlays = (page, patch) => page.evaluate((p) => { const s = window.__logiplan.store; s.setUi({ overlays: { ...s.getState().ui.overlays, ...p } }); }, patch);
const stepTo = async (page, seconds) => {
  await page.evaluate(async (s) => { const r = window.__logiplan.runner; r.setSpeed(600); await r.step(s - r.time); }, seconds);
  await settle(page);
};
/** The station named `name` of the plant on the screen: id, box in metres. */
const stationBox = (page, name) => page.evaluate((n) => {
  const l = window.__logiplan.store.getState().layout;
  const s = l.stations.find((x) => x.name === n);
  const cs = l.grid.cellSize;
  return s && { id: s.id, x: s.x * cs, y: s.y * cs, w: s.w * cs, h: s.h * cs };
}, name);
/** Zoom (pixels per metre) and put the world point (x, y) at the screen position (px, py) of the canvas. */
const look = (page, x, y, zoom, px, py) => page.evaluate(([x, y, z, px, py]) => {
  const { camera, canvas, renderer } = window.__logiplan.ctx;
  if (z) camera.zoomTo(z, canvas.clientWidth / 2, canvas.clientHeight / 2);
  camera.centerOn(x, y);
  camera.pan(px - canvas.clientWidth / 2, py - canvas.clientHeight / 2);
  renderer.invalidate();
}, [x, y, zoom, px, py]);
const fit = async (page) => { await page.evaluate(() => window.__logiplan.ctx.actions.fitView()); await settle(page); };
const scrollPanel = (page, y) => page.evaluate((top) => { const b = document.querySelector('.side__body'); if (b) b.scrollTop = top; }, y);
const panelTop = (page, selector) => page.evaluate((sel) => {
  const body = document.querySelector('.side__body'); const el = [...document.querySelectorAll(`${sel}`)].find((e) => e.getBoundingClientRect().height > 0);
  if (!body || !el) return null;
  return el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
}, selector);

/**
 * Each slot: the plant (an example id), the window, the region of the window that is kept (CSS px, 16:10), what the picture shows and how to stage it.
 * `clip` = [x, y, w, h]; null = the whole window.
 */
export const SLOTS = [
  {
    id: 'build', example: 'two-lines', viewport: [1200, 750], clip: null, simSeconds: 0,
    shows: 'The editor at rest: the plan with roads, bricks and flow arrows, the tool palette, the details panel of the selected station.',
    async stage(page) {
      await fit(page);
      await select(page, 'station', [(await stationBox(page, 'Central warehouse')).id]);
      await tab(page, 'properties');
      await settle(page);
    },
  },
  {
    id: 'flows', example: 'two-lines', viewport: [1440, 900], clip: [440, 40, 1000, 625], simSeconds: 10800, hideBar: true,
    shows: 'A storage station selected, its flow arrows on the plan, the Flows tab with one flow opened (share, batch, priority).',
    async stage(page) {
      const s = await stationBox(page, 'Central warehouse');
      await select(page, 'station', [s.id]);
      await tab(page, 'flows');
      await look(page, s.x + s.w / 2, s.y + s.h / 2, 8, 712, 262);
      await settle(page);
      await page.locator('.side__body button.section__header[aria-label="Flow Central warehouse → Press line"]').click();
      await settle(page);
      await scrollPanel(page, (await panelTop(page, 'button.section__header[aria-label^="Flow "]')) - 100);
      await frames(page, 2);
    },
  },
  {
    id: 'fleet', example: 'two-lines', viewport: [1440, 900], clip: [440, 40, 1000, 625], simSeconds: 10800, hideBar: true,
    shows: 'The Fleet tab of the forklift fleet beside the plan with its vehicles.',
    async stage(page) {
      await tab(page, 'fleet');
      await look(page, 56, 33, 6.4, 700, 290);
      await settle(page);
    },
  },
  {
    id: 'run', example: 'components-plant', viewport: [1440, 740], clip: [48, 48, 1024, 640], simSeconds: 14400, hideZoom: true,
    shows: 'The plant at a fixed simulated time: vehicles on the roads, loads waiting in front of stations, the clock and the speed control.',
    async stage(page) { await tab(page, 'results'); await look(page, 79, 42, 6.2, 520, 380); await settle(page); },
  },
  {
    id: 'results', example: 'two-lines', viewport: [1440, 900], clip: [440, 40, 1000, 625], simSeconds: 10800,
    shows: 'The Results tab: the six measures and the first finding.',
    async stage(page) {
      await tab(page, 'results');
      await look(page, 56, 33, 5.4, 712, 282);
      await settle(page);
      await scrollPanel(page, 50);
      await frames(page, 2);
    },
  },
  {
    id: 'traffic', example: 'congestion-lab', viewport: [1440, 740], clip: [48, 48, 1024, 640], simSeconds: 10800, hideZoom: true,
    shows: 'The Traffic heatmap on the congestion plant after three simulated hours.',
    async stage(page) {
      await tab(page, 'results');
      await page.locator('[data-heat=traffic]').click();
      await look(page, 48, 28, 8.8, 520, 365);
      await settle(page);
    },
  },
  {
    id: 'stats', example: 'congestion-lab', viewport: [1440, 880], clip: [40, 190, 1040, 650], simSeconds: 7200,
    shows: 'One forklift selected: its routes drawn on the plan, the Statistics panel with where its time goes.',
    async stage(page) {
      await select(page, 'vehicle', ['v1#4']);
      await page.evaluate(() => window.__logiplan.ctx.actions.showStatistics());
      await settle(page);
      await hold(page, 900);
    },
  },
  {
    id: 'docks', example: 'warehouse-first-day', viewport: [1440, 900], clip: [440, 40, 1000, 625], simSeconds: 14400, hideBar: true,
    shows: 'The warehouse at four simulated hours: the dock overlay on the plan, the doors card of Goods in in the Results tab.',
    async stage(page) {
      await overlays(page, { docks: true });
      await tab(page, 'results');
      await look(page, 40, 18, 8.6, 650, 290);
      await settle(page);
      await scrollPanel(page, await panelTop(page, '.doors, [data-doors], .door-card') ?? 520);
    },
  },
  {
    id: 'compare', example: 'two-lines', viewport: [1440, 900], clip: [440, 0, 1000, 625], simSeconds: 0, hideBar: true,
    shows: 'Variants A and B (one more forklift) after a comparison run of three repetitions of eight hours: the Experiments tab with the table.',
    async stage(page) {
      await page.evaluate(() => { const st = window.__logiplan.store; st.addScenario('One more forklift'); st.commit('One more forklift', (d) => { d.fleets[0].count += 1; }); });
      await frames(page, 3);
      await tab(page, 'experiments');
      await look(page, 56, 33, 5, 680, 270);
      await hold(page, 400);
      const boxes = page.locator('[data-panel=experiments] input[type=checkbox]');
      for (let i = 0; i < (await boxes.count()); i++) if (!(await boxes.nth(i).isChecked())) await boxes.nth(i).check();
      await page.getByRole('button', { name: 'Run comparison' }).click();
      await page.waitForFunction(() => /Copy as table/.test(document.body.innerText), null, { timeout: 300000 });
      await hold(page, 900);
      // the card says when the comparison was run (the wall clock of the machine): leave that out, the picture must not carry a time of day
      await page.evaluate(() => { for (const p of document.querySelectorAll('.side__body p')) if (/^Run at \d\d:\d\d · /.test(p.textContent)) p.textContent = p.textContent.replace(/^Run at \d\d:\d\d · /, ''); });
      await scrollPanel(page, ((await panelTop(page, '[data-cmp=compare-result]')) ?? 8) - 8);
      await frames(page, 2);
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const BAR_OFF = '.stagebar.overlays { display: none !important; }';
const AIDS_OFF = '.toast-region, .guide-chip, [data-guidance] { display: none !important; } .versionchip { visibility: hidden !important; }';

async function newSession(browser, origin, { theme, viewport, ratio = PIXEL_RATIO }) {
  const context = await browser.newContext({ viewport: { width: viewport[0], height: viewport[1] }, deviceScaleFactor: ratio, colorScheme: theme, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('logiplan:welcome-hidden', '1');
      localStorage.setItem('logiplan:flows-explainer', '0');
    } catch { /* storage may be blocked */ }
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()}`));
  page.setDefaultTimeout(120000);
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
  await page.addStyleTag({ content: AIDS_OFF });
  return { context, page, problems };
}

/** The browser's own encoder: scale `png` (a Buffer) into w x h and return the smallest WebP that fits `budget` (lossless first, then lossy from high to low). */
async function encode(tool, png, w, h, budget, fitMode = 'stretch') {
  const b64 = png.toString('base64');
  const res = await tool.evaluate(async ([b64, w, h, budget, fitMode]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    if (fitMode === 'contain') {
      // the whole picture, centred, on the colour of its own corner (the baseplate)
      const probe = document.createElement('canvas'); probe.width = probe.height = 1; const px = probe.getContext('2d'); px.drawImage(bmp, 3, 3, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = px.getImageData(0, 0, 1, 1).data; x.fillStyle = `rgb(${r},${g},${b})`; x.fillRect(0, 0, w, h);
      const s = Math.min(w / bmp.width, h / bmp.height);
      x.drawImage(bmp, (w - bmp.width * s) / 2, (h - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
    } else if (fitMode === 'cover') {
      const s = Math.max(w / bmp.width, h / bmp.height);
      x.drawImage(bmp, (w - bmp.width * s) / 2, (h - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
    } else x.drawImage(bmp, 0, 0, w, h);
    const toBlob = (q) => new Promise((r) => c.toBlob(r, 'image/webp', q));
    let best = null;
    for (const q of [1, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68, 0.64, 0.6, 0.55, 0.5]) {
      const blob = await toBlob(q);
      if (!best || blob.size < best.blob.size) best = { blob, q };
      if (blob.size <= budget) { best = { blob, q }; break; }
    }
    const buf = new Uint8Array(await best.blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(bin), q: best.q };
  }, [b64, w, h, budget, fitMode]);
  return { data: Buffer.from(res.b64, 'base64'), quality: res.q };
}

const manifest = { _: 'Written by scripts/capture-how.mjs; do not edit. Checked by tests/how.visuals.test.js.', images: {} };
const record = (file, data, extra) => {
  writeFileSync(path.join(OUT, file), data);
  manifest.images[file] = { bytes: data.length, ...extra };
  console.log(`  ${file}  ${(data.length / 1024).toFixed(1)} KB`);
};

async function layoutInfo(page) {
  return page.evaluate(() => { const s = window.__logiplan.store.getState().layout.settings; return { seed: s.seed, warmup: s.warmup }; });
}

async function captureSlot(browser, origin, tool, slot, theme) {
  const { context, page, problems } = await newSession(browser, origin, { theme, viewport: slot.viewport });
  try {
    if (slot.hideBar) await page.addStyleTag({ content: BAR_OFF });
    if (slot.hideZoom) await page.addStyleTag({ content: '.stage__zoom { display: none !important; }' });
    await page.evaluate(async (e) => { await window.__logiplan.ctx.actions.loadExample(e); }, slot.example);
    await frames(page, 4);
    await hold(page, 400);
    const info = await layoutInfo(page);
    if (slot.simSeconds) await stepTo(page, slot.simSeconds);
    await slot.stage(page);
    await frames(page, 3);
    const clip = slot.clip ? { x: slot.clip[0], y: slot.clip[1], width: slot.clip[2], height: slot.clip[3] } : { x: 0, y: 0, width: slot.viewport[0], height: slot.viewport[1] };
    if (Math.abs(clip.width / clip.height - 1.6) > 0.01) throw new Error(`slot ${slot.id}: the clip is not 16:10 (${clip.width} x ${clip.height})`);
    const png = await page.screenshot({ type: 'png', clip });
    const { data, quality } = await encode(tool, png, LARGE.w, LARGE.h, BUDGET.large);
    const file = `${slot.id}.${theme}.webp`;
    record(file, data, { slot: slot.id, theme, width: LARGE.w, height: LARGE.h, example: slot.example, seed: info.seed, simSeconds: slot.simSeconds, window: slot.viewport.join('x'), clip: slot.clip ? slot.clip.join(',') : 'window', shows: slot.shows, altKey: slot.id, alt: ALT[slot.id], quality });
    if (problems.length) console.log(`  (page messages: ${problems.slice(0, 3).join(' | ')})`);
  } finally { await context.close(); }
}

/** The 11 plan previews, exactly as the planner's own example gallery draws them. */
async function captureExamples(browser, origin, tool, theme) {
  const { context, page } = await newSession(browser, origin, { theme, viewport: [1280, 800], ratio: 1 });
  try {
    await page.getByRole('button', { name: 'Examples' }).first().click();
    await page.locator('[role=dialog] [data-example]').first().waitFor();
    const count = await page.locator('[role=dialog] [data-example]').count();
    await page.waitForFunction((n) => document.querySelectorAll('[role=dialog] [data-example] img').length === n && [...document.querySelectorAll('[role=dialog] [data-example] img')].every((i) => i.complete && i.naturalWidth > 0), count, { timeout: 60000 });
    const previews = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[role=dialog] [data-example]')].map((e) => [e.dataset.example, e.querySelector('img').src])));
    const ids = await page.evaluate(() => window.__logiplan.ctx.examples?.map?.((e) => e.id) ?? null);
    for (const [id, src] of Object.entries(previews)) {
      const png = Buffer.from(await page.evaluate(async (u) => {
        const img = new Image(); img.src = u; await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
        const b = await new Promise((r) => c.toBlob(r, 'image/png')); const buf = new Uint8Array(await b.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(bin);
      }, src), 'base64');
      const { data, quality } = await encode(tool, png, THUMB.w, THUMB.h, BUDGET.thumb, 'contain');
      record(`ex-${id}.${theme}.webp`, data, { slot: `ex-${id}`, theme, width: THUMB.w, height: THUMB.h, example: id, alt: '', altKey: '', shows: 'The plan of the example as the planner\'s own gallery preview draws it.', quality });
    }
    void ids;
  } finally { await context.close(); }
}

/** The first frame of the page's own live demo (paused, reduced motion), read from its canvas. */
async function captureDemoStill(browser, origin, tool) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  try {
    await page.goto(`${origin}/how/index.html`);
    await page.locator('#live').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('[data-mount="demo"]')?.getAttribute('data-state') === 'paused' && document.querySelector('.lp-demo__canvas'), null, { timeout: 120000 });
    await frames(page, 4);
    const info = await page.evaluate(() => {
      const c = document.querySelector('.lp-demo__canvas');
      return { w: c.width, h: c.height, css: c.getBoundingClientRect().width / c.getBoundingClientRect().height, demo: document.querySelector('[data-mount="demo"]').getAttribute('data-demo'), url: c.toDataURL('image/png') };
    });
    const png = Buffer.from(info.url.split(',')[1], 'base64');
    const { data, quality } = await encode(tool, png, LARGE.w, LARGE.h, BUDGET.still);
    record('demo-still.dark.webp', data, { slot: 'demo-still', theme: 'dark', width: LARGE.w, height: LARGE.h, example: info.demo, simSeconds: 'the silent start of the demo (warm-up plus two minutes)', window: '1440x900', clip: 'the demo canvas', shows: 'The first frame of the live demo, read from its own canvas (same renderer, camera fit and theme).', altKey: 'demo-still', alt: ALT['demo-still'], quality, source: `canvas ${info.w}x${info.h}` });
  } finally { await context.close(); }
}

/** The social card: the logo, the headline, a plan. Drawn by a throw-away page with the planner's own colours; the plan is the demo's first frame. */
async function captureOg(browser, tool) {
  const still = readFileSync(path.join(OUT, 'run.dark.webp')); // a busy plant, drawn by the planner
  const logo = readFileSync(path.join(ROOT, 'assets/logo.svg'));
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{width:1200px;height:630px;overflow:hidden;background:#0f1319;color:#eef2f8;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;position:relative}
    .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(120,150,200,.10) 1px,transparent 1px),linear-gradient(90deg,rgba(120,150,200,.10) 1px,transparent 1px);background-size:30px 30px}
    .glow{position:absolute;right:-120px;top:-160px;width:760px;height:760px;background:radial-gradient(closest-side,rgba(74,125,255,.35),transparent)}
    .brand{position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700;letter-spacing:-.01em}
    .brand img{width:52px;height:52px}
    h1{position:absolute;left:72px;top:176px;width:520px;font-size:72px;line-height:1.02;font-weight:760;letter-spacing:-.035em}
    h1 em{font-style:normal;background:linear-gradient(90deg,#7fa6ff,#b392ff);-webkit-background-clip:text;background-clip:text;color:transparent}
    p{position:absolute;left:72px;bottom:64px;font-size:26px;color:#aab6ca;letter-spacing:.01em}
    .shot{position:absolute;right:48px;top:100px;width:588px;height:367px;border-radius:18px;border:2px solid rgba(160,185,235,.38);overflow:hidden;background:#12161d}
    .shot img{width:122%;max-width:none;height:auto;display:block;margin:-5% 0 0 -9%}
    .tag{position:absolute;right:48px;top:490px;font:600 15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8da2c6}
  </style><div class="grid"></div>
  <div class="brand"><img src="data:image/svg+xml;base64,${logo.toString('base64')}" alt="">LogiPlan</div>
  <h1>Watch your plant run <em>before you build it.</em></h1>
  <div class="shot"><img src="data:image/webp;base64,${still.toString('base64')}" alt=""></div>
  <div class="tag">A simulated plant, drawn by the planner</div>
  <p>Free and open source. Runs in your browser.</p>`;
  const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(html);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    const shot = await page.screenshot({ type: 'png' });
    const raw = await tool.evaluate(async (b64) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data; let bin = ''; for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode(...d.subarray(i, i + 0x8000)); return btoa(bin);
    }, shot.toString('base64'));
    const png = palettePng(1200, 630, Buffer.from(raw, 'base64'), 224);
    record('og.png', png, { slot: 'og', theme: 'dark', width: 1200, height: 630, shows: 'Social card: logo, headline, a running plant (run.dark.webp).', alt: '', altKey: '' });
  } finally { await context.close(); }
}


// ---------------------------------------------------------------------------------------------------------------------------------------------------
// a tiny palette PNG writer (median cut + error diffusion + zlib), so the social card stays small without external tools
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};

/** Median-cut palette of at most `n` colours from RGBA pixels (alpha ignored: the card is opaque). */
function medianCut(rgba, n) {
  const hist = new Map();
  for (let i = 0; i < rgba.length; i += 4) { const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3); hist.set(k, (hist.get(k) || 0) + 1); }
  let boxes = [{ items: [...hist].map(([k, c]) => ({ r: ((k >> 10) & 31) * 8 + 4, g: ((k >> 5) & 31) * 8 + 4, b: (k & 31) * 8 + 4, c })) }];
  const range = (box, ch) => { let lo = 255, hi = 0; for (const it of box.items) { lo = Math.min(lo, it[ch]); hi = Math.max(hi, it[ch]); } return hi - lo; };
  while (boxes.length < n) {
    let best = -1, bestScore = 0, bestCh = 'r';
    boxes.forEach((box, i) => { if (box.items.length < 2) return; for (const ch of ['r', 'g', 'b']) { const sc = range(box, ch) * Math.sqrt(box.items.reduce((a, it) => a + it.c, 0)); if (sc > bestScore) { bestScore = sc; best = i; bestCh = ch; } } });
    if (best < 0) break;
    const box = boxes[best]; box.items.sort((a, b) => a[bestCh] - b[bestCh]);
    const total = box.items.reduce((a, it) => a + it.c, 0); let acc = 0, cut = 1;
    for (let i = 0; i < box.items.length - 1; i++) { acc += box.items[i].c; if (acc >= total / 2) { cut = i + 1; break; } }
    boxes.splice(best, 1, { items: box.items.slice(0, cut) }, { items: box.items.slice(cut) });
  }
  return boxes.map((box) => { let r = 0, g = 0, b = 0, c = 0; for (const it of box.items) { r += it.r * it.c; g += it.g * it.c; b += it.b * it.c; c += it.c; } return [Math.round(r / c), Math.round(g / c), Math.round(b / c)]; });
}

/** Palette PNG (colour type 3) of RGBA pixels with Floyd-Steinberg dithering. */
export function palettePng(width, height, rgba, colours = 192) {
  const pal = medianCut(rgba, colours);
  const err = new Float32Array(width * 3 * 2); // two rows of error
  let cur = 0;
  const idx = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const next = (cur + 1) % 2; err.fill(0, next * width * 3, (next + 1) * width * 3);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const want = [0, 1, 2].map((c) => Math.max(0, Math.min(255, rgba[o + c] + err[cur * width * 3 + x * 3 + c])));
      let bi = 0, bd = Infinity;
      for (let i = 0; i < pal.length; i++) { const d = (pal[i][0] - want[0]) ** 2 + (pal[i][1] - want[1]) ** 2 + (pal[i][2] - want[2]) ** 2; if (d < bd) { bd = d; bi = i; } }
      idx[y * width + x] = bi;
      for (let c = 0; c < 3; c++) {
        const e = (want[c] - pal[bi][c]) * 0; // damped diffusion keeps flat areas flat
        if (x + 1 < width) err[cur * width * 3 + (x + 1) * 3 + c] += (e * 7) / 16;
        if (x > 0) err[next * width * 3 + (x - 1) * 3 + c] += (e * 3) / 16;
        err[next * width * 3 + x * 3 + c] += (e * 5) / 16;
        if (x + 1 < width) err[next * width * 3 + (x + 1) * 3 + c] += e / 16;
      }
    }
    cur = next;
  }
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = idx.subarray(y * width, (y + 1) * width);
    const prev = y ? idx.subarray((y - 1) * width, y * width) : Buffer.alloc(width);
    const cands = [row, Buffer.from(row.map((v, i) => (v - (i ? row[i - 1] : 0)) & 255)), Buffer.from(row.map((v, i) => (v - prev[i]) & 255))].map((b, f) => Buffer.concat([Buffer.from([f]), b]));
    rows.push(cands.reduce((a, b) => { const cost = (r) => r.reduce((t, v, i) => t + (i ? Math.min(v, 256 - v) : 0), 0); return cost(b) < cost(a) ? b : a; }));
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 3;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(pal.flat())), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------

function readDimensions(file) {
  const b = readFileSync(file);
  if (file.endsWith('.png')) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

function check() {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const files = readdirSync(OUT).filter((f) => f !== 'manifest.json').sort();
  let bad = 0;
  const fail = (t) => { console.error('  ✗ ' + t); bad++; };
  for (const f of files) {
    const e = m.images[f];
    if (!e) { fail(`${f} is not in the manifest`); continue; }
    const size = statSync(path.join(OUT, f)).size;
    if (size !== e.bytes) fail(`${f}: ${size} bytes on disk, ${e.bytes} in the manifest`);
    const d = readDimensions(path.join(OUT, f));
    if (!d || d.width !== e.width || d.height !== e.height) fail(`${f}: dimensions ${JSON.stringify(d)} differ from the manifest (${e.width} x ${e.height})`);
  }
  for (const f of Object.keys(m.images)) if (!existsSync(path.join(OUT, f))) fail(`${f} is in the manifest but not on disk`);
  console.log(bad ? `${bad} problem(s)` : `✓ manifest matches ${files.length} files`);
  process.exit(bad ? 1 : 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) return check();
  const only = new Set(args);
  const want = (name) => only.size === 0 || only.has(name);
  mkdirSync(OUT, { recursive: true });
  if (existsSync(MANIFEST) && only.size) Object.assign(manifest.images, JSON.parse(readFileSync(MANIFEST, 'utf8')).images);

  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--force-color-profile=srgb'] });
  const toolCtx = await browser.newContext();
  const tool = await toolCtx.newPage();
  await tool.goto('about:blank');
  try {
    for (const slot of SLOTS) {
      if (!want(slot.id)) continue;
      console.log(slot.id);
      for (const theme of THEMES) await captureSlot(browser, origin, tool, slot, theme);
    }
    if (want('examples')) { console.log('examples'); for (const theme of THEMES) await captureExamples(browser, origin, tool, theme); }
    if (want('demo-still')) { console.log('demo-still'); await captureDemoStill(browser, origin, tool); }
    if (want('og')) { console.log('og'); await captureOg(browser, tool); }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  const sorted = Object.fromEntries(Object.entries(manifest.images).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(sorted).reduce((a, e) => a + e.bytes, 0);
  writeFileSync(MANIFEST, JSON.stringify({ ...manifest, images: sorted, totalBytes: total }, null, 2) + '\n');
  console.log(`manifest: ${Object.keys(sorted).length} images, ${(total / 1024).toFixed(0)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
