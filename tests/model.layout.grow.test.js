// growGrid / trimGrid / contentBounds (js/model/layout.js): the plan extends with the work.
// Unit tests of the rules, then seeded property tests over random plants: any sequence of grows and trims keeps every
// model invariant, keeps the content's geometry relative to itself, respects GRID_LIMITS, and one undo step restores
// the plan exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { GRID_LIMITS, GRID_BLOCK } from '../js/model/defaults.js';
import { EXAMPLES } from '../js/model/examples.js';
import { createRng } from '../js/util/rng.js';
import { createStore } from '../js/store/store.js';
import { parseKey, cellKey } from '../js/util/grid.js';

const MAX = GRID_LIMITS.maxCols;

/** A small plant: a loop road, two stations with a flow, a wall, a label and a fleet. */
function plant() {
  const l = L.createLayout({ name: 'Grow test', cols: 24, rows: 16, cellSize: 2 });
  L.paintRoadPath(l, [[4, 6], [10, 6], [10, 9], [4, 9], [4, 6]]);
  const a = L.addStation(l, { type: 'source', x: 4, y: 3, w: 3, h: 2 });
  const b = L.addStation(l, { type: 'sink', x: 8, y: 10, w: 3, h: 2 });
  L.addFlow(l, a.id, b.id);
  L.addObstacle(l, { x: 13, y: 5, w: 2, h: 3, kind: 'rack' });
  L.addLabel(l, { x: 12.5, y: 2, text: 'North gate' });
  L.addFleet(l, 'agv', { count: 2 });
  return l;
}

/** Everything that describes the plan's content, positions relative to the content's own top-left corner. */
function signature(layout) {
  const b = L.contentBounds(layout) || { x: 0, y: 0 };
  const roads = Object.entries(layout.roads).map(([key, cell]) => {
    const [cx, cy] = parseKey(key);
    return [cellKey(cx - b.x, cy - b.y), cell];
  }).sort((p, q) => (p[0] < q[0] ? -1 : 1));
  const round = (v) => Math.round(v * 1e6) / 1e6; // labels may sit on fractions: a shift by whole cells moves them by an ulp
  const rel = (e) => ({ ...e, x: round(e.x - b.x), y: round(e.y - b.y) });
  return JSON.stringify({
    name: layout.name, notes: layout.notes, cellSize: layout.grid.cellSize, roads,
    stations: layout.stations.map(rel), obstacles: layout.obstacles.map(rel), labels: layout.labels.map(rel),
    flows: layout.flows, fleets: layout.fleets, settings: layout.settings,
  });
}

// ---- contentBounds -------------------------------------------------------------------------------------------------

test('contentBounds: the box around roads, stations, obstacles and labels; null for an empty plan', () => {
  assert.equal(L.contentBounds(L.createLayout()), null);
  const l = plant();
  assert.deepEqual(L.contentBounds(l), { x: 4, y: 2, w: 11, h: 10 }, 'x 4..14 (the rack ends at 15), y 2..11 (a label sits in cell 12,2)');
  const one = L.createLayout();
  L.addLabel(one, { x: 3.9, y: 7.2, text: 'only a label' });
  assert.deepEqual(L.contentBounds(one), { x: 3, y: 7, w: 1, h: 1 }, 'a label counts as the cell its anchor lies in');
  const roadOnly = L.createLayout();
  L.paintRoadCell(roadOnly, 0, 0);
  assert.deepEqual(L.contentBounds(roadOnly), { x: 0, y: 0, w: 1, h: 1 });
});

// ---- growGrid ------------------------------------------------------------------------------------------------------

