// The route layer: where the selected vehicle usually drives (docs/ENTITY-INSIGHTS-DESIGN.md 4.2, acceptance S1.11; OVERLAY builder).
//
// What the planner sees, with a vehicle selected and the Statistics dock open (compact too):
//   * every route the vehicle drove in the shown window as a coloured line along the roads: WIDTH = trips, COLOUR = the share of the trip lost to waiting
//     (a ramp blue -> amber -> red whose red end is scaled to the routes on screen), DASHED = empty drives and drives to a depot or charger, chevrons along the
//     loaded ones, a hollow dot where a loaded route starts. A pair of docks that is driven in several ways (the dock is chosen per trip) draws EVERY way that
//     carries at least 10 % of the pair's drawn trips, each with its own width and colour.
//   * a numbered badge 1 to 3 at the end of the three busiest loaded routes (the numbers of the dock's trip list), a chip on the busiest ("16 trips · 62 s · usual
//     route": "usual" is claimed only at 50 % of the drawn trips and 5 complete trips, else "3 ways", else "few trips"), a dashed ring where the vehicle queues for a
//     dock or loses the most time in traffic (sized by the seconds, labelled with the figure), a ring and a name chip on the vehicle itself, and a key that states the
//     scale ("time lost waiting: none -> 30 %+").
//   * hover or focus on a row of the dock's trip list dims every other route to 28 %; pinning does the same until it is unpinned. The shell publishes which row
//     (`view.stats.focus`, see below). The flow arrows recede to 35 % while the layer shows (a derived theme, no change in flows.js).
//
// WHAT IT READS. The collector (`sim.detail`, docs/ARCHITECTURE.md 5.8; this file is one of the few that may), the simulation's road graph, and the frame the renderer
// keeps (selection, overlays, camera). `view.stats = { open, window, focus }` is published by the dock (js/ui/panels/stats-dock.js): `open` true in every dock state
// but closed, `window` 'start' | 'last30', `focus` = { id, pinned } | null. The `id` of a row of the dock's trip list is the one of js/ui/panels/stats-model.js
// (routeFocusId): 'loaded:s4>s5' (a loaded trip: all its drawn ways), 'empty:s4>s5' (the empty drive to a pickup), 'depot:s4>s8' (to a depot or a charger; station ids,
// not collector indices, so they survive a restart) and 'round' (the usual round: its two loaded routes numbered 1 and 2 and the empty drive between them, shown even
// when they are not among the busiest). A focus that names nothing that is drawn dims nothing. tests/ui.routes-render.test.js checks the ids against stats-model.js.
//
// TWO PASSES, because the layer sits on both sides of the vehicles (renderer.js drawLayers): `drawRoutes` before the job lines and the vehicles (halos, lines, chevrons, start
// dots) and `drawRouteMarks` after them (rings, badges, chips, the ring on the selected vehicle, the key). The model is built by `buildRouteSet` (pure, no canvas) at
// most twice a second while the collector's `version` moves, at once when the vehicle, the window or the collector changes; the per-frame code allocates nothing
// (typed polylines cached per path id, text widths cached on the model, constant dash arrays; tests/ui.routes-render.test.js scans the functions and measures the heap).

import { vehiclePose, vehicleSize } from './vehicles.js';
import { fontOf, haloText, roundRectPath, TAU } from './draw.js';
import { mix } from '../theme.js';

// ---- constants (the numbers of the design, named) -------------------------------------------------------------------------------------------

/** A way of a pair of docks is drawn when it carries at least this share of the pair's drawn trips (the usual way always is). */
export const VARIANT_DRAWN_SHARE = 0.1;
/** At most this many loaded pairs, and this many other pairs (empty drives and drives to a depot), are drawn for one vehicle. */
export const MAX_LOADED_PAIRS = 6;
export const MAX_OTHER_PAIRS = 4;
/** At most this many ways per pair are drawn, whatever the 10 % rule would allow. */
export const MAX_VARIANTS_PER_PAIR = 4;
/** The loaded pairs with a numbered badge: the numbers of the trip list in the dock. */
export const RANK_BADGES = 3;
/** "Usual" is claimed only from this many complete trips and this share of the drawn trips of the pair. */
export const MIN_LEGS_FOR_USUAL = 5;
export const USUAL_SHARE_CLAIMED = 0.5;
/** The red end of the colour ramp: the 90th percentile of the shares drawn, rounded up to 5 %, clamped to this range. */
export const RAMP_MIN = 0.08;
export const RAMP_MAX = 0.3;
export const RAMP_FALLBACK = 0.25;
/** What the routes that do not belong to the focused row are drawn at, and what the flow arrows recede to while the layer shows. */
export const DIM_ALPHA = 0.28;
/** The dashed drives (empty, to a depot) are drawn at this opacity: quieter than the loaded trips they serve. */
export const OTHER_ALPHA = 0.7;
export const FLOW_ALPHA = 0.35;
/** The model is rebuilt at most this often (ms) while the collector's version moves. */
export const REFRESH_MS = 500;
/** A ring where it queues: from this many seconds of queue for the dock in the window. A ring in traffic: this share of the vehicle's booked waiting, and the seconds. */
export const QUEUE_RING_MIN_SECONDS = 60;
export const CELL_RING_MIN_SHARE = 0.2;
export const CELL_RING_MIN_SECONDS = 30;
export const CELL_RING_MIN_TOTAL = 60;
export const MAX_RINGS = 3;
/** A rate per hour is only printed from this much measured time (below it the ring says "in total"). */
export const MIN_RATE_SECONDS = 600;
/** The lateral offset of a lane on a two-way road, as a fraction of the cell size: the same number as js/sim/traffic/geometry.js LANE_OFFSET (a test compares them). */
export const LANE_OFFSET = 0.22;
/** Line width in px: cell size times (0.2 + 0.32 sqrt(trips / most trips)), clamped; on a phone half of it. */
export const WIDTH_MIN_PX = 2.4;
export const WIDTH_MAX_PX = 10;
export const WIDTH_MIN_PHONE_PX = 1.6;
export const WIDTH_MAX_PHONE_PX = 4.8;
export const OTHER_WIDTH_PX = 3;
export const PHONE_PX = 600;
/** Text and the key appear from this cell size (px) on. */
export const TEXT_MIN_CELL_PX = 14;
export const KEY_MIN_WIDTH_PX = 520;
/** The focus id of the usual round. */
export const ROUND_KEY = 'round';

const CHEVRON_GAP_PX = 30;
const CHEVRON_MAX = 160;
const RAMP_STEPS = 24;
const NONE_STATION = 0xffff;
const GEOM_CACHE_MAX = 400;
const RING_MAX_SELECTED = 8;
const RECT_CAP = 24;

/** The colours of the layer per theme: the tokens --route-* of css/stats.css (a test compares them). */
const PALETTE = {
  light: Object.freeze({ calm: '#2f6fdd', some: '#e39a0b', much: '#d23a45', halo: 'rgba(255,255,255,0.85)', chevron: '#ffffff', badge: '#1c2230', badgeInk: '#ffffff' }),
  dark: Object.freeze({ calm: '#62a0ff', some: '#ffb92e', much: '#ff6b73', halo: 'rgba(14,18,24,0.85)', chevron: '#0e1218', badge: '#e6ebf5', badgeInk: '#0e1218' }),
};
export const ROUTE_COLORS = PALETTE;

