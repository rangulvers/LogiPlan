# LogiPlan — Architecture & Module Contracts

LogiPlan is a browser app for **planning factory layouts and in-plant logistics**. A planner builds a plant on a
Lego-style baseplate (roads, stations, obstacles), defines the material flows and the vehicle fleets, then runs a
**simulation** to watch vehicles drive, queue and deliver — and tunes speed, traffic, fleet size and layout until the
plan works. Variants can be compared side by side and exported as a report.

It runs as a **static GitHub Pages site**: vanilla ES modules, **no build step, no runtime dependencies, no network
access needed**. All simulation code is DOM-free and runs identically in Node (tests, headless experiments) and the browser.

This file is the contract between modules. When code and this document disagree, fix whichever is wrong **and say so in your report**.

---

## 1. Conventions

* ES modules only (`import`/`export`), relative paths with the `.js` extension. `"type": "module"` in package.json.
* `js/model/**`, `js/sim/**`, `js/util/{grid,rng,ids,format}.js`, `js/store/**` (except persistence calls guarded by
  `typeof localStorage`) must run in Node ≥ 20 with **no DOM and no `window`/`document`**.
  `js/ui/**` and `js/util/dom.js` are browser-only (tests for them use the Playwright E2E harness or pure helper functions).
* **No external imports** (no CDN, no npm packages) in `js/`. `npm run check` (scripts/check-imports.mjs) verifies that
  every relative import resolves and every named import is exported — run it.
* Determinism: the simulation never calls `Math.random()` or `Date.now()`. All randomness comes from `js/util/rng.js`
  (`createRng(seed).fork(label)` gives an independent stream per component). Same layout + same seed ⇒ bit-identical run.
* Units: **metres, seconds, m/s, grid cells**. World coordinates in metres, y points down. Directions `0=N 1=E 2=S 3=W`
  (see `js/util/grid.js`). Headings in radians as `Math.atan2(dy, dx)` (so East = 0, South = π/2).
* Style: 2-space indent, semicolons, single quotes, `const`/`let`, small pure functions, JSDoc on exported symbols,
  a header comment per file stating its responsibility. Match the existing code (see `js/util/*.js`, `js/model/defaults.js`).
* Tests: `node:test` + `node:assert/strict`, files `tests/<area>.<module>.test.js` (flat, matched by `tests/*.test.js`),
  helpers in `tests/helpers/`. Tests must be deterministic and fast (each file < 10 s). Build test layouts with
  `tests/helpers/ascii.js` (`layoutFromAscii`) or the model API — never depend on `Math.random`.
* A change is only done when `npm run test:quiet` and `npm run check` pass.

## 2. Repository layout

```
index.html                  app shell (relative asset paths only!)
css/                        tokens.css, layout.css, components.css (+ print styles)
js/
  main.js                   bootstrap: build store, sim runner, UI; handle #share links
  util/    grid.js rng.js ids.js format.js dom.js                      (done)
  model/   defaults.js (done) layout.js validate.js serialize.js examples.js
  sim/     graph.js traffic.js logistics.js stats.js insights.js engine.js experiments.js
  store/   store.js
  ui/      theme.js icons.js camera.js renderer.js editor.js runner.js app.js
           dialogs.js dashboard.js charts.js compare.js report.js
           panels/ inspector.js fleet.js flows.js simulate.js checks.js
tests/     *.test.js, helpers/ (ascii.js …), e2e/ (Playwright, run by hand: npm run test:e2e)
scripts/   serve.mjs (dev server), check-imports.mjs
docs/      ARCHITECTURE.md (this file)
.github/workflows/          ci.yml (tests on PR), pages.yml (deploy to GitHub Pages)
```

## 3. Layering & dependency rules

```
util  ←  model  ←  sim  ←  store?  ←  ui  ←  main
```
* `model` imports only `util`. `sim` imports `util` + `model/defaults.js` (+ `model/layout.js` for `normalizeLayout`).
* `store` imports `model` (+ `util`). It never imports `sim` or `ui`.
* `ui` may import everything below it; `ui` modules never import `main.js`. `sim` never imports `ui` or `store`.
* Layout objects are **plain JSON** (structured-cloneable). Consumers treat a layout as an immutable snapshot; the store
  replaces `state.layout` with a new object on every commit, so caches keyed on object identity (WeakMap) are valid.

---

## 4. Domain model — the Layout

`js/model/defaults.js` is authoritative for defaults. A complete layout:

```js
{
  schema: 1,
  name: 'Untitled plant', notes: '',
  grid: { cols: 48, rows: 32, cellSize: 2 },        // cellSize = metres per cell edge (0.5…10)
  roads: { 'cx,cy': { out: 0b1111, limit?: 0.1..1 } },
  obstacles: [{ id, x, y, w, h, kind: 'wall'|'rack'|'column' }],
  labels:    [{ id, x, y, text, size? }],            // x,y in cells (may be fractional)
  stations:  [Station], flows: [Flow], fleets: [Fleet],
  settings:  Settings,
}
```

### 4.1 Roads (the Lego road plates)
`roads` is a sparse map keyed `"cx,cy"` (use `cellKey`). A key present ⇒ that cell is a road cell. `out` is a bitmask of
**exit directions**: bit `DIR_BIT[d]` (N=1, E=2, S=4, W=8) set ⇒ vehicles may drive from this cell into the neighbouring
cell in direction `d`. A **directed link** A→B therefore exists iff A is a road cell, A.out has the bit for dir(A→B), and
B is a road cell. Invariants (enforced by `normalizeLayout`, maintained by every mutator): no bit points at a
non-road cell or out of bounds; no road cell overlaps a station or obstacle. `limit` (optional, default 1) is a speed
factor for that cell (a "slow zone", e.g. 0.5). A two-way road = links in both directions; a one-way road = one direction.
Two parallel adjacent roads are **not** connected unless explicitly linked. Drawing a stroke from cell P to adjacent
cell Q adds link P→Q (and Q→P for two-way). A lone cell with no links is legal (renders as a plate, unusable).

### 4.2 Stations (bricks)
```js
{ id: 's1', type: 'source'|'process'|'storage'|'sink'|'depot', name, x, y, w, h /*cells*/, params: {…} }
```
Params per type (defaults in `defaultStationParams`):
| type | params |
|---|---|
| source | `interArrival: Dist`, `batch` loads per arrival, `outCap` yard-to-buffer capacity **per outgoing flow**, `startDelay` s |
| process | `cycle: Dist`, `machines` (parallel identical machines), `outPerCycle`, `inCap` input slots **per incoming flow**, `outCap` output slots **per outgoing flow**, `mtbf`/`mttr` s (0 = never fails) |
| storage | `capacity` total loads held, `dwell` min seconds a load stays before it may leave |
| sink | none |
| depot | `slots` parking places, `chargers` of those slots that can charge |

