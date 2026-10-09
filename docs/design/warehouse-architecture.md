# Warehouse, calendar and load types: architecture and delivery plan

Status: design proposal, 2026-10-08. Angle: architecture fit and incremental delivery. Written from a read of `docs/ARCHITECTURE.md` and the code, which is authoritative. Warehouse domain depth (formulas, KPIs, pitfalls) is in the sibling `docs/design/warehouse-ops.md`; section 9 lists where this plan differs.

## 1. Thesis

1. Three optional additions: **operations** (`station.ops`: trucks, doors, racks), **time** (`layout.calendar`), **identity** (`layout.loadTypes`, new load fields). Absent means today's behaviour, bit for bit. The warehouse is built first (M1, M3); the calendar is shared infrastructure.
2. **No new station types.** Extend `source`, `sink`, `storage` through `ops`.
3. **One mechanism for shifts, breaks, staffing and door hours: a capacity timeline** per resource. Doors, machines and vehicles are three consumers of it.
4. **Location by hints, not lanes.** A load or order may carry a dock node; the dispatcher's unit stays the flow.
5. **Seams first (M0).** One behaviour-preserving milestone makes every edit to hot files; later milestones add new files and registry entries.

## 2. What the code forces

| Fact (file) | Consequence |
|---|---|
| `normalizeLayout` rebuilds from known keys; `sanitizeParams` drops unknown keys and treats every nested object as a time `Dist` (layout.js) | Nested or array data cannot live in `params`. New keys need explicit sanitizers or they vanish on load. |
| About 200 lines in 27 files name a station type literal | A sixth type means touching guidance, insights, validate, jobs-view, report, bricks, fleet, flows, connect, tools. Extend instead. |
| Queues are FIFO per flow with the claimed loads as an exact prefix (`unclaimLoads`, `finishLoading`, invariants helper) | Do not pick arbitrary loads from a queue. Select by routing loads into different flows. |
| `Stats` allocates typed arrays once per sim shape, no allocation per tick; shares sum to 1; thresholds assume a stationary plant | Calendar needs an `off` share and on-shift denominators; new KPIs join as registered sections. |
| Warm restart pre-rolls 10 to 40 min from t = 0; the impact card compares 600 s windows | Both assume stationarity. A day-shaped plant breaks them (risk R1). |
| `checkInvariants` demands `schema === 1`; `importProject` warns when a file is newer than `SCHEMA_VERSION` | The warning mechanism exists. Use it, do not bypass it. |
| `layoutChangeKind` treats any unknown top-level key as `structural` | New top-level data rebuilds the sim by default. Correct. |
| Measured here (Node 22, one simulated hour): Starter 20,600x, Two lines 10,400x, Congestion lab 18,900x | Budget 25x above the 400x floor. Spend it on purpose (section 6). |
| `DockBook` (`logistics/docks.js`, in flight) tracks occupant, reservations and busy time per dock cell | Door and aisle logic must reuse it, not add a second chooser. |

