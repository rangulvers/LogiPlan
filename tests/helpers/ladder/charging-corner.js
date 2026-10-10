// Ladder example `charging-corner`: the edits its tips describe and the figures its tips print (docs/EXAMPLES-DESIGN.md section 6.2).
// `edits` are plain layout.js mutator calls applied to a fresh build by tests/helpers/ladder-runs.js (data travels to a worker as the name of an edit);
// `claims` are the numbers of the tips, measured as the mean of seeds 1 to 5 over 8 simulated hours (the convention of tests/sim.engine.review.test.js).
import { a, r } from '../ladder-runs.js';
import * as L from '../../../js/model/layout.js';

const fleetId = (l) => l.fleets[0].id;
const station = (l, name) => l.stations.find((s) => s.name === name);

export const edits = {
  nobat: (l) => L.updateFleet(l, fleetId(l), { battery: { enabled: false } }),
  ch1: (l) => L.updateStation(l, station(l, 'Charging bay').id, { params: { chargers: 1 } }),
  ch3: (l) => L.updateStation(l, station(l, 'Charging bay').id, { params: { chargers: 3 } }),
  res60: (l) => L.updateFleet(l, fleetId(l), { battery: { resumePct: 60 } }),
  charge120: (l) => L.updateFleet(l, fleetId(l), { battery: { chargeTimeMin: 120 } }),
  low0: (l) => L.updateFleet(l, fleetId(l), { battery: { lowPct: 0 } }),
};

export const claims = [
  a(1, 'base', 'Eforklifts_chg', 0, '16', 'charging %'),
  a(1, 'base', 'Eforklifts_util', 0, '64', 'busy %'),
  a(1, 'base', 'leadMean', 1, '8.2', 'lead time, min'),
  a(1, 'base', 'leadP95', 0, '27', 'lead time p95, min'),
  a(1, 'base', 'Goodsin_yardMax', 0, '20', 'pallets queued at Goods in (max)'),
  a(1, 'base', 'thr', 1, '60.3', 'pallets/h'),
  a(2, 'nobat', 'thr', 1, '60.3', 'pallets/h'),
  a(2, 'nobat', 'leadMean', 1, '4.1', 'lead time, min'),
  a(2, 'nobat', 'leadP95', 1, '4.4', 'lead time p95, min'),
  a(3, 'ch1', 'thr', 1, '53.6', 'pallets/h'),
  r(3, ['ch1', 'thr'], ['base', 'thr'], '-11', 'output change %'),
  a(3, 'ch1', 'leadMean', 0, '32', 'lead time, min'),
  a(3, 'ch1', 'wipNow', 0, '56', 'pallets in the plant at the end'),
  a(3, 'ch3', 'leadMean', 1, '6.5', 'lead time, min (3 chargers)'),
  a(4, 'res60', 'leadMean', 1, '4.3', 'lead time, min'),
  a(4, 'charge120', 'thr', 1, '50.4', 'pallets/h'),
  a(4, 'charge120', 'leadMean', 0, '44', 'lead time, min'),
  a(5, 'low0', 'thr', 1, '28.5', 'pallets/h'),
  r(5, ['low0', 'thr'], ['base', 'thr'], '-53', 'output change %'),
  a(5, 'low0', 'dead', 0, '6', 'vehicles dead on the road'),
];