const NO_DASH = [];
const DASH_EMPTY = [9, 6];
const DASH_DEPOT = [2, 7];
const DASH_RING = [3, 3];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isStation = (s) => Number.isInteger(s) && s >= 0 && s !== NONE_STATION;

// ---- keys (what a row of the dock calls a route) --------------------------------------------------------------------------------------------

const KIND_WORDS = ['empty', 'loaded', 'depot', 'depot']; // the collector's leg kinds 0 (to a pickup), 1 (loaded), 2 (to a charger), 3 (to park)
const idxKey = (kind, from, to) => `${kind}:${from}:${to}`;

/** The id a row of the dock gives a pair of stations (the same string as routeFocusId of stats-model.js): 'loaded:s4>s5'; no station (a waiting place on the road) is ''. */
export const pairIdOf = (word, fromId, toId) => `${word}:${fromId}>${toId}`;

/** A focus id as the route layer compares it: 'round', or 'kind:from>to' with an unknown origin written ''; null for anything else. Parsing happens when the focus changes, not per frame. */
export function canonicalFocus(id) {
  if (id === ROUND_KEY) return ROUND_KEY;
  const m = typeof id === 'string' ? /^(loaded|empty|depot):(.*)>(.*)$/.exec(id) : null;
  if (!m) return null;
  const from = m[2] === 'undefined' || m[2] === 'null' ? '' : m[2];
  return pairIdOf(m[1], from, m[3]);
}

// ---- pure rules (unit-tested in Node) ---------------------------------------------------------------------------------------------------------

/** The ways of a pair that are drawn: the usual one always, every other with at least 10 % of the drawable trips. `pathIds` = routesOf(...).pathIds (most used first). */
export function drawnVariants(pathIds) {
  const list = Array.isArray(pathIds) ? pathIds : [];
  let total = 0;
  for (let i = 0; i < list.length; i++) total += list[i].n;
  const out = [];
  for (let i = 0; i < list.length && out.length < MAX_VARIANTS_PER_PAIR; i++) {
    if (i === 0 || (total > 0 && list[i].n / total >= VARIANT_DRAWN_SHARE)) out.push(list[i]);
  }
  return out;
}

/**
 * What may be said about the way of a pair: a "usual route" only from 5 complete trips and, when there are several ways, only when the most used carries at least half of
 * the drawn trips; else "N ways"; below 5 complete trips nothing is claimed. `complete` = trips with a measured duration, `variants` = distinct ways, `share` = of the usual way.
 */
export function usualWording({ complete, variants, share }) {
  if (!(complete >= MIN_LEGS_FOR_USUAL)) return { usual: false, text: 'too few trips for a usual route' };
  if (!(variants > 1)) return { usual: true, text: 'always the same way' };
  const pct = Math.round(100 * clamp(share, 0, 1));
  if (share >= USUAL_SHARE_CLAIMED) return { usual: true, text: `${pct} % the same way` };
  return { usual: false, text: `${variants} ways, the most used ${pct} %` };
}

/** "62 s", "1.5 min", "12 min": a duration the way the plan prints it. '' for nothing. */
export function formatSeconds(s) {
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return '';
  if (s < 90) return `${Math.round(s)} s`;
  const m = s / 60;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
}

/** The chip on the busiest route: "16 trips · 62 s · usual route", "55 trips · 37 s · usual route (56 %)", "12 trips · 1.4 min · 3 ways", "3 trips · few trips so far". `pair` = an entry of routesOf. */
export function routeChipText(pair) {
  const trips = Math.max(0, Math.round(pair.trips || 0));
  let text = `${trips} ${trips === 1 ? 'trip' : 'trips'}`;
  const time = pair.complete > 0 ? formatSeconds(pair.meanTime) : '';
  if (time) text += ` · ${time}`;
  if (!(pair.complete >= MIN_LEGS_FOR_USUAL)) return `${text} · few trips so far`;
  const w = usualWording({ complete: pair.complete, variants: pair.variants, share: pair.pathShare });
  if (!w.usual) return `${text} · ${pair.variants} ways`;
  return pair.variants > 1 ? `${text} · usual route (${formatShare(pair.pathShare)})` : `${text} · usual route`;
}

/** The red end of the ramp for a set of shares (0 to 1): their 90th percentile rounded up to 5 %, between 8 % and 30 %; 25 % for nothing. */
export function rampMaxOf(shares) {
  const a = [];
  for (const s of shares) if (typeof s === 'number' && Number.isFinite(s)) a.push(clamp(s, 0, 1));
  if (a.length === 0) return RAMP_FALLBACK;
  a.sort((x, y) => x - y);
  const p90 = a[Math.min(a.length - 1, Math.floor(0.9 * a.length))];
  return clamp(Math.ceil(p90 * 20 - 1e-9) / 20, RAMP_MIN, RAMP_MAX);
}

/** A trip that loses less than this share of its time to waiting is calm (blue) on every scale: a row of the dock that says "waits 0 s" must not be drawn in the grey-brown blend of blue and amber. */
export const CALM_SHARE = 0.03;

/** Step 0 to RAMP_STEPS of the ramp for a share of the trip lost to waiting, on a ramp whose red end is `max`. */
export function rampStep(share, max) {
  if (!(share >= CALM_SHARE) || !(max > 0)) return 0;
  const t = share >= max ? 1 : share / max;
  return Math.round(t * RAMP_STEPS);
}

/**
 * The ramp: blue holds to 14 % of its length, turns amber by 34 % and holds to 62 %, turns red by 84 % and holds. The holds keep the three colours clear (a plain blend of blue and
 * amber is a grey-brown over most of its length), the short turns show the order; width and the figures carry the rest.
 */
export const RAMP_STOPS = Object.freeze([0, 0.14, 0.34, 0.62, 0.84, 1]);
const RAMPS = {};
for (const mode of ['light', 'dark']) {
  const p = PALETTE[mode];
  const colors = [p.calm, p.calm, p.some, p.some, p.much, p.much];
  const table = [];
  for (let k = 0; k <= RAMP_STEPS; k++) {
    const t = k / RAMP_STEPS;
    let j = 1;
    while (j < RAMP_STOPS.length - 1 && t > RAMP_STOPS[j]) j++;
    const span = RAMP_STOPS[j] - RAMP_STOPS[j - 1];
    table.push(mix(colors[j - 1], colors[j], span > 0 ? (t - RAMP_STOPS[j - 1]) / span : 1));
  }
  RAMPS[mode] = Object.freeze(table);
}

/** The colour (a hex string) of a share on a ramp whose red end is `max`, for a theme mode. */
export const rampColor = (share, max, mode = 'light') => RAMPS[mode === 'dark' ? 'dark' : 'light'][rampStep(share, max)];

