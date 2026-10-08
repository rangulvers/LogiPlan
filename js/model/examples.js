// Worked example plants, built only through the layout.js mutators (so they double as tests of that API).
//
// Design rules that make them runnable in the simulation (docs/ARCHITECTURE.md §5):
//  * every station has a dock: a road cell touching it. Busy stations sit at the end of a short side road (a "bay"),
//    so a vehicle that loads or unloads there does not block through traffic;
//  * roads form loops or dead-end spurs, never one-way dead ends: vehicles cannot turn around mid-road, they only
//    reverse at the end of a spur;
//  * depots hold the parked fleet, so idle vehicles do not stand in the aisles.
// Everything goes through the layout.js mutators. The tips were checked against the real simulation (tests/model.examples.test.js).

import { lPath } from '../util/grid.js';
import {
  createLayout, setNotes, paintRoadPath, addStation, addFlow, addFleet, addObstacle, addLabel, translateAll,
} from './layout.js';

/** Throw if a mutator rejected a request: an example that does not build is a bug, not a soft failure. */
function must(value, what) {
  if (!value) throw new Error(`examples: could not create ${what}`);
  return value;
}

/** Paint a straight-legged road through the corner points; every leg must be fully paintable. */
function road(layout, points, { oneWay = false } = {}) {
  const cells = points.slice(1).reduce((acc, p, i) => acc.concat(lPath(...points[i], ...p).slice(1)), [points[0]]);
  const painted = paintRoadPath(layout, points, { oneWay });
  must(painted === new Set(cells.map((c) => c.join())).size, `road ${JSON.stringify(points)}`);
}

/** Rectangular road loop through four corners (clockwise when drawn top-left first). */
function ring(layout, x0, y0, x1, y1, opts) {
  road(layout, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], opts);
}

/** Place a station through the model API. */
function station(layout, type, name, x, y, size, params) {
  return must(addStation(layout, { type, name, x, y, ...size, params }), `station "${name}"`);
}

function flow(layout, from, to, patch) {
  return must(addFlow(layout, from.id, to.id, patch), `flow "${from.name}" -> "${to.name}"`);
}

function obstacles(layout, kind, rects) {
  for (const [x, y, w, h] of rects) must(addObstacle(layout, { x, y, w, h, kind }), `${kind} at ${x},${y}`);
}

const arrivals = (mean, spread = 0.15) => ({ kind: 'normal', mean, spread });

// ---------------------------------------------------------------------------------------------------------
// 1. Starter
// ---------------------------------------------------------------------------------------------------------

function buildStarter() {
  const layout = createLayout({ name: 'Starter plant', cols: 40, rows: 24, cellSize: 2 });
  setNotes(layout, 'A pallet arrives at Goods receiving every 3 minutes, is assembled in 2 minutes and leaves through Dispatch. Two AGVs carry the pallets '
    + 'around a two-way loop road; each station sits at the end of a short side road, so a vehicle loading there does not block the loop.');

  ring(layout, 5, 7, 34, 17);
  road(layout, [[9, 7], [9, 5]]); // Goods receiving bay
  road(layout, [[20, 7], [20, 9]]); // Assembly bay
  road(layout, [[34, 12], [36, 12]]); // Dispatch bay
  road(layout, [[14, 7], [14, 9]]); // AGV parking bay

  const receiving = station(layout, 'source', 'Goods receiving', 8, 3, { w: 3, h: 2 }, { interArrival: arrivals(180), outCap: 6 });
  const assembly = station(layout, 'process', 'Assembly', 19, 10, { w: 3, h: 3 }, { cycle: arrivals(120, 0.1), inCap: 4, outCap: 4 });
  const dispatch = station(layout, 'sink', 'Dispatch', 37, 11, { w: 3, h: 2 });
  const parking = station(layout, 'depot', 'AGV parking', 13, 10, { w: 3, h: 2 }, { slots: 3, chargers: 0 });

  flow(layout, receiving, assembly);
  flow(layout, assembly, dispatch);
  addFleet(layout, 'agv', { name: 'AGV', count: 2, home: parking.id });

  obstacles(layout, 'rack', [[8, 13, 9, 2]]);
  obstacles(layout, 'column', [[26, 11, 1, 1], [26, 13, 1, 1], [30, 11, 1, 1], [30, 13, 1, 1]]);
  must(addLabel(layout, { x: 12, y: 2.2, text: 'Inbound' }), 'label');
  must(addLabel(layout, { x: 23, y: 9.3, text: 'Assembly hall' }), 'label');
  must(addLabel(layout, { x: 27, y: 15.4, text: 'Outbound' }), 'label');
  must(translateAll(layout, 0, 2), 'centering the plant on the baseplate');
  return layout;
}

// ---------------------------------------------------------------------------------------------------------
// 2. Two production lines + warehouse
// ---------------------------------------------------------------------------------------------------------

