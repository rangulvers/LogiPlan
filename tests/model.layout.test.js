import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { emptyLayout, RUNTIME_KEYS, STATION_TYPES, OBSTACLE_KINDS, FLEET_PRESET_ORDER } from '../js/model/defaults.js';
import { createRng } from '../js/util/rng.js';
import { DIR_BIT, N, E, S, W } from '../js/util/grid.js';

/** A small, valid plant built through the model API: source -> process -> sink along one road, one depot, one fleet. */
function plant() {
  const l = L.createLayout({ name: 'Test plant', cols: 20, rows: 12, cellSize: 2 });
  L.paintRoadPath(l, [[1, 4], [18, 4]]);
  const src = L.addStation(l, { type: 'source', x: 2, y: 2, w: 3, h: 2 });
  const proc = L.addStation(l, { type: 'process', x: 8, y: 2, w: 3, h: 2 });
  const sink = L.addStation(l, { type: 'sink', x: 14, y: 2, w: 3, h: 2 });
  const depot = L.addStation(l, { type: 'depot', x: 8, y: 5, w: 3, h: 2 });
  L.addFlow(l, src.id, proc.id);
  L.addFlow(l, proc.id, sink.id);
  L.addFleet(l, 'agv', { home: depot.id });
  return l;
}

const snapshot = (l) => structuredClone(l);

// ---------------------------------------------------------------------------------------------------------
// createLayout / normalizeLayout
// ---------------------------------------------------------------------------------------------------------

test('createLayout: defaults, overrides and clamping to the grid limits', () => {
  assert.deepEqual(L.createLayout(), emptyLayout());
  const l = L.createLayout({ name: '  Plant X ', cols: 5, rows: 9999, cellSize: 0.1 });
  assert.equal(l.name, 'Plant X');
  assert.deepEqual(l.grid, { cols: 8, rows: 160, cellSize: 0.5 });
  assert.deepEqual(L.createLayout({ cols: NaN, rows: 'abc', cellSize: Infinity }).grid, { cols: 48, rows: 32, cellSize: 2 });
  assert.deepEqual(L.checkInvariants(l), []);
});

test('normalizeLayout: throws only when the input is not an object, and {} becomes the empty plant', () => {
  for (const bad of [null, undefined, 42, 'layout', [], true]) assert.throws(() => L.normalizeLayout(bad), TypeError);
  assert.deepEqual(L.normalizeLayout({}), L.createLayout());
});

test('normalizeLayout: repairs a deliberately broken layout', () => {
  const raw = {
    schema: 7, name: 42, notes: null,
    grid: { cols: '20', rows: 12.4, cellSize: -3 },
    roads: {
      '1,1': { out: 15 }, // only the east neighbour is a road
      '2,1': { out: 3, limit: 0.5 }, // north is not a road, east is
      '3,1': { out: 255, limit: 7 }, // out masked to 4 bits, limit above 1 dropped
      '4,1': { out: 8 },
      '5,1': { out: 2 }, // points into a station
      '7,1': { out: 15 }, // lies under a station
      '01,1': { out: 1 }, '-1,0': { out: 1 }, '20,3': { out: 1 }, 'a,b': {}, '9,9': 'junk',
    },
    stations: [
      { id: 'a', type: 'source', x: 6, y: 1, w: 3, h: 2, name: '  Gate  ', params: { interArrival: { kind: 'bogus', mean: '60', spread: 5 }, batch: 2.6, outCap: -4, startDelay: 'x', extra: 1 } },
      { id: 'a', type: 'process', x: 10, y: 1, w: 2, h: 2 },
      { id: 'c', type: 'sink', x: 7, y: 2, w: 3, h: 3 },
      { id: 'd', type: 'warehouse', x: 0, y: 8 },
      { id: 'e', type: 'storage', x: 18, y: 10, w: 5, h: 5 },
      { id: 'f', type: 'depot', x: '3', y: '8', w: -2, h: '2' },
    ],
    flows: [
      { id: 'f1', from: 'a', to: 's1' },
      { id: 'f1', from: 's1', to: 'e' },
      { id: 'f3', from: 'a', to: 's1' },
      { id: 'f4', from: 'e', to: 'a' },
      { id: 'f5', from: 'zzz', to: 'a' },
      { id: 'f6', from: 'f', to: 'e' },
      { id: 'f7', from: 'a', to: 'e', fleetId: 'v9', weight: 'heavy', perCycle: 0, batchMin: 9, batchMax: 4, priority: 9 },
    ],
    fleets: [
      { id: 'v1', preset: 'rocket', count: '3', speed: -1, home: 'f', battery: { enabled: 'yes', lowPct: 80, resumePct: 10 } },
      { id: 'v1', preset: 'forklift', home: 'a' },
      'junk', null,
    ],
    settings: { dispatch: 'chaos', dt: 99, seed: -5, speedFactor: '2' },
  };
  const n = L.normalizeLayout(raw);
  assert.deepEqual(L.checkInvariants(n), []);
  assert.equal(n.schema, 1);
  assert.equal(n.name, '42');
  assert.equal(n.notes, '');
  assert.deepEqual(n.grid, { cols: 20, rows: 12, cellSize: 0.5 });
  assert.deepEqual(Object.keys(n.roads).sort(), ['1,1', '2,1', '3,1', '4,1', '5,1', '9,9']);
  assert.deepEqual(n.roads['9,9'], { out: 0 }, 'a junk value keeps the plate but loses its links');
  assert.deepEqual(n.roads['1,1'], { out: DIR_BIT[E] });
  assert.deepEqual(n.roads['2,1'], { out: DIR_BIT[E], limit: 0.5 });
  assert.deepEqual(n.roads['3,1'], { out: DIR_BIT[E] | DIR_BIT[W] });
  assert.deepEqual(n.roads['5,1'], { out: 0 });
  assert.deepEqual(n.stations.map((s) => [s.id, s.type, s.name, s.x, s.y, s.w, s.h]), [
    ['a', 'source', 'Gate', 6, 1, 3, 2],
    ['s1', 'process', 'Workstation 1', 10, 1, 2, 2],
    ['e', 'storage', 'Storage 1', 18, 10, 2, 2],
    ['f', 'depot', 'Depot 1', 3, 8, 1, 2],
  ]);
  assert.deepEqual(n.stations[0].params, { interArrival: { kind: 'normal', mean: 60, spread: 1 }, batch: 3, outCap: 1, startDelay: 0 });
  assert.deepEqual(n.flows.map((f) => [f.id, f.from, f.to]), [['f1', 'a', 's1'], ['f2', 's1', 'e'], ['f7', 'a', 'e']]);
  assert.deepEqual(n.flows[2], {
    id: 'f7', from: 'a', to: 'e', weight: 1, perCycle: 1, batchMin: 4, batchMax: 4, maxWait: 0, priority: 3, fleetId: null,
  });
  assert.equal(n.fleets.length, 2);
  assert.deepEqual([n.fleets[0].preset, n.fleets[0].count, n.fleets[0].speed, n.fleets[0].home], ['custom', 3, 0.1, 'f']);
  assert.deepEqual(n.fleets[0].battery, { enabled: false, runtimeMin: 480, chargeTimeMin: 90, lowPct: 80, resumePct: 80 });
  assert.deepEqual([n.fleets[1].id, n.fleets[1].name, n.fleets[1].home], ['v2', 'Forklift', null]);
  assert.deepEqual([n.settings.dispatch, n.settings.dt, n.settings.seed, n.settings.speedFactor], ['nearest', 0.5, 0, 2]);
  assert.deepEqual(L.normalizeLayout(n), n, 'idempotent');
});

