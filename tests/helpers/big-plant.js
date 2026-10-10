// Test helper: the largest plant the app allows - 320 x 320 cells, about 17,000 road cells, 225 stations and 100 vehicles (docs/ENTITY-INSIGHTS-DESIGN.md 8, acceptance S1.5).
// A street grid every 12 cells, bays with Goods in / workstations / Goods out / depots along it, flows chained locally, two fleets that serve every flow.
// Built through the layout API, so a change of the API shows up here too.
import * as L from '../../js/model/layout.js';

export function bigPlant320({ vehicles = 100, size = 320, pitchX = 36 } = {}) {
  const layout = L.createLayout({ name: 'Big plant 320', cols: size, rows: size, cellSize: 2 });
  for (let k = 4; k < size; k += 12) {
    L.paintRoadPath(layout, [[2, k], [size - 3, k]]);
    L.paintRoadPath(layout, [[k, 2], [k, size - 3]]);
  }
  const place = (type, name, x, y, params, bay) => {
    const st = L.addStation(layout, { type, name, x, y, w: 3, h: 2, params });
    if (!st) throw new Error('station ' + name);
    L.paintRoadPath(layout, bay);
    return st;
  };
  let n = 0;
  const sources = []; const procs = []; const sinks = []; const depots = [];
  const rowsN = Math.floor((size - 16) / 12);
  for (let row = 0; row < rowsN; row++) {
    const y = 4 + row * 12 + 3;
    for (let x = 8, i = 0; x + 6 < size; x += pitchX, i++) {
      const bay = [[x + 1, 4 + row * 12], [x + 1, y]];
      if (row % 4 === 0 && i % 3 === 0) sources.push(place('source', `In ${n++}`, x, y + 1, { interArrival: { kind: 'normal', mean: 60, spread: 0.2 }, outCap: 6 }, bay));
      else if (row % 4 === 3 && i % 3 === 2) sinks.push(place('sink', `Out ${n++}`, x, y + 1, {}, bay));
      else if (row % 6 === 1 && i % 4 === 1) depots.push(place('depot', `Park ${n++}`, x, y + 1, { slots: 20, chargers: 4 }, bay));
      else procs.push(place('process', `Work ${n++}`, x, y + 1, { cycle: { kind: 'normal', mean: 90, spread: 0.1 }, inCap: 4, outCap: 4, machines: 2 }, bay));
    }
  }
  // local chains: every workstation is fed by one of the three nearest earlier stations of the row-major order
  procs.forEach((p, i) => {
    const from = i < sources.length ? sources[i] : procs[i - sources.length];
    L.addFlow(layout, from.id, p.id, {});
  });
  procs.slice(-Math.max(6, sinks.length)).forEach((p, i) => L.addFlow(layout, p.id, sinks[i % sinks.length].id, {}));
  const half = Math.floor(vehicles / 2);
  L.addFleet(layout, 'agv', { name: 'AGVs', count: vehicles - half, home: depots[0].id });
  L.addFleet(layout, 'forklift', { name: 'Forklifts', count: half, home: depots[Math.min(1, depots.length - 1)].id });
  layout.settings.warmup = 300;
  return { layout, stations: layout.stations.length, sources: sources.length, procs: procs.length, sinks: sinks.length, depots: depots.length, roadCells: Object.keys(layout.roads).length };
}