let scratch = new Float64Array(256);
let scratchX = new Float64Array(128);
let scratchY = new Float64Array(128);

/**
 * The polyline of a path of road cells in metres, along the lane the vehicles drive: x0, y0, x1, y1, ... Corner points only; on a two-way road the line is moved 0.22
 * cell to the right of the direction of travel (to the left with left-hand traffic), exactly as the simulation's lanes run (js/sim/traffic/geometry.js), so loaded and empty
 * drives of a two-way road do not cover each other; at a corner the two lane lines meet; where a one-way road meets a two-way one in a straight line the line steps over.
 * @param {object} graph the road graph (cols, cellSize, edges, edgeBetween)
 * @param {ArrayLike<number>} nodes cell ids (node = y * cols + x)
 * @param {number} hand 1 right-hand traffic, -1 left-hand
 * @returns {Float64Array}
 */
export function pathLine(graph, nodes, hand = 1) {
  const n = nodes.length;
  if (n < 2 || !graph || !(graph.cols > 0)) return new Float64Array(0);
  const cols = graph.cols;
  const cs = graph.cellSize;
  const off = LANE_OFFSET * cs * (hand < 0 ? -1 : 1);
  if (scratch.length < n * 4 + 8) scratch = new Float64Array(n * 8 + 16);
  if (scratchX.length < n) { scratchX = new Float64Array(n * 2); scratchY = new Float64Array(n * 2); }
  const edges = graph.edges;
  const between = typeof graph.edgeBetween === 'function' ? graph.edgeBetween : null;
  // the unit step and the lane offset of every segment (the offset is perpendicular to the step: to the right of the travel)
  const ux = scratchX;
  const uy = scratchY;
  let cnt = 0;
  const push = (x, y) => { scratch[cnt++] = x; scratch[cnt++] = y; };
  const cx = (id) => ((id % cols) + 0.5) * cs;
  const cy = (id) => (Math.floor(id / cols) + 0.5) * cs;
  const segOff = new Float64Array(2 * (n - 1));
  for (let k = 0; k + 1 < n; k++) {
    const a = nodes[k];
    const b = nodes[k + 1];
    const dx = Math.sign((b % cols) - (a % cols));
    const dy = Math.sign(Math.floor(b / cols) - Math.floor(a / cols));
    const len = Math.hypot(dx, dy) || 1;
    ux[k] = dx / len;
    uy[k] = dy / len;
    let two = false;
    if (between !== null && edges) {
      const e = between(a, b);
      two = e >= 0 && edges[e].rev >= 0;
    }
    segOff[2 * k] = two ? -uy[k] * off : 0;
    segOff[2 * k + 1] = two ? ux[k] * off : 0;
  }
  push(cx(nodes[0]) + segOff[0], cy(nodes[0]) + segOff[1]);
  for (let k = 1; k + 1 < n; k++) {
    const id = nodes[k];
    const inx = segOff[2 * (k - 1)];
    const iny = segOff[2 * (k - 1) + 1];
    const outx = segOff[2 * k];
    const outy = segOff[2 * k + 1];
    const dot = ux[k - 1] * ux[k] + uy[k - 1] * uy[k];
    if (Math.abs(dot) < 1e-9) push(cx(id) + inx + outx, cy(id) + iny + outy); // a corner: the two lane lines meet
    else if (inx !== outx || iny !== outy) { // straight on (or a turn-round at a dead end) onto a lane with another offset: step over
      push(cx(id) + inx, cy(id) + iny);
      push(cx(id) + outx, cy(id) + outy);
    }
  }
  const last = nodes[n - 1];
  push(cx(last) + segOff[2 * (n - 2)], cy(last) + segOff[2 * (n - 2) + 1]);
  return Float64Array.from(scratch.subarray(0, cnt));
}

/** The decoded line of a path with its box, its length and the middle of its longest segment: what is cached per path id. */
function makeGeometry(line) {
  const n = line.length >> 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let best = -1;
  let lx = 0;
  let ly = 0;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const x = line[2 * i];
    const y = line[2 * i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (i + 1 < n) {
      const len = Math.hypot(line[2 * i + 2] - x, line[2 * i + 3] - y);
      length += len;
      if (len > best) { best = len; lx = (x + line[2 * i + 2]) / 2; ly = (y + line[2 * i + 3]) / 2; }
    }
  }
  return { pts: line, n, minX, minY, maxX, maxY, length, lx, ly };
}

const geometryCaches = new WeakMap(); // collector -> { hand, map: path id -> geometry }

function geometryOf(det, graph, hand, pathId) {
  let c = geometryCaches.get(det);
  // a path id means a cell sequence only in one path pool: a collector that restarts (a vehicle or station removed under it) makes a new pool whose ids start at 0 again
  if (c === undefined || c.graph !== graph || c.hand !== hand || c.pool !== det.pool || c.map.size > GEOM_CACHE_MAX) {
    c = { graph, hand, pool: det.pool, map: new Map() };
    geometryCaches.set(det, c);
  }
  let g = c.map.get(pathId);
  if (g === undefined) {
    const nodes = det.pool ? det.pool.nodes(pathId) : null;
    g = nodes && nodes.length >= 2 ? makeGeometry(pathLine(graph, nodes, hand)) : null;
    c.map.set(pathId, g);
  }
  return g;
}

function stationId(det, s) {
  const rt = isStation(s) && det.stations ? det.stations[s] : null;
  return rt && typeof rt.id === 'string' ? rt.id : '';
}

/** The name of a station for a sentence, or '' when there is none (a waiting place on the road, a station the collector does not know). */
function stationName(det, s) {
  const list = det.stations;
  const rt = isStation(s) && list ? list[s] : null;
  if (!rt) return '';
  const name = rt.name || (rt.def && rt.def.name) || rt.id;
  return typeof name === 'string' ? name : '';
}

/** "Queue for Press line's dock", or "Queue for a dock" when the station has no name. */
export const queueTitle = (name) => (name ? `Queue for ${name}'s dock` : 'Queue for a dock');

/** "1.5 min/h" for a queue of `seconds` in a window of `windowSeconds` (a rate only from 10 minutes measured), else "40 s in total". */
export function queueRate(seconds, windowSeconds) {
  if (windowSeconds >= MIN_RATE_SECONDS) {
    const perHour = (seconds * 60) / windowSeconds;
    return `${perHour < 10 ? perHour.toFixed(1) : Math.round(perHour)} min/h`;
  }
  return `${formatSeconds(seconds)} in total`;
}

/** A share as the plan prints it: "25 %", never above 100. */
export const formatShare = (share) => `${Math.round(100 * clamp(share, 0, 1))} %`;

/**
 * The routes of one vehicle in one window, ready to draw: the lines (one per drawn way), the rings, the colour ramp and the box. Pure: no canvas.
 * @param {object} det the collector (sim.detail or the stand-in of tests/helpers/fake-sim.js)
 * @param {object} graph the road graph of the simulation
 * @param {number} i vehicle index (det.vehicleIndex(id))
 * @param {'start'|'last30'} kind the shown window
 * @param {number} hand 1 right-hand traffic, -1 left-hand
 */
