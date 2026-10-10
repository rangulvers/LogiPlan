// The route layer of a selected vehicle (js/ui/render/routes.js; docs/ENTITY-INSIGHTS-DESIGN.md 4.2, acceptance S1.11, OVERLAY part).
//
// Three kinds of tests, none needs a browser:
//   * the pure rules (variants of at least 10 %, "usual" only at 50 % and 5 complete trips, the colour ramp scaled to the routes on screen, the lane geometry) and the
//     contract with the model builder (stats-model.js: the same constants, the same focus ids) and with the stylesheet (the route colours are the tokens of css/stats.css);
//   * the route set of real collector answers (tests/fixtures/stats/*.json through tests/helpers/fake-sim.js createFakeDetail; the roads are rebuilt from the paths of the fixture, so the
//     tests do not depend on the examples) and of a real run;
//   * the drawing against a recording stand-in for the canvas context: what is stroked, with which width, colour, dash and alpha, where the rings and badges sit, what a focused row dims,
//     that flows recede, that nothing is drawn when it must not be, and that a frame allocates nothing (the functions are scanned, the heap is measured).
// Pixels are checked by tests/e2e (the real canvas in Chromium).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph } from '../js/sim/graph.js';
import { LANE_OFFSET as SIM_LANE_OFFSET } from '../js/sim/traffic/geometry.js';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { emptyLayout } from '../js/model/defaults.js';
import { getTheme } from '../js/ui/theme.js';
import { Camera } from '../js/ui/camera.js';
import { Renderer } from '../js/ui/renderer.js';
import {
  CELL_RING_MIN_SHARE, DIM_ALPHA, FLOW_ALPHA, LANE_OFFSET, MAX_LOADED_PAIRS, MAX_OTHER_PAIRS, MAX_RINGS, MAX_VARIANTS_PER_PAIR, MIN_LEGS_FOR_USUAL, QUEUE_RING_MIN_SECONDS, RAMP_FALLBACK,
  CALM_SHARE, OTHER_ALPHA, RAMP_MAX, RAMP_MIN, RAMP_STOPS, RANK_BADGES, REFRESH_MS, ROUND_KEY, ROUTE_COLORS, USUAL_SHARE_CLAIMED, VARIANT_DRAWN_SHARE, buildRouteSet, canonicalFocus, drawRouteMarks, drawRoutes, drawnVariants,
  flowTheme, formatSeconds, jobsSim, modelBuilds, pairIdOf, pathLine, queueRate, queueTitle, rampColor, rampMaxOf, rampStep, routeChipText, routesFor, usualWording,
} from '../js/ui/render/routes.js';
import { createFakeDetail } from './helpers/fake-sim.js';
import { layoutFromAscii } from './helpers/ascii.js';

// ---- fixtures and stand-ins ------------------------------------------------------------------------------------------------------------------

const FIXTURES = {};
const fixture = (name) => (FIXTURES[name] ||= JSON.parse(readFileSync(new URL(`./fixtures/stats/${name}.json`, import.meta.url), 'utf8')));

/** The road graph of a fixture, rebuilt from its paths: every cell a path touches is a two-way road cell (so the tests do not depend on the examples). */
function graphOf(fx) {
  const { cols, rows, cellSize } = fx.graph;
  const layout = emptyLayout({ grid: { cols, rows, cellSize } });
  for (const nodes of Object.values(fx.paths)) for (const n of nodes) layout.roads[`${n % cols},${Math.floor(n / cols)}`] = { out: 15 };
  return buildGraph(layout);
}

/** A collector stand-in with vehicles that have a place on the plan. */
function detailOf(fx) {
  const det = createFakeDetail(fx);
  det.V.forEach((v, i) => Object.assign(v, { x: 10 + 2 * i, y: 12, heading: 0, prevX: 9.9 + 2 * i, prevY: 12, prevHeading: 0, visible: true, tv: { length: 1.2, width: 0.66 }, fleet: { id: v.fleetId } }));
  return det;
}

const vehicleIndex = (fx, name) => fx.vehicles.findIndex((v) => v.name === name);

/** A frame as the renderer keeps it, for the functions of the layer. */
function frameOf(sim, id, over = {}) {
  const { stats = { open: true, window: 'start', focus: null }, overlays = {}, zoom = 9, w = 1100, h = 700, now = 1000, mode = 'light', covered = 0, hand = 1, selIds = id === null ? [] : [id], selKind = 'vehicle' } = over;
  const theme = getTheme(mode);
  const fr = {
    theme, layout: null, scene: null, sim, view: { selection: { kind: selKind, ids: selIds }, stats, overlays }, overlays, zoom, dpr: 1, cs: 2, ox: 0, oy: 0, w, h, alpha: 1, now,
    selKind, selIds, hand, covered, pose: new Float64Array(3), size: { length: 1.2, width: 0.66 }, reducedMotion: true,
  };
  return fr;
}

/** A recording stand-in for the canvas context: every stroke, fill and text with the state it was made in. */
class Rec {
  constructor() {
    this.ops = [];
    this.path = [];
    this.dash = [];
    this.font = '';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
  }

  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push([x, y]); }
  lineTo(x, y) { this.path.push([x, y]); }
  arcTo(x1, y1, x2, y2) { this.path.push([x1, y1], [x2, y2]); }
  arc(x, y, r) { this.path.push({ arc: [x, y, r] }); }
  closePath() {}
  setLineDash(d) { this.dash = d; }
  setTransform() {}
  stroke() { this.ops.push({ op: 'stroke', width: this.lineWidth, style: this.strokeStyle, alpha: this.globalAlpha, dash: this.dash, path: this.path.slice() }); }
  fill() { this.ops.push({ op: 'fill', style: this.fillStyle, alpha: this.globalAlpha, path: this.path.slice() }); }
  fillRect(x, y, w, h) { this.ops.push({ op: 'rect', x, y, w, h, style: this.fillStyle, alpha: this.globalAlpha }); }
  fillText(text, x, y) { this.ops.push({ op: 'text', text: String(text), x, y, style: this.fillStyle, alpha: this.globalAlpha }); }
  strokeText() {}
  measureText(text) { return { width: String(text).length * 6 }; }
  clear() { this.ops.length = 0; }
  get strokes() { return this.ops.filter((o) => o.op === 'stroke'); }
  get texts() { return this.ops.filter((o) => o.op === 'text').map((o) => o.text); }
  /** the arcs (circles) drawn by stroke or fill: { x, y, r, op, style, width, dash, alpha } */
  get circles() {
    const out = [];
    for (const o of this.ops) for (const p of o.path || []) if (p && p.arc) out.push({ x: p.arc[0], y: p.arc[1], r: p.arc[2], op: o.op, style: o.style, width: o.width, dash: o.dash, alpha: o.alpha });
    return out;
  }
}

/** A context that counts and records nothing, for the allocation measurements. */
function nullContext() {
  const counts = { calls: 0 };
  const noop = () => { counts.calls++; };
  const ctx = {
    counts, font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, lineCap: '', lineJoin: '', textAlign: '', textBaseline: '', measureText: (t) => ({ width: String(t).length * 6 }),
  };
  for (const m of ['beginPath', 'moveTo', 'lineTo', 'arcTo', 'arc', 'closePath', 'setLineDash', 'setTransform', 'stroke', 'fill', 'fillRect', 'fillText', 'strokeText']) ctx[m] = noop;
  return ctx;
}

const rampOf = (mode) => Array.from({ length: 25 }, (_, k) => rampColor(k / 24, 1, mode));

// ---- the stylesheet, the model builder and the simulation agree --------------------------------------------------------------------------------