`Dist = { kind: 'const'|'normal'|'uniform'|'exp', mean: seconds, spread: 0..1 }` — see `sampleDist` in `js/util/rng.js`.
Stations occupy rectangles of cells; stations and obstacles never overlap each other or road cells. **Docks:** every road
cell edge-adjacent (4-neighbourhood) to a station rectangle is a dock of that station. Vehicles stop on a dock cell to
load/unload — they physically occupy that road cell while doing so (this is how a badly placed station blocks traffic).
Vehicles never drive inside stations. A depot absorbs parked vehicles: they leave the road (detach) and reappear on the dock cell when needed.

### 4.3 Flows (logical material flow, not geometry)
```js
{ id, from, to, weight, perCycle, batchMin, batchMax, maxWait, priority, fleetId }   // see defaultFlow
```
A flow says "loads leaving station `from` go to station `to`". `from` ∈ {source, process, storage}, `to` ∈ {process, storage,
sink}; depots take part in no flows; `from !== to`; at most one flow per ordered pair. When a station has several outgoing
flows, produced loads are split by `weight` (smooth weighted round-robin, deterministic). `perCycle`: loads of this flow a
process consumes per cycle (bill of materials: an assembly needing 2 of A and 1 of B has two incoming flows with perCycle 2 and 1).
`batchMin/batchMax/maxWait`: how many loads one transport carries (`batchMax` 0 = vehicle capacity); a partial batch ≥ 1 is
released once the oldest waiting load has waited `maxWait` s. `priority` 1–3: higher is served first by the dispatcher.
`fleetId`: restrict to one fleet (null = any).

### 4.4 Fleets
See `defaultFleet` / `FLEET_PRESETS`: `count`, `speed` m/s, `accel`/`decel` m/s², `length` m, `capacity` loads, `loadTime`/`unloadTime` s,
`battery {enabled, runtimeMin, chargeTimeMin, lowPct, resumePct}`, `mtbf`/`mttr` s (vehicle breakdowns — a broken vehicle
blocks its lane!), `home` (depot id), `idle` ('park' | 'stay'). Vehicle ids: `"<fleetId>#<n>"` (1-based).

### 4.5 Settings
`seed, duration, warmup, dispatch, routing, handedness, deadlock, demandFactor, speedFactor, processFactor, dt` (see `defaultSettings`).
`RUNTIME_KEYS` (`demandFactor, speedFactor, processFactor, dispatch, routing`) can be changed **while a simulation runs**
(`sim.setRuntime`); everything else in a layout requires rebuilding the simulation.

### 4.6 `js/model/layout.js` — API (owner: model agent)
Pure functions; mutators edit the layout passed in **in place** (the store passes them a cloned draft) and keep the invariants of §4.1–4.3.
```js
createLayout({ name?, cols?, rows?, cellSize? }) → Layout                     // = emptyLayout + overrides
normalizeLayout(raw) → Layout            // tolerant import: migrate by `schema`, fill defaults, clamp numbers, drop dangling refs,
                                         // repair road links/overlaps, dedupe ids, never throws on junk (throws only if raw isn't an object)
cloneLayout(layout) → Layout             // structuredClone
layoutChangeKind(prev, next) → 'none' | 'cosmetic' | 'runtime' | 'structural'
                                         // 'none' deep-equal; 'cosmetic' iff only name, notes, labels, obstacles, settings.duration differ (sim keeps running);
                                         // 'runtime' iff (additionally) only RUNTIME_KEYS in settings differ (applied live); anything else 'structural' (sim rebuilds)

// queries
getStation(layout, id), getFlow(layout, id), getFleet(layout, id)
stationAt(layout, cx, cy) → Station|null      obstacleAt(layout, cx, cy) → Obstacle|null      labelAt(layout, cx, cy) → Label|null
roadAt(layout, cx, cy) → { out, limit }|null  hasLink(layout, cx, cy, dir) → boolean
isCellFree(layout, cx, cy, { ignoreStation?, ignoreObstacle? }) → boolean      // in bounds, no station/obstacle (roads ignored)
isRectFree(layout, rect, { ignoreStation?, ignoreObstacle?, allowRoads? }) → boolean   // in bounds, no overlap with stations/obstacles (and roads unless allowRoads)
docksOf(layout, stationId) → Array<[cx, cy]>  // road cells adjacent to the station
flowsFrom(layout, stationId), flowsTo(layout, stationId)
stats: roadCellCount(layout), roadLengthMeters(layout)

// road mutators
paintRoadPath(layout, cells /*[[cx,cy],…] consecutive 4-neighbours, gaps are filled with lPath*/, { oneWay = false }) → number /*cells touched*/
   // creates missing road cells (skipping blocked cells: stop painting at the first blocked cell), adds links P→Q (and Q→P unless oneWay)
paintRoadCell(layout, cx, cy) → boolean
eraseRoadCell(layout, cx, cy) → boolean         // removes the cell and every link into it
eraseLink(layout, cx, cy, dir) → boolean
setRoadLimit(layout, cx, cy, limit /*1 removes*/) → boolean
flipRoadDirection(layout, cx, cy, dir) → boolean     // toggle one-way/two-way on a link: A→B only ↔ B→A only ↔ both (cycles)

// entity mutators (return the created/updated object, or null if rejected)
addStation(layout, { type, x, y, w?, h?, name?, params? }) → Station|null     // rejects overlaps/out-of-bounds; unique id ("s1"…); name "Source 2" style unique
moveStation(layout, id, x, y) → boolean       resizeStation(layout, id, rect) → boolean       // reject if blocked; roads under the new rect are NOT silently deleted: reject
updateStation(layout, id, patch) → boolean    // shallow merge; `params` merged one level deep; clamps/validates
removeStation(layout, id) → boolean           // cascades: removes its flows, clears fleet.home refs
duplicateStation(layout, id, { dx = 1, dy = 1 }) → Station|null
addFlow(layout, from, to, patch?) → Flow|null // validates §4.3 rules; null on duplicate/invalid
updateFlow(layout, id, patch) → boolean       removeFlow(layout, id) → boolean
addFleet(layout, preset = 'agv', patch?) → Fleet                 updateFleet(layout, id, patch) → boolean (battery merged)
removeFleet(layout, id) → boolean              // clears flow.fleetId refs     duplicateFleet(layout, id) → Fleet|null
addObstacle(layout, { x, y, w, h, kind }) → Obstacle|null   updateObstacle / removeObstacle(layout, id)   // obstacles may not cover roads/stations
addLabel(layout, { x, y, text, size? }) → Label     updateLabel / removeLabel(layout, id)
resizeGrid(layout, cols, rows) → { removed: number } // drops/clips anything outside; clamps to GRID_LIMITS
setCellSize(layout, cellSize) → boolean
translateAll(layout, dx, dy) → boolean         // shift everything (used when growing the grid to the left/top)
```

