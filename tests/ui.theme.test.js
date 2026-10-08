import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTheme, resolveThemeMode, STATUS_COLORS, statusColor, mix, shade, rgba, parseHex, luminance, contrast, inkFor,
  heatColor, HEAT_LEVELS,
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
    'flow', 'selection', 'hover', 'ghostValid', 'ghostInvalid', 'deadlock', 'font', 'accent',
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
      assert.ok(contrast(c.top, c.ink) >= 3.5, `${mode} ${type}: ink contrast ${contrast(c.top, c.ink).toFixed(2)}`);
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
});

function near(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
}
