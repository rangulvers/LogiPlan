// Ladder example, level 2: electric forklifts with batteries and one charging bay. One idea: energy is a hidden capacity (runtime, charge time, low and resume level, chargers).
import { L, road, ring, flow, bay, fleet, label, arrivals } from './helpers.js';

export const meta = {
  id: 'charging-corner',
  name: 'Charging corner: six electric forklifts, two chargers',
  level: 2,
  rank: 3,
  description: 'Six electric forklifts, two chargers. The batteries start full and run low together: what does that do to the queue?',
  learn: 'Energy is a hidden capacity: no charge, no work, and the chargers are a station like any other.',
  chips: ['electric forklifts', 'batteries', 'chargers'],
  notes: 'Six electric forklifts carry pallets from Goods in through the Store to Goods out; one pallet arrives every minute. Each battery lasts 3 hours of driving and needs 60 minutes to fill from empty '
    + '(indicative values, shortened so that you see charging within one shift). A forklift whose battery falls below 30 % takes no more jobs and drives to the Charging bay, which has only two chargers; '
    + 'it comes back at 90 %. All batteries start full, so the forklifts run low at about the same time: that first charging wave, between hour 3 and hour 5, is what this plant is about. '
    + 'Set the speed to 600×, run it to hour 8 and watch the Results tab and the strip of the fleet in the Fleet tab: how many forklifts are away charging, and how long do pallets wait at Goods in? '
    + 'Every edit starts the run again from zero, so run to hour 8 again before you read the numbers.',
  tips: [
    'Press play, set the speed to 600× and run to hour 8. The batteries start full, so the forklifts run low together: between hour 3 and hour 5 the lead time jumps from 4 to about 20 minutes and up to 20 pallets queue at Goods in; from hour 5 on it is back at 4 minutes. Between hour 4 and hour 5 the Results tab warns that Goods in delivers more than the plant takes and that the forklifts are saturated: that is the wave, not a missing forklift (hour 8: "No bottlenecks"). Over several runs, at hour 8: a forklift spends about 16 % of its time charging, the fleet is busy 64 %, the mean lead time is 8.2 minutes, 95 % of the pallets are through within 27 minutes and the plant delivers 60.3 pallets/h.',
    'Try: switch "Model the battery" off in the Fleet tab and run to hour 8 again. The output is the same (60.3 pallets/h), but the mean lead time falls from 8.2 to 4.1 minutes and the time within which 95 % of the pallets are through from 27 to 4.4 minutes: while there are spare forklifts, the charging wave costs time, not output.',
    'Try: set "Charging slots" of the Charging bay to 1 (Properties tab). One charger cannot keep up with six forklifts, so the wave never ends: from hour 5 on a pallet waits about 50 minutes, the mean lead time over the 8 hours is 32 minutes, about 56 pallets are still in the plant at the end and the output falls to 53.6 pallets/h (-11 %). With three chargers the mean lead time is 6.5 minutes (8.2 with two): the third one helps much less than the second did.',
    'Try: let the forklifts go back to work at 60 % instead of 90 % ("Back to work at" in the Fleet tab, Battery). Each stop is shorter, so the forklifts are back sooner: the mean lead time falls from 8.2 to 4.3 minutes and nobody queues at Goods in. The other way round, a slow charger of 120 minutes (Charge time) gives 50.4 pallets/h and 44 minutes.',
    'Try: set "Go charging below" to 0 %. Nothing sends a forklift to the charger in time any more: all six run flat and stop where they stand (6 of 6 in all five runs), the output drops to 28.5 pallets/h (-53 %) and the Battery finding turns critical.',
  ],
};

export function build() {
  const o = { gap: 60, count: 6, runtime: 180, charge: 60, low: 30, resume: 90, chargers: 2, slots: 8 };
  const layout = L.createLayout({ name: 'Charging corner', cols: 56, rows: 30, cellSize: 2 });
  L.setNotes(layout, meta.notes);
  ring(layout, 5, 7, 50, 21);
  const goodsIn = bay(layout, [14, 7], 'N', 2, { type: 'source', name: 'Goods in', size: { w: 4, h: 2 }, params: { interArrival: arrivals(o.gap, 0.2), outCap: 8 } });
  const store = bay(layout, [24, 7], 'S', 3, { type: 'storage', name: 'Store', size: { w: 10, h: 8 }, params: { capacity: 300, dwell: 45 } });
  road(layout, [[28, 7], [28, 10]]); // second door of the store, beside the first
  const goodsOut = bay(layout, [50, 14], 'E', 2, { type: 'sink', name: 'Goods out', size: { w: 2, h: 4 } });
  const charging = bay(layout, [14, 21], 'S', 2, { type: 'depot', name: 'Charging bay', size: { w: 8, h: 3 }, params: { slots: o.slots, chargers: o.chargers } });
  flow(layout, goodsIn.station, store.station);
  flow(layout, store.station, goodsOut.station);
  fleet(layout, 'forklift', {
    name: 'E-forklifts', count: o.count, length: 2, home: charging.station.id,
    battery: { enabled: true, runtimeMin: o.runtime, chargeTimeMin: o.charge, lowPct: o.low, resumePct: o.resume },
  });
  label(layout, 8, 3.8, 'Receiving');
  label(layout, 46, 10.5, 'Shipping');
  label(layout, 27.5, 26.8, 'Two chargers for six forklifts');
  return layout;
}