test('normalizeLayout: shares no references with its input and ignores prototype-polluting keys', () => {
  const l = plant();
  const n = L.normalizeLayout(l);
  assert.deepEqual(n, l);
  n.stations[0].params.batch = 99;
  n.roads['1,4'].out = 0;
  assert.notEqual(l.stations[0].params.batch, 99);
  assert.notEqual(l.roads['1,4'].out, 0);

  const raw = JSON.parse('{"__proto__":{"polluted":1},"roads":{"__proto__":{"out":15},"1,1":{"out":0,"__proto__":{"x":1}}},'
    + '"stations":[{"type":"source","x":1,"y":3,"__proto__":{"y":2}}],"settings":{"__proto__":{"seed":5}},"constructor":{"prototype":{"p":1}}}');
  const out = L.normalizeLayout(raw);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out.roads), Object.prototype);
  assert.ok(!Object.hasOwn(out.roads, '__proto__'));
  assert.equal(out.settings.seed, 1);
  assert.equal(out.stations[0].y, 3);
  assert.deepEqual(L.checkInvariants(out), []);
});

/** Random corruption of a valid plant: junk values, deleted keys, duplicated entities, scattered road bits. */
function corrupt(base, rng) {
  const root = JSON.parse(JSON.stringify(base));
  const junk = ['abc', '12', -5, NaN, Infinity, null, undefined, [], {}, true, 1e12, 0.5, -0, '__proto__', 7, 1.5, ''];
  const slots = [];
  (function walk(node) {
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      slots.push([node, key]);
      walk(node[key]);
    }
  })(root);
  for (let i = rng.int(12); i >= 0; i--) {
    const [node, key] = rng.pick(slots);
    const roll = rng.next();
    if (roll < 0.55) node[key] = rng.pick(junk);
    else if (roll < 0.7) delete node[key];
    else if (roll < 0.8 && Array.isArray(root.stations)) root.stations.push(JSON.parse(JSON.stringify(rng.pick(root.stations) ?? {})));
    else if (roll < 0.9 && Array.isArray(root.flows)) root.flows.push(JSON.parse(JSON.stringify(rng.pick(root.flows) ?? {})));
    else if (root.roads && typeof root.roads === 'object') root.roads[`${rng.int(24) - 2},${rng.int(14) - 2}`] = { out: rng.int(40) - 3, limit: rng.pick(junk) };
  }
  return root;
}

test('normalizeLayout fuzz: always valid, idempotent and JSON-stable (2000 corrupted plants)', () => {
  const rng = createRng(20240607);
  const base = plant();
  L.addObstacle(base, { x: 12, y: 8, w: 3, h: 2, kind: 'rack' });
  L.addLabel(base, { x: 3.5, y: 9.25, text: 'Hall', size: 2 });
  L.addFleet(base, 'forklift');
  const bad = [];
  for (let i = 0; i < 2000; i++) {
    const n = L.normalizeLayout(corrupt(base, rng));
    const violations = L.checkInvariants(n);
    if (violations.length) bad.push(violations[0]);
    else if (JSON.stringify(L.normalizeLayout(n)) !== JSON.stringify(n)) bad.push('not idempotent');
    else if (JSON.stringify(JSON.parse(JSON.stringify(n))) !== JSON.stringify(n)) bad.push('not JSON-stable');
  }
  assert.deepEqual(bad, []);
});