test('growGrid: adds cells on the chosen sides and shifts everything by the cells added left and above', () => {
  const l = plant();
  const before = L.cloneLayout(l);
  const r = L.growGrid(l, { left: 8, top: 16, right: 24, bottom: 8 });
  assert.deepEqual(r, { dx: 8, dy: 16, left: 8, top: 16, right: 24, bottom: 8, cols: 24 + 8 + 24, rows: 16 + 16 + 8 });
  assert.deepEqual([l.grid.cols, l.grid.rows], [56, 40]);
  assert.deepEqual(L.checkInvariants(l), []);
  for (const [i, s] of before.stations.entries()) assert.deepEqual([l.stations[i].x, l.stations[i].y], [s.x + 8, s.y + 16]);
  assert.deepEqual([l.obstacles[0].x, l.obstacles[0].y], [13 + 8, 5 + 16]);
  assert.deepEqual([l.labels[0].x, l.labels[0].y], [12.5 + 8, 2 + 16], 'fractional label positions shift by whole cells');
  for (const [key, cell] of Object.entries(before.roads)) {
    const [cx, cy] = parseKey(key);
    assert.deepEqual(l.roads[cellKey(cx + 8, cy + 16)], cell, `road ${key} moved with the content`);
  }
  assert.equal(Object.keys(l.roads).length, Object.keys(before.roads).length, 'no road cell lost or added');
  assert.deepEqual(l.flows, before.flows, 'flows refer to station ids, which do not change');
  assert.equal(signature(l), signature(before));
});

test('growGrid: right and bottom do not move anything; zero, negative and junk requests change nothing', () => {
  const l = plant();
  const before = L.cloneLayout(l);
  const r = L.growGrid(l, { right: 8, bottom: 8 });
  assert.deepEqual([r.dx, r.dy, r.cols, r.rows], [0, 0, 32, 24]);
  assert.deepEqual(l.roads, before.roads);
  assert.deepEqual(l.stations, before.stations);
  const fresh = plant();
  for (const sides of [undefined, null, {}, { left: 0 }, { left: -5, top: -1 }, { left: NaN, right: 'x', top: Infinity }, 'wide', []]) {
    const copy = L.cloneLayout(fresh);
    const out = L.growGrid(copy, sides);
    assert.deepEqual(copy, fresh, `no change for ${JSON.stringify(sides)}`);
    assert.deepEqual([out.dx, out.dy, out.left, out.top, out.right, out.bottom], [0, 0, 0, 0, 0, 0]);
    assert.deepEqual([out.cols, out.rows], [24, 16]);
  }
  const frac = plant();
  assert.equal(L.growGrid(frac, { left: 3.6 }).left, 4, 'fractions are rounded');
  assert.equal(L.growGrid(frac, { right: '8' }).right, 8, 'numeric strings are numbers');
});

test('growGrid: never beyond GRID_LIMITS; left/top are served first, right/bottom get what remains; nothing is lost', () => {
  assert.equal(MAX, 320, 'the largest baseplate is 320 x 320 cells');
  const l = plant();
  const r = L.growGrid(l, { left: 5000, right: 5000, top: 5000, bottom: 5000 });
  assert.deepEqual([l.grid.cols, l.grid.rows], [MAX, MAX]);
  assert.deepEqual([r.left, r.right, r.top, r.bottom], [MAX - 24, 0, MAX - 16, 0], 'left and top took all the room');
  assert.deepEqual(L.checkInvariants(l), []);
  assert.deepEqual(L.growGrid(l, { left: 8, right: 8, top: 8, bottom: 8 }), { dx: 0, dy: 0, left: 0, top: 0, right: 0, bottom: 0, cols: MAX, rows: MAX }, 'a full plan does not grow');
  const near = L.createLayout({ cols: MAX - 10, rows: 20 });
  const part = L.growGrid(near, { left: 6, right: 6 });
  assert.deepEqual([part.left, part.right, near.grid.cols], [6, 4, MAX], 'the right side gets the 4 cells that are left');
});

test('growGrid: an empty plan just gets bigger; labels on the far edge stay valid', () => {
  const l = L.createLayout({ cols: 10, rows: 10 });
  L.addLabel(l, { x: 10, y: 10, text: 'corner' });
  assert.deepEqual(L.growGrid(l, { left: 4, top: 4 }).dx, 4);
  assert.deepEqual([l.labels[0].x, l.labels[0].y, l.grid.cols, l.grid.rows], [14, 14, 14, 14]);
  assert.deepEqual(L.checkInvariants(l), []);
});

