// Worked example plants, built only through the layout.js mutators (so they double as tests of that API).
//
// Design rules that make them runnable in the simulation (docs/ARCHITECTURE.md §5):
//  * every station has a dock: a road cell touching it. Busy stations sit at the end of a short side road (a "bay"),
//    so a vehicle that loads or unloads there does not block through traffic;
//  * roads form loops or dead-end spurs, never one-way dead ends: vehicles cannot turn around mid-road, they only
//    reverse at the end of a spur;
//  * depots hold the parked fleet, so idle vehicles do not stand in the aisles.
// Everything goes through the layout.js mutators. Outcomes and tips were checked against the real simulation: every claim a tip makes
// is re-verified by running the variant it describes for the default run length of 8 simulated hours (tests/sim.engine.review.test.js,
// 'tips'; the first two hours of a run are not typical: batteries start full and queues start empty), the outcomes by
// tests/sim.integration.test.js.

import { lPath } from '../util/grid.js';
import {
  createLayout, setNotes, paintRoadPath, addStation, addFlow, addFleet, addObstacle, addLabel, translateAll, eraseRoadCell, moveStation,
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

/** Place a station through the model API (`ops`: the warehouse options of a Goods in / Goods out, ops.js). */
function station(layout, type, name, x, y, size, params, ops) {
  return must(addStation(layout, { type, name, x, y, ...size, params, ops }), `station "${name}"`);
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
    + 'Final assembly, which needs 2 pressed parts and 1 machined part per product; as every product takes two pressings, the Press line is the busiest '
    + 'workstation. The roads are a ring with a cross aisle, and every station '
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

  const receiving = station(layout, 'source', 'Goods receiving', 10, 2, { w: 3, h: 2 }, { interArrival: arrivals(57, 0.2), outCap: 6 });
  const forkliftPark = station(layout, 'depot', 'Forklift park', 17, 2, { w: 3, h: 2 }, { slots: 4, chargers: 0 });
  const dispatch = station(layout, 'sink', 'Dispatch', 44, 2, { w: 3, h: 2 });
  const warehouse = station(layout, 'storage', 'Central warehouse', 22, 10, { w: 6, h: 4 }, { capacity: 80, dwell: 30 });
  const press = station(layout, 'process', 'Press line', 12, 23, { w: 4, h: 3 },
    { cycle: arrivals(60, 0.1), inCap: 4, outCap: 6, mtbf: 7200, mttr: 420 });
  const machining = station(layout, 'process', 'Machining', 40, 22, { w: 3, h: 3 }, { cycle: arrivals(70, 0.1), inCap: 4, outCap: 4 });
  const assembly = station(layout, 'process', 'Final assembly', 30, 23, { w: 5, h: 4 }, { cycle: arrivals(90, 0.1), inCap: 4, outCap: 4 });
  const charging = station(layout, 'depot', 'AGV charging', 20, 23, { w: 4, h: 2 }, { slots: 8, chargers: 4 });

  // Compact trucks carrying two pallets: 2 m long, so they fit a 2 m road cell.
  const forklifts = must(addFleet(layout, 'forklift', { name: 'Forklifts', count: 3, capacity: 2, length: 2, home: forkliftPark.id }), 'forklift fleet');
  const agvs = must(addFleet(layout, 'agv', {
    name: 'AGVs', count: 7, loadTime: 14, unloadTime: 14, home: charging.id, battery: { enabled: true, runtimeMin: 120, chargeTimeMin: 15, lowPct: 50, resumePct: 85 },
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
    + 'hand-over takes 24 s; and 9 AGVs are more than this layout can use. Run it, look at the heat map and the Results tab, then fix it.');

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
  addFleet(layout, 'agv', { name: 'AGV', count: 9, loadTime: 24, unloadTime: 24, home: parking.id });

  obstacles(layout, 'rack', [[9, 12, 12, 5], [28, 12, 11, 5]]);
  must(addLabel(layout, { x: 27.5, y: 3.6, text: 'Docks on the main aisle' }), 'label');
  must(addLabel(layout, { x: 14, y: 6.6, text: 'Narrow one-way aisle' }), 'label');
  must(addLabel(layout, { x: 25.5, y: 10.6, text: 'Crossing' }), 'label');
  return layout;
}

// ---------------------------------------------------------------------------------------------------------
// 4. Dock lab: one street, three docks (warehouse module M1, docs/WAREHOUSE-DESIGN.md 8.1 row 1 and Appendix C)
// ---------------------------------------------------------------------------------------------------------

/** The x of the three side roads ("bays") that lead up to Goods in, and the rows of the street and of the side roads (cells). */
const LAB_BAYS = Object.freeze([22, 25, 28]);
const LAB_STREET_Y = 10;
const LAB_BAY_TOP_Y = 6;

/**
 * The plant of the dock observation: a vehicle cannot drive past a parked one, so docks lined up along one lane cannot share the work, while
 * docks on their own short side roads can. One two-way street runs round the plant; the forklifts circle clockwise (Goods in on top, Storage on the
 * west leg, Goods out and the Forklift park at the bottom), so every vehicle reaches Goods in from the west.
 *  * variant 'bays' (the example): Goods in has three side roads, one dock at the end of each; the work is shared (about 6 : 3 : 1).
 *  * variant 'row': the same plant after the edit that the notes describe - the three side roads erased and Goods in moved down onto the
 *    street, so its docks lie in a row on one lane: the first one takes about 95 % of the visits and Checks says so (docks-share-lane).
 * Trucks are slow to check in and out (10 minutes each) so that three doors are busy about 40 % of the time and the gate stays empty: what
 * the lab shows is the docks, not the doors. Calibrated on the built plant (tests/sim.examples.warehouse.test.js).
 * @param {'bays'|'row'} [variant]
 */
export function buildDockLab(variant = 'bays') {
  if (variant !== 'bays' && variant !== 'row') throw new Error(`examples: unknown Dock lab variant "${variant}"`);
  const layout = createLayout({ name: 'Dock lab', cols: 40, rows: 28, cellSize: 2 });
  setNotes(layout, 'Trucks bring 24 pallets to Goods in about every 30 minutes and forklifts carry them to the Storage; Goods out sends 24 pallets away about every '
    + '38 minutes. Goods in has three doors for trucks and three docks for forklifts, each dock at the end of its own short side road, so the forklifts share '
    + 'the work (open Results, or switch on the Docks overlay, to see the bars). Try a row: erase the three side roads and drag Goods in down until it touches '
    + 'the street. A forklift cannot drive past a parked one, so the first dock takes nearly every visit and the others stand empty; the Checks tab says "docks share a lane".');

  ring(layout, 4, LAB_STREET_Y, 34, 20); // the one street, two-way
  for (const x of LAB_BAYS) road(layout, [[x, LAB_STREET_Y], [x, LAB_BAY_TOP_Y]]); // three side roads to Goods in
  for (const y of [12, 16]) road(layout, [[4, y], [8, y]]); // two bays for the Storage
  for (const x of [8, 13]) road(layout, [[x, 20], [x, 22]]); // two bays for Goods out
  road(layout, [[4, 20], [4, 21]]); // the Forklift park

  const truck = (doors, gap, pallets) => ({ trucks: { doors, checkIn: 600, checkOut: 600, interArrival: arrivals(gap, 0.3), pallets } });
  const goodsIn = station(layout, 'source', 'Goods in', LAB_BAYS[0], 4, { w: 7, h: 2 }, { outCap: 12 },
    truck(3, 1800, { kind: 'uniform', mean: 24, spread: 0.25 }));
  const storage = station(layout, 'storage', 'Storage', 9, 12, { w: 10, h: 5 }, { capacity: 400, dwell: 30 });
  const goodsOut = station(layout, 'sink', 'Goods out', 7, 23, { w: 9, h: 2 }, {},
    truck(2, 2250, { kind: 'const', mean: 24, spread: 0 }));
  const park = station(layout, 'depot', 'Forklift park', 3, 22, { w: 3, h: 2 }, { slots: 8, chargers: 0 });

  flow(layout, goodsIn, storage);
  flow(layout, storage, goodsOut);
  // Compact trucks 2 m long fit a 2 m road cell, like the forklifts of "Two lines + warehouse".
  must(addFleet(layout, 'forklift', { name: 'Forklifts', count: 5, length: 2, home: park.id }), 'forklift fleet');

  must(addLabel(layout, { x: 25.5, y: 1.6, text: 'Receiving docks' }), 'label');
  must(addLabel(layout, { x: 9.5, y: 9.2, text: 'The one street' }), 'label');
  must(addLabel(layout, { x: 23.5, y: 14.5, text: 'Storage bays' }), 'label');
  must(addLabel(layout, { x: 19.5, y: 24, text: 'Shipping' }), 'label');

  if (variant === 'row') {
    for (const x of LAB_BAYS) for (let y = LAB_BAY_TOP_Y; y < LAB_STREET_Y; y++) must(eraseRoadCell(layout, x, y), `side road at ${x},${y}`);
    must(moveStation(layout, goodsIn.id, LAB_BAYS[0], LAB_STREET_Y - 2), 'moving Goods in down onto the street');
    must(setNotes(layout, `${layout.notes} (This copy is the row: the three side roads are gone and Goods in touches the street.)`), 'notes');
  }
  return layout;
}

// ---------------------------------------------------------------------------------------------------------
// 5. Warehouse: first day (warehouse module M1, docs/WAREHOUSE-DESIGN.md 8.1 row 2)
// ---------------------------------------------------------------------------------------------------------

/**
 * A small pallet warehouse on its first day: trucks bring 24 pallets about every 17 minutes to Goods in (three doors, a fourth dock to try),
 * four forklifts carry them to the Storage and on to Goods out (two doors, a truck of 24 pallets about every 25 minutes). The door check at the
 * plan stage is fine (3 doors are enough on paper); the forklifts are what limits the plant, and that is the lesson: more doors change little,
 * one more forklift empties the gate. Calibrated on the built plant (tests/sim.examples.warehouse.test.js).
 */
export function buildWarehouseFirstDay() {
  const layout = createLayout({ name: 'Warehouse: first day', cols: 48, rows: 30, cellSize: 2 });
  setNotes(layout, 'A small pallet warehouse on its first day. A truck with about 24 pallets arrives at Goods in every 17 minutes and takes one of three doors; '
    + 'forklifts carry the pallets to the Storage and later to Goods out, where a truck of 24 pallets waits for them about every 25 minutes. On paper three doors are '
    + 'enough (the door check in the Properties tab says so), but a truck holds its door until the forklifts have taken its last pallet, so the four forklifts '
    + 'decide how long the doors stay busy. Run it and open Results: the Doors card shows the gate and the door time, and the findings say what limits the plant.');

  ring(layout, 4, 9, 40, 21);
  for (const x of [8, 11, 14, 17]) road(layout, [[x, 9], [x, 5]]); // four side roads to Goods in (three doors; the fourth dock is for trying)
  for (const y of [11, 15, 19]) road(layout, [[40, y], [37, y]]); // three bays for the Storage
  for (const x of [21, 27]) road(layout, [[x, 21], [x, 23]]); // two bays for Goods out
  road(layout, [[5, 21], [5, 22]]); // the Forklift park

  const goodsIn = station(layout, 'source', 'Goods in', 8, 3, { w: 10, h: 2 }, { outCap: 12 },
    { trucks: { doors: 3, interArrival: arrivals(1020, 0.3), pallets: { kind: 'uniform', mean: 24, spread: 0.25 } } });
  const storage = station(layout, 'storage', 'Storage', 28, 11, { w: 9, h: 9 }, { capacity: 600, dwell: 30 });
  const goodsOut = station(layout, 'sink', 'Goods out', 20, 24, { w: 9, h: 2 }, {},
    { trucks: { doors: 2, interArrival: arrivals(1500, 0.3), pallets: { kind: 'const', mean: 24, spread: 0 } } });
  const park = station(layout, 'depot', 'Forklift park', 4, 23, { w: 3, h: 2 }, { slots: 8, chargers: 0 });

  flow(layout, goodsIn, storage);
  flow(layout, storage, goodsOut);
  must(addFleet(layout, 'forklift', { name: 'Forklifts', count: 4, length: 2, home: park.id }), 'forklift fleet');

  must(addLabel(layout, { x: 8.5, y: 2.2, text: 'Receiving' }), 'label');
  must(addLabel(layout, { x: 23, y: 15.5, text: 'Pallet storage' }), 'label');
  must(addLabel(layout, { x: 21, y: 26.8, text: 'Shipping' }), 'label');
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
      'Try: lower the AGV count to 1 in the Fleet tab. One AGV cannot keep up: it is busy all the time, pallets pile up at Goods receiving, the output falls by about 8 % and the lead time keeps growing, to about twice its old value after 2 simulated hours and about five times after 8.',
      'Try: raise "Demand ×" in the Simulate tab to 1.5. The assembly runs flat out (about 99 % busy), the AGVs follow at about 90 % and the output tops out near 30 pallets/h.',
      'Try: drag Dispatch with the Select tool and redraw the road so it touches again; the Checks tab warns while a station has no dock.',
    ],
    build: buildStarter,
  },
  {
    id: 'two-lines',
    name: 'Two production lines + warehouse',
    description: 'Forklifts and battery AGVs serve a press line and a machining line from a central warehouse; final assembly needs two pressed parts and one machined part per product.',
    tips: [
      'Try: raise "Demand ×" to 1.3 in the Simulate tab. The output rises by about 28 %, and the Results tab shows the Press line (about 90 % busy) and the AGVs (about 85 %) reaching their limit first.',
      'Try: change the AGV count in the Fleet tab, or sweep it in the Experiments tab: with 5 AGVs the loads wait about 45 % longer for a vehicle and the lead time grows by about 13 %; with 8 or more only the idle time grows.',
      'Try: raise the AGV charge time to 60 min in the Fleet tab. The AGVs now spend about 28 % of their time on the chargers instead of 8 %; the output holds, but loads wait about 40 % longer for a vehicle. Then cut the chargers in AGV charging to 1: the charger becomes the bottleneck, the work in process climbs without limit and the output falls by more than 40 %.',
      'Try: give the Press line a repair time (MTTR) of 30 min in the Properties tab. Stops strike at random, so a single 8-hour run can show anything from hardly any change to a lead time several times longer; on average over ten runs the work in process doubles, the lead time grows by about 60 % and the output falls by about 5 %. Use several replications in the Experiments tab.',
    ],
    build: buildTwoLines,
  },
  {
    id: 'congestion-lab',
    name: 'Congestion lab',
    description: 'A plant with deliberate traffic problems: a narrow one-way loop, a packing dock right on the main aisle, a crossing, trucks that unload in bunches and too many vehicles. Watch the queues form, then fix them.',
    tips: [
      'Switch the heat map to "waiting" while the simulation runs: the queues build up in front of the Packing docks on the main aisle.',
      'Try: change the AGV count (9 now) in the Fleet tab and compare throughput and the traffic wait share in the Results tab. Do more vehicles really mean more output? With 6 AGVs the output is the same and the wait share falls by about a third; every AGV beyond 9 only adds a little more waiting.',
      'Try: let each AGV carry two pallets (Capacity 2 in the Fleet tab). Fewer stops at the docks mean shorter queues: the wait share falls by about half.',
      'Try: cut the load and unload time in the Fleet tab from 24 s to 12 s. The docks free up sooner and the wait share falls by more than half.',
      'Try: draw a one-way road from the cross aisle just below Inbound B east along the north side of Packing and down to the main aisle (cells 24,4 → 32,4 → 32,8). Packing gets a second dock and the traffic wait share drops by about 40 %: vehicles then take whichever of its docks is free.',
    ],
    build: buildCongestionLab,
  },
  {
    id: 'dock-lab',
    name: 'Dock lab: one street, three docks',
    description: 'Trucks bring pallets to a Goods in with three docks, each on its own short side road, and forklifts carry them to a Storage. Turn the three side roads into a row and watch the docks stop sharing the work.',
    tips: [
      'Press play, select Goods in and switch on the Docks overlay (or open the Results tab): every dock carries a bar. With a side road for each dock the forklifts share the work: about 57 %, 34 % and 9 % of the visits go to the first, second and third dock.',
      'Try: erase the three side roads above Goods in and drag Goods in down until it touches the street. The docks now lie in a row on one lane. A forklift cannot drive past a parked one, so the first dock takes about 97 % of the visits and the others stand empty. The Checks tab says "docks share a lane", the forklifts work about 10 % harder for the same pallets (58 % busy instead of 53 %) and a truck holds its door about 2 minutes longer (33 instead of 31).',
      'Try: add a sixth forklift in the Fleet tab. Trucks are unloaded a little sooner (door time 30 instead of 31 minutes), but the street fills up: waiting in traffic rises from 9 % to 14 %. In the row it rises to 20 % and the extra forklift cannot reach the empty docks.',
    ],
    build: () => buildDockLab('bays'),
  },
  {
    id: 'warehouse-first-day',
    name: 'Warehouse: first day',
    description: 'A small pallet warehouse: trucks arrive at three doors, four forklifts carry the pallets to the Storage and on to Goods out. Find out whether the doors or the forklifts decide how long trucks wait.',
    tips: [
      'Press play and open the Results tab: the Doors card shows the gate and the doors. Over several runs a truck waits about 8 minutes at the gate and holds its door for about 42 minutes, and the doors are busy about 83 % of the time. The findings say it is not the doors: the forklifts are busy 99 % of the time.',
      'Try: select Goods in and raise its doors from 3 to 4 (Properties tab, Trucks and doors). Trucks wait less than half as long at the gate (about 4 minutes), but each stays at its door longer (about 47 minutes) and the forklifts are still busy 99 % of the time: the same pallets go through. More doors only move the queue from the gate to the doors.',
      'Try: add a fifth forklift in the Fleet tab instead. The door time falls to about 26 minutes, the gate stays empty and the forklifts are busy about 89 % of the time. A sixth brings the door time to about 22 minutes, at the price of a busier street: waiting in traffic doubles, from 5 % to 10 %.',
      'The door check in the Properties tab (Goods in, Trucks and doors) says 2.7 doors are busy at once at the busiest hour, so 3 doors are enough on paper. It assumes 90 seconds per pallet; in a run the forklifts decide how long a truck stays, and after a run the check uses the door time measured here.',
    ],
    build: buildWarehouseFirstDay,
  },
];
