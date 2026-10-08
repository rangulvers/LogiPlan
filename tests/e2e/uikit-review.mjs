// Independent review of the UI kit in a real browser (run by hand: node tests/e2e/uikit-review.mjs).
//
// tests/e2e/uikit-visual.mjs proves that the kit renders and that text contrast passes. This script goes after what that
// script does not measure, and exits non-zero while any of it is broken. Every finding carries a severity:
//   high    broken, illegible or inaccessible      medium  unpolished, inconsistent or wrong docs      low  nit
//
// Areas (each runs in its own browser so state cannot leak):
//   1  forced colours   Windows high-contrast: do switches, checkboxes, pressed states, sliders and focus survive?
//   2  keyboard         focus survives a legend toggle; every focusable shows a focus change (light, dark and forced colours)
//   3  icons            bounding boxes, near-duplicates, 16 px legibility; writes contact sheets to e2e-output/
//   4  chart edge cases canvas text is recorded while charts are fed empty / NaN / huge / negative / long data at several widths
//   5  chart lifecycle  destroy() leaves no observers, listeners or frames; resize, hidden-then-shown, tooltips at the edges
//   6  pixel ratios     hairlines stay crisp at 1, 1.25, 1.5, 2 and 3 device pixels per CSS pixel
//   7  touch and layout coarse-pointer target sizes, reduced motion, native <dialog>, overlays at 390 px, control heights
//   8  print            charts redraw in the light palette
// Pure-maths property tests, docs-versus-code checks and token contrast maths are in tests/ui.charts.review.test.js.
//
// LOOK at the PNGs it writes (e2e-output/uikit-review-*.png): this script cannot judge taste.
import { withBrowser, OUT } from './browser.mjs';
import path from 'node:path';

const findings = [];
const notes = [];
/** Records a finding when `ok` is false. Messages should say what was measured. */
const defect = (severity, area, ok, message) => { if (!ok) findings.push({ severity, area, message }); };
const png = (name) => path.join(OUT, `uikit-review-${name}.png`);
const DEMO = '/tests/e2e/uikit-demo.html';

/** Opens the demo page in a theme and waits until fonts, icons and charts are ready. */
async function openDemo(page, url, theme, { stable = true } = {}) {
  await page.goto(url(`${DEMO}?theme=${theme}`));
  await page.waitForFunction(() => window.__demoReady === true);
  await page.addStyleTag({ content: `.demo-header { position: static !important; }${stable ? ' *, *::before, *::after { transition: none !important; animation: none !important; }' : ''}` });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

/** PNG bytes of a locator or element handle (plus a 2 px margin); equal bytes mean equal pixels. */
async function pixels(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  return page.screenshot({ clip: { x: Math.max(0, b.x - 2), y: Math.max(0, b.y - 2), width: b.width + 4, height: b.height + 4 } });
}

/**
 * Number of pixels whose colour changed by at least `minRatio`:1 in WCAG contrast between two equally sized screenshots.
 * An indicator that moves a black border to dark navy changes bytes but not what a person sees; this counts what is visible.
 */
async function contrastingPixels(page, before, after, minRatio = 3) {
  return page.evaluate(async ([a, b, min]) => {
    const decode = async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    };
    const [A, B] = [await decode(a), await decode(b)];
    if (A.width !== B.width || A.height !== B.height) return -1;
    const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (d, i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
    let count = 0;
    for (let i = 0; i < A.data.length; i += 4) {
      const [hi, lo] = [lum(A.data, i), lum(B.data, i)].sort((x, y) => y - x);
      if ((hi + 0.05) / (lo + 0.05) >= min) count++;
    }
    return count;
  }, [before.toString('base64'), after.toString('base64'), minRatio]);
}

// ======================================================================================================================
// 1  forced colours
// ======================================================================================================================

async function reviewForcedColors() {
  await withBrowser(async ({ page, url }) => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
      await openDemo(page, url, scheme);
      const active = await page.evaluate(() => matchMedia('(forced-colors: active)').matches);
      defect('low', 'forced-colors', active, 'could not emulate forced colours');
      if (scheme === 'light') {
        for (const s of ['buttons', 'forms', 'data']) await page.locator(`section[data-shot="${s}"]`).screenshot({ path: png(`forced-${s}`) });
      }
      const tag = `forced colours (${scheme})`;
      /** True when changing `mutate` changes how `locator` looks. */
      const looksDifferent = async (locator, mutate) => {
        const handle = await locator.elementHandle(); // resolved once: the mutation may stop the selector from matching
        const before = await pixels(page, handle);
        await handle.evaluate(mutate);
        await page.waitForTimeout(30);
        const after = await pixels(page, handle);
        return (await contrastingPixels(page, before, after)) >= 12;
      };

      const checkbox = page.locator('.check input[type=checkbox]').first();
      defect('high', tag, await looksDifferent(checkbox, (el) => { el.checked = !el.checked; }), 'a checked checkbox looks the same as an unchecked one (white tick on the forced canvas colour)');
      const indeterminate = page.locator('#chk-ind');
      defect('high', tag, await looksDifferent(indeterminate, (el) => { el.indeterminate = false; }), 'an indeterminate checkbox looks the same as an unchecked one');

      const track = page.locator('.switch__track').first();
      const trackShot = await pixels(page, track);
      const box = await track.boundingBox();
      const blank = await page.screenshot({ clip: { x: 4, y: Math.max(0, box.y - 2), width: box.width + 4, height: box.height + 4 } });
      defect('high', tag, Buffer.compare(trackShot, blank) !== 0, 'the switch track is invisible: background-only controls vanish, so switches show only their label');
      defect('high', tag, await looksDifferent(page.locator('.switch').first(), (el) => { const i = el.querySelector('input'); i.checked = !i.checked; }), 'switch on and off look identical');

      const segmented = page.locator('.segmented__item[aria-pressed="true"]').first();
      defect('high', tag, await looksDifferent(segmented, (el) => el.setAttribute('aria-pressed', 'false')), 'the selected segment of a segmented control is not distinguishable from the others');
      const toolButton = page.locator('.toolbar .btn[aria-pressed="true"]').first();
      defect('high', tag, await looksDifferent(toolButton, (el) => el.setAttribute('aria-pressed', 'false')), 'a pressed toolbar button looks like an unpressed one (tool selection, overlay toggles)');
      const tab = page.locator('.tab[aria-selected="true"]').first();
      defect('medium', tag, await looksDifferent(tab, (el) => el.setAttribute('aria-selected', 'false')), 'the selected tab is not distinguishable (underline is a background)');

      const range = page.locator('#r-demand');
      const rb = await range.boundingBox();
      const rail = { x: rb.x + 4, y: rb.y + rb.height / 2 - 3, width: 60, height: 6 };
      const railShot = await page.screenshot({ clip: rail });
      const emptyShot = await page.screenshot({ clip: { ...rail, x: 4 } });
      defect('high', tag, Buffer.compare(railShot, emptyShot) !== 0, 'the slider rail (a gradient background) is invisible; only the thumb remains');

      const progress = page.locator('.progress').first();
      defect('medium', tag, await looksDifferent(progress, (el) => { el.firstElementChild.style.setProperty('--w', '0%'); }), 'the filled part of a progress bar is invisible');

      // focus indicators that rely on box-shadow or border-colour only
      const focusProbes = { '.input': '#f-name', '.input-group': '#f-cycle', '.stepper': '#f-count', 'range slider': '#r-demand' };
      for (const [what, selector] of Object.entries(focusProbes)) {
        const el = page.locator(selector);
        await page.mouse.move(0, 0);
        await el.evaluate((n) => n.blur());
        const target = what === 'range slider' ? el : what === '.input' ? el : el.locator('xpath=ancestor-or-self::*[contains(@class,"input-group") or contains(@class,"stepper")][1]');
        const before = await pixels(page, target);
        await el.evaluate((n) => n.focus({ focusVisible: true }));
        await page.waitForTimeout(30);
        const after = await pixels(page, target);
        defect('high', tag, (await contrastingPixels(page, before, after, 2)) >= 40, `keyboard focus on ${what} is invisible (outline removed, indicator is a box-shadow / border colour that forced colours discards)`);
      }
    }
  });
}

