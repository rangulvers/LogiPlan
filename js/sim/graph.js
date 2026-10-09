// Road graph: turns a layout's road plates into nodes (road cells) and directed edges (links),
// finds docks, classifies "controlled" cells and answers shortest-route queries.
// Pure and DOM-free. See docs/ARCHITECTURE.md §5.1 for the contract.
//
// Routing rule: vehicles cannot U-turn in the middle of a road. The search therefore runs over
// directed EDGES: after traversing edge e into node v the next edge may not be e.rev unless v
// offers no other exit (a dead end), where the vehicle reverses.
//
// Controlled cells (zone blocking): a cell is controlled when vehicles can conflict inside it —
// a reversal happens there (dead end), two streams merge into the same exit, or two movements
// cross. Plain straight/curved roads and one-way forks are uncontrolled.
//
// Size. The cell-indexed members (isNode, out, in, limit, controlled, ...) are dense: one slot per grid cell, so a lookup by
// node id is O(1). A route SEARCH, however, costs time and memory in proportion to the ROAD graph only: its per-node results are
// kept under the compact index `nodeIndex[id]` (position of the node in `nodes`), the search goes on only as far as it is asked, and
// nothing in it is sized by the grid. A 320 x 320 plant with a few roads searches as fast as a small baseplate with the same roads,
// and the same plant grown on any side behaves identically (docs/ARCHITECTURE.md 4.6, tests/sim.largegrid.test.js).

import { DX, DY, DIR_BIT, opposite, parseKey, perimeterCells } from '../util/grid.js';

const EMPTY = Object.freeze([]);

/**
 * Build the road graph for a layout.
 * @param {object} layout complete layout (see docs/ARCHITECTURE.md §4)
 * @returns {object} Graph
 */
