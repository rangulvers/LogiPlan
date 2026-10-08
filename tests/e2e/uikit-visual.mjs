// Visual + behavioural check of the UI kit (run by hand: node tests/e2e/uikit-visual.mjs).
//
// Serves tests/e2e/uikit-demo.html, screenshots every section in light, dark and a 390 px mobile width into
// e2e-output/uikit-*.png (LOOK at them: this script cannot judge taste), and asserts what can be measured:
//  - no console errors / warnings, no failed requests
//  - every icon renders; the required icon names exist
//  - every chart canvas has pixels (or shows its empty-state text), tooltips, clicks, keyboard access and legend toggles work
//  - WCAG AA text contrast (4.5:1, 3:1 for large text) for every visible text in both themes, plus the token pairs
//  - the dark theme is identical via data-theme and via prefers-color-scheme; light wins when forced; print is light
//  - focus rings are visible (outlines on buttons, inputs, groups and steppers), reduced motion zeroes the transitions,
//    no horizontal overflow at 390 px
import { withBrowser, OUT } from './browser.mjs';
import { ICON_NAMES } from '../../js/ui/icons.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REQUIRED_ICONS = [
  'select', 'pan', 'road', 'oneway', 'speedzone', 'erase', 'source', 'process', 'storage', 'sink', 'depot', 'obstacle', 'label', 'flow',
  'undo', 'redo', 'play', 'pause', 'step', 'reset', 'fit', 'zoomin', 'zoomout', 'grid', 'heat', 'flows', 'share', 'export', 'import', 'help',
  'settings', 'warning', 'error', 'info', 'check', 'plus', 'minus', 'trash', 'copy', 'chevron-down', 'chevron-right', 'chevron-left',
  'chevron-up', 'close', 'menu', 'sun', 'moon', 'layers', 'truck', 'bolt', 'clock', 'chart', 'compare', 'flask', 'link', 'download',
  'upload', 'folder', 'save', 'sliders', 'target', 'route', 'forklift',
];
const SECTIONS = ['foundations', 'buttons', 'forms', 'layout', 'cards', 'data', 'overlays', 'charts', 'icons'];
const TOKEN_NAMES = [...new Set(readFileSync(new URL('../../css/tokens.css', import.meta.url), 'utf8').match(/--[a-z0-9-]+(?=\s*:)/g))];

const failures = [];
const notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const file = (name) => path.join(OUT, `uikit-${name}.png`);

/** Opens the demo in a theme and waits until icons, charts and the first frame are in place. */
async function open(page, url, theme) {
  await page.goto(url(`/tests/e2e/uikit-demo.html${theme ? `?theme=${theme}` : ''}`));
  await page.waitForFunction(() => window.__demoReady === true);
  await page.addStyleTag({ content: '.demo-header { position: static !important; }' });
  await page.evaluate(() => document.fonts.ready);
  // let entrance animations (toast, modal) finish so the contrast audit sees final colours
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect.getTiming().iterations !== Infinity).map((a) => a.finished)));
}

/** Screenshots each demo section (and returns the file names). */
async function shootSections(page, prefix) {
  for (const name of SECTIONS) {
    await page.locator(`section[data-shot="${name}"]`).screenshot({ path: file(`${prefix}-${name}`) });
  }
}

/** Contrast audit run inside the page: every visible text, input value and placeholder, in the current theme. */
const auditContrast = () => {
  const parse = (c) => {
    const m = c.trim().match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    const mix = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / (a || 1);
    return { r: mix('r'), g: mix('g'), b: mix('b'), a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const backdrop = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a === 1) break;
    }
    return layers.reduceRight((below, layer) => over(layer, below), { r: 255, g: 255, b: 255, a: 1 });
  };
  const opacityOf = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
  const out = [];
  const test = (el, colorStr, what) => {
    const cs = getComputedStyle(el);
    const fg = parse(colorStr);
    if (!fg) return;
    const bg = backdrop(el);
    const o = opacityOf(el);
    const eff = over({ ...fg, a: fg.a * o }, bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const r = ratio(eff, bg);
    if (r < (large ? 3 : 4.5)) out.push(`${label(el)} "${what.slice(0, 40)}" ${r.toFixed(2)}:1 (${size}px)`);
  };
  for (const el of document.body.querySelectorAll('*')) {
    // inactive components (disabled controls, their labels and addons) are exempt from WCAG 1.4.3
    if (el.closest('canvas, svg, [disabled], [aria-disabled="true"], .is-disabled, .sr-only, [hidden]') || el.closest('label')?.querySelector(':disabled')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (text) test(el, cs.color, text);
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'range' && el.value) test(el, cs.color, el.value);
    if (el.placeholder) test(el, getComputedStyle(el, '::placeholder').color, el.placeholder);
  }
  return out;
};