// ======================================================================================================================
// 2  keyboard
// ======================================================================================================================

async function reviewKeyboard() {
  await withBrowser(async ({ page, url }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await openDemo(page, url, 'light');

    // A legend toggle is a button; operating it must not throw focus back to the page start.
    const legend = page.locator('#c-line .chart-legend__item').first();
    await legend.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, legend: document.activeElement?.classList.contains('chart-legend__item') }));
    defect('high', 'keyboard', focus.legend, `after toggling a series with the keyboard focus moved to <${focus.tag?.toLowerCase()}> (the legend is rebuilt on every toggle), so each further toggle starts again from the top of the page`);
    const pressed = await page.locator('#c-line .chart-legend__item').first().getAttribute('aria-pressed');
    defect('medium', 'keyboard', pressed === 'false', `Enter on a legend entry did not hide its series (aria-pressed=${pressed})`);

    // Every focusable control shows a visible focus change (at least 40 pixels change by 2:1 or more), in both themes and in forced colours.
    for (const [scheme, forced] of [['light', false], ['dark', false], ['light', true]]) {
      await page.emulateMedia({ colorScheme: scheme, forcedColors: forced ? 'active' : 'none', reducedMotion: 'reduce' });
      await openDemo(page, url, scheme);
      const handles = await page.locator('a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]').elementHandles();
      const invisible = [];
      let checked = 0;
      for (const handle of handles) {
        if (!(await handle.isVisible())) continue;
        await handle.scrollIntoViewIfNeeded();
        const box = await handle.boundingBox();
        if (!box || box.width < 2) continue;
        const clip = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 };
        await page.mouse.move(0, 0);
        await handle.evaluate((el) => el.blur());
        const before = await page.screenshot({ clip });
        await handle.evaluate((el) => el.focus({ focusVisible: true }));
        await page.waitForTimeout(15);
        const after = await page.screenshot({ clip });
        checked++;
        if ((await contrastingPixels(page, before, after, 2)) < 40) invisible.push(await handle.evaluate((el) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''}${el.id ? '#' + el.id : ''}${el.className ? '' : ` in .${String(el.parentElement?.className).trim().split(/\s+/)[0]}[${el.type}${el.checked ? ' checked' : ''}]`}`));
      }
      if (!forced) {
        const invalid = invisible.filter((name) => name.includes('#f-cap'));
        const onInverse = invisible.filter((name) => name.includes('toast__'));
        const sliders = invisible.filter((name) => name.includes('.range['));
        const rest = invisible.filter((name) => !invalid.includes(name) && !onInverse.includes(name) && !sliders.includes(name));
        defect('medium', `focus ring (${scheme})`, sliders.length === 0, 'a slider without a value bubble (no data-value) shows keyboard focus only as a 1 px thumb border change plus a 28 % glow; the track has no outline (the bubble hides this in the demo)');
        defect('high', `focus ring (${scheme})`, rest.length === 0, `${rest.length} of ${checked} focusable controls show no visible focus change: ${rest.slice(0, 5).join(', ')}`);
        defect('medium', `focus ring (${scheme})`, invalid.length === 0, 'an invalid field (.field.is-invalid) keeps its red border on focus and adds only a --bad-soft halo (about 1.1:1), so keyboard focus is nearly invisible exactly where the user must fix something');
        defect('medium', `focus ring (${scheme})`, onInverse.length === 0, `the focus ring on buttons inside a toast (${onInverse.join(', ')}) is the plain --accent on --inverse-bg, which is the light surface in the dark theme (2.3:1)`);
      }
      else notes.push(`forced colours: ${invisible.length} of ${checked} focusable controls show no visible focus change (${[...new Set(invisible.map((s) => s.split('.')[0] + '.' + (s.split('.')[1] ?? '')))].join(', ')})`);
    }

    // Charts: the canvas is focusable and role="img" (an image that takes keys); the accessible name must say how to use it.
    await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none', reducedMotion: 'no-preference' });
    await openDemo(page, url, 'light');
    const roles = await page.evaluate(() => [...document.querySelectorAll('canvas[tabindex="0"]')].map((c) => ({ role: c.getAttribute('role'), described: Boolean(c.getAttribute('aria-describedby') || c.getAttribute('aria-roledescription') || c.getAttribute('aria-keyshortcuts')) })));
    defect('low', 'a11y', !roles.some((r) => r.role === 'img' && !r.described), `${roles.filter((r) => r.role === 'img' && !r.described).length} focusable chart canvases are role="img" with no hint that arrow keys explore them (aria-roledescription / aria-describedby)`);

    // A series hidden through the legend must stay readable: struck-through text is still text of an enabled control.
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await openDemo(page, url, scheme);
      await page.locator('#c-line .chart-legend__item').nth(1).click();
      await page.mouse.move(0, 0); // the rebuilt entry sits under the pointer; measure it without the hover colour
      await page.waitForTimeout(80);
      const ratio = await page.evaluate(() => {
        const el = document.querySelector('#c-line .chart-legend__item[aria-pressed="false"]');
        const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m[1].split(/[\s,/]+/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
        const lum = ({ r, g, b }) => { const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        let opacity = 1;
        let bg = { r: 255, g: 255, b: 255 };
        for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
        for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a === 1) { bg = c; break; } }
        const fg = parse(getComputedStyle(el).color);
        const mixed = { r: fg.r * opacity + bg.r * (1 - opacity), g: fg.g * opacity + bg.g * (1 - opacity), b: fg.b * opacity + bg.b * (1 - opacity) };
        const [hi, lo] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
        return (hi + 0.05) / (lo + 0.05);
      });
      defect('medium', `contrast (${scheme})`, ratio >= 4.5, `legend entry of a hidden series has ${ratio.toFixed(2)}:1 text contrast (opacity 0.45 plus line-through); the entry is still an enabled button`);
    }
  });
}

// ======================================================================================================================
// 3  icons
// ======================================================================================================================

async function reviewIcons() {
  await withBrowser(async ({ page, url }) => {
    await openDemo(page, url, 'light');
    const result = await page.evaluate(async () => {
      const { iconSvg, ICON_NAMES } = await import('/js/ui/icons.js');
      const load = (svg) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
      // `small` draws the art that is used at 16 px (the simplified variants), magnified to `size`
      const ink = async (name, size, small = false) => {
        const markup = small ? iconSvg(name, { size: 16 }).replace('width="16" height="16"', `width="${size}" height="${size}"`) : iconSvg(name, { size });
        const img = await load(markup.replace('currentColor', '#000'));
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const mask = new Uint8Array(size * size);
        for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 100 ? 1 : 0;
        return { mask, canvas };
      };
      const S = 96;
      const metrics = [];
      const masks = {};
      for (const name of ICON_NAMES) {
        const { mask } = await ink(name, S);
        let x0 = S; let y0 = S; let x1 = -1; let y1 = -1;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (mask[y * S + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        masks[name] = mask;
        metrics.push({ name, left: x0 / 4, right: (x1 + 1) / 4, top: y0 / 4, bottom: (y1 + 1) / 4, cx: (x0 + x1 + 1) / 8, cy: (y0 + y1 + 1) / 8 });
      }
      const pairs = [];
      for (let i = 0; i < ICON_NAMES.length; i++) for (let j = i + 1; j < ICON_NAMES.length; j++) {
        const a = masks[ICON_NAMES[i]]; const b = masks[ICON_NAMES[j]];
        let both = 0; let either = 0;
        for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) both++; if (a[k] || b[k]) either++; }
        pairs.push([ICON_NAMES[i], ICON_NAMES[j], both / either]);
      }
      pairs.sort((p, q) => q[2] - p[2]);
      // Gap filling at 16 px: close the mask with a disk worth 1.5 icon units (about 1 px at 16 px); ink gained = strokes closer than that.
      const G = 192;
      const unit = G / 24;
      const radius = Math.round(0.75 * unit);
      const disk = [];
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= radius * radius) disk.push([dx, dy]);
      const morph = (m, grow) => {
        const out = new Uint8Array(G * G);
        for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
          let v = grow ? 0 : 1;
          for (const [dx, dy] of disk) {
            const xx = x + dx; const yy = y + dy;
            const on = xx < 0 || yy < 0 || xx >= G || yy >= G ? (grow ? 0 : 1) : m[yy * G + xx];
            if (grow && on) { v = 1; break; }
            if (!grow && !on) { v = 0; break; }
          }
          out[y * G + x] = v;
        }
        return out;
      };
      const fill = {};
      for (const name of ICON_NAMES) {
        const { mask } = await ink(name, G, true);
        const closed = morph(morph(mask, true), false);
        let added = 0; let had = 0;
        for (let i = 0; i < mask.length; i++) { if (mask[i]) had++; else if (closed[i]) added++; }
        fill[name] = added / had;
      }
      // contact sheet: every icon at 16 px and 24 px, magnified without smoothing so single pixels are visible
      document.body.innerHTML = '<div id="sheet" style="display:grid;grid-template-columns:repeat(6,max-content);gap:6px;padding:8px;background:#fff;font:11px sans-serif"></div>';
      for (const name of ICON_NAMES) {
        const cell = document.createElement('div');
        cell.style.cssText = 'border:1px solid #ddd;padding:4px;display:flex;flex-direction:column;align-items:center;gap:3px';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center';
        for (const [size, zoom] of [[16, 6], [24, 4]]) {
          const small = document.createElement('canvas');
          small.width = size; small.height = size;
          const sctx = small.getContext('2d');
          const img = await load(iconSvg(name, { size }).replace('currentColor', '#1c2230'));
          sctx.drawImage(img, 0, 0, size, size);
          const big = document.createElement('canvas');
          big.width = size * zoom; big.height = size * zoom;
          const bctx = big.getContext('2d');
          bctx.imageSmoothingEnabled = false;
          bctx.drawImage(small, 0, 0, big.width, big.height);
          big.style.outline = '1px solid #eee';
          row.append(big);
        }
        const label = document.createElement('div');
        label.textContent = name;
        cell.append(row, label);
        document.getElementById('sheet').append(cell);
      }
      return { metrics, pairs: pairs.slice(0, 6), fill };
    });
    await page.locator('#sheet').screenshot({ path: png('icons-16-and-24px') });

    const off = (m) => Math.max(Math.abs(m.cx - 12), Math.abs(m.cy - 12));
    // A cursor is asymmetric by nature; everything else should sit within 1 icon unit of the optical centre of the grid.
    const decentred = result.metrics.filter((m) => m.name !== 'select' && off(m) > 1);
    defect('low', 'icons', decentred.length === 0, `icons off-centre by more than 1 unit (bounding-box centre): ${decentred.map((m) => `${m.name} (${m.cx.toFixed(2)}, ${m.cy.toFixed(2)})`).join(', ')}`);
    const outside = result.metrics.filter((m) => m.left < 1 || m.top < 1 || m.right > 23 || m.bottom > 23);
    defect('medium', 'icons', outside.length === 0, `icons touch the edge of the 24 px grid (live area is 1..23): ${outside.map((m) => m.name).join(', ')}`);
    defect('medium', 'icons', result.pairs[0][2] < 0.97, `two icons are nearly identical: ${result.pairs[0].join(' / ')}`);
    const dense = Object.entries(result.fill).filter(([, v]) => v > 0.15).map(([name, v]) => `${name} ${(v * 100).toFixed(0)} %`);
    defect('medium', 'icons', dense.length === 0, `strokes closer than ~1 px at 16 px merge into a blob (visual review of the 16 px sheet also finds depot (P plus bolt), speedzone, oneway (arrowhead), forklift and export/import (arrow direction) muddy; share of ink gained by closing 1.5-unit gaps; median ${(Object.values(result.fill).sort((a, b) => a - b)[34] * 100).toFixed(1)} %): ${dense.join(', ')}`);
    notes.push(`icons: closest pair ${result.pairs[0].slice(0, 2).join('/')} IoU ${result.pairs[0][2].toFixed(2)}; contact sheet ${png('icons-16-and-24px')}`);
  });
}

// ======================================================================================================================
// 4  chart edge cases (canvas text is recorded while drawing)
// ======================================================================================================================

/** Installed before any page script: remembers every fillText per canvas frame (a frame starts with clearRect(0, 0, ...)). */
function installTextRecorder() {
  const proto = CanvasRenderingContext2D.prototype;
  const clear = proto.clearRect;
  const fill = proto.fillText;
  proto.clearRect = function (x, y, w, h) { if (x === 0 && y === 0) this.canvas.__texts = []; return clear.call(this, x, y, w, h); };
  proto.fillText = function (text, x, y, maxWidth) {
    (this.canvas.__texts ||= []).push({ text: String(text), x, y, align: this.textAlign, base: this.textBaseline, font: this.font, w: this.measureText(String(text)).width });
    return fill.call(this, text, x, y, maxWidth);
  };
}

/** Runs in the page: mounts a chart from source text in a container of the given width and reports text boxes and DOM facts. */
async function mountAndMeasure({ kind, optionsSource, width }) {
  const mod = await import('/js/ui/charts.js');
  const factory = { line: mod.createLineChart, bar: mod.createBarChart, stack: mod.createStackedBar, spark: mod.createSparkline, gauge: mod.createGauge }[kind];
  const host = document.createElement('div');
  host.id = '__case';
  host.style.cssText = `width:${width}px;position:relative;background:var(--surface)`;
  document.body.append(host);
  const errors = [];
  const onError = (e) => errors.push(e.message || String(e));
  window.addEventListener('error', onError);
  let chart = null;
  try { chart = factory(new Function(`return (${optionsSource});`)()); host.append(chart.el); } catch (e) { errors.push(`create: ${e.message}`); }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))));
  window.removeEventListener('error', onError);
  window.__chart = chart;
  const texts = [];
  for (const canvas of host.querySelectorAll('canvas')) {
    if (canvas.hidden) continue;
    for (const t of canvas.__texts || []) {
      const size = Number((t.font.match(/(\d+(?:\.\d+)?)px/) || [])[1]) || 11;
      const x0 = t.align === 'center' ? t.x - t.w / 2 : t.align === 'right' || t.align === 'end' ? t.x - t.w : t.x;
      const [y0, y1] = t.base === 'middle' ? [t.y - size / 2, t.y + size / 2] : t.base === 'top' || t.base === 'hanging' ? [t.y, t.y + size] : t.base === 'bottom' ? [t.y - size, t.y] : [t.y - size * 0.8, t.y + size * 0.2];
      texts.push({ text: t.text, x0, x1: x0 + t.w, y0, y1, W: canvas.clientWidth, H: canvas.clientHeight });
    }
  }
  return { errors, texts, scrollWidth: host.scrollWidth, clientWidth: host.clientWidth };
}

const series = (name, y, extra = '') => `{ name: '${name}', y: ${y}${extra} }`;
const many = (n, fn) => `Array.from({ length: ${n} }, (_, i) => ${fn})`;
/**
 * [name, kind, options as source text, widths, what a failure means, severity].
 * Cases marked "guard" pass today and keep passing; the others pin down a defect.
 */
const CHART_CASES = [
  // line
  ['line: empty series', 'line', '{ series: [] }', [320], 'guard', 'high'],
  ['line: single point', 'line', `{ x: [1], series: [${series('A', '[42]')}] }`, [320], 'guard', 'high'],
  ['line: all NaN / null / undefined', 'line', `{ x: [1, 2, 3], series: [${series('A', '[NaN, null, undefined]')}] }`, [320], 'guard', 'high'],
  ['line: gaps', 'line', `{ x: [0, 1, 2, 3, 4, 5], series: [${series('A', '[NaN, 1, null, 3, undefined, 5]')}] }`, [320], 'guard', 'high'],
  ['line: huge values', 'line', `{ x: [1, 2, 3], series: [${series('A', '[1e12, 5e12, 3e12]')}] }`, [320], 'guard', 'high'],
  ['line: tiny values', 'line', `{ x: [1, 2, 3], series: [${series('A', '[1e-9, 5e-9, 3e-9]')}] }`, [320], 'guard', 'high'],
  ['line: negative and mixed sign', 'line', `{ x: [1, 2, 3], series: [${series('A', '[-100, 50, 200]')}, ${series('B', '[-5, -10, -2]')}] }`, [320], 'guard', 'high'],
  ['line: constant series', 'line', `{ x: [1, 2, 3], series: [${series('A', '[7, 7, 7]')}] }`, [320], 'guard', 'high'],
  ['line: time axis, one point at 3617 s', 'line', `{ x: [3617], xAxis: 'time', series: [${series('A', '[5]')}] }`, [320], 'guard', 'high'],
  ['line: time axis, 4 days', 'line', `{ x: [0, 345600], xAxis: 'time', series: [${series('A', '[1, 2]')}] }`, [320], 'guard', 'high'],
  ['line: nine series with long names', 'line', `{ x: [1, 2, 3], series: ${many(9, `({ name: 'Series number ' + (i + 1) + ' with a really long descriptive name', y: [i, i + 1, i + 2] })`)} }`, [300], 'the legend sticks out of its container (legend items use a -4 px side margin)', 'low'],
  ['line: x tick labels from a long xFormat', 'line', `{ x: ${many(10, 'i + 1')}, xFormat: (v) => 'Demand factor ' + (v / 4).toFixed(2) + 'x', series: [${series('A', many(10, 'i + 1'))}] }`, [560], 'x tick labels collide: the tick count ignores the label width', 'medium'],
  ['line: documented axis titles on a phone', 'line', `{ x: [1, 2, 3], yLabel: 'Throughput (units/h), mean and min-max of 5 runs', xLabel: 'Number of AGVs in the fleet and the shift model', series: [${series('A', '[1, 2, 3]')}] }`, [300], 'guard', 'low'],
  ['line: reference line far above the data', 'line', `{ x: [1, 2, 3], series: [${series('A', '[1, 5, 3]')}], refLines: [{ axis: 'y', value: 100, label: 'Target' }] }`, [320], 'a target line outside the y range is drawn off the canvas: the scale does not grow to show it, so the target silently disappears', 'low'],
  // bars
  ['bar: single value', 'bar', `{ categories: ['A', 'B', 'C'], series: [{ name: 'T', values: [1, 2, 3] }] }`, [320], 'guard', 'high'],
  ['bar: NaN and null values', 'bar', `{ categories: ['A', 'B', 'C'], series: [{ name: 'T', values: [NaN, 2, null] }] }`, [320], 'guard', 'high'],
  ['bar: outlier of 1e9', 'bar', `{ categories: ['A', 'B', 'C'], series: [{ name: 'T', values: [1, 2, 1e9] }] }`, [320], 'guard', 'high'],
  ['bar: all zero', 'bar', `{ categories: ['A', 'B'], series: [{ name: 'T', values: [0, 0] }] }`, [320], 'guard', 'high'],
  ['bar: max below the data', 'bar', `{ categories: ['A', 'B'], max: 50, series: [{ name: 'T', values: [20, 500] }] }`, [320], 'guard', 'high'],
  ['bar: long category names, horizontal', 'bar', `{ categories: ['A category name that is extremely long and goes on and on', 'Short', 'Another quite long category label here'], series: [{ name: 'T', values: [1, 2, 3] }] }`, [320], 'guard', 'high'],
  ['bar: long category names, vertical', 'bar', `{ orientation: 'vertical', categories: ['A category name that is extremely long and goes on and on', 'Short', 'Another quite long category label here'], series: [{ name: 'T', values: [1, 2, 3] }] }`, [320], 'guard', 'high'],
  ['bar: negative values (deltas vs the first variant), horizontal', 'bar', `{ categories: ['B', 'C', 'D'], unit: '/h', series: [{ name: 'Delta', values: [-5, -10, -2] }] }`, [560, 320], 'the value label of the most negative bar is drawn over the category labels and off the canvas edge', 'medium'],
  ['bar: mixed signs, horizontal', 'bar', `{ categories: ['Alpha', 'Beta', 'Gamma'], series: [{ name: 'T', values: [-50, 20, 100] }] }`, [560], 'negative value label collides with the category label', 'medium'],
  ['bar: negative values, vertical', 'bar', `{ orientation: 'vertical', categories: ['A', 'B', 'C'], series: [{ name: 'Delta', values: [-5, -10, -2] }] }`, [560], 'negative value labels are drawn on top of the category labels', 'medium'],
  ['bar: 40 columns with value labels', 'bar', `{ orientation: 'vertical', categories: ${many(40, "'Category ' + i")}, series: [{ name: 'T', values: ${many(40, 'i * 3')} }] }`, [560], 'value labels of neighbouring columns overprint each other (labels are only tested against bars, not against each other)', 'low'],
  ['bar: custom valueFormat also formats the axis', 'bar', `{ categories: ['A', 'B'], valueFormat: (v) => v.toFixed(1) + ' min', series: [{ name: 'T', values: [1.5, 2.5] }] }`, [320], 'guard', 'low'],
  // stacked bars
  ['stack: negative, NaN and zero segments', 'stack', `{ rows: [{ label: 'x', segments: [{ key: 'idle', value: -1 }, { key: 'driving', value: NaN }, { key: 'waiting', value: 2 }] }] }`, [320], 'guard', 'high'],
  ['stack: sub-pixel segments', 'stack', `{ rows: [{ label: 'x', segments: [{ key: 'idle', value: 1 }, { key: 'driving', value: 0.0001 }, { key: 'waiting', value: 0.0001 }, { key: 'loading', value: 0.0001 }] }] }`, [320], 'guard', 'high'],
  ['stack: long label and note', 'stack', `{ rows: [{ label: 'A very very long row label that wraps way past', note: 'and a very long note text too', segments: [{ key: 'idle', value: 1 }, { key: 'driving', value: 1 }] }] }`, [320], 'guard', 'high'],
  ['stack: unknown keys and own colours', 'stack', `{ rows: [{ label: 'x', segments: [{ key: 'zzz', value: 3 }, { key: 'yyy', value: 3, color: '#f00' }, { value: 3 }] }] }`, [320], 'guard', 'high'],
  // sparklines
  ['spark: empty, NaN, single, constant, huge, negative', 'spark', '{ values: [NaN, null] }', [120], 'guard', 'high'],
  ['spark: single value', 'spark', '{ values: [5] }', [120], 'guard', 'high'],
  ['spark: constant', 'spark', '{ values: [1, 1, 1] }', [120], 'guard', 'high'],
  ['spark: huge', 'spark', '{ values: [1e300, 2e300] }', [120], 'guard', 'high'],
  ['spark: negative', 'spark', '{ values: [-5, -3, -4] }', [120], 'guard', 'high'],
  // gauges
  ['gauge: default 0..1 dial with a percent scale', 'gauge', `{ value: 0.5, label: 'Fleet utilization', thresholds: [{ to: 1, color: 'good', label: 'Healthy' }] }`, [320], 'the "100 %" scale label at the right end of the dial is clipped by the canvas edge (the "%" is cut off in the demo too)', 'medium'],
  ['gauge: large values with units', 'gauge', `{ value: 123456, min: 0, max: 200000, unit: 'units' }`, [320], 'the scale labels ("200,000 units") are wider than the dial and clipped', 'medium'],
  ['gauge: NaN value', 'gauge', '{ value: NaN, label: "x" }', [320], 'no exception', 'high'],
  ['gauge: value outside the range', 'gauge', '{ value: 5, label: "x" }', [320], 'no exception', 'high'],
  ['gauge: min equals max', 'gauge', '{ value: 1, min: 1, max: 1 }', [320], 'no exception', 'high'],
  ['gauge: small dial (size 20)', 'gauge', '{ value: 0.5, size: 20 }', [320], 'drawing throws IndexSizeError (negative arc radius) on every frame for a dial narrower than about 30 px', 'low'],
  ['gauge: size larger than the container', 'gauge', '{ value: 0.5, size: 400 }', [300], 'a fixed-size gauge overflows a narrower container', 'low'],
];

async function reviewChartCases() {
  await withBrowser(async ({ page, url }) => {
    await page.addInitScript(installTextRecorder);
    await page.setViewportSize({ width: 1000, height: 800 });
    await openDemo(page, url, 'light');
    await page.evaluate(() => { document.body.innerHTML = ''; });
    let n = 0;
    for (const [name, kind, optionsSource, widths, expectation, severity] of CHART_CASES) {
      for (const width of widths) {
        const r = await page.evaluate(`(${mountAndMeasure.toString()})(${JSON.stringify({ kind, optionsSource, width })})`);
        const problems = [];
        for (const e of r.errors) problems.push(`exception: ${e}`);
        for (const t of r.texts) {
          if (/NaN|undefined|Infinity|\[object|null/.test(t.text)) problems.push(`text "${t.text}"`);
          if (t.x0 < -0.5 || t.x1 > t.W + 0.5 || t.y0 < -1 || t.y1 > t.H + 1) problems.push(`"${t.text}" is cut off by the canvas (x ${t.x0.toFixed(0)}..${t.x1.toFixed(0)} of ${t.W}, y ${t.y0.toFixed(0)}..${t.y1.toFixed(0)} of ${t.H})`);
        }
        const seen = new Set();
        for (let i = 0; i < r.texts.length; i++) for (let j = i + 1; j < r.texts.length; j++) {
          const a = r.texts[i]; const b = r.texts[j];
          if (a.text === b.text && Math.abs(a.x0 - b.x0) < 0.5 && Math.abs(a.y0 - b.y0) < 0.5) continue; // halo pass of the same label
          const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (overlapX > 1 && overlapY > 2 && !seen.has(`${a.text}|${b.text}`)) { seen.add(`${a.text}|${b.text}`); problems.push(`"${a.text}" overprints "${b.text}"`); }
        }
        if (r.scrollWidth > r.clientWidth + 1) problems.push(`overflows its container (${r.scrollWidth} > ${r.clientWidth} px)`);
        const isGuard = expectation === 'guard' || expectation === 'no exception';
        const effective = expectation === 'no exception' ? problems.filter((p) => p.startsWith('exception')) : problems;
        if (process.env.UIKIT_REVIEW_SHOTS && problems.length) await page.locator('#__case').screenshot({ path: png(`case-${String(n).padStart(2, '0')}`) });
        n++;
        defect(severity, `chart: ${name} @${width}px`, effective.length === 0, `${isGuard ? 'chart misbehaves' : expectation}: ${effective.slice(0, 4).join('; ')}`);
        await page.evaluate(() => { window.__chart?.destroy(); window.__chart = null; document.getElementById('__case')?.remove(); });
      }
    }
    notes.push(`chart edge cases: ${n} chart/width combinations drawn`);
  });
}

// ======================================================================================================================
// 5  chart lifecycle, resize, tooltips
// ======================================================================================================================

/** Installed before any page script: tracks observers, long-lived listeners, frames and canvas redraws. */
function installLifecycleSpies() {
  const observers = { resize: new Set(), mutation: new Set() };
  const RO = window.ResizeObserver;
  const MO = window.MutationObserver;
  window.ResizeObserver = class extends RO { constructor(cb) { super(cb); observers.resize.add(this); } disconnect() { observers.resize.delete(this); super.disconnect(); } };
  window.MutationObserver = class extends MO { observe(...a) { observers.mutation.add(this); return super.observe(...a); } disconnect() { observers.mutation.delete(this); return super.disconnect(); } };
  const listeners = [];
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const capture = (o) => (typeof o === 'object' ? Boolean(o?.capture) : Boolean(o));
  EventTarget.prototype.addEventListener = function (type, fn, o) { listeners.push({ target: this, type, fn, capture: capture(o) }); return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    const i = listeners.findIndex((l) => l.target === this && l.type === type && l.fn === fn && l.capture === capture(o));
    if (i >= 0) listeners.splice(i, 1);
    return remove.call(this, type, fn, o);
  };
  const raf = window.requestAnimationFrame;
  const caf = window.cancelAnimationFrame;
  const pending = new Set();
  window.requestAnimationFrame = (cb) => { const id = raf((t) => { pending.delete(id); cb(t); }); pending.add(id); return id; };
  window.cancelAnimationFrame = (id) => { pending.delete(id); caf(id); };
  const getContext = HTMLCanvasElement.prototype.getContext;
  const draws = new WeakMap();
  HTMLCanvasElement.prototype.getContext = function (...a) { draws.set(this, (draws.get(this) || 0) + 1); return getContext.apply(this, a); };
  window.__spy = { observers, listeners, pending, draws };
}

async function reviewLifecycle() {
  await withBrowser(async ({ page, url }) => {
    await page.addInitScript(installLifecycleSpies);
    await page.addInitScript(installTextRecorder);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openDemo(page, url, 'light');

    const life = await page.evaluate(async () => {
      const spy = window.__spy;
      const mod = await import('/js/ui/charts.js');
      const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))));
      const longLived = (l) => l.target === window || l.target === document || l.target === document.documentElement || l.target === document.body || l.target instanceof MediaQueryList;
      const base = { resize: spy.observers.resize.size, mutation: spy.observers.mutation.size, listeners: spy.listeners.filter(longLived).length };
      const host = document.createElement('div');
      host.style.width = '500px';
      document.body.append(host);
      const made = [];
      for (let i = 0; i < 4; i++) {
        made.push(mod.createLineChart({ x: [1, 2, 3], series: [{ name: 'a', y: [1, 2, 3] }, { name: 'b', y: [3, 2, 1] }] }));
        made.push(mod.createBarChart({ categories: ['a', 'b'], series: [{ name: 'a', values: [1, 2] }] }));
        made.push(mod.createStackedBar({ rows: [{ label: 'r', segments: [{ key: 'idle', value: 1 }] }] }));
        made.push(mod.createSparkline({ values: [1, 2, 3] }));
        made.push(mod.createGauge({ value: 0.4 }));
      }
      for (const c of made) host.append(c.el);
      await frames();
      const canvases = made.map((c) => c.el.querySelector('canvas'));
      const alive = { resize: spy.observers.resize.size - base.resize };
      let doubleDestroyError = null;
      for (const c of made) c.destroy();
      try { for (const c of made) c.destroy(); } catch (e) { doubleDestroyError = e.message; }
      const drawsBefore = canvases.map((cv) => spy.draws.get(cv));
      let updateError = null;
      try { for (const c of made) c.update({}); } catch (e) { updateError = e.message; }
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.dataset.theme = 'light';
      host.style.width = '300px';
      await frames();
      return {
        aliveWhileMounted: alive.resize,
        observersLeft: { resize: spy.observers.resize.size - base.resize, mutation: spy.observers.mutation.size - base.mutation },
        listenersLeft: spy.listeners.filter(longLived).length - base.listeners,
        framesPending: spy.pending.size,
        redrawsAfterDestroy: canvases.map((cv, i) => spy.draws.get(cv) - drawsBefore[i]).reduce((a, b) => a + b, 0),
        elementsLeft: host.children.length,
        doubleDestroyError,
        updateError,
      };
    });
    defect('high', 'lifecycle', life.aliveWhileMounted === 20, `expected 20 resize observers while 20 charts are mounted, saw ${life.aliveWhileMounted}`);
    defect('high', 'lifecycle', life.observersLeft.resize === 0 && life.observersLeft.mutation === 0, `destroy() left observers behind: ${JSON.stringify(life.observersLeft)}`);
    defect('high', 'lifecycle', life.listenersLeft === 0, `destroy() left ${life.listenersLeft} listeners on window / document / media queries`);
    defect('high', 'lifecycle', life.framesPending === 0 && life.redrawsAfterDestroy === 0, `destroyed charts still schedule or draw frames (pending ${life.framesPending}, redraws ${life.redrawsAfterDestroy})`);
    defect('medium', 'lifecycle', life.elementsLeft === 0, `destroy() left ${life.elementsLeft} elements in the DOM`);
    defect('medium', 'lifecycle', !life.doubleDestroyError && !life.updateError, `destroy() twice or update() after destroy() throws: ${life.doubleDestroyError || life.updateError}`);

    // resize: the backing store follows the box, text stays inside, no exceptions, hidden-then-shown charts draw
    const resize = await page.evaluate(async () => {
      const mod = await import('/js/ui/charts.js');
      const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
      const errors = [];
      window.addEventListener('error', (e) => errors.push(e.message));
      const host = document.createElement('div');
      host.style.cssText = 'width:800px';
      document.body.append(host);
      const chart = mod.createLineChart({ x: [0, 1, 2, 3], xAxis: 'time', series: [{ name: 'A', y: [1, 2, 3, 4] }, { name: 'B', y: [4, 3, 2, 1] }] });
      host.append(chart.el);
      const out = [];
      for (const w of [800, 320, 100, 40, 800]) {
        host.style.width = `${w}px`;
        await frames();
        const cv = host.querySelector('canvas');
        const dpr = window.devicePixelRatio;
        const ink = (() => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })();
        out.push({ w, canvasW: cv.width, expected: Math.round(cv.clientWidth * dpr), clientW: cv.clientWidth, ink });
      }
      host.style.display = 'none';
      await frames();
      host.style.display = 'block';
      await frames();
      const cv = host.querySelector('canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let inkAfterShow = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) inkAfterShow++;
      chart.destroy();
      host.remove();
      return { out, inkAfterShow, errors };
    });
    defect('high', 'resize', resize.errors.length === 0, `exceptions while resizing: ${resize.errors.join('; ')}`);
    defect('high', 'resize', resize.out.every((r) => r.canvasW === r.expected), `canvas backing store does not follow the box: ${JSON.stringify(resize.out.filter((r) => r.canvasW !== r.expected))}`);
    defect('high', 'resize', resize.out.filter((r) => r.w >= 320).every((r) => r.ink > 200) && resize.inkAfterShow > 200, 'a chart is blank after resizing or after being hidden and shown again');

    // tooltips: at every pointer position along and around the plot the tooltip stays inside its chart
    const targets = ['#c-line .chart', '#c-sweep .chart', '#c-bar-h .chart', '#c-bar-v .chart', '#c-stack-veh .chart', '#c-stack-st .chart'];
    const escapes = [];
    for (const selector of targets) {
      const chart = page.locator(selector);
      await chart.scrollIntoViewIfNeeded();
      const box = await chart.boundingBox();
      for (const fx of [0.005, 0.1, 0.5, 0.9, 0.995]) {
        for (const fy of [0.02, 0.25, 0.5, 0.75, 0.98]) {
          await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
          await page.waitForTimeout(25);
          const tip = await chart.evaluate((el) => { const t = el.querySelector('.chart-tooltip'); if (!t || t.hidden) return null; const c = el.getBoundingClientRect(); const r = t.getBoundingClientRect(); return { left: r.left - c.left, top: r.top - c.top, right: c.right - r.right, bottom: c.bottom - r.bottom, w: r.width, h: r.height, cw: c.width, ch: c.height }; });
          if (tip && (tip.left < -0.5 || tip.right < -0.5 || (tip.h < tip.ch && (tip.top < -0.5 || tip.bottom < -0.5)))) escapes.push(`${selector} at ${fx},${fy}: ${JSON.stringify(tip)}`);
        }
      }
    }
    await page.mouse.move(2, 2);
    defect('medium', 'tooltips', escapes.length === 0, `${escapes.length} tooltip positions leave their chart: ${escapes.slice(0, 2).join(' | ')}`);

    // the stacked-bar gap is documented as "surface"; see what is really painted between two segments
    const gap = await page.evaluate(async () => {
      const mod = await import('/js/ui/charts.js');
      const host = document.createElement('div');
      host.style.cssText = 'width:400px;background:var(--surface)';
      document.body.append(host);
      const chart = mod.createStackedBar({ legend: false, rows: [{ label: '', segments: [{ key: 'driving', value: 1 }, { key: 'waiting', value: 1 }] }] });
      host.append(chart.el);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
      const cv = host.querySelector('canvas');
      const px = (x, y) => [...cv.getContext('2d').getImageData(x * window.devicePixelRatio, y * window.devicePixelRatio, 1, 1).data];
      const mid = Math.round(cv.clientWidth / 2);
      const samples = [mid - 2, mid - 1, mid, mid + 1].map((x) => px(x, 17));
      const cs = getComputedStyle(document.documentElement);
      const result = { samples, surface3: cs.getPropertyValue('--surface-3').trim(), surface: cs.getPropertyValue('--surface').trim() };
      chart.destroy();
      host.remove();
      return result;
    });
    const hex = (rgb) => `#${rgb.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const gapColour = gap.samples.map(hex).find((c) => c === gap.surface3.toLowerCase() || c === gap.surface.toLowerCase());
    defect('low', 'docs', gapColour === gap.surface.toLowerCase(), `UI-KIT.md section 5.3 promises a 2 px surface gap between stacked segments; the gap shows the track colour ${gap.surface3} (${gapColour ?? 'not found'}), not ${gap.surface}`);
  }, { viewport: { width: 1440, height: 1000 } });
}