export function buildGraph(layout) {
  const { cols, rows, cellSize } = layout.grid;
  const nodeCount = cols * rows;
  const isNode = new Uint8Array(nodeCount);
  const limit = new Float32Array(nodeCount).fill(1);
  const nodes = [];

  for (const [key, cell] of Object.entries(layout.roads || {})) {
    const [cx, cy] = parseKey(key);
    if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
    const id = cy * cols + cx;
    isNode[id] = 1;
    const lim = Number(cell?.limit);
    limit[id] = Number.isFinite(lim) && lim > 0 ? Math.min(1, Math.max(0.05, lim)) : 1;
    nodes.push(id);
  }
  nodes.sort((a, b) => a - b);
  const nodeIndex = new Int32Array(nodeCount).fill(-1); // node id -> position in `nodes` (compact index for search results)
  for (let k = 0; k < nodes.length; k++) nodeIndex[nodes[k]] = k;

  // ---- edges (deterministic order: node ascending, direction N,E,S,W) -------------------------
  const edges = [];
  const outLists = new Array(nodeCount);
  const inLists = new Array(nodeCount);
  for (const id of nodes) { outLists[id] = []; inLists[id] = []; }
  const edgeAt = new Map(); // from*4+dir -> edge id
  for (const u of nodes) {
    const cx = u % cols;
    const cy = (u - cx) / cols;
    const mask = layout.roads[cx + ',' + cy].out | 0;
    for (let d = 0; d < 4; d++) {
      if (!(mask & DIR_BIT[d])) continue;
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const v = ny * cols + nx;
      if (!isNode[v]) continue;
      const edge = { id: edges.length, from: u, to: v, dir: d, length: cellSize, limit: Math.min(limit[u], limit[v]), rev: -1 };
      edges.push(edge);
      edgeAt.set(u * 4 + d, edge.id);
      outLists[u].push(edge.id);
      inLists[v].push(edge.id);
    }
  }
  for (const e of edges) {
    const r = edgeAt.get(e.to * 4 + opposite(e.dir));
    e.rev = r === undefined ? -1 : r;
  }
  const baseCost = new Float64Array(edges.length); // default search cost per edge: length / limit (never below 1e-9)
  for (const e of edges) baseCost[e.id] = Math.max(1e-9, e.length / e.limit);
  // flat copies of the links for the search (compact node index): the edges of a node are consecutive, so its exits are a range of ids
  const edgeToK = new Int32Array(edges.length);
  const edgeRev = new Int32Array(edges.length);
  const outStartK = new Int32Array(nodes.length + 1);
  for (const e of edges) {
    edgeToK[e.id] = nodeIndex[e.to];
    edgeRev[e.id] = e.rev;
    outStartK[nodeIndex[e.from] + 1]++;
  }
  for (let k = 0; k < nodes.length; k++) outStartK[k + 1] += outStartK[k];
  const out = new Array(nodeCount);
  const inn = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) { out[i] = outLists[i] || EMPTY; inn[i] = inLists[i] || EMPTY; }

  // ---- docks ------------------------------------------------------------------------------------
  const docks = new Map();
  const stationsAt = new Map();
  for (const st of layout.stations || []) {
    const set = new Set();
    for (const [cx, cy] of perimeterCells(st)) {
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      const id = cy * cols + cx;
      if (isNode[id]) set.add(id);
    }
    const list = [...set].sort((a, b) => a - b);
    docks.set(st.id, list);
    for (const id of list) {
      if (!stationsAt.has(id)) stationsAt.set(id, []);
      stationsAt.get(id).push(st.id);
    }
  }

  // ---- node classification ------------------------------------------------------------------------
  const controlled = new Uint8Array(nodeCount);
  const deadEnd = new Uint8Array(nodeCount);
  for (const v of nodes) classifyNode(v, edges, out, inn, controlled, deadEnd);

  const graph = {
    cols, rows, cellSize, nodeCount, isNode, nodes, nodeIndex, edges, baseCost, edgeToK, edgeRev, outStartK, out, in: inn, limit, controlled, deadEnd, docks, stationsAt,
    x: (id) => ((id % cols) + 0.5) * cellSize,
    y: (id) => (Math.floor(id / cols) + 0.5) * cellSize,
    cx: (id) => id % cols,
    cy: (id) => Math.floor(id / cols),
    edgeBetween(a, b) {
      for (const eid of out[a]) if (edges[eid].to === b) return eid;
      return -1;
    },
    search: (from, opts) => search(graph, from, opts),
    path: (from, to, opts) => search(graph, from, { ...opts, target: to }).routeTo(to),
    scc: computeScc(nodeCount, nodes, edges, out),
    sameScc: (a, b) => graph.scc[a] >= 0 && graph.scc[a] === graph.scc[b],
  };
  return graph;
}

/** Legal exits after arriving over `arrival` (edge id or -1) at node v. */
function exitsAfter(edges, out, v, arrival) {
  const exits = out[v];
  if (arrival < 0) return exits;
  const rev = edges[arrival].rev;
  if (rev < 0) return exits;
  if (exits.length === 1) return exits; // only way out is the reverse: dead-end reversal
  return exits.filter((id) => id !== rev);
}

function classifyNode(v, edges, out, inn, controlled, deadEnd) {
  const movements = [];
  let reversal = false;
  for (const inId of inn[v]) {
    const ein = edges[inId];
    const exits = exitsAfter(edges, out, v, inId);
    for (const outId of exits) {
      if (outId === ein.rev) reversal = true;
      movements.push([ein, edges[outId]]);
    }
  }
  if (reversal) { deadEnd[v] = 1; controlled[v] = 1; return; }
  for (let i = 0; i < movements.length; i++) {
    for (let j = i + 1; j < movements.length; j++) {
      const [a, b] = [movements[i], movements[j]];
      if (a[0].id === b[0].id) continue; // same incoming lane: a queue, no conflict
      const merge = a[1].id === b[1].id;
      const opposite_ = a[0].from === b[1].to && a[1].to === b[0].from; // exact opposite lanes through the cell
      if (merge || !opposite_) { controlled[v] = 1; return; }
    }
  }
}

