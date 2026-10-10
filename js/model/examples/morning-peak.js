// Ladder example, level 4: a cross-dock on a morning timetable. Two goods-in (suppliers on appointments, returns on a rate), staging lanes, three goods-out (two route
// waves on a timetable, an express dock), eight forklifts, and the peak hour.
import { L, road, ring, station, flow, fleet, label, arrivals } from './helpers.js';

const { createLayout, setNotes, updateCalendar: cal } = L;
const hhmm = (h, m = 0) => h * 3600 + m * 60;

/** Appointment rows: [time as [h, m], trucks at that time]. */
const SUPPLIERS = [[6, 0, 1], [6, 30, 1], [7, 0, 2], [7, 30, 2], [8, 0, 3], [8, 30, 3], [9, 0, 3], [9, 30, 3], [10, 0, 2], [10, 30, 1], [11, 0, 1]];
/** Route trucks: [h, m, pallets?] rows, 24 pallets unless the row says otherwise. */
const waves = (rows, plan = 24) => rows.map(([h, m, p]) => ({ at: hhmm(h, m), pallets: p ?? plan }));
const spread = (h, m, n, every = 0) => Array.from({ length: n }, (_, i) => ({ at: hhmm(h, m) + i * every, pallets: null }));
export const rowsFor = (table, gap = 600) => table.flatMap(([h, m, n]) => spread(h, m, n, gap));

export const meta = {
  id: 'morning-peak',
  name: 'Morning peak: a cross-dock on appointments',
  level: 4,
  rank: 9,
  description: 'A grocery cross-dock on a timetable: 22 supplier trucks, a peak from 08:00 to 10:00, eight forklifts. Size it for the peak.',
  learn: 'Size doors and forklifts for the peak hour, not the average: a better timetable is a lever too.',
  chips: ['day plant (clock)', 'timetables', '2 goods in, 3 goods out', 'one-way ring'],
  notes: 'A cross-dock of a grocery chain, on a day clock that starts at 06:00. 22 supplier trucks have appointments between 06:00 and 11:00, with a peak of 6 an hour between 08:00 and 10:00; a returns truck comes about once an hour. '
    + 'The pallets rest in the staging lanes and leave on route trucks (two gates of two doors each, a truck about every 15 minutes in all, each leaving after 40 minutes at the latest with whatever it has) and on an express truck. '
    + 'Eight forklifts do all the carrying; the ring road is one-way, so they never meet head-on. The average hour is easy, the peak hour is not: set the speed to 600×, run the clock to 14:00 (8 hours; the queue of the peak shows from about noon, because a wait is booked when a truck reaches a door) and open the Results tab. '
    + 'Every edit restarts the day at 06:00, so run to 14:00 again before you read the numbers. '
    + '(Times and truck sizes are indicative. Paste your own timetable into Suppliers, Properties tab, Trucks and doors.)',
  tips: [
    'Press play, set the speed to 600× and let the clock (in the sim bar) run to 14:00, then open the Results tab. At 10:00 it still looks quiet: a truck\'s wait is booked when it reaches a door, so the queue of the peak shows from about noon. Over several runs trucks wait 19 minutes on average at the supplier gate (the worst about 76 minutes, 4 to 5 trucks standing at once), hold a door for 78 minutes, the eight forklifts are busy 88 % of the time and 95 % of the pallets are through within 168 minutes. The findings say it is not the doors, it is the forklifts, as in Warehouse: first day; what this plant adds is the time of day.',
    'Try: replace the timetable of Suppliers by one truck every 15 minutes from 06:00 to 11:15 (Properties tab, Trucks and doors, Paste) and run to 14:00 again: the same 22 trucks. The gate wait falls from 19 to 8 minutes (-58 %), the worst from 76 to 42 minutes and the time within which 95 % of the pallets are through from 168 to 153 minutes, with the same forklifts. A better timetable does for the slowest pallets what two more forklifts do.',
    'Try: cut the forklifts to 6. The pallets for the route trucks arrive late, so trucks leave short and the output falls (58 against 69 pallets/h, -16 %): about 13 of the 28 route and express trucks leave without a full load (on average 5.4 of the west trucks, 4.8 of the east trucks and 2.8 of the express trucks), and the gate wait is 39 minutes (the worst 130).',
    'Try: raise the forklifts to 10 in the Fleet tab. The gate wait disappears (0.6 minutes, worst 6) and a truck holds its door for 53 instead of 78 minutes, but the forklifts are busy only 78 % of the time and waiting in traffic grows from 6.4 % to 9.6 %: capacity for the peak stands idle for the rest of the day.',
    'Try: make the ring two-way (draw over it with the Road tool). Trips get shorter: the gate queue is gone, a truck holds its door for 30 minutes and the forklifts are busy 69 % of the time, but they now wait in traffic 20 % of the time (6 % before) and the Traffic finding appears. A one-way ring costs distance, a two-way ring costs meetings.',
    'Try: set the doors of Suppliers to 4. The Checks tab says "doors too few" (4.8 doors are needed at the busiest hour of the timetable). The gate wait doubles to 38 minutes (the worst 109, 6 to 7 trucks queue) and a truck holds its door for 61 instead of 78 minutes, yet the same 69 pallets/h leave: fewer doors only move the queue from the doors to the gate.',
  ],
};

