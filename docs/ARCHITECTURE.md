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
CHANGELOG.md                what changed, for planners (Keep a Changelog; shown in the About dialog, copied into the site, see 6.11)
css/                        tokens.css, layout.css, components.css (+ print styles), guidance.css, impact.css, drawmode.css (the Draw switch of the stroke tools)
js/
  main.js                   bootstrap: build store, sim runner, UI; handle #share links
  version.js build-info.js update-check.js     the version of the running copy, the changelog parser and the "newer build is live" check (DOM-free, see 6.11)
  util/    grid.js rng.js ids.js format.js dom.js                      (done)
  model/   defaults.js (done) layout.js validate.js serialize.js examples.js
           schema.js ops.js calendar.js extensions.js doors.js validate-ops.js        (the seams of optional features, see 3.1; trucks and dock doors, see 4.10)
  sim/     graph.js traffic.js logistics.js stats.js insights.js engine.js experiments.js
           detail.js                                                                 (the OPTIONAL collector behind sim.detail: statistics of one vehicle, station, flow or cell; a second seam, see 3.1 and 5.8)
  store/   store.js
  ui/      theme.js icons.js camera.js renderer.js editor.js runner.js app.js
           dialogs.js dashboard.js charts.js compare.js report.js about.js (version chip and About dialog)
           panels/ inspector.js fleet.js flows.js simulate.js checks.js
           day-plant.js guidance-ops.js report-ops.js ops-styles.js render/ops.js panels/ops-trucks.js timetable-dialog.js plant-clock.js doors-card.js trucks-help.js   (trucks and dock doors, see 6.10)
tests/     *.test.js, helpers/ (ascii.js, golden.js …), fixtures/golden/ (the safety net: recorded KPI reports, legacy layouts, share links), fixtures/stats/ (answers of the detail collector for fixed runs: the contract with the statistics panels, see 5.8), e2e/ (Playwright, run by hand: npm run test:e2e)
scripts/   serve.mjs (dev server), check-imports.mjs, test-tiers.mjs (fast / heavy test tiers for CI), rebaseline-golden.mjs (re-records tests/fixtures/golden), perf-baseline.mjs (CPU seconds per simulated hour), build-site.mjs (assembles the site and writes its identity, see 6.11 and 9), bump-version.mjs (cuts a version, `--check`)
docs/      ARCHITECTURE.md (this file)
.github/workflows/          ci.yml (PR: check, fast and heavy shards in parallel), pages.yml (fast gate, then deploy to GitHub Pages; heavy shards beside it),
                            e2e.yml (browser tests, on demand and weekly)