### 4.7 `js/model/validate.js` (owner: model agent)
```js
validateLayout(layout, { graph? }) → Issue[]
Issue = { id, severity: 'error'|'warning'|'info', code, message, hint?, refs: { stationId?, flowId?, fleetId?, cells?: [[cx,cy],…] } }
```
Plain-language messages for a factory planner (no jargon like "SCC"). If a pre-built sim `graph` is passed, use `graph.search` for
reachability; otherwise do an internal BFS over `roads`. Codes to implement (at least): `no-stations`, `no-roads`, `no-flows`,
`no-fleets` (flows exist but no vehicles), `station-no-dock` (no adjacent road cell), `station-dock-isolated`, `flow-unreachable`
(no route from a dock of `from` to a dock of `to`), `flow-no-return` (vehicle can get there but not back — one-way dead end),
`flow-bad-endpoints`, `flow-fleet-missing`, `source-no-outflow`, `process-no-inflow`, `process-no-outflow`, `sink-no-inflow`,
`perCycle-exceeds-inCap` (process can never start), `batch-exceeds-capacity`, `storage-small`, `depot-missing` (battery enabled but no depot
with chargers), `home-depot-missing`, `vehicle-longer-than-cell` (warning), `road-fragment` (road cells not connected to any dock),
`one-way-dead-end`, `fleet-count-zero`, `duplicate-names` (info). Each issue has a stable `id` (code + ref) so the UI can keep dismissed state.

### 4.8 `js/model/serialize.js` (owner: model agent)
```js
exportProject(project) → string       // JSON of { app:'logiplan', schema:1, name, active:index, scenarios:[{ id, name, layout }] }
importProject(text) → project         // accepts a project export OR a bare layout JSON; normalizes; throws Error with a friendly message on junk
encodeShare(project) → Promise<string>   // deflate-raw (CompressionStream) + base64url; falls back to plain base64url, prefix 'z.' / 'p.'
decodeShare(str) → Promise<project>
shareUrl(base, project) → Promise<string>   // `${base}#p=${encodeShare}`
```

### 4.9 `js/model/examples.js` (owner: model agent)
`EXAMPLES: [{ id, name, description, build() → Layout }]` — at least three worked, *realistic and runnable* examples built through the
`layout.js` API (so they double as tests): (1) **"Starter: dock → assembly → shipping"** (small, 2 AGVs, works out of the box, a loop road),
(2) **"Two production lines + warehouse"** (forklifts and AGVs, a storage buffer, a depot with chargers, a BOM-style assembly),
(3) **"Congestion lab"** (one-way narrow aisles, a junction and too many vehicles → the planner sees queues and can fix them).
Each example must pass `validateLayout` with zero errors and produce useful KPIs when simulated (an integration test will check that).

---

## 5. Simulation

**Time-stepped** (`dt` = `settings.dt`, default 0.1 s). One tick: `logistics.step(dt)` (decides, loads, machines, dispatch) →
`traffic.step(dt)` (moves vehicles, resolves arrivals) → `stats.sample(dt)`. The UI advances the sim with
`sim.advance(seconds, { maxMillis })`; experiments run it flat out. Vehicle poses are interpolated by the renderer between ticks.

### 5.1 `js/sim/graph.js` — road graph (owner: graph/traffic agent)
```js
buildGraph(layout) → Graph
Graph = {
  cols, rows, cellSize, nodeCount /* cols*rows, dense ids: id = cy*cols+cx */,
  isNode: Uint8Array, nodes: number[] /* road-cell ids ascending */,
  edges: Edge[] /* edges[i].id === i */, out: number[][] , in: number[][]  /* edge ids per node id; [] for non-road */,
  limit: Float32Array /* per-node speed factor */, controlled: Uint8Array, deadEnd: Uint8Array,
  docks: Map<stationId, number[]>, stationsAt: Map<nodeId, string[]>,
  x(id), y(id) → world metres of the cell centre,  cx(id), cy(id),
  edgeBetween(a, b) → edgeId | -1,
  search(from, { arrivalEdge = -1, cost = null }) → Search,
  path(from, to, opts) → Route | null,
  scc: Int32Array /* strongly-connected component per node, -1 if not road */, sameScc(a, b)
}
Edge   = { id, from, to, dir, length /* = cellSize */, limit /* min(limit(from), limit(to)) */, rev /* opposite edge id or -1 */ }
Search = { dist(node) → cost | Infinity, routeTo(node) → Route | null }
Route  = { nodes: number[], edges: number[], cost: number }     // nodes.length === edges.length + 1, nodes[0] = start
```
**Routing rule (no mid-road U-turns):** search runs over *directed edges*; after traversing edge `e` into node `v`, the next edge may not be
`e.rev` **unless** `v` offers no other exit (a dead end), in which case the vehicle reverses there. `arrivalEdge` is the edge the vehicle has
just driven (so a vehicle standing on a dock cell cannot U-turn on the spot); `-1` = free choice (vehicle just left a depot).
Default cost = `edge.length / edge.limit` (so slow zones are avoided when a detour is quicker); a `cost(edge)` callback replaces it
(congestion-aware routing). `routeTo(start)` is a zero-length route. Ties broken deterministically (lowest edge id).

**Controlled nodes** (mutual exclusion — only one vehicle may be inside such a cell at a time, like AGV "zone blocking"):
node `v` is controlled iff, over its *movements* `(e_in → e_out)` (every in-edge × out-edge except `e_out = e_in.rev`, plus the reversal
`e_in → e_in.rev` when it is the only way out), any of: (a) a reversal movement exists (dead end), (b) two movements with different `e_in`
share `e_out` (merge), (c) two movements with different `e_in` that are not exact opposites of each other (crossing / T-junction).
Plain straight or curved roads (two-way: opposite lanes; one-way: single stream) and simple one-way forks are **uncontrolled**.

### 5.2 `js/sim/traffic.js` — vehicle motion (owner: graph/traffic agent)
Moves vehicles along routes with collision avoidance. Knows nothing about loads, stations or orders.

```js
new TrafficSystem(graph, { headway = 0.5 /* min bumper gap, m */, handedness = 'right', deadlockTime = 20 /* s */,
                           resolveDeadlocks = true, rng })
