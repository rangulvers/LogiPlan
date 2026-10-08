// Route planning for the logistics layer: cached graph searches and "which dock?" queries.
//
// A search is keyed by (start node, arrival edge) because the graph forbids mid-road U-turns, so the edge a
// vehicle arrived over changes which routes are legal. With routing 'shortest' the cache is valid forever
// (the layout never changes under a Logistics instance); with 'congestion' the costs are a snapshot of the live
// traffic that is renewed every CONGESTION_REFRESH seconds of sim time: an entry of an older snapshot is searched
// again the next time it is asked for (or, when the tick's search budget is spent, used as it is).
// Questions that do not depend on costs - can a vehicle get to a dock of station X from here? - are not answered
// by searching at all but by `canReach`, which sweeps the road graph backwards from the docks of X once and then
// answers every query in constant time (exactly the answer a search would give, including the no-U-turn rule).
//
// Search budget. A search costs time in proportion to the size of the ROAD graph (its road cells plus its links; the empty
// cells of the baseplate cost nothing, so a plant behaves the same whatever room is left around it), and a plant with 40 vehicles
// needs one search per vehicle the first time they are all looked at: 60 ms in a single tick, 2 s on the largest plants. Callers
// that can wait ask with `deferrable`: each tick (beginTick) only `budget` new searches are started for them and the others get
// null, to be asked again in the next tick. The budget is measured in road graph size, so it is generous on the small plants of
// the examples (never reached there) and one or two searches per tick on the biggest plant.
//
// Dock choice. A station has several docks; the cheapest one is not always a good one. A dock is
// "returnable" when the vehicle can get back to where it started (same strongly connected part of the road
// network); a one-way dead end next to a station is reachable but swallows the vehicle. Returnable docks come
// first, then the cheapest, then the lowest node id. A pickup dock must also have a way on to the drop.

import { CONGESTION_REFRESH, CONGESTION_WEIGHT, EPS, ROUTE_CACHE_BYTES, SEARCH_WORK_PER_TICK } from './common.js';

const MAX_ENTRIES = 512;
const MIN_ENTRIES = 8;
/** Size of one search in units of road cells and links: the work it takes and (below) the memory it keeps. */
const searchSize = (graph) => graph.edges.length + graph.nodes.length;
/**
 * Bytes a cached search keeps: a Float64 and an Int32 per road cell, an Int32 per link, and, as long as it has not explored the whole
 * network (graph.js searches go on only as far as they are asked), a Float64 per link for the costs of the edges it has reached.
 */
const searchBytes = (graph) => 12 * graph.nodes.length + 12 * graph.edges.length + 256;

/** New searches per tick for deferrable lookups on this graph: SEARCH_WORK_PER_TICK in units of one search's size, at least one. */
export function searchBudget(graph) {
  return Math.max(1, Math.floor(SEARCH_WORK_PER_TICK / searchSize(graph)));
}

/** Drop the least recently used quarter of a full cache (a whole-cache flush would make a hot working set start over). */
function evict(map) {
  const byUse = [...map].sort((a, b) => a[1].used - b[1].used);
  for (let i = 0; i < Math.max(1, byUse.length >> 2); i++) map.delete(byUse[i][0]);
}

/**
 * Edges after whose traversal a dock of the station can still be reached (a vehicle that has just driven edge e stands at e.to).
 * Computed by one sweep backwards over the moves the routing rule allows: from e a vehicle may continue over every exit of e.to
 * except the reverse of e, unless that is its only exit (the dead-end reversal).
 * @returns {{ leads: Uint8Array, isDock: Set<number> }} `leads`: 1 per edge id that leads to a dock; `isDock`: the dock nodes
 */
function sweepToDocks(graph, dockNodes) {
  const { edges, out } = graph;
  const isDock = new Set(dockNodes);
  const leads = new Uint8Array(edges.length);
  const queue = new Int32Array(edges.length); // every edge is queued at most once
  let tail = 0;
  for (const node of dockNodes) for (const id of graph.in[node]) if (leads[id] === 0) { leads[id] = 1; queue[tail++] = id; }
  for (let head = 0; head < tail; head++) {
    const next = edges[queue[head]];
    const otherExits = out[next.from].length > 1; // a vehicle may reverse into `next` only at a dead end
    for (const id of graph.in[next.from]) {
      if (leads[id] || (otherExits && edges[id].rev === next.id)) continue;
      leads[id] = 1;
      queue[tail++] = id;
    }
  }
  return { leads, isDock };
}

