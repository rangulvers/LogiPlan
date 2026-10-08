// Dependency-free charts for the dashboard, experiments and report views (docs/ARCHITECTURE.md section 6.6).
//
// Five chart types, each a small DOM wrapper around a hi-dpi <canvas>:
//   createLineChart, createBarChart, createStackedBar, createSparkline, createGauge  ->  { el, update(patch), destroy() }
//
// Charts are theme-aware: colours are read from the CSS custom properties of css/tokens.css (getComputedStyle on
// the chart element) every time a frame is drawn, and a frame is redrawn when the data-theme attribute or the OS colour scheme changes.
// Marks follow the data-viz rules of the kit: 2 px lines, bars at most 24 px thick with a 4 px rounded data end,
// 2 px surface gaps between touching fills, recessive 1 px gridlines, text always in text tokens.
//
// Everything that is pure maths (nice ticks, scales, stacking, hit testing, formatting) is exported at the top of
// the file and unit-tested in tests/ui.charts.test.js; those functions never touch the DOM, so this module can be
// imported in Node. The DOM parts below the "browser" banner need `document` and are only called from the UI.

import { h } from '../util/dom.js';
import { clamp, formatClock, formatNumber, formatPercent, round } from '../util/format.js';
import { rectsOverlap } from '../util/grid.js';
import { inkFor } from './theme.js';

// ==================================================================================================
// Pure helpers
// ==================================================================================================

const EPS = 1e-9;
const clean = (v) => (v === 0 ? 0 : v); // turns -0 into 0 so it never prints as "-0"

const MAX_DECIMALS = 15;

/** Number of decimals needed to print multiples of `step` exactly (0.25 -> 2, 5 -> 0). */
export function stepDecimals(step) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  for (let d = 0; d < MAX_DECIMALS; d++) {
    const s = step * 10 ** d;
    if (Math.abs(s - Math.round(s)) < 1e-6 * s) return d;
  }
  return MAX_DECIMALS;
}

/** Bounds beyond this are clamped so step arithmetic stays finite. */
const TICK_LIMIT = 1e15;

/** Tick steps tried in ascending order within each power of ten. */
const STEP_MULTIPLES = [1, 2, 2.5, 5, 10];

/** Number of multiples of `step` needed to cover [lo, hi]. */
const tickCount = (lo, hi, step) => Math.ceil(hi / step - EPS) - Math.floor(lo / step + EPS) + 1;

/**
 * Axis ticks on round numbers (1, 2, 2.5 or 5 times a power of ten) that cover [min, max] with at most `maxTicks`
 * ticks, using the smallest step that fits. Reversed or equal bounds are repaired, non-finite bounds fall back to
 * 0..1; never throws.
 * @param {number} min
 * @param {number} max
 * @param {number} [maxTicks] tick budget (at least 2; a range that crosses zero always needs 3)
 * @param {{ integer?: boolean }} [opts] integer data: only whole-number steps (never 0.5 or 2.5)
 * @returns {{ min: number, max: number, step: number, ticks: number[] }} min/max are the first/last tick
 */
export function niceTicks(min, max, maxTicks = 5, { integer = false } = {}) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  lo = clamp(lo, -TICK_LIMIT, TICK_LIMIT);
  hi = clamp(hi, -TICK_LIMIT, TICK_LIMIT);
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else { const pad = Math.abs(lo) * 0.1; lo -= pad; hi += pad; }
  }
  const budget = Math.max(2, Math.floor(maxTicks) || 2);
  // A range that crosses zero needs three ticks whatever the step, so the search ends at a step of the data's size.
  const limit = 10 * Math.max(Math.abs(lo), Math.abs(hi), hi - lo);
  let step = 0;
  for (let power = Math.floor(Math.log10((hi - lo) / (budget - 1))) - 1; !step; power++) {
    step = STEP_MULTIPLES.map((m) => m * 10 ** power).find((st) => (!integer || Number.isInteger(st)) && (tickCount(lo, hi, st) <= budget || st >= limit)) ?? 0;
  }
  const start = Math.floor(lo / step + EPS) * step;
  const decimals = stepDecimals(step);
  const ticks = [];
  for (let i = 0, n = tickCount(lo, hi, step) - 1; i <= n; i++) ticks.push(clean(round(start + i * step, decimals)));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/** Candidate tick steps for time axes (seconds): 1 s ... 1 day. */
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400];

/**
 * Ticks for an axis measured in seconds, on clock-friendly steps (minutes, hours). Falls back to niceTicks
 * for ranges beyond a few days or an empty range.
 * @returns {{ min: number, max: number, step: number, ticks: number[] }}
 */
export function timeTicks(min, max, maxTicks = 6) {
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return niceTicks(lo, hi, maxTicks);
  const step = TIME_STEPS.find((s) => Math.ceil(hi / s) - Math.floor(lo / s) + 1 <= maxTicks);
  if (!step) return niceTicks(lo, hi, maxTicks);
  const first = Math.floor(lo / step);
  const last = Math.ceil(hi / step);
  const ticks = [];
  for (let i = first; i <= last; i++) ticks.push(i * step);
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/** Compact label for a time-axis tick: "0", "30 s", "15 min", "2.5 h". */
export function formatTimeTick(seconds, step) {
  if (!Number.isFinite(seconds)) return '–';
  if (seconds === 0) return '0';
  if (step >= 3600) return `${formatNumber(seconds / 3600, stepDecimals(step / 3600))} h`;
  if (step >= 60) return `${formatNumber(seconds / 60, stepDecimals(step / 60))} min`;
  return `${formatNumber(seconds, stepDecimals(step))} s`;
}

/** Label for an axis tick: thousands separators, decimals taken from the step, 12k / 1.5M above 10 000. */
export function formatTick(value, step) {
  if (!Number.isFinite(value)) return '–';
  const a = Math.abs(value);
  if (a >= 1e6) return `${formatNumber(value / 1e6, stepDecimals(step / 1e6))}M`;
  if (a >= 1e4) return `${formatNumber(value / 1e3, stepDecimals(step / 1e3))}k`;
  return formatNumber(clean(value), stepDecimals(step));
}

/** Sensible number of decimals for a value shown without a step: 123, 12.3, 1.23, 0.123. */
export function autoDigits(value) {
  const a = Math.abs(value);
  if (!(a > 0)) return 0;
  return a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
}

/** "42.5 units/h": value with optional unit; non-finite values print as an en dash. */
export function formatValue(value, { unit = '', digits } = {}) {
  if (!Number.isFinite(value)) return '–';
  const text = formatNumber(clean(value), digits ?? autoDigits(value));
  return unit ? `${text} ${unit}` : text;
}

/**
 * Linear mapping from a data domain to a pixel range, with `.invert`. A flat domain maps everything to the
 * middle of the range, so charts of constant data stay centred instead of dividing by zero.
 * @param {[number, number]} domain
 * @param {[number, number]} range
 * @param {{ clamp?: boolean }} [opts] clamp the result to the range
 */
export function linearScale(domain, range, { clamp: doClamp = false } = {}) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const flat = !Number.isFinite(span) || span === 0;
  const scale = (v) => {
    let t = flat ? 0.5 : (v - d0) / span;
    if (doClamp) t = clamp(t, 0, 1);
    return r0 + (r1 - r0) * t;
  };
  scale.invert = (r) => (flat || r1 === r0 ? d0 : d0 + ((r - r0) / (r1 - r0)) * span);
  scale.domain = [d0, d1];
  scale.range = [r0, r1];
  return scale;
}

/**
 * Evenly divided bands (one per category). `padding` is the share of each band left empty.
 * @param {number} count number of bands
 * @param {[number, number]} range pixel range, r0 <= r1
 * @param {number} [padding] 0..0.9
 */
export function bandScale(count, range, padding = 0.2) {
  const n = Math.max(0, Math.floor(count) || 0);
  const [r0, r1] = range;
  const step = n > 0 ? (r1 - r0) / n : 0;
  const bandwidth = step * (1 - clamp(padding, 0, 0.9));
  return {
    count: n,
    step,
    bandwidth,
    start: (i) => r0 + i * step + (step - bandwidth) / 2,
    center: (i) => r0 + (i + 0.5) * step,
    /** Band index under a pixel position, -1 outside the range. */
    indexAt: (pos) => (n === 0 || !(pos >= r0) || pos >= r1 ? -1 : Math.min(n - 1, Math.floor((pos - r0) / step))),
  };
}

/**
 * Bars of one category group inside a band: each at most `maxThickness` thick, `gap` apart, centred.
 * @param {number} bandwidth size of the band across the bars
 * @param {number} count bars in the group (series count)
 */
export function groupLayout(bandwidth, count, { maxThickness = 24, gap = 2 } = {}) {
  const n = Math.max(1, Math.floor(count) || 1);
  const thickness = Math.max(1, Math.min(maxThickness, Math.max(0, bandwidth - gap * (n - 1)) / n));
  const total = thickness * n + gap * (n - 1);
  const first = (bandwidth - total) / 2;
  return {
    thickness,
    total,
    offset: (i) => first + i * (thickness + gap),
    /** Bar whose centre is closest to `pos` (position relative to the band start). */
    indexAt: (pos) => clamp(Math.round((pos - first - thickness / 2) / (thickness + gap)), 0, n - 1),
  };
}

/**
 * Fractions of a stacked bar. Negative, zero and non-finite values take no space.
 * @param {number[]} values
 * @param {{ total?: number }} [opts] denominator; defaults to the sum, so the stack fills the bar
 * @returns {Array<{ index: number, value: number, frac: number, start: number, end: number }>} start/end in 0..1 of `total`
 */
export function stackSegments(values, { total } = {}) {
  const vals = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  const denom = total !== undefined && Number.isFinite(total) && total > 0 ? total : sum;
  let acc = 0;
  return vals.map((value, index) => {
    const frac = denom > 0 ? value / denom : 0;
    const seg = { index, value, frac, start: acc, end: acc + frac };
    acc += frac;
    return seg;
  });
}

