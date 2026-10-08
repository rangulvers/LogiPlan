// Pure-math tests for js/ui/charts.js (scales, nice ticks, formatting, stacking, hit testing) and the icon registry
// of js/ui/icons.js. Canvas drawing and DOM behaviour are covered by tests/e2e/uikit-visual.mjs (Playwright).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  niceTicks, timeTicks, stepDecimals, formatTick, formatTimeTick, formatValue, autoDigits, linearScale, bandScale, groupLayout,
  stackSegments, segmentRects, nearestIndex, nearestPoint, hitRect, clampTooltip, truncateText, crispLine, seriesExtent, allIntegers,
  finiteRuns, bestWorst, gaugeFraction, gaugeBands, gaugeBandAt, segmentsFromShares, STATE_KEYS, STATE_LABELS,
} from '../js/ui/charts.js';
import { ICON_NAMES, iconSvg } from '../js/ui/icons.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

// ---------------------------------------------------------------------------------------------- ticks

test('niceTicks: round steps that cover the data and respect the tick budget', () => {
  assert.deepEqual(niceTicks(0, 100, 5).ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(0, 1, 5).ticks, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(niceTicks(0, 118, 6).ticks, [0, 25, 50, 75, 100, 125]);
  assert.deepEqual(niceTicks(-3, 7, 6).ticks, [-5, -2.5, 0, 2.5, 5, 7.5]);
  const ranges = [[0, 1], [0, 9.7], [3, 4.2], [-17, 230], [0.001, 0.0042], [12345, 98765], [0, 28800], [-1, 1], [99, 101]];
  for (const [min, max] of ranges) {
    for (const budget of [2, 3, 5, 8]) {
      const t = niceTicks(min, max, budget);
      const needed = min < 0 && max > 0 ? 3 : 2; // a range around zero cannot be covered by fewer than three multiples
      assert.ok(t.ticks.length <= Math.max(needed, budget), `${min}..${max} budget ${budget}: ${t.ticks.length} ticks`);
      assert.ok(t.min <= min + 1e-12 && t.max >= max - 1e-12, `${min}..${max} not covered by ${t.min}..${t.max}`);
      t.ticks.slice(1).forEach((v, i) => near(v - t.ticks[i], t.step, t.step * 1e-6));
      const mantissa = t.step / 10 ** Math.floor(Math.log10(t.step) + 1e-9);
      assert.ok([1, 2, 2.5, 5, 10].some((m) => Math.abs(mantissa - m) < 1e-6), `step ${t.step} is not 1, 2, 2.5 or 5 times a power of ten`);
    }
  }
});

test('niceTicks: integer data never gets fractional steps', () => {
  assert.deepEqual(niceTicks(0, 10, 5, { integer: true }).ticks, [0, 5, 10]);
  assert.deepEqual(niceTicks(0, 3, 6, { integer: true }).ticks, [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(0, 118, 6, { integer: true }).ticks, [0, 25, 50, 75, 100, 125]);
  assert.ok(Number.isInteger(niceTicks(0.4, 2.1, 9, { integer: true }).step));
});

test('niceTicks: degenerate and invalid ranges are repaired, never throw, never print -0', () => {
  assert.deepEqual(niceTicks(0, 0).ticks, [0, 0.25, 0.5, 0.75, 1]);
  const flat = niceTicks(5, 5);
  assert.ok(flat.min < 5 && flat.max > 5 && flat.ticks.includes(5));
  assert.deepEqual(niceTicks(10, 0, 5), niceTicks(0, 10, 5));
  for (const bad of [[NaN, 3], [Infinity, -Infinity], [undefined, undefined], ['a', 'b']]) {
    const t = niceTicks(...bad);
    assert.ok(t.ticks.length >= 2 && t.ticks.every(Number.isFinite), `bad input ${bad}`);
  }
  const huge = niceTicks(-1e308, 1e308, 5);
  assert.ok(huge.ticks.length <= 5 && huge.ticks.every(Number.isFinite));
  assert.ok(niceTicks(-2, 2, 5).ticks.every((t) => !Object.is(t, -0)));
  const tiny = niceTicks(0, 1e-9, 4).ticks;
  assert.ok(tiny.length >= 2 && tiny.length <= 4 && new Set(tiny).size === tiny.length, `tiny range: ${tiny}`);
});

test('timeTicks: clock-friendly steps; falls back to plain ticks for empty ranges', () => {
  assert.deepEqual(timeTicks(0, 28800, 6).ticks, [0, 7200, 14400, 21600, 28800]);
  assert.deepEqual(timeTicks(0, 90, 6).ticks, [0, 30, 60, 90]);
  assert.deepEqual(timeTicks(0, 3600, 6).ticks, [0, 900, 1800, 2700, 3600]);
  assert.ok(timeTicks(5, 5).ticks.length >= 2);
  assert.ok(timeTicks(0, 86400 * 400, 6).ticks.length <= 6);
});

test('stepDecimals: decimals needed to print a step exactly', () => {
  assert.equal(stepDecimals(5), 0);
  assert.equal(stepDecimals(0.5), 1);
  assert.equal(stepDecimals(0.25), 2);
  assert.equal(stepDecimals(0.001), 3);
  assert.equal(stepDecimals(0), 0);
  assert.equal(stepDecimals(NaN), 0);
});

// ---------------------------------------------------------------------------------------------- formatting

test('formatTick / formatTimeTick: compact, separator-aware labels', () => {
  assert.equal(formatTick(1500, 500), '1,500');
  assert.equal(formatTick(12000, 2000), '12k');
  assert.equal(formatTick(12500, 2500), '12.5k');
  assert.equal(formatTick(2500000, 500000), '2.5M');
  assert.equal(formatTick(0.25, 0.25), '0.25');
  assert.equal(formatTick(-0, 1), '0');
  assert.equal(formatTick(NaN, 1), '–');
  assert.equal(formatTimeTick(0, 3600), '0');
  assert.equal(formatTimeTick(7200, 3600), '2 h');
  assert.equal(formatTimeTick(5400, 1800), '90 min');
  assert.equal(formatTimeTick(45, 15), '45 s');
  assert.equal(formatTimeTick(Infinity, 15), '–');
});

test('formatValue / autoDigits: precision follows magnitude, units are optional, junk prints as a dash', () => {
  assert.equal(formatValue(42.5, { unit: '/h' }), '42.5 /h');
  assert.equal(formatValue(1234.5), '1,235');
  assert.equal(formatValue(0.1234), '0.123');
  assert.equal(formatValue(12.34), '12.3');
  assert.equal(formatValue(3, { unit: '' }), '3');
  assert.equal(formatValue(2.5, { digits: 0 }), '3');
  assert.equal(formatValue(NaN), '–');
  assert.equal(formatValue(Infinity, { unit: 'm' }), '–');
  assert.deepEqual([0, 0.5, 5, 50, 500].map(autoDigits), [0, 3, 2, 1, 0]);
});

// ---------------------------------------------------------------------------------------------- scales

test('linearScale: maps, inverts, clamps and survives a flat domain', () => {
  const s = linearScale([0, 10], [100, 0]);
  assert.equal(s(0), 100);
  assert.equal(s(10), 0);
  assert.equal(s(2.5), 75);
  near(s.invert(s(7.3)), 7.3);
  assert.equal(s(20), -100);
  assert.equal(linearScale([0, 10], [100, 0], { clamp: true })(20), 0);
  const flat = linearScale([3, 3], [0, 100]);
  assert.equal(flat(3), 50);
  assert.equal(flat.invert(70), 3);
  assert.ok(Number.isNaN(s(NaN)));
});

test('bandScale: equal bands, padding, hit lookup', () => {
  const b = bandScale(4, [0, 200], 0.2);
  assert.equal(b.step, 50);
  assert.equal(b.bandwidth, 40);
  assert.equal(b.start(0), 5);
  assert.equal(b.center(1), 75);
  assert.deepEqual([-1, 0, 49.9, 50, 199.9, 200, 500].map(b.indexAt), [-1, 0, 0, 1, 3, -1, -1]);
  const empty = bandScale(0, [0, 100]);
  assert.equal(empty.indexAt(10), -1);
  assert.equal(empty.step, 0);
  near(bandScale(3, [0, 90], 5).bandwidth, 3, 1e-9);
});

test('groupLayout: bars are capped at 24 px, centred, never overlap, never collapse', () => {
  const one = groupLayout(100, 1);
  assert.equal(one.thickness, 24);
  near(one.offset(0), 38);
  const three = groupLayout(100, 3, { gap: 2 });
  assert.equal(three.thickness, 24);
  near(three.total, 76);
  const tight = groupLayout(30, 3, { gap: 2 });
  assert.ok(tight.thickness <= (30 - 4) / 3 + 1e-9);
  for (let i = 1; i < 3; i++) near(tight.offset(i) - tight.offset(i - 1), tight.thickness + 2);
  assert.ok(tight.offset(0) >= 0 && tight.offset(2) + tight.thickness <= 30 + 1e-9);
  assert.equal(groupLayout(2, 5).thickness, 1);
  assert.deepEqual([0, 20, 40, 100].map((p) => groupLayout(60, 2).indexAt(p)), [0, 0, 1, 1]);
});

// ---------------------------------------------------------------------------------------------- stacking

test('stackSegments: fractions of the total, ignoring non-positive and non-finite values', () => {
  const segs = stackSegments([2, 1, 1]);
  assert.deepEqual(segs.map((s) => s.frac), [0.5, 0.25, 0.25]);
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 0.5], [0.5, 0.75], [0.75, 1]]);
  const messy = stackSegments([3, -1, NaN, 1, Infinity]);
  assert.deepEqual(messy.map((s) => s.value), [3, 0, 0, 1, 0]);
  near(messy.at(-1).end, 1);
  assert.deepEqual(stackSegments([0, 0]).map((s) => s.frac), [0, 0]);
  assert.deepEqual(stackSegments([]), []);
  const partial = stackSegments([2, 2], { total: 8 });
  assert.deepEqual(partial.map((s) => s.frac), [0.25, 0.25]);
  assert.equal(partial.at(-1).end, 0.5);
  assert.equal(stackSegments([1, 1], { total: 0 }).at(-1).end, 1, 'a non-positive total falls back to the sum');
});

