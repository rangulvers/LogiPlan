// Plan checks in a planner's language: validateLayout(layout, { graph? }) -> Issue[].
//
// Issue = { id, severity: 'error'|'warning'|'info', code, message, hint, refs: { stationId?, flowId?, fleetId?, cells? } }
// `id` is `${code}:${ref}` (ref = station/flow/fleet id, a cell "cx,cy", or 'layout'), so it stays the same
// between runs and the UI can remember dismissed issues. Issues come back sorted: errors, warnings, infos.
//
// Reachability honours the same routing rule as the simulation (docs/ARCHITECTURE.md §5.1): vehicles search over
// directed edges and may not turn around on the spot, except at a cell that offers no other exit. With
// `opts.graph` (a sim graph) its `graph.search(from, { arrivalEdge }).dist(to)` decides; otherwise an internal
// search over `layout.roads` with the identical rule is used.
//
// Readings of the spec:
//  * station-no-dock / station-dock-isolated are errors for depots and stations used by a flow, warnings otherwise.
//  * flow-unreachable: no route from any dock of `from` to any dock of `to` (free choice at the start, like a
//    vehicle leaving a depot). flow-no-return: the destination can be reached but no arrival there leaves a way
//    back to a dock of `from` (with a graph: judged on the cheapest route, as the simulation would drive it).
//  * one-way-dead-end: a road cell that can be entered but has no exit at all (a two-way dead end is fine:
//    vehicles reverse there).
//  * batch-exceeds-capacity is a warning, never an error: the simulation limits a minimum batch to what the vehicles,
//    the buffers and the maximum batch allow (js/sim/logistics/dispatcher.js), so the flow still runs, only with
//    smaller batches than the planner asked for.
//  * process-no-outflow is only an info (finished goods may leave the plant at the machine).
//  * Extra code: warmup-exceeds-duration (warning).
//  * The layout must have the usual shape (grid, arrays, roads); it does not have to be normalized: broken references
//    (flow endpoints, fleet.home …) are reported rather than assumed away, and missing names, station parameters or
//    settings are tolerated (a nameless item is called by its id).

import { STATION_TYPES } from './defaults.js';
import { docksOf, flowsFrom, flowsTo, hasLink } from './layout.js';
import { DX, DY, DIR_BIT, opposite, cellKey, parseKey, inBounds } from '../util/grid.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const FLOW_FROM_TYPES = ['source', 'process', 'storage'];
const FLOW_TO_TYPES = ['process', 'storage', 'sink'];
const MAX_CELLS_PER_ISSUE = 100;

/** Name to show for a station or fleet: its own, else its id. */
const nameOf = (item) => (typeof item.name === 'string' && item.name.trim() ? item.name : String(item.id ?? 'unnamed'));
const q = (item) => `“${nameOf(item)}”`;
/** The station's parameters; {} for a station without any (not normalized), so comparisons simply find nothing wrong. */
const paramsOf = (station) => station.params ?? {};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const typeName = (station) => (STATION_TYPES[station.type] ? STATION_TYPES[station.type].short.toLowerCase() : 'station');
const flowText = (a, b) => `${q(a)} → ${q(b)}`;

// ---------------------------------------------------------------------------------------------------------
// Routing (same rule as the simulation: no U-turn unless the cell offers no other exit)
// ---------------------------------------------------------------------------------------------------------

/**
 * Directed-edge reachability over layout.roads. Edge id = cellIndex * 4 + direction.
 * @returns {{ check: (from: object, to: object) => 'ok'|'unreachable'|'no-return' }}
 */