```

## 3. Layering & dependency rules

```
util  ←  model  ←  sim  ←  store?  ←  ui  ←  main
```
* `model` imports only `util`. `sim` imports `util` + `model/defaults.js` (+ `model/layout.js` for `normalizeLayout`).
* **The pure model modules of optional features** (the warehouse module, docs/WAREHOUSE-DESIGN.md): `model/schema.js`, `ops.js`, `calendar.js`, `extensions.js`, `doors.js` and, in later
  milestones, `rack.js`, `loadtypes.js`. They are pure functions of plain JSON (sanitizers, `schemaNeeded`, the clock, the door check, timeline and rack mathematics), import only `util`, `defaults.js` and each other
  (`schema.js` → `defaults.js`; `ops.js` → `util`, `defaults.js`; `calendar.js` → `ops.js`; `extensions.js` → `calendar.js`, `schema.js`; `doors.js` → `util`, `ops.js`) and **never `layout.js`**, which imports them. `sim` may therefore import them too (the simulation
  and the UI derive capacity, clocks and geometry from the same code) without pulling in the mutators. The one model module that may import `layout.js` is `model/validate-ops.js` (the plan checks of the warehouse module and the data of their Fix buttons), which `validate.js` calls.
  The sim-side runtime of a feature lives in its own file (`sim/logistics/trucks.js`, `staffing.js`, `racks.js`, … and `sim/stats-ops.js`, `insights-ops.js`), created only for stations that use it.
* **The version modules** (6.11) sit beside `util`, outside the layers: `js/version.js` and `js/build-info.js` import nothing, `js/update-check.js` imports only those two, and all three are DOM-free and importable from a bare Node process. Nothing in `util`, `model`, `sim` or `store` imports them, so the layers below the UI never see the version; the only importers of the build identity are `ui/about.js`, `ui/report.js` and `update-check.js` (`ui/app.js` and `ui/dialogs.js` use `ui/about.js`). Guarded by `tests/version.review.test.js` 11.2 and 11.3.
* `store` imports `model` (+ `util`). It never imports `sim` or `ui`.
* `ui` may import everything below it; `ui` modules never import `main.js`. `sim` never imports `ui` or `store`.
* Layout objects are **plain JSON** (structured-cloneable). Consumers treat a layout as an immutable snapshot; the store
  replaces `state.layout` with a new object on every commit, so caches keyed on object identity (WeakMap) are valid.

### 3.1 Extension seams (milestone M0 of the warehouse module)
An optional feature (trucks and dock doors, shifts, racks, load types …) is added **beside** the core, never into it: absent means today, a plant that does not use a feature behaves bit for bit as before
(guarded by the golden tests, `tests/sim.golden.*.test.js`, and by `scripts/perf-baseline.mjs`). M0 put the seams in once, in the hot files, so that later milestones add files, not edits. Every seam is inert until a feature fills it.
* **Data.** A feature's keys live in `station.ops` (after `params`), `layout.calendar` / `layout.loadTypes` (after `settings`), `fleet.calendar`, … : **sparse** (a key exists only when it differs from "feature off", an empty block is removed), **appended**
  (so legacy files and share links stay byte-identical) and **owned** by one pure module with `sanitize*` / `merge*` functions that drop unknown keys, clamp numbers and never throw. Registries a milestone adds to:
  `OPS_SANITIZERS` in `ops.js` (per station type: `(raw, current?)` → block or `undefined`; `current` is the block before a merge), `EXTENSION_BLOCKS` in `extensions.js` (top-level blocks, called by `normalizeLayout` through `normalizeExtensions`), `OPS_KEYS` / `CALENDAR_KEYS` (the documented keys, which drive the
  round-trip tests). `updateStation(layout, id, { ops })` merges through `mergeOps` (plain objects merge key by key at every depth, so a patch of only `interArrival.mean` keeps the kind and the spread; arrays and scalars replace; `null` removes; a present but junk value keeps the CURRENT value, like `params`), `duplicateStation` copies `ops`, `checkInvariants` demands that an `ops` block is a fixed point of its sanitizer.
* **Schema.** `layout.schema` is the **lowest version that can express the layout** (`schemaNeeded` in `schema.js`; legacy = 1 and stays 1). `normalizeLayout` stamps it, `checkInvariants` demands exactly it (and that every optional block, today `calendar`, is a fixed point of its sanitizer and exists where a timetable implies it), and the store rolls back an edit that breaks it, so **a mutator that adds or removes persisted extension content must end with
  `reconcileLayout(layout)`** (`extensions.js`: it re-derives, in place and only where something changed, the optional blocks that other content implies, as `normalizeLayout` does, and the stamp; later `pruneRefs`). `updateStation` (for `ops`), `addStation` (it accepts `ops`), `duplicateStation` (a copy of a station with `ops`), `updateCalendar`, `removeStation` (so also `resizeGrid`), `removeFleet` and `removeFlow` do;
  the shift mutators of M2 and `applyFleetPatch`/`applyFlowPatch` for the fleet and flow keys of M2, M3 and M5 have to. This is enforced, not remembered: `tests/model.reconcile.test.js` fails on any exported function of `layout.js` that is not classified (reader or mutator; the table is `tests/helpers/layout-mutators.js`),
  and drives every mutator at random through the real store with stand-in sanitizers, checking after each edit that the layout is valid and agrees with `normalizeLayout` on stamp, calendar and `ops`; `tests/model.ops-trucks.test.js` does the same with the real sanitizers and demands that `normalizeLayout(layout)` is the layout, byte for byte. `exportProject` stamps the project with the highest schema of its layouts, `importProject` warns when a file is above
  `SCHEMA_MAX` (the highest row this build implements: raise it in the milestone that adds the row). `migrate(raw)` is the reserved identity hook that runs before sanitizing. `SCHEMA_VERSION` (defaults.js) stays the base schema.
* **Simulation.** Fixed shapes, present but unread: loads carry `ty, tk, at, slot` (-1 / 0 = none), orders `pickAt, dropAt, pickExtra, dropExtra`, every `StationRT` has `trucks, rack, cal` (null) and **one** accessor `st.capacity` (= `params.capacity` for a storage, `undefined` otherwise;
  M3 derives it for racks) that `state`, `fill`, `fillLabel`, `flowSpace`, `flowCapacity`, the dispatcher's batch limit and the jobs overlay (`render/jobs.js bufferSize`, which falls back to `params.capacity` for a plain stand-in) read. The readers at LAYOUT level (they see a layout station, not a `StationRT`) are
  `model/validate.js` (the buffer between two stations, the smallest limit on a flow, `storage-small`), `ui/report.js` (`stationParams`), `sim/insights.js` and `sim/experiments.js` (the capacity sweep); M3 routes them through one pure helper next to the rack mathematics. A ledger test (`tests/sim.seams.test.js`) fails when a new `params.capacity` read appears. `Logistics.ext` is `null` unless a layout uses a feature, and `Logistics.clock` is `null` without `layout.calendar`.
* **KPIs.** `Stats` has five call sites for an extension: `_build` creates `stats.ext = logistics.ext.stats(stats)` (once, with typed arrays) when `logistics.ext` exists, and `reset`, `sample`, `onEvent` and `report` call `ext.reset()`, `ext.sample(dt)`, `ext.onEvent(name, payload)` and
  `ext.report(report)`, which adds `report.ops`. Without an extension that is one pointer test per call and the report has no `ops` key.
* **Checks and findings.** `validateLayout` calls `validateOps(ctx, add)` (`model/validate-ops.js`, list `OPS_CHECKS`) after its own checks; `generateInsights` runs `EXTENSION_RULES` (insights.js) after its own rules. `OPS_CHECKS` holds the four checks of trucks and doors since M1 (4.10) and `EXTENSION_RULES` its five insight rules (5.7).
* **Test helpers.** `tests/helpers/logistics-invariants.js` and the auditor of `tests/helpers/engine-review-gen.js` count the loads that trucks hold (`st.trucks.gate[].pending`, `docked[].pending`, `staged`) as live and present, and both ask `st.capacity` for the capacity of a storage; `tests/helpers/golden.js` and `tests/fixtures/golden/` hold the safety net
  (`node scripts/rebaseline-golden.mjs` re-records it, and a pull request that does so must say why).
* **Detail collector** (entity statistics, docs/ENTITY-INSIGHTS-DESIGN.md; a second seam, separate from `stats.ext`). `js/sim/detail.js` records what the KPI report cannot give for ONE item (the cells a vehicle drove, where it queued, its time split, the yard wait of a pallet, 30-minute windows). It is **optional and off**: `sim.detail` is `null` until the UI calls
  `sim.enableDetail()`; headless runs, experiments, sweeps, the paired control run and the tests never do. Three small seams in the core and nothing else: `Simulation.step` calls `detail.afterTickSafe(dt, fresh)` after `stats.sample` when `sim.detail !== null` (one pointer test per tick without a collector; it never throws, and a collector that failed is dropped with `sim.detailError`
  set while the run goes on), `TrafficSystem.waitNodeOf(tv)` (the cell a vehicle's waiting is booked on, which `_bookkeep` itself uses) and two `export` keywords in `insights.js` (`fleetWaitShare`, `congested`: the one source of "more vehicles do not help"). The collector only reads (public fields, the event bus), uses no random numbers and mutates nothing, so `kpis()`, `report()` and every recorded result
  stay byte-identical (`tests/sim.golden.detail.test.js`, `tests/sim.detail.fingerprint.test.js`). Two ledgers in `tests/sim.seams.test.js` keep the seam honest: only `detail.js`, `engine.js`, `ui/runner.js`, `ui/panels/stats-*.js` and `ui/render/routes.js` may touch `.detail`, and the 70 or so simulation internals it reads are listed with a probe on a live plant (a change of one fails a named test). See 5.8.

---

## 4. Domain model — the Layout

`js/model/defaults.js` is authoritative for defaults. A complete layout:

```js
{
  schema: 1,                                          // the lowest version that can express the layout (3.1); every legacy plant is 1
  name: 'Untitled plant', notes: '',
  grid: { cols: 48, rows: 32, cellSize: 2 },        // cellSize = metres per cell edge (0.5…10)
  roads: { 'cx,cy': { out: 0b1111, limit?: 0.1..1 } },
  obstacles: [{ id, x, y, w, h, kind: 'wall'|'rack'|'column' }],
  labels:    [{ id, x, y, text, size? }],            // x,y in cells (may be fractional)
  stations:  [Station], flows: [Flow], fleets: [Fleet],
  settings:  Settings,
  // optional, sparse, appended after `settings` and absent on a legacy plant (3.1): calendar { startTod, startDay } (M1, 4.10), loadTypes (M5)
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
{ id: 's1', type: 'source'|'process'|'storage'|'sink'|'depot', name, x, y, w, h /*cells*/, params: {…}, ops?: {…} /* warehouse options, sparse, after params (3.1); M1: ops.trucks on source and sink only (4.10) */ }
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
(`sim.setRuntime`); everything else in a layout requires rebuilding the simulation. With a clock (`layout.calendar`, 4.10) the time of day at simulation time 0 is `startTod`, which is the start of the warm-up, and the KPI window begins at `warmup`; "Run one day" sets `duration` 86400 and `warmup` 0 (6.10).

### 4.6 `js/model/layout.js` — API (owner: model agent)
Pure functions; mutators edit the layout passed in **in place** (the store passes them a cloned draft) and keep the invariants of §4.1–4.3.
```js
createLayout({ name?, cols?, rows?, cellSize? }) → Layout                     // = emptyLayout + overrides
normalizeLayout(raw) → Layout            // tolerant import: migrate(), fill defaults, clamp numbers, drop dangling refs,
                                         // repair road links/overlaps, dedupe ids, never throws on junk (throws only if raw isn't an object);
                                         // stations keep `ops` through sanitizeOps, optional blocks come from normalizeExtensions, `schema` = schemaNeeded(layout)
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
addStation(layout, { type, x, y, w?, h?, name?, params?, ops? }) → Station|null     // rejects overlaps/out-of-bounds; unique id ("s1"…); name "Source 2" style unique; `ops` is sanitized as in a loaded file (a type without options drops it) and reconciled
moveStation(layout, id, x, y) → boolean       resizeStation(layout, id, rect) → boolean       // reject if blocked; roads under the new rect are NOT silently deleted: reject
updateStation(layout, id, patch) → boolean    // shallow merge; `params` merged one level deep; clamps/validates; `ops` merged key by key at every depth by ops.js (`null` removes; reconcileLayout re-derives layout.schema and the implied blocks)
removeStation(layout, id) → boolean           // cascades: removes its flows, clears fleet.home refs; reconcileLayout (stamp, implied blocks)
duplicateStation(layout, id, { dx = 1, dy = 1 }) → Station|null          // copies params and ops
addFlow(layout, from, to, patch?) → Flow|null // validates §4.3 rules; null on duplicate/invalid
updateFlow(layout, id, patch) → boolean       removeFlow(layout, id) → boolean  // reconcileLayout
addFleet(layout, preset = 'agv', patch?) → Fleet                 updateFleet(layout, id, patch) → boolean (battery merged)
removeFleet(layout, id) → boolean              // clears flow.fleetId refs; reconcileLayout     duplicateFleet(layout, id) → Fleet|null
updateCalendar(layout, patch) → boolean        // the clock of a day plant (4.10): { startTod, startDay } merge key by key and create the clock; `null` removes it unless a timetable needs it (then it is reset to 00:00 Monday); false for a patch that is neither an object nor null; reconcileLayout
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
`one-way-dead-end`, `fleet-count-zero`, `duplicate-names` (info). Each issue has a stable `id` (code + ref) so the UI can keep dismissed state. The checks of optional features are in `model/validate-ops.js`, called once at the end (3.1; trucks and doors: `doors-too-few`, `doors-exceed-docks`, `docks-share-lane`, `timetable-empty`, 4.10).

### 4.8 `js/model/serialize.js` (owner: model agent)
```js
exportProject(project) → string       // JSON of { app:'logiplan', schema, name, active:index, scenarios:[{ id, name, layout }] }; schema = the highest of the layouts (1 for every legacy plant)
importProject(text) → project         // accepts a project export OR a bare layout JSON; normalizes; throws Error with a friendly message on junk; `warnings` when a schema is above SCHEMA_MAX (schema.js)
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

Since milestone M1 the catalogue holds two more, both with trucks (schema 2, no clock), listed after the three legacy ones: **`dock-lab`** "Dock lab: one street, three docks" and **`warehouse-first-day`** "Warehouse: first day"
(docs/WAREHOUSE-DESIGN.md 8.1). They are built through the same mutators, validate with no issue at all, and their numbers were calibrated on the built plants (`tests/sim.examples.warehouse.test.js` reproduces every number a tip quotes:
means of seeds 1 to 5 over the default run of 8 simulated hours). `buildDockLab(variant)` is exported: variant `'bays'` is the example (Goods in with three docks, each at the end of its own side road), variant `'row'` is the same plant after the edit that its notes describe
(the three side roads erased, Goods in dragged down onto the street, so its seven docks lie in a row on one lane: the first takes about 97 % of the visits and Checks says `docks-share-lane`). `buildWarehouseFirstDay()` is a small pallet warehouse whose four forklifts, not its three doors,
set how long trucks wait (more doors move the queue from the gate to the doors, a fifth forklift empties the gate). **The three legacy examples are the safety net**: tests that mean "the plants that must never change" take them through `legacyExamples(EXAMPLES)` (`tests/helpers/golden.js`, ids in `LEGACY_EXAMPLE_IDS`),
and `rebaseline-golden.mjs` records no fixture for the others.

### 4.10 Trucks and dock doors (milestone M1): data, helpers, checks (owner: model agent)
Design: docs/WAREHOUSE-DESIGN.md 5.3, 6.2, 6.3, 7.2, Appendices A and B. Trucks are **events**, never vehicles on the road grid; a door is a **count**, not a road cell.

**Data.** `station.ops.trucks` on a Goods in (`source`) and a Goods out (`sink`); any other station type drops `ops`. A block that exists stores every field (this table is `OPS_KEYS` in `ops.js`, which also holds a valid sample and clamping cases per key and drives the round-trip tests):

| key | range, default | meaning |
|---|---|---|
| `doors` | int 1..32, 2 | truck positions |
| `checkIn`, `checkOut` | whole s 0..7200, 300 | time at the door before the pallets are released / after the last pickup |
| `mode` | `'rate'` \| `'schedule'`, `'rate'` | generate trucks from a rate, or follow a timetable |
| `interArrival` | Dist, mean 60..1,000,000 s, `{ normal, 2700, 0.3 }` | rate mode: time between trucks |
| `pallets` | Dist, mean 1..200, `{ uniform, 24, 0.25 }` | pallets per truck (a draw is rounded and kept in 1..200) |
| `schedule` | at most 500 rows `{ at, pallets }`, `[]` | `at` is a time of day (whole seconds 0..86399; `"HH:MM"` text is read), sorted by `at` (stable); `pallets` a whole number 1..200 or `null` = draw from `pallets`; an unreadable `at` drops the row, an unreadable `pallets` becomes `null`; the first 500 valid rows are kept |
| `jitter` | whole s 0..7200, 0 | a scheduled truck arrives at `at` +- uniform(jitter) |
| `noShow` | 0..0.5 (4 decimals), 0 | chance that a scheduled truck does not come |
| `maxDwell`, `staging` | whole s 0..86400, 3600; int 0..50, 4 | Goods out only (kept but ignored on a Goods in) |

`layout.calendar = { startTod, startDay }` (`startTod` whole s 0..86399 or `"HH:MM"`, `startDay` int 0..6, 0 = Monday) is appended after `settings`. A clock **exists** when the raw layout has one or when a station runs `mode: 'schedule'` (the sanitizer creates `{ startTod: 0, startDay: 0 }`); nothing removes it by itself (the planner's start time survives a switch back to rate mode), `updateCalendar(layout, null)` does when no timetable needs it (`usesTimetable(layout)` in `calendar.js` is the model-level test for "a timetable needs the clock"). A **day plant** (cold restart in the runner, no impact card) is, until M2 gives other things a reason for a clock, a plant with a clock AND a truck timetable: that is the one definition `isDayPlant` in `ui/day-plant.js` (6.10), and a clock left behind when the last timetable went back to rate mode does not make the plant one; the panel that switches the last timetable back removes a clock that still has its default start in the same commit, so the plant is stationary (warm restart, impact card) again. M2 needs a model-level definition when other stations use the clock. Schema: a layout with `ops.trucks` or a `calendar` is **2** (`SCHEMA_MAX` = 2), a legacy layout stays 1. `demandFactor` scales the truck frequency in rate mode and the pallets per truck in schedule mode (appointments do not move).
`mergeOps` merges plain objects at every depth: `{ trucks: { interArrival: { mean: 2400 } } }` keeps the kind and spread, a list (`schedule`) replaces, `null` removes a key (the sanitizer then fills the default), `{ trucks: null }` removes the block. **A value in a patch that is present but junk keeps the CURRENT value of that field** (`{ trucks: { doors: 'many' } }` on 5 doors stays 5, a junk `schedule` does not wipe the timetable, `updateCalendar(layout, { startTod: NaN })` keeps the start time): the convention of `mergeParams` and of the top of `layout.js` - an editor that commits NaN or `''` while the user clears a field must not reset the setting. The sanitizers take the block before the merge as an optional second argument (`sanitizeOps(type, raw, current)`, `sanitizeCalendar(raw, layout, current)`); a file has no current block, so there junk takes the default. A number out of range is clamped, it is not junk.

**Where the code is.** `ops.js` (sanitizer, `OPS_KEYS`, `TRUCK_DEFAULTS`/`defaultTrucks`, `trucksOf`, `timeOfDay`), `calendar.js` (`sanitizeCalendar`, `mergeCalendar`, `CALENDAR_KEYS`, `makeClock`, `formatTimeOfDay`, `usesTimetable`), `doors.js` (below), `validate-ops.js` (checks and Fix data), `ui/panels/timetable-paste.js` (the pure paste parser). Mutators that can change derived state end with `reconcileLayout`: `updateStation` (ops), `addStation` (ops), `duplicateStation`, `removeStation`, `updateCalendar`; `tests/model.ops-trucks.test.js` proves `normalizeLayout(layout)` is the layout after every mutator, through the real store with undo and redo.

**`doors.js`** (pure; imports `util` and `ops.js`):
```js
convertToDoors(station | type, params? | params, type?, options?) → trucks block | null   // (a station, then options; a type name, its params, then options; or the params of a Goods in alone) "Add dock doors" (6.3.1; option `shippedPerHour`: a Goods out gets trucks that carry what the plant shipped in the last run instead of 48 an hour); Goods in: P = 24 pallets, gap = P x g / b (kind and spread of the old Dist kept), never below 600 s (then P = ceil(600 x b / g)), 2 doors, 300/300 s; Goods out: 24 pallets / 30 min
describeTrucks(trucks, { demandFactor? }) → { mode, doors, palletsPerTruck, gapSeconds|null, trucksPerHour, palletsPerHour, rows }
dockDoorsToast({ name, type?, trucks, before? }) → string       // copy 1 of 7.6
doorCheck(trucks, { demandFactor?, tPallet?, measuredDoorSeconds? } | null) → { mode, empty, doors, trucksPerHour, pallets, tPallet, basis: 'assumed'|'measured', checkIn, checkOut,
  doorSeconds, doorHours, needed, utilisation, tooFew, suggestedDoors, suggestedUtilisation, suggestionEnough, parts, sentences, text, action: null | { label: 'Use 6 doors', doors: 6 } }
doorCheckText(check) → { parts, sentences, text }               // copy 2 of 7.6
peakRowsPerHour(rows) → number                                  // most rows in any sliding hour (cyclic, half open [a, a + 3600))
truckGap(rng, trucks, demandFactor) → s | Infinity              // rate mode: sampleDist(interArrival, 1 / demandFactor)
drawPallets(rng, dist) → whole 1..200      scalePallets(pallets, demandFactor) → whole >= 1, or 0 when the factor is 0
expandScheduleDay(trucks, clock, dayIndex, rng) → [{ at, pallets, noShow, row }]   // 6.2.6: one clock day of a timetable as simulation times, sorted; a row that needs randomness gets a stream of its own, rng.fork(`day:at:n`), and draws no-show, jitter (always both) and then pallets
expansionTime(trucks, clock, dayIndex) → s                      // when the run has to expand that day (its midnight less the jitter)
```
`needed = peakTrucksPerHour x doorHours` (Little's law, A.1); `ASSUMED_UNLOAD_PER_PALLET` = 90 s; a measured mean door time (docking to the door being free again, check-in and check-out included) replaces `checkIn + pallets x tPallet + checkOut`. `tooFew` from 95 % utilisation (`DOORS_TOO_FEW_UTILISATION`: the queue grows without bound before 100 %, A.1: 5 doors at 98 %); `suggestedDoors` is the fewest doors at most 85 % busy (`DOOR_TARGET_UTILISATION`; 4.9 needed gives 6, 82 %). The button `action` exists only where it ends the warning: when even 32 doors (the most a station can have) would stay above 95 % (`suggestionEnough` false) there is no "Use 32 doors" and the text says "Even 32 doors ... would be busy N % of the time: fewer or smaller trucks ... are the way out". `null` or junk options mean no options. The clock (`calendar.js`): `makeClock(layout.calendar)` → frozen `{ startTod, startDay, tod(t), day(t), dayIndex(t), dayStart(k), label(t) }` with `c(t) = startTod + t`; `label` is `"Mon 06:42"`.

**Checks** (`validate-ops.js`, only for stations that have `ops.trucks`, ref = station id, all warnings): `doors-too-few` (the door check says tooFew, with the plan's `settings.demandFactor`; the message says "needs about 4.9 doors busy at once ... but it has 4" while the doors are fewer than needed, and "keeps its 5 doors busy 98 % of the time" between 95 and 100 % busy), `doors-exceed-docks` (more doors than road cells touch the station; a station with no dock has `station-no-dock` instead; "Add dock doors" still gives a one-dock station like the Starter 2 doors, because one door would make its 10 minutes of check-in and check-out dead time for the only dock and saturate it, so the planner sees this warning, which says what the second door does and does not do), `docks-share-lane`, `timetable-empty`. Their Fix is data: `opsFixFor(layout, issue)` → `{ type: 'update-station', stationId, patch, label, undoLabel }` (Use N doors, Add a row at 06:00 with 24 pallets) | `{ type: 'extend-docks', stationId, count, label, undoLabel }` | `{ type: 'focus', refs: { stationIds, cells }, label: 'Show docks' }` (the existing fix type), and `applyOpsFix(draft, fix)` performs the first two inside one `store.commit` (`extendDockRoad(layout, stationId, wanted)` paints the free cells of the station edge next to existing docks, two-way).
**Docks share a lane** (`dockLanes(layout, station)`): take one side of the station, the strip of cells that touch it. Two neighbouring cells of the strip belong to a lane when both are road cells and the road is connected between them (a link either way: two one-way stubs side by side are not one road). A dock lane is a maximal run of such pairs (two or more cells). Docks that are not neighbours (side roads, the "bays" of the Dock lab) never share a lane; the corner cells are not docks; each side is separate. This is the dock book's blocking rule (`docks.js`: a stopped vehicle holds up the vehicles behind it in a single lane) seen from the plan. **A second road behind the docks does not end the lane** (the first version of the rule said so, "and the cells on their far side are not road cells"): the routes are shortest paths and the dock book never prefers a farther dock, so with six docks in a row (3 simulated hours, a pallet every 14 s, 8 forklifts, seed 3) the first dock took all 465 visits with nothing behind, 202 of 202 with a parallel road joined to every dock cell and 372 of 372 with one joined at its ends (`tests/m1.model.review.test.js`, M1-MODEL-REV-3). A rule that stayed silent there would tell the planner the docks are fine while five of them stand idle; the way out is a side road of its own for each dock. The insight `docks-unbalanced` uses the same chain (`insights.js quietDocksInRow`), so the finding and the Checks tab say "one lane" together.

**Paste** (`ui/panels/timetable-paste.js`, no DOM): `parseTimetable(text)` → `{ rows: [{ at, pallets|null, line }], skipped: [{ line, text, reason, message, code }], header, separator, omitted }`, `rowsOf(result)`, `summarizeTimetable(result)` (copy 5 of 7.6), `parseTimeField`, `parsePalletsField`. Rules: separator tab, else semicolon, else comma only when every data line has exactly one comma outside quotes and is not itself a decimal number; times `H:MM`, `HH:MM` (either with seconds that are zero: `06:00:00`), `HH.MM` (two digits before and after the point), `HHMM` (four digits), a trailing `h` or `Uhr` ignored (`6.30 Uhr` also reads with one digit before the point, a bare `6.30` or `0.25` does not: Excel's day fraction is refused with a hint, never read as 00:25), 12-hour times with a colon and AM/PM (`6:00 AM`, `12:00 AM` = midnight); pallets whole 1..200, `24,0` and `24.0` accepted, `24,5` and `1.000` refused, an empty cell means `null`; the first non-empty line without a digit is a header; empty lines are skipped (line numbers still count them); more than two columns is refused; the first 500 good rows are kept and ONE skipped entry (`code: 'too-many'`) reports the rest. The parser applies nothing: the dialog applies `rowsOf(result)` on "Use N rows".

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
**Loads/WIP.** `Load = { id, createdAt, origin, readyAt, claimed, ty, tk, at, slot }` (the last four are seams of the warehouse module, 3.1: `0, -1, -1, -1` and unread). Created by sources (`createdAt = t`) and by process output (`createdAt` = the
**oldest** input's `createdAt`, so lead time is end-to-end). Consumed by processes (inputs vanish at cycle start; WIP counts them as in-process) and by sinks.

**StationRT** (all types): `id, type, def, state, fill /* 0..1 */, fillLabel /* e.g. "3/8" */, inCount, outCount, produced, consumed, arrivals,
inQ: Map<flowId, Load[]>, outQ: Map<flowId, Load[]>, inbound: Map<flowId, number> /* space reserved by orders en route */, capacity /* getter: the ONE answer to "how many loads can this storage hold" = params.capacity today */,
trucks, rack, cal /* null: seams of the warehouse module */`. `Logistics` also has `ext` and `clock` (null; 3.1). Type specific:
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
* **sink:** consumes arriving loads instantly; emits `'loadCompleted'`. A Goods in / Goods out with `ops.trucks` has `st.trucks` (a `TruckDesk`, 5.7) and follows the rules there instead: the legacy arrival loop does not run, and a Goods out loads trucks.
* **depot:** `parked: VehicleRT[]`, `charging: VehicleRT[]`; `slots`, `chargers`.

**Orders & dispatch (demand-driven, global greedy matching).** A flow has *demand* when `available(flow)` (unclaimed loads in `from.outQ[flow]` that are ready)
and `space(flow)` (at `to`: sink ∞; process `inCap − queued − inbound` per flow; storage `capacity − held − all inbound`) allow a transport of
`qty = min(vehicle.capacity, batchMax || ∞, available, space) ≥ batchMin` (or `qty ≥ 1` once the oldest load waited ≥ `maxWait`). Every 0.5 s of sim time and on
relevant events, build all (idle-or-parked vehicle, flow) candidate pairs where the fleet is allowed by `flow.fleetId`, the pickup dock is reachable and the drop
dock is reachable from the pickup dock; sort by **priority desc**, then by strategy score —
`nearest`: pickup route cost (m, then oldest age); `oldest`: oldest-load age desc (then nearest); `balanced`: `cost − 0.5·age(s) ` —
and assign greedily; each assignment *claims* the loads and *reserves* `inbound` space immediately, so later pairs see reduced availability/space.
`Order = { id, flowId, from, to, qty, vehicleId, loads, createdAt /* assignment time */, readySince, pickedAt, deliveredAt, pickAt, dropAt, pickExtra, dropExtra }` (the last four: seams, `-1, -1, 0, 0`).
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
`orderDelivered {order, waitForPickup, transit}`, `machineDown`, `machineUp`, `vehicleDown`, `vehicleUp`, `vehicleDead`, and, for a Goods in / Goods out with trucks (5.7), `truckArrived`, `truckTurnedAway`, `truckNoShow`, `truckDocked`, `truckReady`, `truckDeparted`.

### 5.4 `js/sim/stats.js` and `js/sim/insights.js` (owner: stats agent)
`Stats` *samples* simulation state each tick (reading the public fields documented above) and listens to events; it never mutates the sim.
```js
new Stats(sim)                  // sim exposes { time, layout, graph, traffic, logistics, settings }
stats.sample(dt)                // called once per tick, after traffic.step
stats.onEvent(name, payload)    // called by the engine for every emitted event
stats.reset()                   // start a fresh measurement window now (engine calls it when time reaches settings.warmup)
stats.ext                       // null, or the extension object of the optional features (3.1): reset / sample / onEvent / report hooks; `report.ops` exists only then
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
  ops?: { trucks: { [stationId]: TruckKpis } },   // only for a layout with trucks (5.7); a legacy report has no `ops` key at all
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
**Trucks and dock doors** (milestone M1) add `report.ops` (only for a plant with trucks) and five rules through `EXTENSION_RULES` (`gate-queue-long`, `doors-bottleneck`, `unload-limited-by-vehicles`, `doors-idle`, `outbound-short`, in `insights-ops.js`, 5.7); the older `supply` rule skips a Goods in with trucks and `docks-unbalanced` says "one lane" for a row of docks of such a plant.
**Entity statistics** (docs/ENTITY-INSIGHTS-DESIGN.md, S1) change two lines of `insights.js`: `fleetWaitShare(f)` and `congested(ctx, f)` are exported, so that the fleet question of the Statistics dock and the `fleet-saturated` insight use ONE test for "more vehicles do not help" (the parity test is in `tests/sim.seams.test.js`). `Stats` and `kpis()` are untouched: nothing in them reads the optional detail collector (5.8); a window figure of one road cell (`Stats.cellStats`) is step S2.
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
sim.detail                                  // null, or the optional detail collector (5.8); sim.detailError: why it was dropped (an Error) or null
sim.enableDetail(opts?) → Detail            // idempotent; sim.disableDetail() lets go of it and of its listeners (sim.dropDetail() is step()'s)
```

### 5.6 `js/sim/experiments.js` — headless runs (owner: engine agent, wave 2)
```js
runSimulation(layout, { duration?, warmup?, seed?, onProgress?, signal?, yieldEveryMs = 30 }) → Promise<KpiReport>   // never blocks the UI > ~30 ms; honours AbortSignal
runReplications(layout, { replications = 3, seed0?, ...opts }) → Promise<{ runs: KpiReport[], summary: { [metricId]: { mean, sd, min, max } } }>
METRICS = [{ id, label, unit, better: 'higher'|'lower'|null, digits, get(report) → number|null }]   // flat comparable numbers: throughput/h, mean & p95 lead time, WIP, fleet utilization (mean), vehicle wait share, empty share, deadlocks, max source backlog, bottleneck utilization …
// M1 adds `gateWaitMean`, `gateWaitP90`, `doorUtilization` (a percentage, weighted by doors) and `trucksShort`: all null for a report without `ops.trucks`
summarizeReport(report) → { [metricId]: number|null }
listSweepParameters(layout) → [{ key, label, unit, min, max, step, values /* suggested */, get(layout) → number, apply(layout, value) → Layout /* cloned */ }]
   // fleet count, fleet speed (per fleet and "all"), vehicle capacity, demand factor, process factor, machines per workstation, buffer capacities, roads' speed limit factor …
   // trucks (5.7): `doors:<station>`, `truckGap:<station>` (rate mode) and `palletsPerTruck:<station>` for a Goods in / Goods out with `ops.trucks`; they replace `station.<id>.interArrival` of a Goods in with trucks
sweep(layout, param, values, { replications, ...opts }) → Promise<Array<{ value, summary, runs }>>
compareScenarios(scenarios /* [{ id, name, layout }] */, { replications, ...opts }) → Promise<Array<{ id, name, summary, runs }>>
```

### 5.7 Trucks and dock doors (milestone M1): the simulation (owner: sim agent)
Design: docs/WAREHOUSE-DESIGN.md 6.2.6, 6.3, 6.8, 6.9; data and helpers: 4.10. Trucks are **events, never vehicles on the road grid**; a door is a **count** (`ops.trucks.doors`), not a road cell, and the dock cells and the dock book are untouched. The code is
`js/sim/logistics/trucks.js` (the runtime), `js/sim/stats-ops.js` (`report.ops.trucks`), `js/sim/insights-ops.js` (five rules) and three hooks. A station without `ops.trucks` has `st.trucks === null` and pays one pointer test per tick; a legacy plant runs bit for bit as before (golden fixtures, A1.1).

**Where it hooks in** (everything else is the unchanged legacy code): `Logistics` builds a `TruckDesk` per Goods in / Goods out with `ops.trucks` (`setupTrucks`, after the runtime settings and the clock exist; the block is sanitized again there, so a hand-made layout cannot put junk into a run), gives the plant `truckSeq` (ids of trucks) and `ext = { stats }`;
`stepStation` calls `st.trucks.step(st, t, lg)` instead of `stepSource` (so `nextArrival` stays infinite and `flushYard` is called by the desk); `flowSpace` / `flowCapacity` ask `st.trucks.room(st)` / `capacity()` for a Goods out with trucks (a **pull** destination); `acceptLoads` hands the delivered pallets to `st.trucks.receive`;
`finishLoading` tells `st.trucks.pickedUp(loads, t)` when a vehicle took pallets from a Goods in; `rescaleArrivals` (the demand slider) calls `st.trucks.rescale`; `StationRT.fill` / `fillLabel` of a Goods out show the staging space (`3/8`; nothing when the staging space is 0, not "0/0"); and the dispatcher's `collectDemand` clamps the minimum batch of a flow with `batchCeiling(flow, space, age)` (`stations.js`; only for a minimum above 1, Infinity between stations without trucks, so a legacy flow is untouched).

**A truck** (`Truck`, all fields present from the start): `{ id, at /* nominal arrival time */, plan, state: 'gate'|'checkin'|'work'|'checkout', door /* 0-based, the lowest free one, -1 at the gate */, dockedAt, releaseAt, freeAt, freedAt, left /* Goods in: pallets not picked up yet */, loaded /* Goods out */, closeAt, closing, pending[] }`.
**The desk** (`TruckDesk`, `st.trucks`): `role` ('in' | 'out'), `mode`, `doors`, `checkIn`, `checkOut`, `maxDwell`, `stagingCap` (= `staging x doors`, Goods out only), `gate[]` (FIFO), `docked[]` (in the order they docked), `staged[]` (Goods out: delivered pallets waiting for a truck), `due[]` (timetable), counters `arrived, nDocked, departed, short, noShow, turnedAway, planned, loadedTotal`, `doorsOpen()` (the count today; M2 makes it follow the clock).

**Goods in.** Arrive at the nominal time (applied on the first tick at or after it, like `stepSource`): the pallets are created now (`createdAt = at`, so the lead time includes the wait at the gate; each carries `tk`), the truck joins the gate. Dock while `docked.length < doorsOpen()`, FIFO. At the end of check-in the pallets go to `yardQ` and `flushYard` moves them into the output buffers (`params.outCap` per outgoing flow
is the staging space) as vehicles make room. **Unloading is emergent**: each pickup decrements `left`; at 0 the check-out starts, then the door is free. The Goods in is `blocked` while a docked truck's pallets wait in the yard. Guards: at most `GATE_LIMIT` (200) trucks at the gate, and the pallets that exist but are not picked up yet (on trucks at the gate or at a door, in the yard; not those already in the output buffers) stay below `YARD_LIMIT`; a further arrival is `truckTurnedAway` and creates no pallets.
**The minimum batch of a flow out of a Goods in.** A flow that waits for `batchMin` pallets (a tugger train that leaves full) would strand the last pallets of a truck: the batch can only be completed by a truck that has not docked yet, and that one cannot dock while the stranded remainder holds the door (with one door for good, with two when both remainders wait). So the dispatcher clamps the minimum batch with `batchCeiling` (`stations.js`) to `TruckDesk.supply(st, flow, age)`: while a door is free the batch keeps waiting for the next truck (trucks of one or two pallets and a batch of three still make full batches) but at most `BATCH_WAIT` (= `PRIORITY_AGING`, 15 min) after its oldest pallet was ready, so the last truck of a timetable does not keep its door all night; when every door is held the batch keeps waiting only as long as some truck at a door can leave without it (it is in check-in or check-out, or has pallets somewhere else: other flows, on their way to a drop, in the yard); when every truck at the doors waits for nothing but the unclaimed pallets of this flow, the remainder goes at once, as a smaller batch (`maxWait` > 0 did this after the wait before, and a legacy source needs none of it: its pallets keep coming). The pallets of trucks in check-in, in the yard and in the queue count as on their way. A truck at the gate does not.
**Goods out.** `room()` = free staging space + (`plan - loaded` of each truck at work that is not closing) - `inboundTotal` (pallets already on their way), never below 0; a truck in check-in does not count (the dispatcher is woken when it is ready), so with `staging 0` pallets are only fetched while a truck is ready. A delivered pallet is loaded onto the earliest-docked truck at work with room (that is the moment `completeLoad` runs: throughput, lead time and the conservation law keep their meaning), else it waits in `staged`
(`staged <= stagingCap`); a truck that finishes check-in takes up to `plan` staged pallets at once. A truck leaves when full, or `maxDwell` after check-in with what it has - but never while pallets are on their way (`inboundTotal > 0`): at `maxDwell` it is marked `closing`, stops counting in `room()`, and leaves when `inboundTotal == 0`. `maxDwell` 0 means until full. `flowCapacity` = `stagingCap + doors x` the largest plan, so a minimum batch bigger than any truck could take cannot starve the flow. **A plan that is not a multiple of the minimum batch** (22 pallets, `batchMin` 4) would leave the last 2 places of a truck unfilled for ever (the room of a truck at work only shrinks while it waits: with `maxDwell` 0 no truck would ever leave, otherwise every truck would leave short with the storage full of pallets and the finding about trucks that leave short would blame the vehicles), so `batchCeiling` also clamps the minimum batch of a flow into a Goods out to the space that is free now: the last places are filled by a smaller trip.
**How the trucks come.** *Rate mode:* the first truck at `params.startDelay` (Goods in) or after one gap (Goods out), then `truckGap` (a draw of `interArrival` divided by `demandFactor`) after each nominal arrival; pallets per truck are a draw of `pallets` (rounded, 1..200), so the slider scales the frequency, not the load. *Timetable:* each clock day (and at the start of the run) the rows of the timetable are expanded into a sorted due list (`expandScheduleDay`: a no-show draw, a jitter draw, a pallets draw for a `null` row; rows that lie before the start of the run are skipped, a jittered row is never earlier than time 0), merged with what is still due; every row that needs randomness has a STREAM OF ITS OWN (`rng.fork('day:at:n')`, `n` counting rows with the same time), whose first two draws are the no-show and the jitter whether or not the settings use them, so changing only the no-show chance, the jitter or the kind of the pallets distribution moves no other truck (experiments compare the same trucks), and a row added to the timetable leaves the others where they were; the pallets of a truck are multiplied by `demandFactor` when it arrives (`scalePallets`, at least 1, 0 = no truck): appointments do not move.
All draws come from forks of the station's stream (`st.rng.fork('trucks')`: the gaps of rate mode and, in a timetable, the forks of its rows; `'trucks:pallets'`: the pallets per truck of rate mode), so adding a truck station elsewhere never changes the arrival times of another one (A1.9), and the nominal times do not depend on `dt` (A1.8; the *application* of an event waits for the next tick, so a coarser `dt` waits up to one tick longer at every step: the mean gate wait of a loaded door differs by 0.5 % between `dt` 0.1 and 0.25, recorded in `tests/sim.trucks.test.js`).
`setRuntime({ demandFactor })`: rate mode keeps the pending arrival's place in the rescaled process (`remaining x old / new`, as `rescaleArrivals` does for a legacy source; the first truck of a Goods in is a fixed offset and does not move), from 0 it starts a fresh gap, to 0 nothing comes; a timetable needs no rescaling. Changing doors, check-in or the timetable rebuilds the simulation: `layoutChangeKind` calls any edit of `stations` or `calendar` **structural**; only the five `RUNTIME_KEYS` settings are runtime.

**Events** (payload always has `station`, `stationId`, `t` = the tick time that handled it): `truckArrived { truck, at }`, `truckTurnedAway { plan, at }`, `truckNoShow { row, at }`, `truckDocked { truck, door, wait }`, `truckReady { truck }` (check-in over: Goods in - the pallets went to the yard; Goods out - the truck is ready to be loaded),
`truckDeparted { truck, short, doorTime /* docked -> door free */, turnaround /* arrival -> door free */, gateWait }`.

**Invariants** (6.3.5, asserted on every tick of the fuzz plants by `checkTrucks` in `tests/helpers/logistics-invariants.js`; the helpers count pallets on trucks at the gate and at the doors (`pending`) and `staged` pallets as live and present): docked <= doors open; the gate is FIFO and in arrival order; a pallet is on at most one truck; `loaded <= plan`; `left` equals the number of the truck's pallets still in the station; `staged <= stagingCap`; the reservation invariant of a Goods out (the places promised to orders on their way, `inboundTotal`, are at most the free staging space plus the room of every truck at work, a closing one included) and `room()` equal to the free staging space plus the room of the trucks at work that are not closing, less `inboundTotal`, never below 0 (recomputed from the raw state: `room()` itself cannot fail a test that it is not negative); the door is held until the check-out after the last pickup / the last pallet / the end of the wait is over (a truck in check-out began it on the tick it is first seen in, took exactly `checkOut`, and a Goods in truck with no pallet left is in check-out, never at work); the counters add up (`arrived = gate + nDocked`, `docked = nDocked - departed`); door numbers are unique and below `doors`.

**`report.ops.trucks[stationId]`** (`stats-ops.js`, created through `Logistics.ext.stats(stats)` only for a layout with trucks; every number finite or null, never NaN):
```js
TruckKpis = { name, role: 'in'|'out', doors,
  trucks: { arrived, docked, departed, short, noShow, turnedAway },   // events in the window; `short`: Goods out trucks that left without a full load
  gateWait:   { mean, p90, max },            // s from the arrival to taking a door, per truck that docked in the window; null fields when none did
  doorTime:   { mean, p90 },                 // s from taking a door to the door being free again (check-in and check-out included), per truck that departed
  turnaround: { mean, p90 },                 // s from the arrival to the door being free again
  doorUtilization,                           // 0..1: door-seconds held / (doors x window)
  gateQueue:  { mean, max, now },            // trucks waiting at the gate: time-weighted mean, largest, right now
  doorsBusyNow,                              // trucks at a door right now
  fillRate,                                  // Goods out: pallets loaded / planned over the trucks that departed in the window; null on a Goods in, or before any truck left
  gateQueueSeries: [] }                      // mean gate queue per point of report.series (same length, also after the series is decimated)
```
Little's law holds in the numbers (A1.5): `doorUtilization x doors` = mean trucks at the doors = (`trucks.docked` / window) x `doorTime.mean` within 5 % over 8 h (`tests/sim.trucks.stats.test.js`). The window follows `settings.warmup`: `reset()` clears the counters and samples, never the trucks at the doors. Like every other KPI it also restarts whenever the number of vehicles changes (`Stats._stale`, legacy behaviour: a vehicle sold in the middle of a run starts a new window, `report.ops` included). The pickup wait of a Goods in with trucks (`flows[id].avgPickupWait`, one of the two pieces of evidence of the finding that the vehicles unload too slowly) starts when a pallet enters the output buffer, so the time it stood in the yard behind a full buffer is not in it; the blocked share of the Goods in is the other evidence and covers that time.

**Insights** (`insights-ops.js`, registered in `EXTENSION_RULES`, thresholds named at the top, each rule silent without `report.ops.trucks` and below three trucks): `gate-queue-long` (mean wait 15 min warning, 45 min critical; the wait is the larger of the mean of the trucks that docked and the Little estimate from the queue, so a queue that only grows is not hidden),
`doors-bottleneck` (doors busy >= 85 % and waiting >= 5 min, and the vehicles are not the limit), `unload-limited-by-vehicles` (the same symptom with evidence that pallets are taken away too slowly: the Goods in blocked >= 25 % of the time or pallets wait >= 2 min for a vehicle, and the verdict of the built-in transport rules is docks, traffic or vehicles: "the doors are not the problem, the vehicles are"; it replaces `doors-bottleneck`),
`doors-idle` (>= 2 doors, < 30 % busy, waiting < 1 min; info) and `outbound-short` (>= 10 % of the trucks left a Goods out short; the advice follows the transport verdict). On a Goods out `doors-bottleneck` adds that more doors only move the wait from the gate to the door when the trucks mostly wait for their pallets (the report cannot tell a door limit from a supply limit: it has no pallets-planned rate). They never speak twice about one station in contradicting ways and never produce a `good` insight. The older `supply` rule ("A delivers more than the plant takes") is not applied to a Goods in with trucks: a truck releases all its pallets into the yard at the end of check-in, so the yard of a healthy station is full while a truck is unloaded, and the rule fired at random with the instant of the report (`receivesTrucks` in `insights.js`); what a pile means for trucks is said by `gate-queue-long` and `unload-limited-by-vehicles`. The built-in `docks-unbalanced` finding names a row of docks "one lane" when the report has `ops` (`insights.js quietDocksInRow`, from the layout: neighbouring dock cells joined by road, as `dockLanes` in the plan check): the KPI report of the statistics keeps the word `detour` for such a row, because the golden fixtures and the pre-M0 digests pin it (`stations[].dockSkew.reason`). The thresholds that repeat those of `insights.js` are asserted equal by `tests/sim.trucks.insights.test.js`.

**Tests.** `tests/sim.trucks.test.js` (lifecycle on micro plants, A1.7, A1.8, A1.9, differential against the legacy source, runtime what-ifs, 24 h), `sim.trucks.stats.test.js` (report.ops, A1.5, metrics, sweeps), `sim.trucks.insights.test.js` (A1.12 sim part), `sim.trucks.perf.test.js` (A1.16), `sim.trucks.fuzz.test.js` (heavy: A1.3, A1.4, A1.8 and A1.9 on 200 random plants). Generators and helpers: `tests/helpers/trucks-gen.js`.

### 5.8 `js/sim/detail.js` — the detail collector behind `sim.detail` (owner: sim agent; docs/ENTITY-INSIGHTS-DESIGN.md 6)
The contract between the simulation and the statistics panels (the model, the dock, the route overlay). The full list of queries with argument and result shapes is at the top of `detail.js`; the answers for fixed runs are `tests/fixtures/stats/*.json` (written by `node tests/helpers/detail-snapshot.js --write`, proved against the live collector by `tests/sim.detail.fixtures.test.js`, served to UI tests by `createFakeDetail(fixture)` in `tests/helpers/fake-sim.js`).
```js
const det = sim.enableDetail({ legCap = 32768, pathCap = 16384, legStart = 2048 })    // vehicles: det.V[i] (= sim.vehicles, det.vehicleIndex(id));  stations: det.stations[i] (det.stIndex.get(id));  NO_STATION = 0xffff
w = det.windowOf('start' | 'last30')   // { kind, t0, seconds, row, zero }: zero = nothing subtracted (Last 30 min equals Since start while fewer than 30 minutes were measured)
det.timeSplit(i, w) → { seconds, driving, waiting, dockQueue, loading, unloading, idle, parked, charging, broken, drivingLoaded, drivingEmpty, drivingDepot }   // the 9 slots add up to seconds; the 3 parts to driving
det.counts(i, w) → { trips, loaded, empty, park, qty }        det.workingSeries(i, n = 60) → number[]        det.batteryOf(i, w) → { now, min, stops: [{ t0, minutes, b0, b1 }] }
det.routesOf(i, w, kinds = [1]) → [{ kind, from, to, flow, trips, complete, meanTime, meanWait, meanDockWait, meanQty, pathId, pathShare, drawn, undrawn, variants, metres, usualTime, usualWait, disturbed, pathIds: [{ id, n, complete, meanTime, meanWait }] }]   // kinds 1 loaded, 0 empty, 2 charger, 3 park
det.roundOf(i, w, jobs = 2) → { jobs: [{ from, to }], count, of, share } | null        det.queuesOf(i, w) → [{ station, seconds, legs, dockNode }]
det.hotspots(i, n) → { cells: [{ node, seconds }], total, folded }  // since start only        det.idleSpots(i, n) → [{ node, seconds }]        det.metresToGo(i) → number | null   // live
det.stationWindow(i, w) → { seconds, fill, inQ, outQ, busy, starved, blocked, down, arrivals, produced, consumed, orders, bufferWait, pallets, yardWait, intakeWait }        det.queueNow(i) → { loads, oldest }   // live
det.visitsTo(i, w) → { visits, meanApproach, meanDockQueue, byVehicle }     det.loadedRoutes({ from?, to? }, w)     det.busiestRoutes(w, n) → { total, routes }     det.cellUse(nodes, w) → { legs, byFlow }
det.pickWait / det.yardWait: Map(station index → LogHist { n, sum, max, percentile(p) });  det.sinkLead: Map(station index → SampleSet);  det.pool.nodes(pathId) → Int32Array of road cells
det.windowStart, det.version (bumps on every leg and bucket close), det.notices, det.whatIf, det.legCoverage() → { rows, cap, wrapped, since }, det.memoryBytes, det.failed / det.error
```
**What it records** (nothing grows with run length): a ring of legs (one row of 36 bytes per drive between two standstills: vehicle, kind, origin and destination station, flow, path id, start, duration, seconds held up, seconds queued for a dock, loads, flags; grows by doubling from 2,048 to 32,768 rows), a pool of distinct cell paths (2 bits per step), a time matrix per vehicle (the 9 slots and the 3 parts of driving), four cell tables per vehicle (24 cells each plus `other`),
a snapshot ring (every 30 s of window time one row of cumulative figures per vehicle and station, 61 rows: "Last 30 min" is the current figure minus the oldest row), the station integrals (sampled once a simulated second, weighted by the real spacing of the samples), the sums of the Goods-in waits, the lead times of the Goods out, charge sessions. 1.5 MB of typed columns on the 320 x 320 / 225-station / 100-vehicle plant after an hour.
**Exact and sampled.** The vehicle figures are exact at tick resolution and equal the report (`tests/sim.detail.exact.test.js`: fleet shares to 1e-9 vehicles, waiting seconds, deliveries, the hot spots cell by cell to 1e-7; on a dock plant whose deadlock resolution relocates vehicles the cell seconds are up to 0.1 % below traffic's own `nodeWait`, because the collector, like `Stats`, reads the waiting flag after the tick, exactly as an independent observer does); the counters are exact; the station shares are sampled once a second (below 0.0007 off the report on the examples). A loaded leg is filed for every delivery: a drive that began and ended inside one tick is filed from the engine's own `orderDelivered` order (zero length, not drawn). A window is the whole run since the collector began; the first window starts when the warm-up ends (`fresh`), a collector enabled later says "counting since".
**Windows.** The cell tables have no 30-minute version (the dock says "since start only"); a leg is in a window when it started in it; the float32 ring reads to half an ulp (about 1e-4 s at 2,000 s of accumulated time) and a difference is never negative.
**Containment.** Everything is caught: a listener that throws or an `afterTick` that throws sets `failed`, the engine drops the collector and keeps the reason (`sim.detailError`); `Logistics.removeVehicle` (the vehicle list shrinks) makes it re-allocate and restart its window with a notice. A bad index in a query answers the empty result.
**Tests.** `sim.detail.unit` (scripted fake simulation: `createFakeDetailSim`), `sim.detail.regress` (STAT-T0, -STRAY, -ZERO, -BALANCE, -ORIGIN, -REMOVE, -THROW and the engine seam), `sim.detail.fixtures`, `sim.seams` (the ledgers); heavy: `sim.golden.detail`, `sim.detail.fingerprint` (neutrality), `sim.detail.exact`, `sim.detail.determinism`, `sim.detail.containment`, `sim.detail.fuzz`, `sim.detail.perf`.
**Cost** (4 cores shared with other work, load average 0.6 to 5, best of alternating rounds; the design's gates in brackets). Collector OFF = the untouched engine within the noise of the machine (`scripts/perf-baseline.mjs --root`: one pointer test per tick; +-10 % between runs of the same code under load, so it cannot be resolved better than that here). Collector ON: +8 to +17 % CPU over off on the five examples by the median of 9 rounds at load 3 (the best round says -1 to +31 %: noise), +3 % (best) to +8 % (median) on Two lines (gate +25 %); 23,000 to 111,000 x real time on them (gate 500 x). The biggest plant (320 x 320, 225 stations, 100 vehicles): the collector's own work is about 6 % of a run (about 85 ns per vehicle and tick, measured with a timer around the poll; 9 % before the arrays of the loop were read into locals), 8 % over off in a three-way alternating comparison with the untouched HEAD at load 2.6 (698 x untouched, 698 x off, 647 x on); best of 8 rounds at load 0.7: 765 x off, 676 x on. **The engine alone sits near 500 x on this plant when the machine is busy** (480 to 575 x in single samples at load 2 to 5), so the gate of the collector on this plant is read on a quiet machine: `node scripts/perf-detail.mjs --gate` prints off and on, the spread of the rounds, the memory and every gate. The sample-and-hold lever of the design (poll every k-th tick) is NOT built: it would trade the exactness of the time split (acceptance S1.3) for a margin that was not needed. Typed columns: 1.5 MB on the big plant after an hour, 2.6 MB once the leg log is full (gate 3.5 MB). Queries on a full leg log of 32,768 rows: 0.1 to 0.7 ms.

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
**Day plants restart cold (milestone M1).** `warmWanted()` is false when the plant on screen or the new plant is a *day plant* (`ui/day-plant.js isDayPlant`: a clock AND a truck timetable, 6.10; 4.10 has the definition). A pre-roll of 10 to 40 minutes would end at a different time of day than the plant on screen, so the edit restarts the simulation at `startTod` (`sim.time` 0, no pre-roll, no `baseline`, no impact card or hint); the `'rebuild'` handler of `app.js` says why in a toast with the action "Compare whole days" (copy 7 of WAREHOUSE-DESIGN 7.6 the first time per session, "The simulation starts again at 06:00, because time of day matters." afterwards) and `panels/day-hint.js` shows "Time of day matters. Compare whole days." A plant whose trucks run in rate mode is stationary and keeps the warm restart and the card, also when a clock is left over from a timetable. `plant-clock.js runSpan` ("Run one day" / "Run one week") sets `duration` and `warmup 0`, resets and plays that span with `runner.step(seconds)`.

### 6.5 Panels & dialogs (owner: panels agent) — `js/ui/panels/*.js`, `js/ui/dialogs.js`
Every panel: `export function createXPanel(ctx) → { el: HTMLElement, update(state): void, destroy(): void }`, where
```js
ctx = { store, runner, renderer, camera, toast(msg, { kind: 'info'|'success'|'warn'|'error', ms? }), actions: { openDialog(name), exportPng(), exportReport(), shareLink(), fitView() } }
```
`update(state)` is called on every store change (and ~4 Hz for live panels). **Rule:** never rebuild a form while a field in it has focus; rebuild only when a structural signature
(selection ids, list lengths, type) changes, otherwise just refresh `value`s of inputs that are not `document.activeElement`. All inputs commit via `store.commit(label, fn, { coalesce })`.
* `inspector.js` — context-sensitive properties: station (name, type-specific params with units and helper text, size), obstacle, label, road cell (speed limit), multi-select summary; with nothing selected: **plant settings** (name, notes, grid size/cell size, handedness, and, while the plant has a clock, the section Clock with Run one day / Run one week, 6.10). A Goods in and a Goods out get the section **Trucks and doors** (`panels/ops-trucks.js`, 6.10); the legacy Deliveries fields are hidden and relabelled while trucks are on.
* `fleet.js` — fleets list/cards: add from preset (AGV, forklift, tugger, custom), count (stepper), speed, accel/decel, length, capacity, load/unload times, battery group, breakdown group, home depot, idle policy; duplicate/delete.
* `flows.js` — table/cards of flows (from → to), weights, perCycle, batch, maxWait, priority, fleet restriction; an "Add flow" form (pick two stations) and quick "chain stations" helper; delete.
* `simulate.js` — **what-if panel**: sliders with live value + reset-to-1 for demand ×, vehicle speed ×, process time ×; dispatch strategy & routing selects, handedness, deadlock policy, seed, run duration/warm-up; runtime-key changes apply live.
* `checks.js` — the issues list from `validateLayout` (graph-aware) grouped by severity; clicking an issue selects/zooms to the referenced station/flow/cell; badge count exposed via `panel.count`. A Fix button is `fixForIssue(layout, issue)` + `applyFix` (6.9); the four checks of trucks and doors (4.10) come with data fixes that run as one undo step.
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
    openWelcome(), openHelp(), openShare(), openImportExport(), openAbout(),   // openAbout: version, build, what is new (6.11)
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
  *As built* (`js/ui/guidance.js`, UI in `js/ui/panels/nextsteps.js`, styles in `css/guidance.css`): `severity` is `'todo'|'warn'|'info'` (notes never block and are not counted as "steps to finish"); a step also has `scopes` (`'plant'|'flows'|'fleet'|'run'`, so the Flows and Fleet tabs show only their own), `icon` and `dismissible`; `fix.type` adds `'set-tab'` (`{ tab }`), `connect-flow` carries `pick: 'to'|'from'` (the end the planner chooses; `toId`/`fromId` hold the suggestion), `add-fleet` may carry `fleetId` (raise that fleet instead of adding one). `validDestinations`/`validOrigins` return station objects, `suggestDestination`/`suggestOrigin` a station object or `null`; `connectFixFor(layout, id)` is the ready-made fix for a toast's Connect action, `fixForIssue(layout, issue)` maps Checks issues to fixes. `fixForIssue` falls through to `opsFixFor` (`model/validate-ops.js`) for the codes of trucks and doors and `applyFix` performs its two data fixes (`update-station`, `extend-docks`) in one `store.commit` (`ui/guidance-ops.js`, 6.10); `computeNextSteps` ends with `addDoorsSteps` (the info note `info:add-doors`, never a step to finish). `guidanceFor(ctx)` holds what all surfaces share (dismissals in localStorage `logiplan:guidance-dismissed`, session progress: has it run, longest run, were the results opened) and a memoised `read(state)`. Suggestions in a list build on each other (a virtual flow per suggestion), so a fresh plant needs two Connect clicks, not four.
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

### 6.10 Trucks and dock doors in the UI (milestone M1; docs/WAREHOUSE-DESIGN.md 7.2, 7.6, 7.7)
All new code is in new files; the existing files only call it (hot-file calls of a few lines each). A plant without trucks looks and behaves exactly as before: every part below is hidden or silent without `ops.trucks` / `layout.calendar`.
* **Inspector, "Trucks and doors"** (`panels/ops-trucks.js`, called by `inspector.js` `stationView` for a Goods in and a Goods out). Without trucks a quiet block with the one button **Add dock doors** (`guidance-ops.js addDockDoors`: `convertToDoors` in ONE undo step "Add dock doors", the station selected, the toast of copy 1 with the action "Show doors", 8 s). With trucks: doors stepper, check-in and check-out in minutes (stored as seconds), the switch **Generate from rate / Use a timetable** (a timetable creates the clock and says the cold-restart toast once per session; switching the last timetable back to rate removes a clock that still has its default start in the same commit), "Time between trucks" and "Pallets per truck" (the distribution control of `fields.js`, here in minutes and pallets), the timetable table (a time and a number of pallets per row, an empty number means "drawn", add / delete rows, keyboard operable, the model sorts), "Trucks arrive up to ... early or late" and "No-shows", on a Goods out "Staging per door" and "A truck waits at most", the live **door check** (`doorCheck` with the plan's demand slider and, after a run, `report.ops.trucks[id].doorTime.mean`; its paragraph, the arithmetic in one line, the button "Use N doors") and the links "Remove trucks" and "How trucks and dock doors work" (Help). Every edit is `store.commit` with a label (`Change doors of "Goods in"`, coalesced per key); `update()` never touches a field that has focus. While trucks are on, `inspector.js` marks the legacy Deliveries fields with `data-role` (`legacy-arrivals`, `out-buffer`, `trucks-note`): the arrival fields are hidden, a note says so, "Output buffer slots per destination" is relabelled "Staging space (pallets) per destination".
* **Paste from spreadsheet** (`panels/timetable-dialog.js` around the pure `timetable-paste.js`): a dialog with a text area, "Paste from clipboard", the summary of copy 5 and a preview table of every pasted line in order (read rows, skipped rows marked in place with line and reason, the header). Nothing is applied until the primary button **Use N rows**; Cancel, Escape and the backdrop change nothing; the rows replace the timetable in one undo step "Paste timetable into ...".
* **Plant settings** (`panels/plant-clock.js`, a section of `plantView` shown only while `layout.calendar` exists): "Clock starts at [time] on [weekday]" (`updateCalendar`), **Run one day** / **Run one week** (one undo step that sets `duration` and `warmup 0`, resets the simulation to the start of the clock and plays at the highest speed; the week asks first), "Remove the clock" while no timetable uses it. The simulation bar shows the time of day (`Mon 06:42`, `app.js createSimBar`, data from `day-plant.js clockChip`).
* **Day plants** (`day-plant.js`, the one definition `isDayPlant(layout)`: the plant has a clock AND a truck timetable; M2 widens it). `runner.js warmWanted()` is false when the displayed plant or the new plant is a day plant, so an edit restarts the simulation cold (`sim.time` 0, no pre-roll, no baseline) and `panels/impact.js` shows neither the card nor the hint; the toast after such a restart says why and offers "Compare whole days" (copy 7 the first time per session, "The simulation starts again at 06:00, because time of day matters." afterwards). A plant with trucks in rate mode is stationary: warm restart and the impact card as before (a leftover clock does not make it a day plant).
* **Canvas** (`render/ops.js`; exactly one call each from `bricks.js planContent` and `paintContent`). `planOps` reserves a band along the lower edge of the face (never on road cells: the band is inside the brick) and hands the rest of the face to the existing layout; `paintOps` draws N door slots (free = dashed outline, a truck in the colour of its state with a clock while checking in or out, an arrow while pallets are unloaded (up, into the brick) or loaded (down, out of it), a pause mark while the door is held and nothing moves; colour never carries the state alone), the **gate chip** ("Gate 5 trucks, 38 min", shortened to "Gate 5, 38 min", "5, 38 min", "5" to leave the slots their room; neutral, amber from 15 min and red from 45 min with a "!" mark, constants `GATE_AMBER_SECONDS` / `GATE_RED_SECONDS`), from 24 px per cell the staged pallets of a Goods out as small squares (doors x staging, at most 24) and, with the Docks overlay on or the brick picked, the **dock share bars** (one thin bar beside the notch of every dock cell, as long as the visits of that dock compared with the busiest, read from the EXISTING `report.stations[id].docks`; one long bar and empty ones is the symptom, even bars the proof that the dock choice works). Below 14 px per cell only the count of doors is drawn; a brick below 5 px is the flat swatch as before. It reads `rt.trucks.gate[]` (`at`), `rt.trucks.docked[]` (`state` 'checkin' | 'work' | 'checkout', `door`), `rt.trucks.staged` and `rt.state`; without them every door is free. Hit testing is unchanged (the band belongs to the brick). Per frame and brick it allocates nothing once warm (plans cached per station, strings per value; the report for the share bars is cached for 250 ms).
* **Results, the Doors card** (`panels/doors-card.js`, mounted by `dashboard.js`, hidden without trucks): per station with trucks the doors, trucks served, gate wait (mean, 90th percentile), door time, doors busy (a bar, orange from 85 %), gate queue now and at its worst, a sparkline of the gate queue (only when it was ever above 0), for a Goods out the trucks that left short and the share of pallets loaded, and the arithmetic of the door check. Source: `report.ops.trucks[stationId]` (WAREHOUSE-DESIGN 6.8); every field may be absent (a report without `ops` shows the configuration and a note, never NaN). The insights of the sim side arrive through the existing Insights list.
* **Checks and guidance.** `guidance.js fixForIssue` defaults to `opsFixFor` (model/validate-ops.js) and `applyFix` performs the data fixes `update-station` ("Use N doors", "Add a row") and `extend-docks` ("Extend the road") inside ONE `store.commit` (`guidance-ops.js applyOpsStoreFix`, with an Undo toast), the fix `focus` ("Show docks") is the only button of that issue (the generic Show button is left out). `computeNextSteps` ends with `addDoorsSteps`: the note `info:add-doors` (severity info, dismissible, never a step to finish) once the plant has flows and a Goods in or Goods out without trucks. Help has the page "Trucks and dock doors" (`panels/trucks-help.js`, with a diagram of docks in a row against docks on side roads). The HTML report gets the truck rows of a station (`report-ops.js`: doors, check-in / check-out, truck rate or timetable, staging; the door check line), the clock in "the plant at a glance" and a "Dock doors" table in the results. Experiments list the metrics and sweeps of `experiments.js` without a change (`compare.js` only knows the units "doors" and "pallets" as counts).
* **After the integration of M1.** "Add dock doors" on a Goods out reads the live report (`ctx.runner.kpis()`, `report.throughput.bySink`) and sizes the trucks to the pallets an hour that reached it in the last run (at least 6 pallets in the window), and the toast says which it did (`dockDoorsToast` option `shipped`); without a run the default of 48 an hour stands and the toast says that the trucks leave short if the plant ships less. The door check has a line under it (`door-check-note`, `doorCheckNote`) that says the 90 s per pallet are an assumption and the vehicles set the door time; the Help page says it in the door-check part. The Doors card's "Trucks served" shows "N arrived" only when that is at least the number served (a truck that was at a door when the warm-up ended is served without having arrived in the window), and says how many trucks were turned away or did not come; a 90th percentile of the gate wait below a second is not shown (it is a tick).
* **After the UX review of M1** (`tests/e2e/doors-review.mjs`, the findings UX-1 to UX-27). (1) A native time input fires `change` per segment, so typing 09:30 over 07:00 passed through 09:00 and rebuilt the timetable under the fingers: `panels/time-input.js whenSettled` settles a time when the field loses the focus or Enter is pressed (the focus is tracked by its own `focus`/`blur`, not `document.activeElement`: Chromium dispatches the `change` of a segment while that is already the body), the timetable shows the stored, sorted rows at once (`commit`), and the focus goes to the same column of the row that moved; the clock field uses it too. (2) `editor/keys.js isOperatedControl`: Delete, Backspace and the arrows belong to a focused button, tab, link or switch, not to the selection on the plan. (3) `parseTimeField` reads `6:00 AM`, `06:00:00` and `6.30 Uhr`, refuses a bare `0.25` (Excel's day fraction) with a hint instead of reading 00:25, keeps a tab at the start or end of a line as an empty cell (`<TAB>24` is "has no arrival time"), and never backtracks over runs of spaces. (4) Switching to "Use a timetable" turns the trucks of the rate into the rows of one day (`ops-trucks.js rowsFromRate`), so the switch keeps the load. (5) A day plant gets the line "Time of day matters. Compare whole days." (`panels/day-hint.js`, a sibling of the impact hint, shown after an edit) and its Experiments run settings default to a whole day (`compare.js DAY_RUN`). (6) A brick without room for the band (a 2-cell-high Goods in below 16.5 px a cell) keeps its face and shows the gate chip and the count of doors on its lower edge (`render/ops.js paintEdge`, mode `'edge'`). (7) The inspector says where the demand slider enters the numbers (`demandNote`) and that doors beyond the dock cells need a second dock (`dockNote`, also in the toast of "Use N doors"); "Remove trucks" offers Undo. Not done on purpose: UX-12b (the decimal comma of a number input is the browser's) and UX-14 (native time inputs follow the browser language); UX-5 keeps its model-side remainder (the two checks of `validate-ops.js` still give two-step advice).
* Tests: `tests/ui.ops-render.test.js`, `ui.ops-panels.test.js`, `ui.ops-guidance.test.js`, `ui.ops-runner.test.js` (pure parts, a fake canvas context, a real store, the runner on fake frames and on the real engine) and `tests/e2e/doors.mjs` (the real app, light and dark, 1440 and 390 px; the section `journey` is acceptance A1.15 of the design, the sections `reference` and `reference-queue` compare the live Doors card with figures worked out on paper).

### 6.11 Version, build identity and the update hint (`js/version.js`, `js/build-info.js`, `js/update-check.js`, `js/ui/about.js`)
Every copy of the app knows what it **is**, and a running page can tell that the site has moved on. None of it touches the plant: the version is never written into a project file or a share link (golden tests), only into the report footer.
* **`js/build-info.js`** exports `BUILD = { version, commit, shortCommit, builtAt, channel, repository }`. In the repository it is the development default (`commit: 'dev'`, `builtAt: null`, `channel: 'dev'`, `version` = package.json, `repository` = package.json's); `scripts/build-site.mjs` OVERWRITES it in the output directory only (version from package.json, `commit` = `GITHUB_SHA` (hex only; otherwise the build is `channel: 'local'`, commit `'local'`), `builtAt` = UTC build time (or `SOURCE_DATE_EPOCH`: whole seconds, a year from 2000 to 2199, anything else is ignored like an invalid `GITHUB_SHA`), `channel: 'live'`, `repository` from `GITHUB_REPOSITORY` or package.json). Every value is written with `JSON.stringify`. The same script writes `version.json` (`{ name, version, commit, shortCommit, builtAt, channel, builtFrom }`; `commit` is still `GITHUB_SHA` or `'local'`) and copies `CHANGELOG.md` into the site. It refuses an output directory that is or contains the repository, and inside the repository any folder but the ignored `_site*` ones (`assertSafeOutput`: `node scripts/build-site.mjs docs` would delete the design documents). Like `bump-version.mjs` it decides whether it was started by node by comparing real paths, so a checkout reached through a symlink still builds.
* **`js/version.js`** (pure): `parseVersion`, `compareVersions` (semantic versioning; junk sorts before every version), `isNewer`, `bumpVersion`, `formatBuildDate` (the viewer's zone, named "CEST" or "EDT" where a name exists, and UTC; only real ISO moments), `parseChangelog` (tolerant, capped, linear time: a line is cut at `CHANGELOG_LIMITS.line` characters and trimmed with `trimEnd()`; never throws: `[{ version, date, unreleased, sections: [{ title, items }] }]`), `parseInline` (**bold**, *italic*, `code`; nothing else is markup), `normalizeBuild`, `hostName` and `whereItRuns` (a port never makes a local host "the live site"), the texts of the chip (`chipText`, `chipTooltip`, `chipAriaLabel`, which starts with the visible text: WCAG 2.5.3), `updateNotice` (a higher number is "a newer version", the same number "a newer build") and the bug-report line, and `updateVerdict(build, fetched)`. Everything that comes from outside is hostile input: own properties only, types checked, lengths capped.
* **Update hint** (`updateVerdict`, `update-check.js`): a build that is `live` (a real commit) fetches `./version.json?t=<now>` with `cache: 'no-store'` once shortly after start, when the tab becomes visible again and every 30 minutes while it stays in front, never more often than every 5 minutes (a clock that was set back counts the last request as old), with a 10 s timeout and a 20,000 character cap. The answer is an update when it has a valid commit that differs from `BUILD.commit` and a version that is not older; for the SAME version number (most deploys: the number is raised by hand) a build time before this build's is "older" too (an older deploy can finish last, pages.yml says so). A rollback (a lower number) is not announced on purpose: reloading would take the planner back. A development or local build, a failed request, junk and an answer that is not newer are all silent and leave the last verdict as it was. The watcher only records the verdict (`watcher.state()`, `subscribe`); it never reloads, never opens anything and never makes a toast, so a running simulation or an edit is not interrupted. Fetch, clock, timers and document are injected (tests/version.update.test.js).
* **UI** (`ui/about.js`): `createVersionChip(ctx, { signal })` puts a `<button class="versionchip">` at the right end of the status line (`app.js createChrome`, one line): the number and the id of the build, `v0.6.0 a45ce49` (the id is what changes with every deploy; it is left out below 600 px, and a development or local copy says `v0.6.0 dev` / `v0.6.0 local` instead), a tooltip (`data-tip`) "Build a45ce49, 9 Oct 2026 – click for what is new", an `aria-label` that starts with the visible text, and while an update is waiting a dot, the word *Update* (the dot alone on a phone) and an extended tooltip; the root gets `data-update` and the More button a dot and "An update is available" in its name. It starts the watcher. On a touch screen the hit area is 40 px high through a negative margin, so the status line keeps its height. `ctx.dialogs.openAbout()` (`dialogs.js`) opens the dialog on the modal primitives (focus trap, Escape, focus returns to the chip; `settleMs: 400` so that the second click of a double click, which lands on the backdrop, does not close it; a held Enter that opened it does not press Close): version, build (a link to the commit page when the repository is on GitHub), build time (local and UTC), where it runs, a **Copy version info** button for the line `LogiPlan v0.6.0 (a45ce49, built 2026-10-09 15:08 UTC), Chrome 126, window 1440 x 900 on a 1920 x 1080 screen` (clipboard API, then the copy command, then the line is selected; the answer stands under the line as a polite live region, never as a toast that would cover Close), the update box with **Reload now**, **What is new** (`loadChangelog`: `./CHANGELOG.md`, read again while an update is waiting; one heading per version with the disclosure button inside it, the sections as the next heading level; the unreleased changes and the newest release open, older versions closed; a note says whether the latest changes are in this build, as far as the update check knows; at phone widths the date of an entry has a row of its own) and the links to the licence and the repository. **Reload now** saves the plant first and is refused (a toast with a button for the project file) when that failed with unsaved changes or when only part of the project fitted the storage (`store.lastPersistError`: a reload would keep only the variant on screen); then `refreshLoadedFiles` fetches the page and every file it loaded with `cache: 'reload'` and reads the bodies (GitHub Pages sends `max-age=600`, so a plain reload would start the old modules again), and the page reloads. A window without a status line (lower than 521 px: a phone held sideways, 200 % zoom on a Full HD monitor) shows the More button at every width, and its menu has "About and what is new". Everything fetched is shown with `textContent` and element nodes, never as markup. Styles are scoped (`ops-styles.js addStyles`), tokens only.
* **Report**: the footer reads "Generated with LogiPlan v0.6.0 (a45ce49)" (`buildSummary`, `exportReportHtml(ctx, { build })`).
* **Releasing**: `scripts/bump-version.mjs patch|minor|major|x.y.z` updates package.json, `js/build-info.js` and CHANGELOG.md together (the Unreleased lines move under the new dated heading); `--check` (`npm run version:check`) fails when the three disagree. Tests: `tests/version.helpers.test.js`, `version.update.test.js`, `version.build.test.js` (builds the site into a temp directory with a fake `GITHUB_SHA`, runs the bump script on a temp copy), `version.changelog.test.js` (the real file: newest release = package.json, valid and non-increasing dates, no empty or unwritten entries), `ui.about.test.js`, the adversarial review `version.review.test.js` (every defect it found has a test named VER-REV-n), the real-browser `tests/e2e/about.mjs` and the opt-in review script `tests/e2e/about-review.mjs` (the findings ABT-n, printed as OPEN or FIXED).

## 7. Visual design ("Lego baseplate for engineers")
Calm, precise, slightly playful. **Canvas:** light grey-blue baseplate with subtle studs in each cell; roads are dark plates with lane markings and chevrons for one-way; stations are
colour-coded **bricks** (top face + darker front edge + studs) with icon and name, a fill bar and a status dot; vehicles are small coloured bodies with a heading notch, a load box when
carrying, red outline when waiting in traffic, amber when broken, green bolt when charging. **Station colours:** source `#2f7df6`, process `#f5b82e`, storage `#f08a24`, sink `#3dbb6d`, depot `#8a63d2`.
Obstacles slate grey (walls hatched, racks with shelf lines). **UI chrome:** neutral surfaces, 8-px spacing grid, 1-px hairlines, rounded 8-px cards, accent `#2f7df6`; light and dark themes via CSS custom properties in `css/tokens.css`
(`--bg --surface --surface-2 --border --text --text-dim --accent --good --warn --bad` …) which the canvas theme (`js/ui/theme.js`) mirrors. System font stack, tabular numbers for KPIs.
Status colours used consistently everywhere: busy/ok green, starved amber, blocked/waiting orange, down/error red, idle grey.

## 8. Quality gates
* `npm run test:quiet` (unit + integration; the same files as `npm run test:fast` + `npm run test:heavy`, which CI runs as parallel jobs: the fast tier and seven heavy shards of 30 to 80 s each, `scripts/test-tiers.mjs`), `npm run check` (imports), `npm run test:e2e` (Playwright, headless Chromium, screenshots in `e2e-output/`).
* **Golden tests** (`tests/sim.golden.*.test.js`, fixtures in `tests/fixtures/golden/`): the KPI report of each of the three legacy examples (`LEGACY_EXAMPLE_IDS`; seeds 1 and 2, one simulated hour, warm-up 600 s), of two multi-dock scratch plants and of five frozen dock-dense plants (`layout.dockplant-<seed>.json`, 600 s; together they notice a change of any one of the twelve constants of the dock choice and the dock book) must equal the recorded text bit for bit, and the recorded legacy layouts and share links must survive `normalizeLayout` / export / import unchanged (schema 1). A change in a legacy result is a bug unless the pull request that re-records the fixtures (`node scripts/rebaseline-golden.mjs`) says why. `node scripts/perf-baseline.mjs` measures CPU seconds per simulated hour (`--root DIR` compares checkouts in one run); the figures recorded at M0 are in `tests/fixtures/golden/perf-baseline.json`.
* Simulation invariants that integration tests assert on every example and on random layouts: no overlapping vehicles; load conservation
  (`created = live + completed + consumed-by-processes` bookkeeping holds); buffers never exceed capacity or go negative; sim time monotonic; same seed ⇒ identical KPIs; no `NaN` anywhere in a `KpiReport`; vehicle state shares sum to 1.
* No console errors/warnings in the browser during a full session (load → edit → run → compare → export).

## 9. Deployment
`.github/workflows/pages.yml`: on push to `main`, job `verify` (import check, fast test tier, assemble `_site/` (index.html, css/, js/, assets/, CHANGELOG.md, docs not needed; the identity of the build, `js/build-info.js` and `version.json`, is written into `_site/` from `GITHUB_SHA`, see 6.11), upload with
`actions/upload-pages-artifact`), then job `deploy` (`actions/deploy-pages`, needs `verify` only, skipped when a newer commit is already on the branch). The heavy test tier runs beside the deploy
(one job per shard) and turns the run red if it fails, without holding the deploy back: the pull request has already passed it (`ci.yml`). Repo Settings → Pages → Source: **GitHub Actions**. All asset URLs relative so it works under `/<repo>/`.