test('the colours of the layer are the tokens --route-* of css/stats.css, light and dark', () => {
  const css = readFileSync(new URL('../css/stats.css', import.meta.url), 'utf8');
  const block = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${selector} block found`);
    return css.slice(at, css.indexOf('}', at));
  };
  const token = (b, name) => (new RegExp(`--route-${name}:\\s*([^;]+);`).exec(b) || [])[1];
  const nums = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  for (const [mode, selector] of [['light', ':root'], ['dark', ":root[data-theme='dark']"]]) {
    const b = block(selector);
    const p = ROUTE_COLORS[mode];
    for (const name of ['calm', 'some', 'much', 'chevron']) assert.equal(token(b, name).trim().toLowerCase(), p[name], `${mode} ${name}`);
    assert.deepEqual(nums(token(b, 'halo')), nums(p.halo), `${mode} halo`);
  }
});

test('the lane offset is the one of the simulation (js/sim/traffic/geometry.js): the line runs where the vehicles drive', () => {
  assert.equal(LANE_OFFSET, SIM_LANE_OFFSET);
});

test('contract with the model builder: the same thresholds, the same wording, the same colour scale, the same focus ids', async (t) => {
  let model;
  try {
    model = await import('../js/ui/panels/stats-model.js');
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return t.skip('stats-model.js is not in the tree');
    throw err;
  }
  assert.equal(model.MIN_LEGS_FOR_USUAL, MIN_LEGS_FOR_USUAL);
  assert.equal(model.USUAL_SHARE_CLAIMED, USUAL_SHARE_CLAIMED);
  assert.equal(model.VARIANT_DRAWN_SHARE, VARIANT_DRAWN_SHARE);
  assert.equal(model.RAMP_MIN, RAMP_MIN);
  assert.equal(model.RAMP_MAX, RAMP_MAX);
  assert.equal(model.ROUND_FOCUS_ID, ROUND_KEY);
  for (let complete = 0; complete <= 8; complete++) {
    for (const variants of [1, 2, 4]) for (const share of [0.2, 0.49, 0.5, 0.51, 0.9, 1]) {
      const ours = usualWording({ complete, variants, share });
      const theirs = model.usualWording({ complete, variants, share });
      assert.equal(ours.usual, theirs.usual, `usual: ${complete} legs ${variants} ways ${share}`);
      assert.equal(ours.text.replace(/\s/g, ' '), theirs.text.replace(/\s/g, ' '), `words: ${complete} legs ${variants} ways ${share}`);
    }
  }
  const lists = [[{ id: 1, n: 9 }, { id: 2, n: 1 }], [{ id: 1, n: 10 }, { id: 2, n: 1 }], [{ id: 1, n: 5 }, { id: 2, n: 5 }, { id: 3, n: 1 }], [{ id: 1, n: 3 }], []];
  for (const list of lists) assert.deepEqual(drawnVariants(list).map((p) => p.id), model.drawnVariants(list).map((p) => p.id));
  for (const shares of [[], [0.01], [0, 0.04, 0.2], [0.12, 0.17, 0.5], [0.9], [0.15, 0.15, 0.15]]) assert.equal(rampMaxOf(shares), model.rampMaxOf(shares), JSON.stringify(shares));
  // a row of the dock names a route by routeFocusId(kind word, from id, to id); the layer recognises exactly that string
  for (const [word, from, to] of [['loaded', 's4', 's5'], ['empty', 's2', 's1'], ['depot', 's4', 's8']]) {
    assert.equal(model.routeFocusId(word, from, to), pairIdOf(word, from, to));
    assert.equal(canonicalFocus(model.routeFocusId(word, from, to)), pairIdOf(word, from, to));
    assert.deepEqual(model.parseFocusId(pairIdOf(word, from, to)), { kind: word, from, to });
  }
  assert.equal(canonicalFocus(model.ROUND_FOCUS_ID), ROUND_KEY);
});

test('contract with the model builder, end to end: the rows of the dock\'s trip list are the numbered routes of the plan, the legend is the key, the round is the round', async (t) => {
  let build; let helpers;
  try {
    ({ buildStatsModel: build } = await import('../js/ui/panels/stats-model.js'));
    helpers = await import('./helpers/stats-fixtures.js');
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return t.skip('the model builder is not in the tree');
    throw err;
  }
  for (const name of ['two-lines-agv1', 'warehouse-goods-in']) {
    const fx = fixture(name);
    const graph = graphOf(fx);
    const det = detailOf(fx);
    for (const kind of ['start', 'last30']) {
      for (let i = 0; i < fx.vehicles.length; i++) {
        const input = helpers.fixtureInput(fx, { kind: 'vehicle', ids: [fx.vehicles[i].id] }, { window: kind });
        const model = build(input);
        const trips = model && model.blocks && model.blocks.find((b) => b.type === 'trips');
        if (!trips) continue;
        const mine = buildRouteSet(det, graph, i, kind, 1);
        const label = `${name} ${kind} ${fx.vehicles[i].name}`;
        trips.rows.forEach((row, k) => {
          const route = mine.routes.find((r) => r.rank === k + 1 && r.usual);
          assert.ok(route, `${label}: row ${k + 1} is drawn`);
          assert.equal(route.pairId, row.focusId, `${label}: row ${k + 1} names the route the plan numbers ${k + 1}`);
          assert.equal(canonicalFocus(row.focusId), row.focusId, `${label}: the layer reads the id as it is`);
        });
        assert.equal(Math.min(trips.rows.length, 3), Math.min(mine.loadedPairs, 3), `${label}: as many numbered routes as rows`);
        if (trips.rows.length > 0) {
          assert.equal(trips.legend.max, mine.rampMax, `${label}: the legend of the dock and the key of the plan state the same scale`);
          assert.equal(trips.legend.text, `time lost waiting: none → ${Math.round(mine.rampMax * 100)} %+`);
          assert.ok(mine.key.scale === trips.legend.text, `${label}: word for word`);
        }
        assert.equal(Boolean(trips.round), Boolean(mine.round), `${label}: a round in the dock exactly when the plan has one`);
        if (trips.round) assert.equal(trips.round.focusId, ROUND_KEY);
      }
    }
  }
});

// ---- the pure rules ------------------------------------------------------------------------------------------------------------------------------

test('variants: the usual way always, every other with at least 10 % of the drawable trips, at most four', () => {
  assert.equal(VARIANT_DRAWN_SHARE, 0.1);
  const ids = (list) => drawnVariants(list).map((p) => p.id);
  assert.deepEqual(ids([{ id: 7, n: 90 }, { id: 8, n: 10 }]), [7, 8], '10 of 100 is exactly 10 %: drawn');
  assert.deepEqual(ids([{ id: 7, n: 91 }, { id: 8, n: 9 }]), [7], '9 of 100 is below: not drawn');
  assert.deepEqual(ids([{ id: 7, n: 1 }]), [7], 'a single way is drawn however few trips');
  assert.deepEqual(ids([{ id: 7, n: 1 }, { id: 8, n: 1 }]), [7, 8], 'two ways of one trip each: 50 % each');
  assert.deepEqual(ids([]), [], 'nothing');
  assert.deepEqual(ids(null), [], 'junk');
  const many = Array.from({ length: 9 }, (_, i) => ({ id: i, n: 10 }));
  assert.equal(drawnVariants(many).length, MAX_VARIANTS_PER_PAIR, 'nine ways of 11 % each: four are drawn');
});

test('"usual" is claimed only from 5 complete trips and, with several ways, only at half of the drawn trips; else "N ways"; below 5 nothing', () => {
  assert.equal(MIN_LEGS_FOR_USUAL, 5);
  assert.equal(USUAL_SHARE_CLAIMED, 0.5);
  assert.deepEqual(usualWording({ complete: 4, variants: 1, share: 1 }), { usual: false, text: 'too few trips for a usual route' });
  assert.equal(usualWording({ complete: 5, variants: 1, share: 1 }).usual, true);
  assert.equal(usualWording({ complete: 5, variants: 1, share: 1 }).text, 'always the same way');
  assert.equal(usualWording({ complete: 20, variants: 3, share: 0.5 }).usual, true, 'exactly half');
  assert.equal(usualWording({ complete: 20, variants: 3, share: 0.4999 }).usual, false);
  assert.equal(usualWording({ complete: 20, variants: 3, share: 0.41 }).text, '3 ways, the most used 41 %');
  assert.equal(usualWording({ complete: NaN, variants: 1, share: 1 }).usual, false, 'junk claims nothing');
  // the chip on the plan says the same
  const pair = (over) => ({ trips: 16, complete: 16, meanTime: 62, variants: 1, pathShare: 1, ...over });
  assert.equal(routeChipText(pair()), '16 trips · 62 s · usual route');
  assert.equal(routeChipText(pair({ variants: 3, pathShare: 0.56 })), '16 trips · 62 s · usual route (56 %)');
  assert.equal(routeChipText(pair({ variants: 3, pathShare: 0.41 })), '16 trips · 62 s · 3 ways');
  assert.equal(routeChipText(pair({ trips: 3, complete: 3 })), '3 trips · 62 s · few trips so far');
  assert.equal(routeChipText(pair({ trips: 1, complete: 0, meanTime: null })), '1 trip · few trips so far');
  assert.equal(routeChipText(pair({ meanTime: 95 })), '16 trips · 1.6 min · usual route');
  assert.equal(formatSeconds(NaN), '');
  assert.equal(formatSeconds(-1), '');
  assert.equal(formatSeconds(0), '0 s');
  assert.equal(formatSeconds(125), '2.1 min');
  assert.equal(formatSeconds(1800), '30 min');
});

test('the colour ramp: red end = the 90th percentile of the shares drawn, rounded up to 5 %, between 8 % and 30 %; blue at none, red at the end, three clear colours', () => {
  assert.equal(RAMP_FALLBACK, 0.25);
  assert.equal(rampMaxOf([]), 0.25, 'nothing to scale to: the old fixed scale');
  assert.equal(rampMaxOf([0, 0.001, 0.02]), RAMP_MIN, 'a calm plant is still scaled: 8 %');
  assert.equal(rampMaxOf([0.01, 0.03, 0.06, 0.17]), 0.2, 'p90 0.17 rounds up to 20 %');
  assert.equal(rampMaxOf([0.15, 0.15, 0.15]), 0.15, 'exact multiples of 5 % stay');
  assert.equal(rampMaxOf([0.5, 0.9, 1]), RAMP_MAX, 'a plant that loses half of every trip: 30 %');
  assert.equal(rampMaxOf([NaN, Infinity, 'x', undefined, 0.1]), 0.1, 'junk is ignored');
  assert.equal(rampMaxOf([...Array(10).fill(0.1), 0.9]), 0.1, 'one outlier in eleven does not move the 90th percentile');
  assert.equal(rampMaxOf([...Array(9).fill(0.1), 0.9]), RAMP_MAX, 'but one in ten is the 90th percentile');
  for (const mode of ['light', 'dark']) {
    const p = ROUTE_COLORS[mode];
    assert.equal(rampColor(0, 0.2, mode), p.calm, `${mode}: no waiting is blue`);
    assert.equal(rampColor(0.2, 0.2, mode), p.much, `${mode}: the red end is red`);
    assert.equal(rampColor(5, 0.2, mode), p.much, `${mode}: beyond the end stays red`);
    assert.equal(rampColor(0.2 * 0.48, 0.2, mode), p.some, `${mode}: the middle is amber`);
    const ramp = rampOf(mode);
    assert.equal(new Set(ramp).size, 14, 'the holds repeat a colour (blue 4 steps, amber 6, red 4 of 25): blue, amber and red keep their ground');
    assert.equal(rampStep(NaN, 0.2), 0);
    assert.equal(rampStep(0.1, 0), 0, 'a zero scale colours nothing');
  }
  assert.deepEqual([...RAMP_STOPS], [0, 0.14, 0.34, 0.62, 0.84, 1]);
});

test('queue figures: a rate only from 10 minutes measured; a share is at most 100 %', () => {
  assert.equal(queueRate(129.2, 7560), '1.0 min/h');
  assert.equal(queueRate(600, 3600), '10 min/h');
  assert.equal(queueRate(40, 300), '40 s in total', 'under 10 minutes measured nothing is extrapolated to an hour');
  assert.equal(queueRate(95, 599), '1.6 min in total');
});

// ---- the lane geometry ---------------------------------------------------------------------------------------------------------------------------

test('pathLine: along the lane the vehicles drive, corner points only, the lanes meet at a corner and step over where a one-way road meets a two-way one', () => {
  const layout = layoutFromAscii(['++++>>>>', '++++....', '++++....'], { cellSize: 2 });
  const graph = buildGraph(layout);
  const id = (x, y) => y * graph.cols + x;
  const off = LANE_OFFSET * 2;
  const near = (a, b, msg) => { assert.equal(a.length, b.length, `${msg}: ${a.length} numbers`); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${msg}[${i}] ${v} vs ${b[i]}`)); };
  // east on the two-way part, onto the one-way part: one straight line per lane, a step at the join
  near(pathLine(graph, [0, 1, 2, 3, 4, 5, 6, 7].map((x) => id(x, 0))), [1, 1 + off, 7, 1 + off, 7, 1, 15, 1], 'east');
  // west on the two-way part: the other side of the road (right of the travel is north)
  near(pathLine(graph, [3, 2, 1, 0].map((x) => id(x, 0))), [7, 1 - off, 1, 1 - off], 'west');
  // left-hand traffic: the other lane
  near(pathLine(graph, [0, 1, 2, 3].map((x) => id(x, 0)), -1), [1, 1 - off, 7, 1 - off], 'left-hand');
  // a corner: east along y = 0 then south along x = 2: the two lane lines meet at one point
  near(pathLine(graph, [id(0, 0), id(1, 0), id(2, 0), id(2, 1), id(2, 2)]), [1, 1 + off, 5 - off, 1 + off, 5 - off, 5], 'corner');
  assert.equal(pathLine(graph, [id(0, 0)]).length, 0, 'one cell is no line');
  assert.equal(pathLine(graph, []).length, 0);
  assert.equal(pathLine(null, [1, 2]).length, 0);
  assert.ok(pathLine(graph, [id(0, 0), id(1, 0), id(0, 0)]).every(Number.isFinite), 'a turn-round at a dead end');
});

// ---- the route set of collector answers --------------------------------------------------------------------------------------------------------------