function createRouter(layout) {
  const { cols, rows } = layout.grid;
  const size = cols * rows;
  const idx = (cx, cy) => cy * cols + cx;
  const road = new Uint8Array(size);
  const exits = new Uint8Array(size); // exit bits that lead into another road cell
  const cells = Object.entries(layout.roads).map(([key, cell]) => [...parseKey(key), (cell && cell.out) | 0]).filter(([cx, cy]) => inBounds(cx, cy, cols, rows));
  for (const [cx, cy] of cells) road[idx(cx, cy)] = 1;
  for (const [cx, cy, out] of cells) {
    for (let d = 0; d < 4; d++) {
      if (out & DIR_BIT[d] && inBounds(cx + DX[d], cy + DY[d], cols, rows) && road[idx(cx + DX[d], cy + DY[d])]) exits[idx(cx, cy)] |= DIR_BIT[d];
    }
  }

  const head = (e) => (e >> 2) + DX[e & 3] + DY[e & 3] * cols;
  const bits = (mask, cell) => [0, 1, 2, 3].filter((d) => mask & DIR_BIT[d]).map((d) => cell * 4 + d);

  /** Edges a vehicle may take after driving edge `e`: anything but the way back, unless that is the only exit. */
  const successors = (e) => {
    const v = head(e);
    const forward = exits[v] & ~DIR_BIT[opposite(e & 3)];
    return bits(forward || exits[v], v);
  };

  /** Edges after which `e2` may be taken (inverse of `successors`). */
  const predecessors = (e2) => {
    const v = e2 >> 2;
    const cx = v % cols;
    const cy = (v - cx) / cols;
    const result = [];
    for (let d = 0; d < 4; d++) {
      const ux = cx - DX[d];
      const uy = cy - DY[d];
      if (!inBounds(ux, uy, cols, rows) || !(exits[idx(ux, uy)] & DIR_BIT[d])) continue;
      if ((e2 & 3) !== opposite(d) || exits[v] === DIR_BIT[e2 & 3]) result.push(idx(ux, uy) * 4 + d);
    }
    return result;
  };

  const flood = (seeds, next) => {
    const seen = new Uint8Array(size * 4);
    const queue = [];
    for (const e of seeds) if (!seen[e]) { seen[e] = 1; queue.push(e); }
    for (let i = 0; i < queue.length; i++) {
      for (const n of next(queue[i])) if (!seen[n]) { seen[n] = 1; queue.push(n); }
    }
    return seen;
  };

  /** Edges that arrive at one of the dock cells. */
  const arrivals = (docks) => docks.flatMap((cell) => {
    const cx = cell % cols;
    const cy = (cell - cx) / cols;
    return [0, 1, 2, 3].filter((d) => inBounds(cx - DX[d], cy - DY[d], cols, rows) && exits[idx(cx - DX[d], cy - DY[d])] & DIR_BIT[d])
      .map((d) => idx(cx - DX[d], cy - DY[d]) * 4 + d);
  });

  const cache = new Map();
  const memo = (key, make) => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key);
  };
  const cellsOf = (station) => station.docks.map(([cx, cy]) => idx(cx, cy));

  /** Everything reachable when leaving the station's docks with free choice of direction. */
  const reachFrom = (station) => memo(`from:${station.id}`, () => {
    const docks = cellsOf(station);
    const seen = flood(docks.flatMap((cell) => bits(exits[cell], cell)), successors);
    const nodes = new Uint8Array(size);
    for (const cell of docks) nodes[cell] = 1;
    for (let e = 0; e < seen.length; e++) if (seen[e]) nodes[head(e)] = 1;
    return { seen, nodes };
  });

  /** Edges from which a dock of the station can still be reached. */
  const canReach = (station) => memo(`to:${station.id}`, () => flood(arrivals(cellsOf(station)), predecessors));

  return {
    check(from, to) {
      const fromDocks = cellsOf(from);
      const toDocks = cellsOf(to);
      const out = reachFrom(from);
      if (!toDocks.some((cell) => out.nodes[cell])) return 'unreachable';
      if (toDocks.some((cell) => fromDocks.includes(cell))) return 'ok';
      const back = canReach(from);
      return arrivals(toDocks).some((e) => out.seen[e] && back[e]) ? 'ok' : 'no-return';
    },
  };
}

