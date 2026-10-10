// Ladder example, level 4: a components plant with everything in one hall. One idea: read a whole plant - which station limits it, which kind of
// vehicle does which job (forklifts for the gates, AGVs for the line, tuggers for the kits) and which roads earn their keep (a two-way ring, a two-way
// mid street and cross aisle, a slow zone on the west side of the ring).
// MODEL FACT used here: a workstation with several incoming flows needs loads from ALL of them in every cycle (a bill of materials), so parallel
// machines are `machines: n` of ONE station, and parallel stations must be merged by a storage.
import { L, road, station, flow, label, fleet, arrivals, attach, slow } from './helpers.js';

const EXACT = { kind: 'const', spread: 0 };

export const meta = {
  id: 'components-plant',
  name: 'Components plant: one hall, three kinds of vehicle',
  level: 4,
  rank: 10,
  description: 'A whole plant under one roof: press, weld, paint, assembly, three kinds of vehicle. Find the bottleneck, then the roads.',
  learn: 'Reading a whole plant: which station limits it, which vehicle does which job, and which roads earn their keep.',
  chips: ['forklifts, AGVs, tuggers', 'bill of materials', 'breakdowns', 'warm-up 2 h'], // at most 4 (E1); the card shows the first three
  notes: 'A components plant under one roof. Steel and parts arrive at the west gates; forklifts take them to the coil store and the supermarket. Steel runs through the press line, weld cell and paint shop to the frame buffer, assembly, packing and the finished goods store on AGVs; '
    + 'tugger trains bring the kits (the weld cell needs 2 pressed parts and 1 kit per cycle, assembly 1 frame and 2 kits) and forklifts load the trucks. The one machine of the paint shop breaks down about every 3 hours. '
    + 'The roads are a two-way ring with a slow zone on its west side, a mid street and a cross aisle. The trucks come on a fixed rhythm, so the plant settles instead of drifting. '
    + 'The line is two hours deep: the first two hours are warm-up. Set the speed to 600× and run to hour 8. Find what limits the plant, then which roads you could do without. Every edit starts the run again, so run to hour 8 again before you read the numbers.',
  tips: [
    'Press play, set the speed to 600×, wait out the warm-up (two plant hours, the sim bar says "Warming up") and run to hour 8, then open the Results tab. Over several runs the plant delivers 19.3 pallets/h. The Paint shop, one machine that breaks down about every 3 hours, is the busiest station (85 % busy; the findings call it the bottleneck in 3 of 5 runs) and assembly waits for input 47 % of the time. Forklifts, AGVs and tugger trains are busy 44 %, 50 % and 52 % of the time and the vehicles spend 9 % of their driving time waiting in traffic.',
    'Try: raise "Demand" in the Simulate tab to 1.2. The paint shop is now flat out (93 % busy, the bottleneck finding is critical in 5 of 5 runs), trucks begin to leave short, and the output rises by only 7 % (20.6 pallets/h, between 18.7 and 22.3 from run to run). Then set "Machines in parallel" of the Paint shop to 2 (Properties tab): the output is 23.0 pallets/h (+19 % against the start), the paint shop falls to 52 % and the Press line (90 % busy, against 74 % at the start) is the next one to limit the plant (the findings name it in 2 of 5 runs).',
    'Try: erase the mid street (Eraser tool along the two-way street between the two bands, from just inside the west side of the ring to just inside the east side). The output does not change, but the vehicles lose their short cuts: forklifts go from 44 % to 63 % busy, tugger trains from 52 % to 79 %, and the share of driving time spent waiting in traffic grows from 9 % to 26 % (the Traffic finding turns critical).',
    'Try: erase the cross aisle instead (the street that runs north to south between Press line and Weld cell; take it out in two strokes and leave the cell where it crosses the mid street). Hardly anything changes: forklifts 45 % busy instead of 44 %, waiting in traffic 10 % instead of 9 %. Not every road earns its keep; but take the crossing cell as well and the mid street is cut in two (forklifts 54 % busy, waiting 16 %).',
    'Try: take the speed limit off the west side of the ring (Slow zone tool, hold Alt and drag along it). The forklifts are busy 40 % of the time instead of 44 % and waiting in traffic falls from 9.3 % to 8.0 %: a 0.7 zone along 25 cells costs the forklifts about 4 points of time.',
  ],
};