const finiteDeep = (value, where = '$') => {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${where} is a number: ${value}`);
  else if (value instanceof Float64Array) value.forEach((v, i) => assert.ok(Number.isFinite(v), `${where}[${i}]`));
  else if (Array.isArray(value)) value.forEach((v, i) => finiteDeep(v, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) finiteDeep(v, `${where}.${k}`);
};

test('route set of Two lines (the fixture): the busiest loaded pairs ranked by trips, the usual way of every other drive, rings from the queue and the cell that held it up', () => {
  const fx = fixture('two-lines-agv1');
  const graph = graphOf(fx);
  const det = detailOf(fx);
  const i = vehicleIndex(fx, 'Forklifts 1');
  const m = buildRouteSet(det, graph, i, 'start', 1);
  finiteDeep(m, 'model');
  const w = det.windowOf('start');
  const all = det.routesOf(i, w, [1, 0, 2, 3]).filter((g) => g.pathId >= 0);
  const loaded = all.filter((g) => g.kind === 1).slice(0, MAX_LOADED_PAIRS);
  const others = all.filter((g) => g.kind !== 1).slice(0, MAX_OTHER_PAIRS);
  const idOf = (g) => pairIdOf(['empty', 'loaded', 'depot', 'depot'][g.kind], fx.stations[g.from]?.id ?? '', fx.stations[g.to]?.id ?? '');
  const drawn = m.routes.filter((r) => !r.roundOnly);
  assert.equal(m.drawn, drawn.length);
  assert.equal(drawn.filter((r) => r.loaded).length, loaded.reduce((n, g) => n + drawnVariants(g.pathIds).length, 0), 'every loaded pair draws the ways that carry 10 % of its drawn trips');
  assert.equal(drawn.filter((r) => !r.loaded).length, others.length, 'a dashed drive is drawn one way (the usual one) per pair');
  assert.ok(drawn.every((r) => r.dash === (r.kind === 1 ? 0 : r.kind === 0 ? 1 : 2)), 'dashes: solid loaded, dashed empty, dotted to a depot');
  loaded.forEach((g, k) => {
    const rs = drawn.filter((r) => r.pairId === idOf(g));
    assert.ok(rs.length >= 1, `pair ${idOf(g)} is drawn`);
    assert.equal(rs[0].rank, k + 1, 'ranked by trips, the numbers of the dock list');
    assert.equal(rs.filter((r) => r.usual).length, 1, 'one usual way per pair');
    assert.equal(rs.find((r) => r.usual).pathId, g.pathId, 'the usual way is the collector\'s usual path');
    assert.equal(rs.find((r) => r.usual).label, routeChipText(g), 'the chip says what the rule allows');
  });
  assert.ok(drawn.filter((r) => !r.loaded).every((r) => r.rank === 0 && r.label === null));
  assert.ok(m.rampMax >= RAMP_MIN && m.rampMax <= RAMP_MAX);
  assert.equal(m.rampMax, rampMaxOf(drawn.filter((r) => r.loaded && r.rank <= 3).map((r) => r.waitShare)), 'the scale follows the loaded ways of the three listed pairs');
  assert.ok(drawn.every((r) => r.color >= 0 && r.color <= 24 && r.waitShare >= 0 && r.waitShare <= 1));
  // the order of drawing: dashed drives first, then loaded ways from the least to the most used: the busiest lies on top
  const kinds = m.routes.filter((r) => !r.roundOnly).map((r) => (r.loaded ? 1 : 0));
  assert.deepEqual(kinds, [...kinds].sort((a, b) => a - b), 'dashed first');
  const loadedN = m.routes.filter((r) => r.loaded && !r.roundOnly).map((r) => r.n);
  assert.deepEqual(loadedN, [...loadedN].sort((a, b) => a - b), 'the busiest last');
  // the rings: the queue for a dock at the dock cell of the collector, and the cell that held it up most (since the start only)
  const queues = det.queuesOf(i, w).filter((q) => q.seconds >= QUEUE_RING_MIN_SECONDS && q.dockNode >= 0);
  assert.ok(m.rings.length >= 1 && m.rings.length <= MAX_RINGS);
  for (const q of queues.slice(0, 1)) {
    const ring = m.rings.find((r) => r.node === q.dockNode);
    assert.ok(ring, 'a ring at the dock cell where the queue is');
    assert.equal(ring.text, `Queue for ${fx.stations[q.station].name}'s dock: ${queueRate(q.seconds, w.seconds)}`);
    assert.equal(ring.x, graph.x(q.dockNode));
    assert.equal(ring.y, graph.y(q.dockNode));
  }
  const hot = det.hotspots(i);
  const cellRings = m.rings.filter((r) => r.kind === 'traffic');
  for (const r of cellRings) {
    const c = hot.cells.find((x) => x.node === r.node);
    assert.ok(c && c.seconds / hot.total >= CELL_RING_MIN_SHARE, 'a cell ring only for a cell with at least 20 % of the vehicle\'s waiting');
    assert.match(r.text, /^\d+ % of its waiting in traffic$/);
    assert.ok(Number(/^(\d+)/.exec(r.text)[1]) <= 100, 'a share is never above 100 %');
  }
  assert.ok(m.bounds && m.bounds.w > 0 && m.bounds.h > 0, 'the box of what is drawn, for "Show route on plan"');
  assert.equal(m.name, 'Forklifts 1');
  assert.ok(m.key.title.startsWith('Forklifts 1') && m.key.scale.includes(`${Math.round(m.rampMax * 100)} %+`), 'the key states the scale');
});

test('Last 30 min: only queue rings (a cell table has no 30-minute version), the window of the collector', () => {
  const fx = fixture('two-lines-agv1');
  const graph = graphOf(fx);
  const det = detailOf(fx);
  const m = buildRouteSet(det, graph, vehicleIndex(fx, 'Forklifts 1'), 'last30', 1);
  assert.equal(m.window, 'last30');
  assert.ok(m.rings.every((r) => r.kind === 'queue'));
  assert.equal(m.seconds, det.windowOf('last30').seconds);
  const start = buildRouteSet(det, graph, vehicleIndex(fx, 'Forklifts 1'), 'start', 1);
  assert.ok(start.rings.some((r) => r.kind === 'traffic'), 'since start has the cell ring');
});

test('Warehouse first day: a pair of docks driven in several ways draws each way that carries 10 %, each with its own width; "usual" only when the rule allows', () => {
  const fx = fixture('warehouse-goods-in');
  const graph = graphOf(fx);
  const det = detailOf(fx);
  const i = vehicleIndex(fx, 'Forklifts 1');
  const m = buildRouteSet(det, graph, i, 'start', 1);
  finiteDeep(m, 'model');
  const w = det.windowOf('start');
  const multi = det.routesOf(i, w, [1]).filter((g) => g.pathId >= 0 && drawnVariants(g.pathIds).length > 1);
  assert.ok(multi.length >= 1, 'the fixture has a pair with several ways');
  for (const g of multi) {
    const ways = m.routes.filter((r) => r.pairKey === `1:${g.from}:${g.to}`);
    assert.deepEqual(ways.map((r) => r.pathId).sort((a, b) => a - b), drawnVariants(g.pathIds).map((p) => p.id).sort((a, b) => a - b));
    assert.deepEqual(ways.map((r) => r.n).sort((a, b) => a - b), drawnVariants(g.pathIds).map((p) => p.n).sort((a, b) => a - b), 'the trips of each way, not of the pair');
    const total = g.pathIds.reduce((n, p) => n + p.n, 0);
    for (const r of ways) assert.ok(Math.abs(r.share - r.n / total) < 1e-12, 'the share of a way among the drawn trips of the pair');
    const usual = ways.find((r) => r.usual);
    const u = usualWording({ complete: g.complete, variants: g.variants, share: g.pathShare });
    assert.equal(/usual route/.test(usual.label), u.usual, 'the chip claims a usual route exactly when the rule does');
    if (!u.usual && g.complete >= MIN_LEGS_FOR_USUAL) assert.match(usual.label, new RegExp(`${g.variants} ways$`));
  }
});

test('the usual round: its loaded routes and the empty drive between them are marked, and drawn on request even when not among the busiest', () => {
  const fx = fixture('two-lines-agv1');
  const graph = graphOf(fx);
  const det = detailOf(fx);
  const i = vehicleIndex(fx, 'Forklifts 1');
  const w = det.windowOf('start');
  const m = buildRouteSet(det, graph, i, 'start', 1);
  const round = det.roundOf(i, w, 2);
  assert.ok(round, 'the fixture has a round');
  assert.equal(m.round.count, round.count);
  // this round is the same trip twice (Final assembly -> Dispatch, then again): one route carries both numbers (mask 3), the drive between them is the empty one
  assert.deepEqual(round.jobs[0], round.jobs[1]);
  const members = m.routes.filter((r) => r.round !== 0);
  assert.deepEqual(members.map((r) => r.round).sort(), [3, 4]);
  assert.equal(members.find((r) => r.round === 3).pairKey, `1:${round.jobs[0].from}:${round.jobs[0].to}`);
  assert.equal(members.find((r) => r.round === 4).pairKey, `0:${round.jobs[0].to}:${round.jobs[1].from}`);
  assert.ok(members.find((r) => r.round === 4).roundOnly, 'the empty drive between them is not among the busiest: it exists for the round only');
  assert.equal(m.round.routes, 2);
  assert.ok(m.roundBounds && m.roundBounds.w > 0);
  // two different trips: job 1, job 2 and the drive between them (made up from two pairs of the fixture, with the empty drive that exists between them)
  const loaded = det.routesOf(i, w, [1]).filter((g) => g.pathId >= 0);
  const [a, b] = [loaded.find((g) => g.from === 0), loaded.find((g) => g.from === 6)];
  assert.ok(a && b);
  det.roundOf = () => ({ jobs: [{ from: a.from, to: a.to }, { from: b.from, to: b.to }], count: 3, of: 7, share: 3 / 7 });
  const two = buildRouteSet(det, graph, i, 'start', 1);
  const marks = two.routes.filter((r) => r.round !== 0).map((r) => [r.pairKey, r.round]);
  assert.deepEqual(marks.filter(([, bit]) => bit < 4).sort((x, y) => x[1] - y[1]), [[`1:${a.from}:${a.to}`, 1], [`1:${b.from}:${b.to}`, 2]], 'job 1 and job 2 are their own routes');
  assert.equal(two.round.jobs.length, 2);
  const none = { ...det, roundOf: () => null };
  assert.equal(buildRouteSet(none, graph, i, 'start', 1).round, null, 'a vehicle without a round');
});

test('the numbers of the design, as the design states them (not read back from the module)', () => {
  assert.deepEqual([VARIANT_DRAWN_SHARE, USUAL_SHARE_CLAIMED, MIN_LEGS_FOR_USUAL], [0.1, 0.5, 5], 'variants from 10 %, "usual" from 50 % and 5 complete trips');
  assert.deepEqual([DIM_ALPHA, FLOW_ALPHA], [0.28, 0.35], 'the others dim to 28 %, flows recede to 35 %');
  assert.deepEqual([RAMP_MIN, RAMP_MAX], [0.08, 0.3], 'the ramp ends between 8 % and 30 %');
  assert.equal(REFRESH_MS, 500, 'the model is rebuilt at 2 Hz at most');
  assert.deepEqual([MAX_LOADED_PAIRS, MAX_OTHER_PAIRS, RANK_BADGES], [6, 4, 3], 'at most 6 loaded and 4 empty pairs, badges 1 to 3');
  assert.equal(MAX_RINGS, 3);
  assert.equal(QUEUE_RING_MIN_SECONDS, 60);
});

