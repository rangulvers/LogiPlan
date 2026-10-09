// Adversarial review of the model layer (docs/ARCHITECTURE.md 4.1-4.9): js/model/layout.js, validate.js, serialize.js,
// examples.js (and the defaults they build on). Written independently of the builder's tests:
//  * helpers here (strict JSON walk, geometry/reference checker, reachability oracle, KPI harness) share no code with them;
//  * "guard" tests pin behaviour that is correct today (random mutator sequences, hostile input, share-link round trips,
//    validation of single-fault examples, the examples running in the real simulation);
//  * tests titled "DEFECT MODEL-n (severity): ..." demonstrate a real defect and FAIL until it is fixed. The severity is the
//    reviewer's rating: high = breaks other modules or corrupts data, medium = wrong behaviour in plausible use,
//    low = polish / hardening.
// The simulation modules are imported dynamically: if they are missing the integration tests are skipped, not failed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { validateLayout } from '../js/model/validate.js';
import * as S from '../js/model/serialize.js';
import { EXAMPLES as ALL_EXAMPLES } from '../js/model/examples.js';
import { legacyExamples } from './helpers/golden.js';

/** The three legacy examples: the catalogue also holds the warehouse examples since M1 (trucks, schema 2), which have their own tests (sim.examples.warehouse.test.js). */
const EXAMPLES = legacyExamples(ALL_EXAMPLES);
import { emptyLayout, defaultGrid, RUNTIME_KEYS, GRID_LIMITS } from '../js/model/defaults.js';
import { buildGraph } from '../js/sim/graph.js';
import { createRng } from '../js/util/rng.js';
import { DX, DY, DIR_BIT, opposite, cellKey, dirFromTo, parseKey } from '../js/util/grid.js';

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

