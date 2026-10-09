// Test helper for the adversarial review of the dock book (tests/sim.docks.review.test.js). Independent of the builder's own helpers and of
// js/sim/logistics/docks.js's checkDockInvariants: everything here is written from the contract, not from the implementation.
//
//   dockPlant(seed, opts)            a random plant built around stations with SEVERAL docks: stations on a comb of spurs, on one through lane
//                                    (lined-up docks), on a one-way ring, with trap spurs (one-way dead ends), shared dock cells (a road between
//                                    two stations), depots with several docks, breakdowns, batteries, demand spikes
//   combPlant({ spurs, ... })        the report's plant, parametrised (spur count, vehicles, speeds, load times)
//   DockWatch                        a per-tick referee that owns its own bookkeeping (reservations, queue membership, occupancy, arrival at the
//                                    reserved dock, flapping, visit ledger) and never calls docks.js helpers
//   oldRule(lg, entry, stationId, toId)   the dock choice BEFORE the dock book (cheapest returnable dock; a pickup dock must lead on to the drop)
//   legacy(sim)                      switch the dock book to the old ranking
//   hostileDocks(seed)               dock-dense plant with hostile numbers (zero load times, huge fleets, tiny buffers)

import { createRng } from '../../js/util/rng.js';
import { DIR_BIT, DX, DY, cellKey } from '../../js/util/grid.js';
import { dist } from '../../js/model/defaults.js';
import { layoutFromAscii } from './ascii.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const pickOf = (rng, list) => list[rng.int(list.length)];

// ---------------------------------------------------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A comb: two stations (source A, sink B) with `spurs` docking spurs each off one two-way main road - the plant of the report.
 * @param {{ spurs?: number, vehicles?: number, interArrival?: number, loadTime?: number, unloadTime?: number, idle?: string, speed?: number,
 *   spurLength?: number, spacing?: number, seed?: number, fleet?: object, settings?: object, cellSize?: number }} [o]
 */
export function combPlant({
  spurs = 3, vehicles = 6, interArrival = 20, loadTime = 12, unloadTime = 12, idle = 'stay', speed = 1.5, spurLength = 1, spacing = 3,
  seed = 3, fleet = {}, settings = {}, sourceCap = 40, cellSize = 2,
} = {}) {
  const width = 2 + spurs * spacing + 2 + 2 + spurs * spacing + 2;
  const stationW = (spurs - 1) * spacing + 1;
  const aX = 1;
  const bX = 3 + spurs * spacing + 2;
  const rows = [];
  const blank = () => Array.from({ length: width }, () => '.');
  for (let r = 0; r < 2; r++) {
    const line = blank();
    for (let x = aX; x < aX + stationW; x++) line[x] = 'A';
    for (let x = bX; x < bX + stationW; x++) line[x] = 'B';
    rows.push(line);
  }
  for (let s = 0; s < spurLength; s++) {
    const line = blank();
    for (let k = 0; k < spurs; k++) { line[aX + k * spacing] = '+'; line[bX + k * spacing] = '+'; }
    rows.push(line);
  }
  rows.push(Array.from({ length: width }, (_, x) => (x >= 1 && x < width - 1 ? '+' : '.')));
  return layoutFromAscii(rows.map((r) => r.join('')), {
    stations: { A: { type: 'source', params: { interArrival: dist('const', interArrival, 0), outCap: sourceCap } }, B: 'sink' },
    flows: [['A', 'B']],
    fleets: [{ count: vehicles, preset: 'agv', loadTime, unloadTime, idle, speed, ...fleet }],
    settings: { warmup: 0, seed, ...settings },
    cellSize,
  });
}

/** Cells (x, y) -> the cell record of a layout, or undefined. */
const road = (layout, x, y) => layout.roads[cellKey(x, y)];

/** Remove the exit towards direction `d` from the road cell (x, y): a one-way link. */
function cut(layout, x, y, d) {
  const cell = road(layout, x, y);
  if (cell) cell.out &= ~DIR_BIT[d];
}

/**
 * A random plant around stations with several docks.
 * @param {number} seed
 * @param {{ vehicles?: number, ring?: boolean|null, traps?: boolean|null, depot?: boolean|null, breakdowns?: boolean|null, dt?: number|null,
 *   topSpur?: number, botSpur?: number, stationsPerBand?: number, spacing?: number }} [o] null / omitted = chosen from the seed
 * @returns {object} a layout
 */