/** A collector whose answers are replaced: the fixture's, with `over` on top (the stand-in's methods close over the fixture, so a prototype chain is enough). */
const altered = (det, over) => Object.assign(Object.create(det), over);

test('rings: a queue from a minute, a cell with at least 20 % of the vehicle\'s waiting (and 30 s of 60 s booked), at most three, the longest first, one per cell', () => {
  const fx = fixture('two-lines-agv1');
  const graph = graphOf(fx);
  const i = vehicleIndex(fx, 'Forklifts 1');
  const base = detailOf(fx);
  const nodes = [...new Set(Object.values(fx.paths).flat())];
  const none = { cells: [], total: 0, folded: 0 };
  const ringsOf = (queues, hot) => buildRouteSet(altered(base, { queuesOf: () => queues, hotspots: () => hot }), graph, i, 'start', 1).rings;
  const q = (station, seconds, dockNode) => ({ station, seconds, legs: 4, dockNode });
  assert.equal(ringsOf([q(3, 59.9, nodes[0])], none).length, 0, 'a minute of queue is the least that is marked');
  assert.equal(ringsOf([q(3, 60, nodes[0])], none).length, 1);
  assert.equal(ringsOf([q(3, 600, -1)], none).length, 0, 'no dock cell known: no ring');
  assert.equal(ringsOf([q(65535, 600, nodes[0])], none)[0].text, 'Queue for a dock: 5.9 min/h'.replace('5.9', (600 * 60 / base.windowOf('start').seconds).toFixed(1)), 'a place that is no station');
  assert.equal(queueTitle("Press line"), "Queue for Press line's dock");
  const hot = (cells, total) => ({ cells: cells.map(([node, seconds]) => ({ node, seconds })), total, folded: 0 });
  assert.equal(ringsOf([], hot([[nodes[1], 38]], 190)).length, 1, '20 % exactly');
  assert.equal(ringsOf([], hot([[nodes[1], 37.9]], 190)).length, 0, 'below 20 %');
  assert.equal(ringsOf([], hot([[nodes[1], 30]], 100)).length, 1, '30 s exactly');
  assert.equal(ringsOf([], hot([[nodes[1], 29.9]], 100)).length, 0, 'below 30 s');
  assert.equal(ringsOf([], hot([[nodes[1], 59]], 59)).length, 0, 'under a minute of booked waiting: too little to name a place');
  assert.equal(ringsOf([], hot([[nodes[1], 150]], 100))[0].text, '100 % of its waiting in traffic', 'never above 100 %');
  assert.equal(ringsOf([q(3, 70, nodes[2])], hot([[nodes[2], 90]], 200)).length, 1, 'one ring per cell: the queue and the traffic of the same dock cell are one ring');
  const many = ringsOf([q(3, 100, nodes[0]), q(4, 500, nodes[1]), q(5, 300, nodes[2]), q(6, 200, nodes[3]), q(2, 80, nodes[4])], hot([[nodes[5], 400]], 800));
  assert.equal(many.length, 3, 'at most three rings');
  assert.deepEqual(many.map((r) => r.seconds), [500, 400, 300], 'the longest first');
});

test('at most 6 loaded pairs with their ways and 4 other pairs are drawn; the badges are 1 to 3; every pair has one usual way', () => {
  const fx = fixture('two-lines-agv1');
  const graph = graphOf(fx);
  const i = vehicleIndex(fx, 'Forklifts 1');
  const base = detailOf(fx);
  const w = base.windowOf('start');
  const real = base.routesOf(i, w, [0, 1, 2, 3]);
  const proto = real.find((g) => g.kind === 1);
  const protoEmpty = real.find((g) => g.kind === 0);
  const extra = [];
  for (let k = 0; k < 9; k++) extra.push({ ...proto, from: 100 + k, to: 200 + k, trips: 30 - k, pathIds: proto.pathIds.map((p) => ({ ...p })) });
  for (let k = 0; k < 7; k++) extra.push({ ...protoEmpty, from: 300 + k, to: 400 + k, trips: 5 + k, pathIds: protoEmpty.pathIds.map((p) => ({ ...p })) });
  const det = altered(base, { routesOf: (v, win, kinds) => [...real, ...extra].filter((g) => kinds.includes(g.kind)).sort((a, b) => b.trips - a.trips) });
  const m = buildRouteSet(det, graph, i, 'start', 1);
  const loaded = m.routes.filter((r) => r.loaded && !r.roundOnly);
  assert.equal(new Set(loaded.map((r) => r.pairKey)).size, 6, 'six loaded pairs');
  assert.equal(new Set(m.routes.filter((r) => !r.loaded && !r.roundOnly).map((r) => r.pairKey)).size, 4, 'four other pairs');
  assert.deepEqual([...new Set(loaded.map((r) => r.rank))].sort(), [1, 2, 3, 4, 5, 6]);
  const fr = frameOf({ detail: det, graph, vehicles: det.V }, fx.vehicles[i].id);
  const rec = new Rec();
  drawRouteMarks(rec, fr, routesFor(fr));
  assert.deepEqual(rec.ops.filter((o) => o.op === 'text' && /^\d$/.test(o.text)).map((o) => o.text).sort(), ['1', '2', '3'], 'numbers 1 to 3 only');
});

test('a dashed drive is drawn one way per pair even when it has several (Warehouse first day), a loaded pair all the ways that carry 10 %', () => {
  const fx = fixture('warehouse-goods-in');
  const det = detailOf(fx);
  const i = vehicleIndex(fx, 'Forklifts 1');
  const m = buildRouteSet(det, graphOf(fx), i, 'start', 1);
  const others = det.routesOf(i, det.windowOf('start'), [0, 2, 3]).filter((g) => g.pathId >= 0);
  assert.ok(others.some((g) => g.pathIds.length > 1), 'the fixture has an empty drive with several ways');
  for (const g of others.slice(0, 4)) assert.equal(m.routes.filter((r) => r.pairKey === `${g.kind}:${g.from}:${g.to}`).length, 1, `${g.kind}:${g.from}>${g.to}: one way`);
});

test('every fixture, both windows, every vehicle: a route set with only finite numbers, drawn ways that exist, no throw (a plant with relocated and zero-length legs, a plant that just started)', () => {
  for (const name of ['two-lines-agv1', 'warehouse-goods-in', 'dockplant-44-hostile', 'two-lines-early']) {
    const fx = fixture(name);
    const graph = graphOf(fx);
    const det = detailOf(fx);
    for (let i = 0; i < fx.vehicles.length; i++) {
      for (const kind of ['start', 'last30']) {
        const m = buildRouteSet(det, graph, i, kind, i % 2 ? -1 : 1);
        finiteDeep(m.routes.map((r) => [r.n, r.share, r.waitShare, r.color, r.rank, r.geom.pts]), `${name} ${i} ${kind}`);
        finiteDeep([m.rampMax, m.seconds, m.bounds, m.rings.map((r) => [r.x, r.y, r.seconds])], `${name} ${i} ${kind} extra`);
        for (const r of m.routes) assert.ok(r.geom.n >= 2 && r.pathId >= 0, 'only drawable ways: a relocated, zero-length or overflowed leg is a trip but not a way');
        assert.ok(m.routes.length <= 40, 'a bounded number of ways');
        assert.ok(m.rings.length <= MAX_RINGS);
      }
    }
  }
  // the plant that just started: what is drawn claims no usual route (a chip below 5 trips says so), and a vehicle without any trip has nothing to scale to
  const early = fixture('two-lines-early');
  const eDet = detailOf(early);
  for (let i = 0; i < early.vehicles.length; i++) {
    const m = buildRouteSet(eDet, graphOf(early), i, 'start', 1);
    for (const r of m.routes.filter((x) => x.label !== null)) assert.match(r.label, /few trips so far$/, 'below 5 complete trips nothing is claimed');
    if (m.routes.every((x) => !x.loaded)) assert.equal(m.rampMax, RAMP_FALLBACK);
  }
});

test('a vehicle the collector does not know, a bad window name, a missing graph: an empty set or an error that the frame survives', () => {
  const fx = fixture('two-lines-agv1');
  const sim = { detail: detailOf(fx), graph: graphOf(fx) };
  const fr = frameOf(sim, 'nobody#9');
  assert.equal(routesFor(fr).drawn, 0, 'unknown vehicle: nothing');
  const fr2 = frameOf({ detail: sim.detail, graph: null }, fx.vehicles[0].id);
  assert.equal(routesFor(fr2), null, 'no road graph: no layer');
  const fr3 = frameOf({ detail: { failed: true }, graph: sim.graph }, fx.vehicles[0].id);
  assert.equal(routesFor(fr3), null, 'a collector that failed shows nothing');
  const broken = { ...sim.detail, routesOf() { throw new Error('boom'); } };
  const fr4 = frameOf({ detail: broken, graph: sim.graph }, fx.vehicles[0].id);
  const err = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try {
    assert.equal(routesFor(fr4).drawn, 0, 'an exception while building shows an empty layer, not a broken frame');
    routesFor(fr4);
  } finally {
    console.error = err;
  }
  assert.equal(seen.length, 1, 'and is said once');
});

// ---- when the layer shows ----------------------------------------------------------------------------------------------------------------------------

function twoLines() {
  const fx = fixture('two-lines-agv1');
  const graph = graphOf(fx);
  const det = detailOf(fx);
  const i = vehicleIndex(fx, 'Forklifts 1');
  return { fx, graph, det, i, id: fx.vehicles[i].id, sim: { detail: det, graph, vehicles: det.V, settings: { handedness: 'right' }, time: fx.time } };
}

test('the layer shows only for one selected vehicle, with the overlay switch on, the dock open (compact too), and a collector', () => {
  const { sim, id } = twoLines();
  assert.ok(routesFor(frameOf(sim, id)).drawn > 0, 'the base case shows');
  assert.equal(routesFor(frameOf(sim, null)), null, 'nothing selected');
  assert.equal(routesFor(frameOf(sim, id, { selKind: 'station', selIds: ['s1'] })), null, 'a station is selected');
  assert.equal(routesFor(frameOf(sim, id, { selKind: 'fleet', selIds: ['v1'] })), null, 'a fleet is selected');
  assert.equal(routesFor(frameOf(sim, id, { selIds: [id, 'v1#2'] })), null, 'two vehicles: the union of their routes is a later step');
  assert.equal(routesFor(frameOf(sim, id, { overlays: { routes: false } })), null, 'the Routes switch is off');
  assert.ok(routesFor(frameOf(sim, id, { overlays: { routes: true } })).drawn > 0, 'on');
  assert.equal(routesFor(frameOf(sim, id, { stats: null })), null, 'the dock has not published: closed');
  assert.equal(routesFor(frameOf(sim, id, { stats: { open: false, window: 'start', focus: null } })), null, 'the dock is closed (dismissed with X)');
  assert.equal(routesFor(frameOf({ ...sim, detail: null }, id)), null, 'collecting is switched off');
  assert.equal(routesFor(frameOf(null, id)), null, 'no simulation');
});

