// Route planning for the logistics layer: cached graph searches and "which dock?" queries.
//
// A search is keyed by (start node, arrival edge) because the graph forbids mid-road U-turns, so the edge a
// vehicle arrived over changes which routes are legal. With routing 'shortest' the cache is valid forever
// (the layout never changes under a Logistics instance); with 'congestion' the costs are a snapshot of the live
// traffic that is renewed every CONGESTION_REFRESH seconds of sim time, and all cached searches expire with it.
// Questions that do not depend on costs - is a station reachable from here? - are answered from searches with
// the plain costs (`settled`), which never expire, so congestion routing does not repeat them every refresh.
//
// Dock choice. A station has several docks; the cheapest one is not always a good one. A dock is
// "returnable" when the vehicle can get back to where it started (same strongly connected part of the road
// network); a one-way dead end next to a station is reachable but swallows the vehicle. Returnable docks come
// first, then the cheapest, then the lowest node id. A pickup dock must also have a way on to the drop.

import { CONGESTION_REFRESH, CONGESTION_WEIGHT, EPS, ROUTE_CACHE_BYTES } from './common.js';

const MAX_ENTRIES = 512;
const MIN_ENTRIES = 8;
const BYTES_PER_SLOT = 12; // a search keeps a Float64 and an Int32 per edge and per node

/** Drop the least recently used quarter of a full cache (a whole-cache flush would make a hot working set start over). */
function evict(map) {
  const byUse = [...map].sort((a, b) => a[1].used - b[1].used);
  for (let i = 0; i < Math.max(1, byUse.length >> 2); i++) map.delete(byUse[i][0]);
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
    /** Searches with the costs of the current mode (expiring in congestion mode) and searches with plain costs. */
    this.entries = new Map();
    this.fixed = new Map();
    this.stamp = -Infinity;
    this.edgeKey = graph.edges.length + 1;
    const total = Math.floor(ROUTE_CACHE_BYTES / (BYTES_PER_SLOT * (graph.edges.length + graph.nodeCount) + 256));
    /** Most searches kept: the plain-cost ones live for ever, so they get most of the memory budget. */
    this.fixedCapacity = Math.max(MIN_ENTRIES, Math.min(MAX_ENTRIES, Math.floor((total * 3) / 4)));
    this.capacity = Math.max(MIN_ENTRIES, Math.min(MAX_ENTRIES, Math.floor(total / 4)));
    this.clock = 0;
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

  /** Take a new snapshot of the traffic: length / limit, stretched by the vehicles currently on each edge. */
  refresh(now) {
    this.entries.clear();
    this.stamp = now;
    const count = typeof this.traffic.edgeCount === 'function' ? (id) => this.traffic.edgeCount(id) : () => 0;
    for (const edge of this.graph.edges) {
      this.edgeCost[edge.id] = (edge.length / edge.limit) * (1 + CONGESTION_WEIGHT * count(edge.id));
    }
  }

  /**
   * The cached search from `node`, having arrived over `arrivalEdge` (-1 = free choice), with the costs of the
   * current routing mode.
   * @returns {{ node: number, arrivalEdge: number, search: object, docks: Map, pickups: Map }} entry
   */
  get(node, arrivalEdge, now) {
    if (this.mode !== 'congestion') return this.lookup(this.fixed, node, arrivalEdge, false);
    if (now - this.stamp >= CONGESTION_REFRESH - EPS) this.refresh(now);
    return this.lookup(this.entries, node, arrivalEdge, true);
  }

  /** Like get, but with the plain costs: for questions of reachability only. Valid for as long as the cache lives. */
  settled(node, arrivalEdge) {
    return this.lookup(this.fixed, node, arrivalEdge, false);
  }

  lookup(map, node, arrivalEdge, congestion) {
    const key = node * this.edgeKey + arrivalEdge + 1;
    let entry = map.get(key);
    if (entry === undefined) {
      if (map.size >= (congestion ? this.capacity : this.fixedCapacity)) evict(map);
      const opts = congestion ? { arrivalEdge, cost: this.cost } : { arrivalEdge };
      entry = { node, arrivalEdge, search: this.graph.search(node, opts), docks: new Map(), pickups: new Map(), used: 0 };
      map.set(key, entry);
    }
    entry.used = ++this.clock;
    return entry;
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

  /** The edge a vehicle driving to `dock` arrives over (the entry's own arrival edge for a zero-length route). */
  arrivalEdgeAt(entry, dock) {
    if (dock.arrivalEdge === undefined) {
      const route = entry.search.routeTo(dock.node);
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
        const onward = this.settled(dock.node, this.arrivalEdgeAt(entry, dock));
        if (this.docksOf(onward, toId).length > 0) { found = dock; break; }
      }
      entry.pickups.set(key, found);
    }
    return found;
  }

  /** Route from an entry's start to `node`, or null when unreachable. */
  routeTo(entry, node) {
    return entry.search.routeTo(node);
  }

  /**
   * How a vehicle parked in `depot` can leave: over every dock where it fits right now (traffic.canAttach),
   * with a free choice of direction; `choose(entry)` names the onward dock from there (or null).
   * @returns {{ attachable: boolean, best: { dock: number, onward: object }|null }} `best` has the cheapest onward dock
   */
  departure(depot, now, choose) {
    let attachable = false;
    let best = null;
    for (const dock of this.graph.docks.get(depot.id) || []) {
      if (!this.traffic.canAttach(dock)) continue;
      attachable = true;
      const onward = choose(this.get(dock, -1, now));
      if (onward && (best === null || onward.dist < best.onward.dist)) best = { dock, onward };
    }
    return { attachable, best };
  }

  /** Can a vehicle starting at an entry reach a dock of any of the stations? */
  reaches(entry, stationIds) {
    return stationIds.some((id) => this.docksOf(entry, id).length > 0);
  }
}