traffic.vehicles: TV[]
traffic.addVehicle({ id, length, speed, accel, decel, node, owner? }) → TV | null     // placed stationary at the node centre, null if no room
traffic.removeVehicle(tv)
traffic.detach(tv)                       // lift off the road (parked inside a depot): tv.onRoad = false, frees lock/lane
traffic.canAttach(node) → boolean        traffic.attach(tv, node) → boolean      // put back at the node centre if there is room
traffic.drive(tv, route)                 // tv must be at route.nodes[0], stopped, !driving. Sets tv.driving = true
traffic.relocate(tv, node) → boolean     // teleport to a free node (deadlock resolution); clears the route
traffic.findFreeNode(near) → node | -1   // closest node (graph distance, ignoring direction) with room for a vehicle
traffic.step(dt)
traffic.speedFactor = 1                  // runtime multiplier on every vehicle's max speed
traffic.onArrive = (tv) => {}            // route finished: tv stopped exactly at the last node's centre, tv.driving = false
traffic.onDeadlock = ({ vehicles, nodes, resolved, victim }) => {}
traffic.edgeCount(edgeId) → number       // vehicles currently on the edge (for congestion-aware costs)
traffic.stats = { edgePasses: Int32Array, edgeWait: Float64Array /* veh·s waiting on edge */, nodeWait: Float64Array /* veh·s waiting in/at cell */,
                  waitVehicle: number, waitJunction: number, waitBroken: number /* cumulative veh·s by waitReason */,
                  deadlocks: number, totalWait: number /* = sum of the three */, drivingTime: number /* veh·s with a route and moving or waiting */ }
TV = { id, owner, length, width, vmax, accel, decel,
       onRoad, node /* ≥0 when stationary exactly at a node centre, else -1 */, edge /* current edge or -1 */, s /* m from the edge tail */, lastEdge,
       v, x, y, heading, prevX, prevY, prevHeading /* pose at start of the last tick, for render interpolation */,
       driving, moving /* v > 0.05 */, waiting /* wants to move but cannot */, waitReason: null|'vehicle'|'junction'|'broken',
       blockedBy: TV|null, disabled /* broken down: brakes and refuses to move until cleared */, odometer, waitTime }