/** Token pair audit: [foreground, background, minimum ratio]; translucent backgrounds are composited over the surface. */
const auditTokenPairs = () => {
  const root = getComputedStyle(document.documentElement);
  const parse = (s) => {
    s = s.trim();
    let m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4), 16), a: 1 };
    m = s.match(/^rgba?\(([^)]+)\)$/);
    const p = m[1].split(/[\s,]+/).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const tok = (n) => parse(root.getPropertyValue(`--${n}`));
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const lum = ({ r, g, b }) => { const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const surface = tok('surface');
  const pairs = [];
  for (const fg of ['text', 'text-dim', 'text-faint']) for (const bg of ['surface', 'bg', 'surface-2', 'surface-3']) pairs.push([fg, bg, 4.5]);
  for (const k of ['good', 'warn', 'bad', 'info']) pairs.push([`${k}-text`, 'surface', 4.5], [`${k}-text`, `${k}-soft`, 4.5], [`${k}-text`, 'surface-2', 4.5]);
  pairs.push(['accent-text', 'surface', 4.5], ['accent-text', 'accent-soft', 4.5], ['accent-text', 'surface-3', 4.5]);
  for (const bg of ['accent-solid', 'accent-hover', 'accent-active', 'bad-solid', 'bad-hover']) pairs.push(['on-accent', bg, 4.5]);
  for (const fg of ['inverse-text', 'inverse-accent', 'inverse-good', 'inverse-warn', 'inverse-bad']) pairs.push([fg, 'inverse-bg', 4.5]);
  for (const k of ['source', 'process', 'storage', 'sink', 'depot']) pairs.push([`st-${k}-ink`, `st-${k}`, 4.5]);
  for (const k of ['accent', 'good', 'warn', 'bad', 'info']) pairs.push([k, 'surface', 3]);
  for (const k of ['control-border', 'control-border-hover', 'control-track']) pairs.push([k, 'surface', 3], [k, 'bg', 3]);
  pairs.push(['focus-color', 'surface', 3], ['inverse-accent', 'inverse-bg', 3]);
  const fails = [];
  for (const [fg, bg, min] of pairs) {
    const bgc = over(tok(bg), surface);
    const fgc = fg === 'focus-color' ? tok('accent') : over(tok(fg), bgc);
    const r = ratio(fgc, bgc);
    if (r < min) fails.push(`--${fg} on --${bg}: ${r.toFixed(2)}:1 < ${min}`);
  }
  return fails;
};

const readTokens = (names) => {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
};

