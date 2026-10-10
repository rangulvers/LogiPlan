// Ladder example, level 1: "Hello, pallet" - one road, one forklift, no workstation. The one idea: a vehicle is a machine with a cycle time
// (round trip + hand-over), so it has a capacity you can calculate on the back of an envelope.
import { L, road, station, flow, label, fleet, arrivals } from './helpers.js';

export const meta = {
  id: 'hello-pallet',
  name: 'Hello, pallet: one forklift, one road',
  level: 1,
  rank: 1,
  description: 'One forklift, one road, one pallet every 2.5 minutes. How many can it carry? Work it out, then raise the demand.',
  learn: 'A vehicle is a machine with a cycle time, so its capacity can be calculated.',
  chips: ['1 forklift', 'napkin maths'],
  notes: 'The smallest plant there is. A pallet arrives at Goods in every 150 seconds (24 an hour) and one forklift carries it along 81 metres of road to Goods out. '
    + 'A forklift is a machine like any other: a trip is a drive of about 35 seconds (27 at full speed, plus speeding up and braking), the hand-over, the drive back and the next hand-over, '
    + 'about 110 seconds in all, so it can carry at most about 33 pallets an hour. Press play (at 600× the 8 hours of the tips take under a minute), open the Results tab and compare the pallets that arrive '
    + 'with the pallets that leave. Then raise "Demand" in the Simulate tab above 1.4 and watch what a vehicle that has no time left does to the queue.',
  tips: [
    'Press play and open the Results tab (set the speed in the bar above the plan to 600× and 8 hours take under a minute). Napkin first: each 81 m leg takes about 35 s (27 s at full speed, plus speeding up and braking) and the hand-over takes 20 s at each end, so one trip is about 110 s and one forklift can carry at most about 33 pallets an hour. The plant asks for 24, so the forklift is busy about 77 % of the time and a pallet is in the plant for under 2 minutes (over several runs: 24.0 pallets/h, lead time 1.6 min).',
    'Try: raise "Demand" in the Simulate tab to 1.5. The forklift cannot do more than about 33 trips an hour, so the output stops at 32.8 pallets/h instead of the 36 asked for, the forklift is busy 100 % of the time, the lead time grows from 1.6 to 24 minutes and about 27 pallets are in the plant at the end of 8 hours.',
    'Try: with "Demand" at 2, add a second forklift in the Fleet tab. The output is 48.1 pallets/h, each forklift is busy about 78 % of the time and the lead time is back at 1.6 minutes; with one forklift it was 79 minutes and 124 pallets were still in the plant after 8 hours.',
    'Try: with "Demand" at 2, set "Vehicle speed" to 2 instead. A forklift twice as fast does not carry twice as much: the output is only 43.8 pallets/h, not about 66, and the forklift is still busy 100 % of the time, because the 40 s of hand-over and the speeding up and braking of every trip do not get faster.',
  ],
};

export function build() {
  const layout = L.createLayout({ name: 'Hello, pallet', cols: 36, rows: 14, cellSize: 3 });
  L.setNotes(layout, meta.notes);

  road(layout, [[4, 7], [31, 7]]); // the one road, two-way, a dead end at both ends
  road(layout, [[17, 7], [17, 8]]); // a bay for the parking

  const goodsIn = station(layout, 'source', 'Goods in', 1, 6, { w: 3, h: 2 }, { interArrival: arrivals(150, 0.15), outCap: 6 });
  const goodsOut = station(layout, 'sink', 'Goods out', 32, 6, { w: 3, h: 2 });
  const park = station(layout, 'depot', 'Forklift park', 16, 9, { w: 3, h: 2 }, { slots: 2, chargers: 0 });

  flow(layout, goodsIn, goodsOut);
  fleet(layout, 'forklift', { name: 'Forklift', count: 1, home: park.id });

  label(layout, 2.5, 4.6, 'Goods in');
  label(layout, 33.5, 4.6, 'Goods out');
  label(layout, 18, 5.4, 'One road, 81 m');
  return layout;
}