## 3. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | `station.ops` is a sibling of `params`, owned by new `js/model/ops.js` | `params` cannot hold nesting (section 2). Sparse: key present only when it has content. |
| D2 | `calendar` and `loadTypes` are top-level, present only when used | Old layouts and share links round-trip byte-identical. |
| D3 | `schema` is the **lowest version that can express the layout**: 1 for legacy content, 2 once any of D1/D2 is used. Add `SCHEMA_MAX = 2`; `emptyLayout` keeps stamping 1 | An older app opening a v2 file shows the existing "newer version" warning instead of silently dropping ops. Additive changes need no rewrite; migrations stay a table for renames only. |
| D4 | Optional fields use the conditional-sparse pattern `road.limit` and `label.size` already follow | A defaulted key would change every legacy layout. |
| D5 | Racks are **derived geometry inside a storage brick**: `deriveRack(station, cellSize)` is pure and shared by sim, inspector and renderer | Cells are 2 m, an aisle is 3 m: cell-level racks cannot express it. Files and undo snapshots stay tiny (parametric, no per-slot data). |
| D6 | `ops` never stores absolute cells. Doors and aisle heads are addressed by `side` plus index along the edge | `moveStation`, `translateAll`, `growGrid`, `resizeGrid` (all being edited now) stay correct without touching `ops`. |
| D7 | Doors are a **semaphore plus truck entities** first (M1). Per-door queues ("ports") are not built | The planner's door-count decision needs no cell binding. Dock cells are already served by `DockBook`. |
| D8 | Aisle-aware put-away and retrieval use **node hints**: `load.at` (pickup dock node) and `order.dropAt` (drop dock node). The batch is the claimed prefix while hints agree | Replaces a lane refactor of dispatcher, vehicles, routing and stations. Null hints give the legacy path. |
| D9 | "Order" means a **truck load plan** (typed lines), not a customer order | Matches the decisions on the table: doors, staging, cut-off. Customer-level OTIF is out of scope. |
| D10 | Typed outbound is **one flow per type group** (`flow.types`) | Reuses per-flow queues and smooth weighted round-robin; no queue change. |
| D11 | New KPIs, insights and checks register through extension points (Stats sections, `insights/warehouse.js`, `model/validate-ops.js`, `METRICS` entries returning `null` when absent) | `compare.js` already hides all-null metrics. Legacy reports stay identical. |
| D12 | New randomness uses new forks (`rng.fork('trucks:' + id)`), never extra draws from existing streams | `rng.js` guarantees independence per label; the golden test depends on it. |

## 4. Data model deltas

Canonical stored times are seconds (the UI shows HH:MM; the sanitizer also accepts `"06:00"`).

```jsonc
// Goods in with trucks (M1). interArrival here means TRUCKS; params.batch is ignored; params.outCap is the staging space.
"ops": { "trucks": { "interArrival": {"kind":"normal","mean":900,"spread":0.3}, "pallets": {"kind":"uniform","mean":24,"spread":0.25} },
         "doors":  { "count": 4, "checkIn": 300, "checkOut": 300 } }
// Goods out with trucks (M1): a truck is a plan of N pallets; pallets are pulled only while a truck is docked
"ops": { "trucks": { "interArrival": {...}, "pallets": {...}, "maxDwell": 3600 }, "doors": { "count": 3, "checkIn": 300, "checkOut": 300 } }
// Rack storage (M3)
"ops": { "form": "rack", "rack": { "aisleWidth": 3.0, "levels": 5, "depth": 1, "bayWidth": 2.7, "positionsPerBay": 3, "reserve": 0.05 },
         "putaway": "nearest-free" }                        // fleet gets optional aisleMin, liftHeight (m); absent = unconstrained
// Calendar (M2), top level
"calendar": { "startTod": 20700, "startDay": 0, "week": 7,
  "shifts":   [{ "id": "early", "name": "Early", "from": 21600, "to": 50400, "days": [0,1,2,3,4],
                 "breaks": [{ "from": 32400, "to": 33300, "unpaid": false, "groups": 2 }] }],   // to < from = past midnight
  "profiles": [{ "id": "inb", "name": "Inbound curve", "hourly": [0,0,0,0,0,0.5,1.4,1.8,1.6,1.2,1,1,0.8,0.7,0.5,0.3,0.2,0,0,0,0,0,0,0] }] }
// bindings, all optional (absent = always available, as today)
"ops.calendar":   { "open": ["early","late"], "profile": "inb", "overtime": 3600 }   // source/sink: door hours, arrival curve
"ops.calendar":   { "shifts": ["early"], "machines": {"late": 1}, "onEnd": "finish" } // process: machines staffed per shift
"fleet.calendar": { "staffing": [{"shift":"early","count":4},{"shift":"late","count":3}], "onEnd": "finish" }
// Load types (M4)
"loadTypes": [{ "id": "t1", "name": "Fast mover", "color": "#e8590c", "cycleFactor": 1 }]
"flow.types": ["t1"]   "source.ops.mix": [{"type":"t1","share":0.7}]   "process.ops.outType": "t3"
// Truck schedule (M2): "ops.trucks.schedule": [{ "at": 23400, "pallets": 26 }], "lateness": {...}, "noShow": 0.02
```

