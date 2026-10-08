// Independent review of the UI kit (css/tokens.css, css/components.css, js/ui/icons.js, js/ui/charts.js, docs/UI-KIT.md).
// Node-only checks: property tests of the pure chart maths, a docs-versus-code cross-check, token parity and contrast maths on
// the design tokens. Browser behaviour (forced colours, focus, canvas text, lifecycle, touch) lives in tests/e2e/uikit-review.mjs.
//
// Every defect of the first review round is fixed; the tests that pinned them down are regression guards now. A new defect
// found in review gets a test named "DEFECT UIKIT-n (severity): ..." that fails until it is fixed (high = broken / illegible /
// inaccessible, medium = unpolished / inconsistent / wrong docs, low = nit); rename it once the fix is in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as charts from '../js/ui/charts.js';
import * as iconsModule from '../js/ui/icons.js';
import { contrast, inkFor, shade } from '../js/ui/theme.js';
import { createRng } from '../js/util/rng.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const css = read('css/components.css');
const tokensCss = read('css/tokens.css');
const uiKitDoc = read('docs/UI-KIT.md');
const architectureDoc = read('docs/ARCHITECTURE.md');
const chartsSource = read('js/ui/charts.js');

// ---------------------------------------------------------------------------------------------- token parsing

/** Custom properties declared inside the first block that starts with `selector` (comments stripped). */
function tokenBlock(selector) {
  const start = tokensCss.indexOf(selector);
  assert.ok(start >= 0, `selector ${selector} not found in tokens.css`);
  const open = tokensCss.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < tokensCss.length; i++) {
    if (tokensCss[i] === '{') depth++;
    if (tokensCss[i] === '}' && --depth === 0) { end = i; break; }
  }
  const body = tokensCss.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const LIGHT = tokenBlock('\n:root {');
const DARK_ATTRIBUTE = tokenBlock("\n:root[data-theme='dark'] {");
const DARK = { ...LIGHT, ...DARK_ATTRIBUTE };
const THEMES = { light: LIGHT, dark: DARK };

/** '#rrggbb' | 'rgba(r, g, b, a)' | 'var(--x)' -> { r, g, b, a } against a theme's token map. */
function colour(value, theme) {
  const v = value.trim();
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref) return colour(theme[ref[1]], theme);
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4), 16), a: 1 };
  const rgba = v.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(rgba, `cannot parse colour "${value}"`);
  const p = rgba[1].split(/[\s,]+/).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
const over = (top, below) => ({ r: top.r * top.a + below.r * (1 - top.a), g: top.g * top.a + below.g * (1 - top.a), b: top.b * top.a + below.b * (1 - top.a), a: 1 });
const toHex = ({ r, g, b }) => `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
/** WCAG contrast of token `fg` on token `bg` (translucent colours composited over --surface). */
function ratio(theme, fg, bg) {
  const surface = colour(theme['--surface'], theme);
  const back = over(colour(theme[`--${bg}`], theme), surface);
  return contrast(toHex(over(colour(theme[`--${fg}`], theme), back)), toHex(back));
}

// ---------------------------------------------------------------------------------------------- token blocks

test('token blocks: dark by media query equals dark by attribute, print equals light, every themed token has a light default (guard)', () => {
  assert.deepEqual(tokenBlock("\n  :root:not([data-theme='light']) {"), DARK_ATTRIBUTE, 'the two dark blocks drifted apart');
  const print = tokenBlock('\n  :root:root:root {');
  assert.deepEqual(Object.keys(print).sort(), Object.keys(DARK_ATTRIBUTE).sort(), 'print must restate exactly the tokens that dark overrides');
  for (const [name, value] of Object.entries(print)) assert.equal(value, LIGHT[name], `print ${name} differs from the light theme`);
  assert.deepEqual(Object.keys(DARK_ATTRIBUTE).filter((name) => !(name in LIGHT)), [], 'tokens that only exist in the dark theme');
});

test('components.css only reads tokens that tokens.css defines (or that the same file declares)', () => {
  const declaredHere = [...css.matchAll(/(--[a-z0-9_-]+)\s*:/g)].map((m) => m[1]);
  const defined = new Set([...Object.keys(LIGHT), ...declaredHere]);
  // var(--x, fallback) is a component input a page may set (--gap, --w, --cols ...); var(--x) without one must resolve.
  const used = new Set([...css.matchAll(/var\((--[a-z0-9_-]+)\s*\)/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((name) => !defined.has(name)), []);
});

// ---------------------------------------------------------------------------------------------- contrast

test('text tokens are AA on every surface in both themes (guard)', () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const fg of ['text', 'text-dim', 'text-faint']) {
      for (const bg of ['surface', 'bg', 'surface-2', 'surface-3']) {
        assert.ok(ratio(theme, fg, bg) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(theme, fg, bg).toFixed(2)}:1`);
      }
    }
  }
});

