// Ladder example, level 2: a shuttle on a long road. One idea: over a long distance the trip, not the hand-over, costs the time, so what
// a vehicle carries per trip (capacity, minimum batch, maximum wait) and whether it comes back loaded decide how many vehicles you need.
import { L, road, station, flow, label, fleet, arrivals } from './helpers.js';

export const meta = {
  id: 'yard-shuttle',
  name: 'Yard shuttle: one truck, 280 metres',
  level: 2,
  rank: 4,
  description: 'A truck carries pallets 280 m down a yard road and empties back. How long should it wait for a full load?',
  learn: 'Over a distance the batch decides: capacity and maximum wait set how many trucks you need.',
  chips: ['yard truck', 'batching', 'return load'],
  notes: 'A packing hall at the north end of the yard sends one pallet every 2 minutes to a warehouse 280 metres down the road, and the warehouse sends one empty pallet every 2 minutes back along the same road. '
    + 'One yard truck (8 pallets, 5 m/s, a full minute to load and a full minute to unload) does all the carrying. It leaves only when it has a full load of 8, or when the oldest pallet has waited 15 minutes. '
    + 'Over a long distance a trip is expensive, so what the truck takes per trip, and how long it waits for more, decides how many trucks you need and how long a pallet stays in the yard. '
    + 'Press play, set the speed to 600×, open the Results tab after 8 hours and look at the truck: is it busy, or parked and waiting for a batch?',
  tips: [
    'Press play and open the Results tab (at 600× the 8 hours take under a minute). 30 pallets/h go each way, 60 in all, and the Results tab finds nothing wrong. The truck waits for a full load of 8, so over several runs it is busy 52 % of the time and parked 45 %, makes 7.6 loaded trips an hour (3.8 round trips) and a pallet is in the yard for 11.4 minutes.',
    'Try: set "Vehicles" of the fleet to 2 in the Fleet tab. The output stays at 60.4 pallets/h and the lead time at 10.9 minutes, and each truck is busy only 28 % of the time: the truck was not the limit, the batch was.',
    'Try: set "Longest wait for a batch" of both flows to 300 s in the Flows tab. The lead time falls from 11.4 to 6.9 minutes (-39 %) at the same 60 pallets/h, but the truck is now busy 99 % of the time (17.4 loaded trips an hour, 8.7 round trips, instead of 7.6 and 3.8) and the finding says it is saturated: a shorter wait is paid for in truck time.',
    'Try: set the truck "Capacity" to 4 in the Fleet tab. The Checks tab warns that a batch of 8 can never be ready ("at most 4 can ever be ready"): the truck simply leaves with 4. The output is still 60.1 pallets/h, the lead time is 7.6 minutes and the truck is busy 93 % of the time. With "Capacity" 1 it carries one pallet per trip, only 17.7 pallets/h (-71 %) get through and about 340 pallets are waiting after 8 hours.',
    'Try: raise "Demand" in the Simulate tab to 2. The same truck carries 121 pallets/h and is busy 94 % of the time, and the lead time falls from 11.4 to 8.1 minutes: the batches fill twice as fast, so each trip is shared by more pallets.',
  ],
};

export function build() {
  const o = { gap: 120, emptiesGap: 120, capacity: 8, batchMin: 8, maxWait: 900, shuttles: 1, loadTime: 60, speed: 5 };
  const layout = L.createLayout({ name: 'Yard shuttle', cols: 60, rows: 44, cellSize: 4 });
  L.setNotes(layout, meta.notes);

  road(layout, [[4, 8], [48, 8], [48, 38]]); // the yard road: two-way, a dead end at both ends
  road(layout, [[7, 8], [7, 6]]); // Packing A bay
  road(layout, [[12, 8], [12, 9]]); // Empties store A bay
  road(layout, [[16, 8], [16, 6]]); // park bay
  road(layout, [[48, 34], [50, 34]]); // Warehouse B bay
  road(layout, [[48, 30], [46, 30]]); // Empties B bay

  const packing = station(layout, 'source', 'Packing A', 5, 4, { w: 8, h: 2 }, { interArrival: arrivals(o.gap, 0.15), outCap: 16 });
  const store = station(layout, 'sink', 'Empties store A', 10, 10, { w: 9, h: 2 });
  const warehouse = station(layout, 'sink', 'Warehouse B', 51, 33, { w: 8, h: 2 });
  const empties = station(layout, 'source', 'Empties B', 37, 29, { w: 9, h: 2 }, { interArrival: arrivals(o.emptiesGap, 0.15), outCap: 16 });
  const park = station(layout, 'depot', 'Yard park', 15, 4, { w: 3, h: 2 }, { slots: 3, chargers: 0 });

  const shuttle = fleet(layout, 'custom', {
    name: 'Yard truck', count: o.shuttles, capacity: o.capacity, speed: o.speed, accel: 1, decel: 1.5, length: 3.5, loadTime: o.loadTime, unloadTime: o.loadTime, home: park.id,
  });
  flow(layout, packing, warehouse, { batchMin: o.batchMin, maxWait: o.maxWait });
  flow(layout, empties, store, { batchMin: o.batchMin, maxWait: o.maxWait });
  label(layout, 8, 2.2, 'Packing hall A');
  label(layout, 55, 36.3, 'Warehouse B');
  label(layout, 27, 6.3, 'The yard road, 280 m');
  label(layout, 53, 18, 'One truck, 8 pallets');
  return layout;
}