Runtime load shape, set once in M0 so every load has the same hidden class: `{ id, createdAt, origin, readyAt, claimed, ty: 0, tk: -1, at: -1, slot: -1 }` (type index, truck id, pickup node hint, slot id). Dangling references (shift ids in bindings, type ids in flows) are cleaned by one `pruneRefs(layout)` called from `normalizeLayout` and the remove mutators.

## 5. Simulation design

| Piece | Structure | Cost per tick | RNG |
|---|---|---|---|
| Capacity timeline | `Float64Array` breakpoints and `Int16Array` capacity values compiled once from calendar plus binding, over `warmup + duration` (at most a few thousand points); one cursor per bound resource | one comparison per bound resource; O(changes) when crossed | none |
| Demand profile | piecewise-constant multiplier m(t); arrivals run in operational time tau and are mapped back through the inverse cumulative profile | only at arrival events | the source's existing arrival stream |
| Trucks | `st.trucks[]` (a few dozen), FIFO `st.gate[]`, `st.docked[]`, integer `doorsOpen` | O(active trucks) | fork per station |
| Slot table (M4) | per aisle a free-list `Int32Array`, slot-to-load `Int32Array`; put-away is O(aisles) | event only | fork for the `random` policy |
| Stats sections | typed arrays allocated in `_build`, registered per feature | O(doors + bound resources) | none |

**Capacity timeline.** Value = how many of a resource's N units are available at time t: doors open, machines staffed, vehicles staffed. Shift windows and breaks are intersected at compile time (a break with `groups: g` removes `ceil(N/g)` units while it lasts). Units above the value are "off", highest index first, so the choice is deterministic. Events fire at their exact nominal times, like `stepSource` and machine breakdowns, so results do not depend on `dt`. The one dynamic event is overtime: at shift end, if work is left, re-check every 60 s up to the cap; timelines stay precompiled.

**Consumers, with the exact hook.** Doors: a truck docks when `docked.length < doorsOpen(t)`; a docked truck finishes. Machines: `stepMachine` already freezes a cycle while `down` and handles exact times; an off machine reuses that branch, with `onEnd: 'finish'` (default) or `'pause'`, as a state `off` that is not a breakdown. Vehicles: `isAvailable` adds `vr.n <= fleetCap(t)`; an off-duty vehicle finishes its order, then parks through the existing `toPark` and yield logic. **Off-duty is a flag over `parked`/`idle`, not a new vehicle state**, so the state machine and its tests are untouched; `Stats` maps the flag to a new `off` slot.

**Profiles (time change).**
```
tauNext += sampleDist(rngArrival, interArrival, 1 / demandFactor)   // unchanged sampling, now in operational time
nextArrival = profile.invert(tauNext)                                // walks segments, skips m = 0
```
`rescaleArrivals` scales the remaining tau by old/new factor, exactly what it does with remaining time today.

**Truck lifecycle (nominal time, same pattern as `stepSource`).**
```
arrive:   truck = { at, pallets ~ pallets dist }; inbound: create loads now (createdAt = at, held in truck.pending); gate.push
dock:     while gate.length && docked.length < doorsOpen(t): FIFO; releaseAt = t + checkIn
release:  inbound: pending -> yardQ while staging has room (flushYard does the rest)
          outbound: flowSpace(sink) = sum over docked trucks (plan - loaded) - inbound reservations     // pull
done:     inbound: when every load with load.tk === truck.id has been picked up (finishLoading, 2 lines)
          outbound: plan filled or dockedAt + maxDwell;  then checkOut, door freed
```
Door time is therefore emergent: it depends on how fast vehicles take pallets away, which is the interaction the planner must see. Outbound loads still complete on acceptance at the sink, so the conservation law and lead time keep their meaning.