/** Same answers, but asked of a sim graph (`graph.search(from, { arrivalEdge }).dist(to)`). */
function createGraphRouter(layout, graph) {
  const cols = graph.cols ?? layout.grid.cols;
  const node = ([cx, cy]) => cy * cols + cx;
  const searches = new Map();
  const search = (from, arrivalEdge) => {
    const key = `${from}:${arrivalEdge}`;
    if (!searches.has(key)) searches.set(key, graph.search(from, { arrivalEdge }));
    return searches.get(key);
  };
  const reaches = (s, to) => Number.isFinite(s.dist(to));
  return {
    check(from, to) {
      let reached = false;
      for (const a of from.docks.map(node)) {
        const out = search(a, -1);
        for (const b of to.docks.map(node)) {
          if (!reaches(out, b)) continue;
          reached = true;
          const route = typeof out.routeTo === 'function' ? out.routeTo(b) : null;
          const back = search(b, route && route.edges.length ? route.edges[route.edges.length - 1] : -1);
          if (from.docks.map(node).some((target) => reaches(back, target))) return 'ok';
        }
      }
      return reached ? 'no-return' : 'unreachable';
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------------------

function buildContext(layout, graph) {
  return {
    layout,
    graph,
    roadCount: Object.keys(layout.roads).length,
    stations: new Map(layout.stations.map((s) => [s.id, s])),
    fleets: new Map(layout.fleets.map((f) => [f.id, f])),
    docks: new Map(layout.stations.map((s) => [s.id, docksOf(layout, s.id)])),
    inFlow: new Set(layout.flows.flatMap((f) => [f.from, f.to])),
    vehicles: layout.fleets.reduce((sum, f) => sum + (f.count > 0 ? f.count : 0), 0),
  };
}

/** Largest vehicle capacity among the fleets allowed to serve the flow (null: none with vehicles). */
function vehicleCapacity(ctx, flow) {
  const pool = flow.fleetId ? [ctx.fleets.get(flow.fleetId)] : [...ctx.fleets.values()];
  const caps = pool.filter((f) => f && f.count > 0).map((f) => f.capacity);
  return caps.length ? Math.max(...caps) : null;
}

const cellDegree = (layout, cx, cy) => {
  let degree = 0;
  for (let d = 0; d < 4; d++) {
    if (hasLink(layout, cx, cy, d)) degree++;
    if (hasLink(layout, cx + DX[d], cy + DY[d], opposite(d))) degree++;
  }
  return degree;
};

// ---------------------------------------------------------------------------------------------------------
// Individual checks. Each receives the context and `add(severity, code, ref, message, hint, refs)`.
// ---------------------------------------------------------------------------------------------------------

function checkPlant(ctx, add) {
  const { layout } = ctx;
  if (!ctx.roadCount) {
    add('error', 'no-roads', 'layout', 'There are no roads, so vehicles have nowhere to drive.',
      'Pick the Road tool and drag from one station to the next; a road cell touching a station is its loading dock.');
  }
  if (!layout.flows.length) {
    add('error', 'no-flows', 'layout', 'No material flows are defined, so nothing will be transported.',
      'Open the Flows tab (or use the Flow tool) and connect a goods-in station to a workstation or goods-out station.');
  } else if (ctx.vehicles === 0) {
    add('error', 'no-fleets', 'layout', layout.fleets.length
      ? 'Every vehicle fleet has a count of zero, so nothing can move the loads.'
      : 'Material flows exist but there are no vehicles to move the loads.',
    layout.fleets.length ? 'Raise the vehicle count of a fleet in the Fleet tab.' : 'Add a fleet (AGV, forklift or tugger train) in the Fleet tab.');
  }
  const { warmup, duration } = layout.settings ?? {};
  if (warmup >= duration) {
    add('warning', 'warmup-exceeds-duration', 'layout', 'The warm-up period is as long as the whole run, so no results would be measured.',
      'Shorten the warm-up or lengthen the run duration in the Simulate tab.');
  }
}

function checkDocks(ctx, add) {
  for (const s of ctx.layout.stations) {
    const docks = ctx.docks.get(s.id);
    const severity = s.type === 'depot' || ctx.inFlow.has(s.id) ? 'error' : 'warning';
    if (!docks.length) {
      add(severity, 'station-no-dock', s.id, `${q(s)} is not next to any road, so vehicles cannot load or unload there.`,
        'Move the station next to a road or draw a road touching it.', { stationId: s.id });
    } else if (docks.every(([cx, cy]) => cellDegree(ctx.layout, cx, cy) === 0)) {
      add(severity, 'station-dock-isolated', s.id, `The road next to ${q(s)} is a single plate that is not connected to any other road.`,
        'Draw the road on from that plate so it joins the rest of the network.', { stationId: s.id, cells: docks });
    }
  }
}

/** The reason a flow's endpoints are not allowed (null if fine). */
function endpointProblem(a, b) {
  if (!a || !b) return 'This flow starts or ends at a station that no longer exists.';
  if (a === b) return `A flow cannot start and end at the same station (${q(a)}).`;
  if (!FLOW_FROM_TYPES.includes(a.type)) return `${q(a)} is a ${typeName(a)}, so loads cannot start their journey there.`;
  if (!FLOW_TO_TYPES.includes(b.type)) return `${q(b)} is a ${typeName(b)}, so it cannot receive loads.`;
  return null;
}

/** Biggest batch that can ever be ready for this flow, and what limits it. */
function batchLimit(ctx, flow, a, b) {
  const limits = [];
  const vehicle = vehicleCapacity(ctx, flow);
  if (vehicle !== null) limits.push([vehicle, `the vehicles carry at most ${vehicle}`]);
  const buffer = a.type === 'storage' ? paramsOf(a).capacity : paramsOf(a).outCap;
  limits.push([buffer, `${q(a)} holds at most ${buffer} loads for this flow`]);
  if (b.type === 'process') limits.push([paramsOf(b).inCap, `${q(b)} accepts at most ${paramsOf(b).inCap} loads of this flow`]);
  if (b.type === 'storage') limits.push([paramsOf(b).capacity, `${q(b)} holds at most ${paramsOf(b).capacity} loads`]);
  if (flow.batchMax > 0) limits.push([flow.batchMax, `the maximum batch is ${flow.batchMax}`]);
  return limits.filter(([n]) => Number.isFinite(n)).sort((x, y) => x[0] - y[0])[0] || null;
}

function checkFlowParameters(ctx, flow, a, b, add) {
  const label = flowText(a, b);
  if (b.type === 'process' && flow.perCycle > paramsOf(b).inCap) {
    add('error', 'perCycle-exceeds-inCap', flow.id,
      `${q(b)} needs ${flow.perCycle} loads from ${q(a)} per cycle, but its input slot for this flow holds only ${paramsOf(b).inCap}, so it can never start.`,
      `Raise the input capacity of ${q(b)} to at least ${flow.perCycle}, or lower the per-cycle quantity of this flow.`,
      { stationId: b.id, flowId: flow.id });
  }
  const limit = batchLimit(ctx, flow, a, b);
  if (limit && flow.batchMin > limit[0]) {
    add('warning', 'batch-exceeds-capacity', flow.id,
      `Flow ${label} is set to wait for ${flow.batchMin} loads per trip, but at most ${limit[0]} can ever be ready (${limit[1]}), so trips will leave with ${limit[0]} or fewer.`,
      `Lower the minimum batch to ${limit[0]} or less to match, or raise the limit.`, { flowId: flow.id });
  }
}

function checkFlowRouting(ctx, flow, a, b, router, add) {
  const label = flowText(a, b);
  const from = { id: a.id, docks: ctx.docks.get(a.id) };
  const to = { id: b.id, docks: ctx.docks.get(b.id) };
  const result = router.check(from, to);
  if (result === 'unreachable') {
    add('error', 'flow-unreachable', flow.id, `Vehicles cannot drive from ${q(a)} to ${q(b)}.`,
      'Look for a gap in the road, a one-way segment pointing the wrong way, or parallel roads that are not joined.',
      { flowId: flow.id, stationId: a.id });
  } else if (result === 'no-return') {
    add('error', 'flow-no-return', flow.id, `Vehicles can reach ${q(b)} from ${q(a)} but cannot get back (flow ${label}).`,
      'A one-way road or dead end traps them. Make the road two-way or add a return road so the route forms a loop.',
      { flowId: flow.id, stationId: b.id });
  }
}

function checkFlows(ctx, add) {
  const { layout } = ctx;
  const pairs = new Set();
  let router = null;
  for (const flow of layout.flows) {
    const a = ctx.stations.get(flow.from);
    const b = ctx.stations.get(flow.to);
    const duplicate = pairs.has(`${flow.from}>${flow.to}`);
    pairs.add(`${flow.from}>${flow.to}`);
    const problem = duplicate && a && b ? `There is more than one flow from ${q(a)} to ${q(b)}.` : endpointProblem(a, b);
    if (problem) {
      add('error', 'flow-bad-endpoints', flow.id, problem, 'Delete the flow or reconnect it between a goods-in/workstation/storage and a workstation/storage/goods-out station.', { flowId: flow.id });
      continue;
    }
    if (flow.fleetId) {
      const fleet = ctx.fleets.get(flow.fleetId);
      if (!fleet || fleet.count <= 0) {
        add('error', 'flow-fleet-missing', flow.id, fleet
          ? `Flow ${flowText(a, b)} is restricted to ${q(fleet)}, which has no vehicles.`
          : `Flow ${flowText(a, b)} is restricted to a fleet that no longer exists.`,
        'Choose another fleet for this flow, set it to "any fleet", or raise the vehicle count.', { flowId: flow.id, fleetId: flow.fleetId });
      }
    }
    checkFlowParameters(ctx, flow, a, b, add);
    if (!ctx.roadCount || !ctx.docks.get(a.id).length || !ctx.docks.get(b.id).length) continue; // reported as no-roads / station-no-dock
    router = router || (ctx.graph ? createGraphRouter(layout, ctx.graph) : createRouter(layout));
    checkFlowRouting(ctx, flow, a, b, router, add);
  }
}

function checkStationRoles(ctx, add) {
  const { layout } = ctx;
  for (const s of layout.stations) {
    const out = flowsFrom(layout, s.id);
    const into = flowsTo(layout, s.id);
    if (s.type === 'source' && !out.length) {
      add('warning', 'source-no-outflow', s.id, `${q(s)} creates loads but no flow takes them away, so they pile up at the gate.`,
        'Add a flow from this station to a workstation or storage.', { stationId: s.id });
    } else if (s.type === 'process') {
      if (!into.length) {
        add('warning', 'process-no-inflow', s.id, `${q(s)} has no incoming flow, so it will run without any input material.`,
          'Add a flow into this station from a goods-in, storage or upstream workstation.', { stationId: s.id });
      }
      if (!out.length) {
        add('info', 'process-no-outflow', s.id, `${q(s)} has no outgoing flow: its finished loads leave the plant right at the machine.`,
          'That is fine for the last step. Otherwise add a flow to the next station.', { stationId: s.id });
      }
    } else if (s.type === 'sink' && !into.length) {
      add('warning', 'sink-no-inflow', s.id, `Nothing is sent to ${q(s)}.`,
        'Add a flow into this goods-out station from the last workstation or storage.', { stationId: s.id });
    } else if (s.type === 'storage') checkStorage(ctx, s, into, add);
  }
}

function checkStorage(ctx, s, into, add) {
  const deliveries = into.map((f) => {
    const vehicle = vehicleCapacity(ctx, f);
    return vehicle === null ? 0 : Math.min(vehicle, f.batchMax > 0 ? f.batchMax : Infinity);
  });
  const biggest = Math.max(0, ...deliveries);
  if (paramsOf(s).capacity < biggest) {
    add('warning', 'storage-small', s.id, `${q(s)} holds only ${paramsOf(s).capacity} loads, fewer than a single delivery of ${biggest}.`,
      `Raise the capacity to at least ${biggest}, or let vehicles carry smaller batches.`, { stationId: s.id });
  }
}

function checkFleets(ctx, add) {
  const { layout } = ctx;
  const chargers = layout.stations.some((s) => s.type === 'depot' && paramsOf(s).chargers > 0);
  const cell = layout.grid.cellSize;
  for (const f of layout.fleets) {
    const refs = { fleetId: f.id };
    const home = f.home ? ctx.stations.get(f.home) : null;
    if (f.home && (!home || home.type !== 'depot')) {
      add('error', 'home-depot-missing', f.id, `The home depot of ${q(f)} is missing: the station it points to is gone or is not a depot.`,
        'Pick another depot in the Fleet tab, or clear the home depot.', refs);
    }
    if (f.count <= 0) {
      add('warning', 'fleet-count-zero', f.id, `${q(f)} has no vehicles.`, 'Raise its count in the Fleet tab, or delete the fleet.', refs);
      continue;
    }
    if (f.length > cell) {
      add('warning', 'vehicle-longer-than-cell', f.id,
        `${q(f)} vehicles are ${f.length} m long but a road cell is only ${cell} m, so they overhang neighbouring cells in corners and at docks.`,
        'Use a larger cell size for the plant, or choose a shorter vehicle.', refs);
    }
    if (f.battery && f.battery.enabled && !chargers) {
      add('error', 'depot-missing', f.id, `${q(f)} runs on batteries but the plant has no parking & charging station with chargers, so the vehicles will run flat.`,
        'Add a Depot station next to a road and give it at least one charger.', refs);
    }
  }
}

function checkNames(ctx, add) {
  const groups = (items, kind) => {
    const byName = new Map();
    for (const item of items) {
      const key = nameOf(item).trim().toLowerCase();
      byName.set(key, [...(byName.get(key) || []), item]);
    }
    for (const [key, list] of byName) {
      if (list.length < 2) continue;
      add('info', 'duplicate-names', `${kind}:${key}`, `${list.length} ${kind === 'station' ? 'stations are' : 'fleets are'} all called ${q(list[0])}.`,
        'Give them different names so charts and reports stay readable.', kind === 'station' ? { stationId: list[0].id } : { fleetId: list[0].id });
    }
  };
  groups(ctx.layout.stations, 'station');
  groups(ctx.layout.fleets, 'fleet');
}

/** Road pieces without a dock, and cells vehicles can enter but never leave. */
function checkRoadNetwork(ctx, add) {
  const { layout } = ctx;
  const cells = Object.keys(layout.roads).map(parseKey).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const docks = new Set([...ctx.docks.values()].flat().map(([cx, cy]) => cellKey(cx, cy)));
  const seen = new Set();
  for (const start of cells) {
    if (seen.has(cellKey(...start))) continue;
    const piece = [start];
    seen.add(cellKey(...start));
    for (let i = 0; i < piece.length; i++) {
      const [cx, cy] = piece[i];
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (seen.has(cellKey(nx, ny)) || !(hasLink(layout, cx, cy, d) || hasLink(layout, nx, ny, opposite(d)))) continue;
        seen.add(cellKey(nx, ny));
        piece.push([nx, ny]);
      }
    }
    if (!piece.some(([cx, cy]) => docks.has(cellKey(cx, cy)))) {
      add('info', 'road-fragment', cellKey(...start), `A piece of road with ${plural(piece.length, 'cell', 'cells')} near (${start[0]}, ${start[1]}) is not connected to any station.`,
        'Delete it, or connect it to the road network and a station.', { cells: piece.slice(0, MAX_CELLS_PER_ISSUE) });
    }
  }
  for (const [cx, cy] of cells) {
    let enters = false;
    let leaves = false;
    for (let d = 0; d < 4; d++) {
      leaves = leaves || hasLink(layout, cx, cy, d);
      enters = enters || hasLink(layout, cx + DX[d], cy + DY[d], opposite(d));
    }
    if (enters && !leaves) {
      add('warning', 'one-way-dead-end', cellKey(cx, cy), `Vehicles that drive onto the road at (${cx}, ${cy}) can never leave again.`,
        'Add an exit, or make the last cells two-way so vehicles can turn around at the end.', { cells: [[cx, cy]] });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------

/**
 * Check a layout for problems a factory planner can act on.
 * @param {object} layout
 * @param {{graph?: object}} [opts] a sim graph (js/sim/graph.js) to use for reachability instead of the internal search
 * @returns {Array<{id: string, severity: string, code: string, message: string, hint: string, refs: object}>}
 */
export function validateLayout(layout, opts) {
  const graph = (opts ?? {}).graph ?? null;
  const issues = [];
  const add = (severity, code, ref, message, hint, refs = {}) => {
    issues.push({ id: `${code}:${ref}`, severity, code, message, hint, refs });
  };
  if (!layout.stations.length) {
    add('error', 'no-stations', 'layout', 'The plant has no stations yet.',
      'Pick a station from the toolbar (goods in, workstation, storage, goods out) and click on the baseplate, or open an example.');
    return issues;
  }
  const ctx = buildContext(layout, graph);
  checkPlant(ctx, add);
  checkDocks(ctx, add);
  checkFlows(ctx, add);
  checkStationRoles(ctx, add);
  checkFleets(ctx, add);
  checkNames(ctx, add);
  checkRoadNetwork(ctx, add);
  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]); // Array#sort is stable
}