test('segmentRects: a 2 px gap between neighbours, flush ends, empty segments take no space', () => {
  const rects = segmentRects(stackSegments([50, 0, 30, 20]), 200, 2);
  assert.equal(rects[1].w, 0);
  const live = [rects[0], rects[2], rects[3]];
  near(live[0].x, 0);
  near(live[0].x + live[0].w + 2, live[1].x);
  near(live[1].x + live[1].w + 2, live[2].x);
  near(live[2].x + live[2].w, 200);
  const tiny = segmentRects(stackSegments([1000, 1]), 100, 2);
  assert.ok(tiny[1].w >= 1, 'a non-empty segment stays visible');
  assert.deepEqual(segmentRects([], 100), []);
});

// ---------------------------------------------------------------------------------------------- hit testing

test('nearestIndex: closest value, lower index on ties, -1 for nothing', () => {
  const xs = [0, 10, 20, 40];
  assert.deepEqual([-5, 0, 4, 5, 6, 14.9, 30, 31, 100].map((x) => nearestIndex(xs, x)), [0, 0, 0, 0, 1, 1, 2, 3, 3]);
  assert.equal(nearestIndex([], 3), -1);
  assert.equal(nearestIndex(xs, NaN), -1);
  assert.equal(nearestIndex([7], 1000), 0);
});

