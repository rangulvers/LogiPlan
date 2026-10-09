# LogiPlan warehouse module: definitive design and build plan

Status: design for build, 2026-10-08. **Milestones M0 (foundations) and M1 (trucks and dock doors) are BUILT** (M0 merged as `a2af6d8`, M1 verified 2026-10-09; the milestone table in 9.0 has the status, 9.2 the as-built notes, the cut-line items that were dropped and the list of places where the code differs from this text). M2 to M6 are still design. It replaces the three drafts in `docs/design/` (`warehouse-ops.md`, `warehouse-architecture.md`, `warehouse-ux.md`), which stay in the repository as background. Where this document and a draft differ, this document wins. Where this document and the code differ, the code is authoritative and this document needs a fix.

Written from a read of `docs/ARCHITECTURE.md`, `README.md`, the three drafts and the code in the working tree of 2026-10-08, including the then uncommitted dock-choice work (`js/sim/logistics/docks.js`, merged since). The sections on M2 to M6 describe nothing that has been built; the sections on M0 and M1 have been amended to what was built (ARCHITECTURE.md 3.1, 4.10, 5.7 and 6.10 are the contract of the code). Numbers marked "measured" were measured on this machine while writing it (Node 22.22, 4 vCPUs, load average about 12, so timings are noisy); numbers marked "estimate" are judgement.

Contents: 1 Summary for the product owner. 2 How the three drafts were judged. 3 Vision, principles, non-goals. 4 What the code does today. 5 The chosen model: data. 6 The chosen model: simulation. 7 The user interface. 8 Examples to ship. 9 Milestone plan. 10 Test strategy. 11 Risk register. 12 Decisions needed from the user. Appendices A to D.

---

## 1. Summary for the product owner

**What you asked.** At a goods-in or goods-out with one road and three docks, every vehicle drove to the same dock and waited while the others stood free. You want the warehouse module extended first, shifts, breaks and demand curves right behind it, and load types later. The floor-plan underlay waits.

**The dock observation has two causes.** First, vehicles used to pick the cheapest dock, not a free one; an engineer is fixing that now (the "dock book", in the working tree, not released). Second, docks lined up in a row along one lane block each other, because a vehicle cannot drive past a parked one. We measured it on a test plant: with six docks in a row all 465 pallets used the first dock; with three separate short side roads the work was shared 311, 155 and 2 (on the tree of M1, with the dock book tuned since: 310, 156 and 1, Appendix C). The plan adds a warning ("these docks lie in a row") and an example plant, "Dock lab".

**What you get, in this order.**
1. *Foundations* (invisible, 2 to 3 days): every existing plant keeps giving exactly the same results.
2. *Trucks and dock doors* (usable after about two weeks): gate queue, doors, check-in and check-out, a truck timetable you can paste from Excel. You see how many doors you need and whether the doors or the forklifts are the bottleneck.
3. *Shifts, breaks, demand curves* (about two weeks more): a daily clock, staffing per shift, a morning peak, and results by hour: "the day fails between 09:00 and 11:00 because 3 forklifts are not enough".
4. *Racks and aisles* (about two weeks more): capacity from size, aisle width and levels; vehicles too wide for the aisle are flagged.
5. *Slots and outbound planning*, with "on time, in full" per truck.
6. *Load types*, as you asked, later; *picking and labour* only if you need them.

**Left out:** floor-plan underlay, stock by article number, pedestrians, conveyors, yard layout, import from a warehouse system.

**Honest limits.** Rack capacity, aisle times and door needs come from typical values. Each shows its arithmetic, is labelled indicative, and every default can be overwritten.

**We need five answers** (section 12), each with a recommended default. Nothing blocks the first two milestones.

---

## 2. How the three drafts were judged

### 2.1 Scores

Scored 1 to 5 by the judge after reading each draft and the code it touches (5 = best; for risk, 5 = lowest risk). Weighting planner value and feasibility double does not change the order.