// ======================================================================================================================
// 6  device pixel ratios
// ======================================================================================================================

async function reviewPixelRatios() {
  const blurry = {};
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    await withBrowser(async ({ page, url }) => {
      await openDemo(page, url, 'light');
      const r = await page.evaluate(() => {
        const cv = document.querySelector('#c-bar-v canvas');
        const W = cv.width; const H = cv.height;
        const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
        let lineRows = 0; let blurRows = 0;
        for (let y = 0; y < H; y++) {
          let covered = 0; let solid = 0;
          for (let x = 0; x < W; x++) { const a = d[(y * W + x) * 4 + 3]; if (a > 0) { covered++; if (a > 245) solid++; } }
          if (covered > W * 0.55) { lineRows++; if (solid < covered * 0.8) blurRows++; }
        }
        return { ratio: W / cv.clientWidth, lineRows, blurRows };
      });
      defect('high', `pixel ratio ${dpr}`, Math.abs(r.ratio - Math.min(3, dpr)) < 0.01, `canvas backing store is ${r.ratio.toFixed(3)}x the CSS size, expected ${dpr}x`);
      blurry[dpr] = `${r.blurRows} of ${r.lineRows}`;
      defect('low', `pixel ratio ${dpr}`, r.blurRows === 0, `${r.blurRows} of ${r.lineRows} horizontal grid / axis rows are anti-aliased instead of crisp (line width stays 1 CSS px while crispLine snaps to whole device pixels)`);
    }, { deviceScaleFactor: dpr, viewport: { width: 1440, height: 1000 } });
  }
  notes.push(`blurry hairline rows per pixel ratio: ${JSON.stringify(blurry)}`);
}

