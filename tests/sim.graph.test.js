import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { buildGraph } from '../js/sim/graph.js';

const nid = (g, x, y) => y * g.cols + x;
const build = (lines, opts) => { const layout = layoutFromAscii(lines, opts); return { layout, g: buildGraph(layout) }; };

test('nodes, edges and reverse pairing on a two-way line', () => {
  const { g } = build(['+++']);
  assert.equal(g.nodes.length, 3);
  assert.equal(g.edges.length, 4);
  for (const e of g.edges) {
    assert.ok(e.rev >= 0);
    assert.equal(g.edges[e.rev].rev, e.id);
    assert.equal(g.edges[e.rev].from, e.to);
    assert.equal(e.length, 2);
  }
  assert.equal(g.edgeBetween(nid(g, 0, 0), nid(g, 1, 0)) >= 0, true);
  assert.equal(g.edgeBetween(nid(g, 0, 0), nid(g, 2, 0)), -1);
  assert.equal(g.x(nid(g, 2, 0)), 5);
  assert.equal(g.y(nid(g, 2, 0)), 1);
});

test('controlled-cell classification', () => {
  // two-way line: ends are dead ends (reversal), the middle is a plain road
  let { g } = build(['+++']);
  assert.deepEqual([0, 1, 2].map((x) => g.controlled[nid(g, x, 0)]), [1, 0, 1]);
  assert.deepEqual([0, 1, 2].map((x) => g.deadEnd[nid(g, x, 0)]), [1, 0, 1]);

  // two-way corner is uncontrolled
  ({ g } = build(['++', '+.']));
  assert.equal(g.controlled[nid(g, 0, 0)], 0);

  // T junction and crossing are controlled
  ({ g } = build(['+++', '.+.']));
  assert.equal(g.controlled[nid(g, 1, 0)], 1);
  ({ g } = build(['.+.', '+++', '.+.']));
  assert.equal(g.controlled[nid(g, 1, 1)], 1);

  // one-way chain: uncontrolled everywhere
  ({ g } = build(['>>>>']));
  assert.deepEqual([0, 1, 2, 3].map((x) => g.controlled[nid(g, x, 0)]), [0, 0, 0, 0]);

  // one-way fork (a single incoming stream, two exits) is uncontrolled
  ({ g } = build(['.^.', '>+>']));
  assert.equal(g.controlled[nid(g, 1, 1)], 0);
});

test('one-way merge is controlled', () => {
  const { g } = build(['.v.', '>>v', '..v'].map((l) => l));
  // cell (1,1) is entered from (0,1) '>' and from (1,0) 'v' and exits only E -> merge
  // (using arrows: (1,1) is '>' so it exits east; both inbound streams share that exit)
  assert.equal(g.controlled[nid(g, 1, 1)], 1);
});

test('docks are the road cells edge-adjacent to a station', () => {
  const { g } = build(['AA.BB', '+++++'], { stations: { A: 'source', B: 'sink' } });
  assert.deepEqual(g.docks.get('A'), [nid(g, 0, 1), nid(g, 1, 1)]);
  assert.deepEqual(g.docks.get('B'), [nid(g, 3, 1), nid(g, 4, 1)]);
  assert.deepEqual(g.stationsAt.get(nid(g, 0, 1)), ['A']);
  assert.equal(g.stationsAt.get(nid(g, 2, 1)), undefined);
});

test('shortest route on a loop follows the one-way direction', () => {
  const { g } = build([
    '>>>v',
    '^..v',
    '^<<<',
  ]);
  const r = g.path(nid(g, 0, 0), nid(g, 0, 1));
  assert.ok(r);
  assert.equal(r.edges.length, 9, 'must go all the way around (one-way)');
  assert.equal(r.nodes[0], nid(g, 0, 0));
  assert.equal(r.nodes.at(-1), nid(g, 0, 1));
  assert.equal(r.nodes.length, r.edges.length + 1);
  assert.equal(r.cost, 18);
});