```
Behavioural requirements (tests must cover each):
1. **Kinematics:** accelerate at `accel` up to `vmax * traffic.speedFactor * edge.limit`; brake at `decel` to stop exactly at the final node centre
   (and at stop lines); slow to ≤ 50 % of vmax through corners and controlled cells; speed 0 for dead-end reversals. Works for `dt` up to 0.5 s.
2. **Headway / no collisions:** never closer than `headway` bumper-to-bumper behind the leader *along the route* (across edge boundaries,
   including a leader standing at a dock). Safe even if the leader stops instantly. Opposite lanes of a two-way road do not interact.
3. **Lanes:** vehicles on an edge with an opposite edge (`rev ≥ 0`) are offset to the right (`handedness`) by ≈ 0.22·cellSize; on one-way edges
   they ride the centreline. Poses are **continuous** (no jumps > 5 cm/tick at max speed) including around corners (blend lateral offset, round
   the turn). `heading` follows the direction of motion smoothly.
4. **Controlled cells:** a vehicle enters one only when it holds the cell's lock, grants are FIFO by request time among vehicles that *can* proceed,
   and only if it can fully clear the cell (room beyond the exit for its length + headway — no box-blocking). Lock released when the vehicle's rear clears the cell.
   A vehicle standing on a controlled dock cell holds it (that is the point). Starvation-free.
5. **Waiting bookkeeping:** `waiting`, `waitReason`, `blockedBy`, `waitTime`, `stats.*Wait` are maintained (the heatmap and the "traffic" KPIs rest on them).
6. **Deadlocks:** every ~1 s build the wait-for graph of waiting vehicles (blockedBy edges). A cycle whose members have all been waiting ≥ `deadlockTime`
   is a deadlock: `stats.deadlocks++`, call `onDeadlock`. If `resolveDeadlocks`, relocate the victim (the longest-waiting member with the fewest
   hindrances) via `findFreeNode` and set `resolved = true`; otherwise the jam stands (`resolved = false`, reported once per cycle membership).
7. **Disabled vehicles** (`tv.disabled = true`) stop with max decel at once and stay; others queue behind them (that is the realism).
8. `detach`/`attach`/`relocate` never leave stale entries in lane lists or locks. `removeVehicle` likewise.
9. Complexity: step cost ≈ O(vehicles × lookahead); 100 vehicles on a 60×40 grid must simulate ≥ 2000× real time in Node on a laptop-class CPU.

### 5.3 `js/sim/logistics.js` — stations, loads, orders, vehicles (owner: logistics agent)
The "brain": simulates sources, machines, buffers, sinks and depots, creates transport jobs and runs each vehicle's state machine.
It drives `TrafficSystem` through `drive/detach/attach` and reacts to `traffic.onArrive`.

```js
new Logistics({ layout, graph, traffic, rng, emit /* (name, payload) => void */ })
logistics.stations: StationRT[] (layout order)      logistics.stationById: Map
logistics.vehicles: VehicleRT[]                      logistics.flows: FlowRT[]
logistics.step(dt, t)          // t = sim time at the start of the tick
logistics.setRuntime({ demandFactor, speedFactor, processFactor, dispatch, routing })
logistics.liveLoads            // number of existing loads (WIP)
logistics.completed            // loads that left the system (sink consumption + process-without-outflow output)
```
**Loads/WIP.** `Load = { id, createdAt, origin, readyAt, claimed }`. Created by sources (`createdAt = t`) and by process output (`createdAt` = the
**oldest** input's `createdAt`, so lead time is end-to-end). Consumed by processes (inputs vanish at cycle start; WIP counts them as in-process) and by sinks.

**StationRT** (all types): `id, type, def, state, fill /* 0..1 */, fillLabel /* e.g. "3/8" */, inCount, outCount, produced, consumed, arrivals,
inQ: Map<flowId, Load[]>, outQ: Map<flowId, Load[]>, inbound: Map<flowId, number> /* space reserved by orders en route */`. Type specific:
* **source:** `yard` (loads that arrived but found the output buffer full — unbounded backlog), `state`: `'normal'` | `'blocked'` (yard > 0). Arrival times
  from `interArrival` (÷ `demandFactor`), first at `startDelay`. Each arrival creates `batch` loads → yard → moved to `outQ` of a flow chosen by
  smooth-weighted-round-robin among flows with free space (`outCap` per flow).
* **process:** `machines: [{ state: 'idle'|'busy'|'blocked'|'down', remaining, cycleTime, progress /* 0..1 */, holding: Load[] }]`; aggregate `state`
  = `'down'` if all down, `'busy'` if any busy, `'blocked'` if any blocked and none busy, else `'starved'` (idle waiting for inputs). A machine starts a cycle when
  every incoming flow has ≥ `perCycle` loads in `inQ` (or it has no incoming flows), consumes them, samples `cycle × processFactor`, and when done
  produces `outPerCycle` loads, each routed by SWRR to an outgoing flow that has free `outCap` space; if none has space the machine is `'blocked'`
  (holding the loads) until it has. No outgoing flow ⇒ outputs complete immediately. Breakdowns: time to next failure ~ Exp(`mtbf`) of calendar time,
  repair ~ Exp(`mttr`); the running cycle is frozen while down.
* **storage:** `outQ` per outgoing flow; loads are routed to a flow (SWRR) on arrival and become available `dwell` s later; capacity counts all held loads.
* **sink:** consumes arriving loads instantly; emits `'loadCompleted'`.
* **depot:** `parked: VehicleRT[]`, `charging: VehicleRT[]`; `slots`, `chargers`.

**Orders & dispatch (demand-driven, global greedy matching).** A flow has *demand* when `available(flow)` (unclaimed loads in `from.outQ[flow]` that are ready)
and `space(flow)` (at `to`: sink ∞; process `inCap − queued − inbound` per flow; storage `capacity − held − all inbound`) allow a transport of
`qty = min(vehicle.capacity, batchMax || ∞, available, space) ≥ batchMin` (or `qty ≥ 1` once the oldest load waited ≥ `maxWait`). Every 0.5 s of sim time and on
relevant events, build all (idle-or-parked vehicle, flow) candidate pairs where the fleet is allowed by `flow.fleetId`, the pickup dock is reachable and the drop
dock is reachable from the pickup dock; sort by **priority desc**, then by strategy score —
`nearest`: pickup route cost (m, then oldest age); `oldest`: oldest-load age desc (then nearest); `balanced`: `cost − 0.5·age(s) ` —
and assign greedily; each assignment *claims* the loads and *reserves* `inbound` space immediately, so later pairs see reduced availability/space.
`Order = { id, flowId, from, to, qty, vehicleId, loads, createdAt /* assignment time */, readySince, pickedAt, deliveredAt }`.
Pickup/drop dock = nearest (route cost) dock of the station. Unreachable flows never get assigned (the UI lists them via `validateLayout`).

**VehicleRT:** `id, fleetId, fleet, name, color, tv, state, order, load: Load[], battery /* 0..1 */, visible /* false while parked inside */, stateSince,
x, y, heading, prevX, prevY, prevHeading /* mirrors of tv pose */, timeIn: {state: seconds}, trips, loadedDistance, emptyDistance`.
`state ∈ idle | parked | toPickup | loading | toDrop | unloading | toCharger | charging | toPark | broken | dead`.
Lifecycle: idle/parked → (assigned) [parked: re-attach at the depot dock when free] → toPickup → loading (`loadTime`, loads leave `outQ`) → toDrop →
unloading (`unloadTime`, loads enter the destination; inbound reservation released) → next order immediately, else idle behaviour: `fleet.idle === 'park'` and a
depot with a free slot is reachable ⇒ toPark → parked (detach); otherwise stay idle on the road. Initial placement: fleets park at `home` (or any depot with free slots);
otherwise spread over non-controlled, non-dock road cells deterministically.
Battery (when enabled): drains `1/(runtimeMin·60)` per s while driving/loading/unloading/waiting on the road, 20 % of that while idle on the road, 0 while parked;
charges `1/(chargeTimeMin·60)` per s at a depot charger. A vehicle with `battery < lowPct` and no order heads for the nearest depot with a free charger (reserving it),
charges to ≥ `resumePct`, then rejoins. At 0 it becomes `'dead'` (stops where it is, blocks its lane). Vehicle breakdowns (`mtbf/mttr`): `state = 'broken'`, `tv.disabled = true`.
After a deadlock relocation the vehicle re-plans its current leg from its new node.
**Emitted events** (`emit(name, payload)`): `loadCreated`, `loadCompleted {load, station, leadTime, t}`, `orderAssigned`, `orderPickedUp`,
`orderDelivered {order, waitForPickup, transit}`, `machineDown`, `machineUp`, `vehicleDown`, `vehicleUp`, `vehicleDead`.

### 5.4 `js/sim/stats.js` and `js/sim/insights.js` (owner: stats agent)
`Stats` *samples* simulation state each tick (reading the public fields documented above) and listens to events; it never mutates the sim.
```js
new Stats(sim)                  // sim exposes { time, layout, graph, traffic, logistics, settings }
stats.sample(dt)                // called once per tick, after traffic.step
stats.onEvent(name, payload)    // called by the engine for every emitted event
stats.reset()                   // start a fresh measurement window now (engine calls it when time reaches settings.warmup)
stats.report() → KpiReport      // JSON-serialisable, cheap enough to call at 2–4 Hz
stats.heat() → { edgePasses: Int32Array, edgeWait: Float64Array, nodeWait: Float64Array, maxEdgePasses, maxEdgeWait, maxNodeWait }   // window-relative
```
```js
KpiReport = {
  window: { start, end, duration, warmingUp /* true until settings.warmup has passed */ },
  throughput: { total, perHour, bySink: { [stationId]: { name, count, perHour } } },
  leadTime: { count, mean, min, p50, p90, p95, max },                       // seconds; null fields when count === 0
  wip: { mean, max, now },
  stations: { [id]: { type, name,
      utilization /* busy fraction (process: mean over machines; source: 1 - blockedShare; storage: avgFill) */,
      starved, blocked, down /* time fractions */, avgIn, maxIn, avgOut, maxOut, avgFill, maxFill /* 0..1 */,
      produced, consumed, arrivals, yardMax, yardNow, breakdowns } },
  fleets: { [fleetId]: { name, count,
      utilization /* 1 - idle/parked/charging-share: time spent working */,
      shares: { driving, waiting, loading, unloading, idle, parked, charging, broken },    // fractions of vehicle-time, sum to 1 (±1e-6)
      trips, tripsPerVehicleHour, distance /* m total */, distancePerVehicle, emptyShare /* empty/total distance */,
      avgPickupWait /* load ready → picked up, s */, avgTransit /* picked up → delivered, s */, minBattery /* 0..1 or null */ } },
  flows: { [flowId]: { from, to, delivered, trips, avgPickupWait, avgTransit, backlog /* loads ready but not yet moved, now */ } },
  traffic: { waitShare /* waiting time / driving+waiting time */, vehicleWait /* veh·s */, junctionWait /* veh·s */, deadlocks,
             hotspots: [{ node, cx, cy, wait /* veh·s */ }] /* top 10 */, deadlockEvents: [{ t, nodes, vehicles, resolved }] },
  orders: { completed, avgPickupWait, avgTransit },
  series: { interval, t: [], throughput: [] /* trailing-window units/h */, wip: [], vehiclesWorking: [], vehiclesWaiting: [] },
}
```
`generateInsights(report, layout) → Insight[]` with `Insight = { id, severity: 'critical'|'warning'|'info'|'good', title, detail, suggestion?, refs: { stationIds?, fleetIds?, flowIds?, cells? } }`,
sorted by severity. Rules (thresholds as named constants at the top of the file): bottleneck workstation (busy ≥ 90 % while its input queue is fuller than average
or successors starve), saturated fleet (utilization ≥ 85 % or high pickup wait ⇒ "add a vehicle / speed up / shorten routes"), oversized fleet (utilization < 35 %),
traffic congestion (waitShare ≥ 12 %; name the hot spot cells), deadlocks, supply exceeds capacity (source yard growing / yardNow large), buffer nearly full,
starved workstation, high empty-driving share (> 60 %), battery/charger problems, frequent breakdowns; a `good` insight when none of the warnings fire.
Messages are plain language for a factory planner and quote the numbers.

### 5.5 `js/sim/engine.js` — `Simulation` (owner: engine agent, wave 2)
```js
new Simulation(layout, { seed? /* overrides settings.seed */ })     // normalizes (clone), builds graph, traffic, logistics, stats, rng
sim.layout, sim.settings, sim.graph, sim.traffic, sim.logistics, sim.stats
sim.time, sim.dt
sim.stations /* = logistics.stations */, sim.vehicles /* = logistics.vehicles */
sim.step(dt = sim.dt)                       // one tick (also triggers stats.reset() when crossing settings.warmup)
sim.advance(seconds, { maxMillis, now = performance-like fn }) → seconds advanced   // loops step(); stops early when over budget
sim.setRuntime(patch)                       // RUNTIME_KEYS only; applies to logistics + traffic immediately
sim.on(name, fn) → off()                    // events: all logistics events + 'deadlock'
sim.kpis() → KpiReport    sim.insights() → Insight[]    sim.heat()
```

### 5.6 `js/sim/experiments.js` — headless runs (owner: engine agent, wave 2)
```js
runSimulation(layout, { duration?, warmup?, seed?, onProgress?, signal?, yieldEveryMs = 30 }) → Promise<KpiReport>   // never blocks the UI > ~30 ms; honours AbortSignal
runReplications(layout, { replications = 3, seed0?, ...opts }) → Promise<{ runs: KpiReport[], summary: { [metricId]: { mean, sd, min, max } } }>
METRICS = [{ id, label, unit, better: 'higher'|'lower'|null, digits, get(report) → number|null }]   // flat comparable numbers: throughput/h, mean & p95 lead time, WIP, fleet utilization (mean), vehicle wait share, empty share, deadlocks, max source backlog, bottleneck utilization …
summarizeReport(report) → { [metricId]: number|null }
listSweepParameters(layout) → [{ key, label, unit, min, max, step, values /* suggested */, get(layout) → number, apply(layout, value) → Layout /* cloned */ }]
   // fleet count, fleet speed (per fleet and "all"), vehicle capacity, demand factor, process factor, machines per workstation, buffer capacities, roads' speed limit factor …
