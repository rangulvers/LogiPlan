import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectFromPoints, marqueeHits, pickMarquee, addToSelection, toggleInSelection, isSelected } from '../js/ui/editor/marquee.js';
import { layoutFromAscii } from './helpers/ascii.js';

// stations A (1..2, 1..2), B (5..7, 1..2), C (1..2, 5..6); walls at (4,4) and (5,4); labels at (4, 3) and (9.5, 1.5)
function plant() {
  const layout = layoutFromAscii([
    '............',
    '.AA..BBB....',
    '.AA..BBB....',
    '............',
    '....##......',
    '.CC.........',
    '.CC.........',
    '............',
  ], { stations: { A: 'source', B: 'process', C: 'sink' } });
  layout.labels.push({ id: 'l1', x: 4, y: 3, text: 'Aisle' }, { id: 'l2', x: 9.5, y: 1.5, text: 'Yard' });
  return layout;
}

test('rectFromPoints: any two corners give the same positive rectangle', () => {
  const want = { x: 1, y: 2, w: 3, h: 4 };
  assert.deepEqual(rectFromPoints(1, 2, 4, 6), want);
  assert.deepEqual(rectFromPoints(4, 6, 1, 2), want);
  assert.deepEqual(rectFromPoints(1, 6, 4, 2), want);
  assert.deepEqual(rectFromPoints(2, 2, 2, 2), { x: 2, y: 2, w: 0, h: 0 });
});

test('marqueeHits: partly inside is enough, touching an edge is not', () => {
  const layout = plant();
  assert.deepEqual(marqueeHits(layout, rectFromPoints(0.5, 0.5, 1.5, 1.5)).station, ['A'], 'a corner overlap selects the whole station');
  assert.deepEqual(marqueeHits(layout, rectFromPoints(0, 0, 1, 3)).station, [], 'ends exactly at the left edge of A');
  assert.deepEqual(marqueeHits(layout, rectFromPoints(0, 0, 3, 3)).station, ['A'], 'fully inside');
  assert.deepEqual(marqueeHits(layout, rectFromPoints(0, 0, 12, 8)).station, ['A', 'B', 'C']);
  assert.deepEqual(marqueeHits(layout, rectFromPoints(8, 5, 11, 7)).station, []);
});

test('marqueeHits: stations, obstacles and labels are reported separately; a label counts by its anchor point', () => {
  const layout = plant();
  const hits = marqueeHits(layout, rectFromPoints(3.2, 2.5, 6, 4.5));
  assert.deepEqual(hits.station, ['B'], 'B reaches into the rectangle');
  assert.deepEqual(hits.obstacle, ['o1', 'o2']);
  assert.deepEqual(hits.label, ['l1']);
  assert.deepEqual(marqueeHits(layout, rectFromPoints(9, 1, 10, 2)).label, ['l2']);
  assert.deepEqual(marqueeHits(layout, rectFromPoints(0, 0, 2, 2)).label, []);
});

test('pickMarquee prefers stations, then obstacles, then labels; no hit selects nothing', () => {
  const layout = plant();
  assert.deepEqual(pickMarquee(marqueeHits(layout, rectFromPoints(0, 0, 12, 8))), { kind: 'station', ids: ['A', 'B', 'C'] });
  assert.deepEqual(pickMarquee(marqueeHits(layout, rectFromPoints(3.2, 3.2, 6.5, 4.8))), { kind: 'obstacle', ids: ['o1', 'o2'] });
  assert.deepEqual(pickMarquee(marqueeHits(layout, rectFromPoints(3.6, 2.6, 4.4, 3.4))), { kind: 'label', ids: ['l1'] });
  assert.deepEqual(pickMarquee(marqueeHits(layout, rectFromPoints(10, 6, 11, 7))), { kind: null, ids: [] });
});

test('addToSelection (Shift+marquee): same kind is merged without repeats, another kind replaces, nothing keeps', () => {
  const cur = { kind: 'station', ids: ['A'] };
  assert.deepEqual(addToSelection(cur, { kind: 'station', ids: ['B', 'A'] }), { kind: 'station', ids: ['A', 'B'] });
  assert.deepEqual(addToSelection(cur, { kind: 'obstacle', ids: ['o1'] }), { kind: 'obstacle', ids: ['o1'] });
  assert.equal(addToSelection(cur, { kind: null, ids: [] }), cur);
});

test('toggleInSelection (Shift+click): adds, removes, empties and switches kind', () => {
  const none = { kind: null, ids: [] };
  assert.deepEqual(toggleInSelection(none, 'station', 'A'), { kind: 'station', ids: ['A'] });
  assert.deepEqual(toggleInSelection({ kind: 'station', ids: ['A'] }, 'station', 'B'), { kind: 'station', ids: ['A', 'B'] });
  assert.deepEqual(toggleInSelection({ kind: 'station', ids: ['A', 'B'] }, 'station', 'A'), { kind: 'station', ids: ['B'] });
  assert.deepEqual(toggleInSelection({ kind: 'station', ids: ['A'] }, 'station', 'A'), none);
  assert.deepEqual(toggleInSelection({ kind: 'station', ids: ['A'] }, 'obstacle', 'o1'), { kind: 'obstacle', ids: ['o1'] });
});

test('isSelected looks at kind and id', () => {
  const sel = { kind: 'station', ids: ['A'] };
  assert.ok(isSelected(sel, 'station', 'A'));
  assert.ok(!isSelected(sel, 'obstacle', 'A'));
  assert.ok(!isSelected(sel, 'station', 'B'));
});