test('no U-turn in mid-road: vehicle standing on a two-way line must drive to the end and reverse there', () => {
  const { g } = build(['+++++']);
  const a = nid(g, 1, 0);
  const arrival = g.edgeBetween(nid(g, 0, 0), a); // arrived from the west
  const toWest = g.search(a, { arrivalEdge: arrival }).routeTo(nid(g, 0, 0));
  assert.deepEqual(toWest.nodes.map((n) => g.cx(n)), [1, 2, 3, 4, 3, 2, 1, 0], 'reverses only at the east dead end');
  // free choice (e.g. leaving a depot) may go either way
  const free = g.search(a, { arrivalEdge: -1 }).routeTo(nid(g, 0, 0));
  assert.deepEqual(free.nodes.map((n) => g.cx(n)), [1, 0]);
});

test('reversal at a dead end is allowed immediately when it is the only exit', () => {
  const { g } = build(['+++']);
  const end = nid(g, 2, 0);
  const arrival = g.edgeBetween(nid(g, 1, 0), end);
  const back = g.search(end, { arrivalEdge: arrival }).routeTo(nid(g, 1, 0));
  assert.deepEqual(back.nodes.map((n) => g.cx(n)), [2, 1]);
});

test('unreachable targets return null / Infinity; zero-length route to self', () => {
  const { g } = build(['>>>', '...', '++.']);
  const s = g.search(nid(g, 0, 0));
  assert.equal(s.routeTo(nid(g, 0, 2)), null);
  assert.equal(s.dist(nid(g, 0, 2)), Infinity);
  assert.equal(s.dist(nid(g, 2, 0)), 4);
  assert.deepEqual(s.routeTo(nid(g, 0, 0)), { nodes: [nid(g, 0, 0)], edges: [], cost: 0 });
  assert.equal(g.path(nid(g, 5, 5), nid(g, 0, 0)), null, 'start is not a road cell');
});

test('slow zones are avoided when a detour is quicker', () => {
  const { layout } = build([
    '+++++',
    '+...+',
    '+++++',
  ]);
  layout.roads['2,0'].limit = 0.2; // the straight top road has a very slow middle
  const g = buildGraph(layout);
  const r = g.path(nid(g, 0, 0), nid(g, 4, 0));
  const viaTop = r.nodes.includes(nid(g, 2, 0));
  assert.equal(viaTop, false, 'route should go around through the bottom road');
});

test('custom cost callback (congestion-aware routing)', () => {
  const { g } = build([
    '+++++',
    '+...+',
    '+++++',
  ]);
  const top = nid(g, 2, 0);
  const plain = g.path(nid(g, 0, 0), nid(g, 4, 0));
  assert.ok(plain.nodes.includes(top), 'straight line wins by default');
  const loaded = g.path(nid(g, 0, 0), nid(g, 4, 0), { cost: (e) => (e.to === top || e.from === top ? 100 : e.length) });
  assert.ok(!loaded.nodes.includes(top));
});

test('strongly connected components', () => {
  const { g } = build([
    '>>v.',
    '^.v.',
    '^<<>',
  ]);
  assert.ok(g.sameScc(nid(g, 0, 0), nid(g, 0, 2)));
  assert.ok(!g.sameScc(nid(g, 0, 0), nid(g, 3, 2)), 'the spur at (3,2) can be entered but not left');
  assert.equal(g.scc[nid(g, 5, 5)], -1);
});

test('graph ignores dangling exit bits, out-of-bounds keys and is deterministic', () => {
  const layout = layoutFromAscii(['++']);
  layout.roads['99,99'] = { out: 15 };
  layout.roads['1,0'].out |= 8 | 4 | 1; // bits towards non-road cells
  const g1 = buildGraph(layout);
  const g2 = buildGraph(layout);
  assert.equal(g1.edges.length, 2);
  assert.deepEqual(g1.edges, g2.edges);
  assert.deepEqual(g1.nodes, g2.nodes);
});

test('route ties are broken deterministically and search is repeatable', () => {
  const { g } = build([
    '+++',
    '+.+',
    '+++',
  ]);
  const a = g.path(nid(g, 0, 0), nid(g, 2, 2));
  const b = g.path(nid(g, 0, 0), nid(g, 2, 2));
  assert.deepEqual(a, b);
  assert.equal(a.cost, 8);
});