sweep(layout, param, values, { replications, ...opts }) → Promise<Array<{ value, summary, runs }>>
compareScenarios(scenarios /* [{ id, name, layout }] */, { replications, ...opts }) → Promise<Array<{ id, name, summary, runs }>>
```

---

## 6. UI

### 6.1 Store — `js/store/store.js` (owner: store agent)
```js
createStore({ storageKey = 'logiplan:v1', storage = globalThis.localStorage /* may be undefined/throw */ }) → store
store.getState() → {
  project: { name, scenarios: [{ id, name, layout }], activeId },
  layout,                      // the active scenario's layout — THE editing document (new object on every commit)
  ui: { tool, toolOptions, selection: { kind: 'station'|'flow'|'fleet'|'obstacle'|'label'|'cell'|null, ids: [] },
        overlays: { grid, studs, flows, docks, heat: 'off'|'traffic'|'waiting', ids, labels }, rightTab, theme: 'auto'|'light'|'dark', followSim? },
  version, dirty, canUndo, canRedo, lastCommit: { label, kind /* layoutChangeKind */ }
}
store.subscribe(fn) → unsubscribe        // fn(state, info) after every change; info = { type: 'commit'|'ui'|'load'|'undo'|'redo', layoutChanged }
store.commit(label, mutator /* (draftLayout) => void|false */, { coalesce?: string }) → boolean
      // clones the layout, runs the mutator, normalises nothing (mutators keep invariants), pushes history unless the mutator returns false or changed nothing;
      // consecutive commits with the same `coalesce` key within 800 ms merge into one undo step (typing in a field, dragging a slider)