export function build() {
  const o = {
    forklifts: 8, agvs: 10, tuggers: 4, chargersF: 3, chargersA: 4, paintMachines: 1, paintMtbf: 10800, paintMttr: 720, paintCycle: 160, pressCycle: 140,
    steelGap: 4440, partsGap: 1480, custGap: 3000, spareGap: 7200, oneWay: false, slowLimit: 0.7, slowAt: 'ringWest'
  };
  const gapOf = (mean) => ({ ...EXACT, mean }); // the trucks come on a fixed rhythm: constant gaps and pallets, so the plant settles (docs/EXAMPLES-DESIGN.md 3.3)
  const palOf = (mean) => ({ ...EXACT, mean });
  const layout = L.createLayout({ name: 'Components plant', cols: 80, rows: 46, cellSize: 2 });
  L.setNotes(layout, meta.notes);
  L.updateSettings(layout, { warmup: 7200 }); // the line is three hours deep: measure from the second hour on
  const OX = 10; // room for the gates west of the ring
  const rd = (pts, opt) => road(layout, pts.map(([x, y]) => [x + OX, y]), opt);
  const att = (spec) => attach(layout, { ...spec, from: [spec.from[0] + OX, spec.from[1]] });

  // --- roads -------------------------------------------------------------------------------------------------------------
  rd([[4, 10], [58, 10], [58, 36], [4, 36], [4, 10]], { oneWay: o.oneWay }); // the ring, clockwise
  rd([[4, 23], [58, 23]]); // the mid street, two-way
  rd([[25, 10], [25, 36]]); // the cross aisle, two-way

  // a slow zone where the mid street crosses the cross aisle (a pedestrian crossing, in the story)
  const SZ = o.slowLimit;
  if (SZ < 1) {
    if (o.slowAt === 'crossing' || o.slowAt === 'all') { slow(layout, [[22 + OX, 23], [28 + OX, 23]], SZ); slow(layout, [[25 + OX, 20], [25 + OX, 26]], SZ); }
    if (o.slowAt === 'ringWest' || o.slowAt === 'all') slow(layout, [[4 + OX, 11], [4 + OX, 35]], SZ);
    if (o.slowAt === 'cross') slow(layout, [[25 + OX, 11], [25 + OX, 35]], SZ);
  }
  const trucks = (doors, extra = {}) => ({ trucks: { doors, checkIn: 300, checkOut: 300, ...extra } });

  // --- gates on the west side (spurs leave the ring to the west) ------------------------------------------------------------
  const steel = att({ type: 'source', name: 'Steel gate', from: [4, 13], side: 'W', len: 3, w: 6, h: 6, along: 1, more: [2], params: { outCap: 8, startDelay: 60 },
    ops: trucks(2, { interArrival: gapOf(o.steelGap), pallets: palOf(24) }) });
  const parts = att({ type: 'source', name: 'Parts gate', from: [4, 28], side: 'W', len: 3, w: 6, h: 6, along: 1, more: [2, 4], params: { outCap: 8, startDelay: 120 },
    ops: trucks(3, { interArrival: gapOf(o.partsGap), pallets: palOf(24) }) });
  const customer = att({ type: 'sink', name: 'Customer gate', from: [4, 34], side: 'W', len: 3, w: 6, h: 3, along: 0, more: [2],
    ops: trucks(2, { interArrival: gapOf(o.custGap), pallets: { kind: 'const', mean: 12, spread: 0 }, maxDwell: 3600, staging: 4 }) });
  const spares = att({ type: 'sink', name: 'Spares gate', from: [6, 36], side: 'S', len: 3, w: 4, h: 3, along: 1,
    ops: trucks(1, { interArrival: gapOf(o.spareGap), pallets: { kind: 'const', mean: 10, spread: 0 }, maxDwell: 3600, staging: 4 }) });

  // --- north band: coil store, press line, weld cell, paint shop (the material runs east, with the ring) ---------------------------
  const coil = att({ type: 'storage', name: 'Coil store', from: [8, 10], side: 'S', len: 3, w: 7, h: 6, along: 2, more: [3], params: { capacity: 120, dwell: 120 } });
  const press = att({ type: 'process', name: 'Press line', from: [20, 10], side: 'S', len: 3, w: 6, h: 6, along: 2, more: [3],
    params: { cycle: arrivals(o.pressCycle, 0.1), machines: 1, outPerCycle: 2, inCap: 6, outCap: 8 } });
  const weld = att({ type: 'process', name: 'Weld cell', from: [33, 10], side: 'S', len: 3, w: 7, h: 6, along: 2, more: [3], params: { cycle: arrivals(200, 0.1), machines: 2, inCap: 6, outCap: 4 } });
  const paint = att({ type: 'process', name: 'Paint shop', from: [46, 10], side: 'S', len: 3, w: 8, h: 6, along: 2, more: [4],
    params: { cycle: arrivals(o.paintCycle, 0.1), machines: o.paintMachines, inCap: 6, outCap: 6, mtbf: o.paintMtbf, mttr: o.paintMttr } });

  // --- south band: frame buffer, assembly, packing, finished goods, supermarket (the material runs west, with the ring) ------------
  const buffer = att({ type: 'storage', name: 'Frame buffer', from: [50, 36], side: 'N', len: 3, w: 6, h: 6, along: 2, more: [3], params: { capacity: 30, dwell: 0 } });
  const asm = att({ type: 'process', name: 'Assembly', from: [39, 36], side: 'N', len: 3, w: 8, h: 6, along: 2, more: [4], params: { cycle: arrivals(200, 0.1), machines: 2, inCap: 6, outCap: 4 } });
  const packing = att({ type: 'process', name: 'Packing', from: [29, 36], side: 'N', len: 3, w: 6, h: 6, along: 2, params: { cycle: arrivals(90, 0.1), inCap: 6, outCap: 6 } });
  const fg = att({ type: 'storage', name: 'FG store', from: [20, 36], side: 'N', len: 3, w: 6, h: 6, along: 2, more: [3], params: { capacity: 150, dwell: 60 } });
  const market = att({ type: 'storage', name: 'Parts supermarket', from: [11, 36], side: 'N', len: 3, w: 6, h: 6, along: 2, more: [3], params: { capacity: 200, dwell: 60 } });

  // --- second docks from the two-way mid street (every line station can be reached from both aisles) ---------------------------
  const MID = 23;
  for (const st of [coil, press, weld, paint]) { const cx = st.x + Math.floor(st.w / 2); road(layout, [[cx, MID], [cx, st.y + st.h]]); }
  for (const st of [market, fg, packing, asm, buffer]) { const cx = st.x + Math.floor(st.w / 2); road(layout, [[cx, MID], [cx, st.y - 1]]); }

  // --- depots ----------------------------------------------------------------------------------------------------------------
  const fPark = att({ type: 'depot', name: 'Forklift park', from: [4, 20], side: 'W', len: 2, w: 6, h: 3, along: 1, params: { slots: 8, chargers: o.chargersF } });
  const aPark = att({ type: 'depot', name: 'AGV charging', from: [58, 16], side: 'E', len: 2, w: 6, h: 4, along: 1, params: { slots: 12, chargers: o.chargersA } });
  const uPark = att({ type: 'depot', name: 'Tugger park', from: [4, 24], side: 'W', len: 2, w: 4, h: 3, along: 1, params: { slots: 4, chargers: 0 } });

  const fk = fleet(layout, 'forklift', { name: 'Forklifts', count: o.forklifts, capacity: 2, length: 2, home: fPark.id, battery: { enabled: true, runtimeMin: 300, chargeTimeMin: 60, lowPct: 25, resumePct: 90 } });
  const ag = fleet(layout, 'agv', { name: 'AGVs', count: o.agvs, home: aPark.id, battery: { enabled: true, runtimeMin: 180, chargeTimeMin: 60, lowPct: 25, resumePct: 90 } });
  const tg = fleet(layout, 'tugger', { name: 'Tugger trains', count: o.tuggers, length: 2, home: uPark.id });

  flow(layout, steel, coil, { fleetId: fk.id });
  flow(layout, parts, market, { fleetId: fk.id });
  flow(layout, coil, press, { fleetId: fk.id });
  flow(layout, press, weld, { fleetId: ag.id, perCycle: 2 });
  flow(layout, market, weld, { fleetId: tg.id, perCycle: 1, weight: 1, batchMin: 2, maxWait: 240 });
  flow(layout, weld, paint, { fleetId: ag.id });
  flow(layout, paint, buffer, { fleetId: ag.id });
  flow(layout, buffer, asm, { fleetId: ag.id });
  flow(layout, market, asm, { fleetId: tg.id, perCycle: 2, weight: 2, batchMin: 4, maxWait: 240 });
  flow(layout, asm, packing, { fleetId: ag.id });
  flow(layout, packing, fg, { fleetId: fk.id });
  flow(layout, fg, customer, { fleetId: fk.id, weight: 3 });
  flow(layout, fg, spares, { fleetId: fk.id, weight: 1 });

  label(layout, 8, 10.4, 'Receiving');
  label(layout, 44, 8.2, 'Press, weld, paint');
  label(layout, 52, 22, 'Mid street');
  label(layout, 36, 38.6, 'Assembly, packing, shipping');
  L.trimGrid(layout, { margin: 4 }); // no empty rows above the hall
  return layout;
}