// ======================================================================================================================
// 7  touch targets, reduced motion, dialog, overlays, control heights
// ======================================================================================================================

async function reviewTouchAndLayout() {
  await withBrowser(async ({ page, browser, url }) => {
    // --- coarse pointer: UI-KIT.md says "coarse pointers get 40 px controls"
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const tp = await touch.newPage();
    await tp.goto(url(`${DEMO}?theme=light`));
    await tp.waitForFunction(() => window.__demoReady === true);
    const small = await tp.evaluate(() => {
      const coarse = matchMedia('(pointer: coarse)').matches;
      const selector = 'button:not(:disabled), a[href], input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea, summary, label.segmented__item';
      const rows = {};
      for (const el of document.querySelectorAll(selector)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const target = (el.matches('input[type=checkbox], input[type=radio]') || el.classList.contains('switch__input')) ? el.closest('label') : el;
        if (el.closest('.segmented') && el.tagName === 'INPUT') continue;
        const b = target.getBoundingClientRect();
        if (!b.width || (b.width >= 24 && b.height >= 24)) continue;
        const key = `${target.tagName.toLowerCase()}.${String(target.className).trim().split(/\s+/).join('.') || target.type}`;
        rows[key] = { h: Math.round(b.height), w: Math.round(b.width) };
      }
      return { coarse, rows };
    });
    defect('low', 'touch', small.coarse, 'coarse-pointer emulation did not engage');
    defect('medium', 'touch', Object.keys(small.rows).length === 0, `under (pointer: coarse) these controls stay smaller than 24x24 CSS px (WCAG 2.5.8), although the docs say coarse pointers get 40 px controls: ${Object.entries(small.rows).map(([k, v]) => `${k} ${v.w}x${v.h}`).join(', ')}`);
    await tp.screenshot({ path: png('touch-390') });
    await touch.close();

    // --- control heights share one grid
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDemo(page, url, 'light');
    const heights = await page.evaluate(() => {
      const h = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height * 10) / 10;
      return { btn: h('.btn:not(.btn--sm):not(.btn--icon)'), input: h('.input:not(.input--sm)'), group: h('.input-group'), stepper: h('.stepper'), select: h('select.input:not(.input--sm)'), segmented: h('.segmented'), btnSm: h('.btn--sm:not(.btn--icon)'), inputSm: h('.input--sm') };
    });
    defect('low', 'density', heights.segmented === heights.btn, `a segmented control is ${heights.segmented}px high next to ${heights.btn}px buttons and ${heights.input}px inputs (min-height is control-h minus 6 plus 2x2 padding)`);
    defect('medium', 'density', new Set([heights.btn, heights.input, heights.group, heights.stepper, heights.select]).size === 1 && heights.btnSm === heights.inputSm, `controls disagree on height: ${JSON.stringify(heights)}`);

    // --- a segmented control inside .stack should hug its items like a button does
    const widths = await page.evaluate(() => {
      const el = document.querySelector('.stack > .segmented:not(.segmented--block)');
      const items = [...el.querySelectorAll('.segmented__item')].reduce((sum, i) => sum + i.getBoundingClientRect().width, 0);
      return { width: Math.round(el.getBoundingClientRect().width), items: Math.round(items) };
    });
    defect('low', 'layout', widths.width <= widths.items + 12, `a .segmented in a .stack stretches to ${widths.width}px around items that need ${widths.items}px: the items sit left in a long grey track (inline-flex loses to the column's align-items: stretch)`);

    // --- reduced motion: nothing keeps moving and the zeroed durations apply to components, not just the tokens
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDemo(page, url, 'light', { stable: false });
    const motion = await page.evaluate(() => {
      const duration = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo).transitionDuration;
      return {
        btn: duration('.btn'), progress: duration('.progress__bar'), track: duration('.switch__track'), tab: duration('.tab'),
        running: document.getAnimations().filter((a) => a.playState === 'running' && a.effect.getTiming().iterations === Infinity).length,
        modal: getComputedStyle(document.querySelector('.modal')).animationDuration,
      };
    });
    defect('medium', 'reduced motion', ['btn', 'progress', 'track', 'tab'].every((k) => /^0s(, 0s)*$/.test(motion[k])), `transition durations under prefers-reduced-motion: ${JSON.stringify(motion)}`);
    defect('medium', 'reduced motion', motion.running === 0 && parseFloat(motion.modal) < 0.001, `animations still run under prefers-reduced-motion: ${JSON.stringify(motion)}`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // --- native <dialog class="modal"> is documented but was never opened in a browser
    await openDemo(page, url, 'light', { stable: false });
    const dialog = await page.evaluate(async () => {
      const d = document.createElement('dialog');
      d.className = 'modal modal--sm';
      d.innerHTML = '<div class="modal__header"><h3 class="modal__title">Native dialog</h3><button class="btn btn--icon btn--sm btn--ghost modal__close" type="button" aria-label="Close">x</button></div><div class="modal__body"><p>Body</p></div><div class="modal__footer"><button class="btn" type="button">Cancel</button></div>';
      document.body.append(d);
      const closedDisplay = getComputedStyle(d).display;
      d.showModal();
      await new Promise((r) => setTimeout(r, 300));
      const r = d.getBoundingClientRect();
      const result = {
        closedDisplay,
        centredX: Math.abs(r.left + r.width / 2 - innerWidth / 2) < 1.5,
        centredY: Math.abs(r.top + r.height / 2 - innerHeight / 2) < 1.5,
        backdrop: getComputedStyle(d, '::backdrop').backgroundColor,
        scrim: getComputedStyle(document.documentElement).getPropertyValue('--scrim').trim(),
        width: Math.round(r.width),
        focusInside: d.contains(document.activeElement),
      };
      return result;
    });
    await page.screenshot({ path: png('native-dialog') });
    await page.keyboard.press('Escape');
    const stillOpen = await page.evaluate(() => document.querySelector('dialog')?.open);
    defect('high', 'dialog', dialog.closedDisplay === 'none', `<dialog class="modal"> is visible while closed (display ${dialog.closedDisplay})`);
    defect('medium', 'dialog', dialog.centredX && dialog.centredY, `native dialog is not centred in the viewport (${JSON.stringify(dialog)})`);
    defect('medium', 'dialog', dialog.backdrop !== 'rgba(0, 0, 0, 0)' && dialog.backdrop.replace(/\s/g, '') === dialog.scrim.replace(/\s/g, ''), `::backdrop colour ${dialog.backdrop} differs from --scrim ${dialog.scrim}`);
    defect('medium', 'dialog', dialog.focusInside && stillOpen === false, `native dialog: focus inside after showModal() = ${dialog.focusInside}, closes on Escape = ${stillOpen === false}`);

    // --- overlays on a phone: menus and tooltips must stay on screen
    await page.setViewportSize({ width: 390, height: 844 });
    await openDemo(page, url, 'light');
    const offscreen = await page.evaluate(() => [...document.querySelectorAll('.menu, .toast, .modal')].map((el) => { const r = el.getBoundingClientRect(); return r.width ? { cls: el.className, left: Math.round(r.left), right: Math.round(r.right) } : null; }).filter((r) => r && (r.left < -1 || r.right > innerWidth + 1)));
    defect('low', 'mobile', offscreen.length === 0, `in the demo at 390 px, overlays leave the screen: ${JSON.stringify(offscreen)} (dropdown menus have no viewport clamp or max-width)`);
  });
}