test('when nothing is shown the layer lets go of the collector and the model (a warm restart must not keep the old simulation alive through the renderer)', () => {
  const { sim, id } = twoLines();
  const fr = frameOf(sim, id);
  assert.ok(routesFor(fr).drawn > 0);
  assert.ok(fr.routes.det === sim.detail && fr.routes.model.drawn > 0, 'while it shows, it holds them');
  fr.view.stats = { open: false };
  assert.equal(routesFor(fr), null);
  assert.equal(fr.routes.det, null, 'the dock closed: the collector is let go');
  assert.equal(fr.routes.model.drawn, 0, 'and the model');
  fr.view.stats = { open: true, window: 'start', focus: null };
  assert.ok(routesFor(fr).drawn > 0, 'and it comes back when the dock opens again');
  fr.selKind = 'station';
  assert.equal(routesFor(fr), null);
  assert.equal(fr.routes.det, null, 'another kind of item selected: let go');
});

test('the model is built when the vehicle, the window or the collector changes, and at most twice a second while the version moves', () => {
  const { sim, id, det } = twoLines();
  const fr = frameOf(sim, id, { now: 1000 });
  for (let k = 0; k < 100; k++) routesFor(fr);
  assert.equal(modelBuilds(fr), 1, 'a hundred frames, one build');
  det.version += 5;
  fr.now = 1000 + REFRESH_MS - 1;
  routesFor(fr);
  assert.equal(modelBuilds(fr), 1, 'the collector moved, but less than half a second ago');
  fr.now = 1000 + REFRESH_MS;
  routesFor(fr);
  assert.equal(modelBuilds(fr), 2, 'and half a second later it is built again');
  routesFor(fr);
  assert.equal(modelBuilds(fr), 2, 'the version it read is the new one');
  fr.now = 0;
  det.version += 1;
  routesFor(fr);
  assert.equal(modelBuilds(fr), 3, 'a clock that went backwards does not freeze the layer');
  fr.view.stats = { open: true, window: 'last30', focus: null };
  routesFor(fr);
  assert.equal(modelBuilds(fr), 4, 'another window: at once');
  fr.view.stats = { open: true, window: 'last30', focus: { id: 'round', pinned: true } };
  routesFor(fr);
  assert.equal(modelBuilds(fr), 4, 'a focus changes nothing in the model');
  fr.selIds = ['v1#2'];
  routesFor(fr);
  assert.equal(modelBuilds(fr), 5, 'another vehicle: at once');
  fr.sim = { ...sim, detail: detailOf(fixture('two-lines-agv1')) };
  routesFor(fr);
  assert.equal(modelBuilds(fr), 6, 'a new collector (a restart of the simulation): at once');
  fr.hand = -1;
  routesFor(fr);
  assert.equal(modelBuilds(fr), 7, 'left-hand traffic moves the lane');
});

// ---- drawing ---------------------------------------------------------------------------------------------------------------------------------------------

/** The strokes of the lines (not the halos) of the drawn routes, found by their path. */
function lineStrokesOf(rec, fr, model) {
  const map = new Map();
  for (const r of model.routes) {
    const g = r.geom;
    const first = [fr.ox + g.pts[0] * fr.zoom, fr.oy + g.pts[1] * fr.zoom];
    const hit = rec.strokes.filter((s) => s.path.length === g.n && Array.isArray(s.path[0]) && Math.abs(s.path[0][0] - first[0]) < 1e-6 && Math.abs(s.path[0][1] - first[1]) < 1e-6);
    // a halo and then the line: the line is the narrower of the two
    map.set(r, { halo: hit.find((s) => s.style === ROUTE_COLORS.light.halo), line: hit.find((s) => s.style !== ROUTE_COLORS.light.halo) });
  }
  return map;
}

test('pass 1: a halo and a line per drawn way; the width follows the trips (2.4 to 10 px), the colour the share of the trip lost to waiting on the scaled ramp, dashes for empty drives and drives to a depot', () => {
  const { sim, id } = twoLines();
  const fr = frameOf(sim, id);
  const model = routesFor(fr);
  const rec = new Rec();
  drawRoutes(rec, fr, model);
  const found = lineStrokesOf(rec, fr, model);
  const ramp = rampOf('light');
  const maxTrips = Math.max(...model.routes.filter((r) => r.loaded).map((r) => r.n));
  for (const r of model.routes) {
    if (r.roundOnly) { assert.equal(found.get(r).line, undefined, 'the routes of the round are not drawn unless that row is focused'); continue; }
    const { halo, line } = found.get(r);
    assert.ok(halo && line, `halo and line of ${r.pairId}`);
    assert.ok(halo.width > line.width, 'the halo is wider than the line');
    assert.equal(line.style, rampColor(r.waitShare, model.rampMax, 'light'), 'the colour is the ramp at the share of the trip lost to waiting');
    assert.ok(ramp.includes(line.style));
    const cellPx = fr.cs * fr.zoom;
    if (r.loaded) {
      const expected = Math.min(10, Math.max(2.4, cellPx * (0.2 + 0.32 * Math.sqrt(r.n / maxTrips))));
      assert.ok(Math.abs(line.width - expected) < 1e-9, `width of ${r.n} trips: ${line.width} vs ${expected}`);
      assert.deepEqual(line.dash, [], 'a loaded route is solid');
    } else {
      assert.equal(line.width, 3, 'a dashed drive has one width');
      assert.ok(line.dash.length === 2 && line.dash[0] > 0, 'dashed');
    }
    assert.equal(line.alpha, !r.loaded ? OTHER_ALPHA : r.usual ? 1 : 0.8, 'a less used way is a little lighter, a dashed drive lighter still');
    if (!r.loaded) assert.equal(halo.width, line.width + 2, 'a dashed drive has a narrower halo (2 px) than a loaded trip (4 px)');
    else assert.equal(halo.width, line.width + 4);
  }
  const loaded = model.routes.filter((r) => r.loaded);
  const widest = loaded.reduce((a, b) => (b.n > a.n ? b : a));
  assert.ok(loaded.every((r) => found.get(r).line.width <= found.get(widest).line.width + 1e-9), 'the way with the most trips is the widest');
  assert.ok(rec.ops.some((o) => o.op === 'fill' && o.style === ROUTE_COLORS.light.chevron), 'chevrons along the loaded routes');
  assert.equal(rec.circles.filter((c) => c.op === 'fill' && c.r === 4.5).length, loaded.filter((r) => r.usual).length, 'a hollow dot where each loaded route starts');
  // the widths of ways with different trips differ (each way has its own width)
  const widths = new Set(loaded.map((r) => found.get(r).line.width.toFixed(3)));
  assert.ok(widths.size > 1 || loaded.every((r) => r.n === loaded[0].n), 'ways of different trips have different widths');
  assert.equal([1, 0.8, OTHER_ALPHA].includes(rec.strokes.at(-1).alpha), true);
});

test('the widths of the several ways of a pair of docks differ with their trips (Warehouse first day), and a dashed way is not scaled', () => {
  const fx = fixture('warehouse-goods-in');
  const det = detailOf(fx);
  const i = vehicleIndex(fx, 'Forklifts 1');
  const sim = { detail: det, graph: graphOf(fx), vehicles: det.V };
  const fr = frameOf(sim, fx.vehicles[i].id, { zoom: 8, w: 1100, h: 800 });
  const model = routesFor(fr);
  const rec = new Rec();
  drawRoutes(rec, fr, model);
  const found = lineStrokesOf(rec, fr, model);
  const ways = model.routes.filter((r) => r.loaded && r.pairId === model.routes.find((x) => x.rank === 1).pairId);
  assert.ok(ways.length >= 3, 'the first pair has several ways');
  const sorted = [...ways].sort((a, b) => a.n - b.n);
  for (let k = 1; k < sorted.length; k++) {
    const a = found.get(sorted[k - 1]).line.width;
    const b = found.get(sorted[k]).line.width;
    assert.ok(sorted[k].n === sorted[k - 1].n ? Math.abs(a - b) < 1e-9 : b > a - 1e-9, 'more trips, wider (or equal at the clamp)');
  }
  assert.ok(new Set(ways.map((r) => found.get(r).line.width.toFixed(2))).size > 1, 'not every way has the same width');
});

test('the halo is 4 px wider than the line, 6 px with a heat map under the routes', () => {
  const { sim, id } = twoLines();
  const widths = (overlays) => {
    const fr = frameOf(sim, id, { overlays });
    const model = routesFor(fr);
    const rec = new Rec();
    drawRoutes(rec, fr, model);
    const found = lineStrokesOf(rec, fr, model);
    const r = model.routes.find((x) => x.loaded && !x.roundOnly);
    return found.get(r).halo.width - found.get(r).line.width;
  };
  assert.ok(Math.abs(widths({}) - 4) < 1e-9);
  assert.ok(Math.abs(widths({ heat: 'traffic' }) - 6) < 1e-9);
  assert.ok(Math.abs(widths({ heat: 'waiting' }) - 6) < 1e-9);
  assert.ok(Math.abs(widths({ heat: 'off' }) - 4) < 1e-9);
});

test('the ring on the vehicle pulses unless the planner asked for reduced motion', () => {
  const { sim, id } = twoLines();
  const alphaAt = (now, reduced) => {
    const fr = frameOf(sim, id, { now });
    fr.reducedMotion = reduced;
    const rec = new Rec();
    drawRouteMarks(rec, fr, routesFor(fr));
    return rec.circles.find((c) => c.op === 'stroke' && c.style === fr.theme.selection && c.width === 3).alpha;
  };
  assert.equal(alphaAt(0, true), 1);
  assert.equal(alphaAt(777, true), 1, 'reduced motion: standing still');
  const seen = new Set([0, 150, 300, 450, 600].map((t) => alphaAt(t, false).toFixed(3)));
  assert.ok(seen.size > 2, 'it breathes');
  for (const a of seen) assert.ok(Number(a) >= 0.6 - 1e-9 && Number(a) <= 1 + 1e-9, 'but never fades out');
});

test('on a phone the lines are 1.6 to 4.8 px, on a desktop 2.4 to 10', () => {
  const { sim, id } = twoLines();
  const widthsAt = (w, h, zoom) => {
    const fr = frameOf(sim, id, { w, h, zoom });
    const model = routesFor(fr);
    const rec = new Rec();
    drawRoutes(rec, fr, model);
    const found = lineStrokesOf(rec, fr, model);
    return model.routes.filter((x) => x.loaded && !x.roundOnly).map((r) => found.get(r).line.width);
  };
  const phone = widthsAt(390, 500, 3);
  assert.ok(phone.length >= 2);
  for (const w of phone) assert.ok(w >= 1.6 - 1e-9 && w <= 4.8 + 1e-9, `${w}`);
  const desktop = widthsAt(1100, 700, 3);
  for (const w of desktop) assert.ok(w >= 2.4 - 1e-9 && w <= 10 + 1e-9, `${w}`);
  assert.ok(Math.max(...desktop) > Math.max(...phone), 'a desktop line is wider than a phone line');
});