export function build() {
  const layout = createLayout({ name: 'Morning peak', cols: 60, rows: 44, cellSize: 3 });
  setNotes(layout, meta.notes);

  ring(layout, 4, 10, 55, 32, { oneWay: true });
  for (const x of [15, 17, 19, 21, 23, 25]) road(layout, [[x, 10], [x, 7]]); // six docks of the supplier gate
  road(layout, [[44, 10], [44, 7]]); // returns gate
  for (const x of [20, 24, 28, 32, 36]) road(layout, [[x, 10], [x, 14]]); // lanes, put-away side
  for (const x of [17, 21, 29, 33, 37]) road(layout, [[x, 32], [x, 27]]); // lanes, pick side
  for (const x of [10, 14, 26, 30]) road(layout, [[x, 32], [x, 36]]); // route dock gates
  for (const x of [44, 46]) road(layout, [[x, 32], [x, 36]]); // express
  road(layout, [[4, 21], [6, 21]]); // forklift park

  const suppliers = station(layout, 'source', 'Suppliers', 14, 5, { w: 13, h: 2 }, { outCap: 10 }, {
    trucks: { doors: 6, checkIn: 420, checkOut: 300, mode: 'schedule', schedule: rowsFor(SUPPLIERS), jitter: 600, noShow: 0.03, pallets: { kind: 'uniform', mean: 24, spread: 0.25 } },
  });
  const returns = station(layout, 'source', 'Returns', 43, 5, { w: 3, h: 2 }, { outCap: 8 }, {
    trucks: { doors: 1, checkIn: 300, checkOut: 300, mode: 'rate', interArrival: arrivals(3600, 0.3), pallets: { kind: 'uniform', mean: 8, spread: 0.4 } },
  });
  const lanes = station(layout, 'storage', 'Staging lanes', 17, 15, { w: 23, h: 12 }, { capacity: 200, dwell: 240 });
  const west = station(layout, 'sink', 'Stores west', 9, 37, { w: 9, h: 2 }, {}, {
    trucks: { doors: 2, checkIn: 300, checkOut: 300, mode: 'schedule', maxDwell: 2400, staging: 4, schedule: waves([[7, 30, 12], [8, 0, 12], [8, 30], [9, 0], [9, 30], [10, 0], [10, 30], [11, 0], [11, 30], [12, 0], [12, 30]]) },
  });
  const east = station(layout, 'sink', 'Stores east', 25, 37, { w: 9, h: 2 }, {}, {
    trucks: { doors: 2, checkIn: 300, checkOut: 300, mode: 'schedule', maxDwell: 2400, staging: 4, schedule: waves([[7, 45, 12], [8, 15, 12], [8, 45], [9, 15], [9, 45], [10, 15], [10, 45], [11, 15], [11, 45], [12, 15], [12, 45]]) },
  });
  const express = station(layout, 'sink', 'Express', 43, 37, { w: 7, h: 2 }, {}, {
    trucks: { doors: 1, checkIn: 180, checkOut: 180, mode: 'schedule', maxDwell: 1800, staging: 4, schedule: [{ at: hhmm(6, 40), pallets: 3 }, ...waves([[8, 30], [9, 30], [10, 30], [11, 30], [12, 30]], 12)] },
  });
  const park = station(layout, 'depot', 'Forklift park', 7, 20, { w: 3, h: 2 }, { slots: 10, chargers: 0 });

  flow(layout, suppliers, lanes);
  flow(layout, returns, lanes);
  flow(layout, lanes, west, { weight: 4 });
  flow(layout, lanes, east, { weight: 4 });
  flow(layout, lanes, express, { weight: 1.2, priority: 3 });
  fleet(layout, 'forklift', { name: 'Forklifts', count: 8, home: park.id });
  cal(layout, { startTod: hhmm(6, 0), startDay: 0 });
  label(layout, 17, 3.5, 'Supplier gate');
  label(layout, 12, 40.5, 'Route trucks');
  label(layout, 38, 34.4, 'One-way ring');
  label(layout, 45, 40.5, 'Express');
  return layout;
}
