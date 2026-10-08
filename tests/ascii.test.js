import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { DIR_BIT, E, W, S } from '../js/util/grid.js';

test('ascii helper: two-way road links both ways, stations and flows are built', () => {
  const l = layoutFromAscii(['AA..BB', '++++++'], {
    stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 3, preset: 'forklift' }],
  });
  assert.equal(l.stations.length, 2);
  assert.deepEqual(l.stations.map((s) => [s.id, s.type, s.x, s.y, s.w, s.h]), [['A', 'source', 0, 0, 2, 1], ['B', 'sink', 4, 0, 2, 1]]);
  assert.equal(l.flows.length, 1);
  assert.equal(l.fleets[0].count, 3);
  assert.equal(l.fleets[0].speed, 3.0);
  assert.equal(l.roads['0,1'].out, DIR_BIT[E]);
  assert.equal(l.roads['3,1'].out, DIR_BIT[E] | DIR_BIT[W]);
  assert.equal(l.roads['5,1'].out, DIR_BIT[W]);
});

test('ascii helper: one-way arrows only link forward', () => {
  const l = layoutFromAscii(['>>v', '..v'], {});
  assert.equal(l.roads['0,0'].out, DIR_BIT[E]);
  assert.equal(l.roads['1,0'].out, DIR_BIT[E]);
  assert.equal(l.roads['2,0'].out, DIR_BIT[S]);
  assert.equal(l.roads['2,1'].out, 0);
});

test('ascii helper: a two-way cell does not link back into a one-way arrow pointing at it', () => {
  const l = layoutFromAscii(['>+']);
  assert.equal(l.roads['0,0'].out, DIR_BIT[E]); // arrow exits into '+'
  assert.equal(l.roads['1,0'].out, 0); // '+' cannot enter the arrow cell from its front
});