/** Freeze a value and everything below it, so any write by the code under test throws (modules are strict). */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Strict JSON-safety: plain objects/arrays/strings/booleans/null and finite, non-negative-zero numbers; no undefined. */
function assertStrictJson(value, path = '$') {
  if (typeof value === 'string') {
    assert.ok(value.isWellFormed(), `${path}: lone surrogate`);
    assert.ok(!(path.endsWith('.notes') ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value), `${path}: control character in ${JSON.stringify(value.slice(0, 20))}`);
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value) && !Object.is(value, -0), `${path}: ${value} is not a plain finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertStrictJson(v, `${path}[${i}]`));
    return;
  }
  assert.ok(typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, `${path}: not a plain object (${typeof value})`);
  for (const key of Object.keys(value)) {
    assert.notEqual(value[key], undefined, `${path}.${key} is undefined`);
    assertStrictJson(value[key], `${path}.${key}`);
  }
}

/** Valid and structuredClone-able, and the clone is the JSON round trip of the original. */
function assertPlainData(value, what) {
  assertStrictJson(value, what);
  assert.deepEqual(structuredClone(value), JSON.parse(JSON.stringify(value)), `${what}: structuredClone differs from the JSON round trip`);
}

/**
 * Geometry and reference rules of docs 4.1-4.3, written from scratch (does not call layout.js). Returns the violations.
 */
function geometryProblems(l) {
  const bad = [];
  const { cols, rows } = l.grid;
  const owner = new Array(cols * rows).fill(null);
  const claim = (kind, e) => {
    for (const k of ['x', 'y', 'w', 'h']) if (!Number.isInteger(e[k])) return bad.push(`${kind} ${e.id}: ${k} is not an integer`);
    if (e.w < 1 || e.h < 1 || e.x < 0 || e.y < 0 || e.x + e.w > cols || e.y + e.h > rows) return bad.push(`${kind} ${e.id}: outside the grid`);
    for (let y = e.y; y < e.y + e.h; y++) {
      for (let x = e.x; x < e.x + e.w; x++) {
        if (owner[y * cols + x]) bad.push(`${kind} ${e.id} overlaps ${owner[y * cols + x]} at ${x},${y}`);
        else owner[y * cols + x] = `${kind} ${e.id}`;
      }
    }
    return null;
  };
  l.stations.forEach((s) => claim('station', s));
  l.obstacles.forEach((o) => claim('obstacle', o));
  for (const [key, cell] of Object.entries(l.roads)) {
    const [x, y] = parseKey(key);
    if (!(x >= 0 && y >= 0 && x < cols && y < rows)) {
      bad.push(`road ${key} outside the grid`);
      continue;
    }
    if (owner[y * cols + x]) bad.push(`road ${key} lies under ${owner[y * cols + x]}`);
    for (let d = 0; d < 4; d++) {
      if ((cell.out & DIR_BIT[d]) && !(cellKey(x + DX[d], y + DY[d]) in l.roads)) bad.push(`road ${key}: link ${d} leads nowhere`);
    }
    if (cell.limit !== undefined && !(cell.limit >= 0.1 && cell.limit < 1)) bad.push(`road ${key}: limit ${cell.limit}`);
  }
  const stationById = new Map(l.stations.map((s) => [s.id, s]));
  const pairs = new Set();
  for (const f of l.flows) {
    const a = stationById.get(f.from);
    const b = stationById.get(f.to);
    if (!a || !b || a === b || !['source', 'process', 'storage'].includes(a.type) || !['process', 'storage', 'sink'].includes(b.type)) {
      bad.push(`flow ${f.id}: illegal endpoints ${f.from} -> ${f.to}`);
    }
    if (pairs.has(`${f.from}>${f.to}`)) bad.push(`flow ${f.id}: duplicate pair`);
    pairs.add(`${f.from}>${f.to}`);
    if (f.fleetId !== null && !l.fleets.some((v) => v.id === f.fleetId)) bad.push(`flow ${f.id}: dangling fleet ${f.fleetId}`);
  }
  for (const v of l.fleets) {
    if (v.home !== null && !(stationById.get(v.home) && stationById.get(v.home).type === 'depot')) bad.push(`fleet ${v.id}: home ${v.home} is not a depot`);
  }
  for (const s of l.stations) {
    if (s.type === 'depot' && s.params.chargers > s.params.slots) bad.push(`depot ${s.id}: more chargers than slots`);
  }
  for (const [kind, list] of [['station', l.stations], ['obstacle', l.obstacles], ['label', l.labels], ['flow', l.flows], ['fleet', l.fleets]]) {
    const ids = list.map((e) => e.id);
    if (new Set(ids).size !== ids.length) bad.push(`${kind}s: duplicate ids`);
  }
  for (const lab of l.labels) if (!(lab.x >= 0 && lab.y >= 0 && lab.x <= cols && lab.y <= rows)) bad.push(`label ${lab.id} outside the grid`);
  return bad;
}

/** No object may appear twice inside a layout (a shared reference means editing one entity silently edits another). */
function assertNoSharedReferences(layout, context) {
  const seen = new Set();
  (function walk(v, path) {
    if (v === null || typeof v !== 'object') return;
    assert.ok(!seen.has(v), `${context}: ${path} is the same object as another part of the layout`);
    seen.add(v);
    for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  })(layout, 'layout');
}

/**
 * Everything a layout must satisfy after any sequence of mutators: model checker, independent checker, strict JSON.
 * `deep` adds the (slower) structuredClone-equals-JSON-round-trip comparison.
 */
function assertHealthy(layout, context, { deep = true } = {}) {
  assert.deepEqual(L.checkInvariants(layout), [], `${context}: checkInvariants`);
  assert.deepEqual(geometryProblems(layout), [], `${context}: geometry and references`);
  assertNoSharedReferences(layout, context);
  if (deep) assertPlainData(layout, context);
  else assertStrictJson(layout, context);
}

const clone = (v) => structuredClone(v);
const byName = (l, name) => l.stations.find((s) => s.name === name);

// ---------------------------------------------------------------------------------------------------------
// 1. Conformance of the public surface (names, argument conventions, return values)
// ---------------------------------------------------------------------------------------------------------

test('conformance: every function named in docs 4.6-4.9 is exported', () => {
  const layoutFns = ['createLayout', 'normalizeLayout', 'cloneLayout', 'layoutChangeKind', 'getStation', 'getFlow', 'getFleet', 'stationAt',
    'obstacleAt', 'labelAt', 'roadAt', 'hasLink', 'isCellFree', 'isRectFree', 'docksOf', 'flowsFrom', 'flowsTo', 'roadCellCount',
    'roadLengthMeters', 'paintRoadPath', 'paintRoadCell', 'eraseRoadCell', 'eraseLink', 'setRoadLimit', 'flipRoadDirection', 'addStation',
    'moveStation', 'resizeStation', 'updateStation', 'removeStation', 'duplicateStation', 'addFlow', 'updateFlow', 'removeFlow', 'addFleet',
    'updateFleet', 'removeFleet', 'duplicateFleet', 'addObstacle', 'updateObstacle', 'removeObstacle', 'addLabel', 'updateLabel',
    'removeLabel', 'resizeGrid', 'setCellSize', 'translateAll'];
  for (const name of layoutFns) assert.equal(typeof L[name], 'function', `layout.js exports ${name}`);
  for (const name of ['exportProject', 'importProject', 'encodeShare', 'decodeShare', 'shareUrl']) assert.equal(typeof S[name], 'function', name);
  assert.equal(typeof validateLayout, 'function');
  assert.ok(Array.isArray(EXAMPLES) && EXAMPLES.length >= 3);
});

test('conformance: return values have the documented types (objects from add*, null for "not found", booleans from the rest)', () => {
  const l = L.createLayout({ cols: 24, rows: 14 });
  assert.equal(typeof L.paintRoadPath(l, [[1, 7], [20, 7]]), 'number');
  const src = L.addStation(l, { type: 'source', x: 2, y: 4 });
  const proc = L.addStation(l, { type: 'process', x: 8, y: 4 });
  const sink = L.addStation(l, { type: 'sink', x: 14, y: 4 });
  const depot = L.addStation(l, { type: 'depot', x: 8, y: 8 });
  for (const s of [src, proc, sink, depot]) assert.ok(s && typeof s.id === 'string' && l.stations.includes(s), 'the created station object is the one stored in the layout');
  const flow = L.addFlow(l, src.id, proc.id);
  const fleet = L.addFleet(l);
  const obstacle = L.addObstacle(l, { x: 20, y: 1, w: 2, h: 2, kind: 'rack' });
  const label = L.addLabel(l, { x: 3.5, y: 1.25, text: 'Hall' });
  for (const [created, list] of [[flow, l.flows], [fleet, l.fleets], [obstacle, l.obstacles], [label, l.labels]]) {
    assert.ok(created && list.includes(created), 'add* returns the stored object');
  }
  assert.equal(L.addFlow(l, src.id, proc.id), null, 'duplicate flow');
  assert.equal(L.addStation(l, { type: 'sink', x: 2, y: 4 }), null, 'overlap');
  assert.equal(L.addObstacle(l, { x: 8, y: 4 }), null, 'overlap');
  assert.equal(L.duplicateStation(l, 'nope'), null);
  assert.equal(L.duplicateFleet(l, 'nope'), null);
  assert.equal(L.getStation(l, 'nope'), null);
  assert.equal(L.getFlow(l, 'nope'), null);
  assert.equal(L.getFleet(l, 'nope'), null);
  assert.equal(L.stationAt(l, 0, 0), null);
  assert.equal(L.obstacleAt(l, 0, 0), null);
  assert.equal(L.labelAt(l, 0, 0), null);
  assert.equal(L.roadAt(l, 0, 0), null);
  for (const fn of [() => L.paintRoadCell(l, 0, 0), () => L.eraseRoadCell(l, 1, 7), () => L.eraseLink(l, 2, 7, 1),
    () => L.setRoadLimit(l, 3, 7, 0.5), () => L.flipRoadDirection(l, 4, 7, 1), () => L.moveStation(l, src.id, 3, 4),
    () => L.resizeStation(l, src.id, { x: 3, y: 4, w: 3, h: 2 }), () => L.updateStation(l, src.id, { name: 'X' }),
    () => L.removeFlow(l, flow.id), () => L.updateFlow(l, 'f9', {}), () => L.updateFleet(l, fleet.id, { count: 3 }),
    () => L.updateObstacle(l, obstacle.id, { kind: 'wall' }), () => L.removeObstacle(l, 'zz'), () => L.updateLabel(l, label.id, { text: 'T' }),
    () => L.removeLabel(l, 'zz'), () => L.setCellSize(l, 2.5), () => L.translateAll(l, 0, 0), () => L.removeFleet(l, 'zz'), () => L.removeStation(l, 'zz')]) {
    assert.equal(typeof fn(), 'boolean');
  }
  const resized = L.resizeGrid(l, 24, 14);
  assert.deepEqual(Object.keys(resized), ['removed']);
  assert.ok(Number.isInteger(resized.removed) && resized.removed >= 0);
  const roadCell = L.roadAt(l, 5, 7);
  assert.deepEqual(Object.keys(roadCell).sort(), ['limit', 'out']);
  assert.ok(L.docksOf(l, proc.id).every((c) => Array.isArray(c) && c.length === 2));
  assert.ok(['none', 'cosmetic', 'runtime', 'structural'].includes(L.layoutChangeKind(l, l)));
  assert.notEqual(L.cloneLayout(l), l);
  assert.deepEqual(L.cloneLayout(l), l);
  assertHealthy(l, 'conformance plant');
});

test('conformance: createLayout is emptyLayout plus clamped overrides; cloneLayout is a deep, independent copy', () => {
  assert.deepEqual(L.createLayout(), emptyLayout());
  assert.deepEqual(L.createLayout({ cols: 30 }).grid, { cols: 30, rows: 32, cellSize: 2 });
  assert.deepEqual(L.createLayout({ rows: 5000, cellSize: 99 }).grid, { cols: 48, rows: GRID_LIMITS.maxRows, cellSize: 10 });
  const l = EXAMPLES[1].build();
  const c = L.cloneLayout(l);
  c.stations[0].params.outCap = 77;
  c.roads[Object.keys(c.roads)[0]].out = 0;
  c.fleets[0].battery.enabled = !c.fleets[0].battery.enabled;
  assert.deepEqual(l, EXAMPLES[1].build(), 'editing the clone never touches the original');
});

test('conformance: update* calls are atomic - a patch with one bad field changes nothing, at any position in the patch', () => {
  const l = EXAMPLES[1].build();
  const flow = l.flows[0];
  const fleet = l.fleets[0];
  const station = l.stations.find((s) => s.type === 'process');
  const obstacle = l.obstacles[0];
  const depot = l.stations.find((s) => s.type === 'depot');
  const taken = l.stations.find((s) => s.id !== station.id && s.type !== 'sink');
  const cases = [
    ['updateFlow', () => L.updateFlow(l, flow.id, { weight: 4, priority: 3, fleetId: 'ghost' })],
    ['updateFlow (endpoint)', () => L.updateFlow(l, flow.id, { weight: 4, to: flow.from })],
    ['updateFlow (late bad field)', () => L.updateFlow(l, flow.id, { fleetId: 'ghost', weight: 4 })],
    ['updateFleet', () => L.updateFleet(l, fleet.id, { count: 9, speed: 2, home: station.id })],
    ['updateFleet (late bad field)', () => L.updateFleet(l, fleet.id, { home: 'ghost', count: 9, battery: { enabled: true } })],
    ['updateStation', () => L.updateStation(l, station.id, { name: 'Moved', params: { machines: 4 }, x: taken.x, y: taken.y })],
    ['updateObstacle', () => L.updateObstacle(l, obstacle.id, { x: depot.x, y: depot.y, kind: 'column' })],
    ['updateObstacle (bad kind)', () => L.updateObstacle(l, obstacle.id, { x: obstacle.x, y: obstacle.y, kind: 'moat' })],
    ['updateLabel', () => L.updateLabel(l, l.labels[0].id, { text: 'New', x: 'far' })],
    ['resizeStation', () => L.resizeStation(l, station.id, { x: station.x, y: station.y, w: station.w + 30, h: station.h })],
  ];
  for (const [name, call] of cases) {
    const before = clone(l);
    assert.equal(call(), false, name);
    assert.deepEqual(l, before, `${name} changed the layout although it was rejected`);
  }
});

test('DEFECT MODEL-1 (medium): defaults.emptyLayout keeps the unspecified grid fields when a partial grid is passed (createLayout is documented as emptyLayout + overrides)', () => {
  assert.deepEqual(emptyLayout({ grid: { cols: 40 } }).grid, { cols: 40, rows: 32, cellSize: 2 }, 'rows and cellSize are lost: `...overrides` is spread over the merged grid');
  assert.deepEqual(defaultGrid({ rows: 10 }), { cols: 48, rows: 10, cellSize: 2 });
  assert.equal(emptyLayout({ name: 'X' }).name, 'X');
  assert.deepEqual(emptyLayout({ settings: { seed: 9 } }).settings.seed, 9);
});

// ---------------------------------------------------------------------------------------------------------
// 2. Property test: random mutator sequences, with oracles for the cascades
// ---------------------------------------------------------------------------------------------------------

/** One random mutator call. Returns { name, result, check(before, layout) } where check asserts operation-specific oracles. */
function randomOperation(rng, l) {
  const pickId = (list, prefix) => (l[list].length && rng.next() < 0.92 ? rng.pick(l[list]).id : prefix + (1 + rng.int(9)));
  const cell = () => [rng.int(32) - 1, rng.int(22) - 1];
  const rect = () => ({ x: rng.int(28), y: rng.int(18), w: 1 + rng.int(5), h: 1 + rng.int(4) });
  const depots = () => l.stations.filter((s) => s.type === 'depot');
  const noCheck = () => {};
  const keepsRoads = (before, layout) => assert.deepEqual(layout.roads, before.roads, 'station and obstacle edits never delete or alter roads');
  const r = rng.next();
  let name;
  let result;
  let check = noCheck;
  if (r < 0.2) {
    name = 'paintRoadPath';
    result = L.paintRoadPath(l, Array.from({ length: 2 + rng.int(4) }, cell), { oneWay: rng.next() < 0.3 });
  } else if (r < 0.25) {
    name = 'eraseRoadCell';
    const c = cell();
    result = L.eraseRoadCell(l, ...c);
    check = (before, layout) => assert.ok(!(cellKey(...c) in layout.roads));
  } else if (r < 0.28) {
    name = 'eraseLink';
    result = L.eraseLink(l, ...cell(), rng.int(4));
  } else if (r < 0.32) {
    name = 'flipRoadDirection';
    result = L.flipRoadDirection(l, ...cell(), rng.int(4));
  } else if (r < 0.35) {
    name = 'setRoadLimit';
    result = L.setRoadLimit(l, ...cell(), rng.pick([0.3, 1, 0.1]));
  } else if (r < 0.43) {
    name = 'addStation';
    result = L.addStation(l, { type: rng.pick(['source', 'process', 'storage', 'sink', 'depot']), ...rect() });
    check = keepsRoads;
  } else if (r < 0.48) {
    name = 'moveStation';
    result = L.moveStation(l, pickId('stations', 's'), rng.int(30), rng.int(20));
    check = keepsRoads;
  } else if (r < 0.51) {
    name = 'resizeStation';
    result = L.resizeStation(l, pickId('stations', 's'), rect());
    check = keepsRoads;
  } else if (r < 0.54) {
    name = 'removeStation';
    const id = pickId('stations', 's');
    result = L.removeStation(l, id);
    check = (before, layout) => {
      if (!result) return;
      assert.deepEqual(layout.flows.map((f) => f.id), before.flows.filter((f) => f.from !== id && f.to !== id).map((f) => f.id), 'cascade: exactly the flows touching the station go');
      for (const fleet of before.fleets) assert.equal(layout.fleets.find((f) => f.id === fleet.id).home, fleet.home === id ? null : fleet.home);
      assert.equal(layout.stations.length, before.stations.length - 1);
      keepsRoads(before, layout);
    };
  } else if (r < 0.56) {
    name = 'duplicateStation';
    result = L.duplicateStation(l, pickId('stations', 's'));
    check = keepsRoads;
  } else if (r < 0.64) {
    name = 'addFlow';
    const from = l.stations.filter((s) => ['source', 'process', 'storage'].includes(s.type));
    const to = l.stations.filter((s) => ['process', 'storage', 'sink'].includes(s.type));
    result = from.length && to.length ? L.addFlow(l, rng.pick(from).id, rng.pick(to).id, { batchMin: rng.int(4), batchMax: rng.int(4) }) : null;
  } else if (r < 0.67) {
    name = 'updateFlow';
    result = L.updateFlow(l, pickId('flows', 'f'), { batchMin: rng.int(6), batchMax: rng.int(6), priority: rng.int(5) });
  } else if (r < 0.69) {
    name = 'removeFlow';
    result = L.removeFlow(l, pickId('flows', 'f'));
  } else if (r < 0.73) {
    name = 'addFleet';
    result = L.addFleet(l, rng.pick(['agv', 'forklift', 'tugger', 'custom']), { count: rng.int(5), home: depots().length ? rng.pick(depots()).id : undefined });
  } else if (r < 0.76) {
    name = 'updateFleet';
    result = L.updateFleet(l, pickId('fleets', 'v'), { home: depots().length && rng.next() < 0.7 ? rng.pick(depots()).id : null, battery: { lowPct: rng.int(100), resumePct: rng.int(100) } });
  } else if (r < 0.78) {
    name = 'removeFleet';
    const id = pickId('fleets', 'v');
    result = L.removeFleet(l, id);
    check = (before, layout) => {
      if (result) for (const f of layout.flows) assert.notEqual(f.fleetId, id);
    };
  } else if (r < 0.79) {
    name = 'duplicateFleet';
    result = L.duplicateFleet(l, pickId('fleets', 'v'));
  } else if (r < 0.84) {
    name = 'addObstacle';
    result = L.addObstacle(l, { ...rect(), kind: rng.pick(['wall', 'rack', 'column']) });
    check = keepsRoads;
  } else if (r < 0.86) {
    name = 'updateObstacle';
    result = L.updateObstacle(l, pickId('obstacles', 'o'), rect());
    check = keepsRoads;
  } else if (r < 0.87) {
    name = 'removeObstacle';
    result = L.removeObstacle(l, pickId('obstacles', 'o'));
  } else if (r < 0.9) {
    name = 'addLabel';
    result = L.addLabel(l, { x: rng.next() * 34 - 2, y: rng.next() * 24 - 2, text: `T${rng.int(99)}` });
  } else if (r < 0.91) {
    name = 'updateLabel';
    result = L.updateLabel(l, pickId('labels', 'l'), { x: rng.next() * 30, y: rng.next() * 20 });
  } else if (r < 0.92) {
    name = 'removeLabel';
    result = L.removeLabel(l, pickId('labels', 'l'));
  } else if (r < 0.96) {
    name = 'resizeGrid';
    const c = 20 + rng.int(14);
    const rr = 14 + rng.int(10);
    result = L.resizeGrid(l, c, rr);
    check = (before, layout) => resizeGridOracle(before, layout, c, rr, result);
  } else if (r < 0.97) {
    name = 'setCellSize';
    result = L.setCellSize(l, rng.pick([1, 2, 2.5, 4]));
  } else {
    name = 'translateAll';
    const dx = rng.int(5) - 2;
    const dy = rng.int(5) - 2;
    result = L.translateAll(l, dx, dy);
    check = (before, layout) => translateOracle(before, layout, dx, dy, result);
  }
  return { name, result, check };
}

/** resizeGrid: survivors are exactly the entities that still touch the new grid; `removed` counts the vanished ones. */
function resizeGridOracle(before, after, cols, rows, result) {
  assert.deepEqual([after.grid.cols, after.grid.rows], [cols, rows]);
  const keptRoads = Object.keys(before.roads).filter((k) => { const [x, y] = parseKey(k); return x < cols && y < rows; });
  assert.deepEqual(Object.keys(after.roads).sort(), keptRoads.sort());
  for (const k of keptRoads) {
    const [x, y] = parseKey(k);
    for (let d = 0; d < 4; d++) {
      if (cellKey(x + DX[d], y + DY[d]) in after.roads) assert.equal(after.roads[k].out & DIR_BIT[d], before.roads[k].out & DIR_BIT[d], 'links between surviving cells are kept');
    }
  }
  const touches = (e) => e.x < cols && e.y < rows;
  for (const list of ['stations', 'obstacles']) {
    assert.deepEqual(after[list].map((e) => e.id), before[list].filter(touches).map((e) => e.id), `${list}: exactly the ones that still touch the grid survive`);
    for (const e of after[list]) {
      const old = before[list].find((o) => o.id === e.id);
      assert.deepEqual([e.x, e.y, e.w, e.h], [old.x, old.y, Math.min(old.x + old.w, cols) - old.x, Math.min(old.y + old.h, rows) - old.y], 'clipped, never moved');
    }
  }
  for (const lab of before.labels) {
    const kept = after.labels.some((a) => a.id === lab.id);
    if (lab.x < cols && lab.y < rows) assert.ok(kept, 'a label strictly inside the new grid stays');
    if (lab.x > cols || lab.y > rows) assert.ok(!kept, 'a label outside the new grid goes');
  }
  const count = (l) => Object.keys(l.roads).length + l.stations.length + l.obstacles.length + l.labels.length;
  assert.equal(result.removed, count(before) - count(after), '`removed` counts every vanished road cell, station, obstacle and label');
  assert.deepEqual(after.flows.map((f) => f.id), before.flows.filter((f) => after.stations.some((s) => s.id === f.from) && after.stations.some((s) => s.id === f.to)).map((f) => f.id));
}

/** translateAll: all-or-nothing, and a success moves every coordinate by exactly (dx, dy). */
function translateOracle(before, after, dx, dy, ok) {
  if (!ok) return assert.deepEqual(after, before, 'a refused shift changes nothing');
  assert.deepEqual(Object.keys(after.roads).sort(), Object.keys(before.roads).map((k) => { const [x, y] = parseKey(k); return cellKey(x + dx, y + dy); }).sort());
  for (const k of Object.keys(before.roads)) { const [x, y] = parseKey(k); assert.deepEqual(after.roads[cellKey(x + dx, y + dy)], before.roads[k]); }
  for (const list of ['stations', 'obstacles', 'labels']) {
    assert.deepEqual(after[list].map((e) => [e.id, e.x, e.y]), before[list].map((e) => [e.id, e.x + dx, e.y + dy]), list);
  }
  return null;
}

test('property: 1000 random mutator calls (2 seeds x 500) keep every invariant, honour the oracles and stay a fixed point of normalizeLayout', () => {
  const seen = new Set();
  for (const seed of [101, 102]) {
    const rng = createRng(seed);
    const l = L.createLayout({ cols: 30, rows: 20, cellSize: 2 });
    for (let step = 0; step < 500; step++) {
      const before = clone(l);
      const snapshot = JSON.stringify(l);
      const { name, result, check } = randomOperation(rng, l);
      const context = `seed ${seed} step ${step} ${name}`;
      assertHealthy(l, context, { deep: step % 25 === 0 });
      if ((result === false || result === null) && JSON.stringify(l) !== snapshot) assert.deepEqual(l, before, `${context}: a rejected call must not touch the layout`);
      if (result) seen.add(name);
      check(before, l);
      if (step % 3 === 0) assert.deepEqual(L.normalizeLayout(l), l, `${context}: mutators must produce what normalizeLayout would accept unchanged`);
    }
    assert.ok(l.stations.length + Object.keys(l.roads).length > 20, `seed ${seed} built something`);
  }
  for (const name of ['paintRoadPath', 'eraseRoadCell', 'addStation', 'moveStation', 'removeStation', 'addFlow', 'addFleet', 'addObstacle', 'resizeGrid', 'translateAll', 'duplicateStation', 'updateFleet']) {
    assert.ok(seen.has(name), `${name} was exercised successfully`);
  }
});

test('property: mutators leave their inputs usable when handed junk arguments (never throw for odd-but-plain values)', () => {
  const rng = createRng(9);
  const odd = [undefined, null, NaN, Infinity, -Infinity, -0, 0, 1, -1, 2.5, 1e12, -1e12, 'a', '', '12', true, false, [], {}, [1, 2], { x: 1 }, 's1', 'f1', 'v1'];
  const base = EXAMPLES[1].build();
  const names = Object.keys(L).filter((k) => /^(paint|erase|set|flip|add|move|resize|update|remove|duplicate|translate)/.test(k));
  let calls = 0;
  for (const name of names) {
    for (let i = 0; i < 20; i++) {
      const l = clone(base);
      const before = JSON.stringify(l);
      const args = Array.from({ length: Math.max(L[name].length - 1, 2) }, () => rng.pick(odd));
      let result;
      try {
        result = L[name](l, ...args);
      } catch (err) {
        // `null` as the options argument is tracked separately (DEFECT MODEL-11); anything else is a failure
        if (!(err instanceof TypeError && /Cannot destructure|Cannot read properties of null/.test(err.message) && args.includes(null))) assert.fail(`${name}(${JSON.stringify(args)}) threw ${err.message}`);
        continue;
      }
      calls++;
      assertHealthy(l, `${name}(${JSON.stringify(args)})`, { deep: false });
      if (result === false || result === null) assert.equal(JSON.stringify(l), before, `${name}(${JSON.stringify(args)}) was rejected but changed the layout`);
    }
  }
  assert.ok(calls > names.length * 15, `${calls} calls completed`);
});

test('property: layoutChangeKind equals an independent definition on 400 random edit pairs, is symmetric and treats clones as "none"', () => {
  const rng = createRng(31);
  const base = EXAMPLES[1].build();
  const edits = [
    ['cosmetic', (l) => { l.name += '!'; }],
    ['cosmetic', (l) => { l.notes += 'n'; }],
    ['cosmetic', (l) => L.addLabel(l, { x: 1, y: 1, text: 'x' })],
    ['cosmetic', (l) => L.addObstacle(l, { x: 0, y: 0, w: 1, h: 1 })],
    ['cosmetic', (l) => { l.settings.duration += 600; }],
    ['runtime', (l) => { l.settings.demandFactor = 1.4; }],
    ['runtime', (l) => { l.settings.speedFactor = 0.7; }],
    ['runtime', (l) => { l.settings.processFactor = 1.1; }],
    ['runtime', (l) => { l.settings.dispatch = 'oldest'; }],
    ['runtime', (l) => { l.settings.routing = 'congestion'; }],
    ['structural', (l) => { l.settings.seed += 1; }],
    ['structural', (l) => { l.settings.warmup += 60; }],
    ['structural', (l) => { l.settings.dt = 0.2; }],
    ['structural', (l) => { l.settings.handedness = 'left'; }],
    ['structural', (l) => { l.settings.deadlock = 'ignore'; }],
    ['structural', (l) => L.moveStation(l, l.stations[0].id, l.stations[0].x, l.stations[0].y + 1)],
    ['structural', (l) => L.updateStation(l, l.stations[1].id, { name: 'Renamed' })],
    ['structural', (l) => L.updateFleet(l, l.fleets[0].id, { count: l.fleets[0].count + 1 })],
    ['structural', (l) => L.updateFlow(l, l.flows[0].id, { weight: 3 })],
    ['structural', (l) => L.setRoadLimit(l, ...parseKey(Object.keys(l.roads)[3]), 0.5)],
    ['structural', (l) => L.setCellSize(l, 3)],
    ['structural', (l) => L.resizeGrid(l, l.grid.cols + 2, l.grid.rows)],
  ];
  const rank = { none: 0, cosmetic: 1, runtime: 2, structural: 3 };
  for (let i = 0; i < 400; i++) {
    const next = clone(base);
    let expected = 'none';
    for (let k = rng.int(3); k >= 0; k--) {
      const [kind, edit] = rng.pick(edits);
      const snapshot = clone(next);
      edit(next);
      if (JSON.stringify(snapshot) !== JSON.stringify(next) && rank[kind] > rank[expected]) expected = kind;
    }
    if (JSON.stringify(base) === JSON.stringify(next)) expected = 'none';
    assert.equal(L.layoutChangeKind(base, next), expected, `pair ${i}`);
    assert.equal(L.layoutChangeKind(next, base), expected, `pair ${i} (reversed)`);
  }
  assert.equal(L.layoutChangeKind(base, clone(base)), 'none');
  assert.ok(RUNTIME_KEYS.every((k) => k in base.settings));
});

test('translateAll after growing the grid (the editor\'s "grow left/top") moves roads, stations, obstacles, labels and docks together, or refuses and changes nothing', () => {
  for (const example of EXAMPLES) {
    const l = example.build();
    const issuesBefore = validateLayout(l).length;
    const docksBefore = l.stations.map((s) => docksFor(l, s).length);
    const before = clone(l);
    assert.deepEqual(L.resizeGrid(l, l.grid.cols + 6, l.grid.rows + 4), { removed: 0 });
    assert.equal(L.translateAll(l, 6, 4), true);
    translateOracle(clone({ ...before, grid: l.grid }), l, 6, 4, true);
    assert.deepEqual(l.stations.map((s) => docksFor(l, s).length), docksBefore, `${example.id}: every station keeps its docks`);
    assert.equal(validateLayout(l).length, issuesBefore);
    assertHealthy(l, example.id);
    const snapshot = clone(l);
    assert.equal(L.translateAll(l, l.grid.cols, 0), false);
    const leftmost = Math.min(...Object.keys(l.roads).map((k) => parseKey(k)[0]), ...l.stations.map((e) => e.x), ...l.obstacles.map((e) => e.x), ...l.labels.map((e) => Math.floor(e.x)));
    assert.equal(L.translateAll(l, -leftmost - 1, 0), false, 'one cell too far to the left');
    assert.equal(L.translateAll(l, -leftmost, 0), true, 'exactly to the edge is fine');
    assertHealthy(l, `${example.id} shifted back`);
    assert.equal(L.translateAll(l, leftmost, 0), true);
    assert.deepEqual(l, snapshot, 'a refused shift leaves everything where it was');
  }
});

// ---------------------------------------------------------------------------------------------------------
// 3. normalizeLayout: totality, idempotence and purity on hostile input
// ---------------------------------------------------------------------------------------------------------

/** A random JSON-ish value of limited depth, biased towards things the normalizer reads. */
function randomJunk(rng, depth = 0) {
  const scalars = [null, true, false, 0, -0, 1, -1, 7, 2.5, 1e9, -1e9, 1e300, -1e300, 'abc', '', '12', ' 3 ', '__proto__', 'constructor', 'source', 'process', 'wall',
    'a'.repeat(300), '\u0000\u0001x', '\ud800', '😀', '#fff', 's1', 'f1', 'v1', '4,5'];
  const roll = rng.next();
  if (depth > 3 || roll < 0.45) return rng.pick(scalars);
  if (roll < 0.7) return Array.from({ length: rng.int(4) }, () => randomJunk(rng, depth + 1));
  const obj = {};
  for (let i = rng.int(5); i >= 0; i--) obj[rng.pick(['id', 'x', 'y', 'w', 'h', 'type', 'name', 'out', 'limit', 'from', 'to', 'kind', 'params', 'battery', 'home', 'count', 'text', '1,1', '2,2', '__proto__'])] = randomJunk(rng, depth + 1);
  return obj;
}

test('normalizeLayout: 600 random junk documents never throw, always satisfy the invariants, are idempotent and do not touch the input', () => {
  const rng = createRng(2024);
  const topKeys = ['schema', 'name', 'notes', 'grid', 'roads', 'obstacles', 'labels', 'stations', 'flows', 'fleets', 'settings', 'extra'];
  const base = EXAMPLES[1].build();
  for (let i = 0; i < 600; i++) {
    const raw = {};
    // half of the documents start from a real plant with a few fields replaced by junk
    if (i % 2) Object.assign(raw, clone(base));
    for (let k = rng.int(5); k >= 0; k--) raw[rng.pick(topKeys)] = randomJunk(rng);
    for (const key of ['stations', 'fleets', 'flows', 'obstacles', 'labels']) if (Array.isArray(raw[key]) && rng.next() < 0.5) raw[key].push(randomJunk(rng), randomJunk(rng));
    const text = JSON.stringify(raw);
    const frozen = i % 7 === 0 ? deepFreeze(JSON.parse(text === undefined ? '{}' : text)) : JSON.parse(text);
    const out = L.normalizeLayout(frozen);
    assertHealthy(out, `junk ${i}`);
    assert.deepEqual(L.normalizeLayout(out), out, `junk ${i}: idempotent`);
    assert.equal(JSON.stringify(frozen), text, `junk ${i}: the input must not be modified`);
  }
});

test('normalizeLayout repairs overlaps the way the mutators would have refused them: the first claim wins, roads under bricks and walls go, dangling references vanish', () => {
  const raw = {
    grid: { cols: 20, rows: 12, cellSize: 2 },
    stations: [
      { id: 'a', type: 'depot', x: 1, y: 1, w: 3, h: 3 },
      { id: 'b', type: 'sink', x: 3, y: 3, w: 2, h: 2 }, // overlaps a at (3,3)
      { id: 'c', type: 'source', x: 18, y: 5, w: 5, h: 2 }, // sticks out of the grid: clipped to 2 wide
      { id: 'd', type: 'process', x: 30, y: 1 }, // completely outside
      { id: 'e', type: 'storage', x: 8, y: 8, w: 2, h: 2 },
    ],
    obstacles: [{ id: 'o1', x: 3, y: 1, w: 2, h: 1, kind: 'rack' }, { id: 'o2', x: 12, y: 1, w: 2, h: 2, kind: 'column' }, { id: 'o3', x: 13, y: 2, w: 2, h: 2 }],
    roads: { '0,1': { out: 2 }, '1,1': { out: 15 }, '5,1': { out: 8 }, '4,1': { out: 3 }, '9,7': { out: 4 }, '9,6': { out: 4 }, '12,1': { out: 0 } },
    flows: [{ id: 'f1', from: 'a', to: 'b' }, { id: 'f2', from: 'e', to: 'c' }, { id: 'f3', from: 'c', to: 'e' }, { id: 'f4', from: 'c', to: 'd' }],
    fleets: [{ id: 'v1', home: 'a' }, { id: 'v2', home: 'e' }, { id: 'v3', home: 'b' }],
  };
  const n = L.normalizeLayout(raw);
  assertHealthy(n, 'repaired plant');
  assert.deepEqual(n.stations.map((s) => [s.id, s.x, s.y, s.w, s.h]), [['a', 1, 1, 3, 3], ['c', 18, 5, 2, 2], ['e', 8, 8, 2, 2]]);
  assert.deepEqual(n.obstacles.map((o) => [o.id, o.x, o.y, o.w, o.h]), [['o2', 12, 1, 2, 2]], 'o1 lies on station a, o3 on o2');
  assert.deepEqual(Object.keys(n.roads).sort(), ['0,1', '4,1', '5,1', '9,6', '9,7'], 'cells under the depot (1,1) and the column (12,1) are gone');
  assert.deepEqual(n.roads['0,1'], { out: 0 }, 'its east neighbour (1,1) vanished, so the link is cut');
  assert.deepEqual(n.roads['4,1'], { out: 2 }, 'north (4,0) is no road, east (5,1) is: only the east bit survives');
  assert.deepEqual(n.roads['5,1'], { out: 8 }, 'a link between two surviving cells stays');
  assert.deepEqual(n.roads['9,6'], { out: 4 });
  assert.deepEqual(n.roads['9,7'], { out: 0 }, 'south of it lies the storage brick');
  assert.deepEqual(n.flows.map((f) => f.id), ['f3'], 'f1 (into a dropped brick), f2 (into a source), f4 (to a dropped brick) go; the survivor keeps its id');
  assert.deepEqual(n.fleets.map((f) => [f.id, f.home]), [['v1', 'a'], ['v2', null], ['v3', null]], 'homes that are not (any longer) a depot are cleared');
});

test('normalizeLayout: non-plain object inputs and exotic values inside are survivable; non-objects throw TypeError', () => {
  for (const bad of [null, undefined, 3, 'layout', true, [], [{}]]) assert.throws(() => L.normalizeLayout(bad), TypeError, String(bad));
  const exotic = {
    name: Symbol('n'), notes: 12n, grid: { cols: new Number(40), rows: [30], cellSize: { valueOf: () => 3 } }, roads: new Map([['1,1', { out: 3 }]]),
    stations: [{ type: 'source', x: 1n, y: 1, w: 2, h: 2 }, { type: 'source', x: new Date(0), y: 1 }, Object.create(null), () => 1],
    fleets: [{ count: Infinity, speed: '1e999' }], flows: 'none', settings: { seed: '0x10', duration: [], dt: 'fast' },
  };
  const out = L.normalizeLayout(exotic);
  assertHealthy(out, 'exotic');
  assertHealthy(L.normalizeLayout(new Date()), 'a Date is an object too');
  assertHealthy(L.normalizeLayout(Object.assign(Object.create(null), { name: 'proto-less', stations: [] })), 'null-prototype object');
});

// ---------------------------------------------------------------------------------------------------------
// 4. Defects in layout.js
// ---------------------------------------------------------------------------------------------------------

test('DEFECT MODEL-2 (medium): updateStation ignores (or rejects) a junk value in params.*, it never resets the field to the type default', () => {
  const l = L.createLayout({ cols: 20, rows: 12 });
  const proc = L.addStation(l, { type: 'process', x: 2, y: 2, params: { machines: 3, inCap: 7, outCap: 5, cycle: { kind: 'exp', mean: 50, spread: 0.3 } } });
  const depot = L.addStation(l, { type: 'depot', x: 8, y: 8, params: { slots: 6, chargers: 3 } });
  const wanted = clone(proc.params);
  // the editor commits whatever the input field holds; an emptied field arrives as NaN/''/null
  L.updateStation(l, proc.id, { params: { machines: 'abc', inCap: NaN, outCap: null, cycle: { kind: 'bogus', mean: 'x', spread: undefined } } });
  assert.deepEqual(proc.params, wanted, 'the junk patch must not clobber machines (3 -> 1?), inCap (7 -> 4?), outCap or the cycle distribution (exp/50 -> normal/90?)');
  L.updateStation(l, depot.id, { params: { slots: null, chargers: '' } });
  assert.deepEqual(depot.params, { slots: 6, chargers: 3 }, 'depot slots and chargers survive a junk patch');
  const mixed = L.updateStation(l, proc.id, { params: { machines: 5, inCap: NaN } });
  assert.equal(proc.params.inCap, 7, 'the junk field keeps its value');
  assert.ok(proc.params.machines === 5 || mixed === false, 'the valid field is applied (or the whole patch rejected)');
  assert.equal(L.updateFlow(l, 'nope', { weight: NaN }), false, 'flows and fleets already behave this way');
});

test('DEFECT MODEL-3 (low): the id "__proto__" is not accepted for any entity or scenario by normalizeLayout / importProject', () => {
  const raw = {
    stations: [{ id: '__proto__', type: 'source', x: 1, y: 1 }, { id: 'ok', type: 'sink', x: 6, y: 1 }],
    obstacles: [{ id: '__proto__', x: 1, y: 6 }], labels: [{ id: '__proto__', x: 2, y: 2, text: 'l' }],
    fleets: [{ id: '__proto__', count: 1 }], flows: [{ id: '__proto__', from: 'ok', to: 'ok' }],
  };
  const out = L.normalizeLayout(raw);
  const ids = [...out.stations, ...out.obstacles, ...out.labels, ...out.fleets, ...out.flows].map((e) => e.id);
  assert.ok(!ids.includes('__proto__'), `ids ${ids.join(',')}: KPI reports and per-id maps keyed by id would silently lose or corrupt this entity`);
  const text = JSON.stringify({ app: 'logiplan', schema: 1, scenarios: [{ id: '__proto__', name: 'A', layout: {} }, { id: 'b', name: 'B', layout: {} }] });
  assert.ok(!S.importProject(text).scenarios.some((s) => s.id === '__proto__'), 'scenario ids key the per-scenario undo histories');
});

test('DEFECT MODEL-11 (low): a null options argument behaves like an omitted one instead of throwing a TypeError (destructuring defaults only cover undefined)', () => {
  const l = EXAMPLES[0].build();
  const station = l.stations[0];
  const calls = {
    paintRoadPath: () => L.paintRoadPath(l, [[0, 0], [1, 0]], null),
    duplicateStation: () => L.duplicateStation(l, station.id, null),
    isCellFree: () => L.isCellFree(l, 0, 0, null),
    isRectFree: () => L.isRectFree(l, { x: 0, y: 0, w: 1, h: 1 }, null),
  };
  const threw = Object.entries(calls).filter(([, call]) => { try { call(); return false; } catch { return true; } }).map(([name]) => name);
  assert.deepEqual(threw, [], 'these helpers throw for `null` options');
});

test('DEFECT MODEL-4 (low): normalizeLayout stays fast when many entities lack a usable id (id assignment must not be quadratic)', () => {
  const raw = { labels: Array.from({ length: 6000 }, (_, i) => ({ x: i % 40, y: i % 30, text: 't' })) };
  const t0 = performance.now();
  const out = L.normalizeLayout(raw);
  const ms = performance.now() - t0;
  assert.equal(out.labels.length, 6000);
  assert.equal(new Set(out.labels.map((x) => x.id)).size, 6000);
  assert.ok(ms < 700, `6000 id-less labels took ${Math.round(ms)} ms (nextId copies the used-id set for every entity)`);
});

// ---------------------------------------------------------------------------------------------------------
// 5. serialize.js: round trips, fallback path, corruption
// ---------------------------------------------------------------------------------------------------------

const sampleProject = () => ({
  name: 'Werk Müller – Halle 3 🏭',
  activeId: 'sc2',
  scenarios: [
    { id: 'sc1', name: 'Basis', layout: EXAMPLES[0].build() },
    { id: 'sc2', name: 'Variante B (mehr AGVs) 日本語', layout: EXAMPLES[1].build() },
    { id: 'sc3', name: 'Lab', layout: EXAMPLES[2].build() },
  ],
});

/** Run `fn` with a global temporarily hidden; always restore it. */
async function withMasked(names, fn) {
  const saved = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n));
  try {
    for (const n of names) Object.defineProperty(globalThis, n, { value: undefined, configurable: true, writable: true });
    return await fn();
  } finally {
    names.forEach((n, i) => { if (saved[i]) Object.defineProperty(globalThis, n, saved[i]); else delete globalThis[n]; });
  }
}

test('serialize: export/import is a fixed point and keeps ids, names, the active scenario and every layout exactly', () => {
  const p = sampleProject();
  const text = S.exportProject(p);
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc), ['app', 'schema', 'name', 'active', 'scenarios']);
  assert.deepEqual([doc.app, doc.schema, doc.active], ['logiplan', 1, 1]);
  const back = S.importProject(text);
  assert.deepEqual(back, p);
  assert.equal(S.exportProject(back), text, 'fixed point');
  assertPlainData(back, 'imported project');
  const asDocument = S.importProject(JSON.stringify(EXAMPLES[2].build()));
  assert.equal(asDocument.scenarios.length, 1);
  assert.deepEqual(asDocument.scenarios[0].layout, EXAMPLES[2].build(), 'a bare layout becomes a one-scenario project');
  assert.equal(S.importProject(text.charCodeAt(0) === 0xfeff ? text : `﻿${text}`).scenarios.length, 3, 'a BOM from Windows editors is tolerated');
  assert.throws(() => S.exportProject({ name: 'x', scenarios: [] }), /nothing to export/i);
});

test('serialize: junk input gets a friendly sentence, never a parser message or a stack-trace fragment', () => {
  const junk = ['', ' ', 'null', '[]', '{}', '12', '"x"', '{"scenarios":[]}', '{"scenarios":[1,{}]}', '<html></html>', '{"grid":', 'PK\u0003\u0004', '{"scenarios":{"a":1}}',
    '{"scenarios":[{"layout":null}]}', '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[['.repeat(2000)];
  for (const text of junk) {
    assert.throws(() => S.importProject(text), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^[A-Z].*\.$/, `message for ${JSON.stringify(text.slice(0, 30))}: ${err.message}`);
      assert.ok(!/JSON\.parse|Unexpected|position \d|undefined|\[object/.test(err.message), err.message);
      return true;
    });
  }
  for (const notText of [undefined, null, 5, {}, []]) assert.throws(() => S.importProject(notText), /LogiPlan/);
});

test('serialize: share links round trip (compressed and plain), tolerate every documented wrapper and keep Unicode intact', async () => {
  const p = sampleProject();
  const z = await S.encodeShare(p);
  assert.match(z, /^z\.[A-Za-z0-9_-]+$/);
  assert.ok(z.length < 12000, `three example scenarios fit in ${z.length} characters`);
  const plain = await withMasked(['CompressionStream'], () => S.encodeShare(p));
  assert.match(plain, /^p\.[A-Za-z0-9_-]+$/);
  assert.ok(plain.length > z.length * 2, 'the fallback is the uncompressed form');
  for (const link of [z, plain]) {
    assert.deepEqual(await S.decodeShare(link), p);
    for (const wrapped of [`p=${link}`, `#p=${link}`, `https://user.github.io/LogiPlan/#p=${link}`, `  ${link}\n`, `http://localhost:8080/index.html?x=1#p=${link}`]) {
      assert.deepEqual(await S.decodeShare(wrapped), p, wrapped.slice(0, 40));
    }
  }
  assert.deepEqual(await S.decodeShare(z.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (z.length % 4)) % 4)), p, 'standard base64 alphabet and padding, as chat apps may rewrite them');
  assert.equal(await S.shareUrl('https://x.test/app/?a=1#old', p), `https://x.test/app/?a=1#p=${z}`);
  assert.equal((await S.shareUrl('https://x.test/', p)).split('#p=')[1], z);
  assert.deepEqual(await S.decodeShare(await withMasked(['CompressionStream'], () => S.shareUrl('https://x.test/', p))), p, 'a plain link opens in a browser that can decompress');
  assert.equal((await S.decodeShare(z)).name, 'Werk Müller – Halle 3 🏭');
});