**KPIs.** Reports gain optional sections: `docks` (per door-station: trucks served, gate wait mean/p90/max, turnaround, door utilization, gate queue mean/max), `calendar` (`byHour` arrays of throughput, WIP, truck wait, vehicles working; `byShift`; overtime and paid hours), `storageOps` (positions used, by aisle; dock-to-stock), `loadTypes` (throughput and lead time per type). With a calendar, `utilization`, `starved`, `blocked`, `down` use on-shift time and shares add `off`; without one the formulas and keys are unchanged. Per-dock cell busy time comes from `DockBook.counters`; do not recount it.

## 6. Milestones

Each is independently shippable behind "absent means today" and ends with a decision a planner cannot take now. Sizes are rough engineer-days.

### M0 Seams and safety net (3 to 4 d; no behaviour change)
- **Data:** `js/model/ops.js`, `calendar.js`, `loadtypes.js` (sanitizers, empty at first). `normalizeStations` calls `sanitizeOps`, `normalizeLayout` calls `normalizeExtensions`, `updateStation` calls `mergeOps`, `duplicateStation` copies `ops`. D3 schema logic and `checkInvariants` accepting 1 or 2. `SCHEMA_MAX`.
- **Sim:** `createLoad` initialises the fixed shape; no-op hook call sites in `stepStation`, `flowSpace`, `finishLoading`, `isAvailable`; Stats section registry; insight and validate module lists; `METRICS` null-safety verified.
- **UI:** none.
- **Tests:** golden fixture first: `kpis()` JSON of the 3 examples x 2 seeds x 2 h, plus the 3 example layouts and 3 captured share links, committed under `tests/fixtures/`, asserted bit-identical after every milestone. Capture it after `DockBook` merges (it changes behaviour) and re-baseline exactly once.
- **Risk:** it carries nearly all edits to hot files (`layout.js`, `stations.js`, `vehicles.js`, `stats.js`). Schedule it between the roads wave and the next merge window.

### M1 Trucks and dock doors (4 to 5 d). Decision: how many doors, which gate rule, how many forklifts for unloading
- **Data:** `ops.trucks` and `ops.doors` for `source` and `sink` (rate-driven; the arrival curve comes in M2).
- **Sim:** new `logistics/trucks.js` (lifecycle above); `flowSpace` for a truck sink; two lines in `finishLoading`; `docks` Stats section; insights `doors-bottleneck`, `doors-idle`, `unload-limited-by-vehicles` in `insights/warehouse.js`.
- **UI:** inspector section "Trucks and doors" with the Little's-law line (trucks/h x door hours = doors needed); door ticks on the brick edge and a gate-queue chip (`bricks.js` overlay plan); a Doors card on the dashboard; report assumptions rows; example "Warehouse with dock doors"; sweep parameters door count and truck rate.
- **Tests:** conservation with `truck.pending` counted as live; no door double-booked; docked trucks <= doors; fuzz layouts with random trucks and doors; `ops` survives export, import, share link; e2e: add doors, run, read the Doors card.
- **Risks:** pallets are created at gate arrival, so WIP and lead time include yard wait (intended, labelled). Nothing here needs `DockBook` changes.

