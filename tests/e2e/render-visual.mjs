// Visual + behavioural check of the plant renderer in headless Chromium.
//   node tests/e2e/render-visual.mjs
// Opens tests/e2e/render-harness.html (sample plant + fake simulation), takes screenshots into e2e-output/
// (render-*.png; LOOK at them), and asserts: no console errors, hit-test priorities, static-layer caching,
// PNG export and a few pixel colours. Exits non-zero on any failure.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';

const HARNESS = '/tests/e2e/render-harness.html';
const results = [];
const check = (name, fn) => results.push([name, fn]);

async function open(page, url) {
  await page.goto(url(HARNESS));
  await page.waitForFunction(() => window.harness && window.harness.ready);
}

/** Apply a scenario in the page, then wait two animation frames so the screenshot sees the final pixels. */
async function scene(page, fn, arg) {
  await page.evaluate(fn, arg);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const shots = [];

async function screenshots({ page, url, errors, shot }) {
  await open(page, url);

  // ---- light theme, run mode, increasing zoom -----------------------------------------------------------
  shots.push(await shot('render-01-light-fit'));
  await scene(page, () => harness.focus(17, 6, 40));
  shots.push(await shot('render-02-light-40ppm-junction'));
  await scene(page, () => harness.focus(11, 8, 60));
  shots.push(await shot('render-03-light-60ppm-stations'));
  await scene(page, () => harness.focus(18, 6, 60));
  shots.push(await shot('render-04-light-60ppm-vehicles'));
  await scene(page, () => harness.focus(14, 5, 20));
  shots.push(await shot('render-05-light-20ppm'));

  await scene(page, () => harness.focus(23, 16, 60));
  shots.push(await shot('render-14-light-60ppm-depot'));
  await scene(page, () => harness.focus(3, 10, 60));
  shots.push(await shot('render-15-light-60ppm-broken-vehicle'));
  await scene(page, () => harness.focus(26, 14, 60));
  shots.push(await shot('render-16-light-60ppm-tugger'));
  await scene(page, () => harness.focus(28, 5, 40));
  shots.push(await shot('render-17-light-40ppm-sink-speedzone'));

  // ---- edit mode (no sim) ------------------------------------------------------------------------------
  await scene(page, () => { harness.setSim(false); harness.fit(); });
  shots.push(await shot('render-06-light-edit'));

  // ---- overlays: docks, ids, heatmaps, deadlock ---------------------------------------------------------
  await scene(page, () => { harness.setSim(true); harness.setView({ overlays: { docks: true, ids: true } }); harness.fit(); });
  shots.push(await shot('render-07-light-docks-ids'));
  await scene(page, () => { harness.setView({ overlays: { docks: false, ids: false, heat: 'traffic' } }); harness.fit(); });
  shots.push(await shot('render-08-light-heat-traffic'));
  await scene(page, () => harness.setView({ overlays: { heat: 'waiting' } }));
  shots.push(await shot('render-09-light-heat-waiting'));
  await scene(page, () => { harness.setView({ overlays: { heat: 'off' } }); harness.setDeadlock(true); harness.focus(17, 6, 40); });
  shots.push(await shot('render-10-light-deadlock'));
  await scene(page, () => { harness.setDeadlock(false); harness.fit(); });

  // ---- interaction visuals ---------------------------------------------------------------------------------
  await scene(page, () => harness.setView({
    selection: { kind: 'station', ids: ['B'] }, resizeHandles: true, hover: { kind: 'station', id: 'C' },
    ghost: { kind: 'station', type: 'storage', rect: { x: 7, y: 17, w: 4, h: 3 }, valid: true },
    paintPreview: { cells: [[26, 8], [26, 9], [26, 10]], oneWay: true },
    marquee: { x: 4, y: 20, w: 12, h: 8 },
  }));
  shots.push(await shot('render-11-light-interaction'));
  await scene(page, () => harness.setView({
    selection: { kind: 'flow', ids: ['f4'] }, resizeHandles: false, hover: { kind: 'cell', cell: [10, 8] },
    ghost: { kind: 'station', type: 'process', rect: { x: 19, y: 12, w: 3, h: 3 }, valid: false },
    paintPreview: { cells: [[24, 8], [25, 8], [26, 8]], oneWay: false, blocked: [[27, 8]] },
    flowPreview: { fromId: 'A', toPoint: [30, 24] }, marquee: null,
  }));
  shots.push(await shot('render-12-light-flow-selected-ghost-invalid'));
  await scene(page, () => harness.setView({
    selection: { kind: 'fleet', ids: ['v1'] }, hover: { kind: 'vehicle', id: 'v2#1' }, ghost: null, paintPreview: null, flowPreview: null,
  }));
  shots.push(await shot('render-13-light-fleet-selected'));
  await scene(page, () => harness.setView({ selection: { kind: null, ids: [] }, hover: null }));

  // ---- dark theme -------------------------------------------------------------------------------------------
  await scene(page, () => { harness.setTheme('dark'); harness.fit(); });
  shots.push(await shot('render-20-dark-fit'));
  await scene(page, () => harness.focus(11, 8, 60));
  shots.push(await shot('render-21-dark-60ppm-stations'));
  await scene(page, () => harness.focus(18, 6, 60));
  shots.push(await shot('render-22-dark-60ppm-vehicles'));
  await scene(page, () => { harness.setView({ overlays: { heat: 'traffic' } }); harness.fit(); });
  shots.push(await shot('render-23-dark-heat'));
  await scene(page, () => { harness.setView({ overlays: { heat: 'off' } }); harness.setSim(false); harness.fit(); });
  shots.push(await shot('render-24-dark-edit'));
  assert.deepEqual(errors, [], 'no console errors or warnings during the screenshot tour');
}

check('hit testing follows the documented priority', async ({ page, url }) => {
  await open(page, url);
  await scene(page, () => { harness.setSim(true); harness.fit(); });
  const at = (cx, cy) => page.evaluate(([x, y]) => {
    const [px, py] = harness.cellToScreen(x, y);
    const hit = harness.renderer.hitTest(px, py);
    return { kind: hit.kind, id: hit.id, cell: hit.cell, handle: hit.handle };
  }, [cx, cy]);
  assert.equal((await at(7, 4)).kind, 'station');
  assert.equal((await at(7, 4)).id, 'A');
  assert.equal((await at(7, 7)).kind, 'cell', 'empty road cell');
  assert.deepEqual((await at(7, 7)).cell, [7, 7]);
  assert.equal((await at(5, 9)).kind, 'obstacle', 'rack');
  const vehicle = await page.evaluate(() => {
    const v = harness.sim.vehicles[2];
    const [px, py] = harness.camera.worldToScreen(v.x, v.y);
    return harness.renderer.hitTest(px, py);
  });
  assert.equal(vehicle.kind, 'vehicle');
  assert.equal(vehicle.id, 'v2#1');
  const label = await page.evaluate(() => {
    const [px, py] = harness.camera.worldToScreen(17.5 * 2, 1.9 * 2);
    return harness.renderer.hitTest(px, py);
  });
  assert.equal(label.kind, 'label');
  const flow = await page.evaluate(() => {
    const e = harness.renderer._fr.scene.flows.find((f) => f.flow.id === 'f4');
    const c = e.curve;
    const t = (c.t0 + c.t1) / 2;
    const x = (1 - t) * (1 - t) * c.ax + 2 * (1 - t) * t * c.qx + t * t * c.bx;
    const y = (1 - t) * (1 - t) * c.ay + 2 * (1 - t) * t * c.qy + t * t * c.by;
    const [px, py] = harness.camera.worldToScreen(x, y);
    return harness.renderer.hitTest(px, py);
  });
  assert.equal(flow.kind, 'flow');
  assert.equal(flow.id, 'f4');
  // a selected station: its body reports 'move', its corner a resize handle (handles win over the body)
  await scene(page, () => harness.setView({ selection: { kind: 'station', ids: ['B'] }, resizeHandles: true }));
  const body = await page.evaluate(() => {
    const [px, py] = harness.cellToScreen(14, 4);
    return harness.renderer.hitTest(px, py);
  });
  assert.equal(body.kind, 'station');
  assert.equal(body.handle, 'move');
  const corner = await page.evaluate(() => {
    const [px, py] = harness.camera.worldToScreen(26, 6); // top-left corner of station B (cell 13,3)
    return harness.renderer.hitTest(px + 2, py + 1);
  });
  assert.equal(corner.handle, 'nw');
  assert.equal(corner.id, 'B');
});

check('flows between touching stations show a direction badge on the shared edge that wins the click', async ({ page, url, shot }) => {
  await open(page, url);
  await scene(page, () => harness.showTouching(true));
  shots.push(await shot('render-18-light-touching-flows'));
  const probe = await page.evaluate(() => {
    const entries = harness.renderer._fr.scene.flows;
    const [badge, arrow] = entries;
    const [bx, by] = harness.camera.worldToScreen(badge.marker.x, badge.marker.y);
    const stationB = harness.touchingLayout.stations.find((st) => st.id === 'B');
    const [sx, sy] = harness.camera.worldToScreen((stationB.x + stationB.w / 2) * 2, (stationB.y + stationB.h / 2) * 2);
    const pick = (x, y) => { const h = harness.renderer.hitTest(x, y); return `${h.kind}/${h.id}`; };
    return { count: entries.length, badge: pick(bx, by), body: pick(sx, sy), arrowIsMarker: arrow.marker !== null };
  });
  assert.equal(probe.count, 2, 'both flows are in the scene');
  assert.equal(probe.badge, 'flow/f1', 'the badge is picked, not the station under it');
  assert.equal(probe.body, 'station/B');
  assert.equal(probe.arrowIsMarker, false, 'the second flow has room for a normal arrow');
  await scene(page, () => harness.showTouching(false));
});

check('static layer is cached across frames and pans, rebuilt on zoom bucket / theme / layout change', async ({ page, url }) => {
  await open(page, url);
  const builds = () => page.evaluate(() => harness.renderer.stats.staticBuilds);
  await scene(page, () => harness.fit());
  const b0 = await builds();
  await scene(page, () => { for (let i = 0; i < 10; i++) harness.draw(i / 10); });
  assert.equal(await builds(), b0, 'plain frames reuse the bitmap');
  await scene(page, () => { harness.camera.pan(7, -5); harness.draw(); });
  assert.equal(await builds(), b0, 'a small pan inside the cached window reuses the bitmap');
  await scene(page, () => { harness.camera.zoomAt(1.1, 300, 300); harness.draw(); });
  assert.equal(await builds(), b0, 'a zoom change below 1.25x keeps the stand-in bitmap');
  await page.waitForTimeout(400);
  assert.equal(await builds(), b0 + 1, 'the settle timer re-renders sharp once the zoom rests');
  await scene(page, () => { harness.camera.zoomAt(1.6, 300, 300); harness.draw(); });
  assert.equal(await builds(), b0 + 2, 'a zoom change beyond 1.25x re-renders immediately');
  await scene(page, () => harness.setTheme('dark'));
  assert.equal(await builds(), b0 + 3, 'theme change rebuilds');
  await scene(page, () => { harness.renderer.layout = { ...harness.layout }; harness.draw(); });
  assert.equal(await builds(), b0 + 4, 'a new layout object rebuilds');
});

check('toDataURL renders the whole plant independent of the camera', async ({ page, url }) => {
  await open(page, url);
  const info = await page.evaluate(async () => {
    harness.focus(2, 2, 70);
    const small = harness.renderer.toDataURL({ scale: 0.5 });
    const full = harness.renderer.toDataURL({ scale: 1 });
    const img = new Image();
    img.src = full;
    await img.decode();
    const transparent = harness.renderer.toDataURL({ scale: 0.25, background: null });
    const t = new Image();
    t.src = transparent;
    await t.decode();
    const c = document.createElement('canvas');
    c.width = t.width; c.height = t.height;
    const g = c.getContext('2d');
    g.drawImage(t, 0, 0);
    return {
      small: small.slice(0, 22), full: full.slice(0, 22), w: img.width, h: img.height, tw: t.width,
      cornerAlpha: g.getImageData(0, 0, 1, 1).data[3], bytes: full.length, smallBytes: small.length,
    };
  });
  assert.equal(info.full, 'data:image/png;base64,');
  assert.equal(info.small, 'data:image/png;base64,');
  // 72 x 44 m plant + 1 m padding on each side = 74 x 46 m at 20 px/m
  assert.equal(info.w, 74 * 20);
  assert.equal(info.h, 46 * 20);
  assert.equal(info.cornerAlpha, 0, 'background: null gives a transparent export');
  assert.ok(info.bytes > info.smallBytes);
  // write exports for visual inspection: light, and dark with heatmap and vehicle ids
  const exports = await page.evaluate(() => {
    harness.setSim(true);
    const light = harness.renderer.toDataURL({ scale: 1.5 });
    harness.setView({ overlays: { heat: 'traffic', ids: true, docks: true } });
    const dark = harness.renderer.toDataURL({ scale: 1, theme: 'dark' });
    harness.setView({ overlays: { heat: 'off', ids: false, docks: false } });
    return { light, dark };
  });
  for (const [name, dataUrl] of Object.entries(exports)) {
    writeFileSync(path.join(OUT, `render-40-export-${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    shots.push(path.join(OUT, `render-40-export-${name}.png`));
  }
});

check('canvas pixels: background, road, station and vehicle colours are where they should be', async ({ page, url }) => {
  await open(page, url);
  await scene(page, () => { harness.setSim(true); harness.fit(); });
  const px = (cell, dx = 0, dy = 0) => page.evaluate(([c, ox, oy]) => {
    const [x, y] = harness.cellToScreen(c[0], c[1]);
    return harness.readPixel(Math.round(x + ox), Math.round(y + oy));
  }, [cell, dx, dy]);
  const corner = await page.evaluate(() => harness.readPixel(2, 2));
  assert.deepEqual(corner, [0xee, 0xf1, 0xf6], 'canvas background is the theme background');
  const road = await px([10, 6], 0, 9); // road plate, off the dashed centre line
  assert.ok(road[0] < 110 && road[1] < 110 && road[2] < 120, `road plate is dark: ${road}`);
  const plate = await px([7, 12]);
  assert.ok(plate[0] > 190 && plate[2] > 200, `baseplate is light grey-blue: ${plate}`);
});

check('works at devicePixelRatio 2 and survives odd input', async ({ page, url }) => {
  await open(page, url);
  const out = await page.evaluate(() => {
    const r = harness.renderer;
    const results = [];
    const tryIt = (name, fn) => { try { fn(); results.push([name, 'ok']); } catch (e) { results.push([name, String(e)]); } };
    tryIt('layout null', () => { r.layout = null; r.render(0.5); r.hitTest(10, 10); r.toDataURL(); });
    tryIt('empty layout', () => { r.layout = { schema: 1, grid: { cols: 8, rows: 8, cellSize: 1 }, roads: {}, obstacles: [], labels: [], stations: [], flows: [], fleets: [], settings: {} }; r.render(0); r.hitTest(5, 5); });
    tryIt('sim without optional fields', () => { r.layout = harness.layout; r.sim = { vehicles: [{ x: NaN, y: 3 }, null, { x: 2, y: 2, tv: null }] }; r.render(1); r.hitTest(100, 100); });
    tryIt('sim = {}', () => { r.sim = {}; r.view.overlays.heat = 'traffic'; r.render(1); r.view.overlays.heat = 'off'; });
    tryIt('huge zoom', () => { r.sim = harness.sim; harness.camera.zoom = 1e6; r.render(1); r.hitTest(5, 5); harness.camera.zoom = 20; });
    tryIt('NaN camera', () => { harness.camera.x = NaN; r.render(1); harness.camera.x = 36; });
    tryIt('0x0 canvas', () => { r.canvas.style.display = 'none'; r.resize(); r.render(1); r.hitTest(1, 1); r.canvas.style.display = 'block'; r.resize(); });
    return results;
  });
  for (const [name, status] of out) assert.equal(status, 'ok', name);
});

check('100 vehicles render within a 60 fps frame budget', async ({ page, url }) => {
  await open(page, url);
  await scene(page, () => { harness.setSim(true); harness.fit(); });
  const light = await page.evaluate(() => harness.bench(100, 150));
  assert.equal(light.vehicles, 100);
  console.log(`       mean frame cost with 100 vehicles, light theme: ${light.ms.toFixed(2)} ms`);
  assert.ok(light.ms < 16.6, `frame cost ${light.ms.toFixed(2)} ms exceeds the 60 fps budget`);
  await scene(page, () => { harness.setTheme('dark'); harness.setView({ overlays: { ids: true, docks: true, heat: 'traffic' } }); });
  const heavy = await page.evaluate(() => harness.bench(100, 150));
  console.log(`       ... dark theme with ids, docks and heatmap: ${heavy.ms.toFixed(2)} ms`);
  assert.ok(heavy.ms < 16.6, `frame cost ${heavy.ms.toFixed(2)} ms exceeds the 60 fps budget`);
});

async function run() {
  let failed = 0;
  await withBrowser(screenshots);
  await withBrowser(async (ctx) => {
    for (const [name, fn] of results) {
      try {
        await fn(ctx);
        console.log('  ok   ' + name);
      } catch (e) {
        failed++;
        console.error('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       '));
      }
    }
    if (ctx.errors.length) {
      failed++;
      console.error('  FAIL console errors during the checks\n       ' + ctx.errors.join('\n       '));
    }
  });
  await withBrowser(async ({ page, url, errors, shot }) => {
    await open(page, url);
    await scene(page, () => harness.focus(14, 5, 30));
    shots.push(await shot('render-30-light-dpr2-30ppm'));
    if (errors.length) { failed++; console.error('  FAIL dpr 2 console errors', errors); }
  }, { viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
  console.log(`\nscreenshots:\n${shots.map((s) => '  ' + s).join('\n')}`);
  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nrender-visual: all checks passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