test('serialize: a compressed link in a browser without DecompressionStream says so; every other failure is the one damaged-link message', async () => {
  const z = await S.encodeShare(sampleProject());
  await withMasked(['DecompressionStream'], async () => {
    await assert.rejects(S.decodeShare(z), /update your browser/i);
    assert.deepEqual((await S.decodeShare(await withMasked(['CompressionStream'], () => S.encodeShare(sampleProject())))).name, sampleProject().name, 'plain links still work there');
  });
  const damaged = { message: 'This share link is damaged or from a newer version.' };
  for (const bad of ['', 'z.', 'p.', 'x.abc', 'z.@@@@', 'p.%%%', 'z.A', 'p.A', undefined, null, 42, 'https://x.test/#p=', '#p=z.', `z.${'A'.repeat(5000)}`, `p.${'e30'.repeat(10)}`, `p.${Buffer.from('[1,2,3]').toString('base64url')}`,
    `p.${Buffer.from('{"scenarios":[1]}').toString('base64url')}`, `p.${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')}`]) {
    await assert.rejects(S.decodeShare(bad), damaged, String(bad).slice(0, 30));
  }
});

test('DEFECT MODEL-5 (low): a compressed link in a browser whose DecompressionStream lacks "deflate-raw" says "update your browser", not "damaged"', async () => {
  const z = await S.encodeShare(sampleProject());
  class OldDecompressionStream {
    constructor(format) { throw new TypeError(`Unsupported compression format: '${format}'`); }
  }
  await withMasked(['DecompressionStream'], async () => {
    globalThis.DecompressionStream = OldDecompressionStream;
    await assert.rejects(S.decodeShare(z), /update your browser/i);
  });
});