test('nearestPoint: Euclidean nearest within a radius, skipping broken points', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: NaN, y: 1 }, null, { x: 4, y: 3 }];
  assert.equal(nearestPoint(pts, 9, 1), 1);
  assert.equal(nearestPoint(pts, 4, 4), 4);
  assert.equal(nearestPoint(pts, 50, 50, 10), -1);
  assert.equal(nearestPoint(pts, 0, 0, 0), 0);
  assert.equal(nearestPoint([], 0, 0), -1);
});

test('hitRect: containment with slop, closest centre wins among overlaps', () => {
  const rects = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 10, h: 10 }];
  assert.equal(hitRect(rects, 5, 5), 0);
  assert.equal(hitRect(rects, 11, 5), -1);
  assert.equal(hitRect(rects, 11, 5, 2), 0, 'inside both slop zones, equally far from both centres: the first wins');
  assert.equal(hitRect(rects, 11.5, 5, 2), 1, 'inside both slop zones: the closer centre wins');
  assert.equal(hitRect(rects, 25, 5), -1);
  assert.equal(hitRect([], 0, 0), -1);
});

test('clampTooltip: prefers right/below the anchor, flips and clamps inside the container', () => {
  const box = { w: 400, h: 200 };
  const tip = { w: 120, h: 60 };
  assert.deepEqual(clampTooltip({ x: 100, y: 50 }, box, tip), { left: 112, top: 62 });
  assert.equal(clampTooltip({ x: 380, y: 50 }, box, tip).left, 380 - 12 - 120, 'flips to the left of the anchor');
  assert.equal(clampTooltip({ x: 100, y: 190 }, box, tip).top, 190 - 12 - 60, 'flips above the anchor');
  const corner = clampTooltip({ x: 2, y: 2 }, { w: 100, h: 50 }, { w: 300, h: 200 });
  assert.deepEqual(corner, { left: 4, top: 4 }, 'a tooltip larger than the container sticks to the margin');
  for (const x of [0, 50, 200, 399]) for (const y of [0, 100, 199]) {
    const p = clampTooltip({ x, y }, box, tip);
    assert.ok(p.left >= 4 && p.left + tip.w <= box.w - 4 && p.top >= 4 && p.top + tip.h <= box.h - 4, `(${x},${y}) -> ${JSON.stringify(p)}`);
  }
});