/** Declarations of the first rule in components.css whose selector list is exactly `selector`. */
function ruleBody(selector) {
  const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `no rule for ${selector} in components.css`);
  return match[1];
}

test('WCAG 1.4.11: control outlines, the off state of switches and the slider rail reach 3:1 on the surface and the page background', () => {
  // --control-border outlines .input, .input-group, .stepper, check boxes and radios; --control-track is the off switch and the slider rail.
  const failures = [];
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const token of ['control-border', 'control-border-hover', 'control-track']) {
      for (const bg of ['surface', 'bg']) {
        const r = ratio(theme, token, bg);
        if (r < 3) failures.push(`${name}: --${token} on --${bg} is ${r.toFixed(2)}:1 (needs 3:1)`);
      }
    }
    // the white thumb of an off switch sits on the track
    const thumb = contrast('#ffffff', toHex(colour(theme['--control-track'], theme)));
    if (thumb < 3) failures.push(`${name}: white switch thumb on --control-track is ${thumb.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, []);
});

test('the controls named in the docs really draw with the 3:1 tokens', () => {
  for (const selector of ['.input', '.input-group', '.stepper']) assert.match(ruleBody(selector), /border: 1px solid var\(--control-border\)/, selector);
  assert.match(ruleBody('.check input'), /border: 1px solid var\(--control-border\)/);
  assert.match(ruleBody('.switch__track'), /background: var\(--control-track\)/);
  assert.match(css, /::-webkit-slider-runnable-track \{[^}]*var\(--control-track\)/);
  assert.match(css, /::-moz-range-track \{[^}]*var\(--control-track\)/);
  for (const selector of ['.input:hover', '.input-group:hover', '.stepper:hover', '.check input:hover']) assert.match(ruleBody(selector), /var\(--control-border-hover\)/, selector);
});

test('the focus ring reaches 3:1 on every surface it can sit on; toasts switch to the inverse accent', () => {
  // Buttons inside .toast sit on --inverse-bg, which is light in the dark theme, so the ring colour changes there.
  const failures = [];
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const bg of ['surface', 'bg', 'surface-2', 'surface-3']) {
      const r = ratio(theme, 'accent', bg);
      if (r < 3) failures.push(`${name}: focus ring (--accent) on --${bg} is ${r.toFixed(2)}:1`);
    }
    const r = ratio(theme, 'inverse-accent', 'inverse-bg');
    if (r < 3) failures.push(`${name}: focus ring (--inverse-accent) on --inverse-bg is ${r.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, []);
  const toast = ruleBody('.toast');
  assert.match(toast, /--focus-color: var\(--inverse-accent\)/);
  assert.match(toast, /--focus-ring: 2px solid var\(--focus-color\)/, '--focus-ring is resolved where it is declared, so the toast must redeclare it');
});