// ======================================================================================================================
// 8  print
// ======================================================================================================================

async function reviewPrint() {
  await withBrowser(async ({ page, url }) => {
    await page.emulateMedia({ colorScheme: 'light', media: 'screen' });
    await openDemo(page, url, 'light');
    const read = () => page.evaluate(() => ['#c-bar-h', '#c-line', '#c-stack-veh', '#c-gauges'].map((s) => document.querySelector(`${s} canvas`).toDataURL()));
    const light = await read();
    await page.emulateMedia({ colorScheme: 'dark', media: 'screen' });
    await openDemo(page, url, 'dark');
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(400);
    const printed = await read();
    defect('high', 'print', light.every((d, i) => d === printed[i]), 'charts do not redraw in the light palette when a dark page is printed');
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    defect('medium', 'print', pdf.length > 10000, 'printing the demo produced an empty PDF');
  });
}

// ======================================================================================================================

const only = process.argv[2];
const steps = { forced: reviewForcedColors, keyboard: reviewKeyboard, icons: reviewIcons, cases: reviewChartCases, lifecycle: reviewLifecycle, ratios: reviewPixelRatios, touch: reviewTouchAndLayout, print: reviewPrint };
for (const [name, run] of Object.entries(steps)) {
  if (only && only !== name) continue;
  try { await run(); } catch (e) { defect('high', name, false, `review step crashed: ${e.stack || e.message}`); }
}

const order = { high: 0, medium: 1, low: 2 };
// the same problem found in several themes or widths is one finding
const merged = new Map();
for (const f of findings) {
  const key = `${f.severity}|${f.message}`;
  if (merged.has(key)) merged.get(key).areas.push(f.area); else merged.set(key, { ...f, areas: [f.area] });
}
const report = [...merged.values()].sort((a, b) => order[a.severity] - order[b.severity]);
for (const n of notes) console.log(`note: ${n}`);
if (report.length) {
  const counts = report.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }), {});
  console.error(`\n${report.length} defect(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  for (const f of report) console.error(`  [${f.severity}] ${[...new Set(f.areas)].join(' / ')}: ${f.message}`);
  process.exitCode = 1;
} else {
  console.log('\nUI kit review: no defects. Screenshots: e2e-output/uikit-review-*.png');
}
