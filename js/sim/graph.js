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
    cols, rows, cellSize, nodeCount, isNode, nodes, edges, out, in: inn, limit, controlled, deadEnd, docks, stationsAt,
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

class MinHeap {
  constructor() { this.cost = []; this.id = []; }
  get size() { return this.id.length; }
  push(cost, id) {
    const c = this.cost;
    const ids = this.id;
    let i = ids.length;
    c.push(cost); ids.push(id);
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
    const lastCost = c.pop();
    const lastId = ids.pop();
    const n = ids.length;
    if (n > 0) {
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
}

const defaultCost = (edge) => edge.length / edge.limit;

function search(graph, from, opts = {}) {
  const { edges, out, nodeCount } = graph;
  const arrivalEdge = opts.arrivalEdge ?? -1;
  const cost = opts.cost || defaultCost;
  const target = opts.target ?? -1;
  const edgeCost = new Float64Array(edges.length).fill(Infinity); // cost to have traversed edge e
  const pred = new Int32Array(edges.length).fill(-1);
  const nodeDist = new Float64Array(nodeCount).fill(Infinity);
  const nodeEdge = new Int32Array(nodeCount).fill(-1);
  const heap = new MinHeap();

  if (from >= 0 && from < nodeCount && graph.isNode[from]) {
    nodeDist[from] = 0;
    const relax = (e, base, p) => {
      const c = base + Math.max(1e-9, cost(edges[e]));
      if (c < edgeCost[e]) { edgeCost[e] = c; pred[e] = p; heap.push(c, e); }
    };
    for (const e of exitsAfter(edges, out, from, arrivalEdge)) relax(e, 0, -1);
    while (heap.size > 0) {
      const e = heap.pop();
      const c = heap.lastCost;
      if (c > edgeCost[e]) continue;
      const v = edges[e].to;
      if (c < nodeDist[v] || (c === nodeDist[v] && e < nodeEdge[v])) { nodeDist[v] = c; nodeEdge[v] = e; }
      if (v === target) break;
      for (const nx of exitsAfter(edges, out, v, e)) relax(nx, c, e);
    }
  }

  return {
    from,
    arrivalEdge,
    dist: (node) => (node === from ? 0 : node >= 0 && node < nodeCount ? nodeDist[node] : Infinity),
    routeTo(node) {
      if (from < 0 || from >= nodeCount || !graph.isNode[from] || node < 0 || node >= nodeCount) return null;
      if (node === from) return { nodes: [from], edges: [], cost: 0 };
      if (nodeEdge[node] < 0) return null;
      const routeEdges = [];
      for (let e = nodeEdge[node]; e >= 0; e = pred[e]) routeEdges.push(e);
      routeEdges.reverse();
      const routeNodes = [from];
      for (const e of routeEdges) routeNodes.push(edges[e].to);
      return { nodes: routeNodes, edges: routeEdges, cost: nodeDist[node] };
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