const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: "${a[k]}" vs "${b[k]}"`);

await withBrowser(async ({ page, url, errors }) => {
  // ---------------------------------------------------------------- screenshots + audits per theme
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
    await open(page, url, theme);
    await shootSections(page, theme);

    const contrast = await page.evaluate(auditContrast);
    check(contrast.length === 0, `[${theme}] text contrast below AA:\n    ${contrast.join('\n    ')}`);
    const pairs = await page.evaluate(auditTokenPairs);
    check(pairs.length === 0, `[${theme}] token pairs below AA:\n    ${pairs.join('\n    ')}`);

    // icons
    const icons = await page.evaluate(() => [...document.querySelectorAll('#icons div[data-icon-name]')].map((d) => {
      const r = d.querySelector('svg').getBoundingClientRect();
      return { name: d.dataset.iconName, w: r.width, h: r.height, paths: d.querySelectorAll('svg > *').length };
    }));
    check(icons.length === ICON_NAMES.length, `[${theme}] gallery shows ${icons.length} of ${ICON_NAMES.length} icons`);
    check(icons.every((i) => i.w === 24 && i.h === 24 && i.paths > 0), `[${theme}] some icons did not render: ${icons.filter((i) => !i.w || !i.paths).map((i) => i.name)}`);

    // charts: pixels or empty-state text
    const charts = await page.evaluate(() => [...document.querySelectorAll('.chart')].map((el) => {
      const canvas = el.querySelector('canvas');
      const empty = el.querySelector('.chart__empty');
      let ink = 0;
      if (canvas && !canvas.hidden && canvas.width > 0) {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
      }
      return { cls: el.className, ink, emptyText: empty && !empty.hidden ? empty.textContent : '', w: el.clientWidth, h: el.clientHeight };
    }));
    for (const c of charts) check(c.w > 0 && c.h > 0 && (c.ink > 80 || c.emptyText), `[${theme}] chart looks blank: ${JSON.stringify(c)}`);
    check(charts.filter((c) => c.emptyText).length === 2, `[${theme}] expected exactly the 2 empty-state charts to show their text, got ${charts.filter((c) => c.emptyText).length}`);
    notes.push(`[${theme}] ${charts.length} charts drawn, ${icons.length} icons rendered`);

    // ---- interactions
    const lineCard = page.locator('#c-line .chart--line');
    await lineCard.scrollIntoViewIfNeeded();
    const box = await lineCard.boundingBox();
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.45);
    await page.waitForTimeout(120);
    const tip = await page.evaluate(() => { const t = document.querySelector('#c-line .chart-tooltip'); return { hidden: t.hidden, text: t.textContent }; });
    check(!tip.hidden && /Throughput/.test(tip.text) && /WIP/.test(tip.text), `[${theme}] line tooltip missing or incomplete: ${JSON.stringify(tip)}`);
    await page.locator('#c-line').locator('xpath=ancestor::div[contains(@class,"card")]').screenshot({ path: file(`${theme}-hover-line`) });

    const sweep = page.locator('#c-sweep .chart--line');
    await sweep.scrollIntoViewIfNeeded();
    const sb = await sweep.boundingBox();
    await page.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height * 0.4);
    await page.mouse.click(sb.x + sb.width * 0.5, sb.y + sb.height * 0.4);
    const status = await page.locator('#sweep-status').textContent();
    check(/applied: \d+ AGVs/.test(status), `[${theme}] clicking a sweep point did not call onPointClick (status "${status}")`);
    await page.locator('#c-sweep').locator('xpath=ancestor::div[contains(@class,"card")]').screenshot({ path: file(`${theme}-hover-sweep`) });

    const bar = page.locator('#c-bar-h .chart--bar');
    await bar.scrollIntoViewIfNeeded();
    const bb = await bar.boundingBox();
    await page.mouse.move(bb.x + bb.width * 0.3, bb.y + 28);
    await page.waitForTimeout(100);
    const barTip = await page.locator('#c-bar-h .chart-tooltip').textContent();
    check(/Throughput/.test(barTip), `[${theme}] bar tooltip missing: "${barTip}"`);
    await page.locator('#c-bar-h').locator('xpath=ancestor::div[contains(@class,"card")]').screenshot({ path: file(`${theme}-hover-bar`) });
    // a live update while the pointer rests on a bar must refresh the open tooltip, not leave stale text or drop it
    await page.evaluate(() => window.__chartAt['#c-bar-h'].update({ series: [{ name: 'Throughput', values: [57, 104, 118, 111, 109] }] }));
    await page.waitForTimeout(150);
    const liveTip = await page.evaluate(() => { const t = document.querySelector('#c-bar-h .chart-tooltip'); return { hidden: t.hidden, text: t.textContent }; });
    check(!liveTip.hidden && /57/.test(liveTip.text), `[${theme}] bar tooltip is stale or gone after update(): ${JSON.stringify(liveTip)}`);
    await page.evaluate(() => window.__chartAt['#c-bar-h'].update({ series: [{ name: 'Throughput', values: [92, 104, 118, 111, 109] }] }));

    const stack = page.locator('#c-stack-veh .chart--stacked');
    await stack.scrollIntoViewIfNeeded();
    const sk = await stack.boundingBox();
    await page.mouse.move(sk.x + sk.width * 0.5, sk.y + 17);
    await page.waitForTimeout(100);
    const stackTip = await page.locator('#c-stack-veh .chart-tooltip').textContent();
    check(/%/.test(stackTip), `[${theme}] stacked-bar tooltip missing: "${stackTip}"`);
    await page.locator('#c-stack-veh').locator('xpath=ancestor::div[contains(@class,"card")]').screenshot({ path: file(`${theme}-hover-stack`) });
    await page.mouse.move(2, 2);

    // legend toggle on the multi-series line chart
    const legendItem = page.locator('#c-line .chart-legend__item').nth(1);
    await legendItem.click();
    check((await legendItem.getAttribute('aria-pressed')) === 'false', `[${theme}] legend toggle did not hide the series`);
    await legendItem.click();
    check((await legendItem.getAttribute('aria-pressed')) === 'true', `[${theme}] legend toggle did not restore the series`);

    // keyboard on the bar chart: Tab focus, arrow keys move, announcement
    await page.locator('#c-bar-h canvas').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100); // the tooltip and its announcement are produced by the next frame
    const live = await page.locator('#c-bar-h [aria-live]').textContent();
    check(/B · \+1 AGV/.test(live), `[${theme}] keyboard navigation did not announce the second bar (live region: "${live}")`);

    // focus ring + data-tip + slider bubble
    await page.locator('section[data-shot="buttons"] .btn--primary').first().focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { style: cs.outlineStyle, width: cs.outlineWidth }; });
    check(ring.style !== 'none' && parseFloat(ring.width) >= 2, `[${theme}] focus ring not visible on the focused button: ${JSON.stringify(ring)}`);
    await page.locator('section[data-shot="buttons"] .card').first().screenshot({ path: file(`${theme}-focus`) });
    // inputs, input groups and steppers use a real outline too (a glow alone would vanish in forced-colours mode)
    for (const selector of ['#f-name', '#f-cycle', '#f-count']) {
      await page.locator(selector).focus();
      const inputRing = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        const box = el.closest('.input-group, .stepper') || el;
        const cs = getComputedStyle(box);
        return { style: cs.outlineStyle, width: cs.outlineWidth };
      }, selector);
      check(inputRing.style !== 'none' && parseFloat(inputRing.width) >= 2, `[${theme}] focus outline missing on ${selector}: ${JSON.stringify(inputRing)}`);
    }
    await page.locator('#f-name').evaluate((el) => el.blur());

    await page.mouse.move(2, 2);
    const settingsBtn = page.locator('[data-tip="Settings"]');
    await settingsBtn.scrollIntoViewIfNeeded();
    await settingsBtn.hover();
    await page.waitForTimeout(600);
    const tipOpacity = await settingsBtn.evaluate((el) => getComputedStyle(el, '::after').opacity);
    check(Number(tipOpacity) === 1, `[${theme}] [data-tip] tooltip does not appear on hover (opacity ${tipOpacity})`);
    const sbox = await settingsBtn.boundingBox();
    await page.screenshot({ path: file(`${theme}-datatip`), clip: { x: Math.max(0, sbox.x - 80), y: Math.max(0, sbox.y - 50), width: 220, height: 100 } });

    await page.locator('#r-demand').scrollIntoViewIfNeeded();
    const rb = await page.locator('#r-demand').boundingBox();
    await page.mouse.move(rb.x + rb.width * 0.3, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width * 0.55, rb.y + rb.height / 2);
    const bubble = await page.evaluate(() => ({ p: document.querySelector('#r-demand').parentElement.style.getPropertyValue('--p'), value: document.querySelector('#r-demand').parentElement.dataset.value, out: document.querySelector('[data-range-out="r-demand"]').textContent }));
    check(Number(bubble.p) > 0.4 && bubble.value === bubble.out, `[${theme}] slider did not update its fill/bubble: ${JSON.stringify(bubble)}`);
    await page.locator('section[data-shot="forms"] .card').nth(1).screenshot({ path: file(`${theme}-slider`) });
    await page.mouse.up();
    await page.mouse.move(2, 2);
  }

  // ---------------------------------------------------------------- theme switching redraws the charts
  await open(page, url, 'light');
  const before = await page.evaluate(() => document.querySelector('#c-bar-h canvas').toDataURL());
  await page.evaluate(() => window.__demo.setTheme('dark'));
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => document.querySelector('#c-bar-h canvas').toDataURL());
  check(before !== after, 'charts did not redraw after switching the theme at runtime');

  // ---------------------------------------------------------------- token parity: data-theme vs prefers-color-scheme vs print
  const snapshot = async (theme, scheme, media) => {
    await page.emulateMedia({ colorScheme: scheme, media });
    await open(page, url, theme);
    return page.evaluate(readTokens, TOKEN_NAMES);
  };
  const lightRef = await snapshot('light', 'light', 'screen');
  const darkRef = await snapshot('dark', 'dark', 'screen');
  check(diff(lightRef, darkRef).length > 30, 'light and dark themes barely differ (expected many themed tokens)');
  const cases = [
    ['auto + OS dark = dark', await snapshot(null, 'dark', 'screen'), darkRef],
    ['forced dark + OS light = dark', await snapshot('dark', 'light', 'screen'), darkRef],
    ['auto + OS light = light', await snapshot(null, 'light', 'screen'), lightRef],
    ['forced light + OS dark = light', await snapshot('light', 'dark', 'screen'), lightRef],
    ['print (forced dark) = light', await snapshot('dark', 'dark', 'print'), lightRef],
    ['print (OS dark) = light', await snapshot(null, 'dark', 'print'), lightRef],
  ];
  for (const [name, got, want] of cases) check(diff(got, want).length === 0, `token parity "${name}":\n    ${diff(got, want).slice(0, 8).join('\n    ')}`);
  notes.push(`${TOKEN_NAMES.length} tokens, ${diff(lightRef, darkRef).length} themed, parity verified across data-theme / prefers-color-scheme / print`);

  // ---------------------------------------------------------------- reduced motion, print rules
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce', media: 'screen' });
  await open(page, url, 'light');
  const motion = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--t-base').trim());
  check(motion === '0ms', `prefers-reduced-motion should zero --t-base, got "${motion}"`);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference', media: 'print' });
  await open(page, url, 'dark');
  const printed = await page.evaluate(() => ({ toolbar: getComputedStyle(document.querySelector('.toolbar')).display, bg: getComputedStyle(document.body).backgroundColor }));
  check(printed.toolbar === 'none' && printed.bg === 'rgb(255, 255, 255)', `print rules: ${JSON.stringify(printed)}`);
  await page.emulateMedia({ media: 'screen' });

  // ---------------------------------------------------------------- mobile (390 px)
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
    await open(page, url, theme);
    const overflow = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const clipped = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) if (/auto|scroll|hidden/.test(getComputedStyle(n).overflowX)) return true; return false; };
      const wide = [...document.body.querySelectorAll('*')].filter((el) => !clipped(el) && el.getBoundingClientRect().right > vw + 1 && getComputedStyle(el).position !== 'fixed' && el.getBoundingClientRect().width > 0);
      return { scrollWidth: document.documentElement.scrollWidth, vw, wide: wide.slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${el.className && el.className.baseVal === undefined ? String(el.className).split(' ')[0] : ''}`) };
    });
    check(overflow.scrollWidth <= overflow.vw && overflow.wide.length === 0, `[mobile ${theme}] horizontal overflow: ${JSON.stringify(overflow)}`);
    const contrast = await page.evaluate(auditContrast);
    check(contrast.length === 0, `[mobile ${theme}] text contrast below AA:\n    ${contrast.join('\n    ')}`);
    await shootSections(page, `mobile-${theme}`);
  }
  check(errors.length === 0, `console errors / warnings / failed requests:\n    ${errors.join('\n    ')}`);
}, { viewport: { width: 1440, height: 1000 } });

console.log(notes.join('\n'));
if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nUI kit checks passed. Screenshots: e2e-output/uikit-*.png');
}