function buildTwoLines() {
  const layout = createLayout({ name: 'Two lines + warehouse', cols: 56, rows: 33, cellSize: 2 });
  setNotes(layout, 'Three forklifts bring raw material from Goods receiving into the central warehouse and take finished goods to Dispatch. '
    + 'Battery AGVs feed the Press line (2 of every 3 pallets) and Machining (1 of 3) from the warehouse and carry their output to '
    + 'Final assembly, which needs 2 pressed parts and 1 machined part per product. The roads are a ring with a cross aisle, and every station '
    + 'sits at the end of a short side road.');

  ring(layout, 6, 6, 49, 30);
  road(layout, [[6, 18], [49, 18]]); // cross aisle
  road(layout, [[11, 6], [11, 4]]); // Goods receiving
  road(layout, [[18, 6], [18, 4]]); // Forklift park
  road(layout, [[45, 6], [45, 4]]); // Dispatch
  road(layout, [[24, 6], [24, 9]]); // Warehouse, north bay (inbound)
  road(layout, [[24, 18], [24, 14]]); // Warehouse, south bay (outbound)
  road(layout, [[13, 18], [13, 22]]); // Press line
  road(layout, [[32, 18], [32, 22]]); // Final assembly
  road(layout, [[41, 18], [41, 21]]); // Machining
  road(layout, [[22, 18], [22, 22]]); // AGV charging

  const receiving = station(layout, 'source', 'Goods receiving', 10, 2, { w: 3, h: 2 }, { interArrival: arrivals(55, 0.2), outCap: 6 });
  const forkliftPark = station(layout, 'depot', 'Forklift park', 17, 2, { w: 3, h: 2 }, { slots: 4, chargers: 0 });
  const dispatch = station(layout, 'sink', 'Dispatch', 44, 2, { w: 3, h: 2 });
  const warehouse = station(layout, 'storage', 'Central warehouse', 22, 10, { w: 6, h: 4 }, { capacity: 80, dwell: 30 });
  const press = station(layout, 'process', 'Press line', 12, 23, { w: 4, h: 3 },
    { cycle: arrivals(45, 0.1), inCap: 4, outCap: 6, mtbf: 7200, mttr: 420 });
  const machining = station(layout, 'process', 'Machining', 40, 22, { w: 3, h: 3 }, { cycle: arrivals(70, 0.1), inCap: 4, outCap: 4 });
  const assembly = station(layout, 'process', 'Final assembly', 30, 23, { w: 5, h: 4 }, { cycle: arrivals(115, 0.1), inCap: 4, outCap: 4 });
  const charging = station(layout, 'depot', 'AGV charging', 20, 23, { w: 4, h: 2 }, { slots: 8, chargers: 4 });

  // Compact trucks carrying two pallets: 2 m long, so they fit a 2 m road cell.
  const forklifts = must(addFleet(layout, 'forklift', { name: 'Forklifts', count: 3, capacity: 2, length: 2, home: forkliftPark.id }), 'forklift fleet');
  const agvs = must(addFleet(layout, 'agv', {
    name: 'AGVs', count: 7, home: charging.id, battery: { enabled: true, runtimeMin: 120, chargeTimeMin: 15, lowPct: 50, resumePct: 85 },
  }), 'AGV fleet');

  flow(layout, receiving, warehouse, { fleetId: forklifts.id, batchMin: 2, maxWait: 120 });
  flow(layout, warehouse, press, { fleetId: agvs.id, weight: 2 });
  flow(layout, warehouse, machining, { fleetId: agvs.id, weight: 1 });
  flow(layout, press, assembly, { fleetId: agvs.id, perCycle: 2 });
  flow(layout, machining, assembly, { fleetId: agvs.id, perCycle: 1 });
  flow(layout, assembly, dispatch, { fleetId: forklifts.id, priority: 2 });

  obstacles(layout, 'column', [[16, 10, 1, 1], [16, 14, 1, 1], [36, 10, 1, 1], [36, 14, 1, 1]]);
  obstacles(layout, 'rack', [[30, 9, 8, 1], [30, 15, 8, 1]]);
  must(addLabel(layout, { x: 7, y: 12, text: 'Inbound' }), 'label');
  must(addLabel(layout, { x: 16.5, y: 27.5, text: 'Production hall' }), 'label');
  must(addLabel(layout, { x: 41, y: 12, text: 'Outbound' }), 'label');
  return layout;
}

// ---------------------------------------------------------------------------------------------------------
// 3. Congestion lab
// ---------------------------------------------------------------------------------------------------------

