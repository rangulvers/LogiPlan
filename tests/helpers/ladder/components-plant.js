// Ladder example `components-plant`: the edits its tips describe and the figures its tips print (docs/EXAMPLES-DESIGN.md section 6.5).
// `edits` are plain layout.js mutator calls applied to a fresh build by tests/helpers/ladder-runs.js (data travels to a worker as the name of an edit);
// `claims` are the numbers of the tips, measured as the mean of seeds 1 to 5 over 8 simulated hours (the convention of tests/sim.engine.review.test.js).
import { a, r, b } from '../ladder-runs.js';
import * as L from '../../../js/model/layout.js';

const fleetNamed = (l, name) => l.fleets.find((f) => f.name === name);
const station = (l, name) => l.stations.find((s) => s.name === name);

// The cells of the road edits are final cells of the built plant (trimGrid moved the hall by -1, -4): the mid street runs along y 19 from x 14 to 66
// (from just inside the west side of the ring to just inside the east side), the cross aisle along x 34 from y 7 to 31, crossing the mid street at (34, 19).
export const edits = {
  d12: (l) => L.updateSettings(l, { demandFactor: 1.2 }),
  d12paint2: (l) => { edits.d12(l); L.updateStation(l, station(l, 'Paint shop').id, { params: { machines: 2 } }); },
  noMid: (l) => { for (let x = 14; x <= 66; x++) L.eraseRoadCell(l, x, 19); },
  noCross: (l) => { for (let y = 7; y <= 31; y++) if (y !== 19) L.eraseRoadCell(l, 34, y); }, // two strokes, the crossing cell stays
  noCrossAll: (l) => { for (let y = 7; y <= 31; y++) L.eraseRoadCell(l, 34, y); }, // the crossing cell goes too
  noSlow: (l) => { for (const [k, c] of Object.entries(l.roads)) if (c.limit) L.setRoadLimit(l, ...k.split(',').map(Number), 1); },
};

export const claims = [
  a(1, 'base', 'thr', 1, '19.3', 'pallets/h'),
  a(1, 'base', 'Paintshop_u', 0, '85', 'paint shop busy %'),
  a(1, 'base', 'Assembly_st', 0, '47', 'assembly starved %'),
  a(1, 'base', 'Forklifts_util', 0, '44', 'forklifts busy %'),
  a(1, 'base', 'AGVs_util', 0, '50', 'AGVs busy %'),
  a(1, 'base', 'Tuggertrains_util', 0, '52', 'tugger trains busy %'),
  a(1, 'base', 'wait', 0, '9', 'waiting in traffic %'),
  a(2, 'd12', 'Paintshop_u', 0, '93', 'paint shop busy %'),
  a(2, 'd12', 'thr', 1, '20.6', 'pallets/h'),
  r(2, ['d12', 'thr'], ['base', 'thr'], '7', 'output change %'),
  b(2, 'd12', 'thr', 'between 18.7 and 22.3', 18.7, 22.3, 'pallets/h band'),
  a(2, 'd12paint2', 'thr', 1, '23.0', 'pallets/h'),
  r(2, ['d12paint2', 'thr'], ['base', 'thr'], '19', 'output change %'),
  a(2, 'd12paint2', 'Paintshop_u', 0, '52', 'paint shop busy %'),
  a(2, 'd12paint2', 'Pressline_u', 0, '90', 'press line busy %'),
  a(2, 'base', 'Pressline_u', 0, '74', 'press line busy %'),
  a(3, 'noMid', 'Forklifts_util', 0, '63', 'forklifts busy %'),
  a(3, 'noMid', 'Tuggertrains_util', 0, '79', 'tugger trains busy %'),
  a(3, 'noMid', 'wait', 0, '26', 'waiting in traffic %'),
  a(4, 'noCross', 'Forklifts_util', 0, '45', 'forklifts busy %'),
  a(4, 'noCross', 'wait', 0, '10', 'waiting in traffic %'),
  a(4, 'noCrossAll', 'Forklifts_util', 0, '54', 'forklifts busy % (crossing cell erased too)'),
  a(4, 'noCrossAll', 'wait', 0, '16', 'waiting in traffic % (crossing cell erased too)'),
  a(5, 'noSlow', 'Forklifts_util', 0, '40', 'forklifts busy %'),
  a(5, 'base', 'wait', 1, '9.3', 'waiting in traffic %'),
  a(5, 'noSlow', 'wait', 1, '8.0', 'waiting in traffic %'),
];
