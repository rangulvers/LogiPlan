// Ladder example, level 5: two plants on one baseplate, joined by a yard. One idea: look at the campus as one system - the plants are zones of one
// plan (the model has no sites), the yard road, a dedicated shuttle fleet restricted to the inter-plant flows, a shared warehouse and a shared
// charging hall tie them together, and the limit of the whole is whichever plant is slower.
import { L, road, flow, label, fleet, arrivals, attach, slow } from './helpers.js';

const EXACT = { kind: 'const', spread: 0 };

export const meta = {
  id: 'twin-plants',
  name: 'Two plants, one yard',
  level: 5,
  rank: 11,
  description: 'Two plants on one baseplate, joined by a yard road, one warehouse, one charging hall and a shuttle fleet shared by both.',
  learn: 'A campus is one system: shared goods, a shuttle fleet, and the one resource both plants depend on.',
  chips: ['two plants (zones)', 'shared warehouse', 'shared charging hall', 'yard trucks'], // at most 4 (E1); the card shows the first three
  notes: 'Two plants on one baseplate, joined by a yard road. Plant A (west) presses, welds and paints car frames and moulds the trim; plant B (east) assembles, tests and packs them, and about one unit in twenty fails the quality check and goes back to plant A for rework. '
    + 'In the yard stand a parts gate, a central warehouse that feeds both plants and one charging hall for the electric vehicles of both. '
    + 'Six yard trucks may drive only the flows that cross the yard (frames and trim from A to B, rejects back to A) and the brackets for the weld cells of A; each plant has its own truck gates, forklifts and AGVs. '
    + 'LogiPlan has no site concept: the second plant is a zone of one big baseplate, so the Results tab has no per-plant figures; compare the plants through their stations and fleets. '
    + 'The central warehouse hands out its parts by fixed weights, not by who is short, and a pallet is a pallet: nothing tells a returned unit from a new one. '
    + 'The trucks come on a fixed rhythm, so the plant settles instead of drifting. The first two hours are warm-up and are not measured: set the speed to 600×, run to hour 8 and open the Results tab (a whole day takes 72 seconds at 1200×).',
  tips: [
    'Press play, set the speed to 600× and run to hour 8 (the first two plant hours are warm-up), then open the Results tab. Over several runs 17.7 pallets/h leave through the four customer gates, about 150 pallets are in the plant (186 after 24 hours: the plant settles) and the mean lead time is 134 minutes. 30 vehicles in 7 fleets work in the plants and the yard; the one warning names the AGVs of plant A (62 % busy, a load waits about 2.4 minutes for one).',
    'Try: set "Charging slots" of the Charging hall to 2 (Properties tab) and run to hour 8 again. It is the one thing both plants share, and it stops both: the output falls from 17.7 to 10.2 pallets/h (-42 %), the loads in the plant climb from 151 to 275, the AGVs of plant B are busy 33 % of the time instead of 60 % and parked 62 % instead of 19 % while they wait for a charger, and a load waits 20 minutes for one of them instead of 1.6. With 3 chargers the output is still 16.9 pallets/h (-5 %): the hall has a cliff, not a slope.',
    'Try: halve the weights of the two flows from the Central warehouse to A Weld 1 and A Weld 2 (Flows tab, Weight 1 to 0.5). The warehouse hands out its parts by fixed weights, not by who is short: plant A now gets far fewer brackets than its welds need, the output falls from 17.7 to 10.7 pallets/h (-40 %), the loads in the plant climb from 151 to 418 and both press lines are blocked, while the parts of the other flows pile up in the warehouse (5 times as full as before).',
    'Try: raise "Demand" in the Simulate tab to 1.5. The campus reaches its limit: the output rises by only 12 % (19.8 pallets/h, not the 27 that is asked for), the loads in the plant climb from 151 to 426, the mean lead time grows from 134 to 165 minutes, trucks at the retail and export gates leave short and the findings name the press lines and the moulding as bottlenecks (each in at least 3 of 5 runs).',
    'Try: halve the yard trucks (3 instead of 6 in the Fleet tab). The output hardly changes (17.3 pallets/h, -2 %), but the trucks are busy 69 % of the time instead of 40 % and a load waits 16 minutes for one instead of 10: the fleet had twice the trucks the campus needs.',
    'Try: let any vehicle drive the frame shuttle (Flows tab: A Frame dispatch to B Frame receiving, Vehicles: Any fleet). The AGVs of plant A now take the long trips between their own jobs: they are busy 70 % of the time instead of 62 % and the share of driving time spent waiting in traffic grows from 6.7 % to 10 %. A dedicated shuttle fleet protects the work inside the plants.',
  ],
};