function buildCongestionLab() {
  const layout = createLayout({ name: 'Congestion lab', cols: 48, rows: 28, cellSize: 2 });
  setNotes(layout, 'A deliberately awkward plant. All traffic shares one narrow one-way loop; Packing has its docks directly on the main aisle '
    + '(every stop blocks the lane behind it); a two-way cross aisle crosses the loop at two junctions; trucks unload 4 pallets at a time and every '
    + 'hand-over takes 24 s; and 8 AGVs, which wait on the aisle instead of driving back to the parking bay, are more than this layout can use. Run it, look at the heat map and the Results tab, then fix it.');

  road(layout, [[6, 8], [41, 8], [41, 20], [6, 20], [6, 8]], { oneWay: true }); // the narrow one-way loop
  road(layout, [[24, 3], [24, 25]]); // two-way cross aisle: crosses the loop at (24,8) and (24,20)
  road(layout, [[6, 14], [4, 14]]); // Inbound A bay
  road(layout, [[41, 14], [43, 14]]); // Dispatch bay

  // A truck brings 4 pallets every 400 s (36 pallets/h per supplier), so the AGVs are called out in bunches.
  const truck = { interArrival: arrivals(400), batch: 4, outCap: 8 };
  const inboundA = station(layout, 'source', 'Inbound A', 1, 13, { w: 3, h: 2 }, truck);
  const inboundB = station(layout, 'source', 'Inbound B', 23, 1, { w: 3, h: 2 }, truck);
  const packing = station(layout, 'process', 'Packing', 29, 5, { w: 3, h: 3 }, { cycle: arrivals(80, 0.1), inCap: 5, outCap: 4 });
  const dispatch = station(layout, 'sink', 'Dispatch', 44, 13, { w: 3, h: 2 });
  const parking = station(layout, 'depot', 'AGV parking', 23, 26, { w: 3, h: 2 }, { slots: 12, chargers: 0 });

  flow(layout, inboundA, packing);
  flow(layout, inboundB, packing);
  flow(layout, packing, dispatch);
  addFleet(layout, 'agv', { name: 'AGV', count: 8, loadTime: 24, unloadTime: 24, idle: 'stay', home: parking.id });

  obstacles(layout, 'rack', [[9, 12, 12, 5], [28, 12, 11, 5]]);
  must(addLabel(layout, { x: 27.5, y: 3.6, text: 'Docks on the main aisle' }), 'label');
  must(addLabel(layout, { x: 14, y: 6.6, text: 'Narrow one-way aisle' }), 'label');
  must(addLabel(layout, { x: 25.5, y: 10.6, text: 'Crossing' }), 'label');
  return layout;
}

/**
 * Worked examples for the welcome dialog. `build()` returns a fresh layout every call; `tips` are things to try.
 * @type {Array<{id: string, name: string, description: string, tips: string[], build: () => object}>}
 */
export const EXAMPLES = [
  {
    id: 'starter',
    name: 'Starter: dock → assembly → shipping',
    description: 'The smallest complete plant: pallets arrive, one assembly station works on them and two AGVs carry them around a loop road to shipping.',
    tips: [
      'Press play and open the Results tab: throughput, assembly utilization and AGV utilization show whether two AGVs are enough.',
      'Try: lower the AGV count to 1 in the Fleet tab and watch the assembly station starve while pallets wait at the gate.',
      'Try: raise "Demand ×" in the Simulate tab to 1.5 and see which resource saturates first.',
      'Try: drag Dispatch with the Select tool and redraw the road so it touches again; the Checks tab warns while a station has no dock.',
    ],
    build: buildStarter,
  },
  {
    id: 'two-lines',
    name: 'Two production lines + warehouse',
    description: 'Forklifts and battery AGVs serve a press line and a machining line from a central warehouse; final assembly needs two pressed parts and one machined part per product.',
    tips: [
      'Try: raise "Demand ×" to 1.3 in the Simulate tab and check the Results tab to see what saturates first: the AGVs, the press line or final assembly.',
      'Try: change the AGV count in the Fleet tab and compare 5, 6 and 7 vehicles in the Experiments tab.',
      'Try: switch off the AGV battery in the Fleet tab, or reduce the chargers in AGV charging to 1, and watch the minimum battery level.',
      'Try: give the Press line a longer repair time (MTTR) in the Properties tab and see how far the breakdown ripples downstream.',
    ],
    build: buildTwoLines,
  },
  {
    id: 'congestion-lab',
    name: 'Congestion lab',
    description: 'A plant with deliberate traffic problems: a narrow one-way loop, a packing dock right on the main aisle, a crossing, trucks that unload in bunches and too many vehicles. Watch the queues form, then fix them.',
    tips: [
      'Switch the heat map to "waiting" while the simulation runs: the queues build up in front of the Packing docks on the main aisle.',
      'Try: change the AGV count (9 now) in the Fleet tab and compare throughput and the traffic wait share in the Results tab. Do more vehicles really mean more output?',
      'Try: let each AGV carry two pallets (Capacity 2 in the Fleet tab). Fewer stops at the docks mean shorter queues.',
      'Try: cut the load and unload time in the Fleet tab from 24 s to 12 s. The docks free up sooner; compare the traffic wait share.',
    ],
    build: buildCongestionLab,
  },
];
