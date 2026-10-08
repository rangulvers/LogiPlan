// Test helper: build a complete layout from an ASCII picture. Used by sim tests so they do not
// depend on the layout editing API.
//
//   . empty        # wall (1x1 obstacle)     + two-way road      ^ > v <  one-way road cell
//   A-Z  station cells: all cells with the same letter form one station (rect = bounding box);
//        station id = the letter.
//
// Link rule between adjacent road cells A -> B:  A can exit toward B (A is '+' or A's arrow points at B)
// AND B accepts entry from A (B is '+' or B's arrow does not point back at A).
//
// Example:
//   const layout = layoutFromAscii([
//     'AA..BB',
//     '++++++',
//   ], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 1 }] });

import { emptyLayout, defaultStation, defaultFlow, defaultFleet } from '../../js/model/defaults.js';
import { DX, DY, DIR_BIT, N, E, S, W, opposite, cellKey } from '../../js/util/grid.js';

const ARROW = { '^': N, '>': E, v: S, '<': W };

export function layoutFromAscii(lines, opts = {}) {
  const rows = lines.length;
  const cols = Math.max(...lines.map((l) => l.length));
  const layout = emptyLayout({
    grid: { cols: Math.max(cols, 8), rows: Math.max(rows, 8), cellSize: opts.cellSize ?? 2 },
    settings: opts.settings || {},
  });
  if (opts.name) layout.name = opts.name;

  const at = (x, y) => (lines[y] && lines[y][x]) || '.';
  const isRoad = (ch) => ch === '+' || ch in ARROW;
  const stationCells = new Map();

  let obstacleId = 1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < lines[y].length; x++) {
      const ch = at(x, y);
      if (ch === '#') layout.obstacles.push({ id: 'o' + obstacleId++, x, y, w: 1, h: 1, kind: 'wall' });
      else if (/[A-Z]/.test(ch)) {
        if (!stationCells.has(ch)) stationCells.set(ch, []);
        stationCells.get(ch).push([x, y]);
      } else if (isRoad(ch)) layout.roads[cellKey(x, y)] = { out: 0 };
    }
  }

  for (const key of Object.keys(layout.roads)) {
    const [x, y] = key.split(',').map(Number);
    const ch = at(x, y);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      const nch = at(nx, ny);
      if (!isRoad(nch)) continue;
      const canExit = ch === '+' || ARROW[ch] === d;
      const canEnter = nch === '+' || ARROW[nch] !== opposite(d);
      if (canExit && canEnter) layout.roads[key].out |= DIR_BIT[d];
    }
  }

  for (const [letter, cells] of stationCells) {
    const xs = cells.map((c) => c[0]);
    const ys = cells.map((c) => c[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const spec = (opts.stations || {})[letter] ?? 'process';
    const { type, ...rest } = typeof spec === 'string' ? { type: spec } : spec;
    layout.stations.push(defaultStation(type, {
      id: letter, name: letter, x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1, ...rest,
    }));
  }

  let flowId = 1;
  for (const f of opts.flows || []) {
    const [from, to, extra] = Array.isArray(f) ? f : [f.from, f.to, f];
    layout.flows.push(defaultFlow({ id: 'f' + flowId++, from, to, ...(extra || {}) }));
  }

  let fleetId = 1;
  const fleets = opts.fleets || [{ count: 1 }];
  for (const f of fleets) {
    const { preset = 'agv', ...rest } = f;
    layout.fleets.push(defaultFleet(preset, { id: 'v' + fleetId++, ...rest }));
  }
  return layout;
}