store.undo(), store.redo()
store.setUi(patch), store.select(kind, ids), store.clearSelection()
store.loadProject(project), store.newProject(layout?, name?), store.replaceLayout(layout, { label })
store.addScenario(name, layoutOrNull /* null = clone current */), store.switchScenario(id), store.renameScenario(id, name), store.deleteScenario(id), store.duplicateScenario(id)
store.persist() / store.restore() → boolean          // localStorage autosave (debounced 400 ms after changes, guarded by try/catch)
```
History: up to 100 snapshots (structuredClone per commit). Switching scenarios keeps a separate undo history per scenario.

### 6.2 Camera & Renderer — `js/ui/camera.js`, `js/ui/renderer.js` (owner: renderer agent)
```js
new Camera({ x, y, zoom })  // x,y = world metres at the canvas centre; zoom = pixels per metre
camera.worldToScreen(x, y), camera.screenToWorld(px, py), camera.screenToCell(px, py, cellSize) → [cx, cy], camera.pan(dxPx, dyPx),
camera.zoomAt(factor, px, py), camera.fit(layout, widthPx, heightPx, padding), camera.setViewport(w, h)

new Renderer(canvas, { camera, theme })
renderer.layout = Layout                // set/replace; static layer re-rendered when identity changes
renderer.sim = Simulation | null        // live vehicles/station states when present
renderer.view = { selection: {kind, ids}, hover: {kind, id, cell}, tool, overlays: {…as store.ui.overlays}, ghost: null | { kind:'station', type, rect, valid } |
                  { kind:'obstacle', rect, valid }, paintPreview: null | { cells:[[cx,cy]…], oneWay, dir? }, flowPreview: null | { fromId, toPoint:[x,y] },
                  marquee: null | rect, resizeHandles: boolean }