test('with a vehicle selected the layer draws nothing off screen', () => {
  const { sim, id } = twoLines();
  const fr = frameOf(sim, id, { zoom: 9 });
  fr.ox = -5000;
  fr.oy = -5000;
  const rec = new Rec();
  drawRoutes(rec, fr, routesFor(fr));
  assert.equal(rec.strokes.length, 0, 'a route that is off the canvas costs no stroke');
});

test('hover or focus on a row dims every other route to 28 %; the usual round shows its routes numbered 1 and 2; a focus that names nothing dims nothing; unpinning restores', () => {
  assert.equal(DIM_ALPHA, 0.28);
  const { sim, id, fx } = twoLines();
  const fr = frameOf(sim, id);
  const model = routesFor(fr);
  const pairs = [...new Set(model.routes.filter((r) => r.loaded && !r.roundOnly).map((r) => r.pairId))];
  assert.ok(pairs.length >= 2);
  const alphasOf = (focus) => {
    fr.view.stats = { open: true, window: 'start', focus };
    const rec = new Rec();
    drawRoutes(rec, fr, routesFor(fr));
    const f = lineStrokesOf(rec, fr, model);
    return new Map(model.routes.filter((r) => !r.roundOnly).map((r) => [r, f.get(r).line.alpha]));
  };
  const rest = alphasOf(null);
  assert.ok([...rest.values()].every((a) => a >= OTHER_ALPHA), 'no focus: nothing is dimmed');
  const on = alphasOf({ id: pairs[0], pinned: false });
  for (const [r, a] of on) {
    if (r.pairId === pairs[0]) assert.ok(a >= OTHER_ALPHA, `${r.pairId} is the focused row: strong`);
    else assert.equal(a, DIM_ALPHA, `${r.pairId}: dimmed to 28 %`);
  }
  const pinned = alphasOf({ id: pairs[0], pinned: true });
  assert.deepEqual([...pinned.values()], [...on.values()], 'pinning looks the same as hovering (the shell keeps it until it is unpinned)');
  const dashed = model.routes.find((r) => !r.loaded && !r.roundOnly);
  const empty = alphasOf({ id: dashed.pairId, pinned: false });
  assert.ok(empty.get(dashed) >= OTHER_ALPHA && [...empty].filter(([r]) => r !== dashed).every(([, a]) => a === DIM_ALPHA), 'an empty drive can be focused too');
  assert.deepEqual([...alphasOf({ id: 'loaded:nowhere>nothing', pinned: false }).values()], [...rest.values()], 'a focus that names nothing that is drawn dims nothing');
  assert.deepEqual([...alphasOf({ id: 42, pinned: false }).values()], [...rest.values()], 'junk');
  assert.deepEqual([...alphasOf(null).values()], [...rest.values()], 'unpinned: everything is back');
  assert.deepEqual([...alphasOf({ id: pairIdOf('loaded', fx.stations[1].id, fx.stations[1].id), pinned: false }).values()], [...rest.values()]);
  // the round: its routes are drawn even when they are not among the busiest, and the rest is dimmed
  const roundOnly = model.routes.filter((r) => r.roundOnly);
  assert.ok(roundOnly.length >= 1);
  fr.view.stats = { open: true, window: 'start', focus: { id: ROUND_KEY, pinned: true } };
  const rec = new Rec();
  drawRoutes(rec, fr, routesFor(fr));
  const f = lineStrokesOf(rec, fr, model);
  for (const r of model.routes) {
    assert.ok(f.get(r).line, `${r.pairId} is drawn while the round is focused`);
    assert.equal(f.get(r).line.alpha >= OTHER_ALPHA, r.round !== 0, `${r.pairId}: ${r.round !== 0 ? 'in the round: strong' : 'not in the round: dimmed'}`);
  }
  rec.clear();
  drawRouteMarks(rec, fr, routesFor(fr));
  const numbers = rec.ops.filter((o) => o.op === 'text' && /^[12]$/.test(o.text));
  assert.deepEqual(numbers.map((o) => o.text).sort(), ['1', '2'], 'the two jobs of the round are numbered 1 and 2 (side by side when they are the same trip)');
  assert.ok(Math.abs(numbers[0].x - numbers[1].x) === 22 && numbers[0].y === numbers[1].y, 'two badges next to each other at the end of the same route');
});

test('pass 2: badges 1 to 3 at the end of the busiest loaded routes, the chip of the busiest, rings at the dock cell where it queues, the ring and the name of the vehicle, the key', () => {
  const { sim, id, graph, fx } = twoLines();
  const fr = frameOf(sim, id);
  const model = routesFor(fr);
  const rec = new Rec();
  drawRouteMarks(rec, fr, model);
  const badges = rec.ops.filter((o) => o.op === 'text' && /^[1-3]$/.test(o.text));
  assert.deepEqual(badges.map((o) => o.text).sort(), ['1', '2'].slice(0, Math.min(3, model.loadedPairs)).map(String).sort(), 'one badge per ranked pair (up to 3)');
  for (const b of badges) {
    const r = model.routes.find((x) => x.rank === Number(b.text) && x.usual);
    const end = [fr.ox + r.geom.pts[2 * r.geom.n - 2] * fr.zoom, fr.oy + r.geom.pts[2 * r.geom.n - 1] * fr.zoom];
    assert.ok(Math.abs(b.x - end[0]) < 1e-6 && Math.abs(b.y - (end[1] + 0.5)) < 1e-6, 'the badge sits at the end of the usual way');
  }
  const top = model.routes.find((r) => r.rank === 1 && r.usual);
  assert.ok(rec.texts.includes(top.label), 'the chip of the busiest route');
  assert.equal(rec.texts.filter((t) => / trips? · /.test(t)).length, 1, 'only the busiest has one while nothing is focused');
  for (const ring of model.rings) {
    const c = rec.circles.find((x) => x.op === 'stroke' && x.dash.length === 2 && Math.abs(x.x - fr.zoom * graph.x(ring.node)) < 1e-6 && Math.abs(x.y - fr.zoom * graph.y(ring.node)) < 1e-6);
    assert.ok(c, `a dashed ring at the cell ${ring.node}`);
    assert.equal(c.style, ROUTE_COLORS.light.much);
    assert.ok(c.r >= 11 && c.r <= 20, 'sized by the seconds');
    assert.ok(rec.texts.includes(ring.text), `and its figure: ${ring.text}`);
  }
  const biggest = [...model.rings].sort((a, b) => b.seconds - a.seconds)[0];
  const radius = (ring) => rec.circles.find((x) => x.op === 'stroke' && x.dash.length === 2 && Math.abs(x.x - fr.zoom * graph.x(ring.node)) < 1e-6).r;
  assert.ok(model.rings.every((ring) => radius(ring) <= radius(biggest) + 1e-9), 'the ring of the longest queue is the biggest');
  assert.ok(rec.texts.includes(fx.vehicles[vehicleIndex(fx, 'Forklifts 1')].name), 'the name chip of the vehicle');
  assert.ok(rec.circles.some((c) => c.op === 'stroke' && c.style === fr.theme.selection && c.width === 3), 'the ring on the vehicle in the selection colour');
  assert.ok(rec.texts.some((t) => t.startsWith('time lost waiting: none → ')), 'the key states the scale');
  assert.ok(rec.texts.includes('Width = trips'));
});

test('the chip of the busiest route stays on the canvas, however near the edge its route is', () => {
  const { sim, id } = twoLines();
  const probe = frameOf(sim, id);
  const top = routesFor(probe).routes.find((r) => r.rank === 1 && r.usual);
  for (const where of [3, 60, probe.w - 3, probe.w - 60]) {
    const fr = frameOf(sim, id);
    fr.ox = where - top.geom.lx * fr.zoom;
    const rec = new Rec();
    drawRouteMarks(rec, fr, routesFor(fr));
    const chip = rec.ops.find((o) => o.op === 'fill' && o.style === fr.theme.flowChip && rec.ops.some((t) => t.op === 'text' && t.text === top.label && Math.abs(t.x - (o.path.reduce((a, p) => a + p[0], 0) / o.path.length)) < 40));
    assert.ok(chip, `the chip is drawn with its middle at ${where}`);
    const xs = chip.path.map((p) => p[0]);
    assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= fr.w, `${where}: the chip spans ${Math.min(...xs).toFixed(0)} to ${Math.max(...xs).toFixed(0)} of ${fr.w}`);
  }
});

test('a focused row shows its own chip and hides the chip of the busiest; the others are dimmed (badges, rings)', () => {
  const { sim, id } = twoLines();
  const fr = frameOf(sim, id);
  const model = routesFor(fr);
  const second = model.routes.find((r) => r.rank === 2 && r.usual);
  fr.view.stats = { open: true, window: 'start', focus: { id: second.pairId, pinned: false } };
  const rec = new Rec();
  drawRouteMarks(rec, fr, routesFor(fr));
  assert.ok(rec.texts.includes(second.label), 'the focused pair has its chip');
  assert.ok(!rec.texts.includes(model.routes.find((r) => r.rank === 1 && r.usual).label), 'and the chip of the busiest is not in the way');
  const badge1 = rec.ops.find((o) => o.op === 'text' && o.text === '1');
  const badge2 = rec.ops.find((o) => o.op === 'text' && o.text === '2');
  assert.equal(badge1.alpha, DIM_ALPHA);
  assert.equal(badge2.alpha, 1);
});

test('the ring on the selected vehicle is drawn even when no routes are shown (the dock closed, the switch off, no collector); the name chip only with the routes', () => {
  const { sim, id, fx } = twoLines();
  const name = fx.vehicles[vehicleIndex(fx, 'Forklifts 1')].name;
  for (const [what, fr] of [
    ['dock closed', frameOf(sim, id, { stats: { open: false } })],
    ['switch off', frameOf(sim, id, { overlays: { routes: false } })],
    ['no collector', frameOf({ ...sim, detail: null }, id)],
  ]) {
    const rec = new Rec();
    drawRouteMarks(rec, fr, routesFor(fr));
    assert.ok(rec.circles.some((c) => c.op === 'stroke' && c.style === fr.theme.selection), `${what}: the ring`);
    assert.ok(!rec.texts.includes(name), `${what}: no name chip`);
    assert.ok(!rec.texts.includes('Width = trips'), `${what}: no key`);
  }
  const fr = frameOf(sim, id);
  const rec = new Rec();
  drawRouteMarks(rec, fr, routesFor(fr));
  assert.ok(rec.texts.includes(name), 'with the routes: the name');
  // a vehicle parked inside a depot is not on the plan: no ring
  sim.vehicles[vehicleIndex(fx, 'Forklifts 1')].visible = false;
  const rec2 = new Rec();
  drawRouteMarks(rec2, frameOf(sim, id), routesFor(frameOf(sim, id)));
  assert.ok(!rec2.circles.some((c) => c.style === fr.theme.selection), 'parked in a depot: no ring');
  sim.vehicles[vehicleIndex(fx, 'Forklifts 1')].visible = true;
  // several selected vehicles: a ring on each, no routes
  const multi = frameOf(sim, id, { selIds: [id, fx.vehicles[1].id] });
  const rec3 = new Rec();
  drawRouteMarks(rec3, multi, routesFor(multi));
  assert.equal(rec3.circles.filter((c) => c.op === 'stroke' && c.style === multi.theme.selection).length, 2);
});