export function build() {
  const o = {
    fkA: 3, agvA: 7, fkY: 2, trucks: 6, tug: 3, agvB: 6, fkB: 3, chargers: 6, shuttleBatch: 6, shuttleWait: 600, passWeight: 19,
    steelGap: 4550, partsGap: 1560, retailGap: 4710, exportGap: 7850, spareGap: 15700, plasticGap: 4720, aCustGap: 14400, pressCycle: 300, weldCycle: 250, paintCycle: 280, mouldCycle: 150, asmCycle: 300, qualityCycle: 110, packCycle: 120, yardBay: 3, exact: true
  };
  const gapOf = (mean) => ({ ...EXACT, mean }); // the trucks come on a fixed rhythm: constant gaps and pallets, so the plant settles (docs/EXAMPLES-DESIGN.md 3.3)
  const palOf = (mean) => ({ ...EXACT, mean });
  const layout = L.createLayout({ name: 'Two plants, one yard', cols: 176, rows: 54, cellSize: 2 });
  L.setNotes(layout, meta.notes);
  L.updateSettings(layout, { warmup: 7200 });
  const OX = 10;
  const rd = (pts, opt) => road(layout, pts.map(([x, y]) => [x + OX, y]), opt);
  const att = (spec) => attach(layout, { ...spec, from: [spec.from[0] + OX, spec.from[1]] });
  const trucksOps = (doors, extra = {}) => ({ trucks: { doors, checkIn: 300, checkOut: 300, ...extra } });

  // ---------- roads: plant A ring (two-way) + mid street through the yard to plant B ring ----------
  rd([[0, 8], [50, 8], [50, 40], [0, 40], [0, 8]]);     // plant A ring: x 0..50
  rd([[96, 8], [146, 8], [146, 40], [96, 40], [96, 8]]); // plant B ring: x 96..146
  rd([[0, 24], [146, 24]]);                               // the mid street, through the yard

  // speed limits where the yard road meets the plant gates
  slow(layout, [[52 + OX, 24], [60 + OX, 24]], 0.5);
  slow(layout, [[88 + OX, 24], [96 + OX, 24]], 0.5);

  // ---------- plant A: components (two lines) ----------
  const steel = att({ type: 'source', name: 'A Steel gate', from: [0, 12], side: 'W', len: 3, w: 6, h: 6, along: 1, more: [2, 4], params: { outCap: 8, startDelay: 60 },
    ops: trucksOps(3, { interArrival: gapOf(o.steelGap), pallets: palOf(24) }) });
  const coil = att({ type: 'storage', name: 'A Coil store', from: [8, 8], side: 'S', len: 3, w: 7, h: 6, along: 2, more: [3], params: { capacity: 160, dwell: 120 } });
  const press1 = att({ type: 'process', name: 'A Press 1', from: [19, 8], side: 'S', len: 3, w: 6, h: 6, along: 2, params: { cycle: arrivals(o.pressCycle, 0.1), outPerCycle: 2, inCap: 6, outCap: 8 } });
  const weld1 = att({ type: 'process', name: 'A Weld 1', from: [28, 8], side: 'S', len: 3, w: 6, h: 6, along: 2, params: { cycle: arrivals(o.weldCycle, 0.1), inCap: 6, outCap: 4 } });
  const paint1 = att({ type: 'process', name: 'A Paint 1', from: [38, 8], side: 'S', len: 3, w: 7, h: 6, along: 2, params: { cycle: arrivals(o.paintCycle, 0.1), inCap: 6, outCap: 6, mtbf: 10800, mttr: 720 } });
  const press2 = att({ type: 'process', name: 'A Press 2', from: [19, 40], side: 'N', len: 3, w: 6, h: 6, along: 2, params: { cycle: arrivals(o.pressCycle, 0.1), outPerCycle: 2, inCap: 6, outCap: 8 } });
  const weld2 = att({ type: 'process', name: 'A Weld 2', from: [28, 40], side: 'N', len: 3, w: 6, h: 6, along: 2, params: { cycle: arrivals(o.weldCycle, 0.1), inCap: 6, outCap: 4 } });
  const paint2 = att({ type: 'process', name: 'A Paint 2', from: [38, 40], side: 'N', len: 3, w: 7, h: 6, along: 2, params: { cycle: arrivals(o.paintCycle, 0.1), inCap: 6, outCap: 6, mtbf: 10800, mttr: 720 } });
  const plastics = att({ type: 'source', name: 'A Plastics gate', from: [8, 40], side: 'S', len: 3, w: 6, h: 4, along: 1, more: [2], params: { outCap: 8, startDelay: 90 },
    ops: trucksOps(2, { interArrival: gapOf(o.plasticGap), pallets: palOf(24) }) });
  const moulding = att({ type: 'process', name: 'A Moulding', from: [8, 40], side: 'N', len: 3, w: 7, h: 6, along: 3, more: [-3, 3], params: { cycle: arrivals(o.mouldCycle, 0.1), machines: 1, inCap: 6, outCap: 8 } });
  const trimStore = att({ type: 'storage', name: 'A Trim store', from: [0, 28], side: 'W', len: 3, w: 6, h: 4, along: 1, params: { capacity: 120, dwell: 0 } });
  const aCustomer = att({ type: 'sink', name: 'A Customer gate', from: [44, 8], side: 'N', len: 3, w: 6, h: 3, along: 1, more: [3],
    ops: trucksOps(1, { interArrival: gapOf(o.aCustGap), pallets: { kind: 'const', mean: 6, spread: 0 }, maxDwell: 3600, staging: 4 }) });
  const rework = att({ type: 'process', name: 'A Rework', from: [56, 24], side: 'S', len: 2, w: 6, h: 4, along: 3, params: { cycle: arrivals(170, 0.1), inCap: 6, outCap: 6 } });
  const frameOut = att({ type: 'storage', name: 'A Frame dispatch', from: [56, 24], side: 'N', len: 2, w: 8, h: 7, along: 4, more: [-3, 3], params: { capacity: 80, dwell: 0 } });
  const aFork = att({ type: 'depot', name: 'A Forklift park', from: [0, 24], side: 'W', len: 2, w: 6, h: 3, along: 1, params: { slots: 6, chargers: 0 } });
  const aAgv = att({ type: 'depot', name: 'A AGV park', from: [30, 40], side: 'S', len: 2, w: 7, h: 3, along: 3, params: { slots: 10, chargers: 0 } });

  // ---------- yard ----------
  const partsGate = att({ type: 'source', name: 'Yard Parts gate', from: [63, 24], side: 'N', len: o.yardBay, w: 8, h: 6, along: 1, more: [2, 4, 6], params: { outCap: 8, startDelay: 120 },
    ops: trucksOps(4, { interArrival: gapOf(o.partsGap), pallets: palOf(24) }) });
  const warehouse = att({ type: 'storage', name: 'Central warehouse', from: [78, 24], side: 'N', len: o.yardBay, w: 14, h: 7, along: 6, more: [-4, 4], params: { capacity: 500, dwell: 120 } });
  const hall = att({ type: 'depot', name: 'Charging hall', from: [72, 24], side: 'S', len: 2, w: 26, h: 5, along: 12, more: [-8, -4, 4, 8], params: { slots: 48, chargers: o.chargers } });
  const yardPark = att({ type: 'depot', name: 'Yard truck park', from: [88, 24], side: 'S', len: 2, w: 5, h: 3, along: 2, params: { slots: 8, chargers: 0 } });

  // ---------- plant B: assembly and shipping ----------
  const frameIn = att({ type: 'storage', name: 'B Frame receiving', from: [90, 24], side: 'N', len: 2, w: 8, h: 7, along: 4, more: [-3, 3], params: { capacity: 80, dwell: 0 } });
  const asm1 = att({ type: 'process', name: 'B Assembly 1', from: [104, 8], side: 'S', len: 3, w: 7, h: 6, along: 3, params: { cycle: arrivals(o.asmCycle, 0.1), inCap: 6, outCap: 6 } });
  const asm2 = att({ type: 'process', name: 'B Assembly 2', from: [104, 40], side: 'N', len: 3, w: 7, h: 6, along: 3, params: { cycle: arrivals(o.asmCycle, 0.1), inCap: 6, outCap: 6 } });
  const testBuf = att({ type: 'storage', name: 'B Test buffer', from: [116, 8], side: 'S', len: 3, w: 6, h: 6, along: 2, more: [3], params: { capacity: 30, dwell: 0 } });
  const quality = att({ type: 'process', name: 'B Quality', from: [121, 8], side: 'S', len: 3, w: 4, h: 6, along: 1, params: { cycle: arrivals(o.qualityCycle, 0.1), inCap: 6, outCap: 6 } });
  const packing = att({ type: 'process', name: 'B Packing', from: [126, 8], side: 'S', len: 3, w: 6, h: 6, along: 2, params: { cycle: arrivals(o.packCycle, 0.1), inCap: 6, outCap: 6 } });
  const fgB = att({ type: 'storage', name: 'B FG store', from: [126, 40], side: 'N', len: 3, w: 8, h: 6, along: 3, more: [3], params: { capacity: 200, dwell: 60 } });
  const retail = att({ type: 'sink', name: 'B Retail gate', from: [146, 14], side: 'E', len: 3, w: 6, h: 6, along: 1, more: [2, 4],
    ops: trucksOps(3, { interArrival: gapOf(o.retailGap), pallets: { kind: 'const', mean: 12, spread: 0 }, maxDwell: 3600, staging: 4 }) });
  const exportG = att({ type: 'sink', name: 'B Export gate', from: [146, 30], side: 'E', len: 3, w: 6, h: 4, along: 1, more: [2],
    ops: trucksOps(2, { interArrival: gapOf(o.exportGap), pallets: { kind: 'const', mean: 12, spread: 0 }, maxDwell: 3600, staging: 4 }) });
  const spares = att({ type: 'sink', name: 'B Spares gate', from: [146, 36], side: 'E', len: 3, w: 6, h: 3, along: 1,
    ops: trucksOps(1, { interArrival: gapOf(o.spareGap), pallets: { kind: 'const', mean: 8, spread: 0 }, maxDwell: 3600, staging: 4 }) });
  const bFork = att({ type: 'depot', name: 'B Forklift park', from: [146, 24], side: 'E', len: 2, w: 6, h: 3, along: 1, params: { slots: 6, chargers: 0 } });
  const bAgv = att({ type: 'depot', name: 'B AGV park', from: [112, 40], side: 'S', len: 2, w: 7, h: 3, along: 3, params: { slots: 10, chargers: 0 } });
  const bTug = att({ type: 'depot', name: 'B Tugger park', from: [96, 34], side: 'W', len: 2, w: 4, h: 3, along: 1, params: { slots: 3, chargers: 0 } });

  // second docks from the mid street for the band stations
  for (const st of [coil, press1, weld1, paint1, asm1, testBuf, quality, packing]) { const cx = st.x + Math.floor(st.w / 2); road(layout, [[cx, 24], [cx, st.y + st.h]]); }
  for (const st of [press2, weld2, paint2, asm2, fgB, moulding]) { const cx = st.x + Math.floor(st.w / 2); road(layout, [[cx, 24], [cx, st.y - 1]]); }

  // ---------- fleets ----------
  const bat = (runtimeMin, chargeTimeMin) => ({ enabled: true, runtimeMin, chargeTimeMin, lowPct: 25, resumePct: 90 });
  const fA = fleet(layout, 'forklift', { name: 'Forklifts A', count: o.fkA, capacity: 2, length: 2, home: aFork.id, battery: bat(300, 60) });
  const gA = fleet(layout, 'agv', { name: 'AGVs A', count: o.agvA, home: aAgv.id, battery: bat(180, 60) });
  const fY = fleet(layout, 'forklift', { name: 'Yard forklifts', count: o.fkY, capacity: 2, length: 2, home: yardPark.id, battery: bat(300, 60) });
  const yt = fleet(layout, 'custom', { name: 'Yard trucks', count: o.trucks, capacity: 6, speed: 4, accel: 1, decel: 1.5, length: 2, loadTime: 40, unloadTime: 40, home: yardPark.id, battery: bat(240, 60) });
  const tg = fleet(layout, 'tugger', { name: 'Tugger B', count: o.tug, length: 2, home: bTug.id });
  const gB = fleet(layout, 'agv', { name: 'AGVs B', count: o.agvB, home: bAgv.id, battery: bat(180, 60) });
  const fB = fleet(layout, 'forklift', { name: 'Forklifts B', count: o.fkB, capacity: 2, length: 2, home: bFork.id, battery: bat(300, 60) });

  // ---------- flows ----------
  flow(layout, steel, coil, { fleetId: fA.id });
  flow(layout, coil, press1, { fleetId: fA.id });
  flow(layout, coil, press2, { fleetId: fA.id });
  flow(layout, press1, weld1, { fleetId: gA.id, perCycle: 2 });
  flow(layout, press2, weld2, { fleetId: gA.id, perCycle: 2 });
  flow(layout, partsGate, warehouse, { fleetId: fY.id });
  flow(layout, warehouse, weld1, { fleetId: yt.id, batchMin: 2, maxWait: 300, weight: 1 });
  flow(layout, warehouse, weld2, { fleetId: yt.id, batchMin: 2, maxWait: 300, weight: 1 });
  flow(layout, weld1, paint1, { fleetId: gA.id });
  flow(layout, weld2, paint2, { fleetId: gA.id });
  flow(layout, paint1, frameOut, { fleetId: gA.id });
  flow(layout, paint2, frameOut, { fleetId: gA.id });
  flow(layout, frameOut, frameIn, { fleetId: yt.id, batchMin: o.shuttleBatch, maxWait: o.shuttleWait, weight: 12 });
  flow(layout, frameOut, aCustomer, { fleetId: fA.id, weight: 1 });
  flow(layout, plastics, moulding, { fleetId: fA.id });
  flow(layout, moulding, trimStore, { fleetId: gA.id });
  flow(layout, trimStore, asm1, { fleetId: yt.id, batchMin: 4, maxWait: 600, weight: 1 });
  flow(layout, trimStore, asm2, { fleetId: yt.id, batchMin: 4, maxWait: 600, weight: 1 });
  flow(layout, frameIn, asm1, { fleetId: gB.id });
  flow(layout, frameIn, asm2, { fleetId: gB.id });
  flow(layout, warehouse, asm1, { fleetId: tg.id, perCycle: 2, batchMin: 4, maxWait: 300, weight: 2 });
  flow(layout, warehouse, asm2, { fleetId: tg.id, perCycle: 2, batchMin: 4, maxWait: 300, weight: 2 });
  flow(layout, asm1, testBuf, { fleetId: gB.id });
  flow(layout, asm2, testBuf, { fleetId: gB.id });
  flow(layout, testBuf, quality, { fleetId: gB.id });
  flow(layout, quality, packing, { fleetId: gB.id, weight: o.passWeight });
  flow(layout, quality, rework, { fleetId: yt.id, batchMin: 2, maxWait: 900, weight: 1 }); // about 1 unit in 20 fails the check and goes back to plant A
  flow(layout, rework, frameOut, { fleetId: gA.id });
  flow(layout, packing, fgB, { fleetId: fB.id });
  flow(layout, fgB, retail, { fleetId: fB.id, weight: 5 });
  flow(layout, fgB, exportG, { fleetId: fB.id, weight: 3 });
  flow(layout, fgB, spares, { fleetId: fB.id, weight: 1 });

  label(layout, 36, 5.6, 'PLANT A: frames and trim', 1.4);
  label(layout, 83, 10.6, 'THE YARD', 1.4);
  label(layout, 133, 5.6, 'PLANT B: assembly and shipping', 1.4);
  label(layout, 4, 9.2, 'Receiving');
  label(layout, 82, 22.2, 'Yard road');
  L.trimGrid(layout, { margin: 4 });
  return layout;
}