// ---- shortest route search (edge-based Dijkstra with the no-U-turn rule) -----------------------------

/** Binary min-heap of (cost, edge id) in typed arrays, ordered by cost and then by id. One per search. */
class EdgeHeap {
  constructor(capacity) {
    this.cost = new Float64Array(capacity);
    this.id = new Int32Array(capacity);
    this.size = 0;
    this.lastCost = 0; // cost of the entry returned by the last pop()
  }

  push(cost, id) {
    if (this.size === this.id.length) this.grow();
    const c = this.cost;
    const ids = this.id;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] < cost || (c[p] === cost && ids[p] < id)) break;
      c[i] = c[p]; ids[i] = ids[p]; i = p;
    }
    c[i] = cost; ids[i] = id;
  }

  pop() {
    const c = this.cost;
    const ids = this.id;
    const topCost = c[0];
    const topId = ids[0];
    const n = --this.size;
    if (n > 0) {
      const lastCost = c[n];
      const lastId = ids[n];
      let i = 0;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        if (r < n && (c[r] < c[l] || (c[r] === c[l] && ids[r] < ids[l]))) l = r;
        if (c[l] > lastCost || (c[l] === lastCost && ids[l] > lastId)) break;
        c[i] = c[l]; ids[i] = ids[l]; i = l;
      }
      c[i] = lastCost; ids[i] = lastId;
    }
    this.lastCost = topCost;
    return topId;
  }

  grow() {
    const cost = new Float64Array(this.cost.length * 2);
    const id = new Int32Array(this.id.length * 2);
    cost.set(this.cost);
    id.set(this.id);
    this.cost = cost;
    this.id = id;
  }
}

/**
 * Cheapest routes from `from` to the road cells, found as far as somebody asks. Cost and memory follow the road graph, not the grid:
 * the result keeps one distance and one edge per ROAD node (compact index) and one predecessor per edge.
 *
 * Lazy. With the default costs a search does not explore the whole network up front: `dist(node)` and `routeTo(node)` continue the
 * Dijkstra until that node is settled (its cost is final the moment it is first reached from the heap, whichever way it was asked), so a
 * question about a dock two aisles away costs two aisles, not the plant. Every answer is the one the full search gives (tests/sim.largegrid.test.js
 * compares both on random networks, in random order of questions). A search with a cost callback (congestion-aware routing: the costs are a
 * snapshot that changes later) is run at once instead, as far as `target` when one is given, so it never mixes two snapshots.
 */