export function dockPlant(seed, o = {}) {
  const rng = createRng(seed * 7727 + 31);
  const opt = (key, f) => (o[key] === undefined || o[key] === null ? f() : o[key]);
  const topSpur = opt('topSpur', () => pickOf(rng, [0, 1, 1, 2, 3]));
  const botSpur = opt('botSpur', () => pickOf(rng, [0, 1, 1, 2, 3]));
  const perBand = opt('stationsPerBand', () => 1 + rng.int(4));
  const ring = opt('ring', () => rng.next() < 0.25) && topSpur + botSpur > 0;
  const traps = opt('traps', () => rng.next() < 0.25);
  const wantDepot = opt('depot', () => rng.next() < 0.45);
  const breakdowns = opt('breakdowns', () => rng.next() < 0.3);
  const dt = opt('dt', () => pickOf(rng, [0.1, 0.1, 0.25, 0.05]));

  // --- bands of stations ---------------------------------------------------------------------------------------------
  const M = 2 + topSpur; // main road row
  const bands = [[], []];
  const gapCols = [];
  let x = ring ? 3 : 1;
  const stations = [];
  for (let band = 0; band < 2; band++) {
    let cx = ring ? 3 : 1;
    const n = band === 0 ? perBand : Math.max(1, perBand - rng.int(2));
    for (let i = 0; i < n; i++) {
      const w = 3 + rng.int(6);
      const st = { band, x: cx, w, letter: LETTERS[stations.length], docksSpacing: opt('spacing', () => pickOf(rng, [1, 2, 2, 3, 3])), off: rng.int(2) };
      stations.push(st);
      bands[band].push(st);
      const shared = rng.next() < 0.2 && i + 1 < n && band === 0;
      cx += w + (shared ? 1 : 2 + rng.int(3));
      if (shared) gapCols.push(cx - 1);
    }
    x = Math.max(x, cx);
  }
  const wantDepotSlot = wantDepot && stations.length < 25;
  let depotStation = null;
  if (wantDepotSlot) {
    depotStation = { band: rng.int(2), x, w: 4, letter: LETTERS[stations.length], depot: true, docksSpacing: pickOf(rng, [1, 2, 3]), off: 0 };
    bands[depotStation.band].push(depotStation);
    stations.push(depotStation);
    x += 4 + 2;
  }
  const width = x + (ring ? 3 : 1);
  const botTop = M + botSpur + 1; // first row of the bottom stations
  const height = botTop + 2 + (ring ? 3 : 0);
  const R = botTop + 2 + 1; // return row of the ring
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => '.'));
  const put = (cx, cy, ch) => { if (cy >= 0 && cy < height && cx >= 0 && cx < width) grid[cy][cx] = ch; };
  for (let cx = ring ? 2 : 0; cx < width - (ring ? 2 : 0); cx++) put(cx, M, '+'); // main road
  const spurCells = [];
  for (const st of stations) {
    const top = st.band === 0;
    const y0 = top ? 0 : botTop;
    for (let dx = 0; dx < st.w; dx++) for (let dy = 0; dy < 2; dy++) put(st.x + dx, y0 + dy, st.letter);
    const spurLen = top ? topSpur : botSpur;
    if (spurLen === 0) continue; // the station touches the main road: its docks are the road cells along it
    for (let dx = st.off; dx < st.w; dx += st.docksSpacing) {
      for (let k = 0; k < spurLen; k++) put(st.x + dx, top ? 2 + k : M + 1 + k, '+');
      spurCells.push({ st, x: st.x + dx, y: top ? 1 + spurLen : M + 1 });
    }
  }
  for (const gx of gapCols) for (let cy = 0; cy < M; cy++) put(gx, cy, '+'); // a road between two stations: shared dock cells
  if (ring) {
    for (let cy = M; cy <= R; cy++) { put(2, cy, '+'); put(width - 3, cy, '+'); }
    for (let cx = 2; cx <= width - 3; cx++) put(cx, R, '+');
  }

  // --- types, flows, fleets ---------------------------------------------------------------------------------------------
  const real = stations.filter((s) => !s.depot);
  const types = real.map((_, i) => (i === 0 ? 'source' : i === 1 ? 'sink' : pickOf(rng, ['process', 'process', 'storage', 'source', 'sink'])));
  for (let i = types.length - 1; i > 0; i--) { const j = rng.int(i + 1); [types[i], types[j]] = [types[j], types[i]]; }
  if (!types.includes('source')) types[0] = 'source';
  if (!types.includes('sink')) types[types.length - 1] = 'sink';
  if (real.length === 1) types[0] = 'process';
  const spike = rng.next() < 0.2;
  const spec = {};
  real.forEach((st, i) => {
    const type = types[i];
    if (type === 'source') spec[st.letter] = { type, params: { interArrival: dist(pickOf(rng, ['const', 'exp', 'normal']), 8 + rng.int(60), 0.2), batch: spike ? 1 + rng.int(6) : pickOf(rng, [1, 1, 2]), outCap: 4 + rng.int(40) } };
    else if (type === 'process') spec[st.letter] = { type, params: { cycle: dist(pickOf(rng, ['const', 'exp', 'uniform']), 5 + rng.int(60), 0.3), machines: 1 + rng.int(3), inCap: 2 + rng.int(8), outCap: 2 + rng.int(8) } };
    else if (type === 'storage') spec[st.letter] = { type, params: { capacity: 4 + rng.int(40), dwell: pickOf(rng, [0, 0, 20]) } };
    else spec[st.letter] = 'sink';
  });
  const depotCount = 3 + rng.int(8);
  if (depotStation) spec[depotStation.letter] = { type: 'depot', params: { slots: depotCount + 4, chargers: pickOf(rng, [0, 1, 2]) } };
  const sources = real.filter((_, i) => types[i] === 'source');
  const sinks = real.filter((_, i) => types[i] === 'sink');
  const mids = real.filter((_, i) => types[i] === 'process' || types[i] === 'storage');
  const flows = [];
  const seen = new Set();
  const flow = (a, b, extra = {}) => {
    const key = `${a.letter}>${b.letter}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    flows.push([a.letter, b.letter, { weight: 1 + rng.int(3), priority: 1 + rng.int(3), ...extra }]);
  };
  for (const s of sources) {
    const targets = mids.length > 0 ? mids : sinks;
    flow(s, pickOf(rng, targets));
    if (rng.next() < 0.4) flow(s, pickOf(rng, mids.concat(sinks)));
  }
  for (const m of mids) flow(m, pickOf(rng, sinks.concat(mids.filter((q) => q !== m))), { perCycle: 1 + rng.int(2) });
  if (flows.length === 0 && sources.length > 0 && sinks.length > 0) flow(sources[0], sinks[0]);

  const fleetCount = 1 + rng.int(2);
  const total = opt('vehicles', () => pickOf(rng, [1, 2, 3, 4, 5, 6, 8, 10, 14]));
  const fleets = [];
  for (let f = 0; f < fleetCount; f++) {
    const preset = pickOf(rng, ['agv', 'agv', 'forklift', 'tugger', 'custom']);
    const base = { agv: [1.5, 12], forklift: [3, 20], tugger: [2, 45], custom: [2, 15] }[preset];
    fleets.push({
      preset, count: Math.max(1, Math.round(total / fleetCount)), idle: pickOf(rng, ['stay', 'stay', 'park']),
      loadTime: pickOf(rng, [0, 4, base[1], base[1], 30]), unloadTime: pickOf(rng, [0, 4, base[1], 30]),
      speed: base[0] * pickOf(rng, [0.5, 1, 1, 1.5]), capacity: pickOf(rng, [1, 1, 2]),
      mtbf: breakdowns ? pickOf(rng, [200, 600]) : 0, mttr: breakdowns ? pickOf(rng, [20, 90]) : 0,
      battery: rng.next() < 0.25 ? { enabled: true, runtimeMin: 6 + rng.int(40), chargeTimeMin: 2 + rng.int(8), lowPct: 30, resumePct: 80 } : {},
      home: depotStation ? depotStation.letter : null,
    });
  }
  const layout = layoutFromAscii(grid.map((r) => r.join('')), {
    stations: spec, flows, fleets,
    settings: { warmup: 0, seed: 1 + rng.int(99999), dt, dispatch: pickOf(rng, ['nearest', 'nearest', 'oldest', 'balanced']), routing: pickOf(rng, ['shortest', 'shortest', 'congestion']), handedness: pickOf(rng, ['right', 'left']), deadlock: 'resolve' },
  });

  // --- one-way parts ----------------------------------------------------------------------------------------------------
  if (ring) {
    for (let cx = 2; cx <= width - 3; cx++) { cut(layout, cx, M, 3); cut(layout, cx, R, 1); } // main road eastbound, return road westbound
  }
  if (traps) {
    const pool = spurCells.filter((c) => c.st.band === 0 ? topSpur >= 1 : botSpur >= 1);
    for (const c of pool) {
      if (rng.next() < 0.25) cut(layout, c.x, c.st.band === 0 ? 1 + topSpur : M + 1, c.st.band === 0 ? 2 : 0); // vehicles can enter the spur but not leave it
    }
  }
  return layout;
}

/** Hostile numbers on a dock-dense plant: zero load times, tiny buffers, a large fleet. */
export function hostileDocks(seed) {
  const rng = createRng(seed * 31 + 5);
  const layout = dockPlant(seed, { vehicles: pickOf(rng, [20, 35, 50]), stationsPerBand: 3, topSpur: 1, botSpur: 1 });
  for (const f of layout.fleets) {
    f.loadTime = pickOf(rng, [0, 0, 1, 25]);
    f.unloadTime = pickOf(rng, [0, 1, 25]);
  }
  for (const s of layout.stations) if (s.type === 'source') s.params.interArrival = dist('const', pickOf(rng, [0.5, 2, 5, 20]), 0);
  return layout;
}

// ---------------------------------------------------------------------------------------------------------------------
// The old rule and the switch
// ---------------------------------------------------------------------------------------------------------------------

/** Switch a Simulation (or a Logistics) to the dock choice of the code before the dock book. */
export function legacy(simOrLg) {
  const lg = simOrLg.logistics || simOrLg;
  lg.docks.enabled = false;
  lg.docks.rebinding = false;
  return simOrLg;
}

/**
 * The dock choice BEFORE the dock book, written down independently of routing.js: among the docks of the station that the search reaches,
 * the ones from which the vehicle can get back (same strongly connected part as where it started) first, then the cheapest, then the lowest
 * node id; for a pickup (toId given) the first of them from which a dock of the drop station can still be reached.
 * @returns {number} the dock node, or -1
 */
export function oldRule(lg, entry, stationId, toId = null) {
  const { graph, routes } = lg;
  const list = [];
  for (const node of graph.docks.get(stationId) || []) {
    const d = entry.search.dist(node);
    if (d < Infinity) list.push({ node, d, back: graph.sameScc(node, entry.node) });
  }
  list.sort((a, b) => (b.back - a.back) || (a.d - b.d) || (a.node - b.node));
  for (const dock of list) {
    if (toId === null) return dock.node;
    const route = entry.search.routeTo(dock.node);
    const arrival = route && route.edges.length > 0 ? route.edges[route.edges.length - 1] : entry.arrivalEdge;
    if (routes.canReach(dock.node, arrival, toId)) return dock.node;
  }
  return -1;
}

/**
 * Wrap `lg.docks.choose` with an independent check against the old rule. Legacy mode must return exactly the old dock; the dock book
 * must find a dock exactly when the old rule does, stay in the old rule's returnable class, and (for a pickup) pick a dock the drop can
 * still be reached from. Returns the counters; mismatches are listed in `.mismatches`.
 */
export function shadowChoose(sim) {
  const lg = sim.logistics;
  const { graph, routes } = lg;
  const book = lg.docks;
  const orig = book.choose.bind(book);
  const stats = { calls: 0, diverted: 0, several: 0, mismatches: [] };
  book.choose = (vr, entry, stationId, toId, t) => {
    const got = orig(vr, entry, stationId, toId, t);
    const old = oldRule(lg, entry, stationId, toId);
    stats.calls++;
    const bad = (why) => { if (stats.mismatches.length < 20) stats.mismatches.push(`t=${t.toFixed(1)} ${vr.id} -> ${stationId}: ${why}`); };
    if ((got === null) !== (old === -1)) bad(`reachability: book ${got && got.node}, old rule ${old}`);
    else if (got !== null) {
      if ((graph.docks.get(stationId) || []).length > 1) stats.several++;
      if (got.node !== old) stats.diverted++;
      if (!book.enabled && got.node !== old) bad(`legacy mode picked ${got.node}, the old rule ${old}`);
      if (graph.sameScc(old, entry.node) && !graph.sameScc(got.node, entry.node)) bad(`${got.node} is a trap, the old rule found ${old}`);
      if (toId !== null) {
        const route = entry.search.routeTo(got.node);
        const arrival = route && route.edges.length > 0 ? route.edges[route.edges.length - 1] : entry.arrivalEdge;
        if (!routes.canReach(got.node, arrival, toId)) bad(`pickup dock ${got.node} cannot reach ${toId}`);
      }
    }
    return got;
  };
  return stats;
}

// ---------------------------------------------------------------------------------------------------------------------
// The referee
// ---------------------------------------------------------------------------------------------------------------------

const DRIVE_TO_STATION = new Set(['toPickup', 'toDrop', 'toPark', 'toCharger']);

/**
 * A per-tick referee for the dock book that keeps its OWN bookkeeping. Call `check()` after every step; `finish()` at the end. It records
 * problems (strings) in `problems`; `assertClean()` throws them. It reads the public fields of the Logistics (vehicles, docks.cells[*].queue,
 * vehicle.dock) but trusts none of docks.js's own consistency functions.
 *
 *  R1  a reservation belongs to a vehicle that is in lg.vehicles, is queued exactly once, at the cell it names, and that cell is a dock of the
 *      station the vehicle is going to (vr.targetId)
 *  R2  the vehicle is on its way (toPickup/toDrop/toPark/toCharger, or broken in one of them) and heads for a station, not a waiting cell
 *  R3  a vehicle that is DRIVING to a station (not disabled, not waiting for a retry) has a reservation
 *  R4  no vehicle that loads, unloads, charges, is parked, idle or dead holds a reservation (dead: ever)
 *  R5  total queue length == number of vehicles holding a reservation (nothing orphaned in a queue)
 *  O1  a loading/unloading vehicle stands on a dock of its station; two vehicles serving on one cell must be side by side (the two lanes of a
 *      two-way road), never on top of each other (counted in stats.sharedCells)
 *  A1  when a vehicle starts loading/unloading it stands on the node it had reserved (never a different dock than the plan), unless it was
 *      teleported meanwhile (deadlock relocation)
 *  R6  the dock a vehicle drives to is one it can get back from, whenever the station has such a dock (one-way traps stay a last resort)
 *  R7  the dock a pickup drives to leads on to the drop station
 *  F1  one reservation changes its dock at most REBIND_MAX_SWITCHES (1) times (stats.maxDocksPerLeg counts the docks a leg ever had, across replans)
 *  V1  per station: services started (dock visits, from the book's counters) == pickups + deliveries seen in events
 *  X1  after the vehicle's removal nothing of it is left in any queue
 */
export class DockWatch {
  constructor(sim, { maxSwitches = 1, quiet = false } = {}) {
    this.sim = sim;
    this.lg = sim.logistics;
    this.problems = [];
    this.maxSwitches = maxSwitches;
    this.ticks = 0;
    this.reserved = new Map(); // vehicle -> last reserved node (from the previous tick)
    this.nodesOf = new Map(); // reservation object -> nodes it has had
    this.state = new Map(); // vehicle -> state at the previous tick
    this.pickups = new Map();
    this.deliveries = new Map();
    this.stats = { reservations: 0, switches: 0, maxQueue: 0, arrivals: 0, sharedCells: 0, maxDocksPerLeg: 0, maxDocksPerCleanLeg: 0, kinds: {} };
    this.legs = new Map();
    this.teleports = new Map();
    this.moved = new Map();
    if (typeof sim.on === 'function') {
      sim.on('orderPickedUp', (e) => this.pickups.set(e.order.from, (this.pickups.get(e.order.from) || 0) + 1));
      sim.on('orderDelivered', (e) => this.deliveries.set(e.order.to, (this.deliveries.get(e.order.to) || 0) + 1));
    }
    this.quiet = quiet;
  }

  fail(message) {
    if (this.problems.length < 40) this.problems.push(`t=${this.sim.time.toFixed(2)}: ${message}`);
  }

  check() {
    const { lg } = this;
    const { graph } = lg;
    this.ticks++;
    const alive = new Set(lg.vehicles);
    const book = lg.docks;
    // queues
    const queued = new Map(); // vehicle -> [cells]
    let queueTotal = 0;
    for (const cell of book.cellList) {
      for (const res of cell.queue) {
        queueTotal++;
        const vr = res.vr;
        if (!alive.has(vr)) this.fail(`R1: ${vr.id} is queued at ${cell.node} but no longer exists`);
        const list = queued.get(vr) || [];
        list.push(cell.node);
        queued.set(vr, list);
        if (vr.dock !== res) this.fail(`R1: ${vr.id} is queued at ${cell.node} with a reservation that is not its own`);
        if (res.node !== cell.node) this.fail(`R1: ${vr.id} queued at ${cell.node} but its reservation names ${res.node}`);
        if (!(graph.docks.get(vr.targetId) || []).includes(cell.node)) this.fail(`R1: ${vr.id} (to ${vr.targetId}) is queued at ${cell.node}, which is no dock of it`);
        if (res.station !== vr.targetId) this.fail(`R1: ${vr.id}: reservation station ${res.station} != target ${vr.targetId}`);
      }
    }
    this.stats.maxQueue = Math.max(this.stats.maxQueue, queueTotal);
    let holders = 0;
    for (const vr of lg.vehicles) {
      const tv = vr.tv;
      const effective = vr.state === 'broken' ? vr.resumeState : vr.state;
      const list = queued.get(vr) || [];
      if (list.length > 1) this.fail(`R1: ${vr.id} is queued at ${list.length} docks (${list})`);
      if (vr.dock !== null) {
        holders++;
        if (list.length !== 1) this.fail(`R1: ${vr.id} holds a reservation but is queued ${list.length} times`);
        if (!DRIVE_TO_STATION.has(effective)) this.fail(`R2: ${vr.id} holds a reservation in state ${vr.state}/${vr.resumeState}`);
        if (vr.targetId === null || vr.spot >= 0) this.fail(`R2: ${vr.id} holds a reservation but heads for ${vr.targetId}/${vr.spot}`);
        if (!tv.onRoad) this.fail(`R2: ${vr.id} holds a reservation but is off the road`);
        const nodes = this.nodesOf.get(vr.dock) || [];
        if (nodes[nodes.length - 1] !== vr.dock.node) {
          nodes.push(vr.dock.node);
          this.nodesOf.set(vr.dock, nodes);
          if (nodes.length > 1) this.stats.switches++;
          else { this.stats.reservations++; this.stats.kinds[vr.dock.kind] = (this.stats.kinds[vr.dock.kind] || 0) + 1; }
          if (nodes.length - 1 > this.maxSwitches) this.fail(`F1: ${vr.id} changed its dock ${nodes.length - 1} times on one reservation (${nodes})`);
        }
        this.reserved.set(vr, vr.dock.node);
        this.checkChoice(vr);
      } else {
        if (vr.state === 'dead' || ['loading', 'unloading', 'charging', 'parked', 'idle'].includes(vr.state)) { /* R4 holds trivially: no reservation */ }
        if (tv.driving && vr.state !== 'broken' && DRIVE_TO_STATION.has(vr.state) && vr.spot < 0 && vr.targetId !== null && !tv.disabled) {
          this.fail(`R3: ${vr.id} drives to ${vr.targetId} (${vr.state}) without a reservation`);
        }
      }
      if (vr.dock !== null && ['loading', 'unloading', 'charging', 'parked', 'idle', 'dead'].includes(vr.state)) this.fail(`R4: ${vr.id} holds a reservation in state ${vr.state}`);
      // A1: arrival
      const before = this.state.get(vr);
      if (this.teleports.get(vr) !== tv.teleports) this.moved.set(vr, this.sim.time); // relocated by deadlock resolution (it replans on the next tick)
      this.teleports.set(vr, tv.teleports);
      const moved = this.moved.has(vr) && this.sim.time - this.moved.get(vr) < 1.5 + this.sim.dt;
      if ((vr.state === 'loading' || vr.state === 'unloading') && before !== vr.state) {
        this.stats.arrivals++;
        const planned = this.reserved.get(vr);
        if (!(graph.docks.get(vr.targetId) || []).includes(tv.node)) this.fail(`A1: ${vr.id} started ${vr.state} at node ${tv.node}, no dock of ${vr.targetId}`);
        else if (planned !== undefined && planned !== tv.node && vr.dock === null && !moved) this.fail(`A1: ${vr.id} started ${vr.state} at ${tv.node} but had reserved ${planned}`);
        this.reserved.delete(vr);
      }
      if (!DRIVE_TO_STATION.has(effective)) this.reserved.delete(vr);
      this.state.set(vr, vr.state);
    }
    if (holders !== queueTotal) this.fail(`R5: ${holders} vehicles hold a reservation but ${queueTotal} are queued`);
    // O1: no two vehicles serve on the same cell
    const serving = new Map();
    for (const vr of lg.vehicles) {
      if ((vr.state === 'loading' || vr.state === 'unloading') && vr.tv.onRoad) {
        if (vr.tv.node < 0) this.fail(`O1: ${vr.id} is ${vr.state} but not stopped on a cell`);
        const other = serving.get(vr.tv.node);
        if (other) {
          this.stats.sharedCells++;
          if (Math.hypot(other.tv.x - vr.tv.x, other.tv.y - vr.tv.y) < 0.3) this.fail(`O1: ${other.id} and ${vr.id} both ${vr.state} on cell ${vr.tv.node}, on top of each other`);
        }
        serving.set(vr.tv.node, vr);
        if (!(graph.docks.get(vr.targetId) || []).includes(vr.tv.node)) this.fail(`O1: ${vr.id} ${vr.state} on ${vr.tv.node}, no dock of ${vr.targetId}`);
      }
    }
  }

  /** R6: the dock is in the returnable class of the vehicle's planning position; R7: a pickup dock leads on to the drop. Both survive late rebinding. */
  checkChoice(vr) {
    const { lg } = this;
    const { graph } = lg;
    const res = vr.dock;
    const entry = res.entry;
    if (entry) {
      const docks = graph.docks.get(res.station) || [];
      const anyBack = docks.some((d) => entry.search.dist(d) < Infinity && graph.sameScc(d, entry.node));
      if (anyBack && !graph.sameScc(res.node, entry.node)) this.fail(`R6: ${vr.id} drives to ${res.node}, a one-way trap, while a dock it can get back from exists`);
    }
    if (vr.state === 'toPickup' && vr.order && vr.route && vr.route.edges.length > 0 && vr.tv.driving) {
      const last = vr.route.edges[vr.route.edges.length - 1];
      if (!lg.routes.canReach(res.node, last, vr.order.flow.to.id)) this.fail(`R7: ${vr.id} picks up at ${res.node} from where ${vr.order.flow.to.id} cannot be reached`);
    }
    const key = `${vr.id}|${vr.state}|${vr.stateSince}|${vr.order ? vr.order.id : ''}`;
    const leg = this.legs.get(key) || { nodes: new Set(), tele0: vr.tv.teleports };
    leg.nodes.add(res.node);
    this.legs.set(key, leg);
    if (leg.nodes.size > this.stats.maxDocksPerLeg) this.stats.maxDocksPerLeg = leg.nodes.size;
    // a leg that was not interrupted by a relocation (deadlock resolution) may have had at most two docks: the planned one and one rebinding switch
    if (leg.tele0 === vr.tv.teleports && leg.nodes.size > this.stats.maxDocksPerCleanLeg) this.stats.maxDocksPerCleanLeg = leg.nodes.size;
  }

  /** The visit ledger: the book's counters against the events. Call at the end of a run (a window that starts at 0). */
  ledger() {
    const book = this.lg.docks;
    // a vehicle that breaks down or dies in service has a visit and no pickup: the ledger is exact only for plants without
    if (this.lg.vehicles.some((v) => v.cfg.failing || v.cfg.batteryOn)) return this.problems;
    for (const st of this.lg.stations) {
      if (st.type === 'depot') continue;
      const visits = (book.byStation.get(st.id) || []).reduce((n, d) => n + d.visits, 0);
      const expected = (this.pickups.get(st.id) || 0) + (this.deliveries.get(st.id) || 0);
      // a vehicle that has arrived and loads at the end of the run has a visit but no event yet: at most one per vehicle in flight
      const inService = this.lg.vehicles.filter((v) => (v.state === 'loading' || v.state === 'unloading') && v.targetId === st.id).length;
      if (visits < expected || visits > expected + inService) this.fail(`V1: ${st.id}: ${visits} dock visits against ${expected} pickups+deliveries (${inService} in service)`);
    }
    return this.problems;
  }

  assertClean(label = '') {
    if (this.problems.length > 0) throw new Error(`${label} dock referee: ${this.problems.slice(0, 6).join(' | ')}${this.problems.length > 6 ? ` (+${this.problems.length - 6} more)` : ''}`);
  }
}

/** Throughput of a finished run: loads delivered in total, per hour of the window. */
export function throughput(sim) {
  const k = sim.kpis();
  return { total: k.throughput.total, perHour: k.throughput.perHour, k };
}

export { DX, DY };
