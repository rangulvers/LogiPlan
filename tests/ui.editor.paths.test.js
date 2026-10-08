import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extendStroke, straightStroke, uniqueCells, clipStroke, lastDirection } from '../js/ui/editor/paths.js';
import { layoutFromAscii } from './helpers/ascii.js';

const adjacent = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
const consecutiveNeighbours = (cells) => cells.every((c, i) => i === 0 || adjacent(cells[i - 1], c));

test('extendStroke: first cell starts the stroke, repeats and neighbours are appended as they are', () => {
  const s = [];
  extendStroke(s, [2, 2]);
  extendStroke(s, [2, 2]);
  extendStroke(s, [3, 2]);
  extendStroke(s, [3, 3]);
  assert.deepEqual(s, [[2, 2], [3, 2], [3, 3]]);
});

test('extendStroke: a gap left by a fast pointer is filled with the L-shaped lPath, horizontal leg first', () => {
  const s = [[3, 2]];
  extendStroke(s, [6, 4]);
  assert.deepEqual(s, [[3, 2], [4, 2], [5, 2], [6, 2], [6, 3], [6, 4]]);
  assert.ok(consecutiveNeighbours(s));
  const v = [[1, 1]];
  extendStroke(v, [2, 5]);
  assert.deepEqual(v, [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [2, 5]], 'vertical leg first when the gap is taller than wide');
});

test('extendStroke: works backwards and leaves the input cell untouched (copies are stored)', () => {
  const to = [0, 0];
  const s = [[4, 0]];
  extendStroke(s, to);
  assert.deepEqual(s, [[4, 0], [3, 0], [2, 0], [1, 0], [0, 0]]);
  to[0] = 99;
  assert.deepEqual(s[s.length - 1], [0, 0]);
});

test('straightStroke: Shift line from the start to the pointer cell (L-shaped when not aligned)', () => {
  assert.deepEqual(straightStroke([2, 2], [5, 2]), [[2, 2], [3, 2], [4, 2], [5, 2]]);
  assert.deepEqual(straightStroke([2, 2], [2, 0]), [[2, 2], [2, 1], [2, 0]]);
  assert.deepEqual(straightStroke([1, 1], [3, 2]), [[1, 1], [2, 1], [3, 1], [3, 2]]);
  assert.deepEqual(straightStroke([4, 4], [4, 4]), [[4, 4]]);
});

test('uniqueCells keeps the first visit of every cell, in order', () => {
  assert.deepEqual(uniqueCells([[1, 1], [2, 1], [1, 1], [3, 1], [2, 1]]), [[1, 1], [2, 1], [3, 1]]);
  assert.deepEqual(uniqueCells([]), []);
});

test('clipStroke: a free stroke is painted completely', () => {
  const layout = layoutFromAscii(['........', '........', '........', '........', '........', '........', '........', '........']);
  const cells = [[0, 0], [1, 0], [2, 0]];
  const { paint, blocked } = clipStroke(layout, cells);
  assert.equal(paint, cells);
  assert.deepEqual(blocked, []);
});

test('clipStroke: the stroke stops at the first station or obstacle and the rest is reported as blocked', () => {
  const layout = layoutFromAscii(['........', '........', '..AA#...', '........', '........', '........', '........', '........']);
  const row = [0, 1, 2, 3, 4, 5, 6].map((x) => [x, 2]);
  const { paint, blocked } = clipStroke(layout, row);
  assert.deepEqual(paint, [[0, 2], [1, 2]]);
  assert.deepEqual(blocked, [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2]]);
  const back = clipStroke(layout, [[2, 2], [1, 2]]);
  assert.deepEqual(back.paint, [], 'starting on a blocked cell paints nothing');
  assert.deepEqual(back.blocked, [[2, 2], [1, 2]]);
});

test('clipStroke: cells off the baseplate are blocked, and so is whatever follows them', () => {
  const layout = layoutFromAscii(['........', '........', '........', '........', '........', '........', '........', '........']);
  const { paint, blocked } = clipStroke(layout, [[6, 0], [7, 0], [8, 0], [7, 0]]);
  assert.deepEqual(paint, [[6, 0], [7, 0]]);
  assert.deepEqual(blocked, [[8, 0], [7, 0]]);
});

test('clipStroke agrees with paintRoadPath about where painting stops', async () => {
  const { paintRoadPath } = await import('../js/model/layout.js');
  const layout = layoutFromAscii(['........', '..#.....', '........', '........', '........', '........', '........', '........']);
  const stroke = [];
  for (const c of [[0, 1], [5, 1]]) extendStroke(stroke, c);
  const { paint } = clipStroke(layout, stroke);
  assert.equal(paintRoadPath(layout, stroke), paint.length);
});

test('lastDirection: direction of the latest step, -1 for a single cell', () => {
  assert.equal(lastDirection([[1, 1]]), -1);
  assert.equal(lastDirection([[1, 1], [2, 1]]), 1);
  assert.equal(lastDirection([[1, 1], [1, 0]]), 0);
  assert.equal(lastDirection([[1, 1], [1, 2], [0, 2]]), 3);
  assert.equal(lastDirection([[1, 1], [1, 2], [1, 2]]), 2, 'a repeated cell is not a step');
  assert.equal(lastDirection([]), -1);
});