/**
 * Pixel rectangles {x, w} for stacked segments: empty segments get w = 0, touching segments are separated by a
 * `gap` of surface colour (split between both neighbours), tiny non-empty segments stay at least 1 px wide.
 */
export function segmentRects(segments, width, gap = 2) {
  const live = segments.filter((s) => s.frac > 0);
  const first = live[0];
  const last = live[live.length - 1];
  return segments.map((s) => {
    if (!(s.frac > 0)) return { x: s.start * width, w: 0 };
    const left = s === first ? 0 : gap / 2;
    const right = s === last ? 0 : gap / 2;
    const x = s.start * width + left;
    return { x, w: Math.max(1, (s.end - s.start) * width - left - right) };
  });
}

/** Index of the value closest to `x` in an ascending numeric array of finite numbers; ties pick the lower index; -1 if empty. */
export function nearestIndex(sorted, x) {
  const n = sorted.length;
  if (n === 0 || !Number.isFinite(x)) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && Math.abs(sorted[lo - 1] - x) <= Math.abs(sorted[lo] - x) ? lo - 1 : lo;
}

/** Index of the {x, y} point nearest to (px, py) within `maxDist` pixels, else -1. Non-finite points are skipped. */
export function nearestPoint(points, px, py, maxDist = Infinity) {
  let best = -1;
  let bestD = maxDist * maxDist;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Index of the rectangle {x, y, w, h} containing (px, py) when each is grown by `slop`; the closest centre wins. */
export function hitRect(rects, px, py, slop = 0) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (px < r.x - slop || px > r.x + r.w + slop || py < r.y - slop || py > r.y + r.h + slop) continue;
    const d = (px - (r.x + r.w / 2)) ** 2 + (py - (r.y + r.h / 2)) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Tooltip position next to an anchor point: right and below by `gap`, flipped to the other side when it would
 * leave the container, then clamped to keep `margin` px inside.
 * @param {{ x: number, y: number }} anchor
 * @param {{ w: number, h: number }} container
 * @param {{ w: number, h: number }} tip
 * @returns {{ left: number, top: number }}
 */
export function clampTooltip(anchor, container, tip, { gap = 12, margin = 4 } = {}) {
  let left = anchor.x + gap;
  if (left + tip.w > container.w - margin) left = anchor.x - gap - tip.w;
  let top = anchor.y + gap;
  if (top + tip.h > container.h - margin) top = anchor.y - gap - tip.h;
  return {
    left: Math.max(margin, Math.min(left, container.w - tip.w - margin)),
    top: Math.max(margin, Math.min(top, container.h - tip.h - margin)),
  };
}

/** Shorten `text` with an ellipsis so that `measure(result) <= maxWidth`; '' when not even the ellipsis fits. */
export function truncateText(text, maxWidth, measure, ellipsis = '…') {
  const s = String(text);
  if (measure(s) <= maxWidth) return s;
  if (measure(ellipsis) > maxWidth) return '';
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(s.slice(0, mid).trimEnd() + ellipsis) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + ellipsis;
}

/** Coordinate that puts a `lineWidth` css-px line exactly on device pixels (crisp hairlines at any devicePixelRatio). */
export function crispLine(v, lineWidth = 1, dpr = 1) {
  const deviceWidth = Math.max(1, Math.round(lineWidth * dpr));
  const dv = v * dpr;
  return (deviceWidth % 2 === 1 ? Math.floor(dv) + 0.5 : Math.round(dv)) / dpr;
}

/** Smallest and largest finite value across several arrays (null entries and non-numbers ignored); null when there is none. */
export function seriesExtent(arrays, { includeZero = false } = {}) {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of arrays) {
    if (!arr) continue;
    for (const v of arr) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min > max) return null;
  if (includeZero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  return { min, max };
}

/** True when every finite value in the arrays is a whole number (so axes should not tick at 2.5 or 0.5). */
export function allIntegers(arrays) {
  return arrays.every((arr) => !arr || arr.every((v) => typeof v !== 'number' || !Number.isFinite(v) || Number.isInteger(v)));
}

/** Inclusive [start, end] index runs of consecutive finite numbers (gaps in a line series). */
export function finiteRuns(values) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    const ok = i < values.length && typeof values[i] === 'number' && Number.isFinite(values[i]);
    if (ok && start < 0) start = i;
    else if (!ok && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  return runs;
}

/**
 * Indices of the best and worst entries among finite values. Ties are all reported; when every value is equal
 * (or fewer than two are finite) nothing is best or worst.
 * @param {number[]} values
 * @param {'higher'|'lower'} better
 * @returns {{ best: number[], worst: number[] }}
 */
export function bestWorst(values, better = 'higher') {
  const finite = values.map((v, i) => [v, i]).filter(([v]) => typeof v === 'number' && Number.isFinite(v));
  if (finite.length < 2) return { best: [], worst: [] };
  const lo = Math.min(...finite.map(([v]) => v));
  const hi = Math.max(...finite.map(([v]) => v));
  if (lo === hi) return { best: [], worst: [] };
  const at = (target) => finite.filter(([v]) => v === target).map(([, i]) => i);
  return better === 'lower' ? { best: at(lo), worst: at(hi) } : { best: at(hi), worst: at(lo) };
}

/** Position of `value` within [min, max] as 0..1 (non-finite values and empty ranges give 0). */
export function gaugeFraction(value, min, max) {
  if (!Number.isFinite(value) || !(max > min)) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

/**
 * Coloured bands of a gauge from thresholds [{ to, color, label? }] (ascending `to`, in value units). The last band
 * extends to `max`, so values above the last threshold keep its colour. No thresholds give one neutral band.
 * @returns {Array<{ from: number, to: number, frac0: number, frac1: number, color: string|null, label: string|null }>}
 */
export function gaugeBands(min, max, thresholds = []) {
  const sorted = thresholds.filter((t) => t && Number.isFinite(t.to)).sort((a, b) => a.to - b.to);
  if (sorted.length === 0) return [{ from: min, to: max, frac0: 0, frac1: 1, color: null, label: null }];
  const bands = [];
  sorted.forEach((t, i) => {
    const from = clamp(i === 0 ? min : sorted[i - 1].to, min, max);
    const to = clamp(i === sorted.length - 1 ? max : t.to, min, max);
    if (to > from) {
      bands.push({ from, to, frac0: gaugeFraction(from, min, max), frac1: gaugeFraction(to, min, max), color: t.color ?? null, label: t.label ?? null });
    }
  });
  return bands.length ? bands : [{ from: min, to: max, frac0: 0, frac1: 1, color: null, label: null }];
}

/** Band containing `value` (the last band for values above the range, the first below it). */
export function gaugeBandAt(value, bands) {
  const hit = bands.find((b) => value >= b.from && value < b.to);
  if (hit) return hit;
  return value < bands[0].from ? bands[0] : bands[bands.length - 1];
}

// ==================================================================================================
// Colours and labels shared by all charts
// ==================================================================================================

/** Operational states with a colour token `--state-<key>` and a display label (vehicle and station states). */
export const STATE_KEYS = Object.freeze(['busy', 'starved', 'blocked', 'down', 'idle', 'driving', 'waiting', 'loading', 'unloading', 'parked', 'charging', 'broken']);
export const STATE_LABELS = Object.freeze({
  busy: 'Busy', starved: 'Starved', blocked: 'Blocked', down: 'Down', idle: 'Idle', driving: 'Driving', waiting: 'Waiting',
  loading: 'Loading', unloading: 'Unloading', parked: 'Parked', charging: 'Charging', broken: 'Broken',
});

const NAMED_TOKENS = { accent: '--accent', good: '--good', warn: '--warn', bad: '--bad', info: '--info', muted: '--text-faint' };

/** A colour reference: a token name ('--series-2'), a name from NAMED_TOKENS, or any CSS colour; default = categorical slot `index`. */
function colorRef(spec, index) {
  if (typeof spec === 'string' && spec) return Object.hasOwn(NAMED_TOKENS, spec) ? NAMED_TOKENS[spec] : spec;
  return index < 8 ? `--series-${index + 1}` : '--series-other';
}

/** CSS value for DOM styling (legend keys follow theme changes without a redraw). */
const cssColor = (ref) => (ref.startsWith('--') ? `var(${ref})` : ref);

/**
 * Stacked-bar segments from a map of shares, e.g. KpiReport.fleets[id].shares.
 * @param {Record<string, number>} shares state -> value
 * @param {string[]} [keys] which states and in which order (default: the object's own order)
 * @returns {Array<{ key: string, label: string, value: number }>}
 */
export function segmentsFromShares(shares, keys = Object.keys(shares || {})) {
  return keys.map((key) => ({ key, label: STATE_LABELS[key] || key, value: Number(shares?.[key]) || 0 }));
}

// ==================================================================================================
// Browser: theme, canvas host, legend, tooltip
// ==================================================================================================

/** Light-theme values used when a token is missing (page without css/tokens.css, or a detached element). */
const FALLBACK = {
  '--font-sans': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  '--text': '#1c2230', '--text-dim': '#4f5d75', '--text-faint': '#5f6c83', '--surface': '#ffffff', '--surface-3': '#edf0f6',
  '--chart-grid': '#e8ecf2', '--chart-axis': '#c3ccda', '--accent': '#2f7df6',
  '--good': '#1f9d5b', '--warn': '#cc7a00', '--bad': '#e5484d', '--info': '#2f7df6',
  '--series-1': '#2a78d6', '--series-2': '#eb6834', '--series-3': '#1baf7a', '--series-4': '#eda100',
  '--series-5': '#e87ba4', '--series-6': '#008300', '--series-7': '#4a3aa7', '--series-8': '#e34948', '--series-other': '#8b93a1',
};

/** Reads the chart palette from the computed style of `el`; unknown tokens resolve through `token(name)`. */
function readTheme(el) {
  const cs = getComputedStyle(el);
  const token = (name) => cs.getPropertyValue(name).trim() || FALLBACK[name] || '';
  return {
    token,
    font: token('--font-sans'),
    text: token('--text'),
    dim: token('--text-dim'),
    faint: token('--text-faint'),
    surface: token('--surface'),
    track: token('--surface-3'),
    grid: token('--chart-grid'),
    axis: token('--chart-axis'),
    accent: token('--accent'),
  };
}

/** Concrete colour for canvas drawing. */
const canvasColor = (ref, theme) => (ref.startsWith('--') ? theme.token(ref) || theme.text : ref);

const themeSubscribers = new Set();
let stopThemeWatch = null;

/** Starts one shared watcher (theme attribute, OS colour scheme, print) that tells every chart to redraw. */
function startThemeWatch() {
  const notify = () => themeSubscribers.forEach((fn) => fn());
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  const queries = typeof matchMedia === 'function' ? [matchMedia('(prefers-color-scheme: dark)'), matchMedia('print')] : [];
  queries.forEach((q) => q.addEventListener('change', notify));
  return () => {
    observer.disconnect();
    queries.forEach((q) => q.removeEventListener('change', notify));
  };
}

/** Subscribe to theme changes; returns the unsubscribe function. The shared watcher exists while anyone listens. */
function watchTheme(fn) {
  themeSubscribers.add(fn);
  if (!stopThemeWatch) stopThemeWatch = startThemeWatch();
  return () => {
    themeSubscribers.delete(fn);
    if (themeSubscribers.size === 0 && stopThemeWatch) { stopThemeWatch(); stopThemeWatch = null; }
  };
}

const setFont = (ctx, theme, size, weight = 400) => { ctx.font = `${weight} ${size}px ${theme.font}`; };

/**
 * The canvas and its chrome: wrapper, empty-state text, tooltip, live region, resize + theme handling and the
 * coalesced redraw. `render({ ctx, w, h, dpr, theme })` is called with a cleared, scaled context.
 */
function createHost({ className, height, render, label }) {
  const canvas = h('canvas', { class: 'chart__canvas', role: 'img', 'aria-label': label || 'Chart' });
  const emptyEl = h('div', { class: 'chart__empty', hidden: true });
  const tipEl = h('div', { class: 'chart-tooltip', hidden: true });
  const liveEl = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const el = h('div', { class: `chart ${className}` }, canvas, emptyEl, tipEl, liveEl);
  const cleanups = [];
  let frame = 0;
  let dead = false;

  const draw = () => {
    frame = 0;
    const w = el.clientWidth;
    const hh = el.clientHeight;
    if (dead || !w || !hh) return;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const pw = Math.round(w * dpr);
    const ph = Math.round(hh * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    render({ ctx, w, h: hh, dpr, theme: readTheme(el) });
  };
  const invalidate = () => { if (!frame && !dead) frame = requestAnimationFrame(draw); };

  const host = {
    el,
    canvas,
    invalidate,
    setHeight(px) { el.style.height = `${px}px`; invalidate(); },
    setLabel(text) { canvas.setAttribute('aria-label', text); },
    /** Show `text` instead of the chart (null/undefined shows the chart). */
    setEmpty(text) {
      emptyEl.hidden = text == null;
      emptyEl.textContent = text ?? '';
      canvas.hidden = text != null;
    },
    /** Pointer position in canvas coordinates. */
    local(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },
    /** Show the tooltip next to `anchor` ({x, y} in canvas coordinates). `announce` also reads it out to screen readers. */
    showTip(spec, anchor, { announce = false } = {}) {
      tipEl.textContent = '';
      if (spec.title) tipEl.append(h('div', { class: 'chart-tooltip__title' }, spec.title));
      for (const row of spec.rows) {
        tipEl.append(h('div', { class: 'chart-tooltip__row' },
          row.color ? h('span', { class: 'chart-tooltip__key', style: { '--c': cssColor(row.color) } }) : null,
          h('span', { class: 'chart-tooltip__name' }, row.detail ? `${row.name} · ${row.detail}` : row.name),
          h('span', { class: 'chart-tooltip__value' }, row.value)));
      }
      if (spec.note) tipEl.append(h('div', { class: 'chart-tooltip__note' }, spec.note));
      tipEl.hidden = false;
      const pos = clampTooltip(anchor, { w: el.clientWidth, h: el.clientHeight }, { w: tipEl.offsetWidth, h: tipEl.offsetHeight });
      tipEl.style.left = `${pos.left}px`;
      tipEl.style.top = `${pos.top}px`;
      if (announce) liveEl.textContent = [spec.title, ...spec.rows.map((r) => `${r.name} ${r.value}`), spec.note].filter(Boolean).join(', ');
    },
    hideTip() { tipEl.hidden = true; },
    listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    },
    destroy() {
      dead = true;
      if (frame) cancelAnimationFrame(frame);
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      el.remove();
    },
  };

  if (height) el.style.height = `${height}px`;
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(invalidate);
    ro.observe(el);
    cleanups.push(() => ro.disconnect());
  } else host.listen(window, 'resize', invalidate);
  cleanups.push(watchTheme(invalidate));
  return host;
}

/** Legend DOM: toggle buttons for series (aria-pressed) or a plain list; keys use CSS variables, so themes switch for free. */
function buildLegend(items, { toggle = false, hidden = new Set(), onToggle, line = false } = {}) {
  const key = (it) => h('span', { class: `chart-legend__key${line ? ' chart-legend__key--line' : ''}`, style: { '--c': cssColor(it.ref) } });
  if (toggle) {
    return h('div', { class: 'chart-legend', role: 'group', 'aria-label': 'Series (click to show or hide)' },
      items.map((it) => h('button', {
        type: 'button', class: 'chart-legend__item', 'aria-pressed': String(!hidden.has(it.index)), onclick: () => onToggle(it.index),
      }, key(it), h('span', null, it.name))));
  }
  return h('ul', { class: 'chart-legend' },
    items.map((it) => h('li', { class: 'chart-legend__item' }, key(it), h('span', null, it.name),
      it.note ? h('span', { class: 'chart-legend__note' }, it.note) : null)));
}

/** Replaces the legend element in place when its description changed; returns the new signature. */
function swapLegend(slot, items, signature, lastSignature, build) {
  if (signature === lastSignature) return lastSignature;
  const next = items.length ? build() : h('div', { hidden: true });
  slot.current.replaceWith(next);
  slot.current = next;
  return signature;
}

/** Pixel-safe rounded rectangle path with an individual radius per corner [tl, tr, br, bl]. */
function roundedRect(ctx, x, y, w, hgt, [tl, tr, br, bl]) {
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + hgt - br);
  ctx.arcTo(x + w, y + hgt, x + w - br, y + hgt, br);
  ctx.lineTo(x + bl, y + hgt);
  ctx.arcTo(x, y + hgt, x, y + hgt - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/** A dot with a 2 px surface ring so it stays legible over lines and other dots. */
function ringDot(ctx, x, y, r, color, surface) {
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = surface;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const column = (arr, len) => Array.from({ length: len }, (_, i) => num(arr?.[i]));

/** Key handling shared by interactive charts: arrows step through items, Home/End jump, Enter/Space activate, Escape clears. */
function keyStep(e, { count, current, onMove, onActivate, onClear }) {
  const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (e.key in moves) onMove(clamp(current < 0 ? (moves[e.key] > 0 ? 0 : count - 1) : current + moves[e.key], 0, count - 1));
  else if (e.key === 'Home') onMove(0);
  else if (e.key === 'End') onMove(count - 1);
  else if ((e.key === 'Enter' || e.key === ' ') && current >= 0) onActivate(current);
  else if (e.key === 'Escape') onClear();
  else return;
  e.preventDefault();
}

// ==================================================================================================
// Line chart
// ==================================================================================================

const LINE_DEFAULTS = { height: 220, includeZero: true, markers: 'auto', legend: 'auto', empty: 'No data yet' };

/** Normalises line-chart options into plain numeric columns (gaps become NaN) so drawing and hit testing never see junk. */
function lineModel(opts) {
  const input = Array.isArray(opts.series) ? opts.series : [];
  const len = Math.max(Array.isArray(opts.x) ? opts.x.length : 0, ...input.map((s) => (Array.isArray(s?.y) ? s.y.length : 0)));
  const xs = Array.from({ length: len }, (_, i) => (Array.isArray(opts.x) ? num(opts.x[i]) : i));
  const series = input.map((s, index) => ({
    index,
    name: String(s?.name ?? `Series ${index + 1}`),
    ref: colorRef(s?.color, index),
    y: column(s?.y, len),
    lo: Array.isArray(s?.lo) ? column(s.lo, len) : null,
    hi: Array.isArray(s?.hi) ? column(s.hi, len) : null,
    area: Boolean(s?.area),
  }));
  const hasData = series.some((s) => s.y.some((v, i) => Number.isFinite(v) && Number.isFinite(xs[i])));
  return { xs, series, hasData };
}

/**
 * Multi-series line chart on a shared x axis, with optional min-max bands, reference lines, legend toggles,
 * a snapping crosshair with tooltip and click / keyboard access to points.
 *
 * @param {object} options
 * @param {number[]} [options.x] shared x values, ascending (default 0..n-1)
 * @param {Array<{ name: string, y: Array<number|null>, lo?: number[], hi?: number[], color?: string, area?: boolean }>} options.series
 *   y values (null = gap); lo/hi draw a band (e.g. min-max over replications); color = token ('--series-3'), 'good'|'bad'|... or CSS colour
 * @param {'linear'|'time'} [options.xAxis] 'time' reads x as seconds and ticks on minutes/hours
 * @param {string} [options.xLabel] axis title below the plot      @param {string} [options.yLabel] axis title above the plot (put the unit here)
 * @param {string} [options.xUnit] @param {string} [options.yUnit] unit appended in tooltips
 * @param {(v: number) => string} [options.xFormat] tooltip header / tick label formatter
 * @param {(v: number) => string} [options.yFormat] tooltip value / tick label formatter
 * @param {number} [options.yMin] @param {number} [options.yMax] fixed y bounds (default: nice ticks around the data)
 * @param {boolean} [options.includeZero] keep 0 on the y axis (default true)
 * @param {Array<{ axis: 'x'|'y', value: number, label?: string }>} [options.refLines] reference lines (targets, current setting)
 * @param {boolean|'auto'} [options.markers] dots on every point ('auto' = when there are at most 24)
 * @param {boolean|'auto'} [options.legend] 'auto' = from two series on
 * @param {number} [options.height] px (default 220)   @param {string} [options.empty] text when there is no data
 * @param {(hit: { seriesIndex: number, index: number, x: number, y: number, series: string }) => void} [options.onPointClick]
 * @param {string} [options.ariaLabel]
 * @returns {{ el: HTMLElement, update(patch: object): void, destroy(): void }}
 */
export function createLineChart(options = {}) {
  const opts = { ...LINE_DEFAULTS, ...options };
  const hidden = new Set();
  let model = lineModel(opts);
  let layout = null;
  let hover = -1;
  let announceNext = false;
  let legendSig = null;
  const slot = { current: h('div', { hidden: true }) };
  const host = createHost({ className: 'chart--line', height: opts.height, render, label: opts.ariaLabel || 'Line chart' });
  host.canvas.tabIndex = 0;

  const visible = () => model.series.filter((s) => !hidden.has(s.index));
  const xFmt = (v) => (opts.xFormat ? opts.xFormat(v) : opts.xAxis === 'time' ? formatClock(v) : formatValue(v, { unit: opts.xUnit }));
  const yFmt = (v) => (opts.yFormat ? opts.yFormat(v) : formatValue(v, { unit: opts.yUnit }));

  /** One frame, then the tooltip for the hovered point, so it always matches the data and layout just drawn. */
  function render(g) {
    draw(g);
    refreshTip();
  }

  function refreshTip() {
    if (hover < 0 || !layout || !Number.isFinite(layout.px[hover])) { host.hideTip(); return; }
    host.showTip(tooltipFor(hover), { x: layout.px[hover], y: layout.plot.y0 }, { announce: announceNext });
    announceNext = false;
  }

  function draw(g) {
    const { ctx, w, h: hgt, theme } = g;
    layout = null;
    const vis = visible();
    const ext = seriesExtent(vis.flatMap((s) => [s.y, s.lo, s.hi]), { includeZero: opts.includeZero });
    const xs = model.xs.filter(Number.isFinite);
    if (!ext || xs.length === 0) return;

    const yTicks = niceTicks(opts.yMin ?? ext.min, opts.yMax ?? ext.max, clamp(Math.floor((hgt - 50) / 40) + 1, 3, 6), { integer: allIntegers(vis.flatMap((s) => [s.y, s.lo, s.hi])) });
    const yDomain = [opts.yMin ?? yTicks.min, opts.yMax ?? yTicks.max];
    const yText = (v) => (opts.yFormat ? opts.yFormat(v) : formatTick(v, yTicks.step));
    setFont(ctx, theme, 11);
    const labelW = Math.max(...yTicks.ticks.map((t) => ctx.measureText(yText(t)).width));
    const plot = { x0: Math.ceil(labelW) + 12, x1: w - 14, y0: opts.yLabel ? 24 : 10, y1: hgt - 22 - (opts.xLabel ? 16 : 0) };
    if (plot.x1 - plot.x0 < 40 || plot.y1 - plot.y0 < 30) return;

    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const xS = linearScale([xMin, xMax], [plot.x0 + 8, plot.x1 - 8]);
    const yS = linearScale(yDomain, [plot.y1, plot.y0]);
    drawLineAxes(g, plot, { xS, yS, yTicks, yText, xMin, xMax });
    drawRefLines(g, plot, xS, yS);

    const px = model.xs.map((x) => (Number.isFinite(x) ? xS(x) : NaN));
    const dense = xs.length > 24;
    const showMarkers = opts.markers === true || (opts.markers === 'auto' && !dense);
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x0 - 6, plot.y0 - 6, plot.x1 - plot.x0 + 12, plot.y1 - plot.y0 + 12);
    ctx.clip();
    for (const s of vis) drawLineSeries(g, s, px, yS, { baseline: yS(clamp(0, yDomain[0], yDomain[1])), markers: showMarkers, endDot: !showMarkers && vis.length <= 4 });
    ctx.restore();

    const order = px.map((p, i) => i).filter((i) => Number.isFinite(px[i])).sort((a, b) => model.xs[a] - model.xs[b]);
    layout = { plot, px, order, orderPx: order.map((i) => px[i]), yS };
    if (hover >= 0) drawCrosshair(g, vis, hover);
  }

  function drawLineAxes(g, plot, { xS, yS, yTicks, yText, xMin, xMax }) {
    const { ctx, w, theme, dpr } = g;
    const lineAt = (y, color) => {
      const yy = crispLine(y, 1, dpr);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x0, yy);
      ctx.lineTo(plot.x1, yy);
      ctx.stroke();
    };
    setFont(ctx, theme, 11);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = theme.dim;
    const [d0, d1] = yS.domain;
    for (const t of yTicks.ticks) {
      if (t < d0 - EPS || t > d1 + EPS) continue;
      const y = yS(t);
      lineAt(y, t === 0 && d0 < 0 ? theme.axis : theme.grid);
      ctx.fillText(yText(t), plot.x0 - 8, y);
    }
    lineAt(plot.y1, theme.axis);

    const timed = opts.xAxis === 'time';
    const count = clamp(Math.floor((plot.x1 - plot.x0) / 84), 2, 10);
    const xTicks = timed ? timeTicks(xMin, xMax, count) : niceTicks(xMin, xMax, count, { integer: allIntegers([model.xs]) });
    const xText = (v) => (opts.xFormat ? opts.xFormat(v) : timed ? formatTimeTick(v, xTicks.step) : formatTick(v, xTicks.step));
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.dim;
    for (const t of xTicks.ticks) {
      if (t < xMin - EPS || t > xMax + EPS) continue;
      const half = ctx.measureText(xText(t)).width / 2;
      ctx.fillText(xText(t), clamp(xS(t), half + 2, w - half - 2), plot.y1 + 8);
    }
    if (opts.xLabel) {
      ctx.fillStyle = theme.faint;
      ctx.fillText(opts.xLabel, (plot.x0 + plot.x1) / 2, plot.y1 + 26);
    }
    if (opts.yLabel) {
      ctx.textAlign = 'left';
      ctx.fillStyle = theme.dim;
      ctx.fillText(opts.yLabel, 2, 4);
    }
  }

  function drawRefLines(g, plot, xS, yS) {
    const { ctx, theme, dpr } = g;
    for (const ref of opts.refLines || []) {
      if (!Number.isFinite(ref?.value)) continue;
      const vertical = ref.axis === 'x';
      const pos = crispLine(vertical ? xS(ref.value) : yS(ref.value), 1, dpr);
      ctx.strokeStyle = theme.faint;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (vertical) { ctx.moveTo(pos, plot.y0); ctx.lineTo(pos, plot.y1); } else { ctx.moveTo(plot.x0, pos); ctx.lineTo(plot.x1, pos); }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (ref.label) {
        setFont(ctx, theme, 11, 500);
        ctx.fillStyle = theme.dim;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = vertical ? 'left' : 'right';
        const lx = vertical ? pos + 4 : plot.x1;
        const ly = vertical ? plot.y0 + 12 : pos - 3;
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4;
        ctx.strokeStyle = theme.surface;
        ctx.strokeText(ref.label, lx, ly);
        ctx.fillText(ref.label, lx, ly);
      }
    }
  }

  function drawLineSeries(g, s, px, yS, { baseline, markers, endDot }) {
    const { ctx, theme } = g;
    const color = canvasColor(s.ref, theme);
    const py = s.y.map((v) => (Number.isFinite(v) ? yS(v) : NaN));
    const joined = px.map((p, i) => (Number.isFinite(p) ? py[i] : NaN));
    const runs = finiteRuns(joined);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = color;
    if (s.lo && s.hi) {
      const both = s.lo.map((v, i) => (Number.isFinite(v) && Number.isFinite(s.hi[i]) && Number.isFinite(px[i]) ? 1 : NaN));
      for (const [a, b] of finiteRuns(both)) {
        ctx.beginPath();
        for (let i = a; i <= b; i++) ctx.lineTo(px[i], yS(s.hi[i]));
        for (let i = b; i >= a; i--) ctx.lineTo(px[i], yS(s.lo[i]));
        ctx.closePath();
        ctx.fill();
      }
    }
    if (s.area) {
      ctx.globalAlpha = 0.1;
      for (const [a, b] of runs) {
        ctx.beginPath();
        ctx.moveTo(px[a], baseline);
        for (let i = a; i <= b; i++) ctx.lineTo(px[i], joined[i]);
        ctx.lineTo(px[b], baseline);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [a, b] of runs) {
      ctx.beginPath();
      ctx.moveTo(px[a], joined[a]);
      for (let i = a + 1; i <= b; i++) ctx.lineTo(px[i], joined[i]);
      ctx.stroke();
    }
    if (markers) for (const [a, b] of runs) for (let i = a; i <= b; i++) ringDot(ctx, px[i], joined[i], 4, color, theme.surface);
    else if (endDot && runs.length) {
      const last = runs[runs.length - 1][1];
      ringDot(ctx, px[last], joined[last], 4, color, theme.surface);
    }
  }

  function drawCrosshair(g, vis, index) {
    const { ctx, theme, dpr } = g;
    const { plot, px, yS } = layout;
    if (!Number.isFinite(px[index])) return;
    const x = crispLine(px[index], 1, dpr);
    ctx.strokeStyle = theme.faint;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plot.y0);
    ctx.lineTo(x, plot.y1);
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (const s of vis) if (Number.isFinite(s.y[index])) ringDot(ctx, px[index], yS(s.y[index]), 4.5, canvasColor(s.ref, theme), theme.surface);
  }

  function tooltipFor(index) {
    const rows = visible().filter((s) => Number.isFinite(s.y[index])).map((s) => ({
      color: s.ref,
      name: s.name,
      value: yFmt(s.y[index]),
      detail: s.lo && s.hi && Number.isFinite(s.lo[index]) && Number.isFinite(s.hi[index]) ? `${yFmt(s.lo[index])} to ${yFmt(s.hi[index])}` : '',
    }));
    return { title: xFmt(model.xs[index]), rows };
  }

  function setHover(index, announce = false) {
    if (index === hover && !announce) return;
    hover = index;
    announceNext = announce && index >= 0;
    host.invalidate();
  }

  /** Data index under a pointer position, or -1 outside the plot. */
  function indexAt(pt) {
    if (!layout) return -1;
    const { plot, orderPx, order } = layout;
    if (pt.x < plot.x0 - 8 || pt.x > plot.x1 + 8 || pt.y < plot.y0 - 10 || pt.y > plot.y1 + 10) return -1;
    const k = nearestIndex(orderPx, pt.x);
    return k < 0 ? -1 : order[k];
  }

  /**
   * The point at data index `index` to report for a click: the series whose point is vertically closest to `y`,
   * or the first series with a value there when `y` is null (keyboard).
   */
  function pick(index, y) {
    const vis = visible();
    const ys = vis.map((s) => (Number.isFinite(s.y[index]) ? layout.yS(s.y[index]) : NaN));
    const k = y === null ? ys.findIndex(Number.isFinite) : nearestPoint(ys.map((py) => ({ x: 0, y: py })), 0, y);
    if (k < 0) return null;
    return { seriesIndex: vis[k].index, index, x: model.xs[index], y: vis[k].y[index], series: vis[k].name };
  }

  const activate = (index, y) => {
    const hit = layout && index >= 0 ? pick(index, y) : null;
    if (hit && opts.onPointClick) opts.onPointClick(hit);
  };

  const onPointer = (e) => setHover(indexAt(host.local(e)));
  host.listen(host.canvas, 'pointermove', onPointer);
  host.listen(host.canvas, 'pointerdown', onPointer);
  host.listen(host.canvas, 'pointerleave', () => setHover(-1));
  host.listen(host.canvas, 'click', (e) => { const pt = host.local(e); activate(indexAt(pt), pt.y); });
  host.listen(host.canvas, 'blur', () => setHover(-1));
  host.listen(host.canvas, 'focus', () => {
    if (host.canvas.matches(':focus-visible') && layout?.order.length) setHover(layout.order[layout.order.length - 1], true);
  });
  host.listen(host.canvas, 'keydown', (e) => {
    if (!layout) return;
    const { order } = layout;
    keyStep(e, {
      count: order.length,
      current: order.indexOf(hover),
      onMove: (k) => setHover(order[k], true),
      onActivate: () => activate(hover, null),
      onClear: () => setHover(-1),
    });
  });

  function sync() {
    model = lineModel(opts);
    for (const i of [...hidden]) if (i >= model.series.length) hidden.delete(i);
    if (hover >= model.xs.length) hover = -1;
    host.setHeight(opts.height);
    host.setEmpty(model.hasData ? null : opts.empty);
    host.setLabel(`${opts.ariaLabel || 'Line chart'}: ${model.series.map((s) => s.name).join(', ') || 'no data'}`);
    host.el.classList.toggle('chart--clickable', Boolean(opts.onPointClick));
    const show = model.hasData && (opts.legend === true || (opts.legend === 'auto' && model.series.length >= 2));
    const items = show ? model.series : [];
    legendSig = swapLegend(slot, items, JSON.stringify([show, items.map((s) => [s.name, s.ref]), [...hidden]]), legendSig, () => buildLegend(items, {
      toggle: true, hidden, line: true,
      onToggle: (i) => {
        if (hidden.has(i)) hidden.delete(i);
        else if (hidden.size < model.series.length - 1) hidden.add(i);
        sync();
      },
    }));
    host.invalidate();
  }

  const el = h('div', { class: 'chart-block' }, host.el, slot.current);
  sync();
  return {
    el,
    update(patch) { Object.assign(opts, patch); sync(); },
    destroy() { host.destroy(); el.remove(); },
  };
}

// ==================================================================================================
// Bar chart
// ==================================================================================================

const BAR_DEFAULTS = { orientation: 'horizontal', labels: 'auto', legend: 'auto', empty: 'No data yet', better: 'higher', highlight: null };
const BAR_MAX_THICKNESS = 18;
const BAR_ROW_MIN = 34;

/** Normalises bar-chart options; `values` shorter than `categories` are padded with gaps. */
function barModel(opts) {
  const categories = (Array.isArray(opts.categories) ? opts.categories : []).map(String);
  const series = (Array.isArray(opts.series) ? opts.series : []).map((s, index) => ({
    index,
    name: String(s?.name ?? ''),
    ref: colorRef(s?.color, index),
    refs: Array.isArray(s?.colors) ? s.colors.map((c) => (c ? colorRef(c, index) : null)) : [],
    values: column(s?.values, categories.length),
  }));
  const marks = series.map((s) => (opts.highlight ? bestWorst(s.values, opts.better) : { best: [], worst: [] }));
  const want = (kind) => opts.highlight === 'both' || opts.highlight === kind;
  const tags = series.map((s, si) => s.values.map((v, ci) => (want('best') && marks[si].best.includes(ci) ? 'best' : want('worst') && marks[si].worst.includes(ci) ? 'worst' : null)));
  return { categories, series, tags, hasData: categories.length > 0 && series.some((s) => s.values.some(Number.isFinite)) };
}

/**
 * Bar chart, horizontal (default) or vertical, single or grouped series, with value labels, per-bar colours,
 * best / worst highlighting and hover, click and keyboard access.
 *
 * @param {object} options
 * @param {string[]} options.categories one label per bar group
 * @param {Array<{ name?: string, values: Array<number|null>, color?: string, colors?: string[] }>} options.series
 *   `colors` overrides the colour per bar (index = category); grouped bars use one series each
 * @param {'horizontal'|'vertical'} [options.orientation]
 * @param {string} [options.unit] appended to value labels and tooltips   @param {number} [options.digits] decimals for values
 * @param {(v: number) => string} [options.valueFormat] custom label / tooltip formatter (overrides unit and digits)
 * @param {number} [options.min] @param {number} [options.max] fixed value-axis bounds (default 0 and nice ticks)
 * @param {boolean|'auto'} [options.labels] value labels at the bar ends; 'auto' (default) = all but grouped columns. A label that would touch another bar is left out
 * @param {'best'|'worst'|'both'|null} [options.highlight] mark the best / worst bar of each series (green / red plus a text tag)
 * @param {'higher'|'lower'} [options.better] which direction is better (default 'higher')
 * @param {string} [options.valueLabel] title of the value axis (put the unit here for grouped columns)
 * @param {number} [options.height] px (default: fits the rows when horizontal, 220 when vertical)
 * @param {(hit: { categoryIndex: number, seriesIndex: number, category: string, series: string, value: number }) => void} [options.onBarClick]
 * @returns {{ el: HTMLElement, update(patch: object): void, destroy(): void }}
 */
export function createBarChart(options = {}) {
  const opts = { ...BAR_DEFAULTS, ...options };
  let model = barModel(opts);
  let layout = null;
  let hover = null; // { ci, si }
  let announceNext = false;
  let legendSig = null;
  const slot = { current: h('div', { hidden: true }) };
  const host = createHost({ className: 'chart--bar', height: 0, render, label: opts.ariaLabel || 'Bar chart' });
  host.canvas.tabIndex = 0;

  const horizontal = () => opts.orientation !== 'vertical';
  const fmt = (v) => (opts.valueFormat ? opts.valueFormat(v) : formatValue(v, { unit: opts.unit, digits: opts.digits }));
  /** 'auto' labels every bar except grouped columns, where neighbouring labels would collide (the tooltip carries those). */
  const showLabels = () => (opts.labels === 'auto' ? horizontal() || model.series.length === 1 : Boolean(opts.labels));
  const tagText = (ci, si) => model.tags[si]?.[ci] || '';
  const autoHeight = () => (horizontal() ? clamp(model.categories.length * Math.max(BAR_ROW_MIN, model.series.length * 20 + 14) + 30 + (opts.valueLabel ? 16 : 0), 90, 720) : 220);

  /** One frame, then the tooltip for the hovered bar, so it always matches the data and layout just drawn. */
  function render(g) {
    draw(g);
    refreshTip();
  }

  function refreshTip() {
    const bar = hover && layout?.bars.find((b) => b.ci === hover.ci && b.si === hover.si);
    if (!bar) { host.hideTip(); return; }
    host.showTip(tooltipFor(hover), { x: bar.x + (horizontal() ? bar.w : bar.w / 2), y: bar.y }, { announce: announceNext });
    announceNext = false;
  }

  function draw(g) {
    const { w, h: hgt } = g;
    layout = null;
    const ext = seriesExtent(model.series.map((s) => s.values), { includeZero: true });
    if (!ext || model.categories.length === 0) return;
    const ticks = niceTicks(opts.min ?? ext.min, opts.max ?? ext.max, horizontal() ? clamp(Math.floor(w / 64), 3, 6) : clamp(Math.floor(hgt / 44), 3, 6), { integer: allIntegers(model.series.map((s) => s.values)) });
    const domain = [opts.min ?? ticks.min, opts.max ?? ticks.max];
    const tickText = (v) => (opts.valueFormat ? opts.valueFormat(v) : formatTick(v, ticks.step));
    const plot = barPlot(g, ticks, tickText);
    if (!plot) return;
    const vS = linearScale(domain, horizontal() ? [plot.x0, plot.x1] : [plot.y1, plot.y0]);
    const bands = bandScale(model.categories.length, horizontal() ? [plot.y0, plot.y1] : [plot.x0, plot.x1], 0.3);
    const group = groupLayout(bands.bandwidth, model.series.length, { maxThickness: BAR_MAX_THICKNESS });
    layout = { plot, vS, bands, group, bars: [] };
    drawBarAxes(g, plot, vS, ticks, tickText, domain);
    if (hover) drawRowHover(g, plot, bands);
    drawBars(g);
    if (showLabels()) drawBarLabels(g);
    drawBarCategoryLabels(g, plot, bands);
  }

  /** Plot rectangle: margins depend on label widths, which are measured with the real font. */
  function barPlot(g, ticks, tickText) {
    const { ctx, w, h: hgt, theme } = g;
    setFont(ctx, theme, 11);
    const tickW = Math.max(...ticks.ticks.map((t) => ctx.measureText(tickText(t)).width));
    setFont(ctx, theme, 12, 600);
    const labelW = (v, tag) => ctx.measureText(fmt(v)).width + (tag ? 8 + ctx.measureText(tag).width : 0);
    const valueW = showLabels() ? Math.max(0, ...model.series.flatMap((s, si) => s.values.map((v, ci) => (Number.isFinite(v) ? labelW(v, tagText(ci, si)) : 0)))) : 0;
    const tagged = model.tags.some((row) => row.some(Boolean));
    const title = opts.valueLabel ? 16 : 0;
    let plot;
    if (horizontal()) {
      setFont(ctx, theme, 12);
      const catW = Math.min(Math.max(...model.categories.map((c) => ctx.measureText(c).width)), w * 0.4);
      plot = { x0: Math.ceil(catW) + 14, x1: w - Math.max(14, Math.ceil(valueW) + 12), y0: 4, y1: hgt - 22 - title };
    } else {
      plot = { x0: Math.ceil(tickW) + 12, x1: w - 10, y0: (showLabels() ? (tagged ? 36 : 22) : 10) + title, y1: hgt - 26 };
    }
    return plot.x1 - plot.x0 < 40 || plot.y1 - plot.y0 < 30 ? null : plot;
  }

  function drawBarAxes(g, plot, vS, ticks, tickText, domain) {
    const { ctx, theme, dpr } = g;
    setFont(ctx, theme, 11);
    ctx.fillStyle = theme.dim;
    ctx.lineWidth = 1;
    for (const t of ticks.ticks) {
      if (t < domain[0] - EPS || t > domain[1] + EPS) continue;
      const p = crispLine(vS(t), 1, dpr);
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      if (horizontal()) {
        ctx.moveTo(p, plot.y0); ctx.lineTo(p, plot.y1); ctx.stroke();
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(tickText(t), p, plot.y1 + 8);
      } else {
        ctx.moveTo(plot.x0, p); ctx.lineTo(plot.x1, p); ctx.stroke();
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(tickText(t), plot.x0 - 8, p);
      }
    }
    const zero = crispLine(vS(clamp(0, domain[0], domain[1])), 1, dpr);
    ctx.strokeStyle = theme.axis;
    ctx.beginPath();
    if (horizontal()) { ctx.moveTo(zero, plot.y0); ctx.lineTo(zero, plot.y1); } else { ctx.moveTo(plot.x0, zero); ctx.lineTo(plot.x1, zero); }
    ctx.stroke();
    if (opts.valueLabel) {
      ctx.fillStyle = horizontal() ? theme.faint : theme.dim;
      ctx.textBaseline = 'top';
      ctx.textAlign = horizontal() ? 'center' : 'left';
      ctx.fillText(opts.valueLabel, horizontal() ? (plot.x0 + plot.x1) / 2 : 2, horizontal() ? plot.y1 + 26 : 4);
    }
  }

  function drawRowHover(g, plot, bands) {
    const { ctx, w, h: hgt, theme } = g;
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = theme.text;
    if (horizontal()) ctx.fillRect(0, bands.center(hover.ci) - bands.step / 2, w, bands.step);
    else ctx.fillRect(bands.center(hover.ci) - bands.step / 2, 0, bands.step, hgt);
    ctx.globalAlpha = 1;
  }

  function barColor(s, ci, theme) {
    const tag = model.tags[s.index][ci];
    if (tag) return canvasColor(tag === 'best' ? '--good' : '--bad', theme);
    return canvasColor(s.refs[ci] || s.ref, theme);
  }

  function drawBars(g) {
    const { ctx, theme } = g;
    const { vS, bands, group } = layout;
    const lo = Math.min(...vS.domain);
    const hi = Math.max(...vS.domain);
    const zero = vS(clamp(0, lo, hi));
    for (let ci = 0; ci < model.categories.length; ci++) {
      for (const s of model.series) {
        const v = s.values[ci];
        if (!Number.isFinite(v)) continue;
        const tip = vS(clamp(v, lo, hi));
        const len = Math.max(1, Math.abs(tip - zero));
        const along = Math.min(tip, zero);
        const across = bands.start(ci) + group.offset(s.index);
        const rect = horizontal()
          ? { x: along, y: across, w: len, h: group.thickness }
          : { x: across, y: along, w: group.thickness, h: len };
        layout.bars.push({ ci, si: s.index, ...rect });
        const r = Math.min(4, group.thickness / 2, len / 2);
        const positive = v >= 0;
        const radii = horizontal() ? (positive ? [0, r, r, 0] : [r, 0, 0, r]) : (positive ? [r, r, 0, 0] : [0, 0, r, r]);
        roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, radii);
        ctx.fillStyle = barColor(s, ci, theme);
        ctx.fill();
        if (hover && hover.ci === ci && hover.si === s.index) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.fill();
        }
      }
    }
  }

  /**
   * Value labels at the bar ends (and the best / worst tag). A label that would run into another bar is left out:
   * the tooltip carries the value, and nothing is ever clipped or overdrawn.
   */
  function drawBarLabels(g) {
    const { ctx, theme } = g;
    for (const b of layout.bars) {
      const v = model.series[b.si].values[b.ci];
      const text = fmt(v);
      const tag = tagText(b.ci, b.si);
      const positive = v >= 0;
      setFont(ctx, theme, 12, 600);
      const valueW = ctx.measureText(text).width;
      ctx.fillStyle = theme.text;
      if (horizontal()) {
        const x = positive ? b.x + b.w + 6 : b.x - 6;
        ctx.textBaseline = 'middle';
        ctx.textAlign = positive ? 'left' : 'right';
        ctx.fillText(text, x, b.y + b.h / 2);
        if (tag) {
          setFont(ctx, theme, 11, 500);
          ctx.fillStyle = theme.dim;
          ctx.fillText(tag, positive ? x + valueW + 8 : x - valueW - 8, b.y + b.h / 2);
        }
        continue;
      }
      const lines = tag ? 28 : 14;
      const box = { x: b.x + b.w / 2 - valueW / 2, y: positive ? b.y - 5 - lines : b.y + b.h + 5, w: valueW, h: lines };
      if (box.y < 0 || layout.bars.some((o) => o !== b && rectsOverlap(box, o))) continue;
      ctx.textAlign = 'center';
      ctx.textBaseline = positive ? 'bottom' : 'top';
      const y = positive ? b.y - 5 : b.y + b.h + 5;
      ctx.fillText(text, b.x + b.w / 2, y);
      if (tag) {
        setFont(ctx, theme, 10, 500);
        ctx.fillStyle = theme.dim;
        ctx.fillText(tag, b.x + b.w / 2, positive ? y - 15 : y + 15);
      }
    }
  }

  function drawBarCategoryLabels(g, plot, bands) {
    const { ctx, theme } = g;
    setFont(ctx, theme, 12);
    ctx.fillStyle = theme.text;
    const measure = (s) => ctx.measureText(s).width;
    model.categories.forEach((c, ci) => {
      if (horizontal()) {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(truncateText(c, plot.x0 - 10, measure), plot.x0 - 10, bands.center(ci));
      } else {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(truncateText(c, bands.step - 6, measure), bands.center(ci), plot.y1 + 8);
      }
    });
  }

  /** Bar under the pointer: the whole category row / column is the target, the bar nearest across the band wins. */
  function barAt(pt) {
    if (!layout) return null;
    const { plot, bands, group } = layout;
    const along = horizontal() ? pt.y : pt.x;
    const ci = bands.indexAt(along);
    const inside = horizontal() ? pt.y >= plot.y0 && pt.y < plot.y1 : pt.x >= plot.x0 && pt.x < plot.x1;
    if (ci < 0 || !inside) return null;
    const si = group.indexAt(along - bands.start(ci));
    return Number.isFinite(model.series[si]?.values[ci]) ? { ci, si } : null;
  }

  function tooltipFor({ ci, si }) {
    const s = model.series[si];
    const tag = tagText(ci, si);
    return {
      title: model.categories[ci],
      rows: [{ color: tag ? (tag === 'best' ? '--good' : '--bad') : s.refs[ci] || s.ref, name: s.name || 'Value', value: fmt(s.values[ci]), detail: tag ? tag[0].toUpperCase() + tag.slice(1) : '' }],
    };
  }

  function setHover(next, announce = false) {
    if (next?.ci === hover?.ci && next?.si === hover?.si && !announce) return;
    hover = next;
    announceNext = announce && next !== null;
    host.invalidate();
  }

  const flat = () => layout?.bars.map((b) => ({ ci: b.ci, si: b.si })) ?? [];
  const activate = (target) => {
    if (!target || !opts.onBarClick) return;
    const s = model.series[target.si];
    opts.onBarClick({ categoryIndex: target.ci, seriesIndex: target.si, category: model.categories[target.ci], series: s.name, value: s.values[target.ci] });
  };
  const onPointer = (e) => setHover(barAt(host.local(e)));
  host.listen(host.canvas, 'pointermove', onPointer);
  host.listen(host.canvas, 'pointerdown', onPointer);
  host.listen(host.canvas, 'pointerleave', () => setHover(null));
  host.listen(host.canvas, 'click', (e) => activate(barAt(host.local(e))));
  host.listen(host.canvas, 'blur', () => setHover(null));
  host.listen(host.canvas, 'focus', () => {
    if (host.canvas.matches(':focus-visible') && flat().length) setHover(flat()[0], true);
  });
  host.listen(host.canvas, 'keydown', (e) => {
    const bars = flat();
    keyStep(e, {
      count: bars.length,
      current: bars.findIndex((b) => b.ci === hover?.ci && b.si === hover?.si),
      onMove: (k) => setHover(bars[k], true),
      onActivate: (k) => activate(bars[k]),
      onClear: () => setHover(null),
    });
  });

  function sync() {
    model = barModel(opts);
    if (hover && !(hover.ci < model.categories.length && model.series[hover.si])) hover = null;
    host.setHeight(opts.height ?? autoHeight());
    host.setEmpty(model.hasData ? null : opts.empty);
    host.setLabel(`${opts.ariaLabel || 'Bar chart'}: ${model.categories.length} categories`);
    host.el.classList.toggle('chart--clickable', Boolean(opts.onBarClick));
    const named = model.series.filter((s) => s.name);
    const show = model.hasData && (opts.legend === true || (opts.legend === 'auto' && model.series.length >= 2)) && named.length > 0;
    const items = show ? named : [];
    legendSig = swapLegend(slot, items, JSON.stringify([show, items.map((s) => [s.name, s.ref])]), legendSig, () => buildLegend(items));
    host.invalidate();
  }

  const el = h('div', { class: 'chart-block' }, host.el, slot.current);
  sync();
  return {
    el,
    update(patch) { Object.assign(opts, patch); sync(); },
    destroy() { host.destroy(); el.remove(); },
  };
}