test('the key sits above the dock at the right (beside the zoom buttons), is stated in the words of the dock, and is left out on a narrow canvas', () => {
  const { sim, id } = twoLines();
  const fr = frameOf(sim, id, { covered: 200, w: 1000, h: 700 });
  const rec = new Rec();
  drawRouteMarks(rec, fr, routesFor(fr));
  const title = rec.ops.find((o) => o.op === 'text' && /: usual trips$/.test(o.text));
  assert.ok(title, 'the key has a title');
  assert.ok(title.y < 700 - 200, 'above the dock');
  assert.ok(title.x > 500, 'at the right');
  assert.ok(rec.texts.some((t) => /^dashed = empty or to depot/.test(t)), 'the dashes and the ring are explained');
  const narrow = frameOf(sim, id, { covered: 200, w: 480, h: 700 });
  const rec2 = new Rec();
  drawRouteMarks(rec2, narrow, routesFor(narrow));
  assert.ok(!rec2.texts.some((t) => /: usual trips$/.test(t)), 'no key on a phone');
});

test('flows recede to 35 % while the layer shows: a copy of the theme, made once, the frozen palette untouched', () => {
  assert.equal(FLOW_ALPHA, 0.35);
  const { sim, id } = twoLines();
  const fr = frameOf(sim, id);
  const model = routesFor(fr);
  const t = flowTheme(fr, model);
  assert.notEqual(t, fr.theme);
  assert.equal(flowTheme(fr, model), t, 'cached');
  assert.equal(flowTheme(fr, null), fr.theme, 'no routes: the theme as it is');
  assert.equal(flowTheme(fr, { drawn: 0 }), fr.theme, 'a vehicle without a drawn route does not make the flows recede');
  const alpha = (c) => Number(/,([\d.]+)\)$/.exec(c)[1]);
  assert.equal(alpha(t.flow), 0.35, 'the colour of the arrows');
  assert.ok(Math.abs(alpha(t.flowHalo) - 0.85 * 0.35) < 0.002, 'the halo');
  assert.ok(Math.abs(alpha(t.flowChip) - 0.95 * 0.35) < 0.002, 'the chips');
  assert.equal(t.flowSelected.startsWith('rgba('), true);
  assert.equal(t.font, fr.theme.font, 'everything else is the theme\'s');
  assert.equal(fr.theme.flow, '#3f5f93', 'the shared theme is not changed');
  assert.ok(Object.isFrozen(fr.theme));
  assert.equal(flowTheme(frameOf(sim, id, { mode: 'dark' }), model).mode, 'dark');
});

test('the jobs overlay yields: a stand-in simulation with only the selected vehicle while the layer shows, the simulation itself otherwise', () => {
  const { sim, id, fx } = twoLines();
  const fr = frameOf(sim, id);
  const model = routesFor(fr);
  const view = jobsSim(fr, model);
  assert.notEqual(view, sim);
  assert.deepEqual(view.vehicles.map((v) => v.id), [id], 'only the selected vehicle keeps its line');
  assert.equal(view.graph, sim.graph, 'everything else is the simulation\'s');
  assert.equal(view.time, sim.time);
  assert.equal(sim.vehicles.length, fx.vehicles.length, 'the simulation is not changed');
  assert.equal(jobsSim(fr, model), view, 'made once');
  assert.equal(jobsSim(fr, null), sim);
  assert.equal(jobsSim(fr, { drawn: 0 }), sim);
  assert.equal(jobsSim({ ...fr, sim: null }, model), null);
  const gone = frameOf(sim, 'nobody#1');
  assert.deepEqual(jobsSim(gone, { drawn: 1 }).vehicles, [], 'a vehicle that is not there: no line');
});

test('a robust layer: junk in the model inputs, in the view and in the frame never makes a pass throw', () => {
  const { sim, id } = twoLines();
  const rec = new Rec();
  const junkStats = [undefined, null, {}, { open: true }, { open: true, window: 7, focus: 5 }, { open: true, window: 'start', focus: { id: {} } }, { open: true, window: 'start', focus: { id: 'loaded:>' } }, { open: 'yes' }];
  for (const stats of junkStats) {
    for (const over of [{}, { zoom: 1e-9 }, { zoom: 1e9 }, { w: 0, h: 0 }, { w: NaN, h: NaN }, { hand: 0 }]) {
      const fr = frameOf(sim, id, { stats, ...over });
      assert.doesNotThrow(() => { const m = routesFor(fr); drawRoutes(rec, fr, m || { routes: [], drawn: 0 }); drawRouteMarks(rec, fr, m); });
    }
  }
  const odd = frameOf(sim, id);
  odd.selIds = [null, undefined, 3, {}];
  odd.selKind = 'vehicle';
  assert.doesNotThrow(() => { drawRouteMarks(rec, odd, routesFor(odd)); });
});

// ---- no allocation per frame ---------------------------------------------------------------------------------------------------------------------------