export class RouteCache {
  /**
   * @param {object} graph road graph (js/sim/graph.js)
   * @param {{ edgeCount?: (edgeId: number) => number }} traffic only edgeCount is used (congestion costs)
   * @param {'shortest'|'congestion'} mode
   */
  constructor(graph, traffic, mode = 'shortest') {
    this.graph = graph;
    this.traffic = traffic;
    this.mode = mode;
    /** Searches with the costs of the current mode (renewed per snapshot in congestion mode) and searches with plain costs. */
    this.entries = new Map();
    this.fixed = new Map();
    /** Time of the current congestion snapshot. */
    this.stamp = -Infinity;
    this.edgeKey = graph.edges.length + 1;
    const total = Math.floor(ROUTE_CACHE_BYTES / searchBytes(graph));
    /** Most searches kept: the plain-cost ones live for ever, so they get most of the memory budget. */
    this.fixedCapacity = Math.max(MIN_ENTRIES, Math.min(MAX_ENTRIES, Math.floor((total * 3) / 4)));
    this.capacity = Math.max(MIN_ENTRIES, Math.min(MAX_ENTRIES, Math.floor(total / 4)));
    this.clock = 0;
    /** New searches deferrable lookups may start per tick (Infinity: no limit), and how many were started since beginTick. */
    this.budget = Infinity;
    this.spent = 0;
    /** station id -> result of sweepToDocks, built on first use. */
    this.sweeps = new Map();
    /** Congestion cost of every edge, a snapshot taken at the last refresh. */
    this.edgeCost = new Float64Array(graph.edges.length);
    this.cost = (edge) => this.edgeCost[edge.id];
  }