export function buildRouteSet(det, graph, i, kind = 'start', hand = 1) {
  const w = det.windowOf(kind === 'last30' ? 'last30' : 'start');
  const vr = det.V ? det.V[i] : null;
  const model = {
    vehicle: i, name: (vr && vr.name) || '', window: w.kind, seconds: w.seconds, version: det.version, routes: [], drawn: 0, rings: [], rampMax: RAMP_FALLBACK,
    hasOthers: false, loadedPairs: 0, round: null, bounds: null, roundBounds: null, key: null,
  };
  const groups = det.routesOf(i, w, [1, 0, 2, 3]);
  const byKey = new Map();
  for (const g of groups) byKey.set(idxKey(g.kind, g.from, g.to), g);
  const loaded = [];
  const others = [];
  for (const g of groups) {
    if (!(g.pathId >= 0) || g.trips < 1) continue;
    if (g.kind === 1) { if (loaded.length < MAX_LOADED_PAIRS) loaded.push(g); } else if (others.length < MAX_OTHER_PAIRS) others.push(g);
  }
  model.loadedPairs = loaded.length;
  const routes = model.routes;
  const addPair = (g, rank, roundOnly, onlyUsual) => {
    const pairKey = idxKey(g.kind, g.from, g.to);
    const pairId = pairIdOf(KIND_WORDS[g.kind], stationId(det, g.from), stationId(det, g.to));
    const variants = roundOnly || onlyUsual ? g.pathIds.slice(0, 1) : drawnVariants(g.pathIds);
    const fallback = g.complete > 0 && g.meanTime > 0 && g.meanWait !== null ? g.meanWait / g.meanTime : 0;
    let drawnTrips = 0;
    for (const p of g.pathIds) drawnTrips += p.n;
    let first = null;
    variants.forEach((p, k) => {
      const geom = geometryOf(det, graph, hand, p.id);
      if (geom === null) return;
      const share = p.complete > 0 && p.meanTime > 0 && p.meanWait !== null ? p.meanWait / p.meanTime : fallback;
      const route = {
        pathId: p.id, kind: g.kind, loaded: g.kind === 1, dash: g.kind === 1 ? 0 : g.kind === 0 ? 1 : 2, from: g.from, to: g.to, n: p.n, usual: k === 0,
        share: drawnTrips > 0 ? p.n / drawnTrips : 1, waitShare: clamp(Number.isFinite(share) ? share : 0, 0, 1), color: 0, geom,
        pairKey, pairId, rank, round: 0, roundOnly,
        label: k === 0 && g.kind === 1 ? routeChipText(g) : null, textW: 0, textFont: '',
      };
      routes.push(route);
      if (first === null) first = route;
    });
    return first;
  };
  loaded.forEach((g, k) => addPair(g, k + 1, false, false));
  for (const g of others) addPair(g, 0, false, true); // an empty drive or a drive to a depot is drawn the one usual way: dashed lines in every way would bury the loaded routes
  // the usual round: its two loaded routes and the empty drive between them (drawn on request even when they are not among the busiest)
  const round = det.roundOf(i, w, 2);
  if (round && round.jobs.length === 2) {
    const find = (g) => (g ? routes.find((r) => r.pairKey === idxKey(g.kind, g.from, g.to) && r.usual) : undefined);
    const jobs = round.jobs.map((j) => byKey.get(idxKey(1, j.from, j.to)));
    const between = byKey.get(idxKey(0, round.jobs[0].to, round.jobs[1].from));
    // `round` is a mask: 1 = the first job, 2 = the second, 4 = the empty drive between them (a round of the same trip twice marks one route with 3)
    const members = [[jobs[0], 1], [between, 4], [jobs[1], 2]];
    let count = 0;
    for (const [g, bit] of members) {
      if (!g || !(g.pathId >= 0)) continue;
      const r = find(g) || addPair(g, 0, true, true);
      if (!r) continue;
      if (r.round === 0) count++;
      r.round |= bit;
    }
    model.round = { jobs: round.jobs, count: round.count, of: round.of, share: round.share, routes: count };
  }
  model.drawn = routes.filter((r) => !r.roundOnly).length;
  model.hasOthers = routes.some((r) => !r.roundOnly && !r.loaded);
  // the scale of the colour follows the loaded ways of the pairs the dock lists (the top three, the numbered ones: stats-model.js scales its legend the same way, so the key on
  // the plan and the legend in the dock agree); the other loaded pairs and the dashed drives are coloured on the same ramp and clipped at its red end
  model.rampMax = rampMaxOf(routes.filter((r) => r.loaded && !r.roundOnly && r.rank <= RANK_BADGES).map((r) => r.waitShare));
  for (const r of routes) r.color = rampStep(r.waitShare, model.rampMax);
  // rings: where it queues for a dock (any window) and, since the start only, the cell that held it up most
  const rings = [];
  const placeRing = (node, seconds, kindName, text) => {
    if (!(node >= 0) || !graph || !(graph.cols > 0)) return;
    if (rings.some((r) => r.node === node)) return;
    rings.push({ node, x: graph.x ? graph.x(node) : 0, y: graph.y ? graph.y(node) : 0, seconds, kind: kindName, text, textW: 0, textFont: '' });
  };
  const queues = det.queuesOf(i, w).filter((q) => q.seconds >= QUEUE_RING_MIN_SECONDS && q.dockNode >= 0).sort((a, b) => b.seconds - a.seconds);
  const cells = [];
  if (w.kind === 'start') {
    const hot = det.hotspots(i, 3);
    if (hot && hot.total >= CELL_RING_MIN_TOTAL) {
      for (const c of hot.cells) {
        const share = Math.min(1, c.seconds / hot.total);
        if (c.seconds >= CELL_RING_MIN_SECONDS && share >= CELL_RING_MIN_SHARE) cells.push({ node: c.node, seconds: c.seconds, share });
      }
    }
  }
  const candidates = [];
  for (const q of queues) candidates.push({ node: q.dockNode, seconds: q.seconds, kindName: 'queue', text: `${queueTitle(stationName(det, q.station))}: ${queueRate(q.seconds, w.seconds)}` });
  for (const c of cells) candidates.push({ node: c.node, seconds: c.seconds, kindName: 'traffic', text: `${formatShare(c.share)} of its waiting in traffic` });
  candidates.sort((a, b) => b.seconds - a.seconds);
  for (const c of candidates) if (rings.length < MAX_RINGS) placeRing(c.node, c.seconds, c.kindName, c.text);
  model.rings = rings;
  // draw order: the dashed drives first, then the loaded ways from the least to the most used, so the busiest lies on top; the routes of the round last (they show on request only)
  routes.sort((a, b) => (a.roundOnly - b.roundOnly) || (a.loaded - b.loaded) || (a.n - b.n) || (a.pathId - b.pathId));
  // the box of what is drawn (metres): the routes and the rings, for "Show route on plan"
  const box = (list) => {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const g of list) { if (g.minX < x0) x0 = g.minX; if (g.minY < y0) y0 = g.minY; if (g.maxX > x1) x1 = g.maxX; if (g.maxY > y1) y1 = g.maxY; }
    return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  const cell = graph && graph.cellSize ? graph.cellSize : 1;
  const ringBoxes = rings.map((r) => ({ minX: r.x - cell / 2, maxX: r.x + cell / 2, minY: r.y - cell / 2, maxY: r.y + cell / 2 }));
  model.bounds = box(routes.filter((r) => !r.roundOnly).map((r) => r.geom).concat(ringBoxes));
  model.key = keyOf(model);
  model.roundBounds = box(routes.filter((r) => r.round !== 0).map((r) => r.geom));
  return model;
}

