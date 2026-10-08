// TrafficSystem performance: 100 vehicles on a 60 x 40 street grid must simulate much faster than real time.
// The architecture asks for >= 2000x on a laptop-class CPU; the assertion uses a conservative bound so that slow or
// busy CI machines pass, and the measured factor is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { buildGraph } from '../js/sim/graph.js';
import { TrafficSystem } from '../js/sim/traffic.js';
import { createRng } from '../js/util/rng.js';

// Timed in CPU seconds of this process, not wall-clock time: node runs the test files in parallel, and on a machine busy with
// other work the wall-clock time of a run says little about the speed of the code.
const cpuSeconds = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

const REQUIRED_FACTOR = 500; // real-time factor (CPU time) that must be reached on any machine
const TARGET_FACTOR = 2000; // the figure of docs/ARCHITECTURE.md §5.2

/** 60 x 40 cells, two-way streets on every sixth row and column: ~660 road cells, 25 junctions. */
const streetGrid = () => Array.from({ length: 40 }, (_, y) => Array.from({ length: 60 }, (_, x) => (x % 6 === 0 || y % 6 === 0 ? '+' : '.')).join(''));

/** A closed tour of `legs` routes for a vehicle standing on `start` (computed up front so that only motion is timed). */
function tour(graph, rng, cells, start, legs) {
  const routes = [];
  let at = start;
  let arrival = -1;
  while (routes.length < legs) {
    const goal = routes.length === legs - 1 ? start : cells[rng.int(cells.length)];
    const route = graph.search(at, { arrivalEdge: arrival }).routeTo(goal);
    if (route === null || route.edges.length === 0) continue;
    routes.push(route);
    at = goal;
    arrival = route.edges[route.edges.length - 1];
  }
  return routes;
}

test('100 vehicles on a 60 x 40 grid simulate at least 500x real time (target 2000x)', (t) => {
  const graph = buildGraph(layoutFromAscii(streetGrid(), { cellSize: 2 }));
  const traffic = new TrafficSystem(graph);
  const rng = createRng(11);
  const cells = graph.nodes.filter((n) => graph.controlled[n] === 0);
  const tours = new Map();
  for (let i = 0; tours.size < 100 && i < 1000; i++) {
    const tv = traffic.addVehicle({ id: `v${tours.size}`, node: cells[rng.int(cells.length)], length: 1.2, speed: 1.5, accel: 0.6, decel: 1 });
    if (tv) tours.set(tv, { legs: tour(graph, rng, cells, tv.node, 6), i: 0 });
  }
  assert.equal(tours.size, 100);
  let trips = 0;
  traffic.onArrive = (tv) => {
    trips++;
    const own = tours.get(tv);
    own.i = (own.i + 1) % own.legs.length;
    traffic.drive(tv, own.legs[own.i]);
  };
  for (const [tv, own] of tours) traffic.drive(tv, own.legs[0]);

  const dt = 0.1;
  for (let i = 0; i < 300; i++) traffic.step(dt); // warm-up (JIT, caches)
  const seconds = 600;
  const started = cpuSeconds();
  for (let i = 0; i < seconds / dt; i++) traffic.step(dt);
  const elapsed = cpuSeconds() - started;
  const factor = seconds / elapsed;

  const message = `100 vehicles, 60x40 grid: ${seconds} s simulated in ${(elapsed * 1000).toFixed(0)} ms = ${factor.toFixed(0)}x real time `
    + `(${((elapsed * 1e6) / (seconds / dt) / 100).toFixed(2)} us per vehicle and tick; target ${TARGET_FACTOR}x)`;
  t.diagnostic(message);
  console.log(message);
  assert.ok(trips > 100, `the vehicles really drive (${trips} trips)`);
  assert.ok(factor >= REQUIRED_FACTOR, `only ${factor.toFixed(0)}x real time (needed ${REQUIRED_FACTOR}x)`);
});