test('text drawn on state colours inside stacked bars (ink chosen by inkFor), hovered or not, is AA at 11 px', () => {
  // charts.js prints "46 %" inside each segment with inkFor(fill); the segment colours are the --state-* tokens.
  // A hovered segment is lifted by 22 % white, and the label ink is chosen for that colour.
  const failures = [];
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const key of charts.STATE_KEYS) {
      const resting = toHex(colour(theme[`--state-${key}`], theme));
      for (const fill of [resting, shade(resting, 0.22)]) {
        const r = contrast(fill, inkFor(fill));
        if (r < 4.5) failures.push(`${name}: ${key} ${fill} with ${inkFor(fill)} is ${r.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------------------------- docs versus code

test('UI-KIT.md: every documented class exists in the stylesheets (guard)', () => {
  const known = new Set([...(css + tokensCss).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const documented = new Set();
  for (const m of uiKitDoc.matchAll(/`\.([a-zA-Z][\w-]*)[^`]*`/g)) documented.add(m[1]);
  for (const m of uiKitDoc.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => documented.add(c));
  const patterns = new Set(['chart-', 'icon--name']); // prefixes and wildcards written as prose
  const missing = [...documented].filter((c) => !known.has(c) && !patterns.has(c) && !c.includes('*'));
  assert.deepEqual(missing, []);
});

test('UI-KIT.md: every documented export exists with the documented name (guard)', () => {
  const exported = { ...charts, ...iconsModule };
  const names = new Set([...uiKitDoc.matchAll(/`((?:create[A-Z]\w+|segmentsFromShares|niceTicks|timeTicks|formatTick|formatTimeTick|formatValue|autoDigits|stepDecimals|linearScale|bandScale|groupLayout|stackSegments|segmentRects|nearestIndex|nearestPoint|hitRect|clampTooltip|truncateText|crispLine|hairlineWidth|fitTicks|seriesExtent|allIntegers|finiteRuns|bestWorst|gaugeFraction|gaugeBands|gaugeBandAt|STATE_KEYS|STATE_LABELS|icon|iconSvg|ICON_NAMES))\b/g)].map((m) => m[1]));
  assert.ok(names.size > 30);
  assert.deepEqual([...names].filter((n) => !(n in exported)), []);
  const section = uiKitDoc.slice(uiKitDoc.indexOf('### 5.6'), uiKitDoc.indexOf('## 6.'));
  const listed = new Set([...section.matchAll(/`(\w+)(?:\([^`]*\))?`/g)].map((m) => m[1]));
  assert.deepEqual(Object.keys(charts).filter((n) => !/^create/.test(n) && !listed.has(n)), [], 'exports missing from the pure-helper list in section 5.6');
});

test('UI-KIT.md: the icon table lists exactly the registered icons and the count is right (guard)', () => {
  const table = uiKitDoc.slice(uiKitDoc.indexOf('| Group | Names |'), uiKitDoc.indexOf('Station type to icon'));
  const listed = new Set([...table.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
  assert.deepEqual(iconsModule.ICON_NAMES.filter((n) => !listed.has(n)), []);
  assert.match(uiKitDoc, new RegExp(`${iconsModule.ICON_NAMES.length} inline SVG icons`));
});

test('UI-KIT.md: every documented option is read by the chart it is documented for (guard)', () => {
  const documented = {
    createLineChart: ['x', 'series', 'xAxis', 'xLabel', 'yLabel', 'xUnit', 'yUnit', 'xFormat', 'yFormat', 'yMin', 'yMax', 'includeZero', 'refLines', 'markers', 'legend', 'height', 'empty', 'onPointClick', 'ariaLabel'],
    createBarChart: ['categories', 'series', 'orientation', 'unit', 'digits', 'valueFormat', 'valueLabel', 'min', 'max', 'labels', 'highlight', 'better', 'height', 'onBarClick'],
    createStackedBar: ['rows', 'normalize', 'max', 'legend', 'valueFormat', 'onSegmentClick'],
    createSparkline: ['values', 'color', 'area', 'width', 'height', 'min', 'max', 'unit'],
    createGauge: ['value', 'min', 'max', 'thresholds', 'label', 'format', 'unit', 'size'],
  };
  // Each chart lives between its banner comment and the next chart's banner (its model helper sits above the factory).
  const banners = { createLineChart: '// Line chart', createBarChart: '// Bar chart', createStackedBar: '// Stacked bar', createSparkline: '// Sparkline', createGauge: '// Gauge' };
  const starts = Object.values(banners).map((title) => chartsSource.indexOf(`\n${title}`));
  assert.ok(starts.every((s, i) => s > 0 && (i === 0 || s > starts[i - 1])), 'chart banners not found in order');
  Object.entries(documented).forEach(([factory, options], i) => {
    const region = chartsSource.slice(starts[i], starts[i + 1]);
    assert.match(region, new RegExp(`export function ${factory}\\(`));
    for (const option of options) assert.match(region, new RegExp(`\\b${option}\\b`), `${factory}: documented option "${option}" never appears in the implementation`);
  });
});

test('every chart name in the ARCHITECTURE.md contract (section 6.6) is exported by charts.js or explained in UI-KIT.md', () => {
  // The dashboard and compare panels are written against the architecture contract; a wrong name fails npm run check.
  // The contract predates the code and calls the factories lineChart, barChart, ...; the code exports createLineChart, ... .
  // The contract file belongs to another owner, so until it is updated the kit docs must say how the names map.
  const section = architectureDoc.slice(architectureDoc.indexOf('### 6.6'), architectureDoc.indexOf('### 6.7'));
  const bullet = section.split('\n').find((line) => line.includes('`charts.js`')) ?? '';
  const named = [...bullet.matchAll(/`([a-zA-Z]+)(?:\/([a-zA-Z]+))?`/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean).filter((n) => n !== 'charts' && !/\.js$/.test(n));
  assert.ok(named.length >= 5, 'the contract bullet for charts.js was not found');
  const unexplained = named.filter((n) => typeof charts[n] !== 'function' && !uiKitDoc.includes(n));
  assert.deepEqual(unexplained, [], `section 6.6 names ${unexplained.join(', ')}: neither exported by charts.js nor mentioned in docs/UI-KIT.md`);
  for (const n of named.filter((name) => typeof charts[name] !== 'function' && typeof charts[`create${name[0].toUpperCase()}${name.slice(1)}`] === 'function')) {
    assert.match(uiKitDoc, new RegExp(`create${n[0].toUpperCase()}${n.slice(1)}`), `${n} maps to a create* factory that UI-KIT.md does not document`);
  }
});

test('UI-KIT.md promises aria-checked styling for check menu items and components.css delivers it', () => {
  assert.match(uiKitDoc, /`aria-checked` for check items/);
  const styled = /\.menu__item(?:\[aria-checked|[^{]*\[aria-checked)/.test(css) || /\[aria-checked[^{]*\.menu__icon/.test(css);
  assert.ok(styled, 'no .menu__item[aria-checked] rule: a menuitemcheckbox looks the same checked and unchecked');
});

test('charts.js header comment states the same bar thickness as the code and the docs', () => {
  const header = /bars at most (\d+) px thick/.exec(chartsSource.slice(0, 1200));
  const constant = /const BAR_MAX_THICKNESS = (\d+);/.exec(chartsSource);
  const documented = /bars are at most (\d+) px thick/.exec(uiKitDoc);
  assert.ok(header && constant && documented);
  assert.equal(header[1], constant[1], `header comment says ${header[1]} px, BAR_MAX_THICKNESS is ${constant[1]}`);
  assert.equal(documented[1], constant[1]);
});

// ---------------------------------------------------------------------------------------------- property tests of the pure maths

const rng = createRng(20240611);
const magnitude = () => {
  const kind = rng.int(8);
  if (kind === 0) return 0;
  return rng.range(-1, 1) * 10 ** rng.range(-9, 12);
};

test('niceTicks: covers the range, ascends strictly, stays within the budget, labels are unique and finite (property test)', () => {
  for (let i = 0; i < 6000; i++) {
    const integer = rng.next() < 0.3;
    let a = magnitude();
    let b = magnitude();
    if (integer) { a = Math.round(a); b = Math.round(b); }
    const budget = 2 + rng.int(9);
    const t = charts.niceTicks(a, b, budget, { integer });
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const tol = (hi - lo) * 1e-6;
    assert.ok(t.ticks.every(Number.isFinite), `non-finite tick for ${a}, ${b}`);
    if (lo !== hi) assert.ok(t.min <= lo + tol && t.max >= hi - tol, `${a}..${b} budget ${budget} not covered by ${t.min}..${t.max}`);
    t.ticks.forEach((v, k) => { if (k) assert.ok(v > t.ticks[k - 1], `ticks not ascending for ${a}, ${b}: ${t.ticks}`); });
    if (Math.abs(lo) < 1e14 && Math.abs(hi) < 1e14) assert.ok(t.ticks.length <= Math.max(budget, 3), `${a}..${b} budget ${budget} gave ${t.ticks.length} ticks`);
    const labels = t.ticks.map((v) => charts.formatTick(v, t.step));
    assert.ok(labels.every((l) => !/NaN|undefined|Infinity/.test(l)), `bad label in ${labels}`);
    assert.equal(new Set(labels).size, labels.length, `duplicate tick labels for ${a}..${b}: ${labels}`);
  }
});

test('timeTicks: covers the range with unique, finite labels (property test)', () => {
  for (let i = 0; i < 3000; i++) {
    const a = rng.range(0, 1e6) * rng.next();
    const b = a + rng.range(0, 1e7) * rng.next();
    const budget = 2 + rng.int(9);
    const t = charts.timeTicks(a, b, budget);
    assert.ok(t.min <= a + 1e-9 && t.max >= b - 1e-9);
    assert.ok(t.ticks.length <= Math.max(budget, 3));
    const labels = t.ticks.map((v) => charts.formatTimeTick(v, t.step));
    assert.equal(new Set(labels).size, labels.length, `duplicate time labels ${labels}`);
    assert.ok(labels.every((l) => !/NaN|undefined|Infinity/.test(l)));
  }
});

test('clampTooltip keeps the tooltip inside the container whenever it fits; nearestIndex agrees with brute force (property test)', () => {
  for (let i = 0; i < 3000; i++) {
    const container = { w: rng.range(100, 800), h: rng.range(60, 500) };
    const tip = { w: rng.range(20, 300), h: rng.range(20, 200) };
    const anchor = { x: rng.range(-20, container.w + 20), y: rng.range(-20, container.h + 20) };
    const p = charts.clampTooltip(anchor, container, tip);
    if (tip.w <= container.w - 8) assert.ok(p.left >= 4 - 1e-9 && p.left + tip.w <= container.w - 4 + 1e-9);
    if (tip.h <= container.h - 8) assert.ok(p.top >= 4 - 1e-9 && p.top + tip.h <= container.h - 4 + 1e-9);
  }
  for (let i = 0; i < 2000; i++) {
    const sorted = Array.from({ length: rng.int(30) }, () => rng.range(-100, 100)).sort((a, b) => a - b);
    const x = rng.range(-120, 120);
    const got = charts.nearestIndex(sorted, x);
    if (!sorted.length) { assert.equal(got, -1); continue; }
    const best = Math.min(...sorted.map((v) => Math.abs(v - x)));
    assert.ok(Math.abs(Math.abs(sorted[got] - x) - best) < 1e-9);
  }
});

test('groupLayout: bars of a group never overlap and stay inside the band when it is wide enough (property test)', () => {
  for (let i = 0; i < 2000; i++) {
    const band = rng.range(0, 200);
    const n = 1 + rng.int(8);
    const g = charts.groupLayout(band, n, { maxThickness: 18 });
    for (let k = 0; k < n - 1; k++) assert.ok(g.offset(k) + g.thickness <= g.offset(k + 1) + 1e-9);
    if (band > 4 * n) assert.ok(g.offset(0) >= -1e-9 && g.offset(n - 1) + g.thickness <= band + 1e-9);
  }
});

test('segmentRects: every rectangle stays inside the bar and none overlaps its neighbour, even with sub-pixel segments (property test)', () => {
  // Segments narrower than the gap used to be forced to 1 px, which pushed later ones past the end and over their neighbours.
  const offenders = [];
  for (let i = 0; i < 3000; i++) {
    const values = Array.from({ length: 2 + rng.int(10) }, () => (rng.next() < 0.3 ? 0 : rng.next() < 0.15 ? rng.range(0, 0.001) : rng.next()));
    const width = rng.range(1, 900);
    const rects = charts.segmentRects(charts.stackSegments(values), width, 2).filter((r) => r.w > 0);
    let end = -Infinity;
    for (const r of rects) {
      if (r.x < end - 1e-9) { offenders.push(`overlap at width ${width.toFixed(0)}`); break; }
      end = r.x + r.w;
    }
    if (end > width + 1e-6) offenders.push(`ends ${(end - width).toFixed(2)} px past the bar (width ${width.toFixed(0)})`);
  }
  assert.deepEqual(offenders.slice(0, 5), [], `${offenders.length} of 3000 random stacks break the layout invariant`);
});

test('gauge helpers: bands tile 0..1 and band lookup never throws for odd ranges (property test)', () => {
  for (let i = 0; i < 2000; i++) {
    const min = magnitude();
    const max = magnitude();
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const thresholds = Array.from({ length: rng.int(5) }, () => ({ to: rng.range(lo, hi), color: 'good' }));
    const bands = charts.gaugeBands(min, max, thresholds);
    assert.ok(bands.length >= 1);
    for (const b of bands) assert.ok(b.frac0 >= 0 && b.frac1 <= 1 && b.frac1 >= b.frac0, JSON.stringify(b));
    assert.ok(bands.includes(charts.gaugeBandAt(magnitude(), bands)));
  }
});