| Criterion | Ops draft | Architecture draft | UX draft |
|---|---|---|---|
| Planner value | 5: deepest domain content (Little's-law door check, derived rack geometry, pull outbound, KPI list, pitfalls) | 4: domain by reference, adds the calendar mechanism | 4: makes the features usable and trusted; adds no simulation capability |
| Feasibility in this architecture | 2: ports/lanes refactor through `routing.js`, `dispatcher.js`, `vehicles.js`, `stations.js` | 5: every extension point checked against the code | 3: depends on derived data not yet built; some canvas encodings contradict the sim model |
| Risk | 2: the largest refactor, in the hottest files, first | 4: seams first, golden fixture, sparse JSON | 3: editor and renderer files are being edited now |
| Testability | 4: golden test, invariants, formulas | 5: golden fixture before any change, per-milestone tests and invariants | 3: copy and screens are checkable by e2e, few sim contracts |
| Time to first value | 2: a no-value refactor first | 3: one small no-value milestone first | 4: an inspector-only first slice |
| **Total** | **15** | **21** | **17** |

### 2.2 What each draft contributes to this document

- **Ops** supplies the domain model: formulas (rack derivation, door check, aisle excursion), outbound pull, KPI and pitfall lists, the picking outline. Its ports refactor is not adopted.
- **Architecture** supplies the structure: `station.ops` and top-level `calendar` as sparse blocks, the schema rule, the capacity timeline, doors as a semaphore with truck entities, node hints, the golden fixture, the milestone shape.
- **UX** supplies the planner experience: no warehouse mode, show-the-arithmetic, the staffing matrix, the demand editor, the truck-timetable paste with preview, the copy, the five example plants.

### 2.3 Where the drafts disagree, and the ruling

| Topic | Ops | Architecture | UX | Ruling and why |
|---|---|---|---|---|
| Doors and the dock choice | Ports: each door has its own queue and dock cells | Doors are a semaphore plus truck entities; aisles use node hints | Door ticks sit on dock cells; per-door share bars | **Semaphore plus trucks (architecture).** The dock book already decides which dock cell a vehicle uses, so ports duplicate it and cost a refactor of four hot files. A door is a truck position and a capacity, not a road cell. Door-to-cell binding is question 2. |
| Door addressing | Pinned absolute cells | Side plus index, no cells | Prefer side plus index | **No cells stored at all.** Doors are only a count (`ops.trucks.doors`); aisle entrances are derived from geometry. `moveStation`, `translateAll`, `growGrid` and `resizeGrid` then need no change. |
| Share bars per door | not mentioned | not mentioned | Bar on each door tick | **Bars belong to dock cells**, fed by the dock book counters (`counters(stationId)`), drawn on the existing dock notches. Doors are drawn separately (section 7). |
| Order: calendar vs racks | Racks before calendar | Calendar before racks | not specified | **Warehouse first (trucks and doors), then calendar, then racks.** You ranked shifts and demand with the warehouse and the truck timetable needs a clock; the calendar is the biggest cross-cutting risk and should be retired early; racks and calendar touch different files, so they can run in parallel if two engineers are free. |
| Typed outbound | Flow `types`, producer routes by type | One flow per type group | Mix bar | **Neither as written.** The model allows at most one flow per ordered pair (`normalizeLayout`, `addFlow`, `checkInvariants`), so "one flow per type group" is impossible. Types route inside the single flow of a pair and through different destination stations; typed truck plans are out of scope (section 6.6). |
| Outbound pull | Release plan tokens at departure minus lead time; pre-stage at a planned door | Pull only while a truck is docked | Not covered | **Docked-truck pull plus an optional staging allowance in M1**; lead-time release and on-time-in-full in M4. Pure pull makes door time look worse than reality (every pallet needs a vehicle round trip while the truck waits). |
| Binding shapes of the calendar | Hooks H1 to H5 only | Three binding shapes (open, shifts/machines, staffing) | One staffing matrix | **One shape everywhere:** `calendar: { staffing: [{ shift, count }] }` on doors, workstations and fleets. It is also exactly what the matrix edits. |
| Overtime | not covered | Re-check every 60 s at shift end | not covered | **Deferred.** Not needed to decide staffing; adds a dynamic event to a precompiled timeline. |
| Stats extension | not covered | A registry of sections | not covered | **One optional extension object** (`ext`) created only when a layout uses a feature, and one namespace `report.ops`. Simpler than a registry; legacy reports stay byte-identical. |
| Schema number | not covered | Lowest version that can express the layout: 1 or 2 | not covered | **Same rule, one number per milestone that persists new keys** (section 5.2), so a cached older tab warns instead of silently dropping keys of a later milestone. |
| Editor tools | none | none through M4 | Form option in the Storage tool, live ghost | **Inspector first.** The editor and renderer files are being edited by the roads and canvas wave. The tool option and ghost follow when that wave has merged (M3b). |
| Templates | not covered | not covered | Four-question templates | **Examples first**; the generator is not scheduled (section 8.2). |
| Restart of day-shaped plants | Same time of day | Cold restart | Open question | **Cold restart** (section 6.2.7), question 3 asks you to confirm. |
| Block storage | Lanes, LIFO, honeycombing | not covered | Floor stack option | **Derived capacity only** (no LIFO) as a cut-line item of M3. |
| Picking | W4, analytic tour | M5 stretch | Pick zone brick option | **M6 stretch**, not designed to build level until question 1 is answered. |

### 2.4 Defects in the drafts found by reading the code

1. Architecture D10 (one flow per type group) cannot be built: at most one flow per ordered pair (`js/model/layout.js` lines 453, 645, 1016). Corrected in 2.3 and 6.6.
2. UX door ticks on dock cells with a per-door share bar contradict doors as a semaphore. Corrected in 2.3.
3. Ops "pinned" door cells would break under `moveStation`, `translateAll`, `growGrid`. Dropped.
4. Architecture quotes 10,000 to 20,000 times real time for the examples. Measured here: 6,100 to 7,100 (Starter), 2,100 to 4,600 (Two lines), 5,300 to 9,800 (Congestion lab) on a busy machine. Performance gates in this document are therefore relative and use CPU time (section 10.5).
5. Architecture's test "dt 0.1 and 0.5 give identical KPIs" cannot hold: shift boundaries and dispatch decisions apply on tick boundaries. The test is a tolerance (section 10.3).
6. The ops worked example for the aisle excursion lifts to `level x height`; a position on the floor needs no lift. This document uses `(level - 1) x height` (mean excursion 44.9 s for the reference rack instead of 53.9 s).
7. UX "restarts on Monday at 05:00" needs a definition: `calendar.startTod` is the time of day at simulation time 0, which is the start of the warm-up (section 6.2.1).
8. Ops proposes ports "so that a load in door 2's queue sends the vehicle to door 2". With the dock book in place this is only needed if doors must be tied to a place on the wall (question 2).

---

## 3. Vision, principles, non-goals

### 3.1 Vision

A planner who knows warehouses but has never used LogiPlan can open "Warehouse: first day", change the door count and the shift pattern, and say at which hour and why the day fails, within fifteen minutes and without opening Help. Concretely the module answers six questions the tool cannot answer today:

| Planner question | Answered by | Milestone |
|---|---|---|
| How many dock doors, and are the doors or the forklifts the bottleneck? | trucks, gate queue, door time (emergent from vehicles), door check | M1 |
| Do my docks actually share the work? | dock share per dock cell, "docks in a row" check, Dock lab | M1 |
| Does the day work: peak hour, shift end, breaks, staffing per shift? | clock, shifts, breaks, demand curve, Results by hour and shift | M2 |
| Which rack, aisle width and levels, which truck type? | derived capacity, equipment constraint, time in the aisle | M3 |
| Is the store big enough, and where do pallets go? | slots, put-away policy, fill by aisle | M4 |
| Do trucks leave on time and full? | loading plans, cut-off, on-time-in-full at truck level | M4 |

### 3.2 Principles

1. **Absent means today.** A plant without the new blocks behaves bit for bit as it does now, and its files, share links and autosave round-trip byte-identical. Guarded by a golden test (section 10.1).
2. **No new station types, no warehouse mode.** The palette keeps its five bricks. Warehouse features are options of Goods in, Goods out and Storage (`station.ops`) and sections of the inspector. About 200 lines in 27 files name a station type literal; a sixth type would touch all of them.
3. **Derive, do not type, and show the arithmetic.** Capacity comes from the rectangle, doors needed from trucks. Every derived number prints its formula in one line and is labelled indicative.
4. **Sparse, explicit, owned JSON.** New data lives in `station.ops`, `layout.calendar`, `fleet.calendar`, `fleet.aisleMin/liftHeight`, `layout.loadTypes`, each owned by a pure module with its own sanitizer. Nothing goes into `params`, whose sanitizer drops unknown keys and treats every nested object as a time distribution.
5. **No absolute cells in `ops`.** Geometry that depends on roads is derived at load time.
6. **Deterministic.** New randomness only through new `rng.fork(label)` streams (fork is label-derived, so it never disturbs an existing stream). Exact-time events fire at their nominal times where the existing code does, and are applied on the first tick at or after that time otherwise.
7. **Every milestone is shippable and ends with a decision the planner could not take before.** Each lists a cut line: what is dropped first if it runs late.
8. **Hot files get tiny hooks.** Other engineers edit `js/ui/editor*`, `js/ui/renderer*`, `js/ui/camera.js`, `js/model/layout.js`, `js/sim/graph.js` and CI now. All logic goes into new files; edits to existing files are call sites of a few lines (section 9.9 lists them).

### 3.3 Non-goals

Floor-plan underlay (declined for now); article numbers (SKU), weights, dimensions, expiry; warehouse-management algorithms (wave optimisers, task interleaving, slotting optimisation); pedestrian traffic and picker collisions; conveyors, sorters, shuttles, AS/RS; yard geometry and trailer shunting; trucks driving on the road grid; consolidation optimisation across customers; typed truck plans (counts per load type on one truck, section 6.6); returns grading; mezzanines; temperature zones; skills, rosters per person, ergonomics; overtime (deferred); capex and net present value; money in any unit before question 5 is answered; time zones and daylight saving; inserting a template into an existing plant. The unit stays the handling unit (pallet, cage).

---

## 4. What the code does today

Facts that shaped the design, each checked in the code. "Consequence" is what this document does about it.

| # | Fact (where) | Consequence |
|---|---|---|
| F1 | `normalizeLayout` rebuilds a layout from known keys; `sanitizeParams` drops unknown keys and treats every nested object as a `Dist` (`layout.js` 213 to 222, 355 to 363, 468 to 486) | Nested or array data cannot live in `params`. Every new key needs an explicit sanitizer and a round-trip test. |
| F2 | At most one flow per ordered pair (`layout.js` 453, 645, 1016; ARCHITECTURE 4.3) | Typed routing cannot use several flows between two stations. Rule kept. |
| F3 | Queues are FIFO per flow with the claimed loads as an exact prefix (`unclaimLoads`, `finishLoading`, invariants helper) | No picking arbitrary loads from a queue. Retrieval takes the front run; hints apply only while they agree. |
| F4 | `Stats.report()` has a fixed shape; `sample` allocates nothing per tick (`stats.js` header, `_build`) | New KPIs live in an optional extension object that allocates once at build and adds keys under `report.ops` only when used. |
| F5 | `rng.fork(label)` derives a stream from the seed and the label (`rng.js` 51) | New forks never change existing streams, so legacy runs stay identical. |
| F6 | `layoutChangeKind` treats any difference outside name, notes, labels, obstacles and settings as `structural` (`layout.js` 528 to 540) | Edits to `ops`, `calendar`, `loadTypes` rebuild the simulation. Correct; no change needed. |
| F7 | Warm restart pre-rolls 10 to 40 min from t = 0; the impact card compares 600 s windows with noise bands tuned on stationary plants (`runner.js` `primeSeconds`, ARCHITECTURE 6.4) | A day-shaped plant breaks both. Cold restart for plants with a daily clock (section 6.2.7). |
| F8 | The dock book (`logistics/docks.js`; merged since, and in `Stats`, insights and the UI as `report.stations[id].docks`, `dockSkew` and the dock insights) ranks the docks of a station by estimated time to start service, reserves docks, rebinds late, and keeps per-dock counters `{ visits, busy, wait }` | M1 needs nothing from it except its counters (used as they are for the dock share bars; M1 added no `ops.docks`). M3 needs `choose(..., { only })` and a service-time extra (section 9, M3). The golden fixture must be captured after task 27. |
| F9 | `createLoad` returns `{ id, createdAt, origin, readyAt, claimed }`; `openOrder` has no hint fields (`logistics.js` 252, 274) | M0 fixes the shapes once (`ty`, `tk`, `at`, `slot` on loads; `pickAt`, `dropAt`, `pickExtra`, `dropExtra` on orders) so hidden classes stay stable. |
| F10 | `params.capacity` of a storage is read in `stations.js` (`state`, `fill`, `fillLabel`, `flowSpace`, `flowCapacity`) and `dispatcher.js` line 79 | M0 introduces `st.capacity`, returning `params.capacity` for now; M3 returns the derived value for racks. |
| F11 | `SCHEMA_VERSION = 1`; `normalizeLayout` stamps it, `checkInvariants` demands equality, `importProject` warns when a file is newer (`layout.js` 480, 698; `serialize.js` 49, 113) | The warning mechanism exists and is tested; the schema rule in 5.2 uses it. |
| F12 | A truck is only a `batch` today: Congestion lab uses `batch: 4` every 400 s | "Add dock doors" converts a Goods in so that the pallet rate stays the same (section 6.3.1). |
| F13 | `compare.js` treats a metric that is `null` in every variant as absent (lines 180 to 182) | New `METRICS` entries return `null` for plants without the feature. |
| F14 | `SPEEDS` in `runner.js` stops at 1200; `settings.dt` allows up to 0.5; the traffic requirement is "works for dt up to 0.5" | A faster clock step (3600x) is a one-line addition in M2; "speed limited" already exists. |

### 4.1 What the dock observation looks like in the current tree (measured)

Scratch plant (not in the repository): a two-way loop, Goods in with docks on the loop, a sink, 8 forklifts, one pallet arriving every 14 s, 3 simulated hours, seed 3. Visits per dock cell of Goods in:

| Dock layout | Dock book on | Dock book off |
|---|---|---|
| Six dock cells in a row on the loop | 465, 0, 0, 0, 0, 0 | 465, 0, 0, 0, 0, 0 |
| Three separate short side roads | 311, 155, 2 | 397, 0, 0 |

(Measured on 2026-10-08 on the working tree of the time. On the merged tree of M1 the same recipe gives 465, 0, 0, 0, 0, 0 for the row and 310, 156, 1 for the three side roads; see Appendix C. The ratios, not the exact visits, are what the Dock lab and its tests rely on.)

Reading: in this plant every vehicle reaches the row of docks from the same side. A farther dock can only be reached by driving past the nearer ones, which is impossible while one of them is occupied, and the dock book's estimate adds exactly that blocking delay, so it never prefers a farther dock. With separate side roads the dock book spreads the load as intended. A quick prototype of a "far end first" rule in a scratch script spread the visits over the row but did not change throughput in that plant, because the loop itself was the limit. Its value is unproven; it is a follow-up for the dock engineer, not a promise.

### 4.2 Speed today (measured)

One simulated hour, `Simulation.advance(3600)`, three runs each: Starter 6,100 to 7,100 times real time, Two lines 2,100 to 4,600, Congestion lab 5,300 to 9,800. One simulated day therefore costs about 9 to 43 seconds of wall clock on a plant of this size. This matters for day-shaped plants (risk R2).

---

## 5. The chosen model: data

### 5.1 Rules for every new key

1. **Where.** Per station: `station.ops` (a sibling of `params`). Per plant: `layout.calendar`, `layout.loadTypes`. Per fleet: `fleet.calendar`, `fleet.aisleMin`, `fleet.liftHeight`. Per flow: `flow.types`.
2. **Sparse.** A key exists only when it differs from "feature off". `ops` is absent on a station without warehouse settings, `calendar` absent without a clock, and an `ops` block that becomes empty is removed. Never a defaulted key on a legacy object: that would change every legacy file and share link. (This is the pattern `road.limit` and `label.size` already use.) Inside a block that exists, every field is stored (the sanitizer fills them), so a later change of a default affects new blocks only and needs no migration.
3. **Appended.** New keys come after the existing keys in the objects `normalizeLayout` builds (`ops` after `params`, `calendar` and `loadTypes` after `settings`), so legacy files stay byte-identical.
4. **Owned.** Each area has one pure module with `sanitize*` and `merge*` functions: `js/model/ops.js` (trucks, rack, block, slotting, pick), `js/model/calendar.js` (clock, shifts, profiles, bindings), `js/model/loadtypes.js`. `normalizeLayout` calls them; so do the mutators. They drop unknown keys, clamp numbers into ranges, accept numeric strings like the existing sanitizers, and never throw.
5. **Seconds.** Stored times are seconds (time of day: seconds after midnight, 0 to 86399). The UI shows `HH:MM`; the sanitizer also accepts the string `"06:00"`.
6. **Ids** match the existing rule `[A-Za-z0-9_-]{1,32}`, are not property names of `Object.prototype`, and are unique within their list.
7. **References are pruned.** One `pruneRefs(layout)` removes staffing rows of deleted shifts, profile references to deleted profiles and type references to deleted types. `normalizeLayout` and every remove mutator call it.
8. **Round trip is tested per key** (section 10.2): a table `OPS_KEYS` in `js/model/ops.js` lists every documented key with a valid sample; one test asserts that each survives `normalizeLayout`, export, import and the share link.

### 5.2 Schema version and migration

The rule (from the architecture draft, made precise): **a layout's `schema` is the lowest version that can express its content.** Legacy content is 1 and stays 1.

| Schema | Introduced by | Persisted keys it adds |
|---|---|---|
| 1 | today | everything that exists now |
| 2 | M1 | `station.ops.trucks` (Goods in, Goods out); `layout.calendar` with `startTod` and `startDay` only |
| 3 | M2 | `calendar.shifts`, `calendar.profiles`; `station.ops.calendar`; `fleet.calendar`; `ops.trucks.schedule[].days` |
| 4 | M3 | `station.ops.form`, `rack`, `block`, `putaway`; `fleet.aisleMin`, `fleet.liftHeight` |
| 5 | M4 | `ops.putaway` values `nearest-free`; `ops.trucks.depart`, `releaseLead`, `grace`, `schedule[].depart` |
| 6 | M5 | `layout.loadTypes`; `flow.types`; `ops.mix`, `ops.trucks.mix`, `ops.accepts`, `ops.outType` |
| 7 | M6 | `station.ops.pick` |

Implementation (new file `js/model/schema.js`, pure):
- `SCHEMA_VERSION` in `defaults.js` stays 1 and is documented as the base schema (`createLayout` and `emptyLayout` stamp it). `SCHEMA_MAX` is the highest row implemented by the build.
- `schemaNeeded(layout)` returns the highest row whose keys the layout uses (at least 1). `normalizeLayout` stamps it. `checkInvariants` accepts exactly `schemaNeeded(layout)`.
- `exportProject` stamps the project with the highest layout schema among its scenarios. `importProject` warns when a file's schema exceeds `SCHEMA_MAX`, with the existing wording (it is tested today with schemas 4, 9 and 12).
- `migrate(raw)` is a reserved hook that runs before sanitizing. Everything in M1 to M6 is additive, so it is the identity. A future rename gets one numbered step and one fixture.
- Behaviour of the **currently deployed app** (schema 1) on a v2 or later file: it shows its newer-format warning and opens the file without the new data. That is existing, tested behaviour, and it is the reason for one number per milestone: a cached older tab warns instead of silently dropping the keys of a later milestone.
- Fixtures: three legacy layouts and three captured share links (schema 1) must satisfy `JSON.stringify(normalizeLayout(x)) === JSON.stringify(x)`.

### 5.3 Data by milestone

**All numeric defaults below that describe real equipment or practice** (aisle widths, speeds, bay and level sizes, the `EQUIPMENT_LIMITS`, 24 pallets per truck, check-in and check-out of 5 minutes, the assumed 90 s per pallet of 6.3.4) are typical values written from memory in the drafts. They are **to verify** against supplier data sheets before release and are labelled indicative in the UI until then (R15, definition of done item 7).

#### M1: trucks and doors (`station.ops.trucks`, Goods in and Goods out only)

```jsonc
"ops": { "trucks": {
  "doors": 2,                                                  // int 1..32
  "checkIn": 300, "checkOut": 300,                             // whole s, 0..7200
  "mode": "rate",                                              // "rate" | "schedule"
  "interArrival": { "kind": "normal", "mean": 2700, "spread": 0.3 },   // rate mode: time between trucks (Dist)
  "pallets": { "kind": "uniform", "mean": 24, "spread": 0.25 },        // pallets per truck (Dist), rounded, 1..200
  "schedule": [],                                              // schedule mode: <= 500 rows such as { "at": 21600, "pallets": 24 }, sorted by "at"; pallets null = draw from "pallets"
  "jitter": 0,                                                 // whole s, 0..7200: a scheduled truck arrives at "at" + uniform(-jitter, +jitter)
  "noShow": 0,                                                 // 0..0.5: chance that a scheduled truck does not come
  "maxDwell": 3600,                                            // whole s, 0..86400, Goods out only: wait for pallets, then leave short (0 = until full)
  "staging": 4                                                 // int 0..50, Goods out only: pallets that may wait per door (0 = pure pull)
} }
"calendar": { "startTod": 0, "startDay": 0 }                   // int 0..86399; int 0..6 (0 = Monday); created when a truck station uses "schedule", and kept until updateCalendar(layout, null) removes it
```

Meaning and interplay:
- `Dist` is the existing time distribution (`const`, `normal`, `uniform`, `exp`; mean in the unit of the field, spread 0..1). `interArrival.mean` is clamped to 60..1,000,000 s here.
- With `ops.trucks` on a **Goods in**, the legacy `params.interArrival` and `params.batch` are ignored (they stay in `params` so a station can go back); `params.outCap` is the **staging space per outgoing flow**; `params.startDelay` delays the first truck in rate mode.
- With `mode: "schedule"` the sanitizer creates `calendar: { startTod: 0, startDay: 0 }` if missing (a plant with a timetable has a clock). It does not remove the clock when the last timetable goes back to rate mode (the planner's start time survives the switch); the panel that switches back removes a clock that still has its default start in the same commit.
- A junk value in a patch (`NaN`, `''`, a text where a number belongs) keeps the CURRENT value of the field, like the patches of `params`; a file, which has no current block, takes the default.
- `maxDwell` and `staging` are kept on a Goods in for round trip but ignored.
- The demand slider `demandFactor` scales **volume**: in rate mode the truck frequency (both directions), in schedule mode the pallets per truck (appointments do not move).

#### M2: calendar (`layout.calendar`, bindings)

```jsonc
"calendar": { "startTod": 0, "startDay": 0,
  "shifts": [ { "id": "early", "name": "Early", "from": 21600, "to": 50400, "days": [0,1,2,3,4],
                "breaks": [ { "from": 32400, "to": 34200, "paid": false, "groups": 2 } ] } ],
  "profiles": [ { "id": "morning", "name": "Morning peak", "hourly": [0,0,0,0,0,0.5,1.4,1.8,1.6,1.2,1,1,0.8,0.7,0.5,0.3,0.2,0,0,0,0,0,0,0] } ] }
"ops": { "calendar": { "staffing": [ { "shift": "early", "count": 4 } ], "profile": "morning" } }   // Goods in / Goods out: doors open per shift; arrival curve
"ops": { "calendar": { "staffing": [ { "shift": "early", "count": 2 } ], "onEnd": "finish" } }       // workstation: machines staffed per shift
"fleet": { "calendar": { "staffing": [ { "shift": "early", "count": 4 } ] } }                        // vehicles available per shift
"schedule": [ { "at": 21600, "pallets": 24, "days": [0,1,2,3,4] } ]                                  // optional "days"; absent = every day
```

| Field | Range and default |
|---|---|
| `shifts` | at most 12; `name` at most 40 characters; `from`, `to` seconds after midnight; `to <= from` means past midnight; `from == to` means 24 h; `days` subset of 0..6 whose entries are the day the shift **starts** (default all seven; the UI preset writes Monday to Friday) |
| `breaks` | at most 4 per shift, inside the shift window (clipped); `paid` boolean (default true); `groups` int 1..8 (default 1) |
| `profiles` | at most 8; `hourly` exactly 24 numbers 0..100, at least one above 0 (otherwise the profile is dropped and the validator warns when a binding names it) |
| `staffing` | rows `{ shift, count }`, count int 0..1000 (clamped to the resource's own count at run time); one row per shift |
| `onEnd` | workstations only: `"finish"` (default, the running cycle ends) or `"pause"` (the cycle freezes) |
| bound resource | absent binding = always available, exactly as today |

#### M3: racks and aisles (Storage), equipment limits (fleets)

```jsonc
"ops": { "form": "rack",                       // "rack" | "block"; absent = today's storage ("bag")
         "rack": { "aisleWidth": 3.0, "depth": 1, "levels": 5, "bayWidth": 2.7, "positionsPerBay": 3, "levelHeight": 1.8,
                   "rowDepth": 1.1, "reserve": 0.05, "axis": "auto", "aisleSpeed": 2.5, "liftSpeed": 0.4, "setTime": 15 },
         "block": { "stack": 2, "usable": 0.6, "palletLength": 1.2, "palletWidth": 0.8 },
         "putaway": "least-full" }              // "least-full" | "random"   (M4 adds "nearest-free")
"fleet": { "aisleMin": 2.8, "liftHeight": 10 } // optional, conditional-sparse: absent = no constraint
```

| Field | Unit, range, default |
|---|---|
| `aisleWidth` | m, 1.5..6, 3.0 |
| `depth` | pallets deep per side, 1..2, 1 |
| `levels` | 1..12, 5 |
| `bayWidth` | m, 1.8..4.5, 2.7 |
| `positionsPerBay` | pallets per bay and level, 1..6, 3 |
| `levelHeight` | m, 0.8..3, 1.8 |
| `rowDepth` | m per row of one pallet depth, 0.8..2, 1.1 |
| `reserve` | share kept free, 0..0.3, 0.05 |
| `axis` | `"auto"`, `"ns"`, `"ew"` (direction the aisles run) |
| `aisleSpeed`, `liftSpeed`, `setTime` | m/s 0.5..6 (2.5); m/s 0.1..1.5 (0.4); s 0..120 (15) |
| `block.stack`, `usable` | int 1..6 (2); 0.3..0.9 (0.6); pallet size m, EUR 1.2 x 0.8 (question 4) |
| `fleet.aisleMin` | m, 1..6; `fleet.liftHeight` m, 0..14 |

`form` other than the default makes `params.capacity` irrelevant for that station: the capacity is derived (6.4). `params.capacity` stays stored so the form can be switched back. **Equipment presets are not in `FLEET_PRESETS`**: `sanitizeFleet` starts every fleet from its preset's defaults, so a constraint key placed in a preset would be added to every legacy fleet and break byte-identical round trips. A separate `EQUIPMENT_LIMITS` table (counterbalance 3.6 m / 6 m, reach 2.8 m / 10 m, narrow-aisle 1.7 m / 12 m, pallet jack 2.0 m / 0.2 m) is used only by the "Add vehicles" action to write the two keys into a new fleet. New presets `reach`, `palletjack` and `vna` can be added to `FLEET_PRESETS` (speed, acceleration, length, load times only).

#### M4: slots, outbound plans

`ops.putaway` gains `"nearest-free"`. Goods out `ops.trucks` gains `releaseLead` (s, 0..86400, default 5400: pallets are requested this long before departure), `grace` (s, 0..7200, default 900: on-time tolerance) and per schedule row `depart` (seconds after midnight; absent = no cut-off, `maxDwell` applies). In rate mode `depart = arrival + maxDwell`.

#### M5: load types

```jsonc
"loadTypes": [ { "id": "fast", "name": "Fast mover", "color": "#e8590c", "velocity": "A", "cycleFactor": 1 } ]   // <= 8; absent = one implicit type
"flow":  { "types": ["fast"] }              // absent = all types
"ops":   { "mix": [ { "type": "fast", "share": 0.7 } ],     // Goods in, rate mode: type shares (normalised)
           "accepts": ["fast"],              // Storage: types it takes (absent = all)
           "outType": "fast" }               // Workstation: type of its output (absent = type of its first input)
"trucks": { "schedule": [ { "at": 21600, "pallets": 24, "mix": [ { "type": "fast", "share": 0.5 } ] } ] }   // inbound only
```

`velocity` is `"A"`, `"B"` or `"C"` (default `"B"`); `cycleFactor` 0.2..5 (default 1).

#### M6: picking

`station.ops.pick` on a workstation (section 6.5). Not specified to field level before question 1 is answered.

### 5.4 Runtime shapes fixed in M0 (no behaviour change)

Fixed once, so that hidden classes stay stable and later milestones add logic, not fields:
- Load: `{ id, createdAt, origin, readyAt, claimed, ty: 0, tk: -1, at: -1, slot: -1 }` (type index, truck id, aisle index, slot id).
- Order: the existing fields plus `pickAt: -1, dropAt: -1, pickExtra: 0, dropExtra: 0` (aisle indices to pick from and drop into, and extra service seconds at that aisle).
- `StationRT`: `trucks: null`, `rack: null`, `cal: null`, `capacity` getter (F10). `Logistics`: `ext: null` (the optional extension object), `clock: null`.
- `Stats`: `ext: null`.

---

## 6. The chosen model: simulation

### 6.0 Loads, types and orders

- A **load** is one handling unit (pallet, cage). Besides today's fields it carries `ty` (type index; 0 is the implicit type "Pallet", M5), `tk` (id of the truck it arrived on, M1), `at` (aisle index where it is stored, M3) and `slot` (slot id, M4). Creation, retirement and the conservation law `created = live + retired` are unchanged; pallets on a truck at the gate and pallets staged at a Goods out count as live.
- An **order** is the dispatcher's transport job (flow, vehicle, loads), as today, plus the hints `pickAt` and `dropAt` (aisle indices) and the extra service seconds `pickExtra` and `dropExtra` at an aisle. In this module "order" never means a customer order: outbound demand is a **truck plan** (pallets for one truck). Customer orders and their lines are out of scope (3.3).
- A **truck** is neither a load nor an order but an entity of the station that owns it (6.3).
- **Types** are described in 6.6; until M5 every load has type 0 and nothing reads it.

### 6.1 New files and what they own

| File | Layer | Owns |
|---|---|---|
| `js/model/schema.js`, `ops.js`, `calendar.js`, `rack.js`, `loadtypes.js` | model, pure | sanitizers, `schemaNeeded`, timeline compiler, profile mathematics, `deriveRack` |
| `js/model/validate-ops.js` | model | validation codes of Appendix B (called from `validateLayout`) |
| `js/sim/logistics/trucks.js` (M1), `staffing.js` (M2), `racks.js` (M3), `slots.js` (M4), `picking.js` (M6) | sim | the runtime of each feature, created only for stations that use it |
| `js/sim/stats-ops.js`, `js/sim/insights-ops.js` | sim | the optional KPI section `report.ops` and its insight rules |

`ARCHITECTURE.md` section 3 allows `sim` to import `util`, `model/defaults.js` and `model/layout.js`. It is amended in M0: `sim` may also import the pure model modules above (they import only `util` and `defaults.js`).

### 6.2 Clock, calendar, shifts, breaks, demand profiles, truck schedules

Milestones: the clock and the truck timetable arrive in M1; shifts, breaks, staffing and demand profiles in M2.

#### 6.2.1 Clock

Without `layout.calendar` there is no clock and times are elapsed seconds, as today. With it: `c(t) = startTod + t`, `tod(t) = c mod 86400`, `day(t) = (startDay + floor(c / 86400)) mod 7` (0 = Monday). **`startTod` is the time of day at simulation time 0, which is the start of the warm-up**; the KPI window begins at `settings.warmup`. A plant with a clock and a truck timetable is called a **day plant** in this document (in M1 a clock exists for no other reason; a clock left behind after the last timetable went back to rate mode does not make a plant a day plant, `ui/day-plant.js isDayPlant`; M2 widens the definition when shifts and profiles use the clock). The helper `makeClock(calendar)` returns `{ tod(t), day(t), label(t) }` (`"Mon 06:42"`).

#### 6.2.2 Staffing and the capacity timeline

Three kinds of resource can be bound: the **doors** of a Goods in or Goods out that has trucks (`ops.trucks.doors`), the **machines** of a workstation (`params.machines`) and the **vehicles** of a fleet (`fleet.count`). One binding shape serves all: `calendar.staffing: [{ shift, count }]`.

- An unbound resource is always fully available (today's behaviour).
- A bound resource with N units has `available(t) = min(N, sum over listed shifts that are active at t of (count minus the break reduction of that shift))`, and 0 when no listed shift is active. Overlapping shifts add up (a hand-over overlap has both crews).
- The schedule repeats weekly. `compileTimeline` turns shifts, days and breaks into breakpoints (`Float64Array`, seconds within one week of 604,800 s) and values (`Int16Array`) once, when `Logistics` is built. At run time a cursor per bound resource advances monotonically and wraps; its cost is one comparison per tick. A change is applied on the first tick at or after the breakpoint (at most `dt` late); the breakpoints themselves are exact.

#### 6.2.3 Breaks

A break window `[from, to]` with `groups = g` is split into g equal waves; the units of the resource go on break one wave at a time: wave k (0-based) takes `floor(count / g) + (k < count mod g ? 1 : 0)` units away for `(to - from) / g` seconds. With `g = 1` the whole crew is away for the whole window. `paid: false` reduces paid hours in the labour KPIs only. For vehicles and doors only the count matters (no identities); for machines, machine index `>= available` is off.

#### 6.2.4 What "off" means for each resource

| Resource | Off behaviour | Code point |
|---|---|---|
| Doors | A truck docks only while `docked < doorsOpen(t)`. A truck already at a door stays until it is done. Trucks wait at the gate. | `trucks.js` |
| Machines | An off machine never starts a cycle. `onEnd: "finish"` lets a running cycle end; `"pause"` freezes it like a breakdown does (without being one). The breakdown clock keeps running on calendar time, as today. State names are unchanged; a flag `m.off` marks it. | the `stepMachine` idle branch and the `down` branch (about 15 lines) |
| Vehicles | A vehicle with number `n > available(t)` (`n` is the 1-based number in its id, `fleetId#n`; `VehicleRT` stores it as `vr.n`) is off duty: `isAvailable` is false, it finishes its current order, then parks at once (no `IDLE_GRACE`) in its home depot or any depot with a free slot, whatever `fleet.idle` says. With no reachable depot it stays and the existing yield logic clears the lane. When it is on duty again it is dispatched like any parked vehicle. **Off duty is a flag over idle or parked, not a new vehicle state**, so the state machine and its tests are untouched. | `isAvailable`, `idle.js` |
| Batteries | Unchanged. Off-duty vehicles parked on a charger keep charging. | none |

#### 6.2.5 Demand profile

A profile (24 hourly values) is normalised to mean 1: `m_i = hourly_i / mean(hourly)`, so the daily total is unchanged and `interArrival` keeps its meaning as the daily average gap. Operational time is `tau(c) = integral of m(s) ds` from 0 to c, with `tau(c + 86400) = tau(c) + 86400`. Arrivals run in operational time with the unchanged sampling and map back through the inverse:

```
tauNext = tauNow + sampleDist(rngArrival, interArrival, 1 / demandFactor)
cNext   = tauInverse(tauNext)           // O(24): whole days, then walk the hourly segments; segments with m = 0 are skipped
tNext   = cNext - startTod
```

`rescaleArrivals` (a change of the demand slider) rescales the remaining operational time by old over new factor, which is what it does today with remaining time. A profile applies to the arrival process of the station it is bound to (trucks in rate mode, or the legacy arrivals of a Goods in); a timetable (schedule mode) overrides it.

#### 6.2.6 Truck schedules

Each day (at start and at every midnight of the clock) the day's rows are expanded into a sorted due list: rows whose `days` contain the day, minus no-shows, moved by `uniform(-jitter, +jitter)` and never before time 0. Equal times keep row order. Pallets per truck: the row's `pallets`, else a draw from `pallets`; multiplied by `demandFactor` and rounded (at least 1). All draws come from `rng.fork('trucks')` of the station, so no existing stream changes, and every row that needs a random number has a stream of its own (`fork(day:at:n)` of that stream, `n` counting rows with the same time) whose first two draws are the no-show and the jitter, taken whether or not the settings use them: changing only the no-show chance, the jitter or the kind of the pallets distribution moves no other truck, and a row added to the timetable leaves the others where they were.

#### 6.2.7 Restart policy, windows and day-long runs

- **A day plant never warm-restarts.** A pre-roll of 10 to 40 minutes ends at a different time of day than the plant on screen, so after an edit the simulation restarts cold at `startTod`. `runner.js` `warmWanted()` returns false when the plant on screen or the new plant is a day plant (a clock AND a truck timetable, `ui/day-plant.js`; in M1 a clock alone, left over from a timetable, does not count). Plants with trucks in rate mode are stationary and keep warm restart and the impact card.
- **The impact card is replaced** for day plants by a one-line hint, "Time of day matters. Compare whole days", with an action that opens Experiments with the plant before the last edit (the runner remembers the layout it replaced) and the plant now, one whole day each after one warm-up day (`duration = 86400`, `warmup = 86400`).
- **Windows.** `report.ops.day` accumulates in 96 quarter-hour bins (time of day), so a window of several days shows the average day. The Results section says how long was measured and warns below one whole day.
- **Cost.** One simulated day is 864,000 ticks at `dt` 0.1. At today's speed that is about 9 to 43 seconds on a plant of the example size (4.2). M2 measures it on the reference example; if one simulated day costs more than 20 s of CPU time there, an idle fast-forward (skip ticks while nothing can happen, using the next-event times the components already know) is scheduled before M3 (R2). "Run one day" (`duration = 86400`, `warmup = 0`) and "Run one week" are buttons in the Shifts tab; the week warns about its cost.

### 6.3 Trucks and dock doors (M1)

Trucks are **events, not vehicles**: they never drive on the road grid, and a station's own dock cells and the dock book are unchanged. A door is a truck position and a capacity, not a road cell (ruling in 2.3).

#### 6.3.1 Converting a Goods in ("Add dock doors")

The button keeps the plant's load unchanged, so the planner sees only the effect of bunching. With `params.interArrival.mean = g` s and `params.batch = b`: pallets per truck `P = 24` and mean gap `P x g / b` (kind and spread of the old distribution kept; the gap is never below 600 s, in which case `P` is raised instead), 2 doors, check-in and check-out 300 s, staging unchanged. Example: Starter has one pallet every 180 s (20 per hour); after conversion a truck of 24 pallets arrives every 72 minutes (still 20 per hour). On a **Goods out** there is no existing rate: default 24 pallets every 30 minutes (48 per hour), 2 doors, staging 4, `maxDwell` 3600 s; the inspector states what the plant shipped in the last run when there is one, so that shipping is not silently the limit.

#### 6.3.2 Inbound trucks (Goods in)

State per truck: `{ id, at, plan, state: 'gate' | 'checkin' | 'work' | 'checkout', dockedAt, releaseAt, left, freedAt, pending[] }`. Per station: `gate[]` (FIFO), `docked[]`, a due list, counters. For a station with trucks the legacy arrival loop of `stepSource` is skipped (`nextArrival` stays infinite) and `flushYard` still runs. Events at nominal times, applied on the tick that reaches them (like `stepSource`):

1. **Arrive** at `at`: the `plan` pallets are created now (`createdAt = at`, so lead time includes the wait at the gate and the conservation law `created = live + retired` holds with `pending` counted as live); the truck joins `gate`.
2. **Dock** while `docked.length < doorsOpen(t)`, FIFO: `dockedAt = t`, `releaseAt = t + checkIn`.
3. **Release** at `releaseAt`: the pallets move to the station's `yardQ`; the existing `flushYard` moves them into the output buffers (the staging space, `params.outCap` per outgoing flow) as vehicles make room. Each pallet carries `tk = truck.id`; `left = plan`.
4. **Unloading is emergent**: vehicles claim pallets through the normal dispatch; each pickup (`finishLoading`) decrements `left` of the load's truck (two lines). There is no unload-rate parameter; door time depends on how fast vehicles take pallets away, which is the interaction the planner must see.
5. **Done** when `left == 0`: after `checkOut` the door is free; `freedAt = t`.

The Goods in is `blocked` while a docked truck's pallets wait in the yard for staging space; the existing source insights apply to that state. Memory guard, like `YARD_LIMIT`: at most 200 trucks wait at the gate, and the pallets that exist but are not picked up yet (on trucks at the gate or at a door, in the yard) stay below `YARD_LIMIT`; a further arrival is counted in `trucks.turnedAway` and creates no pallets. With `demandFactor` 0 no truck arrives, as for sources today.

**Events** (as built): `truckArrived`, `truckTurnedAway`, `truckNoShow`, `truckDocked`, `truckReady` (check-in over) and `truckDeparted`; ARCHITECTURE 5.7 has their payloads.

**The minimum batch of a flow out of a Goods in.** A flow that waits for `batchMin` pallets would strand the last pallets of a truck (the batch could only be completed by a truck that has not docked yet, which cannot dock while the remainder holds the door). The dispatcher therefore lets the batch wait for further trucks while a door is free for them (at most 15 minutes after its oldest pallet was ready, `BATCH_WAIT`), and while some truck at a door can leave without it; when every truck at the doors waits for this batch alone, the remainder goes at once as a smaller batch.

#### 6.3.3 Outbound trucks (Goods out)

A truck has a `plan` of pallets and takes a door as above. Pallets reach the Goods out through the normal flows, but the Goods out is a **pull** destination:

- `flowSpace(flow)` for a Goods out with trucks is `(stagingCap - staged) + sum over trucks at work that are not closing of (plan - loaded)`, minus the reservations already made (`inboundTotal`), never below 0, where `stagingCap = doors x staging`. Trucks still in check-in do not count: the dispatcher wakes when they finish. With `staging = 0` pallets are only fetched while a truck is ready to be loaded.
- A delivered pallet is loaded onto the earliest-docked truck at work with room (FIFO); if none, it waits in `staged` (always `staged <= stagingCap`). When a truck finishes check-in it takes up to `plan` staged pallets at once. Loading is the moment `completeLoad` is called, so throughput, lead time and the conservation law keep their meaning (pallets in `staged` are live).
- A truck leaves when full, or `maxDwell` after check-in with whatever it has (short), but never while reservations are outstanding (`inboundTotal > 0`): at `maxDwell` it is marked `closing`, stops counting in `flowSpace`, and leaves when `inboundTotal == 0` or it is full. Then `checkOut` and the door is free.
- Counters: trucks departed, trucks short; pallets planned and pallets loaded (their ratio is `fillRate`).
- A flow's minimum batch (a plan of 22 pallets with `batchMin` 4) is clamped to the space that is free now, so the last places of a truck are filled by a smaller trip instead of staying empty until `maxDwell` (or for ever with `maxDwell` 0).

#### 6.3.4 The door check (Little's law)

`doorsNeeded = peakTrucksPerHour x doorHours`, with `doorHours = (checkIn + pallets x tPallet + checkOut) / 3600`. Peak trucks per hour: rate mode `3600 / mean(interArrival)` times the peak multiplier of the profile (M2); schedule mode the largest number of rows in any sliding hour. `tPallet` is an **assumed 90 s** before a run and the measured mean door time afterwards (the constant is named `ASSUMED_UNLOAD_PER_PALLET`). Example in Appendix A: 6 trucks per hour of 26 pallets need 4.9 doors busy at once, so 5 doors run at 98 % and the gate queue explodes; 6 doors run at 82 %. The line prints its arithmetic and says that the pallet time is set by the vehicles.

#### 6.3.5 Invariants (asserted on every tick of the fuzz plants)

Docked trucks never exceed `doorsOpen`; the gate is FIFO; a pallet is on at most one truck; `loaded <= plan`; `left` equals the number of the truck's pallets not yet picked up; the places promised to orders on their way never exceed the free staging space plus the room of the trucks at work, and `flowSpace` is exactly what is left of them (never negative); the door is free exactly `checkOut` after the last pickup / the last pallet / the end of the wait; the counters add up (`arrived = gate + docked so far`, `at the doors = docked so far - departed`); conservation including `pending` and `staged`; no `NaN` in any `report.ops` value.

### 6.4 Storage: racks, aisles, slots

#### 6.4.1 Derived geometry (`deriveRack`, M3)

A pure function `deriveRack(layout, station)` shared by the simulation, the inspector, the renderer and the validator (formula and worked examples in Appendix A).

```
module    = aisleWidth + 2 x depth x rowDepth                    // one aisle with a row of racks on each side
aisles    = floor(extentAlongFace / module)                       // extents in metres: cells x cellSize
bays      = floor(extentAlongAisle / bayWidth)
positions = aisles x bays x positionsPerBay x 2 x depth x levels
usable    = floor(positions x (1 - reserve)) - positions of aisles without an entrance
```

The **face** is the side of the rectangle where the aisles open: for `axis: "auto"` the side with the most adjacent road cells (ties: the longer extent along the aisle); `"ns"` or `"ew"` force the pair of sides. Aisle k has its centre line at `k x module + depth x rowDepth + aisleWidth / 2` along the face; its **head cell** is the cell next to the face that contains that point. Entrance status: `ok` (the head cell is a road cell), `none` (it is not), `shared` (another aisle has the same head cell, only possible when `cellSize` is larger than the aisle pitch). The result also lists, per aisle, the head cell, so no cell is ever stored. The function is deliberately conservative (it ignores back-to-back sharing of rows, cross aisles and end clearance) and says so in its text line.

#### 6.4.2 Capacity, put-away and retrieval (M3)

- `st.capacity` (F10) returns `usable` for racks, the block formula for `form: "block"` (`floor(cells x cellSize^2 x usable / (palletLength x palletWidth)) x stack`) and `params.capacity` otherwise.
- Racked storage keeps a count per aisle. `flowSpace(flow)` is the largest free room of any reachable aisle (a batch must fit one aisle) minus its reservations.
- **Put-away.** At assignment the dispatcher reserves room in an aisle (`least-full`, or `random` from `rng.fork('rack:' + id)`) and stores its index in `order.dropAt`. `legTarget` honours the hint: the aisle's dock node (`st.rack.aisles[i].node`) is the only candidate the dock book may choose (`DockBook.choose(..., { only: nodeSet })`, the one change M3 needs there). On delivery `load.at = aisle`.
- **Retrieval** is FIFO by queue order (F3). The batch is the front run of unclaimed loads with the same `at`; `order.pickAt` is that aisle's index. A mixed front simply gives smaller batches.
- Legacy storage (`bag`) has all hints at -1 and the path is unchanged.

#### 6.4.3 Time in the aisle (M3)

For a load at bay b (1..bays) and level l (1..levels): `excursion = 2 x (b - 0.5) x bayWidth / aisleSpeed + 2 x (l - 1) x levelHeight / liftSpeed + setTime`. In M3 b and l are drawn uniformly from the rack's stream at assignment (right mean, no slot table yet) and stored as `order.pickExtra` or `order.dropExtra`; `startLoading` and `startUnloading` add them to the fleet's `loadTime` or `unloadTime`, and `DockBook.serviceTime` adds them to its estimate. The vehicle **holds the aisle head cell during the excursion**, so one vehicle per aisle and queues at the entrance emerge from the traffic model that exists. The mean excursion of the reference rack (5 levels, 11 bays) is 44.9 s against 20 s for a forklift today. Aisle heads on one through lane block traffic just like docks in a row; the validator `rack-face-single-lane` (info) says so.

#### 6.4.4 Equipment constraint (M3)

A fleet can serve a flow with a racked end iff `aisleMin` is absent or `<= aisleWidth`, and `liftHeight` is absent or `>= (levels - 1) x levelHeight`. The dispatcher's `evaluate` skips the pair otherwise (precomputed per fleet and flow). `fleet-cannot-serve-rack` is an error when no allowed fleet can serve the flow and a warning when only some can. This couples the layout choice to the vehicle choice, the classic trade-off.

#### 6.4.5 Slots (M4)

A slot table per racked storage: per aisle a free list (`Int32Array`) ordered by distance from the head, and slot to load. Put-away policies `least-full`, `random`, `nearest-free` (the free slot nearest the head; fast movers end up near the doors once M5 gives them a velocity); retrieval stays FIFO. With slots, `b` and `l` are exact per load, the excursion at retrieval is that of the load's own slot, and the report gets fill by aisle. Slot count equals positions; slots used equal loads held.

#### 6.4.6 Outbound plans, pull and on-time-in-full (M4)

At `depart - releaseLead` a scheduled truck's pallets become wanted: `flowSpace` of the Goods out becomes `min(stagingCap - staged, pallets wanted by released trucks that are not covered yet) + room of trucks at work`, so pallets pre-stage before the truck arrives, never beyond the staging space. The truck leaves when full or at `depart`, short otherwise. **On-time-in-full** per truck: `departedAt <= depart + grace` and `loaded == plan`; the KPI is the share of such trucks and is labelled a truck-level proxy for customer order service. Peak staged pallets is a KPI because pre-staging space is what planners underestimate.

### 6.5 Picking and labour (M6, outline)

A **pick zone** is a workstation with `ops.pick`; its machines are the pickers, so the existing machine sweep, utilisation and bottleneck insights and the shift staffing apply unchanged. Cycle time `tSetup + tour(k) / walkSpeed + k x (tSearch + tPick)` for k lines, with the tour length computed analytically from `deriveRack` (expected aisles visited `A_v = A x (1 - (1 - 1/A)^k)`, then an S-shape or return heuristic). Replenishment is an ordinary flow with a trigger "deliver only when fill is below a threshold". Labour hours (paid versus productive) come from the staffing timeline. The drafts' details (`warehouse-ops.md` section 8) are the starting point; this milestone is not scheduled before question 1 is answered.

### 6.6 Load types (M5)

- `load.ty` is the index into `layout.loadTypes` (0 when there are none: one implicit type "Pallet"). Created by sources with `ops.mix` (draws from the station's `types` fork) or by a truck row's `mix`; a workstation's output has `ops.outType` or the type of its first input.
- **Routing decides by type, queues stay FIFO (F2, F3).** A producer's weighted round-robin chooses only among outgoing flows whose `types` accept the load. A load that no flow accepts is held like a load without room (validator `type-no-home` is an error). Because there is one flow per ordered pair, typed destinations are different stations: fast movers to a fast-mover storage, slow movers to another. That is exactly the zoning use case.
- A storage's `accepts` refuses other types in the validator (warning) and in `flowSpace`.
- Per type: colour of the load box on vehicles, throughput and lead time in `report.ops.types` (only when two or more types exist), process `cycleFactor`, `velocity` for the `abc` put-away policy.
- **Not in scope: typed truck plans** ("10 fast and 14 slow on this truck") and picking a given type out of a mixed queue. They need a queue-selection mechanism that the claimed-prefix invariant forbids today. Revisit after M5 with the first customer's needs.

### 6.7 What changes in dispatch

| Milestone | Change | Where |
|---|---|---|
| M0 | none (fixed shapes, `st.capacity`) | `logistics.js`, `stations.js`, `dispatcher.js` line 79 |
| M1 | `stepStation` hands a Goods in / Goods out with trucks to its desk instead of `stepSource`; `flowSpace` for a Goods out with trucks; `acceptLoads` loads onto trucks; `finishLoading` decrements `left`; `rescaleArrivals` rescales the next truck; the pallets of a truck call `markDirty` through `flushYard` (Goods in) and a truck ready to be loaded through `ready()` (Goods out); `collectDemand` clamps a minimum batch with `batchCeiling` | `stations.js`, `vehicles.js` (1 line), `dispatcher.js` (1 line) |
| M2 | `isAvailable` (off duty); calendar breakpoints call `markDirty` | `vehicles.js`, `idle.js`, `logistics.js` |
| M3 | `evaluate` (equipment); `assign` (aisle reservation, hints); `collectDemand` (batch limited to the aisle run); `legTarget` (hints); `DockBook.choose(only)` and service extra | `dispatcher.js`, `vehicles.js`, `docks.js` |
| M4 | slot reservation; plan tokens in `flowSpace` | `racks.js`, `trucks.js` |
| M5 | none in dispatch (types only choose the producer's queue); `isAvailable` unchanged | `stations.js` |
| M6 | refill trigger in `collectDemand` | `dispatcher.js` |

The dispatcher's unit stays the flow. Strategies (`nearest`, `oldest`, `balanced`), priorities and aging are untouched.

### 6.8 KPIs

All new sections live under one namespace, `report.ops`, which exists only when a layout uses a feature; legacy reports are byte-identical. They are sampled by an optional extension object (`js/sim/stats-ops.js`, created by `Stats._build` only when needed) with typed arrays allocated once and no allocation per tick.

| Section | Contents | From |
|---|---|---|
| `ops.trucks[stationId]` | `name, role ('in' or 'out'), doors, trucks {arrived, docked, departed, short, noShow, turnedAway}, gateWait {mean, p90, max}, doorTime {mean, p90}, turnaround {mean, p90}, doorUtilization, gateQueue {mean, max, now}, doorsBusyNow, fillRate (out: pallets loaded over planned), gateQueueSeries` | M1 |
| `ops.docks[stationId]` | per dock cell `{ cx, cy, visits, busy, wait }` and the share of visits, from `DockBook.counters` (not recounted). **As built: not created.** Task 26 shipped the same data as `report.stations[id].docks` (with `dockSkew`), and the Doors card, the dock share bars and the dock insights read it there; `report.ops` holds only `trucks` | task 26 |
| `ops.day` | 96 quarter-hour bins: throughput, WIP, gate wait, gate queue, doors busy, vehicles working, vehicles staffed, vehicles needed; `byHour` (24) and `byShift` derived; paid hours, productive hours | M2 |
| `ops.storage[stationId]` | positions, usable, fill mean and max, fill by aisle, mean excursion, aisle hold time | M3 |
| `ops.service` | on-time-in-full, trucks late, peak staged pallets | M4 |
| `ops.types[typeId]` | throughput, lead time | M5 |
| `ops.pick[stationId]` | lines per picker-hour, metres per line, face stock-outs | M6 |

The window of every KPI (`report.ops` included) begins at `settings.warmup` and also restarts whenever the number of vehicles changes (`Stats._stale`, legacy behaviour).

With a clock, workstation `utilization`, `starved`, `blocked`, `down` use **on-shift time** as denominator and fleet `shares` gain an `off` key, only for resources with a binding; without a binding the formulas and keys are unchanged.

`METRICS` (experiments.js) gains entries that return `null` when the section is absent (F13): `gateWaitMean`, `gateWaitP90`, `doorUtilization`, `trucksShort` (M1); `peakGateWait`, `shortfallHours` (M2); `storageFillMax` (M3); `otif` (M4). `listSweepParameters` gains `doors:<station>`, `truckGap:<station>`, `palletsPerTruck:<station>` (M1), `staffing:<resource>:<shift>` (M2), `aisleWidth:<station>`, `levels:<station>` (M3).

### 6.9 Insights and validation

New insight rules (`insights-ops.js`, thresholds as named constants at the top, same `candidate()` pattern; with a clock each carries `refs.window = { from, to }` in seconds of the day) and validation codes (`validate-ops.js`, same `Issue` shape with stable ids) are catalogued in Appendix B. Two rules from the existing machinery carry over: an insight never contradicts an older one, and a day plant never gets a "good" insight while any peak hour fails.

### 6.10 Per-tick cost and memory

| Part | Cost per tick | Memory |
|---|---|---|
| Legacy plant after M1 | a pointer test (`st.trucks !== null`) at each station hook (`stepStation`, `flowSpace`, `flowCapacity`, `acceptLoads`, `rescaleArrivals`, `fill`, `fillLabel`), one per pickup (`finishLoading`), one `c.batchMin > 1` test per flow in `collectDemand` (`batchCeiling` returns at once for a flow between stations without trucks), one `ext` test per `Stats` call site (five). **No per-vehicle test**: `isAvailable` and `idle.js` are unchanged until M2 (the design once listed a `cal` test per vehicle; `StationRT.cal` exists, `VehicleRT` has no such field) | none |
| Trucks (M1) | O(active trucks at this station), at most a few dozen: the gate head, the docked list | trucks are short-lived objects |
| Calendar (M2) | one comparison per bound resource; a cursor step at breakpoints | a few hundred breakpoints |
| Day statistics (M2) | about six additions into the current quarter-hour bin | 96 bins per series |
| Racks (M3/M4) | none per tick; O(aisles) per assignment; slots: one `Int32Array` entry per position (100,000 is fine) | typed arrays |

Expected increase for the reference warehouse example: under 5 % per tick over its legacy equivalent; the cost of a day-shaped run is dominated by its length (6.2.7), not by these parts. The gates are in section 10.5.

---

## 7. The user interface

### 7.1 Principles and delivery order

1. **The palette and the tools do not change in M1 and M2.** Warehouse features are sections of the inspector, one new tab and a few drawings on the existing bricks. The editor and renderer files are being edited by the roads and canvas wave, so tool options and live ghosts wait until it has merged (M3b).
2. **Everything is off until asked for.** One button per feature ("Add dock doors", a shift preset, "Racks") switches it on with defaults that run on Play. A plant that never presses them looks exactly as today.
3. **Show the arithmetic.** Derived numbers print their formula in one line ("4 aisles x 11 bays x 3 x 2 x 5 levels = 1,320 positions") and results of the door and rack models carry the word "indicative".
4. **A finding is a sentence, a place and a time.** Insights name the brick, quote the numbers, and with a clock say between which hours.
5. **Colour never carries a state alone.** Each state also has a glyph or a number. Colours reuse `STATUS_COLORS`; there is no new palette.
6. **New code in new files** (`js/ui/panels/ops-trucks.js`, `shifts.js`, `ops-rack.js`, `doors-card.js`, `timetable-paste.js`, `js/ui/render/ops.js`, `js/ui/guidance-ops.js`); existing files get call sites of a few lines (9.9).

### 7.2 M1: trucks and doors

**Inspector, Properties tab.** A Goods in or Goods out with nothing set shows a collapsed section "Trucks and doors" with one button, **Add dock doors**. Pressing it applies the conversion of 6.3.1 in one undo step ("Add dock doors") and opens the section.

| Control | Detail |
|---|---|
| Doors | stepper 1 to 32 |
| Check-in, check-out | minutes (stored as seconds) |
| Trucks | switch **Generate from rate** / **Use a timetable** |
| Rate mode | "Time between trucks" and "Pallets per truck" (the existing distribution field) |
| Timetable | a table with the columns Arrival and Pallets, add and delete rows, **Paste from spreadsheet** (below) |
| Variation | "Trucks arrive up to [x] min early or late" (`jitter`), "No-shows [x] %" (timetable) |
| Staging | on Goods in the existing field "Output buffer slots per destination" is relabelled "Staging space (pallets) per destination" while trucks are on; on Goods out "Staging per door" |
| Goods out only | "A truck waits at most [x] min for its pallets" (`maxDwell`) |
| **Door check line** | live Little's-law sentence (6.3.4) with a button "Use N doors" |
| Remove trucks | link; returns to the legacy fields (nothing was deleted) |

**Paste from spreadsheet** (`timetable-paste.js`, a pure function `parseTimetable(text)` tested in Node). Separators: tab, else semicolon, else comma when every row has exactly one comma-separated pair that cannot be a decimal number. Times: `H:MM`, `HH:MM`, either with seconds that are zero (`06:00:00`, the usual notation of warehouse-system and database exports; `06:00:30` stays refused), `HH.MM` (two digits before and after the point, at most 59), `HHMM`, with a trailing `h` or `Uhr` ignored (`6.30 Uhr` also reads with one digit before the point, a bare `6.30` does not); 12-hour times with a colon and AM/PM (`6:00 AM`, `6:00 pm`, `12:00 AM` is midnight) for English-locale Excel. A bare number below 1 (`0.25`, Excel's time cell shown as a day fraction, which is 06:00) is refused with a hint, never guessed.  Pallets: integers, `24,0` accepted. A header row is skipped. The dialog shows a preview: good rows, and bad rows marked in place with line number and reason ("row 7 “25:70” is not a time"); **nothing is applied until "Use 12 rows"**. Semicolons and decimal commas are first-class because Excel exports them in German and many European locales.

**Plant settings (nothing selected).** When a clock exists: "Clock starts at [HH:MM] on [Monday]" and the buttons **Run one day** and **Run one week**. First use of a timetable creates the clock and shows toast 7 (cold restart).

**Canvas** (`js/ui/render/ops.js`, one call each from `bricks.js` `planContent` and `paintContent`):

| Thing | Encoding | Level of detail |
|---|---|---|
| Doors | a row of N small slots along the lower edge of the brick face, never on road cells: free = outline, checking in = clock glyph, loading or unloading = arrow, waiting for vehicles (staging full or waiting for pallets) = pause glyph, closed (M2) = lock; an occupied slot shows a truck glyph | slots from 14 px cell size; below that only the count |
| Gate queue | chip on the brick: `Gate 5 trucks, 38 min` (count, longest wait); amber from 15 min, red from 45 min (named constants) | all zoom levels except the flat swatch |
| Dock share | a thin bar on each dock notch, length proportional to the visits of that dock (dock book counters); one long bar and two empty ones is the symptom, three even bars the proof that the dock choice works | near zoom, with the existing Docks overlay |
| Staged pallets | small pallet squares in front of the doors of a Goods out | near zoom |
| Clock | chip in the sim bar: `Mon 06:42` (day plants) | always |

**Dashboard.** Results gets a **Doors** card per truck station (hidden without trucks): doors, trucks served, gate wait mean and 90th percentile, door time, door utilisation, gate queue now and maximum, a sparkline of the gate queue, and for a Goods out the trucks that left short. Findings from the insight rules appear in the existing Insights list.

**Guidance.** `computeNextSteps` gains `add-doors` (severity `info`, never counted as a step to finish): a Goods in or Goods out without trucks once the plant has flows. The Checks tab shows the codes of Appendix B with Fix buttons through `fixForIssue`. Help gets a page "Trucks and dock doors" (what a door is, why a row of docks blocks, how to read the gate queue). The HTML report gets assumption rows (doors, truck rate or timetable, check-in and check-out). Experiments get the sweep parameters and metrics of 6.8.

### 7.3 M2: the Shifts tab and time on the canvas

**Tab.** An eighth right-hand tab, **Shifts** (icon clock, after Flows), the word planners use; it holds shifts, breaks, staffing, the demand curve and the run buttons. The strip already collapses to icons below 520 px; a badge appears on the tab when staffing falls short of need. Empty state: "Your plant runs around the clock at a constant rate. Pick a shift pattern to see peak hours and what each shift needs."

```
 Shifts                                    Weekdays | Saturday | Sunday
 Pattern  [1 shift] [2 shifts] [3 shifts] [24/7] [Custom]
        00  03  06  09  12  15  18  21  24
 Early   .   .   |██████████░██|   .   .   .     06:00-14:00   break 09:00-09:30
 Late    .   .   .   .   .   |████████░██| .     14:00-22:00   break 17:30-18:00
 Demand  ▁▁▁▁▁▂▅█▇▅▃▃▂▂▂▂▃▃▂▁▁▁▁▁▁     Inbound curve [Morning peak v]
 ── Who works when ──────────────────────────────────────────
                         Early   Late     (0 = off)
 Goods in 1 doors open     4       2
 Forklifts                 4       3
 AGVs                     24 h    24 h     (battery plants stay on)
 [ Suggest staffing from the last run ]    [ Run one day ] [ Run one week ]
```

- **Presets** write named shifts with a lunch break: 1 shift 06:00 to 14:00; 2 shifts add 14:00 to 22:00; 3 shifts add 22:00 to 06:00 (shown as a wrapped bar); 24/7 is one shift without breaks. Day types (Weekdays, Saturday, Sunday) map to the `days` arrays; the UI never shows seven rows. The first preset click binds every door, workstation and driven fleet to all shifts with their full count, so nothing starves by surprise; AGV fleets with batteries stay unbound (24 h).
- **The form table is primary** (accessible and touch): `Name | From | To | Days | Breaks` with time inputs. The bar strip is an enhancement: drag a bar edge or body (15-minute snap), drag inside a bar to cut a break; each bar is a focusable slider (arrows move 15 minutes, Shift+arrows resize, Delete removes a break).
- **Who works when** is the only place that edits staffing; station and fleet cards show read-only chips ("Early 4 / Late 3 / Edit"). A resource never bound shows "24 h".
- **Suggest staffing** fills the matrix from the last run (vehicles needed per shift = busy vehicle-hours per hour divided by `MACHINE_TARGET_UTILIZATION`, rounded up, with the peak hour named) and **shows a diff first**; nothing is written until the planner accepts.
- **Demand curve:** 24 bars per Goods in or Goods out (inspector, "Arrivals by hour"; this tab shows the plant total), presets Flat, Morning peak, Two peaks, Afternoon-heavy, Month-end spike, and **Paste 24 numbers** (one row or column; any length but 24 or 48 is refused with the count found). A derived line: "Daily total 168 pallets, peak 10:00 = 1.8 x average = 14 pallets an hour". Not used while a timetable is set (shown greyed).
- **Sim bar:** the clock chip gains a shift chip (`Early`, or `Closed`), the speed list gains 3600x ("1 h per second"), and **Run to end of day** is a cut-line item. Off-shift is shown without alarm: closed doors get a lock glyph, off-duty vehicles stay in their depot; nothing flashes.
- **Results, Day section** (only with a clock): gate wait by hour with vehicles busy against staffed and needed, a red band where needed exceeds staffed, a by-shift table (output per hour, door utilisation, vehicle utilisation, gate wait p90, "limited by"), and a Day line "Mon-Fri, 5 days measured". Hours are the x axis of every new chart (`charts.js` bar and stacked bar exist).
- **Impact card and restart:** replaced for day plants as in 6.2.7.

### 7.4 M3: racks and aisles

**Inspector, Storage.** A **Form** control, `Buffer | Floor stack | Racks`, in the Storage section (inspector only in M3a; the tool option follows in M3b). With Racks:

| Control | Detail |
|---|---|
| Aisle width | number plus chips for the equipment (Counterbalance 4.0 m, Reach truck 3.0 m, Narrow-aisle 1.8 m) and, below, chips such as "3.8 m fits the grid" (aisle pitch a whole number of cells) |
| Levels, depth, bay width, pallets per bay, level height, reserve | numbers with the defaults of 5.3 |
| Axis | Auto / Up-down / Left-right |
| **Derivation line** | the formula of 6.4.1 with the result, plus "330 positions have no entrance" when some aisles do not |
| I need [1,200] positions | button **Resize to fit** proposes a rectangle; when blocked it says by what |
| Access | status per aisle ("Aisle 4: no entrance"), button **Show access side** (M3a); **Draw head road** (M3b) paints the road along the aisle heads to the nearest road in one undo step |
| Put-away | `Least full aisle` / `Random` (M4 adds `Nearest free slot`) |

**Fleet card.** A section "Equipment": chips Counterbalance, Reach truck, Narrow-aisle, Pallet jack write `aisleMin` and `liftHeight` (EQUIPMENT_LIMITS), or the two numbers by hand; a line "needs aisles of at least 2.8 m, lifts to 10 m".

**Canvas.** Aisle lines inside the rack brick from `deriveRack` (new, in `render/ops.js`); one fill bar per aisle (grey, amber, red above 90 %), side by side so that "aisle 1 full, aisle 4 empty" is obvious; far zoom: one swatch; near zoom: `78 % (1,030 / 1,320)`. The old `rack` obstacle stays decoration; its inspector gets **Make it a rack block** (swaps it for a Storage brick of the same rectangle).

**M3b (after the roads and canvas wave).** Storage tool option **Form: Buffer, Floor stack, Racks** (pressing 3 again cycles it, like W does for obstacles; stored in `toolOptions.form`, which `PREF_KEYS` already persists) and **Aisles run: Auto, up-down, left-right**; the placement ghost draws the aisles live and the size label reads `16 x 12 cells, 32 x 24 m, 4 aisles, 1,320 positions`.

### 7.5 Later milestones (outline)

M4: put-away select, a column `Depart` in the Goods out timetable, OTIF and staged-pallet figures in the Doors card, fill by aisle in the Storage card. M5: **Load types** in Plant settings (one implicit type "Pallet"; chips + Fast mover, + Slow mover, + Chilled, + Hazardous, + Returns, + Custom each add name, colour, velocity; the UI stops at 6, the model at 8); each Goods in a stacked mix bar (dividers drag, the sum is 100 % by construction, no number to type); chips **Carries** on a flow and **Accepts** on a storage; load boxes on vehicles in the type colour; per-type results when there is more than one type. M6: pick zone options on a workstation.

### 7.6 Copy for the key moments

Placeholders in braces are filled from the plant. The worked examples use the numbers of Appendix A.

| # | Moment | Text |
|---|---|---|
| 1 | Add dock doors (toast, 8 s, action "Show doors") | "{name} now receives trucks: {doors} doors, {pallets} pallets per truck, about one truck every {gap}. That is the same {rate} pallets an hour as before, but they now arrive in bunches." Example: "Goods receiving now receives trucks: 2 doors, 24 pallets per truck, about one truck every 72 min. That is the same 20 pallets an hour as before, but they now arrive in bunches." |
| 2 | Door check (inspector, live; button "Use 6 doors") | "At the busiest hour you need about {need} doors busy at once ({trucks} trucks an hour, {minutes} minutes at a door each). You have {doors}, so trucks will queue at the gate. {better} doors would be busy {util} % of the time. Door time includes waiting for forklifts, so more forklifts shorten it. Estimated from {tPallet} s per pallet; Results shows the real figure after a run." Example: "...about 4.9 doors busy at once (6 trucks an hour, 49 minutes at a door each). You have 4... 6 doors would be busy 82 % of the time." |
| 3 | Docks in a row (Checks warning `docks-share-lane`, Fix "Show docks") | "The docks of {name} lie in a row on one lane. A vehicle standing at the first dock blocks the others, so vehicles queue on the road while the docks behind stand free. Give each dock its own short side road." |
| 4 | Gate finding (Results, warning) | Without a clock: "Trucks wait {wait} minutes at the gate on average". With: "Trucks wait 38 minutes at the gate between 09:00 and 11:00". Detail: "{name} has {doors} doors, busy {util} % of that time, and {n} trucks stood in the yard at the worst moment. The doors are not slow: {x} of the {y} minutes per truck were spent waiting for a free forklift." Suggestion: "Add a forklift (to the Early shift), or open another door." Link: Show on plan. |
| 5 | Timetable paste preview | "{n} rows read, {k} skipped: row {r} “{text}” is not a time. Nothing is applied until you press Use {n} rows." With more than one skipped row the first is quoted and the others counted: "... row {r} “{text}” is not a time (and {k-1} more). ..."; a time that looks like a known spreadsheet notation gets a hint in brackets ("“0.25” is not a time (a number between 0 and 1 is Excel’s time as a fraction of a day: format the column as hh:mm and copy it again)"). |
| 6 | Shift preset applied (toast plus note in the tab) | "Two shifts applied: Early 06:00 to 14:00, Late 14:00 to 22:00, Monday to Friday. This plant now has a daily rhythm, so edits restart the simulation at the start of the day, and results are shown by hour and shift." |
| 7 | Cold restart (first time per session, toast) | "This plant follows a daily timetable. After an edit the simulation starts again at {startTod} instead of continuing, so the figures always describe a whole day." |
| 8 | Staffing short (Results, warning) | "Not enough forklifts on the Early shift between 09:00 and 11:00: {needed} needed, {staffed} staffed." Suggestion: "Add one to the Early shift, or move the break." |
| 9 | Outbound short (Results, warning) | "{k} of {n} trucks left {name} without a full load." Detail: "They waited the full {maxDwell} minutes. Pallets reached the doors too slowly: look at the vehicles that serve the flow into {name}." |
| 10 | Rack block placed (toast, 8 s) | "Rack block 1: 4 aisles, 11 bays, 5 levels = 1,320 pallet positions, 1,254 usable with 5 % kept free. Vehicles enter the aisles from the road in front of them." Actions: Show access side (M3a), Draw head road (M3b). |
| 11 | Rack without access (Checks error `aisle-no-entrance`) | "Rack block 2 has no entrance. No road cell touches the open end of its aisles, so no vehicle can store or fetch pallets there." Hint: "Draw a road along the short side of the block, or move the block next to an existing road." |
| 12 | Fleet cannot serve the rack (Checks, `fleet-cannot-serve-rack`) | "Forklifts need 4.0 m aisles; Rack block 1 has 3.0 m. Switch the fleet to Reach truck, or widen the aisle." |

### 7.7 Accessibility and touch

Every new control is a real button or input with an `aria-label`. Door slots have a hit area of at least 44 px whatever their drawn size; a tap opens a popover (state, truck, "waiting for"). The form table is the accessible primary for shifts and the timetable; screen readers hear "Early shift, 06:00 to 14:00, Monday to Friday, break 09:00 to 09:30". The staffing matrix scrolls horizontally with a sticky first column on narrow screens. Animations respect `prefers-reduced-motion`; nothing flashes or pulses. A rack drag on touch reuses the existing 28 px threshold.

---

## 8. Examples to ship

### 8.1 The list

Every example is built through the `layout.js` mutators (so it doubles as a test of that API), validates with zero errors, runs on Play, meets the performance gates of 10.5, appears in the welcome dialog, and ships tips that a test reproduces at the default run length (the convention of `tests/sim.engine.review.test.js`, "tips": **no tip ships with a number the test does not reproduce**). The three existing examples are unchanged and are the golden fixtures.

| # | Id and name | M | Teaches | Content |
|---|---|---|---|---|
| 1 | `dock-lab`: "Dock lab: one street, three docks" | M1 | The dock observation: docks share the work only when each has its own side road | One feeder road that splits into three short bays, each touching a Goods in with 3 doors and trucks; a Storage; a Goods out with 2 doors; 4 forklifts. Notes tell how to move the three bays into a row and what the Checks tab then says. Tips: read the dock share bars; make them a row and compare; add a fourth forklift. |
| 2 | `warehouse-first-day`: "Warehouse: first day" | M1, extended in M2 | Doors against forklifts; one shift | Goods in with 3 doors (trucks in rate mode), bag Storage, Goods out with 2 doors, 5 forklifts, a depot. Tips: raise the doors and watch that little changes; raise the forklifts and watch the gate queue. In M2: a timetable with a 10:00 peak and one shift. |
| 3 | `dc-two-shifts`: "Distribution centre, two shifts" | M2 (racks in M3) | Staffing matrix, peak hour, breaks | Timetable-driven inbound with a morning-peak profile, Early and Late shifts with lunch breaks, doors and forklifts bound to shifts. Tips: read the Day section; move the break; give Late one forklift less. With racks (M3): switch to narrow-aisle equipment and see positions rise, and what the narrow aisle demands of the vehicles (aisle width, lift height). |
| 4 | `cross-dock`: "Cross-dock at peak" | M2 | Timetable paste, no racks, staging depth | Goods in to Goods out with a staging lane and no storage; 12 arrivals pasted from a table. Tips: find the staging depth that stops the doors blocking. |
| 5 | `rack-warehouse`: "Rack warehouse: aisles and reach trucks" | M3 | Aisle width against equipment, levels, aisle heads | A rack block with a head road, reach trucks. Tips: widen the aisle to 4.0 m and see positions fall; switch the fleet to counterbalance trucks and read the Checks tab. |
| 6 | `supermarket`: "Production supermarket" | M5 | Load types | Fast and slow movers into two storages by type, tuggers. Tips: make fast movers 40 %; watch the aisle bars. |

**As built in M1 (rows 1 and 2; code authoritative).** *Dock lab* (`buildDockLab('bays'|'row')`, 40 x 28 cells): one two-way street, Goods in with three doors for trucks (check-in and check-out 10 minutes, so the doors are busy about 40 % and the gate stays empty: the lab shows the docks, not the doors) and three docks, each at the end of its own side road; a Storage on two bays; Goods out with 2 doors; **5 forklifts** (the design said 4, the lab was calibrated with 5 so that the promised numbers reproduce). The row variant is the same plant after the edit its notes describe (the three side roads erased, Goods in dragged down onto the street). Its three tips: read the dock share bars (57 %, 34 %, 9 % of the visits, bays), make them a row (first dock 97 %, Checks says `docks-share-lane`, forklifts 58 % instead of 53 % busy, door 33 instead of 31 minutes), add a *sixth* forklift (door 30 minutes, waiting in traffic 9 % to 14 %, in the row 20 %); "add a fourth forklift" of the design became "add a sixth". *Warehouse: first day* (48 x 30 cells): trucks of about 24 pallets every 17 minutes to a Goods in with three doors (a fourth dock to try), a Storage of 600 places, Goods out with 2 doors, **4 forklifts** (the design said 5), a Forklift park; four tips (the gate ~8 minutes and the door ~42 minutes with the forklifts 99 % busy; 4 doors move the queue from the gate to the doors; a fifth forklift gives door ~26 minutes and a sixth ~22 minutes; the door check says 2.7 doors). Every number of every tip is reproduced (means of seeds 1 to 5, 8 simulated hours) by `tests/sim.examples.warehouse.test.js`. The M2 extension of example 2 (a timetable with a 10:00 peak, one shift) is not built.

### 8.2 Not scheduled

A template generator ("Start from a template" with four questions: positions needed, trucks per day, doors, shifts, then the plant is built through the model API like the examples) is a good idea, and the suggestion line can reuse the door check. It is not scheduled: it needs the examples to exist first to define "typical", and inserting into an existing plant needs a multi-brick ghost in the renderer. A template plant would carry the banner "Illustrative defaults: replace them with your trucks and rates".

---

## 9. Milestone plan

### 9.0 Order, sizes, dependencies

```
M0 Foundations -> M1 Trucks and dock doors -> M2 Shifts, breaks, demand -> M3 Racks and aisles -> M4 Slots, plans, OTIF -> M5 Load types -> M6 Picking (stretch)
                          \_______ M3a may start right after M1, in parallel with M2: it touches other files _______/
```

The order is the one you asked for: **the warehouse first** (M1 is the first thing a planner can use and answers the dock question), then **shifts, breaks and demand profiles** (M2; the truck timetable of M1 already needs the clock), then the warehouse geometry (M3, M4), **load types later** (M5). If two engineers are free, M2 and M3a run side by side.

Sizes are estimates in engineer-days, adjusted from the drafts (which gave 3 to 8 per milestone) for the work they left out (UI, examples, tests). They are not measurements.

| Milestone | Status | Estimate | Cumulative, one engineer | What the planner can do afterwards that was impossible |
|---|---|---|---|---|
| M0 Foundations | **BUILT**, merged 2026-10-09 (`a2af6d8`) | 2 to 3 | 0.5 week | nothing visible: the safety net exists |
| M1 Trucks and dock doors | **BUILT 2026-10-09** (verified the same day, section 9.2 "As built") | 7 to 9 | 2 weeks | choose door count, staging, forklifts for unloading; see whether docks share the work |
| M2 Shifts, breaks, demand | not started | 8 to 10 | 4 weeks | decide staffing per shift, see the peak hour fail and why |
| M3 Racks and aisles | not started | 8 to 10 (M3a 6 to 7, M3b 2 to 3) | 6 weeks | choose aisle width against equipment, levels, where aisle entrances go |
| M4 Slots, plans, OTIF | not started | 6 to 8 | 7.5 weeks | choose slotting policy, staging need, cut-off feasibility |
| M5 Load types | not started | 4 to 6 | 8.5 weeks | zone by type, see per-type lead times |
| M6 Picking and labour (stretch) | not scheduled | 6 to 8 | not scheduled | pickers per shift, pick method |

**Gate for M0:** the dock tasks (25 to 27) are merged, because the dock book changes behaviour and the golden fixture must be captured after it and re-baselined exactly once.

Every milestone ends with the definition of done of 9.8.

### 9.1 M0 Foundations (no behaviour change)

*Goal.* Land the seams in the hot files once, in one window, plus the safety net.

*Scope.*
- First PR, before any code change: the golden fixture and the performance baseline script (section 10.1, 10.5).
- Data: `js/model/schema.js` (5.2); empty sanitizer modules `ops.js`, `calendar.js` with `sanitizeOps`/`mergeOps` returning `undefined`; `normalizeLayout` calls `normalizeExtensions` and stamps `schemaNeeded`; `updateStation` accepts `ops`; `duplicateStation` copies it; `checkInvariants` accepts `schemaNeeded`; `exportProject` and `importProject` use project-level schema and `SCHEMA_MAX`.
- Sim: the fixed shapes of 5.4; `st.capacity` in the six places of F10; `Logistics.ext` and `Stats.ext` hooks (five call sites in `stats.js`); empty extension lists in `insights.js` and `validate.js`.
- Docs: `ARCHITECTURE.md` section 3 (layering of the new pure model modules).
- Tests helper: `logistics-invariants.js` learns the optional `trucks` field.

*Files.* New: `js/model/schema.js`, `ops.js`, `calendar.js`, `tests/fixtures/golden/*`, `tests/sim.golden.*.test.js`, `scripts/rebaseline-golden.mjs`, `scripts/perf-baseline.mjs`. Edited: see 9.9.

*Acceptance.*
- A0.1 Golden: `JSON.stringify(sim.kpis())` after `advance(3600)` (warm-up 600) of the three examples with two seeds each equals the fixtures bit for bit.
- A0.2 The three legacy layouts and three captured share links satisfy `JSON.stringify(normalizeLayout(x)) === JSON.stringify(x)`, with `schema` 1 (checked on 2026-10-08 for the three examples, through `normalizeLayout` and through `exportProject`/`importProject`).
- A0.3 `schemaNeeded` unit tests: legacy layout gives 1; each row of the table in 5.2 gives its number; the maximum wins.
- A0.4 `importProject` warns for a file with a schema above `SCHEMA_MAX` and not for one at or below it; the existing serialize tests pass unchanged.
- A0.5 `npm run test:quiet` and `npm run check` pass; the added test time is below 15 s.

*Cut line.* None; it is small. *Risk.* Hot files; schedule it between waves, tell the wave owners the line ranges first.

### 9.2 M1 Trucks and dock doors

*Goal and decision unlocked.* How many doors, how deep the staging, how many forklifts the unloading needs, how far apart appointments must be; and whether the docks share the work.

*Scope.*
- Data: `ops.trucks` and `calendar { startTod, startDay }` (5.3), schema 2.
- Sim: `logistics/trucks.js` (6.3); hooks in `stepStation` (instead of `stepSource`), `flowSpace`, `flowCapacity`, `acceptLoads`, `rescaleArrivals`, `finishLoading` and the minimum batch of `collectDemand`; `stats-ops.js` (`ops.trucks`); insights `gate-queue-long`, `doors-bottleneck`, `unload-limited-by-vehicles`, `doors-idle`, `outbound-short`; validation `doors-too-few`, `doors-exceed-docks`, `docks-share-lane`, `timetable-empty`; cold restart for day plants in `runner.js`; `METRICS` and sweeps; dock share consumed from `DockBook.counters` if task 26 has shipped it.
- UI: 7.2 in full. Examples 1 and 2. Help page. Report rows.

*Files.* New: `js/model/validate-ops.js`, `js/sim/logistics/trucks.js`, `js/sim/stats-ops.js`, `js/sim/insights-ops.js`, `js/ui/panels/ops-trucks.js`, `timetable-paste.js`, `doors-card.js`, `js/ui/render/ops.js`, `js/ui/guidance-ops.js`, tests. Edited: 9.9.

*Acceptance.*
- A1.1 Golden unchanged.
- A1.2 Every `ops.trucks` key in `OPS_KEYS` survives `normalizeLayout`, export, import and the share link; ranges are clamped; junk is dropped; `ops` on other station types is dropped; a timetable creates the clock; a layout with `ops` has schema 2 and a legacy one still 1.
- A1.3 Conservation holds on every tick of at least 200 random plants with trucks (the invariants helper counts `pending`, `yardQ` and `staged` as live) and no `NaN` appears in `report.ops`.
- A1.4 The invariants of 6.3.5 hold on every tick of the same plants.
- A1.5 Little's-law cross-check: in a rate-mode plant with ample vehicles over 8 h, the time-average number of docked trucks equals the arrival rate times the mean door time within 5 %.
- A1.6 The door check reproduces the numbers of Appendix A.1 (6 trucks an hour, 26 pallets, 90 s: 4.9 doors; 5 doors at 98 %, 6 at 82 %).
- A1.7 Outbound pull: with `staging 0` and no truck at work nothing reaches the Goods out and the storage fill rises; with a truck pallets flow; a truck leaves full, or `maxDwell` after check-in short and only when `inboundTotal == 0`; `fillRate` equals loaded over planned.
- A1.8 Arrival timestamps of trucks are identical for `dt` 0.1 and 0.25; mean gate wait differs by less than a margin recorded at build time (twice the observed difference). Recorded: 15 s asserted, 7.1 s observed (one door, a truck every 200 s on average, mean wait 1,438.6 s at `dt` 0.1 against 1,445.7 s at 0.25): an event is applied on the first tick at or after its time, so every door time is rounded up to a tick and the queue adds that up.
- A1.9 Same seed gives an identical event digest; adding a truck station elsewhere does not change the arrival times of another station (fork independence).
- A1.10 "Add dock doors" keeps the pallet rate: Starter (180 s, batch 1) gives 24 pallets every 72 min; a 600 s floor raises the pallets instead of shortening the gap.
- A1.11 `parseTimetable` passes a table of at least 25 inputs (tab, semicolon, comma separators; `6:00`, `06:00`, `06.00`, `0600`, `6:00 Uhr`; decimal comma; header; bad rows; empty text) with expected rows and skips.
- A1.12 `docks-share-lane` fires on the Dock lab "row" variant and not on the "bays" variant; `doors-too-few` fires at the Appendix A numbers; `doors-exceed-docks` fires when doors exceed the station's dock cells.
- A1.13 Runner: an edit to a day plant restarts cold (`sim.time` 0 after the edit) and the impact card is hidden; an edit to a stationary truck plant restarts warm.
- A1.14 Dock lab: validates with zero errors; runs; its tips reproduce; in the row variant the first dock's share of visits is above 90 % and Checks shows the warning; in the bays variant each of the first two docks has more than 20 % (thresholds are calibrated on the built example and then fixed).
- A1.15 Playwright journey: Add dock doors, Play, the Doors card shows numbers, undo restores the plant, a share-link round trip keeps the doors, a pasted timetable is applied only after "Use N rows".
- A1.16 The performance gates of 10.5 hold for both new examples.

*Cut line (dropped first).* Paste from spreadsheet, the gate-queue sparkline, `jitter` and `noShow`, the extension of example 2, dock share bars if task 26 has not shipped them.

*Depends on* M0, and on task 26 for the dock share. *Risks* R3, R7, R8.

### 9.3 M2 Shifts, breaks, demand profiles

*Goal and decision unlocked.* Staffing per shift, door hours, breaks, and whether the peak hour survives.

*Scope.*
- Data: 5.3 (M2), schema 3.
- Sim: `model/calendar.js` (sanitizer, `compileTimeline`, `makeClock`, `tauInverse`); `logistics/staffing.js` (cursors); the three consumers of 6.2.4; the profile in `trucks.js` and `rescaleArrivals`; `ops.day`, `off` shares and on-shift denominators; insights `staffing-short`, `peak-hour-fails`, `shift-idle`; validation `shift-gap`, `staffing-needs-depot`, `staffing-over-count`, `profile-missing`, `calendar-unused`.
- UI: 7.3 in full; 3600x speed; impact card replacement. Examples 2 (extended), 3, 4.

*Acceptance.*
- A2.1 Golden unchanged.
- A2.2 `compileTimeline` agrees with a brute-force per-second evaluator on 100 random calendars (overnight shifts, `from == to`, overlapping shifts that add and cap at N, break waves, week wrap, empty staffing gives 0, unbound gives N).
- A2.3 `tauInverse`: monotone; `tau(c + 86400) = tau(c) + 86400`; zero hours skipped; `tau(tauInverse(x)) = x` within 1e-6; profiles normalise to mean 1.
- A2.4 Arrival counts per hour follow the profile over 30 simulated days at a fixed seed (chi-square against a threshold fixed at build time).
- A2.5 On every tick of the fuzz plants: no order is assigned to an off vehicle; an off machine never starts a cycle; trucks dock only while `docked < doorsOpen`; with `onEnd: "pause"` an off machine's cycle does not progress.
- A2.6 Off-duty vehicles with a reachable depot park within a bound recorded at build time; without a depot the validator warns and the lane still clears (yield) in the fuzz.
- A2.7 `dt` 0.1 versus 0.25 on a two-shift plant: breakpoints identical, KPIs within a tolerance recorded at build time (target 2 %).
- A2.8 With a clock, machine shares sum to 1 on on-shift time and fleet shares sum to 1 including `off`; fleets without a binding have no `off` key.
- A2.9 `needed` versus `staffed` per hour equals a hand-computed micro plant.
- A2.10 Cold restart and the "compare whole days" action (two variants, `duration` and `warmup` 86400).
- A2.11 Round trip of every schema-3 key; deleting a shift prunes its staffing rows; limits (12 shifts, 4 breaks, 8 profiles) hold.
- A2.12 UI: form-table edits commit with labels; strip drag snaps to 15 minutes and is keyboard operable; the matrix writes bindings; "Suggest staffing" shows a diff and writes nothing until accepted; Playwright: apply "2 shifts", run one day, the Day section shows 24 hours.
- A2.13 One simulated day of the reference example costs less than 20 s CPU; otherwise the idle fast-forward spike of R2 comes before M3.

*Cut line.* The bar-strip editor (the form table stays), "Suggest staffing", "Run to end of day", the by-shift "limited by" column, two of the five demand presets.

*Depends on* M1. *Risks* R1, R2, R9, R20.

### 9.4 M3 Racks and aisles

*Goal and decision unlocked.* Aisle width against equipment, number of levels, where aisle entrances and cross aisles go.

*Scope.*
- Data: 5.3 (M3), schema 4; `EQUIPMENT_LIMITS`; fleet presets `reach`, `palletjack`, `vna`.
- Sim: `model/rack.js`; `logistics/racks.js`; `st.capacity` derived; put-away and retrieval through hints (6.4.2); excursion (6.4.3); equipment constraint (6.4.4); `DockBook.choose(..., { only })` and the service extra, **agreed with the dock engineer before M0 is scheduled**; `ops.storage`; insights `storage-nearly-full`, `aisle-hotspot`, `lift-dominates`; validation `aisle-no-entrance`, `aisle-shared-entrance`, `fleet-cannot-serve-rack`, `rack-too-small`, `rack-face-single-lane`.
- UI: 7.4. Example 5. **M3a** is everything above with an inspector-only UI; **M3b** adds the tool option, the live ghost and "Draw head road" after the roads and canvas wave has merged.

*Acceptance.*
- A3.1 Golden unchanged.
- A3.2 `deriveRack`: positions monotone in the extents, never negative, `usable <= positions`, `aisles x module <= extent`; the Appendix A.2 numbers (990, 1,320, 1,980; 300 for the default 16 x 12 cell rack); the block formula.
- A3.3 On every tick of the fuzz plants with racks: aisle counts never exceed per-aisle capacity, their sum equals the loads held, a batch fits one aisle, a retrieval batch is the front run with one aisle index.
- A3.4 With injected bay and level, the excursion added at `startLoading` or `startUnloading` equals the formula exactly; legacy storage adds 0.
- A3.5 A fleet below the requirement never receives an order for a racked end; the validator distinguishes error and warning; the Fix button switches the preset.
- A3.6 An aisle without a head road is excluded from `usable` and warned about; drawing the road restores it.
- A3.7 `choose(..., { only })` restricts the choice; without it the ranking is unchanged and the golden test passes.
- A3.8 UI: the Form switch commits "Set storage form"; the derivation line equals `deriveRack`; Resize to fit proposes a legal rectangle or says by what it is blocked; Playwright: place a rack block, run, read the Storage card.
- A3.9 The performance gates of 10.5.

*Cut line.* `block` form, all of M3b, Resize to fit, `rack-face-single-lane`.

*Depends on* M1 (M2 not required) and the dock-book API agreement. *Risks* R6, R16.

### 9.5 M4 Slots, outbound plans, on-time-in-full

*Goal and decision unlocked.* Slotting policy, staging need, cut-off feasibility.

*Scope.* Schema 5. `logistics/slots.js` (6.4.5); exact excursion per slot; fill by aisle; outbound plan release, `depart`, `grace`, on-time-in-full (6.4.6); `ops.service`; insights `late-trucks`, `otif-low`, `staging-short`; validation `plan-after-cutoff`; UI 7.5. This is the largest and least certain item; it is sized L and its detail is settled at the start of the milestone.

*Acceptance.* Slot count equals positions; slots used equal loads held; no slot is occupied twice (fuzz); policies are deterministic; `nearest-free` gives the first load the slot nearest the head and a lower mean excursion than `random` for a fixed seed; on-time-in-full arithmetic on a micro plant; pre-staging never exceeds the staging space; a truck leaves at `depart`; conservation including `staged`; golden unchanged. *Cut line.* `nearest-free`, `staging-short`.

### 9.6 M5 Load types

*Scope and acceptance.* Schema 6; 6.6 in full; UI 7.5. Tests: per-type conservation on every tick of typed fuzz plants; a typed round trip; the unique-flow-pair rule still holds (an explicit test); `type-no-home` errors; storage `accepts`; per-type report; golden unchanged. *Cut line.* `cycleFactor`, `velocity` and the `abc` policy.

### 9.7 M6 Picking and labour (stretch)

Outline in 6.5. Not scheduled before question 1 is answered; if the first customer is a case-picking distribution centre this moves ahead of M5 and gets its own design pass.

### 9.8 Definition of done, every milestone

1. `npm run test:quiet` and `npm run check` pass; new tests live flat in `tests/`, each file under 10 s of CPU; the golden test is unchanged.
2. `docs/ARCHITECTURE.md` is amended where the code changed (sections 3, 4.2, 4.5, 4.8, 5.3, 5.4, 6.4, 6.5, 6.9); the README "Known limits" line that says shift calendars are not modelled is corrected when M2 ships.
3. A Help page, the example(s), report export rows, Experiments metrics and sweep parameters.
4. A Playwright journey under `tests/e2e/` and light, dark, desktop and narrow screenshots reviewed.
5. Share link and autosave round trip checked, including a file of the previous schema.
6. The pull request text states CPU seconds per simulated hour of the three legacy examples before and after.
7. Every default marked "to verify" in this document is either verified against a source or labelled indicative in the UI.

### 9.9 Hot-file edit list

Calls only; logic is in new files. "Wave" is the engineer group that edits the file now.

| File | Wave | Edit | M |
|---|---|---|---|
| `js/model/layout.js` | roads and canvas | M0, about 30 lines at six sites: import; `normalizeStations` (`ops`); `normalizeLayout` (extensions, stamp); `updateStation` (`ops`); `duplicateStation` (copy `ops`); `checkInvariants` (schema). M2 and M3: `sanitizeFleet`, `applyFleetPatch` and the fleet check accept `calendar`, `aisleMin`, `liftHeight` (`duplicateFleet` already clones whole fleets); `removeStation`, `removeFleet` call `pruneRefs` | 0, 2, 3 |
| `js/model/serialize.js` | | project schema and warning threshold, three lines | 0 |
| `js/model/defaults.js` | | `SCHEMA_MAX` note; fleet presets | 0, 3 |
| `js/model/validate.js` | | one call to `validate-ops.js` | 0 |
| `js/sim/logistics.js` | | load and order shapes; `ext` and `clock` fields; `markDirty` at breakpoints | 0, 2 |
| `js/sim/logistics/stations.js` | | `st.capacity` (five reads); M1 `stepSource`, `flowSpace`, `acceptLoads`, `rescaleArrivals`; M2 `stepMachine`; M3 `storeLoad`, `flowSpace` | 0 to 3 |
| `js/sim/logistics/vehicles.js` | | M1 `finishLoading` (two lines); M2 `isAvailable`; M3 `startLoading`, `startUnloading`, `legTarget` | 1 to 3 |
| `js/sim/logistics/dispatcher.js` | | M0 line 79 (`st.capacity`); M3 `evaluate`, `assign`, `collectDemand` | 0, 3 |
| `js/sim/logistics/docks.js` | dock work | M3 `choose` option and `serviceTime` extra; agree first | 3 |
| `js/sim/logistics/idle.js` | | off-duty parking | 2 |
| `js/sim/stats.js` | | five hook sites; M2 off keys and on-shift denominators | 0, 2 |
| `js/sim/insights.js` | | one hook | 0 |
| `js/sim/experiments.js` | | `METRICS` entries, sweep parameters | 1 to 3 |
| `js/ui/panels/inspector.js` | | three lines (section builders) | 1, 3 |
| `js/ui/render/bricks.js` | canvas | one call to `drawDoors` and later `drawAisles` | 1, 3 |
| `js/ui/dashboard.js` | | mount the Doors, Day, Storage cards | 1 to 3 |
| `js/ui/runner.js` | | `warmWanted`, `SPEEDS`, clock chip data | 1, 2 |
| `js/ui/app.js` | canvas | one tab line (Shifts); clock chip | 1, 2 |
| `js/ui/guidance.js`, `dialogs.js`, `report.js`, `panels/impact.js` | | a hook, Help page and gallery, rows, day-plant condition | 1, 2 |
| `js/ui/editor/tools.js`, `place.js`, `js/store/store.js`, renderer files | **roads and canvas** | **only M3b, after that wave has merged** | 3b |

**As built (lines added / removed against the commit before, by `git diff --numstat`; code authoritative).** *M0* (`030ea67` to `a2af6d8`): `layout.js` 28 / 5, `serialize.js` 21 / 5, `defaults.js` 5 / 0, `validate.js` 2 / 0, `logistics.js` 6 / 1, `stations.js` 17 / 5, `dispatcher.js` 1 / 1 (the `st.capacity` read), `stats.js` 9 / 1, `insights.js` 7 / 0, and the new `extensions.js` (58 lines, the `reconcileLayout` seam that the design did not list). *M1* (`a2af6d8` to the M1 verification): `layout.js` 36 / 3 (`updateCalendar`, `addStation` ops, `duplicateStation` reconcile, `checkExtensionBlocks`), `serialize.js` 9 / 1, `logistics.js` 9 / 2, `stations.js` 27 / 3, `dispatcher.js` 5 / 3 (the minimum-batch clamp `batchCeiling`, one call), **`vehicles.js` 1 / 0** (one line in `finishLoading`, not two), `insights.js` 60 / 4, `experiments.js` 57 / 1, `examples.js` 127 / 4, `inspector.js` 14 / 4, `bricks.js` 5 / 0 (one `planOps` and one `paintOps` call), `dashboard.js` 6 / 2, `runner.js` 6 / 1, `app.js` 18 / 4, `guidance.js` 7 / 1, `report.js` 16 / 8, `impact.js` 3 / 2, `compare.js` 17 / 7, `checks.js` 3 / 1, `nextsteps.js` 3 / 1, `dialogs.js` (the Help page and, later, the About dialog). Not in the table of the design but touched by M1: `js/ui/editor.js` (2 / 1) and `js/ui/editor/keys.js` (14 / 0), because Delete and the arrows on a focused button of the timetable deleted or nudged the selected brick (UX review, `isOperatedControl`); `ui/panels/fields.js` (5 / 1, the stepper stores a typed out-of-range number at the nearest limit: "33" doors end at 32; it is the stepper of every panel); `scripts/test-tiers.mjs` (7 shards instead of 5), `.github/workflows/ci.yml` and `pages.yml` (the shard list). `docks.js`, `idle.js`, `graph.js`, `traffic.js` and the renderer files other than `render/bricks.js` are untouched.

---

## 10. Test strategy

### 10.1 Golden fixtures (the safety net)

`tests/fixtures/golden/` holds, for each of the three examples and seeds 1 and 2: `JSON.stringify(sim.kpis())` after `advance(3600)` with `warmup` 600, plus the three example layouts and three share links captured with `shareUrl`. Three test files (one per example, each under 10 s) assert bit equality after every milestone. One command, `scripts/rebaseline-golden.mjs`, rewrites the fixtures; the pull request that runs it must say why. The only planned re-baseline is the one after the dock work; any other change in legacy output is a bug.

### 10.2 Round trip and schema

The `OPS_KEYS` table drives one test per area: every documented key, sampled with valid values, survives `normalizeLayout`, `exportProject` and `importProject`, and the share link; unknown keys are dropped; ranges are clamped; `schema` equals `schemaNeeded`. Legacy fixtures stay byte-identical.

### 10.3 Determinism and `dt`

Same seed, same event digest (`eventDigest` in `tests/helpers/logistics-invariants.js`). Adding a feature to one station never changes the draws of another (fork independence). Exact-time events (arrivals, breakpoints) have identical timestamps for `dt` 0.1 and 0.25; KPI differences between the two are bounded by tolerances that are **recorded at build time and then fixed**, not guessed here.

### 10.4 Invariants and fuzz

`tests/helpers/logistics-invariants.js` and the generators are extended per milestone (trucks, doors, off duty, aisles, slots, types) and run on every tick of the fuzz plants. The conservation law, the claimed-prefix rule, capacities and the new invariants of 6.3.5 are checked there.

### 10.5 Performance gates

Measured as CPU seconds with `process.cpuUsage` (as `sim.traffic.perf.test.js` does; wall clock is meaningless on a busy machine, see 4.2):
- Legacy examples: at least 500 times real time (automatic) and within 10 % of the CPU seconds per simulated hour recorded by `scripts/perf-baseline.mjs` at M0 (a manual line in the pull request).
- Every new example: at least 500 times (automatic), target 2,000.
- One simulated day of the reference two-shift example: under 20 s CPU (M2 gate).

### 10.6 UI

Pure helpers are unit-tested in Node (`parseTimetable`, copy builders, `guidance-ops`, the door check text). Browser behaviour is covered by Playwright journeys (`npm run test:e2e`).

### 10.7 Tips

Each example's tips are reproduced by a test at the default run length before they ship (the existing "tips" test pattern).

---

## 11. Risk register

Likelihood (L) and impact (I): H high, M medium, L low.

| ID | Risk | L | I | Mitigation | Owner and trigger |
|---|---|---|---|---|---|
| R1 | **Non-stationarity.** Warm restart, the 600 s impact window with its noise bands, the 20-minute insight windows and the 8 h default run assume a plant without a daily rhythm | H | H | Cold restart for day plants; Results by whole days; "Compare whole days" replaces the impact card; a day plant never gets a "good" insight while a peak hour fails; follow-up: same-time-of-day window if question 3 asks for it | M1 (clock) and M2; decided in 6.2.7 |
| R2 | **Day-long runs are slow.** One simulated day is 9 to 43 s on a plant of the example size (4.2); replications multiply it | M | H | Default measured length one day after one warm-up day; weeks warn; measure at M2; if above 20 s CPU per day, an idle fast-forward spike (skip ticks while no event is due) comes before M3 | M2 acceptance A2.13 |
| R3 | **Hot-file collisions** with the roads, canvas and CI work | H | M | M0 in one window with line ranges announced; all logic in new files; calls of a few lines (9.9); M3b waits for the wave | M0 scheduling |
| R4 | **Golden fixture churn** because the dock work changes legacy behaviour | M | M | Capture after task 27; exactly one re-baseline; rebaseline script and rule (10.1) | M0 gate |
| R5 | **Silent data loss** in `normalize*` | M | H | Explicit sanitizers; `OPS_KEYS` round-trip tests; one schema number per milestone so older tabs warn | every milestone |
| R6 | **False precision** of derived capacity, door needs and aisle times | H | M | Show the arithmetic, label indicative, make every default editable, offer a calibration run against the planner's own day; defaults flagged "to verify" (R15) | UI 7.1 principle 3 |
| R7 | **Door semantics confusion.** A door is a capacity, not a road cell, so "door 2 = that cell" is not modelled | M | M | Explicit copy ("doors are positions for trucks; vehicles use whichever dock the dock book chooses"); dock share bars on dock cells; question 2 | M1 |
| R8 | **Docks in a row cannot share work** (physics, measured). A "far end first" rule might help but is unproven | M | L | Validator `docks-share-lane`, the Dock lab, Help text; hand the idea to the dock engineer as a follow-up without a promise | M1 |
| R9 | **Off-duty vehicles block lanes** or strand without a depot | M | H | Park through the existing logic; yield logic; `staffing-needs-depot`; fuzz with random staffing | M2 A2.6 |
| R10 | **Typed flows** tempt someone to relax the one-flow-per-pair rule | L | H | Rule kept; explicit test in M5; typed destinations by station (6.6) | M5 |
| R11 | **Complexity for the first-time planner** | M | M | Everything off by default; one button per feature; defaults that run; `info`-level guidance only; examples first | UX principle 2 |
| R12 | **Paste parsing ambiguity** (`06.00`, `1,5`, merged cells) | M | L | Preview before apply; row-level errors; never guess silently; Node-tested table | M1 A1.11 |
| R13 | **Scope creep** into picking and warehouse-management logic | M | M | Non-goals (3.3); M6 gated by question 1 | product owner |
| R14 | **Test-suite time** (about 3 minutes today) grows with golden and fuzz | M | L | Each file under 10 s CPU; golden split per example | CI |
| R15 | **Unverified domain defaults.** Aisle widths, lift and travel speeds, bay sizes, pallets per truck, the 90 s per pallet door assumption and the literature on pick tours are typical values written from memory in the drafts and not checked against sources | M | M | Mark every default "to verify" in the code table; verify against supplier data sheets before release or label as indicative | every milestone's definition of done, item 7 |
| R16 | **Dock-book API** needed by M3 (`only`, service extra) is an assumption not yet agreed | M | M | Agree the two optional parameters with the dock engineer before M0 is scheduled | M3 gate |
| R17 | **Lead time changes meaning** when trucks are on (gate wait is included) | L | M | Say so in the Doors card and Help; the legacy definition is untouched without trucks | M1 |
| R18 | **Stats additions slow the hot path** | L | M | One extension object, typed arrays, no allocation per tick; the CPU gate | 10.5 |
| R19 | **Eight tabs on a 360 px panel** | L | L | Existing icon-only strip; badge on Shifts only for a real shortfall | M2 |
| R20 | **Insight thresholds** tuned for stationary plants misfire on a day plant | M | M | Rules read on-shift shares and carry a window; `peak-hour-fails` precedes "good" | M2 |

---

## 12. Decisions needed from the user

Five questions. Nothing blocks M0 and M1; the defaults below are chosen so that agreeing with them needs no rework.

1. **Who is the first customer: a pallet warehouse (receiving, racks, shipping) or a distribution centre that picks cases for orders?**
   *Recommended:* the pallet warehouse. Picking (M6) stays unscheduled, and M4 comes before M5.
   *If otherwise:* picking and labour hours move ahead of load types and get their own design pass (+6 to 8 days); the pallet is the wrong grain for order lines, so picking would use the analytic tour approximation only, and the KPIs change to lines per hour.

2. **Must a dock door be tied to a particular spot on the wall (door 2 is this road cell)?**
   *Recommended:* no. A door is a count of truck positions; vehicles use whichever dock cell the dock book chooses, and the dock share bars sit on the dock cells.
   *If yes:* the ports refactor of the ops draft is needed (+8 to 12 days in four hot files, after the dock work), giving per-door staging and "this pallet sits at door 2"; it would be scheduled between M1 and M2.

3. **For a plant with a daily rhythm, should an edit restart the simulation from the start of the day (cold restart), as recommended, or continue as today?**
   *Recommended:* cold restart; the "effect of your change" card is replaced by "compare whole days".
   *If continue:* the pre-roll must end at the same time of day as the plant on screen, so an edit costs up to a simulated day of pre-roll (9 to 43 s now); that needs the idle fast-forward first (+2 to 3 days and the R2 spike) and a same-time-of-day comparison window.

4. **Which standard should the defaults use: metric with the euro pallet (1.2 x 0.8 m, 24 pallets per truck), or US (48 x 40 in pallet, 26 per 53 ft trailer)?**
   *Recommended:* metric and euro pallet (the app is metric today).
   *If US:* only the defaults differ (pallet footprint, truck size, bay width); since a block stores all its fields once created, a later change of defaults affects new blocks only and needs no migration.

5. **Do you want money in the results (cost per pallet, labour and equipment rates), or hours and counts only?**
   *Recommended:* hours and counts only (paid versus productive labour hours in M2).
   *If money:* rates become inputs in the Shifts tab, a Cost card appears, and the figures look more exact than the inputs justify (+3 to 4 days, and risk R6 grows).

---

## Appendix A. Formulas and worked examples

### A.1 Door check (6.3.4)

`doorHours = (checkIn + pallets x tPallet + checkOut) / 3600`; `doorsNeeded = peakTrucksPerHour x doorHours`.
Example: 26 pallets at 90 s is 39 min; with check-in and check-out of 5 min each a truck holds a door for 49 min = 0.817 h. At 6 trucks an hour: 6 x 0.817 = 4.9 doors busy at once. 5 doors run at 98 %, 6 doors at 82 %. Because the 39 minutes are set by the vehicles, doors and forklifts have to be traded together.

### A.2 Derived rack (6.4.1)

Reference store: 32 m x 24 m (16 x 12 cells of 2 m), the 24 m side faces the road, 5 levels, depth 1, `rowDepth` 1.1 m, `bayWidth` 2.7 m, 3 pallets per bay, `reserve` 5 %. Recomputed by the judge; they match the ops draft.

| Equipment | Aisle | Module | Aisles | Bays | Positions | Usable | m2 per position |
|---|---|---|---|---|---|---|---|
| Counterbalance | 4.0 m | 6.2 m | 3 | 11 | 990 | 940 | 0.78 |
| Reach truck | 3.0 m | 5.2 m | 4 | 11 | 1,320 | 1,254 | 0.58 |
| Narrow-aisle | 1.8 m | 4.0 m | 6 | 11 | 1,980 | 1,881 | 0.39 |

Default new rack (16 m x 12 m, reach truck): module 5.2 m, 2 aisles, 5 bays, 300 positions (285 usable).

Mean excursion of the reference rack (6.4.3), aisle speed 2.5 m/s, lift speed 0.4 m/s, set time 15 s, 11 bays, 5 levels: mean distance to the bay 14.85 m gives 11.9 s; mean lift `(l - 1) x 1.8 m` = 3.6 m gives 18.0 s; plus 15 s = 44.9 s. With `l x 1.8 m` (the ops draft's convention) it would be 53.9 s.

### A.3 Demand profile (6.2.5)

```
m[h]  = hourly[h] / mean(hourly)                      // mean 1, so the daily total is unchanged
tau(c)= integral of m(s) ds, 0..c                     // c = seconds since midnight of day 0; tau(c + 86400) = tau(c) + 86400
tauInverse(x):  d = floor(x / 86400); r = x - d * 86400
                for h = 0..23: seg = m[h] * 3600
                               if m[h] > 0 and r <= seg: return d * 86400 + h * 3600 + r / m[h]
                               r -= seg
                return (d + 1) * 86400                // rounding edge only
```

### A.4 Break waves (6.2.3)

Count 4 with `groups` 2: two waves of 2 units each, each for half the window. Count 3 with `groups` 2: wave 0 takes 2 units, wave 1 takes 1. `groups` 1: all units for the whole window.

### A.5 Conversion (6.3.1)

Starter: 1 pallet every 180 s = 20 per hour. Pallets per truck 24, gap = 24 x 180 / 1 = 4,320 s = 72 min. Congestion lab: 4 pallets every 400 s = 36 per hour; gap = 24 x 400 / 4 = 2,400 s = 40 min.

---

## Appendix B. Validation codes and insight rules

Validation uses the existing `Issue` shape and stable ids (`code:ref`). Severities in brackets. The four checks of M1 run only for stations that have `ops.trucks` (a legacy plant gets no new issue); their ref is the station id.

| Code | M | Fires when | Fix |
|---|---|---|---|
| `doors-too-few` (warning) | 1 | the door check (A.1) puts the doors above 95 % busy (`needed / doors > 0.95`; A.1 itself says 5 doors for 4.9 needed run at 98 % and the queue explodes, so the rule does not wait for `needed` to exceed the doors) | Use N doors: the fewest that are at most 85 % busy; no button where even 32 doors would stay above 95 % (the message then says so) |
| `doors-exceed-docks` (warning) | 1 | more doors than road cells touching the station (a station with no road cell at all has `station-no-dock` instead) | Extend the road along the edge |
| `docks-share-lane` (warning) | 1 | two or more dock cells of a station are neighbouring road cells along its edge and the road is joined between them (a link either way). A second road behind them does NOT end the lane: measured, the first dock took every visit with and without one (Appendix C) | Show docks |
| `timetable-empty` (warning) | 1 | schedule mode with no rows | Add a row |
| `shift-gap` (warning) | 2 | a day has uncovered hours while a source without door binding keeps producing | Show shifts |
| `staffing-needs-depot` (warning) | 2 | a fleet is bound to shifts but no depot is reachable | Add parking |
| `staffing-over-count` (info) | 2 | a staffing count exceeds the resource count (clamped) | Set to N |
| `profile-missing` (warning) | 2 | a binding names a profile that is absent or all zero | Pick a profile |
| `calendar-unused` (info) | 2 | shifts exist but nothing is bound | Open Shifts |
| `aisle-no-entrance` (error with flows, else warning) | 3 | no road cell touches the head of an aisle | Draw head road / Show access side |
| `aisle-shared-entrance` (warning) | 3 | two aisles share one head cell | Show grid-fit widths |
| `fleet-cannot-serve-rack` (error if no allowed fleet can, else warning) | 3 | aisle or lift requirement not met | Switch fleet to Reach truck |
| `rack-too-small` (warning) | 3 | zero usable positions | Resize to fit |
| `rack-face-single-lane` (info) | 3 | aisle heads lie on one through lane with no parallel road | Show access side |
| `plan-after-cutoff` (warning) | 4 | `depart - releaseLead` lies before time 0 or before the previous truck left | Shorten the lead |
| `type-no-home` (error) | 5 | a type is produced that no outgoing flow accepts | Add types to a flow |
| `type-refused` (warning) | 5 | a flow delivers a type the destination refuses | Allow the type |

Insight rules (thresholds are named constants at the top of `insights-ops.js`; with a clock each carries `refs.window`). The ids of the M1 rules carry the station (`gate-queue-long:A`), the usual pattern of the older rules. The older `supply` rule ("A delivers more than the plant takes") is not applied to a Goods in with trucks: a truck releases its pallets into the yard at once, so the yard of a healthy station is full while a truck is unloaded.

| Rule | M | Severity | Condition |
|---|---|---|---|
| `gate-queue-long` | 1 | warning from mean gate wait 15 min, critical from 45 min | mean gate wait above the constant: the larger of the mean of the trucks that docked and the Little estimate from the queue (a queue that only grows is not hidden); at least three trucks in the window |
| `doors-bottleneck` | 1 | warning | door utilisation at least 85 %, gate wait at least 5 min, and not `unload-limited-by-vehicles`; also not `outbound-short` on a Goods out, and not on a Goods in whose pallets are held back for a reason the older rules name. On a Goods out the advice adds that more doors only move the wait from the gate to the door when the trucks mostly wait for pallets |
| `unload-limited-by-vehicles` | 1 | warning | doors busy or trucks queue, while the Goods in is blocked (staging full) at least 25 % of the time or pallets wait 2 min or more for a vehicle, and the verdict of the older transport rules is docks, traffic or vehicles: "the doors are not the problem, the forklifts are" |
| `doors-idle` | 1 | info | at least 2 doors, utilisation below 30 %, gate wait below 1 min |
| `outbound-short` | 1 | warning | at least 10 % of trucks left short |
| `docks-unbalanced` | 1 | info | three or more docks and one holds at least 90 % of the visits. Exists since the dock work (task 26); in a plant with trucks it says "the docks lie one behind the other on one lane" for a row of docks, as the Checks tab does |
| `staffing-short` | 2 | warning | needed above staffed in an hour window |
| `peak-hour-fails` | 2 | warning or critical | any hour with gate wait at or above the threshold or staffing short; blocks the "good" insight |
| `shift-idle` | 2 | info | a shift's utilisation below 35 % |
| `storage-nearly-full` | 3 | warning from 90 % mean fill, critical when full more than 10 % of the time | |
| `aisle-hotspot` | 3 | info | one aisle holds at least twice the average hold time |
| `lift-dominates` | 3 | info | lift time above half the excursion at 5 or more levels |
| `late-trucks`, `otif-low` | 4 | warning | on-time-in-full below 90 % |

---

## Appendix C. Measurement recipes

Run from the repository root with Node 22. Neither script is committed; the first is the basis of the Dock lab and of its test.

Dock distribution (section 4.1):

```js
import { createLayout, paintRoadPath, addStation, addFlow, addFleet } from './js/model/layout.js';
import { Simulation } from './js/sim/engine.js';
function build(spurs) {
  const L = createLayout({ name: 'Dock lab', cols: 40, rows: 24, cellSize: 2 });
  paintRoadPath(L, [[4,10],[30,10],[30,18],[4,18],[4,10]]);                       // two-way loop
  const gap = { kind: 'normal', mean: 14, spread: 0.2 };
  if (!spurs) addStation(L, { type: 'source', name: 'Goods in', x: 10, y: 8, w: 6, h: 2, params: { interArrival: gap, outCap: 12 } }); // six docks in a row
  else {
    addStation(L, { type: 'source', name: 'Goods in', x: 10, y: 4, w: 7, h: 2, params: { interArrival: gap, outCap: 12 } });
    for (const x of [10, 13, 16]) paintRoadPath(L, [[x, 10], [x, 6]]);              // three bays
  }
  const sink = addStation(L, { type: 'sink', name: 'Goods out', x: 31, y: 13, w: 3, h: 2 });
  const park = addStation(L, { type: 'depot', name: 'Park', x: 8, y: 19, w: 3, h: 2, params: { slots: 8 } });
  paintRoadPath(L, [[9, 18], [9, 19]]);
  const src = L.stations.find((s) => s.type === 'source');
  addFlow(L, src.id, sink.id);
  addFleet(L, 'forklift', { name: 'FL', count: 8, home: park.id, capacity: 1 });
  return L;
}
for (const spurs of [false, true]) for (const enabled of [true, false]) {
  const sim = new Simulation(build(spurs), { seed: 3 });
  sim.logistics.docks.enabled = enabled;
  sim.advance(3 * 3600);
  const src = sim.stations.find((s) => s.type === 'source');
  console.log({ spurs, dockBook: enabled }, sim.logistics.docks.counters(src.id).map((d) => d.visits));
}
```

Result on 2026-10-08: `[465,0,0,0,0,0]` for the row with the dock book on or off; `[311,155,2]` for the bays with it on and `[397,0,0]` with it off. On the tree of milestone M1 (the dock work merged and tuned since) the same recipe gives `[465,0,0,0,0,0]` for the row and `[310,156,1]` for the bays (seed 3, 3 simulated hours). With a second road behind the row joined to every dock cell the row gives `[202,0,0,0,0,0]` (the first dock takes every visit), joined only at its ends `[372,0,0,0,0,0]` (in both the other five docks get no visit at all) (`tests/m1.model.review.test.js`, M1-MODEL-REV-3): the reason `docks-share-lane` does not look at what lies behind the docks.

Speed (section 4.2): for each of `EXAMPLES`, `new Simulation(ex.build(), { seed: 1 })`, time `sim.advance(3600)` with `performance.now()` and print `3600 / seconds`.

---

## Appendix D. Glossary

**Dock:** a road cell that touches a station; vehicles stop on it to load or unload. **Dock book:** the part of the simulation (`logistics/docks.js`) that chooses a dock and keeps per-dock counters. **Door:** a truck position of a Goods in or Goods out; a count, not a road cell. **Gate:** the queue where trucks wait for a free door. **Staging:** pallets waiting next to the doors. **Plan:** the pallets a Goods out truck is to take. **Day plant:** a plant with a clock (`layout.calendar`). **Shift, staffing, profile:** when a resource is available, how many units, and a 24-hour demand curve. **Head cell / aisle head:** the road cell in front of an aisle opening. **Module:** aisle width plus the two racks beside it. **Positions, usable:** pallet places built, and those left after the reserve and unreachable aisles. **Excursion:** the time a vehicle spends inside an aisle for one pallet. **On-time-in-full:** a truck left on time with its full plan (truck level). **Golden fixture:** recorded results of the legacy examples that must never change. **Cut line:** what is dropped first when a milestone runs late.