// ---- trimGrid ------------------------------------------------------------------------------------------------------

test('trimGrid: shrinks to the content plus the margin and moves the content up and left by the cells cut there', () => {
  const l = plant();
  const before = L.cloneLayout(l);
  const r = L.trimGrid(l, { margin: 4 });
  // content x 4..14, y 2..11; margin 4: columns 0..18 (the content starts at 4), rows 0..15 (2 - 4 < 0)
  assert.equal(r.changed, true);
  assert.deepEqual([l.grid.cols, l.grid.rows], [19, 16], 'x: 15 + 4 = 19 columns, nothing to cut on the left; y: nothing to cut, 11 + 4 + 1 = 16 rows');
  assert.deepEqual([r.left, r.top, r.right, r.bottom], [0, 0, -5, 0]);
  assert.deepEqual(L.checkInvariants(l), []);
  assert.equal(signature(l), signature(before));
  // a plant in the middle of a big baseplate
  const big = L.cloneLayout(before);
  L.growGrid(big, { left: 40, top: 30, right: 50, bottom: 20 });
  const t = L.trimGrid(big, { margin: 4 });
  assert.deepEqual([t.dx, t.dy], [-40, -28 + 0], 'cut 40 columns and 28 rows from the left/top (content y starts at 2 + 30 = 32, minus 4)');
  assert.deepEqual(L.contentBounds(big), { x: 4, y: 4, w: 11, h: 10 }, 'four empty cells all around');
  assert.deepEqual([big.grid.cols, big.grid.rows], [11 + 8, 10 + 8]);
  assert.equal(signature(big), signature(before));
  assert.equal(L.trimGrid(big, { margin: 4 }).changed, false, 'trimming twice is a no-op');
});

test('trimGrid: never below the minimum size, never drops anything, leaves an empty plan alone', () => {
  const tiny = L.createLayout({ cols: 40, rows: 40 });
  L.paintRoadPath(tiny, [[20, 20], [21, 20]]);
  const r = L.trimGrid(tiny, { margin: 0 });
  assert.deepEqual([tiny.grid.cols, tiny.grid.rows], [GRID_LIMITS.minCols, GRID_LIMITS.minRows], 'a 2 x 1 road leaves the minimum 8 x 8');
  assert.equal(Object.keys(tiny.roads).length, 2);
  assert.deepEqual(L.checkInvariants(tiny), []);
  assert.equal(r.changed, true);
  const edge = L.createLayout({ cols: 40, rows: 40 });
  L.paintRoadCell(edge, 39, 39);
  L.trimGrid(edge, { margin: 0 });
  assert.deepEqual([edge.grid.cols, edge.grid.rows], [8, 8], 'the minimum is taken from the cells before the content when there are none after it');
  assert.deepEqual(Object.keys(edge.roads), ['7,7']);
  const empty = L.createLayout({ cols: 30, rows: 30 });
  assert.equal(L.trimGrid(empty).changed, false);
  assert.deepEqual([empty.grid.cols, empty.grid.rows], [30, 30]);
  const labelled = L.createLayout({ cols: 30, rows: 30 });
  L.addLabel(labelled, { x: 30, y: 30, text: 'far corner' });
  L.trimGrid(labelled, { margin: 2 });
  assert.deepEqual(L.checkInvariants(labelled), []);
  assert.equal(labelled.labels.length, 1);
  assert.equal(L.trimGrid(L.cloneLayout(plant()), { margin: -3 }).changed, true, 'a negative margin counts as 0');
});

// ---- the whole thing through the store ---------------------------------------------------------------------------------