test('checkInvariants reports each kind of violation (so the fuzz test above can fail)', () => {
  assert.deepEqual(L.checkInvariants(plant()), []);
  assert.deepEqual(L.checkInvariants(null), ['layout is not an object']);
  const cases = [
    ['bit', (l) => { l.roads['18,4'].out |= DIR_BIT[E]; }, /non-road or off-grid/],
    ['road under station', (l) => { l.roads['2,2'] = { out: 0 }; }, /lies under/],
    ['overlap', (l) => { l.stations[1].x = 3; }, /overlaps/],
    ['out of grid', (l) => { l.stations[2].x = 19; }, /outside the grid/],
    ['dup id', (l) => { l.stations[1].id = 's1'; }, /duplicate id/],
    ['dangling flow', (l) => { l.flows[0].to = 'nope'; }, /endpoints/],
    ['flow from sink', (l) => { l.flows[0].from = 's3'; }, /endpoints/],
    ['fleet home', (l) => { l.fleets[0].home = 's1'; }, /home is not a depot/],
    ['param range', (l) => { l.stations[0].params.batch = 0; }, /params\.batch/],
    ['non-integer cell', (l) => { l.stations[0].x = 1.5; }, /rectangle invalid/],
    ['settings', (l) => { l.settings.dt = NaN; }, /settings\.dt/],
    ['label', (l) => { l.labels.push({ id: 'l1', x: -1, y: 0, text: 'x' }); }, /position outside/],
    ['schema', (l) => { l.schema = 2; }, /schema/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const l = plant();
    mutate(l);
    assert.ok(L.checkInvariants(l).some((v) => pattern.test(v)), `${name}: ${L.checkInvariants(l)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// layoutChangeKind
// ---------------------------------------------------------------------------------------------------------

test('layoutChangeKind classifies edits as none / cosmetic / runtime / structural', () => {
  const a = plant();
  const kind = (edit) => {
    const b = L.cloneLayout(a);
    edit(b);
    return L.layoutChangeKind(a, b);
  };
  assert.equal(L.layoutChangeKind(a, a), 'none');
  assert.equal(kind(() => {}), 'none');
  assert.equal(kind((b) => { b.name = 'Renamed'; }), 'cosmetic');
  assert.equal(kind((b) => { b.notes = 'hello'; }), 'cosmetic');
  assert.equal(kind((b) => L.addLabel(b, { x: 1, y: 1, text: 'x' })), 'cosmetic');
  assert.equal(kind((b) => L.addObstacle(b, { x: 12, y: 8 })), 'cosmetic');
  assert.equal(kind((b) => { b.settings.duration = 100; }), 'cosmetic');
  for (const [key, value] of [['demandFactor', 1.5], ['speedFactor', 0.8], ['processFactor', 1.2], ['dispatch', 'oldest'], ['routing', 'congestion']]) {
    assert.ok(RUNTIME_KEYS.includes(key));
    assert.equal(kind((b) => { b.settings[key] = value; }), 'runtime', key);
  }
  assert.equal(kind((b) => { b.settings.demandFactor = 2; b.name = 'x'; b.settings.duration = 5; }), 'runtime');
  for (const [key, value] of [['seed', 9], ['warmup', 1], ['dt', 0.2], ['handedness', 'left'], ['deadlock', 'ignore']]) {
    assert.equal(kind((b) => { b.settings[key] = value; }), 'structural', key);
  }
  assert.equal(kind((b) => L.paintRoadCell(b, 1, 8)), 'structural');
  assert.equal(kind((b) => L.moveStation(b, 's1', 2, 1)), 'structural');
  assert.equal(kind((b) => { b.flows[0].weight = 3; }), 'structural');
  assert.equal(kind((b) => { b.fleets[0].count = 9; }), 'structural');
  assert.equal(kind((b) => { b.grid.cellSize = 3; }), 'structural');
  assert.equal(kind((b) => { b.schema = 2; }), 'structural');
  assert.equal(kind((b) => { b.settings.speedFactor = 2; L.moveStation(b, 's1', 2, 1); }), 'structural', 'a structural edit wins');
  assert.equal(L.layoutChangeKind(null, a), 'structural');
  assert.equal(L.layoutChangeKind(a, undefined), 'structural');
  assert.equal(L.layoutChangeKind({ a: undefined }, {}), 'none', 'undefined fields do not count');
});

// ---------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------

test('queries: lookups by id and by cell', () => {
  const l = plant();
  L.addObstacle(l, { x: 12, y: 8, w: 2, h: 2, kind: 'column' });
  const first = L.addLabel(l, { x: 3.5, y: 9.2, text: 'a' });
  const top = L.addLabel(l, { x: 3.9, y: 9.9, text: 'b' });
  assert.equal(L.getStation(l, 's2').type, 'process');
  assert.equal(L.getStation(l, 'nope'), null);
  assert.equal(L.getFlow(l, 'f1').to, 's2');
  assert.equal(L.getFleet(l, 'v1').preset, 'agv');
  assert.equal(L.stationAt(l, 9, 3).id, 's2');
  assert.equal(L.stationAt(l, 11, 3), null);
  assert.equal(L.obstacleAt(l, 13, 9).id, 'o1');
  assert.equal(L.obstacleAt(l, 14, 9), null);
  assert.equal(L.labelAt(l, 3, 9), top, 'the topmost (last) label wins');
  assert.notEqual(L.labelAt(l, 3, 9), first);
  assert.equal(L.labelAt(l, 4, 9), null);
  assert.deepEqual(L.roadAt(l, 5, 4), { out: DIR_BIT[E] | DIR_BIT[W], limit: 1 });
  assert.equal(L.roadAt(l, 5, 5), null);
  assert.equal(L.hasLink(l, 5, 4, E), true);
  assert.equal(L.hasLink(l, 5, 4, N), false);
  assert.equal(L.hasLink(l, 18, 4, E), false);
  assert.deepEqual(L.flowsFrom(l, 's2').map((f) => f.id), ['f2']);
  assert.deepEqual(L.flowsTo(l, 's2').map((f) => f.id), ['f1']);
});

test('queries: free cells and rectangles, docks, road statistics', () => {
  const l = plant();
  assert.equal(L.isCellFree(l, 0, 0), true);
  assert.equal(L.isCellFree(l, 3, 3), false, 'station');
  assert.equal(L.isCellFree(l, 3, 3, { ignoreStation: 's1' }), true);
  assert.equal(L.isCellFree(l, 5, 4), true, 'roads are ignored');
  assert.equal(L.isCellFree(l, -1, 0), false);
  assert.equal(L.isCellFree(l, 20, 0), false);
  assert.equal(L.isCellFree(l, 1.5, 0), false);
  assert.equal(L.isRectFree(l, { x: 0, y: 6, w: 4, h: 3 }), true);
  assert.equal(L.isRectFree(l, { x: 0, y: 3, w: 4, h: 3 }), false, 'overlaps a road and a station');
  assert.equal(L.isRectFree(l, { x: 0, y: 4, w: 2, h: 1 }), false, 'road');
  assert.equal(L.isRectFree(l, { x: 0, y: 4, w: 2, h: 1 }, { allowRoads: true }), true);
  assert.equal(L.isRectFree(l, { x: 2, y: 2, w: 3, h: 2 }, { ignoreStation: 's1', allowRoads: true }), true);
  assert.equal(L.isRectFree(l, { x: 19, y: 0, w: 2, h: 1 }), false, 'out of bounds');
  assert.equal(L.isRectFree(l, { x: 0, y: 0, w: 0, h: 1 }), false);
  assert.equal(L.isRectFree(l, { x: 0, y: 0, w: 1, h: NaN }), false);
  L.addObstacle(l, { x: 12, y: 8, w: 2, h: 2 });
  assert.equal(L.isRectFree(l, { x: 13, y: 9, w: 2, h: 2 }), false);
  assert.equal(L.isRectFree(l, { x: 13, y: 9, w: 2, h: 2 }, { ignoreObstacle: 'o1' }), true);

  assert.deepEqual(L.docksOf(l, 's1'), [[2, 4], [3, 4], [4, 4]]);
  assert.deepEqual(L.docksOf(l, 's4'), [[8, 4], [9, 4], [10, 4]], 'a road cell can be a dock of two stations');
  assert.deepEqual(L.docksOf(l, L.addStation(l, { type: 'sink', x: 0, y: 9 }).id), [], 'not next to a road');
  assert.deepEqual(L.docksOf(l, 'nope'), []);
  assert.equal(L.roadCellCount(l), 18);
  assert.equal(L.roadLengthMeters(l), 36);
});

// ---------------------------------------------------------------------------------------------------------
// Road mutators
// ---------------------------------------------------------------------------------------------------------

test('paintRoadPath: fills gaps with an L path, links along the stroke, merges and never removes links', () => {
  const l = L.createLayout({ cols: 12, rows: 10 });
  assert.equal(L.paintRoadPath(l, [[1, 1], [4, 1]]), 4);
  assert.deepEqual(l.roads['1,1'], { out: DIR_BIT[E] });
  assert.deepEqual(l.roads['2,1'], { out: DIR_BIT[E] | DIR_BIT[W] });
  assert.deepEqual(l.roads['4,1'], { out: DIR_BIT[W] });
  const before = snapshot(l);
  assert.equal(L.paintRoadPath(l, [[1, 1], [4, 1]], { oneWay: true }), 4);
  assert.deepEqual(l, before, 'a one-way stroke over a two-way road changes nothing');

  assert.equal(L.paintRoadPath(l, [[1, 3], [3, 3]], { oneWay: true }), 3);
  assert.deepEqual([l.roads['1,3'].out, l.roads['2,3'].out, l.roads['3,3'].out], [DIR_BIT[E], DIR_BIT[E], 0]);
  assert.equal(L.hasLink(l, 1, 1, S), false, 'parallel roads are not connected');
  assert.equal(L.paintRoadPath(l, [[3, 3], [1, 3]]), 3, 'repainting two-way adds the reverse links');
  assert.deepEqual([l.roads['1,3'].out, l.roads['3,3'].out], [DIR_BIT[E], DIR_BIT[W]]);

  assert.equal(L.paintRoadPath(l, [[6, 6], [8, 8]]), 5, 'L-shaped gap: horizontal leg first');
  assert.ok(l.roads['8,6'] && l.roads['8,7'] && !l.roads['6,8']);
  assert.equal(L.paintRoadPath(l, [[6, 6], [6, 6]]), 1);
});

test('paintRoadPath: stops at stations, obstacles and the grid edge; ignores junk', () => {
  const l = L.createLayout({ cols: 12, rows: 10 });
  L.addObstacle(l, { x: 6, y: 5 });
  L.addStation(l, { type: 'sink', x: 3, y: 7, w: 2, h: 2 });
  assert.equal(L.paintRoadPath(l, [[1, 5], [10, 5]]), 5);
  assert.ok(l.roads['5,5'] && !l.roads['6,5'] && !l.roads['7,5']);
  assert.equal(L.hasLink(l, 5, 5, E), false);
  assert.equal(L.paintRoadPath(l, [[3, 7], [8, 7]]), 0, 'starting on a station');
  assert.ok(!l.roads['5,7']);
  assert.equal(L.paintRoadPath(l, [[10, 1], [15, 1]]), 2, 'stops at the edge of the grid');
  assert.equal(L.paintRoadPath(l, [[0, 0], [1e9, 0]]), 1, 'absurd gaps end the stroke');
  assert.equal(L.paintRoadPath(l, null), 0);
  assert.equal(L.paintRoadPath(l, [[0, 9], ['a', 2], [3, 9]]), 1, 'junk ends the stroke');
  assert.deepEqual(L.checkInvariants(l), []);
});

test('paintRoadCell, eraseRoadCell and eraseLink keep the link invariants', () => {
  const l = L.createLayout({ cols: 12, rows: 10 });
  L.addObstacle(l, { x: 0, y: 0 });
  assert.equal(L.paintRoadCell(l, 5, 5), true);
  assert.equal(L.paintRoadCell(l, 5, 5), false, 'exists');
  assert.equal(L.paintRoadCell(l, 0, 0), false, 'blocked');
  assert.equal(L.paintRoadCell(l, 12, 0), false, 'outside');
  L.paintRoadPath(l, [[3, 5], [7, 5]]);
  L.paintRoadPath(l, [[5, 3], [5, 7]]);
  assert.equal(l.roads['5,5'].out, 15);
  assert.equal(L.eraseLink(l, 5, 5, N), true);
  assert.equal(L.hasLink(l, 5, 5, N), false);
  assert.equal(L.hasLink(l, 5, 4, S), true, 'only the directed link is removed');
  assert.equal(L.eraseLink(l, 5, 5, N), false);
  assert.equal(L.eraseLink(l, 9, 9, N), false);
  assert.equal(L.eraseLink(l, 5, 5, 7), false);
  assert.equal(L.eraseRoadCell(l, 5, 5), true);
  for (const [cx, cy, dir] of [[4, 5, E], [6, 5, W], [5, 4, S], [5, 6, N]]) assert.equal(L.hasLink(l, cx, cy, dir), false);
  assert.equal(l.roads['4,5'].out & DIR_BIT[E], 0);
  assert.equal(l.roads['5,6'].out & DIR_BIT[N], 0);
  assert.equal(L.eraseRoadCell(l, 5, 5), false);
  assert.deepEqual(L.checkInvariants(l), []);
});

test('setRoadLimit sets, clamps and removes slow zones', () => {
  const l = L.createLayout({ cols: 12, rows: 10 });
  L.paintRoadCell(l, 2, 2);
  assert.equal(L.setRoadLimit(l, 2, 2, 0.5), true);
  assert.equal(L.roadAt(l, 2, 2).limit, 0.5);
  assert.equal(L.setRoadLimit(l, 2, 2, 0.5), false, 'unchanged');
  assert.equal(L.setRoadLimit(l, 2, 2, 0), true);
  assert.equal(L.roadAt(l, 2, 2).limit, 0.1, 'clamped to 0.1');
  assert.equal(L.setRoadLimit(l, 2, 2, 1), true);
  assert.ok(!('limit' in l.roads['2,2']));
  assert.equal(L.setRoadLimit(l, 2, 2, 1), false);
  assert.equal(L.setRoadLimit(l, 2, 2, 'x'), false);
  assert.equal(L.setRoadLimit(l, 3, 3, 0.5), false, 'no road there');
});

test('flipRoadDirection cycles two-way -> one direction -> other direction -> two-way', () => {
  const l = L.createLayout({ cols: 12, rows: 10 });
  L.paintRoadPath(l, [[2, 2], [3, 2]]);
  const state = () => [L.hasLink(l, 2, 2, E), L.hasLink(l, 3, 2, W)];
  assert.deepEqual(state(), [true, true]);
  assert.equal(L.flipRoadDirection(l, 2, 2, E), true);
  assert.deepEqual(state(), [true, false]);
  assert.equal(L.flipRoadDirection(l, 2, 2, E), true);
  assert.deepEqual(state(), [false, true]);
  assert.equal(L.flipRoadDirection(l, 2, 2, E), true);
  assert.deepEqual(state(), [true, true]);
  assert.equal(L.flipRoadDirection(l, 3, 2, W), true, 'seen from the other cell, "forward" is the other way round');
  assert.deepEqual(state(), [false, true]);
  assert.equal(L.flipRoadDirection(l, 2, 2, N), false, 'no road to the north');
  L.paintRoadCell(l, 6, 6);
  L.paintRoadCell(l, 7, 6);
  assert.equal(L.flipRoadDirection(l, 6, 6, E), false, 'neighbours without a link');
  assert.equal(L.flipRoadDirection(l, 2, 2, 9), false);
});

// ---------------------------------------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------------------------------------

test('addStation: unique ids, numbered default names, defaults from the type, rejections', () => {
  const l = L.createLayout({ cols: 20, rows: 12 });
  const a = L.addStation(l, { type: 'source', x: 0, y: 0 });
  const b = L.addStation(l, { type: 'source', x: 5, y: 0 });
  const c = L.addStation(l, { type: 'process', x: 10, y: 0, name: '  Press line ', params: { cycle: { mean: 45 }, machines: 3 } });
  assert.deepEqual([a.id, b.id, c.id], ['s1', 's2', 's3']);
  assert.deepEqual([a.name, b.name, c.name], ['Source 1', 'Source 2', 'Press line']);
  assert.deepEqual([a.w, a.h], [STATION_TYPES.source.size.w, STATION_TYPES.source.size.h]);
  assert.deepEqual(c.params.cycle, { kind: 'normal', mean: 45, spread: 0.1 }, 'distributions merge field by field');
  assert.equal(c.params.machines, 3);
  assert.equal(L.addStation(l, { type: 'process', x: 14, y: 0 }).name, 'Workstation 1');
  L.removeStation(l, 's1');
  const d = L.addStation(l, { type: 'source', x: 0, y: 5 });
  assert.deepEqual([d.id, d.name], ['s1', 'Source 1'], 'freed ids and names are reused');

  const count = l.stations.length;
  L.paintRoadCell(l, 10, 8);
  const rejected = [
    { type: 'source', x: 6, y: 1 }, // overlaps Source 2
    { type: 'source', x: 18, y: 0 }, // out of bounds
    { type: 'source', x: 10, y: 8, w: 1, h: 1 }, // road
    { type: 'warehouse', x: 0, y: 9 },
    { type: '__proto__', x: 0, y: 9 },
    { type: 'sink', x: NaN, y: 9 },
    { type: 'sink', x: 0, y: 9, w: 0 },
    { type: 'sink', x: 0, y: 9, w: 'wide' },
    null,
  ];
  for (const spec of rejected) assert.equal(L.addStation(l, spec), null, JSON.stringify(spec));
  assert.equal(l.stations.length, count);
  assert.deepEqual(L.checkInvariants(l), []);
});

test('moveStation / resizeStation reject blocked targets and never delete roads', () => {
  const l = plant();
  const before = snapshot(l);
  assert.equal(L.moveStation(l, 's1', 2, 3), false, 'onto the road');
  assert.equal(L.moveStation(l, 's1', 7, 2), false, 'onto another station');
  assert.equal(L.moveStation(l, 's1', -1, 2), false);
  assert.equal(L.moveStation(l, 's1', 'x', 2), false);
  assert.equal(L.moveStation(l, 'nope', 2, 2), false);
  assert.equal(L.resizeStation(l, 's1', { x: 2, y: 2, w: 3, h: 3 }), false, 'would cover the road');
  assert.equal(L.resizeStation(l, 's1', { x: 2, y: 2 }), false, 'incomplete rectangle');
  assert.deepEqual(l, before);
  assert.equal(L.moveStation(l, 's1', 2, 2), true, 'staying put is accepted');
  assert.equal(L.moveStation(l, 's1', 3, 0), true);
  assert.deepEqual([L.getStation(l, 's1').x, L.getStation(l, 's1').y], [3, 0]);
  assert.equal(L.resizeStation(l, 's1', { x: 3, y: 0, w: 4, h: 4 }), true);
  assert.deepEqual(L.docksOf(l, 's1').length, 4);
  assert.equal(Object.keys(l.roads).length, 18);
  assert.deepEqual(L.checkInvariants(l), []);
});

test('updateStation: name, params (merged one level deep, clamped), atomic on blocked geometry', () => {
  const l = plant();
  assert.equal(L.updateStation(l, 's2', { name: ' Assembly ', params: { cycle: { mean: 75, kind: 'uniform' }, machines: 2.4, inCap: -1, bogus: 5 } }), true);
  const s = L.getStation(l, 's2');
  assert.equal(s.name, 'Assembly');
  assert.deepEqual(s.params.cycle, { kind: 'uniform', mean: 75, spread: 0.1 });
  assert.deepEqual([s.params.machines, s.params.inCap, 'bogus' in s.params], [2, 1, false]);
  assert.equal(s.params.outPerCycle, 1, 'untouched params stay');
  assert.equal(L.updateStation(l, 's2', { name: '', id: 'zz', type: 'sink' }), true);
  assert.deepEqual([s.name, s.id, s.type], ['Assembly', 's2', 'process'], 'empty names, ids and types are ignored');
  const before = snapshot(l);
  assert.equal(L.updateStation(l, 's2', { name: 'Moved', x: 2, y: 2 }), false);
  assert.deepEqual(l, before, 'nothing applied when the geometry is rejected');
  assert.equal(L.updateStation(l, 's4', { params: { slots: 2, chargers: 9 } }), true);
  assert.equal(L.getStation(l, 's4').params.chargers, 2, 'chargers never exceed slots');
  assert.equal(L.updateStation(l, 'nope', {}), false);
  assert.equal(L.updateStation(l, 's2', null), false);
});

test('removeStation cascades to flows and fleet homes', () => {
  const l = plant();
  assert.equal(L.removeStation(l, 's2'), true);
  assert.deepEqual(l.flows, [], 'both flows touched s2');
  assert.equal(L.removeStation(l, 's4'), true);
  assert.equal(l.fleets[0].home, null);
  assert.equal(L.removeStation(l, 's4'), false);
  assert.deepEqual(L.checkInvariants(l), []);
});

test('duplicateStation: nearest free spot, own name, independent params', () => {
  const l = plant();
  L.updateStation(l, 's2', { name: 'Press 1', params: { machines: 4 } });
  const copy = L.duplicateStation(l, 's2');
  assert.equal(copy.name, 'Press 2');
  assert.equal(copy.type, 'process');
  assert.ok(copy.id !== 's2' && copy.params.machines === 4);
  copy.params.machines = 9;
  copy.params.cycle.mean = 1000;
  assert.equal(L.getStation(l, 's2').params.machines, 4);
  assert.notEqual(L.getStation(l, 's2').params.cycle.mean, 1000);
  assert.equal(L.duplicateStation(l, 's2', { dx: 0, dy: 0 }).name, 'Press 3');
  assert.deepEqual(l.flows.length, 2, 'flows are not copied');
  assert.deepEqual(L.checkInvariants(l), []);
  assert.equal(L.duplicateStation(l, 'nope'), null);

  const full = L.createLayout({ cols: 8, rows: 8 });
  const only = L.addStation(full, { type: 'storage', x: 0, y: 0, w: 8, h: 8 });
  assert.equal(L.duplicateStation(full, only.id), null, 'no room left');
});

// ---------------------------------------------------------------------------------------------------------
// Flows and fleets
// ---------------------------------------------------------------------------------------------------------

test('addFlow enforces the rules of §4.3', () => {
  const l = plant();
  L.addStation(l, { type: 'storage', x: 12, y: 8, w: 3, h: 2 }); // s5
  const bad = [['s3', 's2'], ['s1', 's1'], ['s2', 's2'], ['s4', 's2'], ['s2', 's4'], ['s2', 's1'], ['s1', 's2'], ['s1', 'zz'], ['zz', 's2']];
  for (const [from, to] of bad) assert.equal(L.addFlow(l, from, to), null, `${from}->${to}`);
  assert.equal(l.flows.length, 2);
  const f = L.addFlow(l, 's1', 's5', { weight: 3, perCycle: 0, priority: 99, batchMin: 3, maxWait: 60, fleetId: 'v1' });
  assert.deepEqual([f.id, f.weight, f.perCycle, f.priority, f.batchMin, f.maxWait, f.fleetId], ['f3', 3, 1, 3, 3, 60, 'v1']);
  assert.equal(L.addFlow(l, 's1', 's5'), null, 'duplicate pair');
  assert.equal(L.addFlow(l, 's5', 's3', { fleetId: 'v77' }), null, 'unknown fleet');
  assert.ok(L.addFlow(l, 's5', 's3'));
  assert.deepEqual(L.checkInvariants(l), []);
});

test('updateFlow patches atomically and keeps batch limits consistent', () => {
  const l = plant();
  assert.equal(L.updateFlow(l, 'f1', { weight: 2.5, batchMin: 6 }), true);
  assert.deepEqual([L.getFlow(l, 'f1').weight, L.getFlow(l, 'f1').batchMin], [2.5, 6]);
  assert.equal(L.updateFlow(l, 'f1', { batchMax: 3 }), true);
  assert.deepEqual([L.getFlow(l, 'f1').batchMin, L.getFlow(l, 'f1').batchMax], [3, 3], 'an explicit maximum lowers the minimum');
  assert.equal(L.updateFlow(l, 'f1', { batchMin: 8 }), true);
  assert.deepEqual([L.getFlow(l, 'f1').batchMin, L.getFlow(l, 'f1').batchMax], [8, 8], 'an explicit minimum raises the maximum');
  assert.equal(L.updateFlow(l, 'f1', { batchMax: 0 }), true);
  const before = snapshot(l);
  assert.equal(L.updateFlow(l, 'f1', { weight: 9, fleetId: 'nope' }), false);
  assert.equal(L.updateFlow(l, 'f1', { to: 's1' }), false, 'self flow');
  assert.equal(L.updateFlow(l, 'f1', { from: 's2', to: 's3' }), false, 'duplicate of f2');
  assert.deepEqual(l, before);
  assert.equal(L.updateFlow(l, 'f1', { fleetId: 'v1' }), true);
  assert.equal(L.getFlow(l, 'f1').fleetId, 'v1');
  assert.equal(L.updateFlow(l, 'f1', { fleetId: null }), true);
  assert.equal(L.getFlow(l, 'f1').fleetId, null);
  assert.equal(L.updateFlow(l, 'f1', { to: 's3' }), true, 're-route to another sink');
  assert.equal(L.removeFlow(l, 'f1'), true);
  assert.equal(L.removeFlow(l, 'f1'), false);
});

test('fleets: presets, unique names, battery merge, home validation, cascades', () => {
  const l = plant();
  const second = L.addFleet(l);
  assert.deepEqual([second.id, second.name, second.preset, second.speed], ['v2', 'AGV 2', 'agv', 1.5]);
  const fork = L.addFleet(l, 'forklift', { count: 3, battery: { enabled: true, runtimeMin: 100 } });
  assert.deepEqual([fork.speed, fork.count, fork.battery.enabled, fork.battery.runtimeMin, fork.battery.chargeTimeMin], [3, 3, true, 100, 90]);
  assert.equal(L.addFleet(l, 'spaceship').preset, 'custom');
  assert.equal(L.addFleet(l, 'agv', { home: 's1' }).home, null, 'an invalid home is ignored when adding');

  assert.equal(L.updateFleet(l, 'v3', { speed: 99, battery: { lowPct: 50, resumePct: 20 }, idle: 'stay', name: 'Trucks' }), true);
  const f = L.getFleet(l, 'v3');
  assert.deepEqual([f.speed, f.idle, f.name, f.battery.runtimeMin, f.battery.lowPct, f.battery.resumePct], [15, 'stay', 'Trucks', 100, 50, 50]);
  const before = snapshot(l);
  assert.equal(L.updateFleet(l, 'v3', { count: 7, home: 's1' }), false, 'home must be a depot');
  assert.equal(L.updateFleet(l, 'v3', { count: 7, home: 'nope' }), false);
  assert.deepEqual(l, before, 'rejected patches change nothing');
  assert.equal(L.updateFleet(l, 'v3', { home: 's4' }), true);
  assert.equal(L.updateFleet(l, 'v3', { home: null }), true);
  assert.equal(L.getFleet(l, 'v3').home, null);
  assert.equal(L.updateFleet(l, 'zz', {}), false);

  const dup = L.duplicateFleet(l, 'v1');
  assert.deepEqual([dup.id, dup.name], ['v6', 'AGV 4'], 'next free number in the name');
  dup.battery.enabled = true;
  assert.equal(L.getFleet(l, 'v1').battery.enabled, false, 'duplicates are deep copies');
  assert.equal(L.duplicateFleet(l, 'zz'), null);

  L.updateFlow(l, 'f1', { fleetId: 'v2' });
  assert.equal(L.removeFleet(l, 'v2'), true);
  assert.equal(L.getFlow(l, 'f1').fleetId, null);
  assert.equal(L.removeFleet(l, 'v2'), false);
  assert.deepEqual(L.checkInvariants(l), []);
});

// ---------------------------------------------------------------------------------------------------------
// Obstacles, labels, grid
// ---------------------------------------------------------------------------------------------------------

test('obstacles: add, update, remove; never over roads, stations or each other', () => {
  const l = plant();
  const o = L.addObstacle(l, { x: 12, y: 8, w: 2, h: 3, kind: 'rack' });
  assert.deepEqual([o.id, o.kind, o.w, o.h], ['o1', 'rack', 2, 3]);
  assert.equal(L.addObstacle(l, { x: 0, y: 0, kind: 'bogus' }).kind, 'wall');
  for (const spec of [{ x: 5, y: 4 }, { x: 3, y: 3 }, { x: 12, y: 9 }, { x: 19, y: 0, w: 2 }, { x: NaN, y: 0 }, null]) {
    assert.equal(L.addObstacle(l, spec), null, JSON.stringify(spec));
  }
  assert.equal(L.updateObstacle(l, 'o1', { x: 14 }), true);
  assert.equal(L.updateObstacle(l, 'o1', { y: 3 }), false, 'would cover the road');
  assert.equal(L.updateObstacle(l, 'o1', { kind: 'moat' }), false);
  assert.equal(L.updateObstacle(l, 'o1', { x: 16, kind: 'column' }), true);
  assert.deepEqual([L.obstacleAt(l, 16, 8).kind, L.obstacleAt(l, 14, 8)], ['column', null]);
  assert.equal(L.updateObstacle(l, 'zz', {}), false);
  assert.equal(L.removeObstacle(l, 'o1'), true);
  assert.equal(L.removeObstacle(l, 'o1'), false);
  assert.ok(OBSTACLE_KINDS.every((kind) => L.addObstacle(l, { x: 0, y: 8 + OBSTACLE_KINDS.indexOf(kind), kind })));
  assert.deepEqual(L.checkInvariants(l), []);
});

test('labels: add, update, remove with clamping', () => {
  const l = plant();
  const a = L.addLabel(l, { x: 2.5, y: 8.5, text: '  Hall  ', size: 99 });
  assert.deepEqual([a.id, a.text, a.size], ['l1', 'Hall', 8]);
  assert.equal(L.addLabel(l, { x: 2, y: 3, text: '' }).text, 'Label');
  assert.ok(!('size' in L.addLabel(l, { x: 2, y: 3, text: 'x' })));
  const far = L.addLabel(l, { x: -4, y: 500, text: 'far' });
  assert.deepEqual([far.x, far.y], [0, 12], 'clamped into the grid');
  assert.equal(L.addLabel(l, { x: NaN, y: 1, text: 'x' }), null);
  assert.equal(L.addLabel(l, null), null);
  assert.equal(L.updateLabel(l, 'l1', { x: 5, text: 'Dock', size: null }), true);
  assert.deepEqual([a.x, a.text, 'size' in a], [5, 'Dock', false]);
  assert.equal(L.updateLabel(l, 'l1', { text: '   ' }), true);
  assert.equal(a.text, 'Dock', 'blank text keeps the old text');
  assert.equal(L.updateLabel(l, 'l1', { x: 'far' }), false);
  assert.equal(L.updateLabel(l, 'nope', {}), false);
  assert.equal(L.removeLabel(l, 'l1'), true);
  assert.equal(L.removeLabel(l, 'l1'), false);
  assert.deepEqual(L.checkInvariants(l), []);
});

test('resizeGrid clips and drops what falls outside and reports how much was removed', () => {
  const l = plant();
  L.addObstacle(l, { x: 12, y: 8, w: 6, h: 3 });
  L.addObstacle(l, { x: 18, y: 0 });
  L.addLabel(l, { x: 19.5, y: 1, text: 'edge' });
  L.addLabel(l, { x: 3, y: 1, text: 'keep' });
  assert.deepEqual(L.resizeGrid(l, 20, 12), { removed: 0 });
  const result = L.resizeGrid(l, 14, 9);
  assert.deepEqual(l.grid, { cols: 14, rows: 9, cellSize: 2 });
  assert.deepEqual(L.checkInvariants(l), []);
  assert.equal(L.getStation(l, 's3'), null, 'the sink at x=14 is gone');
  assert.deepEqual(l.flows.map((f) => f.id), ['f1'], 'its flow went with it');
  assert.equal(l.roads['14,4'], undefined);
  assert.equal(l.roads['13,4'].out & DIR_BIT[E], 0, 'links into dropped cells are cleared');
  assert.deepEqual(l.obstacles.map((o) => [o.x, o.w]), [[12, 2]], 'clipped, the second one is gone');
  assert.deepEqual(l.labels.map((x) => x.text), ['keep']);
  assert.equal(result.removed, 5 + 1 + 1 + 1 + 0, 'cells x=14..18 on the road, 1 station, 1 obstacle, 1 label');

  const clipped = L.resizeGrid(l, 10, 9);
  assert.equal(L.getStation(l, 's2').w, 2, 'a station that sticks out is clipped, not deleted');
  assert.equal(clipped.removed, 4 + 1, '4 road cells and the clipped obstacle that now lies completely outside');
  assert.equal(L.resizeGrid(l, 3, 1e9).removed, 4, '2 road cells plus the process and the depot, now completely outside');
  assert.deepEqual([l.grid.cols, l.grid.rows], [8, 160], 'clamped to the grid limits');
  assert.deepEqual(L.resizeGrid(l, 'x', undefined), { removed: 0 }, 'junk keeps the current size');
  assert.deepEqual(L.checkInvariants(l), []);
});

test('setCellSize and translateAll', () => {
  const l = plant();
  assert.equal(L.setCellSize(l, 3), true);
  assert.equal(l.grid.cellSize, 3);
  assert.equal(L.setCellSize(l, 99), true);
  assert.equal(l.grid.cellSize, 10);
  assert.equal(L.setCellSize(l, 'big'), false);
  assert.equal(l.grid.cellSize, 10);

  L.addObstacle(l, { x: 12, y: 8, w: 2, h: 2 });
  L.addLabel(l, { x: 1.5, y: 10, text: 'l' });
  const before = snapshot(l);
  assert.equal(L.translateAll(l, -2, 0), false, 'the road starts at x=1: shifting left by 2 would push cells off the grid');
  assert.deepEqual(l, before);
  L.resizeGrid(l, 24, 14);
  assert.equal(L.translateAll(l, 4, 2), true);
  assert.deepEqual([L.getStation(l, 's1').x, L.getStation(l, 's1').y], [6, 4]);
  assert.deepEqual(L.docksOf(l, 's1'), [[6, 6], [7, 6], [8, 6]], 'docks move with everything');
  assert.deepEqual([l.obstacles[0].x, l.labels[0].x, l.labels[0].y], [16, 5.5, 12]);
  assert.ok(l.roads['5,6'] && !l.roads['1,4']);
  assert.deepEqual(L.checkInvariants(l), []);
  assert.equal(L.translateAll(l, 100, 0), false);
  assert.equal(L.translateAll(l, 0.4, 'x'), false);
  assert.equal(L.translateAll(l, 0, 0), true);
});

test('updateStation: a field patched with an unusable value keeps its current value (an editor may commit NaN or an empty string)', () => {
  const l = L.createLayout({ cols: 20, rows: 12 });
  const proc = L.addStation(l, { type: 'process', x: 2, y: 2, params: { machines: 3, inCap: 7, outCap: 5, mtbf: 3600, cycle: { kind: 'exp', mean: 50, spread: 0.3 } } });
  const depot = L.addStation(l, { type: 'depot', x: 8, y: 8, params: { slots: 6, chargers: 3 } });
  const wanted = structuredClone(proc.params);
  const junk = [NaN, '', 'abc', null, Infinity, {}, [], true];
  for (const value of junk) {
    assert.equal(L.updateStation(l, proc.id, { params: { machines: value, inCap: value, outCap: value, mtbf: value, cycle: value } }), true);
    assert.deepEqual(proc.params, wanted, `junk ${String(value)} left the parameters alone`);
    L.updateStation(l, proc.id, { params: { cycle: { kind: value, mean: value, spread: value } } });
    assert.deepEqual(proc.params, wanted, `junk ${String(value)} inside the distribution left it alone`);
    L.updateStation(l, depot.id, { params: { slots: value, chargers: value } });
    assert.deepEqual(depot.params, { slots: 6, chargers: 3 });
  }
  L.updateStation(l, proc.id, { params: { machines: 5, inCap: NaN, cycle: { mean: '75', kind: 'bogus' } } });
  assert.deepEqual([proc.params.machines, proc.params.inCap, proc.params.cycle], [5, 7, { kind: 'exp', mean: 75, spread: 0.3 }], 'valid fields apply next to junk ones');
  L.updateStation(l, proc.id, { params: { inCap: 1e9, outCap: -4 } });
  assert.deepEqual([proc.params.inCap, proc.params.outCap], [1000, 1], 'numbers are still clamped to their range');
  assert.deepEqual(L.checkInvariants(l), []);
});

test('ids: names that exist on every object ("__proto__", "constructor", "toString" …) are never kept as entity ids', () => {
  const reserved = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];
  const raw = {
    stations: [...reserved.map((id, i) => ({ id, type: 'source', x: i * 3, y: 1, w: 2, h: 2 })), { id: 'ok', type: 'sink', x: 0, y: 6 }],
    obstacles: [{ id: '__proto__', x: 1, y: 9 }], labels: [{ id: 'constructor', x: 2, y: 2, text: 'l' }],
    fleets: [{ id: 'toString', count: 1 }], flows: [{ id: '__proto__', from: 's1', to: 'ok' }],
  };
  const out = L.normalizeLayout(raw);
  const ids = [...out.stations, ...out.obstacles, ...out.labels, ...out.fleets, ...out.flows].map((e) => e.id);
  assert.ok(ids.every((id) => !reserved.includes(id)), ids.join());
  assert.deepEqual(out.stations.map((x) => x.id), ['s1', 's2', 's3', 's4', 's5', 's6', 'ok']);
  assert.deepEqual(out.flows.map((f) => [f.id, f.from, f.to]), [['f1', 's1', 'ok']]);
  assert.deepEqual(L.checkInvariants(out), []);
  const bad = structuredClone(out);
  bad.stations[0].id = 'constructor';
  assert.ok(L.checkInvariants(bad).some((m) => /invalid id/.test(m)), 'the independent checker rejects them too');
  for (const id of reserved) assert.equal(L.cleanId(id), '');
  assert.equal(L.cleanId('s_1-b'), 's_1-b');
});

test('normalizeLayout: ids are assigned in linear time and exactly as the mutators would (first free number per prefix)', () => {
  const raw = {
    stations: [{ id: 's2', type: 'sink', x: 0, y: 0 }, { type: 'sink', x: 5, y: 0 }, { id: 's2', type: 'sink', x: 10, y: 0 }, { id: 's1', type: 'sink', x: 15, y: 0 }, { id: 5, type: 'sink', x: 20, y: 0 }],
    labels: Array.from({ length: 30000 }, (_, i) => ({ x: i % 40, y: i % 30, text: 't', id: i % 7 === 0 ? 'dup' : undefined })),
  };
  const t0 = performance.now();
  const out = L.normalizeLayout(raw);
  const ms = performance.now() - t0;
  assert.deepEqual(out.stations.map((x) => x.id), ['s2', 's3', 's4', 's1', '5']);
  assert.equal(new Set(out.labels.map((x) => x.id)).size, 30000);
  assert.equal(out.labels[0].id, 'dup', 'the first holder keeps a repeated id');
  assert.equal(out.labels[1].id, 'l1');
  assert.ok(ms < 1500, `30000 id-less labels took ${Math.round(ms)} ms (a copy of the id set per label would take 25 s)`);
});

test('a null options argument behaves like an omitted one', () => {
  const l = plant();
  assert.deepEqual(L.createLayout(null), L.createLayout());
  assert.equal(L.isCellFree(l, 0, 0, null), L.isCellFree(l, 0, 0));
  assert.equal(L.isRectFree(l, { x: 0, y: 0, w: 1, h: 1 }, null), L.isRectFree(l, { x: 0, y: 0, w: 1, h: 1 }));
  const two = structuredClone(l);
  assert.equal(L.paintRoadPath(two, [[1, 9], [4, 9]], null), L.paintRoadPath(l, [[1, 9], [4, 9]]));
  assert.deepEqual(two, l, 'null means two-way');
  const copy = L.duplicateStation(l, 's1', null);
  assert.ok(copy && copy.type === 'source');
  assert.deepEqual(L.checkInvariants(l), []);
});

test('setName, setNotes and updateSettings clamp like the loader does and ignore what is unusable', () => {
  const l = plant();
  assert.equal(L.setName(l, '  Werk 3\u0007 '), true);
  assert.equal(l.name, 'Werk 3');
  assert.equal(L.setName(l, '   '), true);
  assert.equal(L.setName(l, null), true);
  assert.equal(l.name, 'Werk 3', 'an empty name keeps the old one');
  L.setName(l, 'x'.repeat(500));
  assert.equal(l.name.length, 80);
  assert.equal(L.setNotes(l, 'line 1\nline 2\u0000'), true);
  assert.equal(l.notes, 'line 1\nline 2 ', 'line breaks stay, control characters become spaces');
  L.setNotes(l, undefined);
  assert.equal(l.notes, '');

  assert.equal(L.updateSettings(l, { seed: '42', duration: 1, warmup: -5, demandFactor: 99, speedFactor: 0, dt: 0.25, dispatch: 'oldest', routing: 'congestion', handedness: 'left', deadlock: 'ignore' }), true);
  assert.deepEqual(l.settings, { ...l.settings, seed: 42, duration: 60, warmup: 0, demandFactor: 10, speedFactor: 0.05, dt: 0.25, dispatch: 'oldest', routing: 'congestion', handedness: 'left', deadlock: 'ignore' });
  const before = structuredClone(l.settings);
  assert.equal(L.updateSettings(l, { seed: NaN, duration: '', demandFactor: null, dispatch: 'teleport', handedness: 7, hologram: 1 }), true);
  assert.deepEqual(l.settings, before, 'junk values and unknown keys change nothing');
  assert.equal(L.updateSettings(l, null), false);
  assert.equal(L.updateSettings(l, 'seed'), false);
  assert.deepEqual(L.checkInvariants(l), []);
  const next = structuredClone(l);
  next.settings.demandFactor = 1.5;
  assert.equal(L.layoutChangeKind(l, next), 'runtime', 'what updateSettings writes is classified as the model says');
});

// ---------------------------------------------------------------------------------------------------------
// Property test: random mutator calls never break an invariant, and rejected calls change nothing
// ---------------------------------------------------------------------------------------------------------

/** Operation table for the property test: [name, run(layout), weight]. Targets favour things that exist, so most calls succeed. */
function operations(rng) {
  const id = (l, list, prefix) => (l[list].length && rng.next() < 0.9 ? rng.pick(l[list]).id : prefix + (1 + rng.int(9)));
  const stationOf = (l, types) => {
    const pool = l.stations.filter((s) => types.includes(s.type));
    return pool.length && rng.next() < 0.95 ? rng.pick(pool).id : 's' + (1 + rng.int(9));
  };
  const randomCell = () => [rng.int(18) - 1, rng.int(14) - 1];
  const roadCell = (l) => {
    const keys = Object.keys(l.roads);
    return keys.length && rng.next() < 0.8 ? rng.pick(keys).split(',').map(Number) : randomCell();
  };
  const odd = () => rng.pick([NaN, 'x', null, -3, 1e6, 0.5, undefined]);
  const rect = () => ({ x: rng.int(16), y: rng.int(12), w: 1 + rng.int(4), h: 1 + rng.int(3) });
  const paramPatch = () => ({
    cycle: { mean: rng.next() * 300 - 20, spread: rng.next() * 2, kind: rng.pick(['const', 'exp', 'bogus']) }, machines: rng.int(5) - 1, inCap: rng.int(9),
    slots: rng.int(6), chargers: rng.int(9), capacity: rng.int(60) - 5, batch: rng.int(4), outCap: odd() ?? 3,
  });
  const FROM = ['source', 'process', 'storage'];
  const TO = ['process', 'storage', 'sink'];
  return [
    ['paintRoadPath', (l) => L.paintRoadPath(l, Array.from({ length: 1 + rng.int(5) }, () => roadCell(l)), { oneWay: rng.next() < 0.4 }), 8],
    ['paintRoadCell', (l) => L.paintRoadCell(l, ...randomCell()), 2],
    ['eraseRoadCell', (l) => L.eraseRoadCell(l, ...roadCell(l)), 2],
    ['eraseLink', (l) => L.eraseLink(l, ...roadCell(l), rng.int(5) - 1), 3],
    ['setRoadLimit', (l) => L.setRoadLimit(l, ...roadCell(l), rng.pick([0.5, 0.2, 1, 3, odd()])), 2],
    ['flipRoadDirection', (l) => L.flipRoadDirection(l, ...roadCell(l), rng.int(4)), 4],
    ['addStation', (l) => L.addStation(l, { type: rng.pick(['source', 'process', 'storage', 'sink', 'depot', 'bogus']), ...rect(), params: paramPatch() }), 5],
    ['moveStation', (l) => L.moveStation(l, id(l, 'stations', 's'), rng.int(18) - 1, rng.pick([rng.int(12), odd()])), 3],
    ['resizeStation', (l) => L.resizeStation(l, id(l, 'stations', 's'), rect()), 2],
    ['updateStation', (l) => L.updateStation(l, id(l, 'stations', 's'), { name: rng.pick(['Z', '', odd()]), params: paramPatch(), ...(rng.next() < 0.3 ? rect() : {}) }), 3],
    ['removeStation', (l) => L.removeStation(l, id(l, 'stations', 's')), 1],
    ['duplicateStation', (l) => L.duplicateStation(l, id(l, 'stations', 's'), { dx: rng.int(6) - 3, dy: rng.int(6) - 3 }), 2],
    ['addFlow', (l) => L.addFlow(l, stationOf(l, FROM), stationOf(l, TO), { weight: rng.next() * 5, fleetId: rng.pick([null, id(l, 'fleets', 'v')]) }), 6],
    ['updateFlow', (l) => L.updateFlow(l, id(l, 'flows', 'f'), { batchMin: rng.int(9), batchMax: rng.int(5), priority: rng.int(6), to: rng.next() < 0.3 ? stationOf(l, TO) : undefined }), 3],
    ['removeFlow', (l) => L.removeFlow(l, id(l, 'flows', 'f')), 1],
    ['addFleet', (l) => L.addFleet(l, rng.pick([...FLEET_PRESET_ORDER, 'bogus']), { count: rng.int(8), home: rng.pick([null, stationOf(l, ['depot'])]) }), 1],
    ['updateFleet', (l) => L.updateFleet(l, id(l, 'fleets', 'v'), { speed: rng.next() * 20, battery: { lowPct: rng.int(120), resumePct: rng.int(120), enabled: rng.next() < 0.5 }, home: rng.pick([null, stationOf(l, ['depot', 'sink'])]) }), 2],
    ['removeFleet', (l) => L.removeFleet(l, id(l, 'fleets', 'v')), 1],
    ['duplicateFleet', (l) => L.duplicateFleet(l, id(l, 'fleets', 'v')), 1],
    ['addObstacle', (l) => L.addObstacle(l, { ...rect(), kind: rng.pick(['wall', 'rack', 'column', 'x']) }), 3],
    ['updateObstacle', (l) => L.updateObstacle(l, id(l, 'obstacles', 'o'), { ...rect(), kind: rng.pick(['wall', 'moat']) }), 2],
    ['removeObstacle', (l) => L.removeObstacle(l, id(l, 'obstacles', 'o')), 1],
    ['addLabel', (l) => L.addLabel(l, { x: rng.next() * 24 - 2, y: rng.next() * 16 - 2, text: rng.pick(['T', '', 'a long label']), size: rng.pick([undefined, 2, 99]) }), 2],
    ['updateLabel', (l) => L.updateLabel(l, id(l, 'labels', 'l'), { x: rng.pick([3, 99, odd()]), text: rng.pick(['x', '']), size: rng.pick([null, 1, 'x']) }), 2],
    ['removeLabel', (l) => L.removeLabel(l, id(l, 'labels', 'l')), 1],
    ['resizeGrid', (l) => L.resizeGrid(l, 12 + rng.int(10), 10 + rng.int(8)), 1],
    ['setCellSize', (l) => L.setCellSize(l, rng.pick([0.2, 2, 3.5, 40, odd()])), 1],
    ['translateAll', (l) => L.translateAll(l, rng.int(5) - 2, rng.int(5) - 2), 1],
    ['setName', (l) => L.setName(l, rng.pick(['Werk', '', odd(), 'x'.repeat(120)])), 1],
    ['setNotes', (l) => L.setNotes(l, rng.pick(['a\nb', '', odd(), 'tab\there\u0000'])), 1],
    ['updateSettings', (l) => L.updateSettings(l, { seed: odd(), duration: odd(), demandFactor: rng.pick([0.5, 99, odd()]), dispatch: rng.pick(['oldest', 'bogus', undefined]), handedness: rng.pick(['left', 7]) }), 1],
  ];
}

/** Pick an operation with probability proportional to its weight. */
function pickOperation(ops, rng) {
  let roll = rng.next() * ops.reduce((sum, op) => sum + op[2], 0);
  for (const op of ops) {
    roll -= op[2];
    if (roll < 0) return op;
  }
  return ops[ops.length - 1];
}

test('property: 4 x 500 random mutator calls keep every invariant; rejected calls change nothing', () => {
  const touched = new Set();
  for (const seed of [1, 2, 3, 4]) {
    const rng = createRng(seed);
    const ops = operations(rng);
    const layout = L.createLayout({ cols: 16, rows: 12, cellSize: 2 });
    for (let step = 0; step < 500; step++) {
      const [name, run] = pickOperation(ops, rng);
      const before = snapshot(layout);
      const result = run(layout);
      const violations = L.checkInvariants(layout);
      assert.deepEqual(violations, [], `seed ${seed} step ${step}: ${name} -> ${violations[0]}`);
      if (result === false || result === null) assert.deepEqual(layout, before, `seed ${seed} step ${step}: rejected ${name} changed the layout`);
      if (result) touched.add(name);
      assert.equal(JSON.stringify(JSON.parse(JSON.stringify(layout))), JSON.stringify(layout), `${name} left a non-JSON value`);
    }
  }
  assert.ok(touched.size >= 20, `random calls exercised ${touched.size} different successful mutators`);
});
