import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, sampleDist } from '../js/util/rng.js';
import { lPath, perimeterCells, dirFromTo, rectsOverlap, cellKey, parseKey, N, E, S, W } from '../js/util/grid.js';
import { nextId } from '../js/util/ids.js';
import { formatClock, formatDuration, formatPercent } from '../js/util/format.js';

test('rng is deterministic and forks are independent of consumption order', () => {
  const a = createRng(42), b = createRng(42);
  assert.deepEqual([a.next(), a.next(), a.next()], [b.next(), b.next(), b.next()]);
  const r1 = createRng(7).fork('x').next();
  const base = createRng(7); base.next(); base.next();
  assert.equal(base.fork('x').next(), r1, 'fork depends only on seed+label');
  assert.notEqual(createRng(7).fork('x').next(), createRng(7).fork('y').next());
});

test('rng stays in range and distributions have the right mean', () => {
  const r = createRng(1);
  for (let i = 0; i < 1000; i++) { const v = r.next(); assert.ok(v >= 0 && v < 1); }
  const n = 20000;
  for (const kind of ['const', 'exp', 'normal', 'uniform']) {
    const rr = createRng(5); let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleDist(rr, { kind, mean: 60, spread: 0.3 });
    assert.ok(Math.abs(sum / n - 60) < 2.5, `${kind} mean ${sum / n}`);
  }
  assert.equal(sampleDist(createRng(1), { kind: 'const', mean: 10 }, 2), 20);
});

test('grid helpers', () => {
  assert.deepEqual(parseKey(cellKey(12, 7)), [12, 7]);
  assert.equal(dirFromTo(1, 1, 1, 0), N);
  assert.equal(dirFromTo(1, 1, 2, 1), E);
  assert.equal(dirFromTo(1, 1, 1, 2), S);
  assert.equal(dirFromTo(1, 1, 0, 1), W);
  assert.equal(dirFromTo(1, 1, 3, 1), -1);
  assert.deepEqual(lPath(0, 0, 2, 0), [[0, 0], [1, 0], [2, 0]]);
  assert.deepEqual(lPath(0, 0, 1, 2), [[0, 0], [0, 1], [0, 2], [1, 2]]);
  assert.equal(perimeterCells({ x: 2, y: 2, w: 2, h: 3 }).length, 2 * 2 + 2 * 3);
  assert.ok(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 }));
  assert.ok(!rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 }));
});

test('ids and format', () => {
  assert.equal(nextId('s', ['s1', 's2', 's4']), 's3');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(formatDuration(30), '30 s');
  assert.equal(formatDuration(600), '10 min');
  assert.equal(formatPercent(0.734), '73 %');
});
