// Ladder example `yard-shuttle`: the edits its tips describe and the figures its tips print (docs/EXAMPLES-DESIGN.md section 6.3).
// `edits` are plain layout.js mutator calls applied to a fresh build by tests/helpers/ladder-runs.js (data travels to a worker as the name of an edit);
// `claims` are the numbers of the tips, measured as the mean of seeds 1 to 5 over 8 simulated hours (the convention of tests/sim.engine.review.test.js).
import { a, r } from '../ladder-runs.js';
import * as L from '../../../js/model/layout.js';

export const edits = {
  two: (l) => L.updateFleet(l, l.fleets[0].id, { count: 2 }),
  wait300: (l) => { for (const f of l.flows) L.updateFlow(l, f.id, { maxWait: 300 }); },
  cap4: (l) => L.updateFleet(l, l.fleets[0].id, { capacity: 4 }),
  cap1: (l) => L.updateFleet(l, l.fleets[0].id, { capacity: 1 }),
  d2: (l) => L.updateSettings(l, { demandFactor: 2 }),
};

export const claims = [
  a(1, 'base', 'thr', 0, '60', 'pallets/h (both directions)'),
  a(1, 'base', 'Yardtruck_util', 0, '52', 'truck busy %'),
  a(1, 'base', 'Yardtruck_park', 0, '45', 'truck parked %'),
  a(1, 'base', 'Yardtruck_trips', 1, '7.6', 'loaded trips per hour'),
  a(1, 'base', 'leadMean', 1, '11.4', 'lead time, min'),
  a(2, 'two', 'thr', 1, '60.4', 'pallets/h'),
  a(2, 'two', 'leadMean', 1, '10.9', 'lead time, min'),
  a(2, 'two', 'Yardtruck_util', 0, '28', 'truck busy %'),
  a(3, 'wait300', 'leadMean', 1, '6.9', 'lead time, min'),
  r(3, ['wait300', 'leadMean'], ['base', 'leadMean'], '-39', 'lead time change %'),
  a(3, 'wait300', 'Yardtruck_util', 0, '99', 'truck busy %'),
  a(3, 'wait300', 'Yardtruck_trips', 1, '17.4', 'loaded trips per hour'),
  a(4, 'cap4', 'thr', 1, '60.1', 'pallets/h'),
  a(4, 'cap4', 'leadMean', 1, '7.6', 'lead time, min'),
  a(4, 'cap4', 'Yardtruck_util', 0, '93', 'truck busy %'),
  a(4, 'cap1', 'thr', 1, '17.7', 'pallets/h (capacity 1)'),
  r(4, ['cap1', 'thr'], ['base', 'thr'], '-71', 'output change %'),
  a(4, 'cap1', 'wipNow', -1, '340', 'pallets in the plant at the end (capacity 1)'),
  a(5, 'd2', 'thr', 0, '121', 'pallets/h'),
  a(5, 'd2', 'Yardtruck_util', 0, '94', 'truck busy %'),
  a(5, 'd2', 'leadMean', 1, '8.1', 'lead time, min'),
];
