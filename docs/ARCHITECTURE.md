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
  helpers in `tests/helpers/`. Tests must be deterministic and fast (each file < 10 s; a slower one goes into a heavy shard of
  `scripts/test-tiers.mjs`, every other file is in the fast tier by default). Build test layouts with
  `tests/helpers/ascii.js` (`layoutFromAscii`) or the model API — never depend on `Math.random`.
* A change is only done when `npm run test:quiet` and `npm run check` pass.

## 2. Repository layout

```
index.html                  app shell (relative asset paths only!)
css/                        tokens.css, layout.css, components.css (+ print styles), guidance.css, impact.css, drawmode.css (the Draw switch of the stroke tools)
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
scripts/   serve.mjs (dev server), check-imports.mjs, test-tiers.mjs (fast / heavy test tiers for CI)
docs/      ARCHITECTURE.md (this file)
.github/workflows/          ci.yml (PR: check, fast and heavy shards in parallel), pages.yml (fast gate, then deploy to GitHub Pages; heavy shards beside it),
                            e2e.yml (browser tests, on demand and weekly)
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
resizeGrid(layout, cols, rows) → { removed: number } // drops/clips anything outside; clamps to GRID_LIMITS (320 x 320 cells since the plan grows, defaults.js)
setCellSize(layout, cellSize) → boolean
translateAll(layout, dx, dy) → boolean         // shift everything (used when growing the grid to the left/top)

// the plan grows with the work (js/ui/editor/grow.js decides how much, these do it)
growGrid(layout, { left = 0, top = 0, right = 0, bottom = 0 }) → { dx, dy, left, top, right, bottom, cols, rows }
   // adds cells on the sides and shifts everything by (left, top) with translateAll, so nothing is lost and the node order of the road graph (row by row)
   // is kept; clamped to GRID_LIMITS (left/top are served first); returns what was really added; dx = left, dy = top (the move of the content)
trimGrid(layout, { margin = 4 }) → { changed, dx, dy, left, top, right, bottom /* cells removed: <= 0 */, cols, rows }
   // shrinks to contentBounds + margin, never below the minimum size, never drops anything; an empty plan is left alone.   trimmedSize(layout, opts) = the same without doing it
contentBounds(layout) → { x, y, w, h } | null    // box around roads, stations, obstacles and labels (a label = the cell of its anchor)
```
Growing is translation: the same plant on a bigger baseplate simulates **identically** (KPIs, heat and poses equal up to float rounding of about 1e-16; tests/sim.largegrid.test.js).

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
  nodeIndex: Int32Array /* node id → position in `nodes` (compact index), -1 if not road */, baseCost: Float64Array /* default search cost per edge */,
  edgeToK, edgeRev: Int32Array, outStartK: Int32Array /* flat copies of the links for the search; the exits of compact node k are edges outStartK[k] .. outStartK[k+1]-1 */,
  search(from, { arrivalEdge = -1, cost = null }) → Search,
  path(from, to, opts) → Route | null,
  scc: Int32Array /* strongly-connected component per node, -1 if not road */, sameScc(a, b)
}
Edge   = { id, from, to, dir, length /* = cellSize */, limit /* min(limit(from), limit(to)) */, rev /* opposite edge id or -1 */ }
Search = { dist(node) → cost | Infinity, routeTo(node) → Route | null }
```
**Size.** The cell-indexed members (`isNode`, `out`, `in`, `limit`, …) are dense (one slot per grid cell, O(1) lookup by node id). A **search** costs time and memory in proportion to the ROAD graph only
(its road cells + links, about 90 ns per road cell and link in Node): results are kept per compact node, the Dijkstra buffers (tentative edge costs, heap) are reused, nothing is sized by the grid. So are the search budget and the route cache
(`routing.js`: `searchBudget`, `RouteCache` capacity), which makes a plant behave the same whatever room is left around it (the 320 x 320 baseplate costs nothing but its own dense arrays, a few MB).
Measured (Node, one core): Two lines on a 320 x 320 baseplate runs 8 000 – 16 000 x real time; a plant that fills it (16 000 road cells, 300 stations, 50 vehicles) builds in 90 – 150 ms.
```js
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
traffic.reroute(tv, route) → boolean     // give a DRIVING vehicle another way on from a cell it has not reached (late dock choice): `route` is the complete new route, it keeps the old edges up to
                                         // the cell where the two part, which must lie beyond the braking distance + 2 cells (else false, nothing changed); no U-turn there; locks on cells the new route does not use are let go
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
Unreachable flows never get assigned (the UI lists them via `validateLayout`). Which dock of the station a vehicle drives to is decided by the **dock book** (below), not by route cost alone; the dispatcher ranks vehicles
by the route cost to the cheapest dock (unchanged), the leg planned afterwards (`planLeg`) picks the dock.