test('the per-frame functions of the layer contain no allocating constructs', () => {
  const src = readFileSync(new URL('../js/ui/render/routes.js', import.meta.url), 'utf8');
  const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const code = strip(src);
  const functionSource = (name) => {
    const start = code.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `function ${name} not found`);
    const open = code.indexOf('{', code.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  };
  const forbidden = [
    [/`/, 'template string'], [/=>/, 'arrow function'], [/\bfunction\s*\(/, 'function expression'], [/\bnew\s/, 'new'], [/\.\.\./, 'spread'],
    [/(?:=|\(|,|return|:)\s*\[/, 'array literal'], [/(?:=|\(|,|return)\s*\{/, 'object literal'],
    [/\.(?:map|filter|forEach|slice|concat|reduce|find|includes|push|toFixed|join|sort)\(/, 'allocating method'], [/Object\.assign|\bMath\.hypot\(.*,.*,/, 'allocating helper'],
  ];
  const perFrame = ['routesFor', 'isFocused', 'activeFocus', 'widthOf', 'maxTripsOf', 'onScreen', 'tracePath', 'drawChevrons', 'drawRoutes', 'collides', 'take', 'textWidth', 'drawBadge', 'drawLabel',
    'drawRing', 'findVehicle', 'drawVehicleMarks', 'drawKey', 'drawRouteMarks', 'flowTheme', 'jobsSim'];
  for (const name of perFrame) {
    const body = functionSource(name);
    for (const [re, what] of forbidden) {
      // the first build of a cache (a theme copy, a stand-in simulation, a state) allocates once: those branches are the only allowed ones
      if ((name === 'flowTheme' || name === 'jobsSim' || name === 'routesFor') && ['object literal', 'array literal', 'new'].includes(what)) continue;
      assert.ok(!re.test(body), `${name}() contains a ${what}`);
    }
  }
});

test('thousands of frames with a selected vehicle leave no growth behind (both passes, a focus coming and going, a moving camera)', async () => {
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const { sim, id } = twoLines();
  const fr = frameOf(sim, id, { covered: 160 });
  const ctx = nullContext();
  const stats = [{ open: true, window: 'start', focus: null }, { open: true, window: 'start', focus: { id: 'round', pinned: true } }, { open: true, window: 'start', focus: { id: 'loaded:s1>s4', pinned: false } }];
  const frame = (k) => {
    fr.view.stats = stats[k % 3];
    fr.now = 1000 + k * 16.7;
    fr.alpha = (k % 10) / 10;
    fr.ox = -(k % 40);
    fr.zoom = 9 + (k % 5) * 0.1;
    const m = routesFor(fr);
    flowTheme(fr, m);
    drawRoutes(ctx, fr, m);
    drawRouteMarks(ctx, fr, m);
    jobsSim(fr, m);
  };
  for (let k = 0; k < 300; k++) frame(k);
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let k = 0; k < 6000; k++) frame(k);
  gc();
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(grown < 1.5e6, `heap grew by ${(grown / 1e6).toFixed(2)} MB over 6000 frames`);
  assert.ok(ctx.counts.calls > 6000 * 10, 'and the frames did draw');
  assert.equal(modelBuilds(fr), 1, 'the model was built once: a focus, the camera and the clock do not build it');
});

test('building a model is cheap (it runs at most twice a second while the collector moves)', () => {
  const { sim, id, det } = twoLines();
  const fr = frameOf(sim, id);
  routesFor(fr);
  const t0 = performance.now();
  for (let k = 0; k < 200; k++) {
    det.version++;
    fr.now += REFRESH_MS;
    routesFor(fr);
  }
  const each = (performance.now() - t0) / 200;
  assert.equal(modelBuilds(fr), 201);
  assert.ok(each < 3, `a build took ${each.toFixed(2)} ms on average (the budget is a few ms twice a second)`);
});

// ---- the renderer ----------------------------------------------------------------------------------------------------------------------------------

class RenderCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.clientWidth = w;
    this.clientHeight = h;
    this.rec = new Proxy(new Rec(), { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  }

  getContext() { return this.rec; }
  toDataURL() { return 'data:image/png;base64,FAKE'; }
}

function renderer(sim, { layout, w = 1100, h = 700 } = {}) {
  const canvas = new RenderCanvas(w, h);
  const made = [];
  const camera = new Camera({ x: 56, y: 33, zoom: 9 });
  const r = new Renderer(canvas, { camera, theme: 'light', dpr: 1, now: () => 1000, reducedMotion: true, createCanvas: (cw, ch) => { const c = new RenderCanvas(cw, ch); made.push(c); return c; } });
  r.layout = layout || layoutFromAscii(['AAA....BBB', '++++++++++'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] });
  r.sim = sim;
  return { r, canvas, made, camera };
}

test('the renderer draws the layer for a selected vehicle with the dock open, and not otherwise; hit-testing is unchanged', () => {
  const { sim, id, fx } = twoLines();
  const { r, canvas, camera } = renderer(sim);
  r.view.selection = { kind: 'vehicle', ids: [id] };
  r.view.stats = { open: true, window: 'start', focus: null };
  const colors = new Set(rampOf('light'));
  const routeStrokes = (rec) => rec.strokes.filter((s) => colors.has(s.style) && s.path.length > 1);
  canvas.rec.clear();
  r.render(1);
  assert.ok(routeStrokes(canvas.rec).length >= 6, 'the routes are stroked');
  assert.ok(canvas.rec.texts.includes('Forklifts 1'), 'the name of the vehicle');
  const hits = [[100, 100], [400, 300], ...sim.vehicles.slice(0, 3).map((v) => camera.worldToScreen(v.x, v.y))].map(([x, y]) => JSON.stringify(r.hitTest(x, y)));
  r.view.stats = null;
  canvas.rec.clear();
  r.render(1);
  assert.equal(routeStrokes(canvas.rec).length, 0, 'the dock is closed: no routes');
  assert.ok(canvas.rec.circles.some((c) => c.style === r.theme.selection), 'the ring on the selected vehicle stays');
  assert.deepEqual([[100, 100], [400, 300], ...sim.vehicles.slice(0, 3).map((v) => camera.worldToScreen(v.x, v.y))].map(([x, y]) => JSON.stringify(r.hitTest(x, y))), hits, 'what is under a point does not depend on the layer');
  r.view.stats = { open: true, window: 'start', focus: null };
  r.view.overlays.routes = false;
  canvas.rec.clear();
  r.render(1);
  assert.equal(routeStrokes(canvas.rec).length, 0, 'the Routes switch is off');
  r.view.overlays.routes = true;
  r.view.selection = { kind: 'station', ids: ['A'] };
  canvas.rec.clear();
  r.render(1);
  assert.equal(routeStrokes(canvas.rec).length, 0, 'a station is selected');
  assert.ok(fx);
});

test('the renderer: flows recede while the layer shows, and the export of the plan never carries the layer', () => {
  const { sim, id } = twoLines();
  const { r, canvas, made } = renderer(sim);
  const flowColor = getTheme('light').flow;
  const flowStrokes = (rec) => rec.strokes.filter((s) => s.style === flowColor || /^rgba\(63,95,147,/.test(String(s.style)));
  r.view.selection = { kind: 'vehicle', ids: [id] };
  r.view.stats = { open: true, window: 'start', focus: null };
  canvas.rec.clear();
  r.render(1);
  const receded = flowStrokes(canvas.rec);
  assert.ok(receded.length > 0, 'the flow arrow is drawn');
  assert.ok(receded.every((s) => /^rgba\(63,95,147,0\.35\)$/.test(String(s.style))), 'at 35 %');
  r.view.stats = null;
  canvas.rec.clear();
  r.render(1);
  assert.ok(flowStrokes(canvas.rec).every((s) => s.style === flowColor), 'the layer is off: the arrow is as it was');
  assert.ok(flowStrokes(canvas.rec).length > 0);
  r.view.stats = { open: true, window: 'start', focus: null };
  r.toDataURL({ scale: 0.2 });
  const exported = made.at(-1).rec;
  const colors = new Set(rampOf('light'));
  assert.equal(exported.strokes.filter((s) => colors.has(s.style) && s.path.length > 1).length, 0, 'an export has no layer');
  assert.ok(!exported.texts.includes('Forklifts 1'));
});

test('the renderer: while the layer shows, the jobs overlay draws only the selected vehicle', () => {
  const { sim, id, det } = twoLines();
  // every vehicle drives to a station: the job lines of the overlay would be one per vehicle
  const layout = layoutFromAscii(['AAA....BBB', '++++++++++'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] });
  sim.vehicles.forEach((v) => Object.assign(v, { state: 'toDrop', order: { from: 'A', to: 'B' }, route: null, fleet: { id: 'v1' }, load: [] }));
  sim.logistics = { docks: null };
  const dashed = (rec) => rec.strokes.filter((s) => s.dash.length > 0 && s.width < 5 && ![...rampOf('light')].includes(s.style) && s.style !== ROUTE_COLORS.light.much);
  const { r, canvas } = renderer(sim, { layout });
  r.view.selection = { kind: 'vehicle', ids: [id] };
  r.view.stats = null;
  canvas.rec.clear();
  r.render(1);
  const all = dashed(canvas.rec).length;
  r.view.stats = { open: true, window: 'start', focus: null };
  canvas.rec.clear();
  r.render(1);
  const only = dashed(canvas.rec).filter((s) => s.dash.length === 2 && s.dash[0] >= 4 && s.dash[0] <= 9 && s.dash[1] > 0 && s.dash[1] <= 6 && s.style !== ROUTE_COLORS.light.much).length;
  assert.ok(all > only, `fewer job lines with the layer on: ${all} against ${only}`);
  assert.ok(det);
});

test('the renderer: a vehicle layer on a simulation whose plan moved (simShift) draws in the simulation\'s frame and does not throw', () => {
  const { sim, id } = twoLines();
  const { r, canvas } = renderer(sim);
  r.simShift = { dx: 3, dy: -2 };
  r.view.selection = { kind: 'vehicle', ids: [id] };
  r.view.stats = { open: true, window: 'start', focus: null };
  canvas.rec.clear();
  assert.doesNotThrow(() => r.render(1));
  const moved = canvas.rec.strokes.filter((s) => s.path.length > 1 && s.style === ROUTE_COLORS.light.halo).map((s) => s.path[0]);
  r.simShift = null;
  canvas.rec.clear();
  r.render(1);
  const still = canvas.rec.strokes.filter((s) => s.path.length > 1 && s.style === ROUTE_COLORS.light.halo).map((s) => s.path[0]);
  assert.equal(moved.length, still.length);
  assert.ok(moved.some((p, k) => Math.abs(p[0] - still[k][0] - 3 * 2 * 9) < 1e-6 && Math.abs(p[1] - still[k][1] + 2 * 2 * 9) < 1e-6), 'moved by the shift in cells (2 m each, 9 px per metre)');
});

test('the dock height (--dock-covered on the stage) lifts the key above the dock', () => {
  const { sim, id } = twoLines();
  const { r, canvas } = renderer(sim);
  canvas.parentElement = { style: { getPropertyValue: (name) => (name === '--dock-covered' ? '180px' : '') } };
  r.view.selection = { kind: 'vehicle', ids: [id] };
  r.view.stats = { open: true, window: 'start', focus: null };
  for (let k = 0; k < 9; k++) r.render(1); // the property is read every few frames
  canvas.rec.clear();
  r.render(1);
  const title = canvas.rec.ops.find((o) => o.op === 'text' && /: usual trips$/.test(o.text));
  assert.ok(title && title.y < 700 - 180, `the key is above the dock: ${title && title.y}`);
});

// ---- a real run ----------------------------------------------------------------------------------------------------------------------------------------

test('a real run of Two lines with the collector: the layer builds from live answers, follows the collector\'s version, and every drawn way lies on the roads of the plan', () => {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  layout.settings.warmup = 300;
  const sim = new Simulation(layout);
  const det = sim.enableDetail();
  assert.ok(det);
  sim.advance(1500);
  const vehicle = sim.vehicles.find((v) => det.routesOf(det.vehicleIndex(v.id), det.windowOf('start'), [1]).some((g) => g.pathId >= 0)) || sim.vehicles[0];
  const fr = frameOf(sim, vehicle.id, { now: 1000 });
  fr.sim = sim;
  const m = routesFor(fr);
  assert.ok(m.drawn >= 1, 'a vehicle that delivered has routes');
  for (const r of m.routes) {
    const pts = r.geom.pts;
    for (let k = 0; k < r.geom.n; k++) {
      const col = Math.floor(pts[2 * k] / sim.graph.cellSize);
      const row = Math.floor(pts[2 * k + 1] / sim.graph.cellSize);
      assert.ok(layout.roads[`${col},${row}`], `the corner ${k} of way ${r.pathId} is on a road cell (${col}, ${row})`);
    }
    // the polyline runs from the first to the last cell of the logged path
    const nodes = det.pool.nodes(r.pathId);
    const first = [(nodes[0] % sim.graph.cols + 0.5) * sim.graph.cellSize, (Math.floor(nodes[0] / sim.graph.cols) + 0.5) * sim.graph.cellSize];
    assert.ok(Math.hypot(pts[0] - first[0], pts[1] - first[1]) <= LANE_OFFSET * sim.graph.cellSize * 1.5 + 1e-9, 'it starts within a lane offset of the first cell');
  }
  const built = modelBuilds(fr);
  sim.advance(60);
  fr.now += REFRESH_MS + 1;
  routesFor(fr);
  assert.equal(modelBuilds(fr), built + 1, 'the collector moved on: the layer follows');
  const rec = new Rec();
  drawRoutes(rec, fr, routesFor(fr));
  drawRouteMarks(rec, fr, routesFor(fr));
  assert.ok(rec.strokes.length > 10);
});

// ---- the review fixes of the overlay (the notes of tests/e2e/entity-stats-review.mjs, STAT-ENG-REV-6) -------------------------------------------------

test('a trip that loses less than 3 % of its time to waiting is calm (blue) on every scale: no grey-brown blend for "waits 0 s"', () => {
  assert.equal(CALM_SHARE, 0.03);
  for (const mode of ['light', 'dark']) {
    for (const max of [RAMP_MIN, 0.15, RAMP_MAX]) {
      assert.equal(rampColor(0, max, mode), ROUTE_COLORS[mode].calm);
      assert.equal(rampColor(0.02, max, mode), ROUTE_COLORS[mode].calm, `${mode}: 2 % on a ${max} scale is calm`);
      assert.equal(rampColor(0.0299, max, mode), ROUTE_COLORS[mode].calm);
    }
  }
  assert.equal(rampStep(0.02, RAMP_MIN), 0, '2 % of an 8 % scale used to be step 6 of 24, the blend');
  assert.ok(rampStep(0.03, RAMP_MIN) > 0, 'from 3 % on the ramp starts');
  assert.equal(rampStep(RAMP_MIN, RAMP_MIN), 24, 'the red end is still the red end');
  assert.equal(rampStep(-0.5, 0.2), 0);
});

test('the dashed drives (empty, to a depot) are drawn quieter than the loaded trips: lighter and with a narrower halo', () => {
  const { sim, id } = twoLines();
  const fr = frameOf(sim, id);
  const model = routesFor(fr);
  const rec = new Rec();
  drawRoutes(rec, fr, model);
  const found = lineStrokesOf(rec, fr, model);
  const dashed = model.routes.filter((r) => !r.loaded && !r.roundOnly);
  const loaded = model.routes.filter((r) => r.loaded && !r.roundOnly);
  assert.ok(dashed.length >= 1 && loaded.length >= 1);
  assert.equal(OTHER_ALPHA, 0.7);
  for (const r of dashed) {
    const { halo, line } = found.get(r);
    assert.equal(line.alpha, OTHER_ALPHA);
    assert.equal(halo.width - line.width, 2);
  }
  for (const r of loaded) {
    const { halo, line } = found.get(r);
    assert.ok(line.alpha >= 0.8);
    assert.equal(halo.width - line.width, 4);
  }
});

test('a path id means a cell sequence only in one path pool: a collector that restarts with a new pool does not draw the old shapes under the new ids', () => {
  const { graph, det, i } = twoLines();
  const first = buildRouteSet(det, graph, i, 'start', 1);
  const route = first.routes.find((r) => !r.roundOnly);
  const before = Array.from(route.geom.pts);
  const old = det.pool;
  // the same ids, now naming the reverse walk of the same cells: a restarted collector's new pool
  const flipped = { ...old, nodes: (id) => Int32Array.from(old.nodes(id)).reverse(), len: old.len, start: old.start, size: old.size };
  det.pool = flipped;
  try {
    const second = buildRouteSet(det, graph, i, 'start', 1);
    const again = second.routes.find((r) => r.pathId === route.pathId && !r.roundOnly);
    assert.ok(again, 'the same path id is drawn');
    assert.notDeepEqual(Array.from(again.geom.pts), before, 'the shape comes from the NEW pool, not from the cache of the old one');
    det.pool = old;
    const third = buildRouteSet(det, graph, i, 'start', 1);
    assert.deepEqual(Array.from(third.routes.find((r) => r.pathId === route.pathId && !r.roundOnly).geom.pts), before, 'and back with the old pool the old shape');
  } finally {
    det.pool = old;
  }
});
