// Ladder example `twin-plants`: the edits its tips describe and the figures its tips print (docs/EXAMPLES-DESIGN.md section 6.6).
// `edits` are plain layout.js mutator calls applied to a fresh build by tests/helpers/ladder-runs.js (data travels to a worker as the name of an edit);
// `claims` are the numbers of the tips, measured as the mean of seeds 1 to 5 over 8 simulated hours (the convention of tests/sim.engine.review.test.js).
import { a, m, r } from '../ladder-runs.js';
import * as L from '../../../js/model/layout.js';

const fleetNamed = (l, name) => l.fleets.find((f) => f.name === name);
const station = (l, name) => l.stations.find((s) => s.name === name);
const stationName = (l, id) => l.stations.find((s) => s.id === id).name;
/** The flows from the Central warehouse to the weld cells of plant A (the brackets). */
const bracketFlows = (l) => l.flows.filter((f) => stationName(l, f.from) === 'Central warehouse' && stationName(l, f.to).startsWith('A Weld'));

export const edits = {
  ch2: (l) => L.updateStation(l, station(l, 'Charging hall').id, { params: { chargers: 2 } }),
  ch3: (l) => L.updateStation(l, station(l, 'Charging hall').id, { params: { chargers: 3 } }),
  brkHalf: (l) => { for (const f of bracketFlows(l)) L.updateFlow(l, f.id, { weight: 0.5 }); },
  d15: (l) => L.updateSettings(l, { demandFactor: 1.5 }),
  yt3: (l) => L.updateFleet(l, fleetNamed(l, 'Yard trucks').id, { count: 3 }),
  anyFrame: (l) => {
    for (const f of l.flows) if (stationName(l, f.from) === 'A Frame dispatch' && stationName(l, f.to) === 'B Frame receiving') L.updateFlow(l, f.id, { fleetId: null });
  },
};

export const claims = [
  a(1, 'base', 'thr', 1, '17.7', 'pallets/h'),
  a(1, 'base', 'wipNow', -1, '150', 'pallets in the plant at hour 8'),
  a(1, 'base', 'wipNow', 0, '186', 'pallets in the plant at hour 24', 24),
  a(1, 'base', 'leadMean', 0, '134', 'lead time, min'),
  a(1, 'base', 'AGVsA_util', 0, '62', 'AGVs A busy %'),
  m(1, 'base', 'AGVsA_pw', 1, '2.4', 'AGVs A pickup wait, min'),
  a(2, 'ch2', 'thr', 1, '10.2', 'pallets/h (2 chargers)'),
  r(2, ['ch2', 'thr'], ['base', 'thr'], '-42', 'output change %'),
  a(2, 'ch2', 'wipNow', 0, '275', 'pallets in the plant (2 chargers)'),
  a(2, 'ch2', 'AGVsB_util', 0, '33', 'AGVs B busy % (2 chargers)'),
  a(2, 'base', 'AGVsB_util', 0, '60', 'AGVs B busy %'),
  a(2, 'ch2', 'AGVsB_park', 0, '62', 'AGVs B parked % (2 chargers)'),
  a(2, 'base', 'AGVsB_park', 0, '19', 'AGVs B parked %'),
  m(2, 'ch2', 'AGVsB_pw', 0, '20', 'AGVs B pickup wait, min (2 chargers)'),
  m(2, 'base', 'AGVsB_pw', 1, '1.6', 'AGVs B pickup wait, min'),
  a(2, 'ch3', 'thr', 1, '16.9', 'pallets/h (3 chargers)'),
  r(2, ['ch3', 'thr'], ['base', 'thr'], '-5', 'output change %'),
  a(3, 'brkHalf', 'thr', 1, '10.7', 'pallets/h'),
  r(3, ['brkHalf', 'thr'], ['base', 'thr'], '-40', 'output change %'),
  a(3, 'brkHalf', 'wipNow', 0, '418', 'pallets in the plant'),
  a(3, 'base', 'wipNow', 0, '151', 'pallets in the plant'),
  a(4, 'd15', 'thr', 1, '19.8', 'pallets/h'),
  r(4, ['d15', 'thr'], ['base', 'thr'], '12', 'output change %'),
  a(4, 'd15', 'wipNow', 0, '426', 'pallets in the plant'),
  a(4, 'd15', 'leadMean', 0, '165', 'lead time, min'),
  a(5, 'yt3', 'thr', 1, '17.3', 'pallets/h'),
  r(5, ['yt3', 'thr'], ['base', 'thr'], '-2', 'output change %'),
  a(5, 'yt3', 'Yardtrucks_util', 0, '69', 'yard trucks busy %'),
  a(5, 'base', 'Yardtrucks_util', 0, '40', 'yard trucks busy %'),
  m(5, 'yt3', 'Yardtrucks_pw', 0, '16', 'yard trucks pickup wait, min (3 trucks)'),
  m(5, 'base', 'Yardtrucks_pw', 0, '10', 'yard trucks pickup wait, min'),
  a(6, 'anyFrame', 'AGVsA_util', 0, '70', 'AGVs A busy %'),
  a(6, 'anyFrame', 'wait', 0, '10', 'waiting in traffic %'),
  a(6, 'base', 'wait', 1, '6.7', 'waiting in traffic %'),
];