renderer.resize()                       // call on container resize (handles devicePixelRatio)
renderer.render(alpha)                  // draw a frame; alpha ∈ [0,1] interpolates vehicle poses between ticks
renderer.hitTest(px, py) → { kind: 'station'|'obstacle'|'label'|'flow'|'vehicle'|'cell', id?, cell:[cx,cy], handle?: 'n'|'ne'|…|'move' } 
renderer.toDataURL(opts) → string       // PNG of the whole layout (offscreen, ignoring camera) for reports
```
Visual spec (§7). Perf: static layer (baseplate, roads, obstacles, labels) cached on an offscreen canvas and redrawn only when layout/theme/zoom bucket changes; per frame draws stations' dynamic parts and vehicles. ≥ 60 fps with 100 vehicles.
Station/flow/vehicle visuals read the runtime fields of §5.3; the renderer must also work with `sim = null` (editing mode shows the layout alone).

### 6.3 Editor — `js/ui/editor.js` (owner: store agent)
Translates pointer/keyboard input into store commits and `renderer.view` updates. `new Editor({ canvas, store, camera, renderer, ctx })`, `editor.setTool(name)`, `editor.destroy()`.
Tools (shortcut): `select` (V), `pan` (H; also Space-drag / middle mouse / two-finger touch), `road` (R, two-way), `oneway` (O), `speedzone` (Z, option: factor),
`erase` (E), `source`/`process`/`storage`/`sink`/`depot` (1–5), `obstacle` (W, option kind), `label` (T), `flow` (F).
* **Road/one-way:** press-drag paints a free-hand path cell by cell (gaps from fast mouse movement filled with `lPath`), live preview, committed on release as **one** undo step.
  `oneway` links follow the drag direction. Starting/ending on an existing road cell connects to it. Shift = straight line (L-shape). Blocked cells stop the stroke with a red preview.
* **Station tools:** hover shows a ghost (green valid / red invalid); click places a default-size brick; press-drag sizes it. Select tool: drag to move (snap to grid, invalid = red ghost, release on invalid = cancel),
  drag edge/corner handles to resize, Delete removes, arrow keys nudge, Ctrl/Cmd+D duplicates.
* **Flow tool:** click source station then destination station ⇒ `addFlow`; Esc cancels; invalid pairs show a toast-style hint via `ctx.toast`.
* **Eraser:** drag over cells removes road cells, obstacles and labels there (stations only via selection + Delete). **Speed zone:** paints `limit`.
* Wheel = zoom at cursor, drag with pan tool/Space/middle = pan, double-click empty = fit. Esc = cancel current gesture / clear selection. Ctrl/Cmd+Z / Shift+Z / Y = undo/redo.
* All gestures work with touch (pointer events, `touch-action: none` on the canvas; two-finger pan/pinch).
Every layout change goes through `store.commit` with a clear human label ("Move station", "Draw road") — these appear in the undo tooltip.

### 6.4 Runner — `js/ui/runner.js` (owner: store agent)
Owns the live `Simulation` and the `requestAnimationFrame` loop.
```js
createRunner({ store, renderer, onFrame? }) → runner
runner.sim: Simulation|null     runner.playing: boolean     runner.speed: number (sim seconds per real second)     runner.limited: boolean (true when it cannot keep up)
runner.play(), runner.pause(), runner.toggle(), runner.step(seconds = 1), runner.reset(), runner.setSpeed(x)   // speeds 1,2,5,10,30,60,120,300,600,1200
runner.on(event, fn) → off     // 'state' (play/pause/reset/speed), 'frame' (every rAF, throttled stats at ~4 Hz as 'kpis')
```
Behaviour: the sim is built lazily on first play/step; **structural** layout changes (via `layoutChangeKind`) reset the sim (keeping the playing state) after a 250 ms debounce;
**runtime** and **cosmetic** changes never reset (runtime ones call `sim.setRuntime`). Per frame: `target += min(realDt, 0.1) * speed`; `sim.advance(target - sim.time, { maxMillis: 10 })`; `limited` when it falls behind; `alpha` for interpolation.
Pauses automatically when the tab is hidden. Exposes `runner.kpis()` (cached 250 ms) and `runner.insights()`.

### 6.5 Panels & dialogs (owner: panels agent) — `js/ui/panels/*.js`, `js/ui/dialogs.js`
Every panel: `export function createXPanel(ctx) → { el: HTMLElement, update(state): void, destroy(): void }`, where
```js
ctx = { store, runner, renderer, camera, toast(msg, { kind: 'info'|'success'|'warn'|'error', ms? }), actions: { openDialog(name), exportPng(), exportReport(), shareLink(), fitView() } }
```
`update(state)` is called on every store change (and ~4 Hz for live panels). **Rule:** never rebuild a form while a field in it has focus; rebuild only when a structural signature
(selection ids, list lengths, type) changes, otherwise just refresh `value`s of inputs that are not `document.activeElement`. All inputs commit via `store.commit(label, fn, { coalesce })`.
* `inspector.js` — context-sensitive properties: station (name, type-specific params with units and helper text, size), obstacle, label, road cell (speed limit), multi-select summary; with nothing selected: **plant settings** (name, notes, grid size/cell size, handedness).
* `fleet.js` — fleets list/cards: add from preset (AGV, forklift, tugger, custom), count (stepper), speed, accel/decel, length, capacity, load/unload times, battery group, breakdown group, home depot, idle policy; duplicate/delete.
* `flows.js` — table/cards of flows (from → to), weights, perCycle, batch, maxWait, priority, fleet restriction; an "Add flow" form (pick two stations) and quick "chain stations" helper; delete.
* `simulate.js` — **what-if panel**: sliders with live value + reset-to-1 for demand ×, vehicle speed ×, process time ×; dispatch strategy & routing selects, handedness, deadlock policy, seed, run duration/warm-up; runtime-key changes apply live.
* `checks.js` — the issues list from `validateLayout` (graph-aware) grouped by severity; clicking an issue selects/zooms to the referenced station/flow/cell; badge count exposed via `panel.count`.
* `dialogs.js` — `showDialog({ title, body, actions })` modal primitives + `openWelcome()` (examples gallery, "new empty plant", "continue"), `openHelp()` (tools, shortcuts, how the simulation works), `openShare()`, `openImportExport()`.

### 6.6 Dashboard, charts, compare, report (owner: dashboard agent)
* `charts.js` — dependency-free chart primitives drawn on `<canvas>`/SVG, theme-aware, hi-dpi, hover tooltips: `lineChart`, `barChart` (horizontal & vertical, grouped), `stackedBar`, `sparkline`, `gauge`/`donut`, with axes, units, legends. Pure render functions + small DOM wrappers.
* `dashboard.js` — live KPI view (`createDashboard(ctx)`): headline cards (throughput/h, mean & p95 lead time, WIP, fleet utilization, traffic wait share, deadlocks) with sparklines; per-fleet state-share stacked bars; per-station utilization/queue bars (bottleneck highlighted); throughput & WIP time-series; **Insights** list from `generateInsights` (clicking selects/zooms to refs); "warming up" state; "no data yet" empty state with a hint.
* `compare.js` — **Experiments tab**: (1) *Compare variants*: pick scenarios, replications, duration → run (progress + cancel) → table of METRICS with best/worst highlighting and deltas vs. the first, plus bar charts; (2) *Parameter sweep*: choose a parameter from `listSweepParameters`, range/step, replications → line chart of chosen metric(s) with min–max band, click a point to apply that value to the current layout; (3) results kept in memory per session.
* `report.js` — `exportReportHtml(ctx) → string` / download: self-contained HTML (inline CSS, layout PNG as data-URL, assumptions tables for stations/flows/fleets, KPI tables, insights, optional comparison results; print-friendly); `exportLayoutPng`, `exportLayoutJson` helpers.

### 6.7 App shell & main — `js/ui/app.js`, `js/main.js`, `index.html`, `css/` (owners: shell agents)
**Layout** (desktop): top bar — logo + project name (editable), scenario/variant tabs (A, B, + duplicate), undo/redo, Examples/New, Share, Export ▾, Help.
Left vertical toolbar — tool buttons grouped (Select/Pan · Roads: two-way, one-way, speed zone, erase · Stations: 5 types · Obstacle, Label, Flow) with tooltips showing shortcut.
Centre — canvas with floating **sim controls** (reset, play/pause, step, speed select, clock, "speed limited" hint) and overlay toggles (grid, flows, docks, heatmap off/traffic/waiting, labels), zoom controls, minimap-less. Status line under the canvas: cursor cell/metres, selection hint, tool hint.
Right panel with tabs: **Properties · Fleet · Flows · Simulate · Results · Experiments · Checks (badge)**. Tabs persist in `ui.rightTab`. The right panel collapses to a drawer on narrow screens (< 900 px); toolbar becomes a horizontal scroller at the bottom.
First visit: welcome dialog with examples. `#p=` share links load a project (confirm if the current one is dirty). Keyboard shortcuts as in §6.3 plus Space = play/pause, `.` = step, `+`/`-` = sim speed, `F` fit… (document final map in Help).
Accessibility: all controls are real buttons/inputs with `aria-label`/`title`; visible focus rings; colour is never the only signal; respects `prefers-reduced-motion`; dark mode via `prefers-color-scheme` and a manual toggle.

---

## 7. Visual design ("Lego baseplate for engineers")
Calm, precise, slightly playful. **Canvas:** light grey-blue baseplate with subtle studs in each cell; roads are dark plates with lane markings and chevrons for one-way; stations are
colour-coded **bricks** (top face + darker front edge + studs) with icon and name, a fill bar and a status dot; vehicles are small coloured bodies with a heading notch, a load box when
carrying, red outline when waiting in traffic, amber when broken, green bolt when charging. **Station colours:** source `#2f7df6`, process `#f5b82e`, storage `#f08a24`, sink `#3dbb6d`, depot `#8a63d2`.
Obstacles slate grey (walls hatched, racks with shelf lines). **UI chrome:** neutral surfaces, 8-px spacing grid, 1-px hairlines, rounded 8-px cards, accent `#2f7df6`; light and dark themes via CSS custom properties in `css/tokens.css`
(`--bg --surface --surface-2 --border --text --text-dim --accent --good --warn --bad` …) which the canvas theme (`js/ui/theme.js`) mirrors. System font stack, tabular numbers for KPIs.
Status colours used consistently everywhere: busy/ok green, starved amber, blocked/waiting orange, down/error red, idle grey.

## 8. Quality gates
* `npm run test:quiet` (unit + integration), `npm run check` (imports), `npm run test:e2e` (Playwright, headless Chromium, screenshots in `e2e-output/`).
* Simulation invariants that integration tests assert on every example and on random layouts: no overlapping vehicles; load conservation
  (`created = live + completed + consumed-by-processes` bookkeeping holds); buffers never exceed capacity or go negative; sim time monotonic; same seed ⇒ identical KPIs; no `NaN` anywhere in a `KpiReport`; vehicle state shares sum to 1.
* No console errors/warnings in the browser during a full session (load → edit → run → compare → export).

## 9. Deployment
`.github/workflows/pages.yml`: on push to `main`, run tests, assemble `_site/` (index.html, css/, js/, assets/, docs not needed), deploy with
`actions/upload-pages-artifact` + `actions/deploy-pages`. Repo Settings → Pages → Source: **GitHub Actions**. All asset URLs relative so it works under `/<repo>/`.