test('undo restores the plan exactly after a grow and after a trim; redo brings it back', () => {
  const store = createStore({ storage: undefined });
  const start = plant();
  store.replaceLayout(start, { label: 'Start' });
  const initial = L.cloneLayout(store.getState().layout);
  assert.ok(store.commit('Extend plan', (d) => { L.growGrid(d, { left: 8, top: 8, right: 16 }); }));
  const grown = L.cloneLayout(store.getState().layout);
  assert.notDeepEqual(grown, initial);
  assert.deepEqual(L.checkInvariants(grown), []);
  assert.ok(store.commit('Trim to content', (d) => { L.trimGrid(d, { margin: 2 }); }));
  const trimmed = L.cloneLayout(store.getState().layout);
  store.undo();
  assert.deepEqual(store.getState().layout, grown, 'undo of the trim');
  store.undo();
  assert.deepEqual(store.getState().layout, initial, 'undo of the grow');
  store.redo();
  store.redo();
  assert.deepEqual(store.getState().layout, trimmed, 'redo twice');
});

// ---- seeded property tests -------------------------------------------------------------------------------------------

/** A random plant built through the model API (so it is valid by construction). */
function randomPlant(rng) {
  const l = L.createLayout({ cols: 16 + rng.int(60), rows: 12 + rng.int(40), cellSize: rng.pick([1, 2, 2.5, 4]) });
  const { cols, rows } = l.grid;
  for (let i = 0, n = 2 + rng.int(6); i < n; i++) {
    const cells = [[rng.int(cols), rng.int(rows)]];
    for (let k = 0, steps = 3 + rng.int(25); k < steps; k++) {
      const [x, y] = cells[cells.length - 1];
      const d = rng.int(4);
      cells.push([Math.max(0, Math.min(cols - 1, x + [0, 1, 0, -1][d])), Math.max(0, Math.min(rows - 1, y + [-1, 0, 1, 0][d]))]);
    }
    L.paintRoadPath(l, cells, { oneWay: rng.next() < 0.3 });
  }
  const types = ['source', 'process', 'storage', 'sink', 'depot'];
  for (let i = 0, n = rng.int(7); i < n; i++) L.addStation(l, { type: rng.pick(types), x: rng.int(cols), y: rng.int(rows), w: 1 + rng.int(4), h: 1 + rng.int(3) });
  for (let i = 0, n = rng.int(4); i < n; i++) L.addObstacle(l, { x: rng.int(cols), y: rng.int(rows), w: 1 + rng.int(3), h: 1 + rng.int(3), kind: rng.pick(['wall', 'rack', 'column']) });
  for (let i = 0, n = rng.int(3); i < n; i++) L.addLabel(l, { x: rng.range(0, cols), y: rng.range(0, rows), text: `L${i}` });
  for (let i = 0; i < 6; i++) {
    const from = rng.pick(l.stations);
    const to = rng.pick(l.stations);
    if (from && to) L.addFlow(l, from.id, to.id);
  }
  if (rng.next() < 0.8) L.addFleet(l, rng.pick(['agv', 'forklift', 'tugger']), { count: 1 + rng.int(3) });
  return l;
}