  /** Switch the routing mode; cached searches of the old mode are dropped. */
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.entries.clear();
    this.stamp = -Infinity;
  }

  /** A new tick starts: deferrable lookups may start `budget` new searches again. */
  beginTick() {
    this.spent = 0;
  }

  /** Take a new snapshot of the traffic: length / limit, stretched by the vehicles currently on each edge. Entries of the old snapshot are renewed when next asked for. */
  refresh(now) {
    this.stamp = now;
    const count = typeof this.traffic.edgeCount === 'function' ? (id) => this.traffic.edgeCount(id) : () => 0;
    for (const edge of this.graph.edges) {
      this.edgeCost[edge.id] = (edge.length / edge.limit) * (1 + CONGESTION_WEIGHT * count(edge.id));
    }
  }

  /**
   * The cached search from `node`, having arrived over `arrivalEdge` (-1 = free choice), with the costs of the
   * current routing mode.
   * @param {number} node
   * @param {number} arrivalEdge
   * @param {number} now sim time (decides when the congestion snapshot is renewed)
   * @param {boolean} [deferrable] true: start a new search only if this tick's budget allows it, else answer null
   *   (an entry of an older congestion snapshot is then returned as it is)
   * @returns {{ node: number, arrivalEdge: number, search: object, docks: Map, pickups: Map }|null} entry
   */
  get(node, arrivalEdge, now, deferrable = false) {
    if (this.mode !== 'congestion') return this.settled(node, arrivalEdge, deferrable);
    if (now - this.stamp >= CONGESTION_REFRESH - EPS) this.refresh(now);
    return this.lookup(this.entries, node, arrivalEdge, true, deferrable);
  }

  /** Like get, but with the plain costs, whatever the routing mode: valid for as long as the cache lives. */
  settled(node, arrivalEdge, deferrable = false) {
    return this.lookup(this.fixed, node, arrivalEdge, false, deferrable);
  }

  lookup(map, node, arrivalEdge, congestion, deferrable) {
    const key = node * this.edgeKey + arrivalEdge + 1;
    let entry = map.get(key);
    if (entry === undefined || (congestion && entry.stamp !== this.stamp)) {
      if (deferrable && this.spent >= this.budget) {
        if (entry === undefined) return null;
      } else {
        this.spent++;
        if (entry === undefined && map.size >= (congestion ? this.capacity : this.fixedCapacity)) evict(map);
        const opts = congestion ? { arrivalEdge, cost: this.cost } : { arrivalEdge };
        entry = { node, arrivalEdge, search: this.graph.search(node, opts), docks: new Map(), pickups: new Map(), used: 0, stamp: this.stamp };
        map.set(key, entry);
      }
    }
    entry.used = ++this.clock;
    return entry;
  }

  /**
   * Can a vehicle at `node`, having arrived over `arrivalEdge` (-1 = free choice), get to a dock of the station? Standing on
   * one counts. The answer is the one a search from there would give (no mid-road U-turn), found without searching.
   */
  canReach(node, arrivalEdge, stationId) {
    const docks = this.graph.docks.get(stationId);
    if (docks === undefined || docks.length === 0) return false;
    let sweep = this.sweeps.get(stationId);
    if (sweep === undefined) this.sweeps.set(stationId, (sweep = sweepToDocks(this.graph, docks)));
    if (sweep.isDock.has(node)) return true;
    const exits = this.graph.out[node];
    if (exits === undefined) return false; // not a node of this graph
    const arrived = this.graph.edges[arrivalEdge];
    const reverse = arrived === undefined ? -1 : arrived.rev;
    for (const id of exits) if (sweep.leads[id] === 1 && (id !== reverse || exits.length === 1)) return true;
    return false;
  }

  /**
   * Reachable docks of a station from an entry's start, best first (see the header). Each dock is
   * `{ node, dist, back, arrivalEdge }`; arrivalEdge (the last edge of the route there) is filled in on demand.
   */
  docksOf(entry, stationId) {
    let list = entry.docks.get(stationId);
    if (list === undefined) {
      list = [];
      for (const node of this.graph.docks.get(stationId) || []) {
        const dist = entry.search.dist(node);
        if (dist < Infinity) list.push({ node, dist, back: this.graph.sameScc(node, entry.node), arrivalEdge: undefined });
      }
      list.sort((a, b) => (b.back - a.back) || (a.dist - b.dist) || (a.node - b.node));
      entry.docks.set(stationId, list);
    }
    return list;
  }

  /**
   * The route from an entry's start to `dock` (a dock of docksOf, or any `{ node }`), kept on the dock: the search of an entry never changes,
   * so every vehicle that plans from there gets the same route object (nobody modifies a route; the traffic system copies it).
   */
  routeOfDock(entry, dock) {
    if (dock.route === undefined) dock.route = entry.search.routeTo(dock.node);
    return dock.route;
  }

  /** Seconds a vehicle needs for the route to `dock` at the speed limits (unit speed; cached on the dock): the plain length of the way, whatever the routing mode. */
  baseTimeOfDock(entry, dock) {
    if (dock.base === undefined) {
      const route = this.routeOfDock(entry, dock);
      let sum = 0;
      if (route === null) sum = Infinity;
      else for (const e of route.edges) sum += this.graph.baseCost[e];
      dock.base = sum;
    }
    return dock.base;
  }

  /** The edge a vehicle driving to `dock` arrives over (the entry's own arrival edge for a zero-length route). */
  arrivalEdgeAt(entry, dock) {
    if (dock.arrivalEdge === undefined) {
      const route = this.routeOfDock(entry, dock);
      dock.arrivalEdge = route && route.edges.length > 0 ? route.edges[route.edges.length - 1] : entry.arrivalEdge;
    }
    return dock.arrivalEdge;
  }

  /** Best dock of a station for an entry's start, or null when none is reachable. */
  bestDock(entry, stationId) {
    const list = this.docksOf(entry, stationId);
    if (list.length === 0) return null;
    this.arrivalEdgeAt(entry, list[0]);
    return list[0];
  }

  /** Best dock of `fromId` from which a dock of `toId` can still be reached, or null. */
  pickupDock(entry, fromId, toId) {
    const key = fromId + '>' + toId;
    let found = entry.pickups.get(key);
    if (found === undefined) {
      found = null;
      for (const dock of this.docksOf(entry, fromId)) {
        if (this.canReach(dock.node, this.arrivalEdgeAt(entry, dock), toId)) { found = dock; break; }
      }
      entry.pickups.set(key, found);
    }
    return found;
  }

  /**
   * The docks of `stationId` a vehicle at an entry's start may choose between, cheapest first: the reachable ones of the best class (the
   * returnable ones if there are any, else the others) and, with `toId` (a pickup), only those from which a dock of `toId` can still be
   * reached. The first one is what bestDock / pickupDock return; docks.js picks among them by the estimated time to start service.
   * @returns {Array<{ node: number, dist: number, back: boolean, arrivalEdge: number }>}
   */
  dockChoices(entry, stationId, toId = null) {
    const key = toId === null ? stationId : stationId + '>' + toId;
    if (entry.choices === undefined) entry.choices = new Map();
    let list = entry.choices.get(key);
    if (list === undefined) {
      list = [];
      let back = null;
      for (const dock of this.docksOf(entry, stationId)) {
        if (back !== null && dock.back !== back) break; // sorted: the returnable docks come first
        if (toId !== null && !this.canReach(dock.node, this.arrivalEdgeAt(entry, dock), toId)) continue;
        back = dock.back;
        list.push(dock);
      }
      entry.choices.set(key, list);
    }
    return list;
  }

  /** Route from an entry's start to `node`, or null when unreachable. */
  routeTo(entry, node) {
    return entry.search.routeTo(node);
  }

  /**
   * How a vehicle parked in `depot` can leave: over every dock where it fits right now (traffic.canAttach),
   * with a free choice of direction; `choose(entry)` names the onward dock from there (or null). Docks whose search the
   * tick's budget does not allow yet are left out and reported as `pending`.
   * @returns {{ attachable: boolean, pending: boolean, best: { dock: number, onward: object }|null }} `best` has the cheapest onward dock
   */
  departure(depot, now, choose) {
    let attachable = false;
    let pending = false;
    let best = null;
    for (const dock of this.graph.docks.get(depot.id) || []) {
      if (!this.traffic.canAttach(dock)) continue;
      attachable = true;
      const entry = this.get(dock, -1, now, true);
      if (entry === null) { pending = true; continue; }
      const onward = choose(entry);
      if (onward && (best === null || onward.dist < best.onward.dist)) best = { dock, onward };
    }
    return { attachable, pending, best };
  }

  /** Can a vehicle at `node` (arrived over `arrivalEdge`) get to a dock of any of the stations? */
  canReachAny(node, arrivalEdge, stationIds) {
    return stationIds.some((id) => this.canReach(node, arrivalEdge, id));
  }
}
