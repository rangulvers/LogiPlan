// Canvas palette for the plant renderer (docs/ARCHITECTURE.md §7), light and dark. The canvas cannot read
// CSS custom properties cheaply, so this file mirrors the design tokens of css/tokens.css (accent #2f7df6,
// neutral grey-blue surfaces) as plain JS objects. It also owns the colour maths (hex mixing, contrast) and
// the status colours that the rest of the UI shares, so a "starved" workstation has the same amber everywhere.
//
// Pure: no DOM access except an optional, guarded `matchMedia` in resolveThemeMode().

import { STATION_TYPES, STATION_TYPE_ORDER } from '../model/defaults.js';
import { clamp } from '../util/format.js';

// ---- status colours (shared with panels, dashboard, charts) -------------------------------------

/** busy/ok green, starved amber, blocked/waiting orange, down/error red, idle grey. */
export const STATUS_COLORS = Object.freeze({
  ok: '#2fb36b',
  busy: '#2fb36b',
  normal: '#2fb36b',
  starved: '#f5a524',
  blocked: '#f76b15',
  waiting: '#f76b15',
  full: '#f76b15',
  down: '#e5484d',
  error: '#e5484d',
  idle: '#8b93a1',
});

/** Colour for a station / machine / vehicle state name; unknown states read as idle grey. */
export function statusColor(state) {
  return Object.hasOwn(STATUS_COLORS, state) ? STATUS_COLORS[state] : STATUS_COLORS.idle;
}

/** Ink of the mark drawn inside a state dot (the colour-independent cue): >= 4.5:1 on every status colour. */
export const STATUS_INK = '#0b0f19';

// ---- colour maths ----------------------------------------------------------------------------------

/** '#rgb' / '#rrggbb' -> [r, g, b] (0..255). Anything else parses as black. */
export function parseHex(hex) {
  let h = typeof hex === 'string' && hex[0] === '#' ? hex.slice(1) : '';
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 0, 0];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** Linear mix of two hex colours: t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a, b, t) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return '#' + [0, 1, 2].map((i) => toHex(ca[i] + (cb[i] - ca[i]) * t)).join('');
}

/** Lighten (amount > 0, towards white) or darken (amount < 0, towards black) by a fraction. */
export const shade = (hex, amount) => (amount >= 0 ? mix(hex, '#ffffff', amount) : mix(hex, '#000000', -amount));