// ---- the state of a frame ----------------------------------------------------------------------------------------------------------------------

const EMPTY_MODEL = Object.freeze({ vehicle: -1, name: '', window: 'start', seconds: 0, version: -1, routes: Object.freeze([]), drawn: 0, rings: Object.freeze([]), rampMax: RAMP_FALLBACK, hasOthers: false, loadedPairs: 0, round: null, bounds: null, roundBounds: null, key: null });

/** The state of the layer lives on the frame (`fr.routes`, one frame per renderer): the model, what it was built for, the rectangles taken by this frame's labels. */
function stateOf(fr) {
  let s = fr.routes;
  if (s === null || s === undefined) {
    s = { det: null, id: null, win: '', hand: 0, version: -1, at: 0, model: EMPTY_MODEL, rects: new Float64Array(RECT_CAP * 4), nRects: 0, built: 0, focusRaw: null, focusId: null, chipText: '', chipFont: '', chipW: 0 };
    fr.routes = s;
  }
  return s;
}

/** Nothing is shown: let go of the collector and the model of an earlier selection (a warm restart must not keep the old simulation alive through the renderer). */
function release(fr) {
  const s = fr.routes;
  if (s !== null && s !== undefined && s.det !== null) {
    s.det = null;
    s.id = null;
    s.model = EMPTY_MODEL;
    s.version = -1;
  }
}

const reported = new Set();
function reportOnce(err) {
  const key = err && err.message ? err.message : String(err);
  if (reported.has(key)) return;
  reported.add(key);
  if (typeof console !== 'undefined') console.error('[LogiPlan] the route layer', err);
}

/** How many times the model of this frame's layer was built (tests: the cache works). */
export const modelBuilds = (fr) => stateOf(fr).built;

/**
 * The model of the layer for this frame, or null when nothing is shown: no single vehicle selected, the overlay switch off, the dock closed, no collector. Builds it when the
 * vehicle, the window or the collector changed, or (at most twice a second) when the collector's version moved.
 */
export function routesFor(fr) {
  const stats = fr.view.stats;
  const sim = fr.sim;
  const det = sim ? sim.detail : null;
  const graph = sim ? sim.graph : null;
  if (fr.selKind !== 'vehicle' || fr.selIds.length !== 1 || fr.overlays.routes === false || !stats || stats.open !== true || !det || !graph || det.failed === true) {
    release(fr);
    return null;
  }
  const s = stateOf(fr);
  const id = fr.selIds[0];
  const win = stats.window === 'last30' ? 'last30' : 'start';
  let rebuild = s.det !== det || s.id !== id || s.win !== win || s.hand !== fr.hand;
  if (!rebuild && s.version !== det.version) {
    const dt = fr.now - s.at;
    rebuild = !(dt >= 0 && dt < REFRESH_MS);
  }
  if (rebuild) {
    s.det = det;
    s.id = id;
    s.win = win;
    s.hand = fr.hand;
    s.version = det.version;
    s.at = fr.now;
    s.built++;
    try {
      const i = det.vehicleIndex(id);
      s.model = i >= 0 ? buildRouteSet(det, graph, i, win, fr.hand) : EMPTY_MODEL;
    } catch (err) {
      reportOnce(err);
      s.model = EMPTY_MODEL;
    }
  }
  return s.model;
}

// ---- flows recede -------------------------------------------------------------------------------------------------------------------------------

const receded = new WeakMap(); // theme -> theme with the colours of the flow arrows at 35 %

function scaleAlpha(color, k) {
  if (typeof color !== 'string') return color;
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${Math.round((m[4] === undefined ? 1 : Number(m[4])) * k * 1000) / 1000})`;
  const h = /^#([0-9a-f]{6})$/i.exec(color);
  if (h) {
    const v = parseInt(h[1], 16);
    return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${k})`;
  }
  return color;
}

/**
 * The theme the flow arrows are drawn with: the frame's own, or while the route layer shows a copy whose arrow, halo, chip, text and border colours are at 35 %
 * (flows.js reads only these from the theme, so the arrows recede without a change there). Cached per theme.
 */
export function flowTheme(fr, model) {
  const theme = fr.theme;
  if (!model || model.drawn < 1) return theme;
  let t = receded.get(theme);
  if (t === undefined) {
    const own = {};
    for (const key of ['flow', 'flowHalo', 'flowSelected', 'flowChip', 'text', 'panelBorder']) own[key] = { value: scaleAlpha(theme[key], FLOW_ALPHA), enumerable: true }; // (the theme is frozen: plain assignment would fail)
    t = Object.create(theme, own);
    receded.set(theme, t);
  }
  return t;
}

// ---- the jobs overlay yields ------------------------------------------------------------------------------------------------------------------------

const jobViews = new WeakMap(); // simulation -> { view, list }: a stand-in with the one vehicle

/**
 * The simulation the jobs overlay (render/jobs.js: dashed lines from every vehicle to the dock it drives to) is drawn from: the frame's own, or while the route layer shows a stand-in
 * that has only the selected vehicle, so that the two colour languages never compete (a line to the target of that one vehicle is what the planner wants beside its routes).
 * The stand-in inherits everything else (graph, logistics, time) from the simulation; it is made once per simulation.
 */
export function jobsSim(fr, model) {
  const sim = fr.sim;
  if (!sim || !model || model.drawn < 1) return sim;
  let entry = jobViews.get(sim);
  if (entry === undefined) {
    const list = [];
    const view = Object.create(sim);
    Object.defineProperty(view, 'vehicles', { value: list, writable: true });
    entry = { view, list };
    jobViews.set(sim, entry);
  }
  const v = findVehicle(fr, fr.selIds[0]);
  entry.list.length = v ? 1 : 0;
  if (v) entry.list[0] = v;
  return entry.view;
}

// ---- drawing -------------------------------------------------------------------------------------------------------------------------------------

const paletteOf = (theme) => (theme.mode === 'dark' ? PALETTE.dark : PALETTE.light);
const rampOf = (theme) => (theme.mode === 'dark' ? RAMPS.dark : RAMPS.light);

/** Does the route belong to the focused row? `id` = a canonical focus id (canonicalFocus). */
function isFocused(r, id) {
  return id === r.pairId || (id === ROUND_KEY && r.round !== 0);
}