// ---------------------------------------------------------------------------------------------- text, pixels

test('truncateText: keeps what fits, ends in an ellipsis, never exceeds the width', () => {
  const measure = (s) => s.length * 7;
  assert.equal(truncateText('Assembly', 100, measure), 'Assembly');
  const cut = truncateText('Assembly line with a long name', 70, measure);
  assert.ok(cut.endsWith('…') && measure(cut) <= 70, cut);
  assert.equal(cut, 'Assembly…');
  assert.equal(truncateText('abc', 5, measure), '', 'not even the ellipsis fits');
  assert.equal(truncateText('abcdef', 7, measure), '…');
  assert.equal(truncateText('abc def', 35, measure), 'abc…', 'no dangling space before the ellipsis');
  assert.equal(truncateText('', 10, measure), '');
});

test('crispLine: puts hairlines on device pixels at any pixel ratio', () => {
  assert.equal(crispLine(10.3, 1, 1), 10.5);
  assert.equal(crispLine(10.8, 1, 1), 10.5);
  assert.equal(crispLine(10.3, 1, 2), 10.5, 'two device pixels: centre on a device boundary');
  near(crispLine(10.2, 1, 3), 30.5 / 3);
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const dw = Math.max(1, Math.round(dpr));
    const edge = (crispLine(7.37, 1, dpr) * dpr) - dw / 2;
    near(edge, Math.round(edge), 1e-9);
  }
});

// ---------------------------------------------------------------------------------------------- data helpers