### M2 Calendar: shifts, breaks, profiles, schedules (6 to 8 d). Decision: staffing per shift, door hours, peak-hour feasibility
- **Data:** `calendar` plus the three bindings; truck `schedule`, `lateness`, `noShow`; `settings.duration` helper "run N days".
- **Sim:** `calendar.js` compiler; the cursor; consumers (doors, `stepMachine`, `isAvailable`); profile time change in `stepSource` and the truck generator; `calendar` Stats section and `off` share; overtime event; all insight rules read on-shift shares.
- **UI:** a **Calendar** tab (`panels/calendar.js`; one line registers it in `app.js`): shift list, 24 h strip editor for profiles, bindings as checkboxes on station, process and fleet cards; clock chip in the sim bar (`runner.js`: "Mon 06:42"); `byHour` bar chart with `charts.js`.
- **Tests:** timeline compile unit tests (overnight shift, break groups, week wrap); dt-independence (0.1 vs 0.5 give identical KPIs); no order assigned to an off vehicle; off machine never starts a cycle; arrival counts per hour follow the curve (chi-square tolerance, fixed seed); a layout without calendar stays golden.
- **Risks:** R1 (warm restart and impact card) is decided here: calendar plants use cold restart and the card says "compare whole days in Experiments". R2: an off-duty vehicle with no reachable depot parks on a yield cell; validator `staffing-needs-depot`.

### M3 Racks and aisles (6 to 8 d). Decision: aisle width versus equipment, levels, where cross aisles and entrances go. Can run parallel to M2
- **Data:** storage `ops.form: 'block' | 'rack'` and `ops.rack`; fleet `aisleMin`, `liftHeight`.
- **Sim:** `deriveRack` in `model/warehouse.js` gives capacity (replaces typed `capacity` for racked stores), aisle list and head offsets. Heads map to edge cells and then to graph dock nodes; an aisle without a road cell in front is dead and does not count. Put-away picks the least-occupied live aisle and sets `order.dropAt`; retrieval sets `load.at`. In-aisle excursion time is added to dock service time, held on the head cell, so one vehicle per aisle and entrance queues emerge from traffic. **Needs from `DockBook`:** `choose(..., { only: nodeSet })` and a `serviceTime` extension hook; agree the API with that engineer before M0.
- **UI:** aisle lines drawn inside the brick from `deriveRack`; inspector "Racking" with the derivation line ("4 aisles x 11 bays x 5 levels = 1,320 positions"); entrance markers; validate `aisle-no-entrance`, `aisle-shared-entrance`, `fleet-cannot-serve-rack`.
- **Tests:** `deriveRack` property tests (positions monotone in size, never negative); slot count equals positions; excursion adds exactly the formula time; golden unchanged for `form` absent.
- **Risks:** false precision (show the derivation, label indicative); batch of capacity > 1 across aisles (restrict to same-aisle prefix).

### M4 Load types, slots, pull outbound (6 to 8 d). Decision: slotting policy, staging need, cut-off feasibility
- **Data:** `loadTypes`, `flow.types`, `source.ops.mix`, `process.ops.outType`, storage `accepts`; outbound truck `plan` lines by type and `depart`.
- **Sim:** `load.ty`; eligibility predicate in the existing `hasRoom` (reads `st.curType`, no allocation); per-type cycle and dwell factors; slot table with `fifo`/`nearest`/`abc` policies; plan tokens per type in `flowSpace`; OTIF at truck level (full and by departure). Conservation per type.
- **UI:** type palette in plant settings; load boxes coloured by `ty` in `render/vehicles.js`; flow card "Carries"; plan table in the sink inspector; per-type KPIs.
- **Tests:** per-type conservation on every tick; no slot double-occupied; slots used = loads held; typed fuzz.
- **Risks:** mixed-type batches on tuggers; many types x many flows explodes the planner's work (cap at 8 types, presets).

### M5 Picking and labour (stretch, 5 to 7 d)
Pickers are the machines of a `process` with `ops.pick` (cycle from the analytic tour), staffed through the capacity timeline; replenishment is a flow with a `refill` trigger; labour hours and optional cost. Detail in `warehouse-ops.md` section 8.

## 7. Cross-cutting rules