// ==================================================================================================
// Stacked bar (100 % stacks)
// ==================================================================================================

const STACK_BAR_HEIGHT = 18;
const STACK_ROW_PITCH = 34;

/** Normalises stacked-bar rows: a colour reference and label per segment, segments laid out as fractions. */
function stackModel(opts) {
  const rows = (Array.isArray(opts.rows) ? opts.rows : []).map((row, ri) => {
    const input = Array.isArray(row?.segments) ? row.segments : [];
    const segments = input.map((seg, si) => {
      const key = String(seg?.key ?? si);
      const ref = seg?.color ? colorRef(seg.color, si) : STATE_KEYS.includes(key) ? `--state-${key}` : colorRef(null, si);
      return { key, ref, label: String(seg?.label ?? STATE_LABELS[key] ?? key), value: num(seg?.value) };
    });
    const total = opts.normalize === false && Number.isFinite(opts.max) ? opts.max : undefined;
    return { index: ri, label: String(row?.label ?? ''), note: row?.note ? String(row.note) : '', segments, stack: stackSegments(segments.map((s) => s.value), { total }) };
  });
  const legend = [];
  for (const row of rows) for (const s of row.segments) if (!legend.some((l) => l.key === s.key)) legend.push({ key: s.key, name: s.label, ref: s.ref, index: legend.length });
  const hasData = rows.some((r) => r.stack.some((s) => s.value > 0));
  return { rows, legend, hasData };
}

