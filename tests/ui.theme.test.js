import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTheme, resolveThemeMode, STATUS_COLORS, STATUS_INK, statusColor, mix, shade, rgba, parseHex, luminance, contrast, inkFor,
  heatColor, HEAT_LEVELS, MIN_INK_CONTRAST,
} from '../js/ui/theme.js';
import { STATION_TYPES, STATION_TYPE_ORDER } from '../js/model/defaults.js';

test('theme: getTheme returns a cached frozen palette per mode and falls back to light', () => {
  assert.equal(getTheme('light'), getTheme('light'));
  assert.equal(getTheme('dark'), getTheme('dark'));
  assert.notEqual(getTheme('light'), getTheme('dark'));
  assert.equal(getTheme('nonsense'), getTheme('light'));
  assert.ok(Object.isFrozen(getTheme('dark')));
  assert.equal(getTheme('light').mode, 'light');
  assert.equal(getTheme('dark').mode, 'dark');
});

test('theme: both palettes define every colour the renderer reads', () => {
  const required = [
    'bg', 'baseplate', 'stud', 'gridLine', 'gridMajor', 'road', 'roadMark', 'roadChevron', 'zoneHatch', 'label', 'labelHalo',
    'flow', 'selection', 'hover', 'ghostValid', 'ghostInvalid', 'deadlock', 'font', 'accent', 'dotRim', 'dotRing', 'flowChip', 'flowHalo',
  ];
  for (const mode of ['light', 'dark']) {
    const t = getTheme(mode);
    for (const key of required) assert.equal(typeof t[key], 'string', `${mode}.${key}`);
    for (const kind of ['wall', 'rack', 'column']) assert.ok(t.obstacle[kind].fill, `${mode}.obstacle.${kind}`);
    assert.equal(typeof t.heat, 'function');
    assert.equal(t.status, STATUS_COLORS);
  }
  assert.notEqual(getTheme('light').baseplate, getTheme('dark').baseplate);
  assert.ok(luminance(getTheme('dark').baseplate) < luminance(getTheme('light').baseplate));
});

test('theme: station colours follow the model, have a darker edge and readable ink', () => {
  for (const mode of ['light', 'dark']) {
    const t = getTheme(mode);
    for (const type of STATION_TYPE_ORDER) {
      const c = t.station[type];
      assert.ok(luminance(c.edge) < luminance(c.top), `${mode} ${type}: front edge is darker than the top face`);
      assert.ok(luminance(c.hi) > luminance(c.top), `${mode} ${type}: highlight is lighter than the top face`);
      assert.ok(contrast(c.top, c.ink) >= MIN_INK_CONTRAST, `${mode} ${type}: ink contrast ${contrast(c.top, c.ink).toFixed(2)} (fill labels and counts are small bold text)`);
    }
  }
  // light mode uses the documented base colours unchanged
  for (const type of STATION_TYPE_ORDER) assert.equal(getTheme('light').station[type].top, STATION_TYPES[type].color);
  assert.equal(STATION_TYPES.source.color, '#2f7df6');
});

test('theme: STATUS_COLORS carry the shared semantics and statusColor maps state names', () => {
  assert.equal(STATUS_COLORS.busy, STATUS_COLORS.ok);
  assert.equal(STATUS_COLORS.blocked, STATUS_COLORS.waiting);
  assert.equal(STATUS_COLORS.down, STATUS_COLORS.error);
  const distinct = new Set([STATUS_COLORS.ok, STATUS_COLORS.starved, STATUS_COLORS.blocked, STATUS_COLORS.down, STATUS_COLORS.idle]);
  assert.equal(distinct.size, 5, 'ok / starved / blocked / down / idle are five different colours');
  assert.ok(Object.isFrozen(STATUS_COLORS));
  assert.equal(statusColor('starved'), STATUS_COLORS.starved);
  assert.equal(statusColor('full'), STATUS_COLORS.blocked);
  assert.equal(statusColor('nope'), STATUS_COLORS.idle);
  assert.equal(statusColor('toString'), STATUS_COLORS.idle, 'prototype keys are not states');
});