test('seriesExtent / allIntegers / finiteRuns: tolerate gaps and junk', () => {
  assert.deepEqual(seriesExtent([[3, null, 7], [NaN, -2, '5']]), { min: -2, max: 7 });
  assert.deepEqual(seriesExtent([[3, 7]], { includeZero: true }), { min: 0, max: 7 });
  assert.deepEqual(seriesExtent([[-3, -1]], { includeZero: true }), { min: -3, max: 0 });
  assert.equal(seriesExtent([[], [null, NaN], undefined]), null);
  assert.equal(allIntegers([[1, 2, null], [NaN, 4]]), true);
  assert.equal(allIntegers([[1, 2.5]]), false);
  assert.deepEqual(finiteRuns([1, 2, null, NaN, 5, undefined, 7, 8]), [[0, 1], [4, 4], [6, 7]]);
  assert.deepEqual(finiteRuns([]), []);
  assert.deepEqual(finiteRuns([null, NaN]), []);
});

test('bestWorst: extremes by direction, ties kept, flat or tiny data highlights nothing', () => {
  assert.deepEqual(bestWorst([92, 104, 118, 111]), { best: [2], worst: [0] });
  assert.deepEqual(bestWorst([92, 104, 118, 111], 'lower'), { best: [0], worst: [2] });
  assert.deepEqual(bestWorst([5, 9, 9, 1]), { best: [1, 2], worst: [3] });
  assert.deepEqual(bestWorst([4, 4, 4]), { best: [], worst: [] });
  assert.deepEqual(bestWorst([4]), { best: [], worst: [] });
  assert.deepEqual(bestWorst([NaN, 3, null, 8]), { best: [3], worst: [1] });
  assert.deepEqual(bestWorst([]), { best: [], worst: [] });
});

test('segmentsFromShares: ordered segments with labels, missing keys count as zero', () => {
  const segs = segmentsFromShares({ idle: 0.2, driving: 0.8, custom: 'x' }, ['driving', 'idle', 'custom', 'parked']);
  assert.deepEqual(segs.map((s) => [s.key, s.label, s.value]), [['driving', 'Driving', 0.8], ['idle', 'Idle', 0.2], ['custom', 'custom', 0], ['parked', 'Parked', 0]]);
  assert.deepEqual(segmentsFromShares({ busy: 1 }).map((s) => s.key), ['busy']);
  assert.deepEqual(segmentsFromShares(null), []);
  assert.deepEqual(Object.keys(STATE_LABELS).sort(), [...STATE_KEYS].sort());
});

// ---------------------------------------------------------------------------------------------- gauge

test('gaugeFraction / gaugeBands / gaugeBandAt: threshold bands tile the dial', () => {
  assert.equal(gaugeFraction(0.5, 0, 1), 0.5);
  assert.equal(gaugeFraction(7, 0, 1), 1);
  assert.equal(gaugeFraction(-3, 0, 1), 0);
  assert.equal(gaugeFraction(NaN, 0, 1), 0);
  assert.equal(gaugeFraction(5, 3, 3), 0);
  const bands = gaugeBands(0, 1, [{ to: 0.85, color: 'warn' }, { to: 0.35, color: 'info' }, { to: 0.95, color: 'bad' }]);
  assert.deepEqual(bands.map((b) => [b.from, b.to, b.color]), [[0, 0.35, 'info'], [0.35, 0.85, 'warn'], [0.85, 1, 'bad']], 'sorted; last band reaches max');
  near(bands.at(-1).frac1, 1);
  for (let i = 1; i < bands.length; i++) assert.equal(bands[i].frac0, bands[i - 1].frac1);
  assert.deepEqual(gaugeBands(0, 10).map((b) => [b.from, b.to, b.color]), [[0, 10, null]]);
  assert.deepEqual(gaugeBands(0, 10, [{ to: NaN }, null]).length, 1);
  assert.equal(gaugeBandAt(0.5, bands).color, 'warn');
  assert.equal(gaugeBandAt(0.35, bands).color, 'warn');
  assert.equal(gaugeBandAt(2, bands).color, 'bad');
  assert.equal(gaugeBandAt(-1, bands).color, 'info');
});

