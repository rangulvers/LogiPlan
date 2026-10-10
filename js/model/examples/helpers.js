// Shared helpers of the six ladder examples (js/model/examples/<id>.js, docs/EXAMPLES-DESIGN.md 9.1). They are the helpers that js/model/examples.js
// keeps private for the first five examples, plus `slow`, `attach` and `bay` (a station at the end of a short spur off a road cell). Everything goes
// through the layout.js mutators; `must` throws when a mutator refused a request: an example that does not build is a bug, not a soft failure.
import { lPath } from '../../util/grid.js';
import * as L from '../layout.js';

export { L };

export function must(value, what) {
  if (!value) throw new Error(`examples: could not create ${what}`);
  return value;
}

/** Paint a straight-legged road through the corner points; every leg must be fully paintable. */
export function road(layout, points, { oneWay = false } = {}) {
  const cells = points.slice(1).reduce((acc, p, i) => acc.concat(lPath(...points[i], ...p).slice(1)), [points[0]]);
  const painted = L.paintRoadPath(layout, points, { oneWay });
  const want = new Set(cells.map((c) => c.join())).size;
  must(painted === want, `road ${JSON.stringify(points)} (painted ${painted} of ${want})`);
}

export function ring(layout, x0, y0, x1, y1, opts) {
  road(layout, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], opts);
}

export function station(layout, type, name, x, y, size, params, ops) {
  return must(L.addStation(layout, { type, name, x, y, ...size, params, ops }), `station "${name}" at ${x},${y}`);
}

export function flow(layout, from, to, patch) {
  return must(L.addFlow(layout, from.id, to.id, patch), `flow "${from.name}" -> "${to.name}"`);
}

export function obstacles(layout, kind, rects) {
  for (const [x, y, w, h] of rects) must(L.addObstacle(layout, { x, y, w, h, kind }), `${kind} at ${x},${y}`);
}

export function label(layout, x, y, text, size) {
  return must(L.addLabel(layout, { x, y, text, ...(size ? { size } : {}) }), `label ${text}`);
}

export const arrivals = (mean, spread = 0.15) => ({ kind: 'normal', mean, spread });

export function fleet(layout, preset, patch) {
  return must(L.addFleet(layout, preset, patch), `fleet ${preset}`);
}

/** A slow zone on a straight run of road cells (limit 0.1..1). */
export function slow(layout, points, limit) {
  const cells = points.slice(1).reduce((acc, p, i) => acc.concat(lPath(...points[i], ...p).slice(1)), [points[0]]);
  for (const [cx, cy] of cells) {
    const cell = L.roadAt(layout, cx, cy);
    if (cell && cell.limit === limit) continue;
    must(L.setRoadLimit(layout, cx, cy, limit), `slow zone at ${cx},${cy}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Placement helper: a station at the end of a short spur ("bay") off a road cell.
// ---------------------------------------------------------------------------------------------------------------------------

const SIDE = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

/**
 * Paint a spur of `len` cells from the road cell `from` = [x, y] towards `side` and put the station behind the end of the spur, so that the
 * last spur cell touches it. `along` is the offset of the spur against the station's face (0 = the spur meets the middle cell of the face).
 * `more`: further spur offsets along the face (cells), each gets its own spur (several docks of one station).
 * The station's rectangle is computed from w, h; returns the station.
 */
export function attach(layout, { type, name, from, side, len = 3, w, h, params, ops, more = [], along = null, twoWay = true }) {
  const [dx, dy] = SIDE[side];
  const [fx, fy] = from;
  const horizontal = side === 'E' || side === 'W';
  const faceLen = horizontal ? h : w;
  const off = along === null ? Math.floor(faceLen / 2) : along; // index of the spur cell on the face
  const lastX = fx + dx * len;
  const lastY = fy + dy * len;
  let x;
  let y;
  if (side === 'N') { x = lastX - off; y = lastY - h; }
  else if (side === 'S') { x = lastX - off; y = lastY + 1; }
  else if (side === 'E') { x = lastX + 1; y = lastY - off; }
  else { x = lastX - w; y = lastY - off; }
  road(layout, [[fx + dx, fy + dy], [lastX, lastY]], { oneWay: !twoWay });
  // make sure the spur is joined to the road cell it starts from (paintRoadPath links consecutive cells only)
  road(layout, [[fx, fy], [fx + dx, fy + dy]], { oneWay: !twoWay });
  const s = station(layout, type, name, x, y, { w, h }, params, ops);
  for (const m of more) {
    const mx = horizontal ? fx : fx + m;
    const my = horizontal ? fy + m : fy;
    road(layout, [[mx, my], [mx + dx, my + dy]]);
    road(layout, [[mx + dx, my + dy], [mx + dx * len, my + dy * len]]);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------------
// bay(): a side road of `len` cells that leaves the road cell [x, y] towards `side`, and a station centred on its end (from the capability prototypes)
// ---------------------------------------------------------------------------------------------------------------------------
export function bay(layout, [x, y], side, len, spec) {
  const [dx, dy] = SIDE[side];
  const end = [x + dx * len, y + dy * len];
  road(layout, [[x, y], end], { oneWay: spec.oneWay === true });
  const { w, h } = spec.size;
  const shift = spec.shift || 0;
  let sx; let sy;
  if (side === 'N') { sx = end[0] - Math.floor(w / 2) + shift; sy = end[1] - h; }
  else if (side === 'S') { sx = end[0] - Math.floor(w / 2) + shift; sy = end[1] + 1; }
  else if (side === 'E') { sx = end[0] + 1; sy = end[1] - Math.floor(h / 2) + shift; }
  else { sx = end[0] - w; sy = end[1] - Math.floor(h / 2) + shift; }
  const st = station(layout, spec.type, spec.name, sx, sy, spec.size, spec.params, spec.ops);
  return { station: st, end };
}