test('property: any sequence of grows and trims keeps the invariants, the relative geometry and the limits (300 plants)', () => {
  let steps = 0;
  let limited = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rng = createRng(seed);
    const layout = randomPlant(rng);
    assert.deepEqual(L.checkInvariants(layout), [], `seed ${seed}: the generator makes valid plants`);
    const reference = signature(layout);
    const content = L.contentBounds(layout);
    for (let step = 0; step < 8; step++) {
      const before = L.cloneLayout(layout);
      const boundsBefore = L.contentBounds(layout);
      let result;
      if (rng.next() < 0.7) {
        const pick = () => (rng.next() < 0.45 ? 0 : rng.next() < 0.1 ? 100 + rng.int(400) : rng.int(40));
        const sides = { left: pick(), top: pick(), right: pick(), bottom: pick() };
        result = L.growGrid(layout, sides);
        assert.equal(result.cols, before.grid.cols + result.left + result.right, `seed ${seed}.${step}: columns`);
        assert.equal(result.rows, before.grid.rows + result.top + result.bottom, `seed ${seed}.${step}: rows`);
        for (const k of ['left', 'top', 'right', 'bottom']) assert.ok(result[k] >= 0 && result[k] <= sides[k], `seed ${seed}.${step}: ${k} is within the request`);
        if (result.left < sides.left || result.right < sides.right || result.top < sides.top || result.bottom < sides.bottom) {
          limited++;
          assert.ok(layout.grid.cols === MAX || layout.grid.rows === MAX, `seed ${seed}.${step}: only the limit holds growth back`);
        }
      } else {
        result = L.trimGrid(layout, { margin: rng.int(7) });
        assert.ok(result.left <= 0 && result.top <= 0 && result.right <= 0 && result.bottom <= 0, `seed ${seed}.${step}: trimming only removes`);
        assert.equal(result.changed, layout.grid.cols !== before.grid.cols || layout.grid.rows !== before.grid.rows);
      }
      steps++;
      assert.deepEqual(L.checkInvariants(layout), [], `seed ${seed}.${step}: invariants`);
      assert.ok(layout.grid.cols >= GRID_LIMITS.minCols && layout.grid.cols <= MAX && layout.grid.rows >= GRID_LIMITS.minRows && layout.grid.rows <= MAX, `seed ${seed}.${step}: size within the limits`);
      assert.equal(signature(layout), reference, `seed ${seed}.${step}: content relative to itself is unchanged`);
      if (content) {
        const now = L.contentBounds(layout);
        assert.deepEqual([now.w, now.h], [content.w, content.h], `seed ${seed}.${step}: content size unchanged`);
        assert.deepEqual([now.x - boundsBefore.x, now.y - boundsBefore.y], [result.dx, result.dy], `seed ${seed}.${step}: content moved by dx, dy`);
      }
      assert.equal(Object.keys(layout.roads).length, Object.keys(before.roads).length);
      assert.equal(layout.stations.length, before.stations.length);
      assert.equal(layout.obstacles.length, before.obstacles.length);
      assert.equal(layout.labels.length, before.labels.length);
    }
  }
  assert.ok(steps === 300 * 8 && limited > 0, `the limit was hit in ${limited} steps (the sequences are long enough to reach it)`);
});

test('property: one undo restores the plan exactly, one redo repeats it (200 random edits through the store)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = createRng(1000 + seed);
    const store = createStore({ storage: undefined });
    store.replaceLayout(randomPlant(rng), { label: 'Start' });
    for (let step = 0; step < 4; step++) {
      const before = store.getState().layout;
      const snapshot = L.cloneLayout(before);
      const grow = rng.next() < 0.6;
      const changed = store.commit(grow ? 'Extend plan' : 'Trim to content', (d) => {
        if (grow) L.growGrid(d, { left: rng.int(20), top: rng.int(20), right: rng.int(20), bottom: rng.int(20) });
        else L.trimGrid(d, { margin: rng.int(6) });
      });
      if (!changed) continue;
      const after = L.cloneLayout(store.getState().layout);
      assert.deepEqual(L.checkInvariants(after), [], `seed ${seed}.${step}`);
      store.undo();
      assert.deepEqual(store.getState().layout, snapshot, `seed ${seed}.${step}: undo restores exactly`);
      store.redo();
      assert.deepEqual(store.getState().layout, after, `seed ${seed}.${step}: redo repeats it`);
    }
  }
});

test('property: growing the three example plants on any side keeps their content intact', () => {
  for (const example of EXAMPLES) {
    const base = example.build();
    const reference = signature(base);
    for (const sides of [{ left: GRID_BLOCK }, { top: GRID_BLOCK }, { right: GRID_BLOCK }, { bottom: GRID_BLOCK }, { left: 3, top: 5, right: 7, bottom: 11 }, { left: 200, top: 200, right: 200, bottom: 200 }]) {
      const l = L.cloneLayout(base);
      L.growGrid(l, sides);
      assert.deepEqual(L.checkInvariants(l), [], example.id);
      assert.equal(signature(l), reference, `${example.id} ${JSON.stringify(sides)}`);
      L.trimGrid(l, { margin: 4 });
      assert.deepEqual(L.checkInvariants(l), [], example.id);
      assert.equal(signature(l), reference);
    }
  }
});