/** Hex colour + alpha -> 'rgba(r,g,b,a)'. */
export function rgba(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${Math.round(clamp(alpha, 0, 1) * 1000) / 1000})`;
}

/** WCAG relative luminance (0..1). */
export function luminance(hex) {
  const lin = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio (1..21) between two hex colours. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Contrast (WCAG AA for normal text) that `inkFor` aims for. */
export const MIN_INK_CONTRAST = 4.5;

/**
 * Whichever of dark / light ink reads better on `bg`. When neither reaches 4.5:1 (some mid-tone bricks) it
 * falls back to pure black or white, which always do (the best of the two is >= 4.58:1 on any colour).
 */
export function inkFor(bg, dark = '#1c2230', light = '#ffffff') {
  const best = contrast(bg, dark) >= contrast(bg, light) ? dark : light;
  if (contrast(bg, best) >= MIN_INK_CONTRAST) return best;
  return contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff';
}

// ---- heat ramp -------------------------------------------------------------------------------------

/** Heat ramp stops [t, r, g, b, a]: fully transparent at 0, quickly visible yellow, then orange, red at 1. */
const HEAT_STOPS = [
  [0, 255, 212, 59, 0],
  [0.12, 255, 212, 59, 0.55],
  [0.5, 255, 146, 43, 0.82],
  [1, 224, 49, 49, 0.95],
];
const HEAT_STEPS = 64;

/** Precomputed 'rgba()' strings, index 0 = transparent, last = hottest. Shared by both themes. */
const HEAT_TABLE = Array.from({ length: HEAT_STEPS }, (_, i) => {
  const t = i / (HEAT_STEPS - 1);
  let k = 1;
  while (k < HEAT_STOPS.length - 1 && HEAT_STOPS[k][0] < t) k++;
  const [t0, r0, g0, b0, a0] = HEAT_STOPS[k - 1];
  const [t1, r1, g1, b1, a1] = HEAT_STOPS[k];
  const f = (t - t0) / (t1 - t0);
  const lerp = (p, q) => p + (q - p) * f;
  return `rgba(${Math.round(lerp(r0, r1))},${Math.round(lerp(g0, g1))},${Math.round(lerp(b0, b1))},${Math.round(lerp(a0, a1) * 1000) / 1000})`;
});

/** Heat colour for a normalised value 0..1 (NaN / negative = transparent, > 1 = hottest). No allocation. */
export function heatColor(t) {
  if (!(t > 0)) return HEAT_TABLE[0];
  return HEAT_TABLE[Math.min(HEAT_STEPS - 1, Math.round(t * (HEAT_STEPS - 1)))];
}

/** Number of distinct heat levels (callers may quantise to it to batch draw calls). */
export const HEAT_LEVELS = HEAT_STEPS;

// ---- palettes --------------------------------------------------------------------------------------

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const ACCENT = '#2f7df6';

/** Brick colours derived from the station's base colour. */
function brickColors(base, mode) {
  const top = mode === 'dark' ? shade(base, -0.1) : base;
  const ink = inkFor(top);
  const dark = ink !== '#ffffff';
  return {
    base: top,
    top,
    hi: shade(top, 0.34), // highlight line along the top-left edge of the top face
    edge: shade(top, -0.34), // front (south) face = depth of the brick
    stud: shade(top, 0.14),
    studHi: shade(top, 0.42),
    studLo: shade(top, -0.2),
    ink,
    inkDim: dark ? 'rgba(28,34,48,0.7)' : 'rgba(255,255,255,0.8)',
    icon: mode === 'dark' ? shade(top, 0.3) : shade(top, -0.38), // glyph colour on the name tile
    plate: dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.2)', // pill behind the name so it reads over studs
    track: 'rgba(15,20,32,0.32)', // empty part of bars (reads on every brick colour)
    bar: 'rgba(255,255,255,0.95)', // filled part of bars
  };
}

function stationPalette(mode) {
  const out = {};
  for (const type of STATION_TYPE_ORDER) out[type] = Object.freeze(brickColors(STATION_TYPES[type].color, mode));
  return Object.freeze(out);
}

const LIGHT = {
  mode: 'light',
  font: FONT,
  accent: ACCENT,
  bg: '#eef1f6',
  shadow: 'rgba(30,41,59,0.16)',
  baseplate: '#d9e2ee',
  baseplateSide: '#b9c6d8',
  baseplateEdge: '#a9b8cd',
  stud: '#e1e8f2',
  studHi: '#edf2f9',
  studLo: '#c5d1e2',
  gridLine: 'rgba(84,104,134,0.17)',
  gridMajor: 'rgba(84,104,134,0.32)',
  road: '#434b5a',
  roadEdgeHi: 'rgba(255,255,255,0.20)',
  roadEdgeLo: 'rgba(8,12,20,0.55)',
  roadMark: 'rgba(238,242,248,0.78)',
  roadChevron: 'rgba(224,231,242,0.92)',
  zoneFill: 'rgba(245,184,46,0.20)',
  zoneHatch: 'rgba(245,184,46,0.85)',
  zoneBadge: '#f5b82e',
  zoneBadgeInk: '#3a2a00',
  obstacle: {
    wall: { fill: '#5d6877', edge: '#3d4654', hatch: 'rgba(255,255,255,0.22)' },
    rack: { fill: '#9aa5b6', edge: '#6f7b8e', shelf: '#6f7b8e', box: '#c9d1dd' },
    column: { fill: '#4a5463', edge: '#2d3541', ring: '#a9b3c3' },
  },
  label: '#273044',
  labelHalo: 'rgba(238,243,250,0.92)',
  text: '#1c2230',
  textDim: '#5d6b82',
  panel: 'rgba(255,255,255,0.92)',
  panelBorder: 'rgba(60,76,104,0.28)',
  tile: 'rgba(255,255,255,0.93)', // name plate on a brick
  tileInk: '#1c2230',
  flow: '#3f5f93',
  flowHalo: 'rgba(255,255,255,0.85)',
  flowSelected: ACCENT,
  flowChip: 'rgba(255,255,255,0.95)',
  selection: ACCENT,
  selectionFill: 'rgba(47,125,246,0.08)',
  hover: 'rgba(47,125,246,0.7)',
  handleFill: '#ffffff',
  handleStroke: ACCENT,
  ghostValid: '#2fb36b',
  ghostInvalid: '#e5484d',
  marquee: ACCENT,
  marqueeFill: 'rgba(47,125,246,0.10)',
  dock: '#ffffff',
  dotRim: '#ffffff', // bezel of the state dot: light rim, dark ring, so the status colour reads on any brick colour
  dotRing: 'rgba(11,15,25,0.82)',
  deadlock: '#e5484d',
  vehicle: {
    outline: 'rgba(14,20,32,0.7)',
    windshield: 'rgba(235,244,255,0.9)',
    headlight: '#fff3b8',
    wheel: 'rgba(14,20,32,0.82)',
    load: '#cf9a58',
    loadEdge: '#8d5f2b',
    wait: '#e5484d',
    hazard: '#ffb224',
    hazardInk: '#1c2230',
    bolt: '#1fc46d',
    batteryTrack: 'rgba(14,20,32,0.45)',
    badgeFill: '#ffffff',
    badgeInk: '#1c2230',
  },
};

const DARK = {
  ...LIGHT,
  mode: 'dark',
  bg: '#12161d',
  shadow: 'rgba(0,0,0,0.42)',
  baseplate: '#2c384b',
  baseplateSide: '#161c26',
  baseplateEdge: '#3d4c66',
  stud: '#344158',
  studHi: '#40506b',
  studLo: '#222c3b',
  gridLine: 'rgba(160,180,215,0.10)',
  gridMajor: 'rgba(160,180,215,0.22)',
  road: '#0a0d13',
  roadEdgeHi: 'rgba(160,180,215,0.24)',
  roadEdgeLo: 'rgba(0,0,0,0.6)',
  roadMark: 'rgba(168,181,205,0.62)',
  roadChevron: 'rgba(190,202,224,0.82)',
  zoneFill: 'rgba(245,184,46,0.14)',
  zoneHatch: 'rgba(245,184,46,0.62)',
  obstacle: {
    wall: { fill: '#4d596b', edge: '#2e3745', hatch: 'rgba(255,255,255,0.16)' },
    rack: { fill: '#68768c', edge: '#47546a', shelf: '#47546a', box: '#8e9bb0' },
    column: { fill: '#6d7b91', edge: '#47546a', ring: '#c2ccdc' },
  },
  label: '#dbe3f0',
  labelHalo: 'rgba(24,30,40,0.9)',
  text: '#e6ebf5',
  textDim: '#93a0b8',
  panel: 'rgba(28,34,46,0.92)',
  panelBorder: 'rgba(160,180,215,0.28)',
  tile: 'rgba(20,25,34,0.9)',
  tileInk: '#e6ebf5',
  flow: '#8fb0ea',
  flowHalo: 'rgba(14,18,26,0.85)',
  flowSelected: '#5b9bff',
  flowChip: 'rgba(30,38,52,0.95)',
  selection: '#5b9bff',
  selectionFill: 'rgba(91,155,255,0.16)',
  hover: 'rgba(120,176,255,0.8)',
  handleFill: '#1c2230',
  handleStroke: '#7fb1ff',
  dock: '#e6ebf5',
  vehicle: {
    ...LIGHT.vehicle,
    outline: 'rgba(0,0,0,0.78)',
    badgeFill: '#1c2230',
    badgeInk: '#e6ebf5',
  },
};

function build(base) {
  const theme = {
    ...base,
    station: stationPalette(base.mode),
    status: STATUS_COLORS,
    statusColor,
    heat: heatColor,
  };
  return Object.freeze(theme);
}

const THEMES = { light: build(LIGHT), dark: build(DARK) };

/**
 * Canvas palette for 'light' or 'dark' (anything else is treated as light). The object is frozen and
 * cached: the same mode always returns the same instance, so it can be used as a cache key.
 * @param {'light'|'dark'} mode
 */
export function getTheme(mode) {
  return mode === 'dark' ? THEMES.dark : THEMES.light;
}

/**
 * Resolve the user's theme setting to a concrete mode. 'auto' follows `prefers-color-scheme` when
 * `matchMedia` exists, otherwise 'light'.
 * @param {'auto'|'light'|'dark'} mode
 * @returns {'light'|'dark'}
 */
export function resolveThemeMode(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  try {
    if (typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch {
    // matchMedia can throw in sandboxed frames: fall through to light
  }
  return 'light';
}