test('theme: the mark inside a state dot reads on every status colour, and the dot has a bezel that separates it from any brick', () => {
  for (const [state, color] of Object.entries(STATUS_COLORS)) {
    assert.ok(contrast(STATUS_INK, color) >= MIN_INK_CONTRAST, `${state} ${color}: ${contrast(STATUS_INK, color).toFixed(2)}:1`);
  }
  for (const mode of ['light', 'dark']) {
    const t = getTheme(mode);
    assert.ok(luminance(t.dotRim) > 0.7, 'light rim');
    assert.match(t.dotRing, /^rgba\(\d+,\d+,\d+,0\.[5-9]/, 'a mostly opaque dark ring');
    // the status colour never has to stand on the brick colour alone (amber on yellow is 1.1:1): it sits on the dark ring
    assert.ok(t.dotRing.match(/\d+/g).slice(0, 3).every((v) => Number(v) < 40), `${mode}: ring is near black`);
  }
});

test('theme: dark mode keeps roads distinguishable from the baseplate', () => {
  const dark = getTheme('dark');
  assert.ok(contrast(dark.road, dark.baseplate) >= 1.5, `road / plate ${contrast(dark.road, dark.baseplate).toFixed(2)}:1`);
  assert.ok(luminance(dark.road) < luminance(dark.baseplate));
  assert.ok(contrast(getTheme('light').road, getTheme('light').baseplate) >= 4, 'light roads are far darker than the plate');
});

test('theme: resolveThemeMode passes explicit modes through and follows matchMedia for auto', () => {
  assert.equal(resolveThemeMode('light'), 'light');
  assert.equal(resolveThemeMode('dark'), 'dark');
  assert.equal(resolveThemeMode('auto'), 'light', 'no matchMedia in Node');
  const saved = globalThis.matchMedia;
  try {
    globalThis.matchMedia = (q) => ({ matches: q.includes('dark') });
    assert.equal(resolveThemeMode('auto'), 'dark');
    assert.equal(resolveThemeMode(undefined), 'dark');
    assert.equal(resolveThemeMode('light'), 'light', 'an explicit choice beats the OS preference');
    globalThis.matchMedia = () => ({ matches: false });
    assert.equal(resolveThemeMode('auto'), 'light');
    globalThis.matchMedia = () => { throw new Error('sandboxed'); };
    assert.equal(resolveThemeMode('auto'), 'light');
  } finally {
    if (saved === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = saved;
  }
});

test('theme: heat ramp is transparent at 0, opaque red at 1 and monotone in between', () => {
  const alpha = (s) => Number(/rgba\([^,]+,[^,]+,[^,]+,([\d.]+)\)/.exec(s)[1]);
  assert.equal(alpha(heatColor(0)), 0);
  assert.equal(heatColor(NaN), heatColor(0));
  assert.equal(heatColor(-3), heatColor(0));
  assert.equal(heatColor(7), heatColor(1), 'values above 1 saturate');
  assert.match(heatColor(1), /^rgba\(224,49,49,/);
  let prev = -1;
  for (let i = 0; i <= 40; i++) {
    const a = alpha(heatColor(i / 40));
    assert.ok(a >= prev, 'alpha never decreases');
    prev = a;
  }
  assert.ok(alpha(heatColor(1)) > 0.85);
  assert.equal(getTheme('dark').heat(0.5), heatColor(0.5));
  assert.ok(HEAT_LEVELS >= 16);
});

test('theme: colour maths', () => {
  assert.deepEqual(parseHex('#2f7df6'), [47, 125, 246]);
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHex('nope'), [0, 0, 0]);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#102030', '#102030', 0.7), '#102030');
  assert.equal(shade('#808080', 1), '#ffffff');
  assert.equal(shade('#808080', -1), '#000000');
  assert.ok(luminance(shade('#2f7df6', -0.3)) < luminance('#2f7df6'));
  assert.equal(rgba('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
  assert.equal(rgba('#ff0000', 9), 'rgba(255,0,0,1)');
  near(contrast('#000000', '#ffffff'), 21);
  near(contrast('#777777', '#777777'), 1);
  assert.equal(inkFor('#f5b82e'), '#1c2230', 'dark ink on yellow');
  assert.equal(inkFor('#1c2230'), '#ffffff', 'light ink on dark');
  // mid-tone colours where neither the navy nor the white ink reaches 4.5:1 get pure black or white instead
  assert.equal(inkFor('#2f7df6'), '#000000');
  assert.equal(inkFor('#8a63d2'), '#000000');
  for (let r = 0; r < 256; r += 51) {
    for (let g = 0; g < 256; g += 51) {
      for (let b = 0; b < 256; b += 51) {
        const bg = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        assert.ok(contrast(bg, inkFor(bg)) >= MIN_INK_CONTRAST, `${bg}: ${contrast(bg, inkFor(bg)).toFixed(2)}`);
      }
    }
  }
});

function near(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
}
