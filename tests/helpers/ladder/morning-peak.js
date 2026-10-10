// Ladder example `morning-peak`: the edits its tips describe and the figures its tips print (docs/EXAMPLES-DESIGN.md section 6.4).
// `edits` are plain layout.js mutator calls applied to a fresh build by tests/helpers/ladder-runs.js (data travels to a worker as the name of an edit);
// `claims` are the numbers of the tips, measured as the mean of seeds 1 to 5 over 8 simulated hours (the convention of tests/sim.engine.review.test.js).
import { a, r, b } from '../ladder-runs.js';
import * as L from '../../../js/model/layout.js';

const hhmm = (h, mi = 0) => h * 3600 + mi * 60;
const fleetId = (l) => l.fleets[0].id;
const byName = (l, name) => l.stations.find((s) => s.name === name);
/** One truck every 15 minutes from 06:00 to 11:15: the same 22 trucks as the timetable of the example, spread evenly. */
const flatRows = () => Array.from({ length: 22 }, (_, i) => ({ at: hhmm(6, 0) + i * 900, pallets: null }));

export const edits = {
  flat: (l) => L.updateStation(l, byName(l, 'Suppliers').id, { ops: { trucks: { schedule: flatRows() } } }),
  f6: (l) => L.updateFleet(l, fleetId(l), { count: 6 }),
  f10: (l) => L.updateFleet(l, fleetId(l), { count: 10 }),
  // draw over the whole ring with the Road tool, two-way
  twoWay: (l) => { L.paintRoadPath(l, [[4, 10], [55, 10], [55, 32], [4, 32], [4, 10]], { oneWay: false }); },
  doors4: (l) => L.updateStation(l, byName(l, 'Suppliers').id, { ops: { trucks: { doors: 4 } } }),
};

export const claims = [
  a(1, 'base', 'Suppliers_gate', 0, '19', 'gate wait, min'),
  a(1, 'base', 'Suppliers_gmax', 0, '76', 'worst gate wait, min'),
  b(1, 'base', 'Suppliers_gq', '4 to 5', 4, 5, 'trucks at the gate at once (max)'),
  a(1, 'base', 'Suppliers_door', 0, '78', 'door time, min'),
  a(1, 'base', 'Forklifts_util', 0, '88', 'forklifts busy %'),
  a(1, 'base', 'leadP95', 0, '168', 'lead time p95, min'),
  a(2, 'flat', 'Suppliers_gate', 0, '8', 'gate wait, min'),
  r(2, ['flat', 'Suppliers_gate'], ['base', 'Suppliers_gate'], '-58', 'gate wait change %'),
  a(2, 'flat', 'Suppliers_gmax', 0, '42', 'worst gate wait, min'),
  a(2, 'flat', 'leadP95', 0, '153', 'lead time p95, min'),
  a(3, 'f6', 'thr', 0, '58', 'pallets/h (6 forklifts)'),
  a(3, 'base', 'thr', 0, '69', 'pallets/h'),
  r(3, ['f6', 'thr'], ['base', 'thr'], '-16', 'output change %'),
  a(3, 'f6', 'Storeswest_short', 1, '5.4', 'west trucks that left short'),
  a(3, 'f6', 'Storeseast_short', 1, '4.8', 'east trucks that left short'),
  a(3, 'f6', 'Express_short', 1, '2.8', 'express trucks that left short'),
  a(3, 'f6', 'Suppliers_gate', 0, '39', 'gate wait, min'),
  a(3, 'f6', 'Suppliers_gmax', 0, '130', 'worst gate wait, min'),
  a(4, 'f10', 'Suppliers_gate', 1, '0.6', 'gate wait, min'),
  a(4, 'f10', 'Suppliers_gmax', 0, '6', 'worst gate wait, min'),
  a(4, 'f10', 'Suppliers_door', 0, '53', 'door time, min'),
  a(4, 'f10', 'Forklifts_util', 0, '78', 'forklifts busy %'),
  a(4, 'base', 'wait', 1, '6.4', 'waiting in traffic %'),
  a(4, 'f10', 'wait', 1, '9.6', 'waiting in traffic %'),
  a(5, 'twoWay', 'Suppliers_door', 0, '30', 'door time, min'),
  a(5, 'twoWay', 'Forklifts_util', 0, '69', 'forklifts busy %'),
  a(5, 'twoWay', 'wait', 0, '20', 'waiting in traffic %'),
  a(5, 'base', 'wait', 0, '6', 'waiting in traffic %'),
  a(6, 'doors4', 'Suppliers_gate', 0, '38', 'gate wait, min'),
  a(6, 'doors4', 'Suppliers_gmax', 0, '109', 'worst gate wait, min'),
  b(6, 'doors4', 'Suppliers_gq', '6 to 7', 6, 7, 'trucks at the gate at once (max)'),
  a(6, 'doors4', 'Suppliers_door', 0, '61', 'door time, min'),
  a(6, 'doors4', 'thr', 0, '69', 'pallets/h'),
];