// ---------------------------------------------------------------------------------------------- contracts with tokens.css and icons.js

test('charts only read CSS tokens that css/tokens.css defines (in every theme block)', () => {
  const css = readFileSync(new URL('../css/tokens.css', import.meta.url), 'utf8');
  const blocks = css.split(/\n(?=@media|:root)/).filter((b) => /--bg:/.test(b));
  assert.equal(blocks.length, 4, 'light, dark (media), dark (attribute), print');
  const themed = ['--text', '--text-dim', '--text-faint', '--surface', '--surface-3', '--border', '--chart-grid', '--chart-axis', '--accent', '--good', '--warn', '--bad', '--info',
    ...Array.from({ length: 8 }, (_, i) => `--series-${i + 1}`), '--series-other'];
  for (const block of blocks) for (const name of themed) assert.ok(new RegExp(`${name}:`).test(block), `${name} missing in a theme block`);
  const fixed = ['--font-sans', ...STATE_KEYS.map((k) => `--state-${k}`)];
  for (const name of fixed) assert.ok(new RegExp(`${name}:`).test(css), `${name} is not defined`);
});

test('icons: every required name exists once, markup is well-formed and sized', () => {
  const required = ['select', 'pan', 'road', 'oneway', 'speedzone', 'erase', 'source', 'process', 'storage', 'sink', 'depot', 'obstacle', 'label', 'flow', 'undo', 'redo',
    'play', 'pause', 'step', 'reset', 'fit', 'zoomin', 'zoomout', 'grid', 'heat', 'flows', 'share', 'export', 'import', 'help', 'settings', 'warning', 'error', 'info', 'check',
    'plus', 'minus', 'trash', 'copy', 'chevron-down', 'chevron-right', 'chevron-left', 'chevron-up', 'close', 'menu', 'sun', 'moon', 'layers', 'truck', 'bolt', 'clock', 'chart',
    'compare', 'flask', 'link', 'download', 'upload', 'folder', 'save', 'sliders', 'target', 'route', 'forklift'];
  for (const name of required) assert.ok(ICON_NAMES.includes(name), `missing icon ${name}`);
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
  assert.ok(Object.isFrozen(ICON_NAMES));
  for (const name of ICON_NAMES) {
    const svg = iconSvg(name);
    assert.match(svg, /^<svg [^>]*viewBox="0 0 24 24"[^>]*stroke="currentColor"[^>]*stroke-width="1.75"[^>]*aria-hidden="true"[^>]*>/, name);
    assert.match(svg, new RegExp(`class="icon icon--${name}"`));
    // tags balance: every opening tag is self-closed or closed
    const stack = [];
    for (const [, close, tag, selfClose] of svg.matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/g)) {
      if (selfClose) continue;
      if (close) assert.equal(stack.pop(), tag, `${name}: unbalanced </${tag}>`); else stack.push(tag);
    }
    assert.deepEqual(stack, [], `${name}: unclosed tags`);
    for (const [, d] of svg.matchAll(/ d="([^"]*)"/g)) assert.match(d, /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-., ]+$/, `${name}: unexpected characters in a path`);
  }
});

test('iconSvg: size, class, unknown names and hostile input', () => {
  assert.match(iconSvg('play', { size: 32 }), /width="32" height="32"/);
  assert.match(iconSvg('play'), /width="18" height="18"/);
  for (const size of [0, -4, NaN, Infinity, undefined, 'x']) assert.match(iconSvg('play', { size }), /width="18"/, `size ${size}`);
  assert.match(iconSvg('play', { class: 'btn__icon' }), /class="icon icon--play btn__icon"/);
  assert.match(iconSvg('play', { class: '"><script>' }), /class="icon icon--play &quot;&gt;&lt;script&gt;"/);
  const missing = iconSvg('does-not-exist');
  assert.match(missing, /icon--missing/);
  assert.match(missing, /<rect/);
  assert.doesNotMatch(iconSvg('__proto__'), /undefined|\[object/);
});
