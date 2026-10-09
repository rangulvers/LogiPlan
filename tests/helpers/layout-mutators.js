// The classification of every exported function of js/model/layout.js (a reader, or a mutator with a driver) and the drivers themselves,
// shared by the tests that attack "the layout stays consistent after every edit" (tests/model.reconcile.test.js with stand-in sanitizers,
// tests/model.ops-trucks.test.js with the real ones). A NEW exported function of layout.js fails the classification test until it is added
// here: to READERS, or to MUTATORS with a driver (and, if it can add or remove extension content, it must end with reconcileLayout).
import * as L from '../../js/model/layout.js';

/** Exports that only read (or build a new layout): they cannot make a stamp stale. */
export const READERS = new Set([
  'checkInvariants', 'cleanId', 'cleanText', 'cloneLayout', 'contentBounds', 'createLayout', 'docksOf', 'flowsFrom', 'flowsTo', 'getFleet', 'getFlow',
  'getStation', 'hasLink', 'isCellFree', 'isRectFree', 'labelAt', 'layoutChangeKind', 'normalizeLayout', 'obstacleAt', 'roadAt', 'roadCellCount',
  'roadLengthMeters', 'stationAt', 'trimmedSize',
]);

export const pick = (rng, list) => list[rng.int(list.length)];
export const anyOf = (list, rng) => (list.length ? pick(rng, list) : undefined);
const cell = (l, rng) => [rng.int(l.grid.cols), rng.int(l.grid.rows)];
/** Patches of `station.ops` as the panel, a sweep and a hostile file would send them (M1: trucks). */
export const OPS_PATCHES = [
  { trucks: { doors: 4 } }, { trucks: { doors: 1 } }, { trucks: { mode: 'schedule' } }, { trucks: { mode: 'rate' } },
  { trucks: { interArrival: { mean: 1800 } } }, { trucks: null }, null, 'junk', {},
  { trucks: { mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: null }] } }, { trucks: { schedule: [] } },
  { trucks: { jitter: 600, noShow: 0.1, maxDwell: 1800, staging: 8, pallets: { mean: 30 } } }, { trucks: { doors: 99, checkIn: -5 } },
];

/**
 * One call per exported mutator, with arguments that are valid often enough to change something. `rng` chooses the target.
 * A mutator that is not in this table (and not in READERS) fails the classification test below.
 */
export const MUTATORS = {
  addStation: (l, rng) => L.addStation(l, { type: pick(rng, ['source', 'sink', 'process', 'storage']), x: cell(l, rng)[0], y: cell(l, rng)[1], ...(rng.next() < 0.5 ? { ops: pick(rng, OPS_PATCHES) } : {}) }),
  moveStation: (l, rng) => L.moveStation(l, anyOf(l.stations, rng)?.id, ...cell(l, rng)),
  resizeStation: (l, rng) => { const s = anyOf(l.stations, rng); return s && L.resizeStation(l, s.id, { x: s.x, y: s.y, w: 1 + rng.int(4), h: 1 + rng.int(3) }); },
  updateStation: (l, rng) => L.updateStation(l, anyOf(l.stations, rng)?.id, rng.next() < 0.7 ? { ops: pick(rng, OPS_PATCHES) } : { name: `n${rng.int(99)}`, params: { batch: 1 + rng.int(3) } }),
  removeStation: (l, rng) => L.removeStation(l, anyOf(l.stations, rng)?.id),
  duplicateStation: (l, rng) => L.duplicateStation(l, anyOf(l.stations, rng)?.id),
  addFlow: (l, rng) => L.addFlow(l, anyOf(l.stations, rng)?.id, anyOf(l.stations, rng)?.id),
  updateFlow: (l, rng) => L.updateFlow(l, anyOf(l.flows, rng)?.id, { weight: 1 + rng.int(4) }),
  removeFlow: (l, rng) => L.removeFlow(l, anyOf(l.flows, rng)?.id),
  addFleet: (l, rng) => L.addFleet(l, pick(rng, ['agv', 'forklift', 'tugger'])),
  updateFleet: (l, rng) => L.updateFleet(l, anyOf(l.fleets, rng)?.id, { count: 1 + rng.int(4) }),
  removeFleet: (l, rng) => L.removeFleet(l, anyOf(l.fleets, rng)?.id),
  duplicateFleet: (l, rng) => L.duplicateFleet(l, anyOf(l.fleets, rng)?.id),
  addObstacle: (l, rng) => L.addObstacle(l, { x: cell(l, rng)[0], y: cell(l, rng)[1] }),
  updateObstacle: (l, rng) => L.updateObstacle(l, anyOf(l.obstacles, rng)?.id, { kind: 'wall' }),
  removeObstacle: (l, rng) => L.removeObstacle(l, anyOf(l.obstacles, rng)?.id),
  addLabel: (l, rng) => L.addLabel(l, { text: 'x', x: cell(l, rng)[0], y: cell(l, rng)[1] }),
  updateLabel: (l, rng) => L.updateLabel(l, anyOf(l.labels, rng)?.id, { text: 'y' }),
  removeLabel: (l, rng) => L.removeLabel(l, anyOf(l.labels, rng)?.id),
  setName: (l, rng) => L.setName(l, `plant ${rng.int(9)}`),
  setNotes: (l, rng) => L.setNotes(l, `note ${rng.int(9)}`),
  updateCalendar: (l, rng) => L.updateCalendar(l, pick(rng, [{ startTod: 21600 }, { startDay: 3 }, { startTod: '07:30', startDay: 1 }, null, {}, 'junk'])),
  updateSettings: (l, rng) => L.updateSettings(l, { dt: pick(rng, [0.1, 0.25]) }),
  resizeGrid: (l, rng) => L.resizeGrid(l, 6 + rng.int(60), 6 + rng.int(40)),
  setCellSize: (l, rng) => L.setCellSize(l, pick(rng, [1, 2, 3])),
  translateAll: (l, rng) => L.translateAll(l, rng.int(3) - 1, rng.int(3) - 1),
  growGrid: (l, rng) => L.growGrid(l, { left: rng.int(3), top: rng.int(3), right: rng.int(3), bottom: rng.int(3) }),
  trimGrid: (l) => L.trimGrid(l),
  paintRoadPath: (l, rng) => L.paintRoadPath(l, [cell(l, rng), cell(l, rng)]),
  paintRoadCell: (l, rng) => L.paintRoadCell(l, ...cell(l, rng)),
  eraseRoadCell: (l, rng) => L.eraseRoadCell(l, ...cell(l, rng)),
  eraseLink: (l, rng) => L.eraseLink(l, ...cell(l, rng), pick(rng, [0, 1, 2, 3])),
  setRoadLimit: (l, rng) => L.setRoadLimit(l, ...cell(l, rng), pick(rng, [0.5, 1, null])),
  flipRoadDirection: (l, rng) => L.flipRoadDirection(l, ...cell(l, rng), pick(rng, [0, 1, 2, 3])),
};