function search(graph, from, opts = {}) {
  const { edges, nodeIndex, nodeCount, baseCost, edgeToK, edgeRev, outStartK } = graph;
  const arrivalEdge = opts.arrivalEdge ?? -1;
  const customCost = opts.cost || null;
  const target = opts.target ?? -1;
  const roadNodes = graph.nodes.length;
  const nodeDist = new Float64Array(roadNodes).fill(Infinity); // per compact node: cost of the cheapest arrival (known once it is settled)
  const nodeEdge = new Int32Array(roadNodes).fill(-1); // ... and the edge that arrives that way
  const pred = new Int32Array(edges.length); // edge before e on its cheapest route, -1 for a first edge; only read along settled chains
  let run = null; // the Dijkstra state while the search can still go on: { edgeCost (0 = not reached: every cost is >= 1e-9), heap }

  /** Continue until compact node `untilK` is settled (-1: until every reachable node is). Leaves a state that can be continued. */
  function expand(untilK) {
    const { edgeCost, heap } = run;
    while (heap.size > 0) {
      const e = heap.pop();
      const c = heap.lastCost;
      if (c > edgeCost[e]) continue;
      const k = edgeToK[e];
      if (c < nodeDist[k] || (c === nodeDist[k] && e < nodeEdge[k])) { nodeDist[k] = c; nodeEdge[k] = e; }
      const first = outStartK[k];
      const last = outStartK[k + 1];
      const skip = last - first > 1 ? edgeRev[e] : -1; // no U-turn, except at a dead end
      for (let nx = first; nx < last; nx++) {
        if (nx === skip) continue;
        const cc = c + (customCost === null ? baseCost[nx] : Math.max(1e-9, customCost(edges[nx])));
        const known = edgeCost[nx];
        if (cc < (known === 0 ? Infinity : known)) { edgeCost[nx] = cc; pred[nx] = e; heap.push(cc, nx); }
      }
      if (k === untilK) return;
    }
    run = null; // nothing left to explore: the buffers can go
  }

  if (from >= 0 && from < nodeCount && graph.isNode[from]) {
    run = { edgeCost: new Float64Array(edges.length), heap: new EdgeHeap(256) };
    // the first edges: every exit of the start, except the way back along the arrival edge unless it is the only way out
    const k0 = nodeIndex[from];
    const first = outStartK[k0];
    const last = outStartK[k0 + 1];
    const skip0 = arrivalEdge >= 0 && edges[arrivalEdge] !== undefined && last - first > 1 ? edgeRev[arrivalEdge] : -1;
    for (let e = first; e < last; e++) {
      if (e === skip0) continue;
      const c = customCost === null ? baseCost[e] : Math.max(1e-9, customCost(edges[e]));
      if (c < Infinity) { run.edgeCost[e] = c; pred[e] = -1; run.heap.push(c, e); }
    }
    if (customCost !== null) {
      expand(target >= 0 && target < nodeCount ? nodeIndex[target] : -1);
      run = null; // as far as asked, and no further: the costs of now are not the costs of later
    }
  }

  /** Make sure compact node k is settled if it can be. */
  const settle = (k) => { if (nodeEdge[k] < 0 && run !== null) expand(k); };
  const compact = (node) => (node >= 0 && node < nodeCount ? nodeIndex[node] : -1);
  return {
    from,
    arrivalEdge,
    dist: (node) => {
      if (node === from) return 0;
      const k = compact(node);
      if (!(k >= 0)) return Infinity;
      settle(k);
      return nodeDist[k];
    },
    routeTo(node) {
      if (from < 0 || from >= nodeCount || !graph.isNode[from] || node < 0 || node >= nodeCount) return null;
      if (node === from) return { nodes: [from], edges: [], cost: 0 };
      const k = compact(node);
      if (!(k >= 0)) return null;
      settle(k);
      if (nodeEdge[k] < 0) return null;
      const routeEdges = [];
      for (let e = nodeEdge[k]; e >= 0; e = pred[e]) routeEdges.push(e);
      routeEdges.reverse();
      const routeNodes = [from];
      for (const e of routeEdges) routeNodes.push(edges[e].to);
      return { nodes: routeNodes, edges: routeEdges, cost: nodeDist[k] };
    },
  };
}

// ---- strongly connected components (iterative Tarjan) ---------------------------------------------------

function computeScc(nodeCount, nodes, edges, out) {
  const comp = new Int32Array(nodeCount).fill(-1);
  const index = new Int32Array(nodeCount).fill(-1);
  const low = new Int32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);
  const stack = [];
  let counter = 0;
  let compCount = 0;
  for (const root of nodes) {
    if (index[root] >= 0) continue;
    const work = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root); onStack[root] = 1;
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame[0];
      if (frame[1] < out[v].length) {
        const w = edges[out[v][frame[1]++]].to;
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w); onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        if (low[v] === index[v]) {
          let w;
          do { w = stack.pop(); onStack[w] = 0; comp[w] = compCount; } while (w !== v);
          compCount++;
        }
        work.pop();
        if (work.length) { const parent = work[work.length - 1][0]; low[parent] = Math.min(low[parent], low[v]); }
      }
    }
  }
  return comp;
}