- **Backward compatibility.** Share links carry the whole project JSON through `importProject` and `normalizeLayout`; new keys are optional, so every existing link and the `logiplan:v1` autosave load unchanged. Test: each captured v1 file satisfies `normalizeLayout(x)` deep-equal `x` with schema 1. A schema-3 file triggers the newer-version warning.
- **Determinism.** Nominal-time events, new RNG forks only (D12), cursors advance monotonically, no `Date.now`. Same seed gives identical KPIs and `eventDigest`.
- **Performance budget.** Legacy examples: tick cost within +10% and at least 5,000x (today 10,000 to 20,000x). Warehouse example (4 doors, 1,300 positions, 12 vehicles, two shifts): at least 1,500x. Hard floor 400x. Enforced in a perf test next to `sim.traffic.perf.test.js`.
- **Tests per milestone.** Unit (sanitizers, compilers, `deriveRack`), invariants extended in `tests/helpers/logistics-invariants.js` (trucks, doors, off-duty, slots, types) run on every tick of the fuzz plants, golden, then one Playwright journey under `tests/e2e/` (build, run, read KPIs, share link round trip). Done = `npm run test:quiet` and `npm run check` green.
- **Hot files.** M0 places every call site and registry in `layout.js`, `stations.js`, `vehicles.js`, `stats.js`; later milestones fill them from new files. Stated exceptions: the `stepMachine` off branch (M2, about 15 lines) and `routing.js`, `docks.js`, `dispatcher.js` `assign` (M3, a few lines). No new editor tool is needed through M4 (inspector forms), so `editor*` and `renderer*` stay out of the plan except one overlay hook in `bricks.js`.

## 8. Non-goals

SKU-level inventory; WMS algorithms (wave optimisers, interleaving); per-cell rack drawing; yard geometry and trailer shunting; trucks on the road grid; pedestrian traffic; conveyors, sorters, AS/RS; customer-order consolidation; time zones and daylight saving; costing beyond labour hours. The unit stays the handling unit (pallet, cage).

## 9. Relation to `warehouse-ops.md`

Agreed: `station.ops`, derived rack geometry, pull outbound, trucks as events, one load-type concept, optional everything. Different here: (1) no ports refactor; doors start as a semaphore and aisles use node hints, so `dispatcher.js` keeps its unit; (2) `ops` holds no absolute cells (D6), where its `pinned` list does; (3) calendar before racks, because it is the largest cross-cutting risk and the feature the requester liked most; (4) the schema rule D3 and sparse keys, and M0 as a dedicated seam milestone with a golden fixture.

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Non-stationarity breaks warm restart, the 600 s impact window, 20-minute insight windows, the default 8 h run | Cold restart for calendar plants; KPI windows in whole days; `settings.duration` helper; follow-up to give the impact card a same-time-of-day window |
| R2 | Off-duty vehicles block lanes | Park through existing logic; validator for missing depot; fuzz with random staffing |
| R3 | Silent data loss in `normalize*` | Round-trip tests for every new key; a test that lists each documented `ops` key and asserts it survives |
| R4 | Golden fixture churn when `DockBook` lands | Capture after the merge; re-baseline once; freeze |
| R5 | Hot-file collisions with the roads, canvas and CI work | M0 scheduling; new-file rule; small registries |
| R6 | False precision of derived rack capacity and times | Show the arithmetic in the inspector; label indicative; calibration open question |
| R7 | Complexity for a first-time planner | Everything off by default; "Add doors" and "Make it a racked warehouse" buttons; defaults that run |
| R8 | `dt` sensitivity of exact-time events | Test at 0.1 and 0.5; events processed at nominal times |

## 11. Open questions

1. First customer: pallet warehouse or DC with case picking? It decides whether M5 comes before M4.
2. Do AGV fleets follow shifts (usually 24/7 with charging), or only drivered fleets? Default proposed: only fleets with a `calendar` binding.
3. Truck-level OTIF acceptable as the first service measure?
4. Is the schema rule D3 acceptable (v2 only when new features are used), or should all new files say 2?
5. The `DockBook` API for `only` and the service-time hook: needs agreement before M0 is scheduled.
6. Default run length once a calendar exists: one day, one week?
