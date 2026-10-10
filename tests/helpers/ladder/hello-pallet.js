// Ladder example `hello-pallet`: the edits its tips describe and the figures its tips print (docs/EXAMPLES-DESIGN.md section 6.1).
// `edits` are plain layout.js mutator calls applied to a fresh build by tests/helpers/ladder-runs.js (data travels to a worker as the name of an edit);
// `claims` are the numbers of the tips, measured as the mean of seeds 1 to 5 over 8 simulated hours (the convention of tests/sim.engine.review.test.js).
import { a } from '../ladder-runs.js';
import * as L from '../../../js/model/layout.js';

export const edits = {
  d15: (l) => L.updateSettings(l, { demandFactor: 1.5 }),
  d2: (l) => L.updateSettings(l, { demandFactor: 2 }),
  d2two: (l) => { edits.d2(l); L.updateFleet(l, l.fleets[0].id, { count: 2 }); },
  d2fast2: (l) => { edits.d2(l); L.updateSettings(l, { speedFactor: 2 }); },
};

export const claims = [
  a(1, 'base', 'thr', 1, '24.0', 'pallets/h'),
  a(1, 'base', 'Forklift_util', 0, '77', 'forklift busy %'),
  a(1, 'base', 'leadMean', 1, '1.6', 'lead time, min'),
  a(2, 'd15', 'thr', 1, '32.8', 'pallets/h'),
  a(2, 'd15', 'Forklift_util', 0, '100', 'forklift busy %'),
  a(2, 'd15', 'leadMean', 0, '24', 'lead time, min'),
  a(2, 'd15', 'wipNow', 0, '27', 'pallets in the plant at the end'),
  a(3, 'd2two', 'thr', 1, '48.1', 'pallets/h (two forklifts)'),
  a(3, 'd2two', 'Forklift_util', 0, '78', 'forklift busy %'),
  a(3, 'd2two', 'leadMean', 1, '1.6', 'lead time, min'),
  a(3, 'd2', 'leadMean', 0, '79', 'lead time, min (one forklift)'),
  a(3, 'd2', 'wipNow', 0, '124', 'pallets in the plant at the end (one forklift)'),
  a(4, 'd2fast2', 'thr', 1, '43.8', 'pallets/h'),
  a(4, 'd2fast2', 'Forklift_util', 0, '100', 'forklift busy %'),
];