/**
 * Horizontal stacked bars, one per row, normalised to 100 % of the row total (or to `max` when `normalize` is false).
 * Used for the shares of vehicle states and station states. Segments are labelled in place when the text fits.
 *
 * @param {object} options
 * @param {Array<{ label: string, note?: string, segments: Array<{ key: string, value: number, label?: string, color?: string }> }>} options.rows
 *   `key` of a known state (STATE_KEYS) picks its state colour and label; `note` is right-aligned text (e.g. "86 % working")
 * @param {boolean} [options.normalize] false: scale to `max` instead of the row sum (e.g. seconds)  @param {number} [options.max]
 * @param {boolean} [options.legend] show the legend (default true)
 * @param {(seg: { value: number, frac: number, label: string }) => string} [options.valueFormat] tooltip value (default: percent)
 * @param {(hit: { rowIndex: number, segmentIndex: number, key: string, row: string, value: number }) => void} [options.onSegmentClick]
 * @returns {{ el: HTMLElement, update(patch: object): void, destroy(): void }}
 */
export function createStackedBar(options = {}) {
  const opts = { legend: true, empty: 'No data yet', ...options };
  let model = stackModel(opts);
  let layout = null;
  let hover = null; // { ri, si }
  let announceNext = false;
  let legendSig = null;
  const slot = { current: h('div', { hidden: true }) };
  const host = createHost({ className: 'chart--stacked', height: 0, render, label: opts.ariaLabel || 'Stacked bar chart' });
  host.canvas.tabIndex = 0;

  const percent = (frac) => formatPercent(frac, frac > 0 && frac < 0.1 ? 1 : 0);

  /** One frame, then the tooltip for the hovered segment, so it always matches the data and layout just drawn. */
  function render(g) {
    draw(g);
    refreshTip();
  }

  function refreshTip() {
    const box = hover && layout?.rows.find((r) => r.ri === hover.ri && r.si === hover.si);
    if (!box) { host.hideTip(); return; }
    host.showTip(tooltipFor(hover), { x: box.x + box.w / 2, y: box.y + box.h }, { announce: announceNext });
    announceNext = false;
  }

  function draw(g) {
    const { ctx, w, theme } = g;
    layout = { rows: [] };
    setFont(ctx, theme, 12);
    const measure = (s) => ctx.measureText(s).width;
    const labelW = Math.min(Math.max(0, ...model.rows.map((r) => measure(r.label))), w * 0.32);
    setFont(ctx, theme, 11);
    const noteW = Math.min(Math.max(0, ...model.rows.map((r) => measure(r.note))), w * 0.3);
    const x0 = model.rows.some((r) => r.label) ? Math.ceil(labelW) + 12 : 0;
    const x1 = w - (noteW ? Math.ceil(noteW) + 12 : 0);
    if (x1 - x0 < 40) return;
    model.rows.forEach((row, ri) => {
      const y = ri * STACK_ROW_PITCH + (STACK_ROW_PITCH - STACK_BAR_HEIGHT) / 2;
      drawStackRow(g, row, { x0, x1, y }, labelW, noteW);
    });
  }

  function drawStackRow(g, row, { x0, x1, y }, labelW, noteW) {
    const { ctx, w, theme } = g;
    const mid = y + STACK_BAR_HEIGHT / 2;
    setFont(ctx, theme, 12);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.text;
    const measure = (s) => ctx.measureText(s).width;
    if (row.label) ctx.fillText(truncateText(row.label, labelW, measure), 0, mid);
    if (row.note) {
      setFont(ctx, theme, 11);
      ctx.textAlign = 'right';
      ctx.fillStyle = theme.dim;
      ctx.fillText(truncateText(row.note, noteW, measure), w, mid);
    }
    const width = x1 - x0;
    ctx.save();
    roundedRect(ctx, x0, y, width, STACK_BAR_HEIGHT, [4, 4, 4, 4]);
    ctx.clip();
    ctx.fillStyle = theme.track;
    ctx.fillRect(x0, y, width, STACK_BAR_HEIGHT);
    const rects = segmentRects(row.stack, width, 2);
    row.segments.forEach((seg, si) => {
      const r = rects[si];
      if (!(r.w > 0)) return;
      const color = canvasColor(seg.ref, theme);
      ctx.fillStyle = color;
      ctx.fillRect(x0 + r.x, y, r.w, STACK_BAR_HEIGHT);
      if (hover && hover.ri === row.index && hover.si === si) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.fillRect(x0 + r.x, y, r.w, STACK_BAR_HEIGHT);
      }
      layout.rows.push({ ri: row.index, si, x: x0 + r.x, y, w: r.w, h: STACK_BAR_HEIGHT });
      drawSegmentLabel(g, percent(row.stack[si].frac), { x: x0 + r.x, y, w: r.w }, color);
    });
    ctx.restore();
  }

  /** Text inside a segment, only when it fits with padding on both sides (never clipped). */
  function drawSegmentLabel(g, text, { x, y, w }, fill) {
    const { ctx, theme } = g;
    setFont(ctx, theme, 11, 600);
    if (ctx.measureText(text).width + 12 > w) return;
    ctx.fillStyle = /^#[0-9a-f]{3,6}$/i.test(fill) ? inkFor(fill) : theme.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + STACK_BAR_HEIGHT / 2 + 0.5);
  }

  function segAt(pt) {
    if (!layout) return null;
    const hit = hitRect(layout.rows, pt.x, pt.y, 2);
    return hit < 0 ? null : { ri: layout.rows[hit].ri, si: layout.rows[hit].si };
  }

  function tooltipFor({ ri, si }) {
    const row = model.rows[ri];
    const seg = row.segments[si];
    const frac = row.stack[si].frac;
    const value = opts.valueFormat ? opts.valueFormat({ value: seg.value, frac, label: seg.label }) : percent(frac);
    return { title: row.label, rows: [{ color: seg.ref, name: seg.label, value }] };
  }

  function setHover(next, announce = false) {
    if (next?.ri === hover?.ri && next?.si === hover?.si && !announce) return;
    hover = next;
    announceNext = announce && next !== null;
    host.invalidate();
  }

  const activate = (t) => {
    if (!t || !opts.onSegmentClick) return;
    const row = model.rows[t.ri];
    opts.onSegmentClick({ rowIndex: t.ri, segmentIndex: t.si, key: row.segments[t.si].key, row: row.label, value: row.segments[t.si].value });
  };
  const flat = () => layout?.rows.map((r) => ({ ri: r.ri, si: r.si })) ?? [];
  host.listen(host.canvas, 'pointermove', (e) => setHover(segAt(host.local(e))));
  host.listen(host.canvas, 'pointerdown', (e) => setHover(segAt(host.local(e))));
  host.listen(host.canvas, 'pointerleave', () => setHover(null));
  host.listen(host.canvas, 'click', (e) => activate(segAt(host.local(e))));
  host.listen(host.canvas, 'blur', () => setHover(null));
  host.listen(host.canvas, 'focus', () => {
    if (host.canvas.matches(':focus-visible') && flat().length) setHover(flat()[0], true);
  });
  host.listen(host.canvas, 'keydown', (e) => {
    const all = flat();
    keyStep(e, {
      count: all.length,
      current: all.findIndex((t) => t.ri === hover?.ri && t.si === hover?.si),
      onMove: (k) => setHover(all[k], true),
      onActivate: (k) => activate(all[k]),
      onClear: () => setHover(null),
    });
  });

  function sync() {
    model = stackModel(opts);
    if (hover && !model.rows[hover.ri]?.segments[hover.si]) hover = null;
    host.setHeight(Math.max(STACK_ROW_PITCH, model.rows.length * STACK_ROW_PITCH));
    host.setEmpty(model.hasData ? null : opts.empty);
    host.setLabel(`${opts.ariaLabel || 'Stacked bar chart'}: ${model.rows.map((r) => r.label).filter(Boolean).join(', ')}`);
    host.el.classList.toggle('chart--clickable', Boolean(opts.onSegmentClick));
    const show = model.hasData && opts.legend !== false;
    const items = show ? model.legend : [];
    legendSig = swapLegend(slot, items, JSON.stringify([show, items.map((l) => [l.name, l.ref])]), legendSig, () => buildLegend(items));
    host.invalidate();
  }

  const el = h('div', { class: 'chart-block' }, host.el, slot.current);
  sync();
  return {
    el,
    update(patch) { Object.assign(opts, patch); sync(); },
    destroy() { host.destroy(); el.remove(); },
  };
}