test('serialize: 300 randomly damaged links either decode to a valid project or fail with the standard message (no hangs, no stray errors, no unhandled rejections)', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const rng = createRng(77);
    const alphabet = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'];
    const project = sampleProject();
    const links = [await S.encodeShare(project), await withMasked(['CompressionStream'], () => S.encodeShare(project))];
    const outcome = { ok: 0, damaged: 0 };
    for (let i = 0; i < 300; i++) {
      const link = links[i % 2];
      const pos = 2 + rng.int(link.length - 2);
      const roll = rng.next();
      const mutated = roll < 0.4 ? link.slice(0, pos) + rng.pick(alphabet) + link.slice(pos + 1)
        : roll < 0.6 ? link.slice(0, pos) + link.slice(pos + 1)
          : roll < 0.8 ? link.slice(0, pos) : link.slice(0, pos) + rng.pick(alphabet) + link.slice(pos);
      try {
        const decoded = await S.decodeShare(mutated);
        outcome.ok++;
        for (const s of decoded.scenarios) assertHealthy(s.layout, `damaged link ${i}`);
      } catch (err) {
        assert.equal(err.message, 'This share link is damaged or from a newer version.', `link ${i}: ${err.message}`);
        outcome.damaged++;
      }
    }
    assert.ok(outcome.damaged > 200, `most damage is detected (${JSON.stringify(outcome)})`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, [], 'the stream plumbing leaves no unhandled rejection behind');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('serialize: truncating a link at any point is always detected', async () => {
  const p = sampleProject();
  for (const link of [await S.encodeShare(p), await withMasked(['CompressionStream'], () => S.encodeShare(p))]) {
    for (let cut = 2; cut < link.length - 1; cut += Math.ceil(link.length / 120)) {
      await assert.rejects(S.decodeShare(link.slice(0, cut)), /damaged or from a newer version/, `cut at ${cut} of ${link.length}`);
    }
  }
});

test('DEFECT MODEL-6 (medium): importProject must not silently drop scenarios beyond the first 20 - keep them or say so in warnings', () => {
  const scenarios = Array.from({ length: 25 }, (_, i) => ({ id: `sc${i + 1}`, name: `Variant ${i + 1}`, layout: L.createLayout({ name: `L${i + 1}` }) }));
  const imported = S.importProject(S.exportProject({ name: 'Many', activeId: 'sc25', scenarios }));
  const warned = (imported.warnings || []).some((w) => /20|25|dropped|skipped|only|first|too many/i.test(w));
  assert.ok(imported.scenarios.length === 25 || warned, `${imported.scenarios.length} of 25 scenarios kept and no warning (${JSON.stringify(imported.warnings)})`);
  assert.ok(imported.scenarios.some((s) => s.id === imported.activeId), 'activeId always names a kept scenario');
});

test('DEFECT MODEL-7 (low): importProject resolves `active` against the file\'s own scenario list even when earlier entries are skipped', () => {
  const layout = L.createLayout();
  const doc = { app: 'logiplan', schema: 1, name: 'x', active: 2, scenarios: [{ id: 'a', name: 'A', layout }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', layout }] };
  const imported = S.importProject(JSON.stringify(doc));
  assert.deepEqual(imported.scenarios.map((s) => s.id), ['a', 'c']);
  assert.ok(imported.warnings && imported.warnings.length >= 1, 'the skipped scenario is reported');
  assert.equal(imported.activeId, 'c', 'the file says scenario #3 (C) was active');
  const junkFirst = { ...doc, active: 1, scenarios: [7, { id: 'a', name: 'A', layout }, { id: 'c', name: 'C', layout }] };
  assert.equal(S.importProject(JSON.stringify(junkFirst)).activeId, 'a', 'junk entries before the active one do not shift the index either');
});

test('serialize: newer schemas open with a warning and hostile keys are inert', () => {
  const future = JSON.stringify({ app: 'logiplan', schema: 7, name: 'Future', scenarios: [{ id: 'a', name: 'A', layout: { ...L.createLayout(), schema: 9, hologram: { on: true } } }] });
  const imported = S.importProject(future);
  assert.match(imported.warnings[0], /newer version/);
  assertHealthy(imported.scenarios[0].layout, 'future layout');
  assert.ok(!('hologram' in imported.scenarios[0].layout));
  const evil = '{"__proto__":{"polluted":1},"scenarios":[{"id":"a","layout":{"__proto__":{"polluted":2},"constructor":{"prototype":{"polluted":3}},"stations":[{"type":"source","x":1,"y":1,"__proto__":{"polluted":4}}]}}]}';
  const p = S.importProject(evil);
  assert.equal({}.polluted, undefined);
  assert.equal(p.scenarios[0].layout.stations.length, 1);
});

// ---------------------------------------------------------------------------------------------------------
// 6. validate.js
// ---------------------------------------------------------------------------------------------------------

const codesOf = (issues) => issues.map((i) => i.code);
const issue = (issues, code, pick = () => true) => issues.find((i) => i.code === code && pick(i));

/** Road cells edge-adjacent to a station rectangle (own implementation of the dock definition in docs 4.2). */
function docksFor(l, s) {
  const docks = [];
  for (let y = s.y - 1; y <= s.y + s.h; y++) {
    for (let x = s.x - 1; x <= s.x + s.w; x++) {
      const insideX = x >= s.x && x < s.x + s.w;
      const insideY = y >= s.y && y < s.y + s.h;
      if (insideX !== insideY && cellKey(x, y) in l.roads) docks.push([x, y]);
    }
  }
  return docks;
}

/**
 * Reachability oracle (cell + heading state search, written from the routing rule of docs 5.1): 'unreachable' when no
 * dock of `to` can be reached from the docks of `from` with free choice at the start; 'no-return' when no arrival at a
 * dock of `to` can get back to a dock of `from`; otherwise 'ok'.
 */
function reachability(l, from, to) {
  const has = (x, y) => cellKey(x, y) in l.roads;
  const exits = (x, y) => [0, 1, 2, 3].filter((d) => (l.roads[cellKey(x, y)].out & DIR_BIT[d]) && has(x + DX[d], y + DY[d]));
  const moves = (x, y, heading) => {
    const all = exits(x, y);
    const ahead = heading < 0 ? all : all.filter((d) => d !== opposite(heading));
    return ahead.length ? ahead : all;
  };
  const flood = (starts) => {
    const seen = new Map(starts.map((s) => [s.join(), s]));
    const queue = [...seen.values()];
    for (let i = 0; i < queue.length; i++) {
      const [x, y, h] = queue[i];
      for (const d of moves(x, y, h)) {
        const n = [x + DX[d], y + DY[d], d];
        if (!seen.has(n.join())) { seen.set(n.join(), n); queue.push(n); }
      }
    }
    return queue;
  };
  const isDockOf = (s) => { const set = new Set(docksFor(l, s).map((c) => c.join())); return (state) => set.has(`${state[0]},${state[1]}`); };
  const atFrom = isDockOf(from);
  const atTo = isDockOf(to);
  const arrivals = flood(docksFor(l, from).map(([x, y]) => [x, y, -1])).filter(atTo);
  if (!arrivals.length) return 'unreachable';
  return arrivals.some((a) => flood([a]).some(atFrom)) ? 'ok' : 'no-return';
}

/** Small random road network on an 8x8 baseplate with a flow between two random stations; null when degenerate. */
function randomNetwork(rng) {
  const l = L.createLayout({ cols: 8, rows: 8 });
  const types = ['source', 'process', 'storage', 'sink'];
  for (let i = 0; i < 4; i++) L.addStation(l, { type: types[i], x: rng.int(7), y: rng.int(7), w: 1 + rng.int(2), h: 1 + rng.int(2) });
  for (let s = 3 + rng.int(6); s > 0; s--) L.paintRoadPath(l, Array.from({ length: 2 + rng.int(3) }, () => [rng.int(8), rng.int(8)]), { oneWay: rng.next() < 0.5 });
  for (let e = rng.int(4); e > 0; e--) {
    const keys = Object.keys(l.roads);
    if (!keys.length) break;
    const [x, y] = parseKey(rng.pick(keys));
    if (rng.next() < 0.5) L.eraseLink(l, x, y, rng.int(4)); else L.eraseRoadCell(l, x, y);
  }
  const from = rng.pick(l.stations.filter((s) => s.type !== 'sink' && s.type !== 'depot'));
  const to = rng.pick(l.stations.filter((s) => s.type !== 'source' && s.type !== 'depot'));
  if (!from || !to || from === to || !L.addFlow(l, from.id, to.id)) return null;
  L.addFleet(l);
  return docksFor(l, from).length && docksFor(l, to).length ? { l, from, to } : null;
}

const flowVerdict = (issues) => (codesOf(issues).includes('flow-unreachable') ? 'unreachable' : codesOf(issues).includes('flow-no-return') ? 'no-return' : 'ok');

test('validate: the three examples have zero issues with the internal search and with the real sim graph, and validation never writes to its input', () => {
  for (const example of EXAMPLES) {
    const l = example.build();
    assert.deepEqual(validateLayout(l), [], `${example.id} (internal search)`);
    assert.deepEqual(validateLayout(l, { graph: buildGraph(l) }), [], `${example.id} (sim graph)`);
    const frozen = deepFreeze(example.build());
    assert.deepEqual(validateLayout(frozen), [], `${example.id} (frozen input)`);
    assert.deepEqual(validateLayout(frozen, { graph: buildGraph(frozen) }), []);
  }
  assert.deepEqual(codesOf(validateLayout(emptyLayout())), ['no-stations']);
});

test('validate: reachability equals an independent oracle on 700 random road networks (no-U-turn rule included); the sim graph never contradicts it', () => {
  const rng = createRng(4242);
  const tally = { ok: 0, unreachable: 0, 'no-return': 0, graphStricter: 0 };
  for (let n = 0; n < 700; n++) {
    const net = randomNetwork(rng);
    if (!net) continue;
    const expected = reachability(net.l, net.from, net.to);
    const own = flowVerdict(validateLayout(net.l));
    assert.equal(own, expected, `network ${n}: internal search`);
    const viaGraph = flowVerdict(validateLayout(net.l, { graph: buildGraph(net.l) }));
    // the graph judges the way back from the arrival edge of the cheapest route, so it may be stricter on "no-return" only
    if (expected === 'ok') assert.ok(viaGraph === 'ok' || viaGraph === 'no-return', `network ${n}: graph said ${viaGraph}, oracle ok`);
    else assert.equal(viaGraph, expected, `network ${n}: graph`);
    if (viaGraph !== own) tally.graphStricter++;
    tally[expected]++;
  }
  assert.ok(tally.ok > 100 && tally.unreachable > 100 && tally['no-return'] > 20, JSON.stringify(tally));
});

/** A corridor with station A at its west end and sink B in the middle; `variant` decides what lies east of B. */
function corridorPlant(variant) {
  const l = L.createLayout({ cols: 24, rows: 12 });
  L.paintRoadPath(l, [[1, 6], [9, 6]]); // two-way corridor
  const a = L.addStation(l, { type: 'source', x: 1, y: 4, w: 2, h: 2 }); // docks (1,6) (2,6)
  const b = L.addStation(l, { type: 'sink', x: 6, y: 4, w: 2, h: 2 }); // docks (6,6) (7,6)
  assert.ok(a && b && L.addFlow(l, a.id, b.id) && L.addFleet(l));
  if (variant === 'trap') L.paintRoadPath(l, [[9, 6], [14, 6]], { oneWay: true }); // the corridor continues one-way into a dead end
  if (variant === 'loop') L.paintRoadPath(l, [[9, 6], [14, 6], [14, 8], [1, 8], [1, 6]], { oneWay: true }); // ... and returns round a one-way ring
  if (variant === 'fork') {
    L.paintRoadPath(l, [[9, 6], [9, 9]]); // two-way spur south: a dead end where vehicles may reverse
    L.paintRoadPath(l, [[9, 6], [14, 6]], { oneWay: true });
  }
  return l;
}

test('validate: vehicles cannot turn round on a through road, only where it ends or round a loop (flow-no-return vs ok)', () => {
  const verdicts = {};
  for (const variant of ['dead-end', 'trap', 'loop', 'fork']) {
    const l = corridorPlant(variant);
    verdicts[variant] = flowVerdict(validateLayout(l));
    assert.equal(flowVerdict(validateLayout(l, { graph: buildGraph(l) })), verdicts[variant], `${variant}: the sim graph agrees`);
    assert.equal(verdicts[variant], reachability(l, l.stations[0], l.stations[1]), `${variant}: oracle`);
  }
  assert.deepEqual(verdicts, { 'dead-end': 'ok', trap: 'no-return', loop: 'ok', fork: 'ok' });
  const trap = validateLayout(corridorPlant('trap'));
  assert.equal(issue(trap, 'flow-no-return').severity, 'error');
  assert.ok(issue(trap, 'one-way-dead-end'), 'and the end of the one-way tail is reported as a trap');
  assert.deepEqual(codesOf(validateLayout(corridorPlant('loop'))), [], 'a one-way ring that returns to the corridor produces no issue at all');
});

/** Walk from a station's dock away from the station along the only continuation until a junction; cut the link there. */
function cutBay(l, station) {
  const linked = (x, y) => [0, 1, 2, 3].filter((d) => L.hasLink(l, x, y, d) || L.hasLink(l, x + DX[d], y + DY[d], opposite(d)));
  let [x, y] = docksFor(l, station)[0];
  let prev = null;
  for (let guard = 0; guard < 200; guard++) {
    const next = linked(x, y).map((d) => [x + DX[d], y + DY[d]]).filter(([nx, ny]) => !prev || nx !== prev[0] || ny !== prev[1]);
    if (next.length !== 1) break;
    prev = [x, y];
    [x, y] = next[0];
    if (linked(x, y).length >= 3) {
      const d = dirFromTo(prev[0], prev[1], x, y);
      L.eraseLink(l, prev[0], prev[1], d);
      L.eraseLink(l, x, y, opposite(d));
      return;
    }
  }
  assert.fail(`no junction found behind ${station.name}`);
}

test('validate: a single injected fault is reported with the matching code, severity and references (false-negative sweep on the examples)', () => {
  // 1. a station loses every road cell next to it
  for (const [id, name] of [['starter', 'Assembly'], ['two-lines', 'Press line'], ['congestion-lab', 'Inbound A']]) {
    const l = EXAMPLES.find((e) => e.id === id).build();
    const s = byName(l, name);
    for (let docks = docksFor(l, s); docks.length; docks = docksFor(l, s)) L.eraseRoadCell(l, ...docks[0]);
    const found = issue(validateLayout(l), 'station-no-dock');
    assert.ok(found, `${id}: ${name} without road`);
    assert.deepEqual([found.severity, found.refs.stationId], ['error', s.id]);
    assert.ok(!codesOf(validateLayout(l)).includes('flow-unreachable'), `${id}: no duplicate noise for flows that cannot be checked`);
  }
  // 2. the side road of a station is cut off from the rest of the network
  for (const [id, name] of [['starter', 'Assembly'], ['two-lines', 'Press line'], ['congestion-lab', 'Inbound A']]) {
    const l = EXAMPLES.find((e) => e.id === id).build();
    const s = byName(l, name);
    cutBay(l, s);
    const flowIds = l.flows.filter((f) => f.from === s.id || f.to === s.id).map((f) => f.id);
    assert.ok(flowIds.length >= 1);
    const unreachable = validateLayout(l).filter((i) => i.code === 'flow-unreachable').map((i) => i.refs.flowId);
    assert.deepEqual(unreachable.sort(), flowIds.sort(), `${id}: every flow touching ${name} is unreachable`);
    assert.deepEqual(validateLayout(l, { graph: buildGraph(l) }).filter((i) => i.code === 'flow-unreachable').map((i) => i.refs.flowId).sort(), flowIds.sort(), `${id}: also with the sim graph`);
  }
  // 2b. the only road next to a station is a lone plate
  for (const [id, name] of [['starter', 'Assembly'], ['two-lines', 'Press line'], ['congestion-lab', 'Inbound A']]) {
    const l = EXAMPLES.find((e) => e.id === id).build();
    const s = byName(l, name);
    const [dx, dy] = docksFor(l, s)[0];
    for (let d = 0; d < 4; d++) { L.eraseLink(l, dx, dy, d); L.eraseLink(l, dx + DX[d], dy + DY[d], opposite(d)); }
    const issues = validateLayout(l);
    const found = issue(issues, 'station-dock-isolated');
    assert.ok(found, `${id}: ${name} sits next to a lone plate`);
    assert.deepEqual([found.severity, found.refs.stationId, found.refs.cells], ['error', s.id, [[dx, dy]]]);
    assert.ok(codesOf(issues).includes('flow-unreachable'));
  }
  // 3. the dock of the shipping station can be entered but not left
  for (const id of ['starter', 'congestion-lab']) {
    const l = EXAMPLES.find((e) => e.id === id).build();
    const sink = l.stations.find((s) => s.type === 'sink');
    const [dx, dy] = docksFor(l, sink)[0];
    for (let d = 0; d < 4; d++) L.eraseLink(l, dx, dy, d);
    const issues = validateLayout(l);
    assert.ok(issue(issues, 'flow-no-return', (i) => i.refs.stationId === sink.id), `${id}: flow into ${sink.name} has no way back`);
    assert.ok(issue(issues, 'one-way-dead-end', (i) => i.refs.cells[0][0] === dx && i.refs.cells[0][1] === dy), `${id}: the dock is reported as a trap`);
  }
  // 4. parameter faults in the two-line plant
  const base = EXAMPLES[1].build();
  const edit = (fn) => { const l = clone(base); fn(l); return validateLayout(l); };
  const agvs = base.fleets.find((f) => f.preset === 'agv');
  const assembly = byName(base, 'Final assembly');
  const flowIntoAssembly = base.flows.find((f) => f.to === assembly.id);
  let issues = edit((l) => L.updateStation(l, agvs.home, { params: { chargers: 0 } }));
  assert.deepEqual([issue(issues, 'depot-missing').severity, issue(issues, 'depot-missing').refs.fleetId], ['error', agvs.id]);
  issues = edit((l) => L.updateFleet(l, agvs.id, { battery: { enabled: false } }));
  assert.deepEqual(issues, [], 'no battery, no chargers needed');
  issues = edit((l) => L.updateFlow(l, flowIntoAssembly.id, { perCycle: 9 }));
  assert.deepEqual(issue(issues, 'perCycle-exceeds-inCap').refs, { stationId: assembly.id, flowId: flowIntoAssembly.id });
  issues = edit((l) => { for (const f of [...l.fleets]) L.updateFleet(l, f.id, { count: 0 }); });
  assert.ok(codesOf(issues).includes('no-fleets') && codesOf(issues).filter((c) => c === 'fleet-count-zero').length === 2 && issue(issues, 'no-fleets').severity === 'error');
  issues = edit((l) => { for (const f of [...l.flows]) L.removeFlow(l, f.id); });
  assert.ok(['no-flows', 'source-no-outflow', 'sink-no-inflow', 'process-no-inflow'].every((c) => codesOf(issues).includes(c)), codesOf(issues).join());
  issues = edit((l) => L.updateFleet(l, agvs.id, { length: 2.5 }));
  assert.equal(issue(issues, 'vehicle-longer-than-cell').refs.fleetId, agvs.id);
  assert.deepEqual(edit((l) => L.updateFleet(l, agvs.id, { length: 2 })), [], 'a vehicle exactly as long as a cell is fine');
  issues = edit((l) => L.updateStation(l, byName(l, 'Central warehouse').id, { params: { capacity: 1 } }));
  assert.equal(issue(issues, 'storage-small').refs.stationId, byName(base, 'Central warehouse').id);
  issues = edit((l) => L.updateStation(l, byName(l, 'Machining').id, { name: 'press LINE' }) && L.updateStation(l, byName(l, 'Press line').id, { name: 'Press line ' }));
  assert.equal(issue(issues, 'duplicate-names').severity, 'info');
  issues = edit((l) => { l.settings.warmup = l.settings.duration; });
  assert.equal(issue(issues, 'warmup-exceeds-duration').severity, 'warning');
  issues = edit((l) => { L.updateFleet(l, agvs.id, { count: 0 }); L.updateFlow(l, flowIntoAssembly.id, { fleetId: agvs.id }); });
  assert.equal(issue(issues, 'flow-fleet-missing').severity, 'error');
  issues = edit((l) => { L.removeStation(l, agvs.home); });
  assert.ok(!codesOf(issues).includes('home-depot-missing'), 'removing the depot clears fleet.home, so nothing dangles');
  assert.ok(codesOf(edit((l) => { l.fleets[1].home = assembly.id; })).includes('home-depot-missing'));
});

test('validate: edits that do not change the plan never create an issue (false-positive sweep)', () => {
  const edits = [
    ['rename plant', (l) => { l.name = 'Other'; l.notes = 'x'; }],
    ['label', (l) => L.addLabel(l, { x: 2, y: 2, text: 'hello' })],
    ['obstacle', (l) => L.addObstacle(l, { x: 0, y: 0, w: 1, h: 1 })],
    ['runtime settings', (l) => Object.assign(l.settings, { demandFactor: 1.5, speedFactor: 0.8, processFactor: 1.2, dispatch: 'oldest', routing: 'congestion', handedness: 'left' })],
    ['bigger cells', (l) => L.setCellSize(l, 3)],
    ['bigger grid', (l) => L.resizeGrid(l, l.grid.cols + 4, l.grid.rows + 4)],
    ['shift everything', (l) => { L.resizeGrid(l, l.grid.cols + 3, l.grid.rows + 3); L.translateAll(l, 3, 3); }],
    ['seed and duration', (l) => { l.settings.seed = 77; l.settings.duration = 4 * 3600; }],
    ['more vehicles', (l) => L.updateFleet(l, l.fleets[0].id, { count: l.fleets[0].count + 1 })],
    ['slower vehicles', (l) => L.updateFleet(l, l.fleets[0].id, { speed: 0.5, accel: 0.2 })],
    ['heavier flow weights', (l) => L.updateFlow(l, l.flows[0].id, { weight: 5, priority: 3 })],
    ['slow zone on the first road cell', (l) => L.setRoadLimit(l, ...parseKey(Object.keys(l.roads)[0]), 0.5)],
    ['duplicate a station elsewhere', (l) => L.duplicateStation(l, byName(l, l.stations[0].name).id, { dx: 0, dy: 6 })],
  ];
  for (const example of EXAMPLES) {
    for (const [what, edit] of edits) {
      const l = example.build();
      edit(l);
      const issues = validateLayout(l).filter((i) => !(what === 'duplicate a station elsewhere' && ['station-no-dock', 'source-no-outflow', 'sink-no-inflow', 'process-no-inflow', 'process-no-outflow', 'duplicate-names'].includes(i.code)));
      assert.deepEqual(issues.map((i) => i.id), [], `${example.id}: ${what}`);
      assert.deepEqual(L.checkInvariants(l), [], `${example.id}: ${what}`);
    }
  }
});

test('validate: on 150 random plants every issue is plain data with a unique stable id, a message and a hint, sorted errors first', () => {
  const rng = createRng(606);
  const l = L.createLayout({ cols: 30, rows: 20 });
  const rank = { error: 0, warning: 1, info: 2 };
  const codes = new Set();
  for (let step = 0; step < 1500; step++) {
    randomOperation(rng, l);
    if (step % 10) continue;
    const issues = validateLayout(l);
    assert.deepEqual(validateLayout(clone(l)), issues, 'deterministic');
    assertPlainData(issues, `issues at step ${step}`);
    assert.equal(new Set(issues.map((i) => i.id)).size, issues.length, `step ${step}: ids unique`);
    assert.deepEqual(issues.map((i) => rank[i.severity]), issues.map((i) => rank[i.severity]).sort(), 'errors first');
    for (const i of issues) {
      codes.add(i.code);
      assert.ok(i.id.startsWith(`${i.code}:`) && typeof i.message === 'string' && i.message.length > 10 && typeof i.hint === 'string' && i.hint.length > 10, JSON.stringify(i));
      assert.ok(!/undefined|NaN|\[object|Infinity/.test(i.message + i.hint), i.message);
      for (const [x, y] of i.refs.cells || []) assert.ok(cellKey(x, y) in l.roads, `${i.code}: cell ${x},${y} is a road`);
      if (i.refs.stationId) assert.ok(l.stations.some((s) => s.id === i.refs.stationId), `${i.code}: station exists`);
      if (i.refs.flowId) assert.ok(l.flows.some((f) => f.id === i.refs.flowId), `${i.code}: flow exists`);
      if (i.refs.fleetId) assert.ok(l.fleets.some((f) => f.id === i.refs.fleetId) || i.code === 'flow-fleet-missing', `${i.code}: fleet exists`);
    }
  }
  assert.ok(codes.size >= 8, `random plants exercised ${codes.size} issue codes: ${[...codes].join(', ')}`);
});

test('DEFECT MODEL-8 (low): validateLayout copes with layouts that are not normalized (its header promises it) - missing names, params or settings must not throw', () => {
  const broken = {
    'a station without a name': (l) => { delete l.stations[0].name; },
    'a station without params': (l) => { delete l.stations[1].params; },
    'a layout without settings': (l) => { delete l.settings; },
    'a fleet without a name': (l) => { delete l.fleets[0].name; },
  };
  for (const [what, fn] of Object.entries(broken)) {
    const l = EXAMPLES[0].build();
    fn(l);
    assert.doesNotThrow(() => validateLayout(l), what);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 7. Examples: planner's view, consistency of the texts, and a run in the real simulation
// ---------------------------------------------------------------------------------------------------------

async function loadEngine() {
  try {
    const [traffic, logistics, stats, insights] = await Promise.all([
      import('../js/sim/traffic.js'), import('../js/sim/logistics.js'), import('../js/sim/stats.js'), import('../js/sim/insights.js'),
    ]);
    return { TrafficSystem: traffic.TrafficSystem, Logistics: logistics.Logistics, Stats: stats.Stats, generateInsights: insights.generateInsights, trafficWaitShare: insights.TRAFFIC_WAIT_SHARE };
  } catch {
    return null;
  }
}
const engine = await loadEngine();
const simTest = (name, fn) => test(name, { skip: engine ? false : 'simulation modules are not available' }, fn);

const runs = new Map();
/** Simulate `hours` of a layout with graph + TrafficSystem + Logistics + Stats (what the engine will wire together). Cached. */
function simulate(key, layout, hours) {
  if (runs.has(`${key}|${hours}`)) return runs.get(`${key}|${hours}`);
  const graph = buildGraph(layout);
  const traffic = new engine.TrafficSystem(graph, { handedness: layout.settings.handedness, resolveDeadlocks: layout.settings.deadlock === 'resolve' });
  const sim = { time: 0, layout, graph, traffic, settings: layout.settings };
  const stats = new engine.Stats(sim);
  const logistics = new engine.Logistics({ layout, graph, traffic, rng: createRng(layout.settings.seed), emit: (name, payload) => stats.onEvent(name, payload) });
  sim.logistics = logistics;
  const dt = layout.settings.dt;
  let measuring = false;
  for (let t = 0; t < hours * 3600; t += dt) {
    if (!measuring && t >= layout.settings.warmup) { stats.reset(); measuring = true; }
    logistics.step(dt, t);
    traffic.step(dt);
    sim.time = t + dt;
    stats.sample(dt);
  }
  const report = stats.report();
  const result = { report, insights: engine.generateInsights(report, layout), deadlocks: traffic.stats.deadlocks };
  runs.set(`${key}|${hours}`, result);
  return result;
}
const exampleRun = (id, hours = 3) => simulate(id, EXAMPLES.find((e) => e.id === id).build(), hours);

function assertFiniteNumbers(value, path = 'report') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (Array.isArray(value) || ArrayBuffer.isView(value)) Array.from(value).forEach((v, i) => assertFiniteNumbers(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertFiniteNumbers(v, `${path}.${k}`);
}

// arrival-limited output of the plants, in loads per hour (a BOM assembly needs 3 pallets / one of each source per product)
const NOMINAL_PER_HOUR = { starter: 20, 'two-lines': 20, 'congestion-lab': 36 };

simTest('examples in the real simulation: useful KPIs (throughput near the arrival rate, lead times, every flow delivers, no NaN, shares add up)', () => {
  for (const example of EXAMPLES) {
    const layout = example.build();
    const { report } = exampleRun(example.id);
    assertFiniteNumbers(report);
    const nominal = NOMINAL_PER_HOUR[example.id];
    assert.ok(report.throughput.perHour > 0.85 * nominal && report.throughput.perHour < 1.15 * nominal, `${example.id}: ${report.throughput.perHour.toFixed(1)}/h against ${nominal}/h offered`);
    assert.ok(report.leadTime.count > 20 && report.leadTime.p50 > 0 && report.leadTime.p95 >= report.leadTime.p50, `${example.id}: lead times ${JSON.stringify(report.leadTime)}`);
    assert.ok(report.wip.mean > 0.5, `${example.id}: wip`);
    for (const flow of layout.flows) assert.ok(report.flows[flow.id].delivered > 0, `${example.id}: flow ${flow.id} delivered nothing`);
    for (const fleet of layout.fleets) {
      const k = report.fleets[fleet.id];
      assert.ok(k.trips > 0, `${example.id}: ${fleet.name} made no trips`);
      assert.ok(Math.abs(Object.values(k.shares).reduce((a, b) => a + b, 0) - 1) < 1e-6, `${example.id}: ${fleet.name} state shares sum to 1`);
      assert.ok(k.utilization < 0.95, `${example.id}: ${fleet.name} is saturated from the start (${k.utilization.toFixed(2)})`);
    }
    for (const s of Object.values(report.stations)) {
      assert.ok(s.blocked < 0.2, `${example.id}: ${s.name} is blocked ${Math.round(s.blocked * 100)} % of the time`);
      assert.ok(s.yardMax <= 3, `${example.id}: ${s.name} backs up (${s.yardMax} loads in the yard) within 3 h`);
    }
  }
});

simTest('examples in the real simulation: no deadlocks (the Two-lines plant used to jam in its forklift bay: 2-5 deadlocks per 4 h with the earlier traffic engine)', () => {
  for (const example of EXAMPLES) assert.equal(exampleRun(example.id).deadlocks, 0, `${example.id}, seed ${example.build().settings.seed}`);
  const seed2 = EXAMPLES[1].build();
  seed2.settings.seed = 2;
  assert.equal(simulate('two-lines-seed2', seed2, 3).deadlocks, 0, 'two-lines, seed 2');
});

simTest('examples in the real simulation: the starter and two-lines plants raise no critical insight, the starter not even a warning', () => {
  const rank = { critical: 0, warning: 1 };
  const starter = exampleRun('starter').insights.filter((i) => i.severity in rank);
  assert.deepEqual(starter.map((i) => i.id), [], 'the starter works out of the box');
  assert.deepEqual(exampleRun('two-lines').insights.filter((i) => i.severity === 'critical').map((i) => i.id), []);
});

simTest('DEFECT MODEL-9 (medium): the congestion lab congests - waiting in traffic reaches the app\'s own congestion threshold and the verdict is not "no congestion found"', () => {
  const { report, insights } = exampleRun('congestion-lab');
  const lab = EXAMPLES.find((e) => e.id === 'congestion-lab');
  assert.ok(lab.description.toLowerCase().includes('queues'), 'the catalogue promises queues');
  assert.ok(report.traffic.waitShare >= engine.trafficWaitShare,
    `vehicles wait only ${(report.traffic.waitShare * 100).toFixed(1)} % of their driving time (the Results tab flags congestion from ${engine.trafficWaitShare * 100} %): the AGVs on the one-way loop do not queue`);
  assert.ok(!insights.some((i) => i.severity === 'good'), `the Results tab says: ${insights.filter((i) => i.severity === 'good').map((i) => i.title)}`);
  assert.ok(insights.some((i) => i.id.startsWith('traffic') || /congest/i.test(i.id + i.title)), `insights: ${insights.map((i) => i.id).join(', ')}`);
});

simTest('validate vs simulation: the errors that say "this flow cannot run" are true (no way back, unreachable, workstation that can never start)', () => {
  const starter = () => EXAMPLES[0].build();
  const faults = {
    'flow-no-return': (l) => { const [x, y] = docksFor(l, l.stations.find((s) => s.type === 'sink'))[0]; for (let d = 0; d < 4; d++) L.eraseLink(l, x, y, d); },
    'flow-unreachable': (l) => cutBay(l, l.stations.find((s) => s.type === 'process')),
    'perCycle-exceeds-inCap': (l) => L.updateFlow(l, 'f1', { perCycle: 6 }),
  };
  const baseline = simulate('starter-truth-base', starter(), 1).report.throughput.total;
  assert.ok(baseline > 5);
  for (const [code, fault] of Object.entries(faults)) {
    const l = starter();
    fault(l);
    assert.ok(validateLayout(l).some((i) => i.code === code && i.severity === 'error'), code);
    assert.equal(simulate(`starter-truth-${code}`, l, 1).report.throughput.total, 0, `${code}: the simulation really delivers nothing`);
  }
});

simTest('DEFECT MODEL-10 (medium): batch-exceeds-capacity is an error that says "can never be ready", yet the simulation clamps batchMin to the vehicle capacity and delivers at full rate', () => {
  const l = EXAMPLES[0].build();
  L.updateFlow(l, 'f1', { batchMin: 3 }); // an AGV carries 1 load
  const errors = validateLayout(l).filter((i) => i.severity === 'error').map((i) => i.code);
  const delivered = simulate('starter-batch3', l, 1).report.flows.f1.delivered;
  // consistent outcomes: no error and the flow runs (downgrade to a warning), or an error and the flow really stalls (honour batchMin)
  assert.ok(!(errors.includes('batch-exceeds-capacity') && delivered > 5),
    `the Checks tab shows a red error (${errors}) for a plan that delivers ${delivered} loads per simulated hour: downgrade it to a warning ("the batch will be limited to the vehicle capacity") or make the simulation honour batchMin as docs 5.3 specifies`);
});

simTest('examples in the real simulation: the starter tip is true - with one AGV the assembly starves, pallets pile up at the gate and lead times explode', () => {
  const two = exampleRun('starter');
  const l = EXAMPLES[0].build();
  L.updateFleet(l, l.fleets[0].id, { count: 1 });
  const one = simulate('starter-one-agv', l, 5);
  const gate = l.stations.find((s) => s.type === 'source').id;
  assert.ok(one.report.stations[gate].maxFill >= 0.8, `the output buffer at the gate fills up (${one.report.stations[gate].maxFill})`);
  assert.ok(two.report.stations[gate].maxFill <= 0.5, 'but not with two AGVs');
  assert.ok(one.report.leadTime.p50 > 1.5 * two.report.leadTime.p50, `lead time ${one.report.leadTime.p50.toFixed(0)} s against ${two.report.leadTime.p50.toFixed(0)} s`);
  assert.ok(one.report.fleets[l.fleets[0].id].utilization > 0.95);
});

test('examples: the texts agree with the numbers (notes, tips and descriptions quote parameters that are really there)', () => {
  const [starter, twoLines, lab] = EXAMPLES.map((e) => e.build());
  const first = (l, type) => l.stations.find((s) => s.type === type);
  assert.match(starter.notes, /every 3 minutes/);
  assert.equal(first(starter, 'source').params.interArrival.mean, 180);
  assert.match(starter.notes, /assembled in 2 minutes/);
  assert.equal(first(starter, 'process').params.cycle.mean, 120);
  assert.match(starter.notes, /Two AGVs/);
  assert.equal(starter.fleets[0].count, 2);

  const press = twoLines.flows.find((f) => f.to === byName(twoLines, 'Final assembly').id && f.from === byName(twoLines, 'Press line').id);
  const machining = twoLines.flows.find((f) => f.to === byName(twoLines, 'Final assembly').id && f.from === byName(twoLines, 'Machining').id);
  assert.match(twoLines.notes, /2 pressed parts and 1 machined part/);
  assert.deepEqual([press.perCycle, machining.perCycle], [2, 1]);
  const warehouse = byName(twoLines, 'Central warehouse');
  const toPress = twoLines.flows.find((f) => f.from === warehouse.id && f.to === byName(twoLines, 'Press line').id);
  const toMachining = twoLines.flows.find((f) => f.from === warehouse.id && f.to === byName(twoLines, 'Machining').id);
  assert.match(twoLines.notes, /2 of every 3 pallets/);
  assert.equal(toPress.weight / (toPress.weight + toMachining.weight), 2 / 3);
  // the split matches the bill of materials, so neither line starves the other
  const perHour = 3600 / byName(twoLines, 'Goods receiving').params.interArrival.mean;
  assert.ok(Math.abs((perHour * (2 / 3)) / press.perCycle - (perHour * (1 / 3)) / machining.perCycle) < 1e-9, 'pressed and machined parts arrive in the 2:1 ratio the assembly consumes');

  assert.match(lab.notes, /9 AGVs/);
  assert.equal(lab.fleets[0].count, 9);
  assert.ok(EXAMPLES[2].tips.some((t) => t.includes(`(${lab.fleets[0].count} now)`)), 'the tip quotes the real vehicle count');

  const tabs = new Set(['Fleet', 'Flows', 'Simulate', 'Results', 'Experiments', 'Properties', 'Checks']);
  for (const example of EXAMPLES) {
    for (const tip of example.tips) {
      for (const [, name] of tip.matchAll(/\b([A-Z][a-z]+) tab\b/g)) assert.ok(tabs.has(name), `${example.id}: "${name} tab" is not a tab of the right panel (docs 6.7)`);
      for (const [, name] of tip.matchAll(/\b([A-Z][a-z]+) tool\b/g)) assert.ok(['Road', 'Select', 'Eraser', 'Pan', 'Flow', 'Obstacle'].includes(name), `${example.id}: "${name} tool"`);
    }
  }
});

test('examples: plants are internally consistent for a planner (rates, capacities, vehicle sizes, depots)', () => {
  for (const example of EXAMPLES) {
    const l = example.build();
    for (const s of l.stations) {
      if (s.type === 'process') {
        const perHour = (3600 / s.params.cycle.mean) * s.params.machines;
        const incoming = l.flows.filter((f) => f.to === s.id);
        assert.ok(perHour >= 30 && perHour <= 60, `${example.id}: ${s.name} makes ${perHour.toFixed(0)} cycles/h`);
        for (const f of incoming) assert.ok(f.perCycle <= s.params.inCap, `${example.id}: ${s.name} can hold what one cycle needs`);
      }
      if (s.type === 'source') assert.ok(s.params.interArrival.mean >= 30 && s.params.interArrival.mean <= 600, `${example.id}: ${s.name} arrival interval`);
      if (s.type === 'depot') assert.ok(s.params.slots >= l.fleets.filter((f) => f.home === s.id).reduce((n, f) => n + f.count, 0), `${example.id}: ${s.name} holds its fleet`);
    }
    for (const f of l.fleets) {
      assert.ok(f.speed >= 0.5 && f.speed <= 4, `${example.id}: ${f.name} speed ${f.speed} m/s`);
      assert.ok(f.length <= l.grid.cellSize, `${example.id}: ${f.name} fits a road cell`);
      assert.ok(f.accel <= f.decel + 1e-9 || f.preset === 'custom', `${example.id}: ${f.name} brakes at least as hard as it accelerates`);
      if (f.battery.enabled) {
        const depot = l.stations.find((s) => s.id === f.home);
        assert.ok(depot && depot.params.chargers >= 1, `${example.id}: ${f.name} has chargers at home`);
        assert.ok(f.battery.chargeTimeMin < f.battery.runtimeMin, `${example.id}: ${f.name} charges faster than it runs`);
      }
    }
    for (const flow of l.flows) assert.ok(flow.batchMax === 0 || flow.batchMax >= flow.batchMin);
  }
});
