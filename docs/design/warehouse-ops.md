# Warehouse operations: model and roadmap

Status: design proposal, 2026-10-08, written from a read of the code, which is authoritative where it differs.
Scope: the warehouse module, meaning how LogiPlan models inbound trucks, dock doors, storage, picking and outbound loading so that a planner can decide where docks, racks and aisles go, how many vehicles and pickers are needed, and how trucks and shifts load the system. Shifts, breaks and demand profiles are designed separately; section 9 lists the hooks needed from them.

## 1. Thesis

1. Today `storage` is a bag with a typed-in number. Capacity is not derived from the rectangle, a put-away costs the fleet's constant `loadTime`, `rack` obstacles are decoration, and stock leaves by itself as soon as `dwell` has passed and a vehicle is free. A planner cannot learn anything about doors, racks or aisles from it.
2. Four mechanisms fix that, not a second simulator: **ports** (named access points of a station: dock doors, aisle heads), **derived geometry** (rack capacity and in-aisle time computed from the rectangle and a few rack parameters), **pull** (stock leaves a warehouse only when an outbound truck's load plan asks for it) and **trucks as events** (gate queue, check-in, door time, cut-off).
3. Trucks never drive on the road grid and pickers are not vehicles. In-aisle travel is a time term while the vehicle holds the aisle-head dock cell (vehicles never drive inside stations, ARCHITECTURE 4.2).
4. Everything is optional. A station without the new `ops` block behaves bit-identically to today (guarded by a golden test, section 11).
5. Five phases (W0 to W4, section 11), each ending in a decision a planner cannot take today.

## 2. Decisions a planner makes, and where the model stops

| Decision | Model must know | Today |
|---|---|---|
| How many dock doors, which ones for what | peak trucks/h, door time (check-in + unloading + check-out), gate queue | `source` has `interArrival` + `batch`; no door, no truck wait, unloading is instant |
| Rack type, aisle width, depth, levels | positions vs floor area vs equipment; in-aisle and lift time | `capacity` typed; `loadTime` constant |
| Where aisle entrances and cross aisles go | which road cell serves which aisle, blocking | all docks of a station are interchangeable; `RouteCache.docksOf` ranks them statically (returnable, distance, node id), ignoring who stands on them, so vehicles coming from the same side all pick the same one (the reported dock bug) |
| Vehicles and pickers per shift | demand by hour, staffing by shift, breaks | `fleet.count` constant, no calendar |
| Does the day work (peak hour, shift end, cut-off)? | time of day, release and cut-off | stationary arrivals; KPIs are run averages |
| Outbound on time | truck appointment, load plan, OTIF | `sink` consumes a load on delivery |

## 3. Element by element: minimal model and deliberate omissions

| Element | Minimal model | Left out, and why |
|---|---|---|
| Yard, gate | FIFO gate queue (appointment trucks by slot); wait is a KPI; not on the road grid | yard geometry, shunting: no layout decision hangs on it |
| Dock doors | N doors per goods-in or goods-out: one dock cell plus a staging lane each | leveller types, per-door equipment (use load-type zones) |
| Appointments | schedule or rate profile, lateness, no-show share | carrier behaviour, detention fees |
| Receiving, QC | per-pallet delay plus a QC share with a longer delay, before the pallet is storable | clerk capacity, ASN matching, damages |
| Put-away | directed: slot reserved at dispatch; nearest-free, random, ABC-zoned, fixed-by-type | re-slotting, task interleaving optimisation |
| Block stacking | lanes x depth x stack height, LIFO per lane, usable share below 1 | single stack positions |
| Pallet racking | aisles x bays x levels x depth derived from the rectangle; slot table; one vehicle per aisle | beam loads, sprinklers, seismic rules |
| Shelving, pick faces | pick zone with stock in lines, min/max replenishment | per-SKU faces: stock is pooled per load type |
| Order picking | pick-by-order, batch, zone, wave change tour length and release timing through formulas | pick-path simulation, aisle collisions between pickers |
| Packing, staging | packing is a workstation; staging is the door lane capacity | station ergonomics |
| Outbound loading | load plan per truck, release lead time, cut-off, short and late flags | customer-level consolidation optimiser, drop sequencing |
| Returns | by composition: a goods-in with its own mix, flow split restock/scrap | grading, disposition rules |
| Resources | fleet presets reach truck, VNA, pallet jack (`aisleMin`, lift height and speed); pickers are machines | skills, individual speeds |
| Cross-docking | free: goods-in door lane to goods-out door lane by a flow | none |

## 4. The one structural change: ports

A **port** is an access point of a station with its own dock cells, queue and space bookkeeping.

```js
Port = { id: 's3#d2', stationId, kind: 'default'|'door'|'aisle',
         nodes: number[],      // dock graph nodes serving this port (subset of graph.docks.get(stationId))
         lanes: Map<flowId, queue>, cap, lock: 0|1 }
```

A legacy station has one `default` port with all its dock nodes, so behaviour does not change. A door port has one node (or a pinned few); an aisle port has the node nearest to the aisle head.

Dispatch works on **lanes** (flow, source port, destination port). Concretely: `collectDemand` and `flowSpace` iterate lanes instead of flows; `readyLoads`, `unclaimLoads`, `finishLoading` use the port's queue instead of `flow.outLink`; `legTarget` in `vehicles.js` and `bestDock`/`pickupDock` in `routing.js` take a node set instead of a station id. `lg.stations` stays 1:1 with the layout (`Stats._build` indexes it by position and the report is keyed by station id); ports hang under `StationRT.ports`.

**Dock-choice fix (in progress elsewhere).** The team's task list calls it a "DockBook" (`js/sim/logistics/docks.js`, not in the tree yet), so what follows is a requirement on it. Do not build a second chooser. The DockBook must accept a candidate node set and rank by returnable, then occupancy, then distance; ports pass their `nodes`. When a load sits in door 2's lane, the pickup dock is door 2's cell by construction. Sequence W0 after that merge (`routing.js`, `dispatcher.js`, `vehicles.js` are hot files).

## 5. Inbound: trucks, gate, doors

Config lives in a new `station.ops` block (sibling of `params`). Reason: `sanitizeParams` (layout.js) drops unknown keys and treats every nested object as a time distribution, and `normalizeLayout` rebuilds a layout from known keys only, so nested or array data in `params` would be silently mangled. `ops` is owned by a new pure module `js/model/warehouse.js`.

```jsonc
// source ("Goods in") with 4 doors
"ops": { "doors": { "count": 4, "pinned": null,           // null: first 4 dock cells along the edge; or [[cx,cy],...]
                    "staging": 4,                         // pallets per door lane (replaces outCap)
                    "checkIn": 300, "checkOut": 300, "assign": "first-free" /*|'balanced'|'nearest-dest'*/ },
         "trucks": { "mode": "schedule",                  // or "rate": params.interArrival + demand profile
                     "schedule": [{ "at": "06:00", "pallets": 26, "mix": null }],
                     "pallets": { "kind": "uniform", "mean": 26, "spread": 0.2 },   // used in "rate" mode
                     "lateness": { "kind": "normal", "mean": 0, "spread": 0.5, "window": 1800 }, "noShow": 0.02 },
         "receiving": { "time": { "kind": "normal", "mean": 20, "spread": 0.3 }, "qcShare": 0.05,
                        "qcTime": { "kind": "const", "mean": 1200 } } }
```

Truck lifecycle (scheduled on nominal time like `stepSource`, so independent of `dt`):

1. **Arrive**: pallets are created now (`createdAt` = gate arrival, so `leadTime` includes yard wait; the conservation law created = live + retired is unchanged).
2. **Gate queue** until a door is free and open (calendar hook H4).
3. **Docked**: after `checkIn`, pallets move one at a time into the door's staging lane while it has room; `readyAt` = release + receiving delay.
4. **Unloading is emergent**: vehicles claim pallets from the lane. Door time therefore depends on vehicle count, the real interaction; there is no unload-rate parameter.
5. **Empty**, then `checkOut`, then the door is free.

`demandFactor` scales arrival rate in `rate` mode and pallets per truck in `schedule` mode (appointments do not move when demand grows).

Check shown in the inspector (Little's law): peak trucks/h x door time = door-hours needed per hour. Example: 6 trucks/h x (5 + 39 [26 pallets at 1.5 min] + 5 min = 0.82 h) = 4.9, so 5 doors run at about 98 % and the gate queue explodes; 6 to 7 doors are needed. The 39 min is itself set by forklifts, so doors and forklifts must be traded together.

## 6. Storage: geometry, slots, put-away

`form: 'bag'` (default, legacy) | `'block'` | `'rack'`. The rectangle plus rack parameters give capacity and times; a pure function `deriveRack(station, cellSize)` is shared by the sim, the inspector and the renderer (aisle lines drawn inside the brick).

```jsonc
"ops": { "form": "rack",
         "rack": { "equipment": "reach", "aisleWidth": 3.0, "depth": 1, "levels": 5,
                   "positionsPerBay": 3, "bayWidth": 2.7, "levelHeight": 1.8, "rowDepth": 1.1,
                   "axis": "auto", "reserve": 0.05 },
         "putaway": "nearest-free" /*|'random'|'abc'|'fixed-by-type'*/, "retrieval": "fifo" /*|'nearest'*/,
         "accepts": null }                                  // load-type ids, null = all
```

**Derivation** (conservative by design, shown in the inspector as a line the planner can check):
`module = aisleWidth + 2 x depth x rowDepth`; `aisles = floor(width / module)`; `bays = floor(length / bayWidth)`; `positions = aisles x bays x positionsPerBay x 2 sides x depth x levels`. Aisles run perpendicular to the side facing the nearest road; `width` is the extent across the aisles, `length` along them.

Worked example, 32 m x 24 m (16 x 12 cells at 2 m, the 24 m side faces the road), 5 levels:

| Equipment | Aisle | Aisles | Positions | m2 per position |
|---|---|---|---|---|
| Counterbalance | 4.0 m | 3 | 990 | 0.78 |
| Reach truck | 3.0 m | 4 | 1 320 | 0.58 |
| VNA (guided) | 1.8 m | 6 | 1 980 | 0.39 |

Equipment is a real constraint, not a label: a fleet that serves a rack needs `aisleMin <= aisleWidth` and `liftHeight >= levels x levelHeight` (new fleet fields, new validation code `fleet-cannot-serve-rack`). That couples the layout choice to the vehicle choice, which is the classic trade-off.

**Time inside the aisle** is added to the fleet's `loadTime`/`unloadTime` (fork positioning, scanning); it replaces neither:
`excursion = 2 x bayDist / vAisle + 2 x height / vLift + tSet`. Example: bay 6 of 11 (16 m), level 4 (7.2 m), 2.5 m/s, 0.4 m/s: 12.8 + 36 + about 15 s set, roughly 65 s against 20 s today. High levels dominate (insight `lift-dominates`). The vehicle holds the aisle-head dock cell for the excursion, so one vehicle per aisle and queues at the entrance emerge from the traffic model that already exists. In W2, before slots exist, the aisle is the least-occupied one with room and the position is drawn uniformly from a forked stream, which gives the right mean.

**Aisle to road.** Aisle `a` gets the dock node nearest to its head. If two aisles map to one node, the validator warns (`aisle-shared-entrance`: "Aisles 3 and 4 share one entrance; extend the cross aisle along the rack face"); none reachable gives `aisle-no-entrance`.

**Slots (W3).** A slot table per storage (a sorted free list per aisle: put-away is O(aisles)). Put-away is directed: when the dispatcher assigns a delivery it reserves a slot (and so the drop port) for the load type; `flowSpace` is "free compatible slots minus reservations". A multi-load order reserves slots in one aisle. Retrieval by `fifo` takes the oldest ready load of the matching types; its slot decides the aisle and the excursion. `block` storage uses the same engine with lane depth, LIFO per lane and `usableShare` 0.85 (honeycombing).

## 7. Outbound: pull, cut-off, OTIF

Stock must leave only on request. A goods-out with doors holds trucks with a **load plan**:

```jsonc
"ops": { "doors": { "count": 3, "staging": 12, "checkIn": 300, "checkOut": 300 },
         "trucks": { "mode": "schedule", "releaseLead": 5400,   // pallets are requested 90 min before departure
                     "schedule": [{ "at": "14:00" /*arrival*/, "depart": "15:00", "pallets": 26, "route": "R1" }] } }
```

At `depart - releaseLead` the plan creates **tokens** (pallets wanted, by type) and is assigned a planned door, so pallets pre-stage in that door's lane before the truck arrives. A storage-to-goods-out lane has demand only up to `tokens - staged - inbound`. The truck takes its door when it arrives; it leaves when full and checked out, or at `depart` with whatever is loaded. Loads complete (`loadCompleted`) when placed on the truck.

Truck-level OTIF = left by `depart + grace` and carried the full plan. It is a proxy for customer-order OTIF and is labelled as such. `route` tags keep staged pallets apart; consolidation across routes is out of scope. Pre-staging space is what planners usually underestimate, so peak staged pallets is a KPI.

## 8. Picking (W4)

A **pick zone** is a `process` station with `ops.pick`; its machines are the pickers (so the existing `machines` sweep, utilisation and bottleneck insights apply unchanged, and shifts apply as staffing).

```jsonc
"ops": { "pick": { "method": "order" /*|'batch'|'zone'|'wave'*/, "linesPerOrder": { "kind": "exp", "mean": 6 },
                   "batchSize": 4, "zones": 1, "waveEvery": 3600, "walkSpeed": 1.1,
                   "tSearch": 6, "tPick": 8, "tSetup": 60,
                   "faces": 400, "linesPerPallet": 120, "replenishBelow": 0.3 } }
```

Cycle = `tSetup + tour(k)/walkSpeed + k x (tSearch + tPick)`. Tour length is analytic from the same `deriveRack` geometry: expected aisles visited `A_v = A x (1 - (1 - 1/A)^k)` for `k` uniformly placed picks, then the S-shape or return heuristic (Hall 1993; de Koster et al. 2007) from `A_v`, aisle length and pitch. Methods only change `k`, the zone length and the timing: batch pools `k` over `batchSize` orders (plus a sort time), zone shortens the tour and adds a handover, wave releases orders in blocks (peaks).
Travel is typically about half of manual picker time, hence ABC put-away (fast movers near the dock) is worth modelling.
Replenishment is an ordinary flow from the reserve storage with a new trigger `refill: { below: 0.3 }` (deliver only when fill is under the threshold, top up to capacity); face stock-outs are counted and stop the cycle (`starved`).

## 9. Resources, calendar hooks, load types

**Hooks needed from the calendar design** (nothing here is implemented without them):
- H1 a clock: `sim.clock(t) -> { day, tod }`, `startTod` setting.
- H2 demand profile applied to truck and order generators through the inverse cumulative profile, not per-tick thinning, so arrivals stay `dt`-independent as in `stepSource`.
- H3 staffing: vehicles and machines available per shift and break. An off-shift vehicle finishes its order, parks (`isAvailable` false); picker machines finish the cycle, then go `off`.
- H4 door opening hours: trucks outside them wait at the gate.
- H5 KPI windows in whole days or shifts.

**Load types.** `layout.loadTypes: [{ id, name, color, zone, velocity: 'A'|'B'|'C', positions: 1 }]`; absent means one implicit type. A load gets `type`. Flows carry optional `types`; the producer routes a load only to flows that accept its type (smooth weighted round-robin among those). Behaviours: segregation (`accepts` of a storage), velocity-zoned put-away, per-type colours and lead times. A process emits `outType` (default: its first input's type). Fast movers are simply their own type with a high share in the truck `mix`. Left out: SKUs, weights, dimensions, expiry, per-type vehicle rules (use `flow.fleetId`).

## 10. KPIs, insights, validation

A new `warehouse` section in `KpiReport`, matching `METRICS` entries and insight rules:

| KPI | Definition here |
|---|---|
| Dock-to-stock | docked to put-away finished (also gate-to-stock) |
| Truck wait, turnaround | arrival to docked; arrival to departure; mean, p90 |
| Door utilisation | busy time / open time; gate queue mean, max |
| Storage utilisation | positions used / usable, mean, max, by aisle |
| Put-away, retrieval time | dock cell hold time: travel / lift / handling |
| Pick rate, travel per line | lines per picker-hour; analytic metres per line |
| Order cycle time | plan release to loaded; plus end-to-end `leadTime` |
| OTIF | truck level, section 7 |
| Labour hours, cost per pallet | paid (shift length x headcount) vs productive; optional `costPerHour` |

Insights (thresholds as named constants, as today): `doors-bottleneck`, `doors-idle`, `unload-limited-by-vehicles` (door held while staging is full and pickup wait is high: "the doors are not the problem, the forklifts are"), `storage-nearly-full` (above 90 %), `aisle-hotspot`, `lift-dominates`, `late-trucks`, `otif-low`, `stock-aging`, `pickface-stockout`. Validation codes: `door-no-dock`, `doors-too-few`, `aisle-no-entrance`, `aisle-shared-entrance`, `fleet-cannot-serve-rack`, `type-no-home`, `plan-after-cutoff`.

## 11. Code touch points and phases

New files: `js/model/warehouse.js` (pure: `sanitizeOps`, `deriveRack`, `deriveDoors`, `pickTour`, Little's-law helper), `js/sim/logistics/ports.js`, `trucks.js`, `slots.js`. Edits: `defaults.js` (ops defaults, equipment presets), `layout.js` (`normalizeStations` keeps `ops`, `normalizeLayout` keeps `loadTypes`, `updateStation` accepts `ops`; export and share links need nothing else; any `ops` edit is `structural`, so the sim rebuilds), `validate.js`, `stations.js`, `dispatcher.js`, `vehicles.js`, `routing.js`, `stats.js`, `insights.js`, `experiments.js` (sweeps: doors, aisle width, levels, pickers), UI (`inspector.js` sections next to `storageSections`, `render/bricks.js` doors, aisle lines and trucks at doors), a new example "Warehouse: 4 doors, racked storage, 3 outbound doors" built through the model API.

| Phase | Content | Decision it unlocks | Size |
|---|---|---|---|
| W0 | ports refactor behind one default port; golden equivalence test | none (no behaviour change) | M |
| W1 | trucks, gate, doors, receiving; door KPIs | number of doors, staging depth, appointment spacing, forklifts for unloading | M |
| W2 | `deriveRack`, `block`/`rack` capacity and excursion time, aisle ports, equipment constraint | aisle width vs equipment, levels, where aisle entrances go | M |
| W3 | slot table, put-away, load types, pull outbound, OTIF | slotting policy, staging need, cut-off feasibility | L |
| W4 | pick zone, pickers, replenishment, labour hours and cost | pickers per shift, pick method, face count | L |

Sizes are rough (M about 3 to 4 engineer-days, L 5 to 7). W1 and W2 can run in parallel after W0. Tests: legacy golden (identical `KpiReport` for the three examples after every phase, which also keeps the figures quoted in `examples.js` tips true); no door double-booked; staging within cap; no slot double-occupied, slots used = loads held; conservation law; same seed, same KPIs; `ops` survives export, import and share link; fuzz layouts with random doors and aisles.

## 12. Pitfalls and how the tool reacts

| Pitfall | Reaction |
|---|---|
| Sizing to the average day | KPIs by peak hour and shift |
| Door count from average arrivals | Little's-law line; `lateness` creates bunching |
| 100 % rack fill | warning above 90 %; `reserve`, `usableShare` |
| Aisle width chosen for density only | equipment constraint, `lift-dominates` |
| Replenishment starving picking | face stock-outs counted |
| Steady-state thinking on a daily cycle, one run | whole days (H5), replications |
| Paid vs available labour time | both shown, labelled |

## 13. Non-goals

SKU-level inventory and slotting optimisation; WMS algorithms (wave optimisers, task interleaving); pedestrian traffic and picker collisions; conveyors, sorters, AS/RS; yard and trailer management; consolidation optimisation; returns logic; mezzanines; temperature; skills and ergonomics; capex and NPV. The unit is a handling unit (pallet, cage); case-level work exists only as the pick-zone approximation.

## 14. Risks

- **False precision.** Derived capacity and tour formulas look exact. Show the derivation, label results indicative, offer a one-day calibration against real data.
- **Hot-file collisions.** W0 edits `routing.js`, `dispatcher.js`, `vehicles.js` and `stations.js`, which the dock work is changing, and `ops` needs `layout.js`, which the roads wave edits. Sequence after the dock fix; write the golden test first.
- **Non-stationarity breaks existing machinery.** Warm restart (`primeSeconds`, 10 to 40 min), the 600 s impact window and its noise bands assume a stationary plant. With a calendar the pre-roll must end at the same time of day and compare whole days, or an edit made in the morning reads "worse" at the evening trough.
- **Silent data loss.** `normalizeLayout` drops unknown keys (section 5). Mitigated by `ops`; covered by round-trip tests.
- **Complexity for the first-time planner.** Progressive disclosure ("Add doors", "Make it a racked warehouse" buttons) and defaults that run.
- **Performance.** One slot entry per position (100k is fine); put-away stays O(aisles); truck events O(doors) per tick.

## 15. Open questions

1. First customer: pallet warehouse or DC with case picking? It decides whether W4 or W3 comes first.
2. Default pallet: EUR 1.2 x 0.8 m (up to 33 per EU trailer) or GMA 48 x 40 in (about 26 per 53 ft trailer)? The examples here use metric units and 26 pallets per truck.
3. Money: is cost per pallet wanted at all (rates are an input burden), or hours only?
4. Draw trucks at doors and in the gate queue? Cheap; recommended.
5. Agreement needed with the dock engineer (candidate node set and occupancy signal, section 4) and with the owner of `layout.js` (the `ops` slot instead of nested `params`).