/** The canonical id of the focused row when it names something that is drawn, else null (a focus that names nothing dims nothing). */
function activeFocus(fr, model) {
  const stats = fr.view.stats;
  const focus = stats ? stats.focus : null;
  const raw = focus ? focus.id : null;
  if (raw === null || raw === undefined) return null;
  const s = stateOf(fr);
  if (s.focusRaw !== raw) {
    s.focusRaw = raw;
    s.focusId = canonicalFocus(raw);
  }
  const id = s.focusId;
  if (id === null) return null;
  const list = model.routes;
  for (let k = 0; k < list.length; k++) {
    if ((!list[k].roundOnly || id === ROUND_KEY) && isFocused(list[k], id)) return id;
  }
  return null;
}

/** Line width of a route in px. */
function widthOf(r, cellPx, maxTrips, phone) {
  if (!r.loaded) return phone ? OTHER_WIDTH_PX * 0.6 : OTHER_WIDTH_PX;
  const w = cellPx * (0.2 + 0.32 * Math.sqrt(r.n / maxTrips));
  return phone ? clamp(w * 0.5, WIDTH_MIN_PHONE_PX, WIDTH_MAX_PHONE_PX) : clamp(w, WIDTH_MIN_PX, WIDTH_MAX_PX);
}

/** The most trips of a loaded way, for the widths (at least 1). */
function maxTripsOf(model) {
  let m = 1;
  const list = model.routes;
  for (let k = 0; k < list.length; k++) if (list[k].loaded && list[k].n > m) m = list[k].n;
  return m;
}

function onScreen(fr, g, pad) {
  const z = fr.zoom;
  return !(fr.ox + g.maxX * z < -pad || fr.ox + g.minX * z > fr.w + pad || fr.oy + g.maxY * z < -pad || fr.oy + g.minY * z > fr.h + pad);
}

function tracePath(ctx, fr, g) {
  const pts = g.pts;
  const z = fr.zoom;
  const ox = fr.ox;
  const oy = fr.oy;
  ctx.beginPath();
  ctx.moveTo(ox + pts[0] * z, oy + pts[1] * z);
  for (let i = 1; i < g.n; i++) ctx.lineTo(ox + pts[2 * i] * z, oy + pts[2 * i + 1] * z);
}