// ==================================================================================================
// Sparkline
// ==================================================================================================

/**
 * Tiny trend line for KPI tiles: no axes, an end dot on the latest value, an optional soft area. Fills the width of
 * its container unless `width` is given.
 *
 * @param {object} options
 * @param {Array<number|null>} options.values
 * @param {string} [options.color] token / CSS colour (default: the first series colour)
 * @param {number} [options.width] px (default: 100 % of the container)   @param {number} [options.height] px (default 28)
 * @param {boolean} [options.area] soft fill under the line (default true)
 * @param {number} [options.min] @param {number} [options.max] fixed value range (default: the data, padded)
 * @param {string} [options.unit] used in the accessible description
 * @returns {{ el: HTMLElement, update(patch: object): void, destroy(): void }}
 */
export function createSparkline(options = {}) {
  const opts = { height: 28, area: true, ...options };
  let values = [];
  const host = createHost({ className: 'sparkline', height: opts.height, render, label: 'Trend' });

  function render(g) {
    const { ctx, w, h: hgt, theme } = g;
    const runs = finiteRuns(values);
    if (!runs.length) return;
    const ext = seriesExtent([values]);
    const lo = opts.min ?? ext.min;
    const hi = opts.max ?? ext.max;
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    const yS = linearScale([lo - pad, hi + pad], [hgt - 6, 6]);
    const xS = linearScale([0, Math.max(1, values.length - 1)], [6, w - 7]);
    const color = canvasColor(colorRef(opts.color, 0), theme);
    const last = runs[runs.length - 1][1];
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [a, b] of runs) {
      if (opts.area && b > a) {
        ctx.beginPath();
        ctx.moveTo(xS(a), hgt);
        for (let i = a; i <= b; i++) ctx.lineTo(xS(i), yS(values[i]));
        ctx.lineTo(xS(b), hgt);
        ctx.closePath();
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.moveTo(xS(a), yS(values[a]));
      for (let i = a + 1; i <= b; i++) ctx.lineTo(xS(i), yS(values[i]));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ringDot(ctx, xS(last), yS(values[last]), 3.5, color, theme.surface);
  }

  function sync() {
    values = Array.isArray(opts.values) ? opts.values.map(num) : [];
    if (opts.width) host.el.style.width = `${opts.width}px`;
    host.setHeight(opts.height);
    const ext = seriesExtent([values]);
    const unit = opts.unit ? ` ${opts.unit}` : '';
    host.setLabel(ext
      ? `Trend over ${values.length} samples: latest ${formatValue(values[finiteRuns(values).at(-1)[1]])}${unit}, lowest ${formatValue(ext.min)}${unit}, highest ${formatValue(ext.max)}${unit}`
      : 'Trend: no data');
    host.invalidate();
  }

  sync();
  return {
    el: host.el,
    update(patch) { Object.assign(opts, patch); sync(); },
    destroy() { host.destroy(); },
  };
}

// ==================================================================================================
// Gauge
// ==================================================================================================

const GAUGE_START = Math.PI; // 9 o'clock
const GAUGE_SWEEP = Math.PI; // over the top to 3 o'clock

/**
 * Semi-circle gauge with coloured threshold bands, a progress arc in the colour of the band the value is in, the
 * value as large text, an optional caption and, when the band has a `label`, a status line (dot + text, so the
 * state is never only a colour).
 *
 * @param {object} options
 * @param {number} options.value
 * @param {number} [options.min] (default 0)   @param {number} [options.max] (default 1)
 * @param {Array<{ to: number, color: string, label?: string }>} [options.thresholds] ascending `to` in value units; color = token ('--good'), 'good'|'warn'|'bad'|... or CSS colour
 * @param {string} [options.label] caption under the dial   @param {(v: number) => string} [options.format] value text (default: percent when max <= 1)
 * @param {string} [options.unit] unit for the default format when max > 1
 * @param {number} [options.size] width in px (default 160)
 * @returns {{ el: HTMLElement, update(patch: object): void, destroy(): void }}
 */
export function createGauge(options = {}) {
  const opts = { min: 0, max: 1, size: 160, ...options };
  let bands = gaugeBands(opts.min, opts.max, opts.thresholds);
  const valueEl = h('div', { class: 'gauge__value tnum' });
  const captionEl = h('div', { class: 'gauge__caption' });
  const statusEl = h('div', { class: 'gauge__status' });
  const host = createHost({ className: 'chart--gauge', height: 0, render, label: 'Gauge' });
  host.el.append(h('div', { class: 'gauge__readout' }, valueEl));
  host.el.setAttribute('role', 'meter');
  host.canvas.setAttribute('aria-hidden', 'true');
  host.canvas.removeAttribute('role');
  const el = h('div', { class: 'gauge' }, host.el, captionEl, statusEl);

  const defaultFormat = (v) => (opts.max <= 1 ? formatPercent(v, 0) : formatValue(v, { unit: opts.unit }));
  const format = (v) => (opts.format || defaultFormat)(v);

  const geometry = (w) => {
    const pad = 8;
    const thickness = Math.max(8, Math.round(w * 0.07));
    return { thickness, radius: (w - 2 * pad) / 2, cx: w / 2, cy: pad + (w - 2 * pad) / 2 };
  };

  /** One arc of the dial between two fractions of the sweep. */
  function arc(ctx, g, f0, f1, color, { alpha = 1, cap = 'butt' } = {}) {
    if (!(f1 > f0)) return;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.radius - g.thickness / 2, GAUGE_START + f0 * GAUGE_SWEEP, GAUGE_START + f1 * GAUGE_SWEEP);
    ctx.lineWidth = g.thickness;
    ctx.lineCap = cap;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const bandColor = (band, theme, fallback) => (band.color ? canvasColor(colorRef(band.color, 0), theme) : fallback);

  function render({ ctx, w, theme }) {
    const g = geometry(w);
    const gapFrac = 0.012;
    for (const b of bands) arc(ctx, g, b.frac0 + (b.frac0 > 0 ? gapFrac : 0), b.frac1, bandColor(b, theme, theme.track), { alpha: b.color ? 0.28 : 1 });
    const frac = gaugeFraction(opts.value, opts.min, opts.max);
    arc(ctx, g, 0, frac, bandColor(gaugeBandAt(opts.value, bands), theme, theme.accent), { cap: 'round' });
    setFont(ctx, theme, 11);
    ctx.fillStyle = theme.faint;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText(format(opts.min), g.cx - g.radius + g.thickness / 2, g.cy + 8);
    ctx.fillText(format(opts.max), g.cx + g.radius - g.thickness / 2, g.cy + 8);
  }

  function sync() {
    bands = gaugeBands(opts.min, opts.max, opts.thresholds);
    const g = geometry(opts.size);
    const band = gaugeBandAt(opts.value, bands);
    const known = Number.isFinite(opts.value);
    el.style.width = `${opts.size}px`;
    host.el.style.width = `${opts.size}px`;
    host.setHeight(Math.round(g.cy + 24));
    valueEl.textContent = known ? format(opts.value) : '–';
    captionEl.textContent = opts.label ?? '';
    captionEl.hidden = !opts.label;
    statusEl.textContent = '';
    statusEl.hidden = !(known && band.label);
    if (!statusEl.hidden) {
      statusEl.append(h('span', { class: 'dot', style: { '--c': cssColor(band.color ? colorRef(band.color, 0) : '--accent') } }), band.label);
    }
    host.el.setAttribute('aria-label', opts.label || 'Gauge');
    host.el.setAttribute('aria-valuemin', String(opts.min));
    host.el.setAttribute('aria-valuemax', String(opts.max));
    host.el.setAttribute('aria-valuenow', String(known ? opts.value : opts.min));
    host.el.setAttribute('aria-valuetext', [known ? format(opts.value) : 'no value', known ? band.label : null].filter(Boolean).join(', '));
    host.invalidate();
  }

  sync();
  return {
    el,
    update(patch) { Object.assign(opts, patch); sync(); },
    destroy() { host.destroy(); el.remove(); },
  };
}