**Dock book** (`js/sim/logistics/docks.js`, `logistics.docks`, one `DockBook` per Logistics). Every dock cell has an *occupant* (the vehicle standing on it - loading, unloading, about to start, idle, broken - or still pulling out of it) and FIFO *reservations*
(vehicles that planned a route to stop there: `vr.dock = { node, station, kind: 'pickup'|'drop'|'park'|'charge', service /* load/unload time + turnaround of the cell: 8 s at a dead end, 3 s on a through lane for the 1.2 m AGV, longer for longer vehicles */, eta, since, switches }`).
A reservation is made when a leg to a dock is planned, replaced when it is planned again (deadlock relocation), released on arrival (the vehicle becomes the occupant), when its order is given back, when the vehicle dies or is removed
(`logistics.removeVehicle(vr)`); that of a broken or dead vehicle stays but is ignored when estimating. `checkDockInvariants(lg)` (every reservation belongs to a vehicle that is on its way to a dock of that station, queued once; every such vehicle has one) holds on every tick.
*Choice:* among the docks the vehicle can reach and get back from (and, for a pickup, from which the drop can still be reached: `routes.dockChoices`) it takes the one with the smallest **cost** =
estimated time to start service (travel time (route cost / (top speed x 0.75)) + blocking delay (a stopped vehicle - docked, idle, broken, a long vehicle's overhung junction lock, or a reservation that gets to a dock cell on the way before this vehicle passes - holds it up until it has gone, but not one in the other lane of a two-way road: this is how docks lined up on one lane block each other)
+ wait (what the occupant still needs + the service of the reservations expected before it, in order of arrival; an idle vehicle that stays is expected to start making room when the first follower has waited `YIELD_AFTER` s)) + the **way out** (`DOCK_EXIT_WEIGHT` x the extra route of a dock that lies farther than the nearest choice).
A wait for a dock whose approach cell is a junction (a spur of one cell off the main road) is spent on the junction and counts `DOCK_BLOCK_WEIGHT` (2) x; the cheapest-route dock is only left for a gain of more than `DOCK_MIN_GAIN` (3 s). Ties: cheaper route, then lower node id. A station with one usable dock is not evaluated; a vehicle that stands on a dock keeps it.
A vehicle **longer than a cell** whose choice includes a dock that hangs on a spur of one cell (it would overhang the junction in front of the dock and hold its lock) keeps to the old rule - nearest dock, no switching on the way (`overhangs`, `overhangRule`): spreading such vehicles over the docks of a comb jammed the main road (72 comb plants of tuggers and forklifts: without the rule 5 are >10 % worse and 4 gridlock, with it none, 25 % more loads overall; the validator already warns `vehicle-longer-than-cell`).
*Late rebinding:* a vehicle still driving looks again every 2 s from the first cell of its route beyond its braking distance + 2 cells and switches (via `traffic.reroute`, no U-turn) when another dock's cost (as above) is lower by more than max(8 s, 25 % of its own), at most once per approach.
`logistics.docks.enabled = false` restores the old static ranking (cheapest returnable dock) - for comparisons and regression tests. Per (station, dock) counters `visits`, `busy` (s a vehicle was *served* on the cell: loading, unloading, pulling out), `held` (s an idle, broken or dead vehicle only stood on it), `wait` (vehicle-s that a vehicle with a reservation stood
in a queue behind a vehicle on a dock of the same station) feed the KPIs. Looking never changes anything: `refreshOccupants` / `status` (called by the renderer) only read the vehicles; the simulation forgets `vr.leaving` itself at the start of every tick (`forgetLeavers`).

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
      produced, consumed, arrivals, yardMax, yardNow, breakdowns,
      docks: [{ node, cx, cy, visits /* services started there */, busyShare /* of the window a vehicle was served on the cell */, heldShare /* of it an idle / broken vehicle only stood on it */, waitBefore /* veh·s queued for it */ }],
      dockWaitTotal /* veh·s vehicles queued for a dock of the station */, dockSkew? /* one dock does the work, another hardly any, vehicles wait: { busy, quiet[], reason: 'trap'|'lane'|'detour', waitPerVisit } */ } },
  fleets: { [fleetId]: { name, count,
      utilization /* 1 - idle/parked/charging-share: time spent working */,
      shares: { driving, waiting, loading, unloading, idle, parked, charging, broken },    // fractions of vehicle-time, sum to 1 (±1e-6)
      trips, vehicleTrips /* { [vehicleId]: trips in the window } */, tripsPerVehicleHour, distance /* m total */, distancePerVehicle, emptyShare /* empty/total distance */,
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
**Resources that are not used** (window ≥ 20 min, thresholds named at the top of the file; `fleet-no-jobs` needs no window): `fleet-no-jobs` (a fleet that no flow may use: the plant has flows and every one is restricted to
another fleet, so its vehicles stand idle however much work there is; it replaces `fleet-oversized` for such a fleet, and the fleet strip shows the badge "no jobs"), `fleet-unused` (a fleet makes < 0.3 trips per vehicle and hour although other vehicles carried ≥ 3
loads on the flows it may serve too and no load waits for a vehicle: "The other vehicles already cover every job. Remove them, or give them their own flows under Fleet → Jobs this fleet
serves."), `vehicle-idle-some` (some vehicles of a busy fleet make < 20 % of the average trips of their fleet-mates), `source-unconnected-activity` (a goods-in whose yard grows because no flow
leaves it) and `station-never-used` (a destination that received nothing in 15 min although the supplier produced loads and the vehicles have time: "Nothing reaches X - check the road to it"; a supplier that is a storage
with a dwell of half the window or more is skipped, nothing could have left it yet).
They never contradict the older rules: an unused fleet is not also oversized or told to get a spare, a saturated fleet is not told to add vehicles while another fleet that may do the same jobs
hardly works, and an unconnected goods-in is not also "delivering more than the plant takes".
**Docks:** `dock-bottleneck` (a station whose docks are *in service* ≥ 60 % of the time on average (loading, unloading, pulling out - not an idle vehicle that merely stands there) while vehicles queued ≥ 8 s per visit for them: "Vehicles queue at X: its only dock is busy 87 % of the time and vehicles waited 4 min. Add a second dock - any road cell touching the
station - or a bypass bay."; silent for docks that are balanced and idle), `dock-idle-vehicles` (the same queue, but the docks are in service < 60 % of the time and idle vehicles that stay on the road stand on them ≥ 25 % of it: "Set the fleet to Park in depot") and `docks-unbalanced` (one dock takes ≥ 75 % of ≥ 20 visits while another gets ≤ 15 % and vehicles wait ≥ 5 s per visit - only said with the reason `stations[].dockSkew.reason`: a trap, docks lined up on one lane, a detour).
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
        overlays: { grid, studs, flows, docks, jobs /* default on */, heat: 'off'|'traffic'|'waiting', ids, labels }, rightTab, theme: 'auto'|'light'|'dark', followSim?,
        warmRestart /* boolean, default true, saved with the other prefs: pre-roll the simulation after an edit, see 6.4 */ },
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
                  { kind:'obstacle', rect, valid }, paintPreview: null | { cells:[[cx,cy]…], oneWay, dir? }, flowPreview: null | { fromId, toPoint:[x,y] } | { toId, fromPoint:[x,y] },
                  marquee: null | rect, resizeHandles: boolean, connectHandle: null | { id, hover?, pressed? },
                  connect: null | { role: 'from'|'to', anchorId, valid: Set<id>, exists: Set<id>, over, overStatus, snap, verb },
                  extension: null | { left, top, right, bottom /* cells the plan would gain */, ok, limited, hint }, extendChips: boolean, extendHover: null | 'left'|'top'|'right'|'bottom' }
renderer.simShift = { dx, dy } | null   // cells the plan's content has moved since renderer.sim was built (it grew on the left or top): the vehicles are drawn and hit that far along; the layers that read the
                                        // simulation's own geometry (heat, job lines, dock marks, deadlock rings) are left out until the replacement simulation arrives (set by the runner)
renderer.resize()                       // call on container resize (handles devicePixelRatio)
renderer.render(alpha)                  // draw a frame; alpha ∈ [0,1] interpolates vehicle poses between ticks
renderer.hitTest(px, py) → { kind: 'station'|'obstacle'|'label'|'flow'|'vehicle'|'connect-handle'|'extend'|'cell', id?, cell:[cx,cy], handle?: 'n'|'ne'|…|'move' }   // 'connect-handle' only while view.connectHandle is set; 'extend' (id = the side) only while view.extendChips is on
renderer.toDataURL(opts) → string       // PNG of the whole layout (offscreen, ignoring camera) for reports
```
Visual spec (§7). Perf: static layer (baseplate, roads, obstacles, labels) cached on an offscreen canvas and redrawn only when layout/theme/zoom bucket changes; per frame draws stations' dynamic parts and vehicles. ≥ 60 fps with 100 vehicles.
Station/flow/vehicle visuals read the runtime fields of §5.3; the renderer must also work with `sim = null` (editing mode shows the layout alone).

### 6.3 Editor — `js/ui/editor.js` (owner: store agent)
Translates pointer/keyboard input into store commits and `renderer.view` updates. `new Editor({ canvas, store, camera, renderer, ctx })`, `editor.setTool(name)`, `editor.startConnect(opts)`, `editor.destroy()`.
Tools (shortcut): `select` (V), `pan` (H; also Space-drag / middle mouse / two-finger touch), `road` (R, two-way), `oneway` (O), `speedzone` (Z, option: factor),
`erase` (E), `source`/`process`/`storage`/`sink`/`depot` (1–5), `obstacle` (W, option kind), `label` (T), `flow` (F).
* **Road/one-way/eraser/speed zone** (`editor/roads.js`, `editor/strokes.js`): press-drag with a live preview, committed on release as **one** undo step; `oneway` links follow the drag direction. How the stroke follows the pointer is the **draw mode** (`ui.toolOptions.drawMode`, saved with the UI preferences, default `smart`; the "Draw: Smart | Straight | Free" control over the plan, shown with these four tools):
  **smart** = straight by intent: an axis (H or V) is picked once the pointer is 1 cell from where it was pressed and the stroke runs along it to the pointer's projection; a **turn** (one corner at the projected cell, then the other axis) happens only when the pointer is `TURN_THRESHOLD` = 2 cells or more off the line (a finger needs at least 28 px, `turnThreshold`), so a wobble never makes a jog; moving back along the stroke retracts it, also through corners; fast jumps are interpolated in steps of 0.5 cell.
  **straight** = hold Shift (or choose it): one straight line from the start, the axis locks at 1.5 cells and never flips. **free** = every cell the pointer visits, gaps filled with `lPath`. Shift pressed or released mid-stroke continues in the other mode from the current end. Shift+click (no drag) draws an L-shaped line from the end of this tool's previous stroke to the clicked cell (hovering with Shift previews it; undo, Esc, another tool and a plan change forget the start). Alt = erase. Blocked cells stop the stroke with a red tail. The preview (`view.paintPreview`) carries `label` (length near the pointer, "24 m · 12 cells") and, for a locked straight line, `guide` (axis and start cell, drawn across the plant).
* **Station tools:** hover shows a ghost (green valid / red invalid); click places a default-size brick; press-drag sizes it. Select tool: drag to move (snap to grid, invalid = red ghost, release on invalid = cancel),
  drag edge/corner handles to resize, Delete removes, arrow keys nudge, Ctrl/Cmd+D duplicates.
* **Flow tool:** click source station then destination station ⇒ `addFlow`; Esc cancels; invalid pairs show a toast-style hint via `ctx.toast`. Valid receivers glow while a sender is chosen (`view.connect`).
* **Connecting without the Flow tool** (`js/ui/editor/connect.js` rules, `connector.js` behaviour): a selected Goods in / workstation / storage shows a round **flow handle** (`view.connectHandle`, hit as `'connect-handle'`) just outside the edge that faces its nearest valid destination; dragging it to a station adds the flow (undo label `Connect A → B`, new flow selected, toast), a plain click starts connect mode, Esc cancels. `editor.startConnect({ fromId } | { toId })` starts the same click mode for any station (the toast after placing a station calls it from its **Connect** action); it switches to Select. `view.connect = { role, anchorId, valid: Set, over, overStatus, snap, verb }` makes valid stations glow, the rest recede and labels the one under the pointer; `view.flowPreview` is `{ fromId, toPoint }` or, when the anchor receives, `{ toId, fromPoint }`.
* **Eraser:** drag over cells removes road cells, obstacles and labels there (stations only via selection + Delete). **Speed zone:** paints `limit`.
* **The plan grows with the work** (`editor/grow.js`, pure and unit-tested in tests/ui.editor.grow.test.js; `render/extend.js` draws it). The baseplate is made of **blocks of 8 cells** (`GRID_BLOCK`), at most 320 x 320 cells (`GRID_LIMITS`).
  A **road / one-way stroke, a brick placed, sized, moved or resized, a label** may reach beyond an edge: the pointer keeps working outside the baseplate (pointer capture; `p.ux/uy/cx/cy` are real, kept within a window the plan could ever grow into) and the tool reports what it touches with `ed.showGrowth(extent)`.
  `planGrowth(grid, extent)` gives whole blocks per side that hold the extent plus one spare cell (limit-aware: a stroke that runs into the largest plan stops at its edge with a message; an edit that needs more room than there is, or left + right together too much, is refused with the toast "The plan cannot grow beyond 320 × 320 cells."); the renderer shows the added ground as a translucent block with a dashed outline and "+8 columns" (`view.extension`),
  and the status line says "The plan grows by 8 columns on the right." On release `ed.commitGrow(label, extent, (draft, shift) => …)` is **one** `store.commit` (label unchanged: "Draw road", "Move station") that calls `growGrid` and then the edit, so one undo takes both back. `shift` = `{ dx, dy }` is how far the content moved (left / top growth): tools add it to the coordinates they took from the pointer (`shiftRect`, `shiftCells`).
  **The view stays:** the shift is noted on the new layout (`noteGrowth`), and the editor moves the camera by the same distance on the commit and, from the notes, on undo and redo (`contentShift`), so nothing moves on screen; the Properties buttons and the chips note their shift the same way.
  Rules: eraser, speed zones and flow-handle drags never grow the plan; with the pointer **inside** the baseplate an item being moved or resized may not stick out (red ghost, "Move the pointer past the edge to extend the plan.").
  **Auto-pan:** during a road stroke, a brick sized, moved or resized, a pointer within 24 px of (or beyond) the edge of the canvas pans the view, 60 → 900 px/s growing with the square of the proximity, until it leaves the zone (`autoPanVelocity`; handlers opt in with `autoPan()`).
  **Edge chips:** with Select and the drawing tools (not eraser, slow zone, pan, flow), while the mouse is over the canvas (always on a touch screen), each edge of the baseplate shows a faint strip (28 – 40 px, outside the plan) with a round **+** chip in the middle of the visible part of the edge; hovering previews the block, a click / tap extends by one block ("Extend plan", one undo step, `view.extendChips`, hit as `'extend'`). Hidden below 2 px per cell, for a plan under 100 px on screen, while an edit shows its block, and where the chip would not fit into the window.
  Keyboard route: Properties > Plant settings > Grid and scale has **Extend the plan by 8 cells** (Left, Up, Right, Down) and **Trim to content** ("48 × 32 → 40 × 24 cells, 80 × 48 m"), each undoable; the status line always shows the plan size.
* Wheel = zoom at cursor, drag with pan tool/Space/middle = pan, double-click empty = fit. Esc = cancel current gesture / clear selection. Ctrl/Cmd+Z / Shift+Z / Y = undo/redo.
* All gestures work with touch (pointer events, `touch-action: none` on the canvas; two-finger pan/pinch). While a tool gesture runs the editor sets `data-gesture` on the canvas (`syncView`); css/layout.css uses it to fade the card of an empty plant (`.stage__empty`, which sits in the middle of the plan and lets pointer and wheel through to the canvas, only its buttons take the pointer).
Every layout change goes through `store.commit` with a clear human label ("Move station", "Draw road") — these appear in the undo tooltip.

### 6.4 Runner — `js/ui/runner.js` (owner: store agent)
Owns the live `Simulation` and the `requestAnimationFrame` loop.
```js
createRunner({ store, renderer, onFrame? }) → runner
runner.sim: Simulation|null     runner.playing: boolean     runner.speed: number (sim seconds per real second)     runner.limited: boolean (true when it cannot keep up)
runner.play(), runner.pause(), runner.toggle(), runner.step(seconds = 1), runner.reset(), runner.setSpeed(x)   // speeds 1,2,5,10,30,60,120,300,600,1200
runner.on(event, fn) → off     // 'state' (play/pause/reset/speed), 'frame' (every rAF, throttled stats at ~4 Hz as 'kpis'), 'rebuild', 'baseline', 'error'
runner.priming: boolean   runner.primeProgress: 0..1   runner.warm: { preRoll } | null   runner.baseline: { report, simTime, labels, edits, layout, control, after } | null   runner.keepBaseline()   runner.dismissBaseline()
```
Behaviour: the sim is built lazily on first play/step; **structural** layout changes (via `layoutChangeKind`) replace the sim (keeping the playing state) after a 250 ms debounce;
**runtime** and **cosmetic** changes never replace it (runtime ones call `sim.setRuntime`). Per frame: `target += min(realDt, 0.1) * speed`; `sim.advance(target - sim.time, { maxMillis: 10 })`; `limited` when it falls behind; `alpha` for interpolation.
Pauses automatically when the tab is hidden. Exposes `runner.kpis()` (cached 250 ms) and `runner.insights()`.
**Warm restart** (`store.ui.warmRestart`, default on). Replacing a simulation that has already run (`time > 0`) because of an edit (commit, undo, redo) does not start from an empty plant: the new
Simulation is pre-rolled silently by `primeSeconds(warmup)` = clamp(warm-up + 10 min, 10 min, 40 min), in slices of `sim.advance(…, { maxMillis: 12 })`, one slice per animation frame, and swapped in at once;
meanwhile the old simulation stays on screen and stands still (`runner.priming`, `primeProgress`; the sim bar chip says "Updating…"). Another edit during priming restarts it from the newest layout;
a hidden tab does not prime; `destroy()` ends it. The pre-roll depends only on layout and seed (the engine steps whole ticks), so it is deterministic. `reset()`, the first `play()` of a plant, loading another plant
and switching variants stay **cold** starts from an empty plant at 0:00. `'rebuild'` carries `{ reason: 'create'|'structural'|'reset', sim, warm, label, labels, previous?: { report, simTime }, baseline, paired, warmedUp, warmupLeft }`
(`paired`: the baseline holds the fair old-versus-new figures; `warmedUp: false` with `warmupLeft` seconds when the new simulation is still in its warm-up after the swap, which the toast says).
**Bounded in wall-clock time:** each pre-roll phase stops after `PRIME_MAX_MS` (4 s) of frames that actually primed (a hidden tab does not count) and swaps in with what is done (`warmedUp: false` if that is still inside the warm-up); a plant that is
too big for the pre-roll therefore freezes the old simulation for 4 s at most per phase instead of for as long as it takes. `primeProgress` covers both phases; the sim bar chip shows it in steps of 20 % once the pre-roll has taken 600 ms.
Measured cost of the pre-roll (real headless Chromium on a shared, busy machine; ranges over several runs of tests/e2e/edit-feedback.mjs `perf`, the first priming after loading the page is the slowest): Starter 16–115 ms in 1–3 frames,
Congestion lab 90–260 ms in 5–10 frames, Two lines 105–340 ms in 5–11 frames (the engine alone needs 70–380 ms in Node for the 1200 s: 90–140 ms once warm), a 160 × 160 plant with 100 vehicles (48 stations, 4031 road cells)
0.9–1.0 s in 42–47 frames in the page and 0.6–1.2 s in Node (building the Simulation is one synchronous call of 60–90 ms). Edit to swapped-in simulation, debounce included: 0.3–0.6 s on the examples, 1.2–1.4 s on the big plant.
The slowest animation-frame callback while priming was 16–28 ms on Two lines and 30–38 ms on the big plant (p95 15–19 ms), and no long task over 50 ms was reported; "1–3 frames" holds only for the Starter.
**The plan grows while it runs.** Growing or trimming the plan on its left or top moves everything on it (`growGrid` / `trimGrid` note the move with `noteGrowth`, the editor moves the camera by it). The displayed simulation still stands in the old coordinates for the debounce and the pre-roll
(0.3 to 1.4 s measured), so the runner adds up the moves it sees since that simulation was built (`runner.simShift`, `contentShift` of editor/grow.js on every commit, undo and redo; reset by a replacement, a load or a variant switch) and tells the renderer (`renderer.simShift`):
the vehicles stay on their roads (the first version drew them 8 cells off for those frames). Growing on the right or below moves nothing and needs no shift. tests/e2e/roads-canvas-combined.mjs `running` samples every frame.
**Baseline.** When a warm restart replaces a simulation that had measured ≥ 10 minutes, that simulation's last KpiReport becomes `runner.baseline.report` with the labels of the edits and `layout`, the plant it describes; further warm restarts keep the
ORIGINAL baseline and only add labels, until `keepBaseline()` (the plant on screen, as it is now, becomes the reference, no labels; it returns false and leaves everything as it was while a replacement is being pre-rolled or the run is not yet reliable) or
`dismissBaseline()`. Every cold start clears it.
**The fair comparison** (`baseline.control` = `{ window, report, runtime }` and `baseline.after` = `{ window, report }`). The long cumulative report of the old run cannot be set against the first 10 minutes of a new run (run-to-run noise of 10–35 % in a figure, measured; a rename
read "worse"). So after the pre-roll of the new plant the runner pre-rolls the OLD plant (`baseline.layout`, i.e. the layout the displayed simulation was built from, with the what-if settings of the new plant so that only the edits differ) to the same measured window, with the same seed:
`control` is its report, `after` the new plant's, both over the same `window` (600 s with the default warm-up). A change that cannot matter reads exactly ±0. The control depends only on the old plant, the window and the what-if settings (`runtime`), so consecutive edits reuse it unless a what-if was moved in between (one
extra pre-roll for the first edit, none for the next ones); it costs about as much as the pre-roll of the new plant (Two lines: edit to swapped-in simulation 0.5–0.7 s for the first edit of a baseline, 0.35–0.4 s after; the big plant 1.1 s, 1.7 s with the control). A failure or a timeout of this
second phase costs the comparison (`paired: false`, no card figures, the card says why), never the restart; a new plant that is still in its warm-up at the swap has no window to compare.

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
  At the top, `panels/impact.js` mounts the **"Effect of your change"** card while `runner.baseline` has edits: six figures (throughput, mean lead time, work in progress, fleet utilization, time waiting in traffic, deadlocks)
  as the OLD plant (`baseline.control`) → the UPDATED plant (`baseline.after`) over the same measured window and seed (see 6.4), with a `.delta--good/--bad` chip (direction from `METRICS[].better`; neutral inside a noise band per figure,
  set just above the noise measured on 450 paired runs: throughput 15 % and at least 2 loads, lead time 8 % and at least 3 loads on each side, work in progress 8 %, waiting in traffic 4 points, any change of the deadlocks; never for utilization),
  an honesty line ("Indicative: one run per plant, so small differences are not coloured") in a polite live region, the window, a note when nothing changed beyond noise or when the updated plant finished no load (never a green figure for a plant
  that stands still; no verdict on traffic when nothing drove), and the buttons Keep as baseline (disabled while the next plant is being pre-rolled or the run is not reliable) / Compare properly… (adds `baseline.layout` as the variant "Before: …", ticked next to the
  current plant, and opens the Experiments tab; the running simulation is not touched) / Dismiss. Without numbers (still warming up, no pair) the card is its status line only. The same module's
  `createImpactHint` puts a one-line "Before → after" under the simulation bar (full text in its tooltip). `panels/fleet-status.js` is the live strip of a fleet card (working / waiting / idle / parked, trips so far, trips per vehicle and hour,
  lowest battery, a badge from the insights: "no jobs", "barely used", "some idle" or "mostly idle").
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

### 6.8 The shared `ctx` (assembled by `js/ui/app.js`, consumed by every panel, dialog and the editor)
```js
ctx = {
  store, runner, renderer, camera, canvas,
  toast(msg, { kind = 'info', ms = 3500, action: { label, onClick } = null } = {}),
  setStatus(text),                                  // status line under the canvas ('' clears)
  graph() → Graph,                                  // buildGraph(store layout), cached per layout identity
  issues() → Issue[],                               // validateLayout(layout, { graph }), cached per layout identity
  dialogs: {                                        // js/ui/dialogs.js  createDialogs(ctx)
    show({ title, body /* Node */, actions /* [{ label, variant, onClick, close? }] */, size: 'sm'|'md'|'lg' }) → { close() },
    confirm({ title, text, confirmLabel, danger }) → Promise<boolean>,
    prompt({ title, label, value, placeholder, confirmLabel }) → Promise<string | null>,
    openWelcome(), openHelp(), openShare(), openImportExport(),
  },
  actions: {
    fitView(),                                      // camera fits the whole layout
    focus({ stationIds, flowIds, fleetIds, cells }),// select + pan/zoom the canvas to the referenced things (used by Checks and Insights)
    setTool(name), setRightTab(name),               // 'properties'|'fleet'|'flows'|'simulate'|'results'|'experiments'|'checks'
    startConnect({ fromId } | { toId }),            // connect mode on the plan: click the other station (editor.startConnect); false when it cannot start
    loadExample(id), newProject(),                  // ask for confirmation when the project is dirty
    exportPng(), exportReport(), exportJson(), importFile(), shareLink(),
  },
}
```
Panels call only what is listed here (never reach into app internals), so each panel can be exercised in isolation with a harness `ctx`.

### 6.9 Guidance — coaching a first-time planner
Goal: someone who has never seen the tool can build a working plant without reading docs, and every "dead" configuration (a Goods-in nobody collects from, a station off the road, no vehicles) is visible **where the planner is working** and has a one-click fix. The model the UI must teach: *vehicles are not assigned to stations; flows say where loads go, and every free vehicle automatically serves every flow (nearest/oldest/balanced, per Simulate tab) unless a flow is restricted to one fleet.*
* `js/ui/guidance.js` (pure, Node-tested): `computeNextSteps(layout, { issues, simRunning, simulatedSeconds })` → ordered `NextStep[]` (`{ id, severity: 'todo'|'warn', title, text, refs, fix }`, `fix = { type: 'connect-flow'|'add-fleet'|'set-tool'|'focus'|'run', ... }`), `computeChecklist(layout, runnerInfo)` (getting-started steps with live done-state), `validDestinations(layout, stationId)` / `validOrigins(layout, stationId)` (stations a new flow may legally target, closest first), `suggestDestination(layout, stationId)`, `applyFix(ctx, fix)` (commits through the store with a clear label).
  *As built* (`js/ui/guidance.js`, UI in `js/ui/panels/nextsteps.js`, styles in `css/guidance.css`): `severity` is `'todo'|'warn'|'info'` (notes never block and are not counted as "steps to finish"); a step also has `scopes` (`'plant'|'flows'|'fleet'|'run'`, so the Flows and Fleet tabs show only their own), `icon` and `dismissible`; `fix.type` adds `'set-tab'` (`{ tab }`), `connect-flow` carries `pick: 'to'|'from'` (the end the planner chooses; `toId`/`fromId` hold the suggestion), `add-fleet` may carry `fleetId` (raise that fleet instead of adding one). `validDestinations`/`validOrigins` return station objects, `suggestDestination`/`suggestOrigin` a station object or `null`; `connectFixFor(layout, id)` is the ready-made fix for a toast's Connect action, `fixForIssue(layout, issue)` maps Checks issues to fixes. `guidanceFor(ctx)` holds what all surfaces share (dismissals in localStorage `logiplan:guidance-dismissed`, session progress: has it run, longest run, were the results opened) and a memoised `read(state)`. Suggestions in a list build on each other (a virtual flow per suggestion), so a fresh plant needs two Connect clicks, not four.
* UI surfaces: a **Next steps** card at the top of Properties / Flows / Fleet; a canvas **guide chip** ("2 steps to finish") that opens the same list; a dismissible **Getting started** checklist; **Fix** buttons on Checks issues; inline **Loads in / Loads out** sections in the station inspector with "Add destination"; fleet cards explaining which flows they serve; Help section "How vehicles find work".
* *As built, who serves which flow* (`js/ui/panels/jobs-info.js`, pure and Node-tested in `tests/ui.jobsinfo.test.js`; the drawing in `js/ui/panels/jobs-view.js`, driven by `tests/e2e/guidance-panels.mjs`): the station form of the Properties tab starts (under the header) with **Where do loads go?** and **Where do loads come from?** (non-collapsible; a row per flow with the station at the other end, the share in % and a weight stepper from two outgoing flows on, loads per cycle for a workstation, Flow settings, Remove; an "Add destination / Add origin" picker made of `validDestinations` / `validOrigins` + Connect that stays on the station, shown as a callout while the station has no flow; a depot gets a note instead). Each fleet card has **Jobs this fleet serves** (the model in two sentences, "4 flows share these 2 AGVs", the flows it may serve split into Any fleet / Only this fleet with an "Only this fleet" switch that sets `flow.fleetId`, warnings for a dedicated flow whose fleet has no vehicles and for a plant without vehicles). Each flow card in the Flows tab has **Served by: any fleet (AGV ×2, Forklift ×1)** / **only AGV ×2**, the loads waiting and delivered from the runner's cached `kpis()` while a simulation exists, and the tab opens with a collapsible **How vehicles find work** (remembered in localStorage `logiplan:flows-explainer`). Help has a page `vehicles` ("How vehicles find work", an inline SVG diagram, the loop, docks, several Goods in, dedicating vehicles, priority/batch/capacity, what to do when loads pile up, the Jobs overlay); the welcome dialog shows one of three rotating tips per visit (`WELCOME_TIPS`, localStorage `logiplan:welcome-tip`). The old "Connected flows" section of the station form is gone: the two blocks replace it.
* Canvas: a **flow handle** on a selected station (drag from it to another station to create a flow), a toast with a **Connect** action right after placing a station, valid-target highlighting while connecting, a **Jobs** overlay (`js/ui/render/jobs.js`, `ui.overlays.jobs`: a dashed line from each vehicle with an order to the dock it is driving to, amber while it picks up and blue while it delivers, fading with distance, with a chip "→ Goods in 2" when zoomed in; and a badge "n waiting" on every station with loads ready and not yet claimed by a vehicle, red from 80 % of its output buffer; and, from 8 px per metre on, a small mark at the station edge of every dock cell: a hollow dot while the dock is free, a ring while a vehicle is on its way to it, a filled dot while a vehicle stands on it - `logistics.docks.status(node)`). The Results tab lists the docks of every used station (a bar for how busy each was, its visits, the time vehicles queued).

* *As built, after the first-time-planner walkthrough* (`tests/e2e/walkthrough.mjs`, which drives the real app with mouse, finger and keyboard only and counts the actions): one question is asked once, and the answer tells the planner what it means. Details:
  the place tool puts no ghost over the brick it just placed (a red "blocked" ghost looked like a failed placement; the ghost of a station carries the planner's word "Goods in", not "Source"); a click on a road says "Put it beside the road, not on it";
  the Properties card leaves out the `connect-out:<id>` / `connect-in:<id>` steps of the single selected station (the form asks the same question with the same picker, `hiddenInProperties`) and, while the Getting started list is on screen, the steps it mirrors (`no-road`, `place-stations`);
  after a flow is created by any route (handle, connect mode, Flow tool, toast, card, Checks, chip, Properties picker) the toast is `flowCreatedText(layout, flow)`: the usual sentence and, when the destination is a workstation with now two or more inputs, "<name> now needs a load from both of its inputs before every cycle" (the model starts a cycle only when every input has delivered); the Flow tool uses the same undo label `Connect A → B` through `connector.connectStations`; a Connect or Add vehicles button puts a placement tool down (`backToSelect`); the "Goods out placed. What feeds it?" toast closes once a flow answers it;
  `computeNextSteps` also names a flow dedicated to a fleet without vehicles (`no-carrier:<flowId>`, fix Add vehicles, `alt` fix `release-flow` = "Any fleet", scopes flows and fleet), does not say "Press play" while an error that no step names is open, and suggests "Open Results" only after warm-up + 5 measured minutes (`resultsAfter(layout)`);
  on a touch screen or a window under 640 px connect mode shows a persistent prompt toast with a Cancel button (no Esc key, the status line is cut off);
  the Help page and the workstation's inputs say that two Goods in feeding one workstation are both needed per cycle and that a Storage in between lets either one supply it.
  Measured on the Two-lines example (8 stations, 6 flows, 10 vehicles): `guidanceFor(ctx).read()` 0.2 ms median per store change (p95 0.3 ms), chip + card + list DOM update 0.1 ms, the shell's own `validateLayout` 2.4 ms; at 600x with 10 vehicles 60 fps with the Jobs overlay on and off, +0.0 to +0.1 ms per frame (median) for the overlay.

## 7. Visual design ("Lego baseplate for engineers")
Calm, precise, slightly playful. **Canvas:** light grey-blue baseplate with subtle studs in each cell; roads are dark plates with lane markings and chevrons for one-way; stations are
colour-coded **bricks** (top face + darker front edge + studs) with icon and name, a fill bar and a status dot; vehicles are small coloured bodies with a heading notch, a load box when
carrying, red outline when waiting in traffic, amber when broken, green bolt when charging. **Station colours:** source `#2f7df6`, process `#f5b82e`, storage `#f08a24`, sink `#3dbb6d`, depot `#8a63d2`.
Obstacles slate grey (walls hatched, racks with shelf lines). **UI chrome:** neutral surfaces, 8-px spacing grid, 1-px hairlines, rounded 8-px cards, accent `#2f7df6`; light and dark themes via CSS custom properties in `css/tokens.css`
(`--bg --surface --surface-2 --border --text --text-dim --accent --good --warn --bad` …) which the canvas theme (`js/ui/theme.js`) mirrors. System font stack, tabular numbers for KPIs.
Status colours used consistently everywhere: busy/ok green, starved amber, blocked/waiting orange, down/error red, idle grey.

## 8. Quality gates
* `npm run test:quiet` (unit + integration; the same files as `npm run test:fast` + `npm run test:heavy`, which CI runs as parallel jobs), `npm run check` (imports), `npm run test:e2e` (Playwright, headless Chromium, screenshots in `e2e-output/`).
* Simulation invariants that integration tests assert on every example and on random layouts: no overlapping vehicles; load conservation
  (`created = live + completed + consumed-by-processes` bookkeeping holds); buffers never exceed capacity or go negative; sim time monotonic; same seed ⇒ identical KPIs; no `NaN` anywhere in a `KpiReport`; vehicle state shares sum to 1.
* No console errors/warnings in the browser during a full session (load → edit → run → compare → export).

## 9. Deployment
`.github/workflows/pages.yml`: on push to `main`, job `verify` (import check, fast test tier, assemble `_site/` (index.html, css/, js/, assets/, docs not needed), upload with
`actions/upload-pages-artifact`), then job `deploy` (`actions/deploy-pages`, needs `verify` only, skipped when a newer commit is already on the branch). The heavy test tier runs beside the deploy
(one job per shard) and turns the run red if it fails, without holding the deploy back: the pull request has already passed it (`ci.yml`). Repo Settings → Pages → Source: **GitHub Actions**. All asset URLs relative so it works under `/<repo>/`.