/** Chevrons along a polyline, one path filled once: a small arrow head every 30 px, anchored at the start of the route. */
function drawChevrons(ctx, fr, g, width, color) {
  const pts = g.pts;
  const z = fr.zoom;
  const size = Math.max(fr.w < PHONE_PX ? 4 : 5.5, width * 0.8);
  let carry = CHEVRON_GAP_PX / 2;
  let drawn = 0;
  const w = fr.w;
  const h = fr.h;
  ctx.beginPath();
  for (let i = 0; i + 1 < g.n && drawn < CHEVRON_MAX; i++) {
    const x0 = fr.ox + pts[2 * i] * z;
    const y0 = fr.oy + pts[2 * i + 1] * z;
    const x1 = fr.ox + pts[2 * i + 2] * z;
    const y1 = fr.oy + pts[2 * i + 3] * z;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1) continue;
    if (Math.max(x0, x1) < -size || Math.min(x0, x1) > w + size || Math.max(y0, y1) < -size || Math.min(y0, y1) > h + size) { // off screen: only the phase moves on
      carry = carry >= len ? carry - len : carry + Math.ceil((len - carry) / CHEVRON_GAP_PX) * CHEVRON_GAP_PX - len;
      continue;
    }
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    let s = carry;
    while (s < len - size && drawn < CHEVRON_MAX) {
      const cx = x0 + ux * s;
      const cy = y0 + uy * s;
      ctx.moveTo(cx + ux * size * 0.55, cy + uy * size * 0.55);
      ctx.lineTo(cx - ux * size * 0.45 - uy * size * 0.62, cy - uy * size * 0.45 + ux * size * 0.62);
      ctx.lineTo(cx - ux * size * 0.45 + uy * size * 0.62, cy - uy * size * 0.45 - ux * size * 0.62);
      ctx.closePath();
      s += CHEVRON_GAP_PX;
      drawn++;
    }
    carry = s - len;
  }
  if (drawn > 0) {
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/**
 * Pass 1: the routes of the selected vehicle, under the job lines and the vehicles. Expects the CSS-pixel transform.
 * @param {object} model the result of routesFor(fr) (not null)
 */
export function drawRoutes(ctx, fr, model) {
  const list = model.routes;
  if (model.drawn < 1) return;
  const theme = fr.theme;
  const pal = paletteOf(theme);
  const ramp = rampOf(theme);
  const focus = activeFocus(fr, model);
  const roundShown = focus === ROUND_KEY;
  const cellPx = fr.cs * fr.zoom;
  const phone = fr.w < PHONE_PX;
  const maxTrips = maxTripsOf(model);
  const heat = fr.overlays.heat === 'traffic' || fr.overlays.heat === 'waiting';
  const haloExtra = heat ? 6 : 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(NO_DASH);
  // the halos of all routes first, so that the halo of one never covers the line of another
  for (let k = 0; k < list.length; k++) {
    const r = list[k];
    if (r.roundOnly && !roundShown) continue;
    if (!onScreen(fr, r.geom, 12)) continue;
    const focused = focus === null || isFocused(r, focus);
    ctx.globalAlpha = focused ? 1 : DIM_ALPHA;
    tracePath(ctx, fr, r.geom);
    // the dashed drives (empty, to a depot) are the supporting cast: a narrower halo, so that a long drive to park is not the loudest line of the plan
    ctx.lineWidth = widthOf(r, cellPx, maxTrips, phone) + (r.dash !== 0 ? haloExtra / 2 : haloExtra) + (focus !== null && focused ? 1 : 0);
    ctx.strokeStyle = pal.halo;
    ctx.stroke();
  }
  for (let k = 0; k < list.length; k++) {
    const r = list[k];
    if (r.roundOnly && !roundShown) continue;
    if (!onScreen(fr, r.geom, 12)) continue;
    const focused = focus === null || isFocused(r, focus);
    const width = widthOf(r, cellPx, maxTrips, phone) + (focus !== null && focused ? 1 : 0);
    ctx.globalAlpha = focused ? (r.dash !== 0 ? OTHER_ALPHA : r.usual ? 1 : 0.8) : DIM_ALPHA;
    tracePath(ctx, fr, r.geom);
    ctx.lineWidth = width;
    ctx.strokeStyle = ramp[r.color];
    if (r.dash !== 0) { // square dash ends: a dashed stroke with round caps costs several times more to rasterise (the same choice as the job lines)
      ctx.lineCap = 'butt';
      ctx.setLineDash(r.dash === 1 ? DASH_EMPTY : DASH_DEPOT);
    }
    ctx.stroke();
    if (r.dash !== 0) {
      ctx.setLineDash(NO_DASH);
      ctx.lineCap = 'round';
    }
    if (r.dash === 0) drawChevrons(ctx, fr, r.geom, width, pal.chevron);
    if (r.loaded && r.usual) { // the start of a loaded route: a hollow dot
      const g = r.geom;
      ctx.beginPath();
      ctx.arc(fr.ox + g.pts[0] * fr.zoom, fr.oy + g.pts[1] * fr.zoom, phone ? 3 : 4.5, 0, TAU);
      ctx.fillStyle = theme.mode === 'dark' ? '#12161d' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = phone ? 2 : 2.5;
      ctx.strokeStyle = ramp[r.color];
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

// ---- pass 2: rings, badges, chips, the selected vehicle, the key ------------------------------------------------------------------------------------

/** Remember a rectangle that is taken; does it collide with one taken before? */
function collides(s, x, y, w, h) {
  const rects = s.rects;
  for (let i = 0; i < s.nRects; i++) {
    const o = i * 4;
    if (x < rects[o + 2] && x + w > rects[o] && y < rects[o + 3] && y + h > rects[o + 1]) return true;
  }
  return false;
}

function take(s, x, y, w, h) {
  if (s.nRects >= RECT_CAP) return;
  const o = s.nRects++ * 4;
  s.rects[o] = x;
  s.rects[o + 1] = y;
  s.rects[o + 2] = x + w;
  s.rects[o + 3] = y + h;
}

/** Width of `text` in the font set on ctx, measured once per (text, font) and kept on the model object (`owner.textW`, `owner.textFont`). */
function textWidth(ctx, owner, text) {
  if (owner.textFont !== ctx.font || owner.textW === 0) {
    owner.textW = ctx.measureText(text).width;
    owner.textFont = ctx.font;
  }
  return owner.textW;
}

function drawBadge(ctx, fr, pal, ramp, r, no, dx) {
  const g = r.geom;
  const x = fr.ox + g.pts[2 * g.n - 2] * fr.zoom + dx;
  const y = fr.oy + g.pts[2 * g.n - 1] * fr.zoom;
  if (x < -12 || y < -12 || x > fr.w + 12 || y > fr.h + 12) return;
  const rad = fr.w < PHONE_PX ? 8 : 10;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, TAU);
  ctx.fillStyle = pal.badge;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = ramp[r.color];
  ctx.stroke();
  ctx.fillStyle = pal.badgeInk;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(BADGE_TEXT[no], x, y + 0.5);
}
const BADGE_TEXT = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const LABEL_OFFSETS = [-34, 34, -58, 58, -82]; // where a chip may sit relative to the middle of its route (px), nearest first

function drawLabel(ctx, fr, s, theme, ramp, r) {
  const text = r.label;
  const g = r.geom;
  const w = textWidth(ctx, r, text) + 18;
  const h = 20;
  const px = fr.ox + g.lx * fr.zoom;
  const y = fr.oy + g.ly * fr.zoom;
  if (px < -w || y < -h || px > fr.w + w || y > fr.h + h) return;
  const x = fr.w > w + 8 ? Math.min(fr.w - w / 2 - 4, Math.max(w / 2 + 4, px)) : px; // the chip stays on the canvas
  let top = y + LABEL_OFFSETS[0] - h / 2;
  for (let k = 0; k < LABEL_OFFSETS.length; k++) {
    top = y + LABEL_OFFSETS[k] - h / 2;
    if (!collides(s, x - w / 2, top, w, h)) break;
  }
  if (top < 4) top = 4;
  take(s, x - w / 2, top, w, h);
  ctx.beginPath();
  roundRectPath(ctx, x - w / 2, top, w, h, h / 2);
  ctx.fillStyle = theme.flowChip;
  ctx.fill();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = ramp[r.color];
  ctx.stroke();
  ctx.fillStyle = theme.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, top + h / 2 + 0.5);
}

function drawRing(ctx, fr, s, theme, pal, ring, maxSeconds, showText) {
  const x = fr.ox + ring.x * fr.zoom;
  const y = fr.oy + ring.y * fr.zoom;
  if (x < -40 || y < -40 || x > fr.w + 40 || y > fr.h + 40) return;
  const rad = 11 + 9 * Math.sqrt(ring.seconds / maxSeconds);
  ctx.setLineDash(NO_DASH);
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, TAU);
  ctx.lineWidth = 5;
  ctx.strokeStyle = pal.halo;
  ctx.stroke();
  ctx.setLineDash(DASH_RING);
  ctx.lineWidth = 2;
  ctx.strokeStyle = pal.much;
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
  take(s, x - rad, y - rad, 2 * rad, 2 * rad);
  if (!showText) return;
  const tw = textWidth(ctx, ring, ring.text);
  let tx = x - tw / 2;
  if (tx + tw > fr.w - 4) tx = fr.w - 4 - tw;
  if (tx < 4) tx = 4;
  let ty = y - rad - 11; // above the ring, so the text does not lie on the route; below it when that is taken
  if (ty < 12 || collides(s, tx - 3, ty - 8, tw + 6, 16)) ty = y + rad + 11;
  if (collides(s, tx - 3, ty - 8, tw + 6, 16)) return;
  take(s, tx - 3, ty - 8, tw + 6, 16);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  haloText(ctx, ring.text, tx, ty + 0.5, theme.text, theme.labelHalo, 3);
}

function findVehicle(fr, id) {
  const sim = fr.sim;
  const det = sim ? sim.detail : null;
  if (det && typeof det.vehicleIndex === 'function' && det.V) {
    const i = det.vehicleIndex(id);
    if (i >= 0) return det.V[i];
  }
  const list = sim ? sim.vehicles : null;
  if (list) for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
  return null;
}

/** The ring on a selected vehicle (and, for the one whose routes show, its name chip). */
function drawVehicleMarks(ctx, fr, s, theme, id, withChip) {
  const v = findVehicle(fr, id);
  if (!v || v.visible === false) return;
  const pose = fr.pose;
  if (!vehiclePose(v, fr.alpha, fr.cs * 1.5, pose)) return;
  const size = vehicleSize(v, fr.cs, fr.size);
  const lenPx = Math.max(size.length * fr.zoom, 9);
  const widPx = Math.max(size.width * fr.zoom, 5);
  const x = fr.ox + pose[0] * fr.zoom;
  const y = fr.oy + pose[1] * fr.zoom;
  if (x < -40 || y < -40 || x > fr.w + 40 || y > fr.h + 40) return;
  const rad = Math.max(11, 0.5 * Math.hypot(lenPx, widPx) + 5);
  const pulse = fr.reducedMotion ? 1 : 0.8 + 0.2 * Math.sin(fr.now / 260);
  ctx.setLineDash(NO_DASH);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, TAU);
  ctx.lineWidth = 6.5;
  ctx.strokeStyle = theme.mode === 'dark' ? 'rgba(14,18,24,0.85)' : 'rgba(255,255,255,0.9)';
  ctx.stroke();
  ctx.globalAlpha = pulse;
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.selection;
  ctx.stroke();
  ctx.globalAlpha = 1;
  take(s, x - rad, y - rad, 2 * rad, 2 * rad);
  const name = v.name;
  if (!withChip || typeof name !== 'string' || name === '' || fr.cs * fr.zoom < 6) return;
  ctx.font = fontOf(theme, 600, 11.5);
  if (s.chipText !== name || s.chipFont !== ctx.font) { // measured once per name and font
    s.chipText = name;
    s.chipFont = ctx.font;
    s.chipW = ctx.measureText(name).width;
  }
  const w = s.chipW + 18;
  const h = 22;
  let top = y - rad - 6 - h;
  if (top < 4) top = y + rad + 6;
  ctx.beginPath();
  roundRectPath(ctx, x - w / 2, top, w, h, h / 2);
  ctx.fillStyle = theme.flowChip;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = theme.selection;
  ctx.stroke();
  ctx.fillStyle = theme.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x, top + h / 2 + 0.5);
  take(s, x - w / 2, top, w, h);
}

const KEY_RAMP_W = 56;
const KEY_RIGHT_INSET_PX = 60; // 12 px margin + the 36 px of the zoom buttons + 12 px air
const KEY_PAD = 9;
const KEY_LINE_H = 16;

/** The three lines of the key (built with the model, so that nothing is made per frame): the title, the scale, and what the dashes and rings mean. */
function keyOf(model) {
  const lines = model.hasOthers || model.rings.length > 0 ? 3 : 2;
  const extra = model.hasOthers && model.rings.length > 0 ? 'dashed = empty or to depot · ring = where it queues' : model.hasOthers ? 'dashed = empty or to depot' : 'ring = where it queues';
  return { title: model.name ? `${model.name}: usual trips` : 'Usual trips', width: 'Width = trips', scale: `time lost waiting: none → ${Math.round(model.rampMax * 100)} %+`, extra, lines, font: '', w: 0, rampX: 0 };
}

/** The key at the bottom left of the plan, above the dock: the scale of the colour, the dashes and the ring, in the words of the dock. */
function drawKey(ctx, fr, theme, ramp, model, covered) {
  const key = model.key;
  if (fr.w < KEY_MIN_WIDTH_PX) return;
  const h = KEY_PAD * 2 + KEY_LINE_H * key.lines - 3;
  const y = fr.h - (covered > 0 ? covered : 44) - 10 - h;
  if (y < 56) return;
  const bold = fontOf(theme, 600, 11.5);
  const plain = fontOf(theme, 500, 11);
  if (key.font !== plain) { // measured once per font
    ctx.font = bold;
    const t1 = ctx.measureText(key.title).width;
    ctx.font = plain;
    key.rampX = ctx.measureText(key.width).width + 10;
    const t2 = key.rampX + KEY_RAMP_W + 8 + ctx.measureText(key.scale).width;
    const t3 = key.lines === 3 ? ctx.measureText(key.extra).width : 0;
    key.w = Math.max(t1, t2, t3) + KEY_PAD * 2;
    key.font = plain;
  }
  const w = Math.min(fr.w - 24, key.w);
  const x = fr.w - KEY_RIGHT_INSET_PX - w; // beside the zoom buttons, so that it never meets the guide chip and the dock's floating controls at the left
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, 10);
  ctx.fillStyle = theme.panel;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.panelBorder;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = bold;
  ctx.fillStyle = theme.text;
  ctx.fillText(key.title, x + KEY_PAD, y + KEY_PAD + 5);
  ctx.font = plain;
  ctx.fillStyle = theme.textDim;
  const row2 = y + KEY_PAD + KEY_LINE_H + 5;
  ctx.fillText(key.width, x + KEY_PAD, row2);
  const bx = x + KEY_PAD + key.rampX;
  for (let k = 0; k < KEY_RAMP_W; k += 2) {
    ctx.fillStyle = ramp[Math.round((k / (KEY_RAMP_W - 2)) * RAMP_STEPS)];
    ctx.fillRect(bx + k, row2 - 3, 2, 6);
  }
  ctx.fillStyle = theme.textDim;
  ctx.fillText(key.scale, bx + KEY_RAMP_W + 8, row2);
  if (key.lines === 3) ctx.fillText(key.extra, x + KEY_PAD, row2 + KEY_LINE_H);
}

/**
 * Pass 2: above the vehicles. The ring of every selected vehicle (always), and while the layer shows the badges, the chip of the busiest route, the rings where it queues, the
 * name chip of the vehicle and the key. `model` is the result of routesFor(fr) or null.
 */
export function drawRouteMarks(ctx, fr, model) {
  if (fr.selKind !== 'vehicle' || fr.selIds.length === 0) return;
  const s = stateOf(fr);
  s.nRects = 0;
  const theme = fr.theme;
  const shown = model !== null && model.drawn > 0;
  const pal = paletteOf(theme);
  const ramp = rampOf(theme);
  // the ring on the selected vehicle first: it takes its place (and that of its name chip), the labels below keep clear of it
  const n = fr.selIds.length < RING_MAX_SELECTED ? fr.selIds.length : RING_MAX_SELECTED;
  for (let k = 0; k < n; k++) drawVehicleMarks(ctx, fr, s, theme, fr.selIds[k], shown && n === 1);
  if (shown) {
    const focus = activeFocus(fr, model);
    const roundShown = focus === ROUND_KEY;
    const list = model.routes;
    const showText = fr.cs * fr.zoom >= TEXT_MIN_CELL_PX;
    let maxSeconds = 1;
    for (let k = 0; k < model.rings.length; k++) if (model.rings[k].seconds > maxSeconds) maxSeconds = model.rings[k].seconds;
    ctx.font = fontOf(theme, 600, 11);
    ctx.globalAlpha = focus === null ? 1 : DIM_ALPHA + 0.2;
    for (let k = 0; k < model.rings.length; k++) drawRing(ctx, fr, s, theme, pal, model.rings[k], maxSeconds, showText);
    // numbered badges: the busiest loaded routes (the numbers of the dock's list), or 1 and 2 of the usual round when that row is focused
    ctx.font = fontOf(theme, 700, 11);
    for (let k = 0; k < list.length; k++) {
      const r = list[k];
      if (!r.usual) continue;
      ctx.globalAlpha = focus === null || isFocused(r, focus) ? 1 : DIM_ALPHA;
      if (roundShown) { // the two jobs: when they are the same trip, its end carries both numbers side by side
        const jobs = r.round & 3;
        if (jobs & 1) drawBadge(ctx, fr, pal, ramp, r, 1, jobs === 3 ? -11 : 0);
        if (jobs & 2) drawBadge(ctx, fr, pal, ramp, r, 2, jobs === 3 ? 11 : 0);
      } else if (!r.roundOnly && r.loaded && r.rank >= 1 && r.rank <= RANK_BADGES) drawBadge(ctx, fr, pal, ramp, r, r.rank, 0);
    }
    ctx.globalAlpha = 1;
    if (showText) {
      ctx.font = fontOf(theme, 500, 11);
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        if (r.label === null || r.roundOnly) continue;
        if (focus === null ? r.rank === 1 : isFocused(r, focus)) drawLabel(ctx, fr, s, theme, ramp, r);
      }
    }
    drawKey(ctx, fr, theme, ramp, model, fr.covered > 0 ? fr.covered : 0);
  }
  ctx.globalAlpha = 1;
}
