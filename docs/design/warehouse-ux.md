# Warehouse planner experience: how a planner builds, reads and trusts it

Status: design proposal, 2026-10-08. Angle: interaction, screens, copy and guidance, from a read of `docs/ARCHITECTURE.md` and the code. Data names follow the sibling designs `warehouse-architecture.md` ("arch": `station.ops`, `layout.calendar`, `layout.loadTypes`) and `warehouse-ops.md` ("ops"). Section 11 lists what this design asks of them.

## 1. Goal, test and principles

The planner wants to decide: where racks, aisles and doors go, how many vehicles and pickers per shift, and whether the day survives the peak. The success test: **someone who knows warehouses but has never seen LogiPlan opens "Warehouse: first day", changes the door count and the shift pattern, and says at which hour and why the plant fails, in 15 minutes, without opening Help.**

| # | Principle | Consequence here |
|---|---|---|
| P1 | Same canvas, no warehouse mode | The palette keeps its five bricks. Warehouse features are options of Storage, Goods in, Goods out and an inspector section each |
| P2 | Derive, show the arithmetic | Positions come from the rectangle, doors needed from trucks. Every derived number prints its formula in one line |
| P3 | Every result has a clock | Any figure can be asked "at which hour?" and the answer is on the plan |
| P4 | A finding is a sentence, a place and a time | Insights carry `refs.window`; clicking shades the day strip and selects the brick |
| P5 | Defaults run; absent means today | A plant without `calendar` behaves bit-identically; "Add doors" works with zero typing |

## 2. Building the warehouse

### 2.1 Tools and gestures

| Want | Gesture | What happens |
|---|---|---|
| Rack block | Press `3` (Storage). Tool options bar (the `stage__options` strip that already hosts obstacle kind and speed factor) shows **Form: Buffer, Floor stack, Racks**; `3` again cycles, like `W` does for obstacles. Drag a rectangle | The ghost (green/red as now) draws aisle lines live from `deriveRack`, and the size label becomes `16 × 12 cells · 32 × 24 m · 4 aisles · 1,320 positions`. Release = one undo step "Place rack block" |
| Aisle direction | Tool options: **Aisles run: Auto, ↕, ↔** | Auto = parallel to the shortest path from the brick to its nearest road face. No bare key (R, O, Z, E, W, T, F are taken) |
| Dock doors | Select Goods in or Goods out, inspector **Trucks and doors**, button **Add dock doors** | The dock notches that `drawDockNotches` already shows for a selected brick become numbered **door ticks**. The count stepper is authoritative; click a tick to move that door to another dock cell. Fewer dock cells than doors: warning with a fix, see 7 |
| Staging | Same section: "Staging: 4 pallets per door" | Small pallet squares in front of each tick (drawn at cell size 16 px and up). It is the door lane capacity, not geometry |
| Pick zone | Press `2`; options: **Kind: Machine, Pick zone** | Same brick, inspector section **Picking**; pickers are its machine count, so staffing and sweeps already work |
| Size from need | Rack inspector: "I need [1,200] positions" | Button **Resize to fit** proposes the rectangle; if blocked, the sentence says by what |
| Fit to grid | Rack inspector, next to Aisle width | Chips such as **3.8 m fits the grid**: aisle plus two rows is a whole number of 2 m cells, so each aisle gets its own entrance cell |
| Head road | Rack inspector: **Draw head road** | Paints a two-way road along the aisle-head face to the nearest road in one commit "Add head road for Rack block 1" (`paintRoadPath`) |

The original observation (one street, three docks, every vehicle takes the same one) must be visible and testable here: during a run each door tick carries a thin **share bar** of loads handled. One bright tick and two dark ones is the symptom; three even ticks is the proof that the dock-choice fix works. The data is `DockBook` visits and busy time per dock.

Racks stay one brick. A larger store is several rack blocks with a road between them (Ctrl+D duplicates). The old `rack` obstacle stays decoration; its inspector gets **Make it a rack block**, which swaps it for a Storage brick of the same rectangle.

### 2.2 Templates

Templates are **examples with four questions**, not insertable groups: insertion needs a multi-brick ghost in `renderer.js` and `place.js`, which are being edited. The welcome dialog gets a second section **Start from a template**.

```
 Start from a template                                   [x]
 (•) Distribution centre   ( ) Cross-dock   ( ) Production supermarket
 Pallet positions needed ........ [ 1,200 ]
 Trucks per day  in / out ........ [ 24 ] / [ 30 ]
 Dock doors      in / out ........ [ 3 ]  / [ 4 ]      (suggested: 4 / 5)
 Shifts ......................... ( 1 ) (•2 ) ( 3 ) ( 24/7 )
 Preview: 56 × 40 m, 4 aisles, 2 reach trucks per shift      [ Create plant ]
```

The suggestion line runs the Little's-law helper from `ops` section 5. "Create plant" builds through the layout API, like `examples.js`, so every template must validate with zero errors and run (tested the same way as the three examples). Dirty plan: the existing confirm.

## 3. Time: shifts, breaks, demand

### 3.1 The Calendar tab

One new tab, `calendar`, label **Calendar**, icon clock, after Flows. The tab strip already collapses to icons below 520 px and keeps the selected label, so an eighth tab fits. Empty state until used: "Your plant runs around the clock at a constant rate. Pick a shift pattern to see peak hours and what each shift needs."

```
 Calendar                                  Weekdays | Saturday | Sunday
 Pattern  [1 shift] [2 shifts] [3 shifts] [24/7] [Custom]
        00  03  06  09  12  15  18  21  24
 Early   ·   ·   ▐██████████░██▌   ·   ·   ·     06:00-14:00   break 09:00-09:30
 Late    ·   ·   ·   ·   ·   ▐████████░██▌ ·     14:00-22:00   break 17:30-18:00
 Demand  ▁▁▁▁▁▂▅█▇▅▃▃▂▂▂▂▃▃▂▁▁▁▁▁▁     Inbound curve [Morning peak ▾]
 ── Who works when ──────────────────────────────────────────
                         Early   Late     (0 = off)
 Goods in 1 doors open     4       2
 Goods out 1 doors open    2       4
 Forklifts                 4       3
 AGVs                     24 h    24 h     (battery plants stay on)
 [ Suggest staffing from the last run ]
```

* **Presets** write named shifts with a lunch break: 1 shift 06:00 to 14:00, 2 shifts add 14:00 to 22:00, 3 shifts add 22:00 to 06:00 (past midnight is shown as a wrapped bar), 24/7 is one shift, no breaks. Day types (Weekdays, Saturday, Sunday) map to the model's `days` arrays; the UI never shows seven rows.
* **Strip editing:** drag a bar edge or body (15 min snap), drag inside a bar to cut a break. Every bar is a focusable `role="slider"`; arrows move 15 min, Shift+arrows resize, Delete removes a break.
* **Form fallback is primary for accessibility and touch:** under the strip, a table `Name | From | To | Days | Breaks` with `<input type="time">`. On touch the strip is tap-to-select, with the table row opening below; no drag is required.
* **Who works when** is the single editing surface for staffing. It writes `ops.calendar` and `fleet.calendar`; the cards on Fleet and the station inspector show read-only chips ("Early 4 · Late 3") with an Edit link back here. A resource never bound keeps today's always-on behaviour, shown as "24 h".
* **Suggest staffing** fills the matrix from the last run: vehicles needed per shift = busy vehicle-hours per hour ÷ 0.85 (the `MACHINE_TARGET_UTILIZATION` idea), rounded up, with the peak hour named beside it.

### 3.2 Demand profile

A 24-bar editor, one per Goods in and Goods out (inspector, "Arrivals by hour"; the Calendar tab shows the plant total). Drag a bar; presets: Flat, Morning peak, Two peaks, Afternoon-heavy, Month-end spike. Above the bars the derived line: "Daily total 168 pallets · peak 10:00 = 1.8 × average = 14 pallets/h". **Paste 24 numbers** (one column or one row) from a spreadsheet; any length other than 24 or 48 is refused with the count found.

### 3.3 Truck timetable

Section **Trucks** has a switch **Generate from rate and curve / Use a timetable**. The timetable is a table, not a form per truck:

```
 Arrival   Pallets  Mix            Depart (out only)
 06:00     26       Standard
 06:20     24       Fast:16 Slow:8
 [ Paste from spreadsheet ]   12 rows read · 1 skipped: "25:70" is not a time
```

The paste box accepts tab, comma or semicolon separators, `6:00` / `06:00` / `06.00`, decimal comma, an optional header, and `Fast:16;Slow:8` in Mix. A preview lists good rows and marks bad ones in place; nothing is applied until **Use 12 rows**. Semicolons and decimal commas are first-class, because Excel exports them in German and many European locales.

### 3.4 Time on the canvas

The sim bar clock becomes `Mon 06:42` with a shift chip (`Early`, or `Closed`), and a 24 h strip under it: shifts shaded, peak hours marked, a playhead. The strip is read-only (the simulation cannot rewind). Speed select gains `1 h/s` (3600×) beside the existing steps, and **Run to 14:00** / **Run to end of day** for a quick look. Off-shift is shown without alarm: closed doors get a lock glyph and a grey tick, parked off-duty vehicles stay in their depot, the baseplate dims by about 6 %. Nothing flashes or pulses.

## 4. Load types and order profiles without data entry

Types are **colours with a share**, not SKUs. Plant settings (nothing selected) gets **Load types**: one implicit type "Pallet"; chips **+ Fast mover, + Slow mover, + Chilled, + Hazardous, + Returns, + Custom** each add name, colour and sensible defaults. The UI stops at 6 (the model allows 8).

* **Mix:** each Goods in shows one stacked bar, `70 % Fast · 25 % Slow · 5 % Chilled`; dividers drag, the sum is 100 % by construction, no number to type.
* **Where types matter:** Storage **Accepts** chips (default all), Flow **Carries** chips (default all), Rack **Slotting: fast movers closest to the doors** (a checkbox, maps to the ABC policy).
* **Outbound order profile** is a truck plan line in the timetable (`Mix` column). Blank means the sink's default mix.
* **Seen:** load boxes on vehicles take the type colour, rack aisle bars stack by type, Results gets throughput and lead time per type, only when more than one type exists.

## 5. Reading it on the canvas

| Thing | Encoding (hook) | Level of detail |
|---|---|---|
| Storage fill | One bar per aisle inside the rack brick (`bricks.js` `paintContent`); grey to amber to red above 90 %; stacked by type when types exist | Far: one fill swatch. Mid: aisle bars. Near: `78 % · 1,030 / 1,320` |
| Imbalance | Aisle bars side by side make "aisle 1 full, aisle 4 empty" obvious; insight `aisle-hotspot` points at it | Mid and near |
| Pick faces | Row of face boxes in the pick brick; empty face = red hatch plus count `Faces 380/400` | Near |
| Door state | Tick colour plus glyph: free, unloading, waiting for vehicles (staging full), closed. A docked-truck rectangle at the tick | Mid and near |
| Gate queue | Chip on the Goods in brick: `Gate: 5 trucks · 38 min` (amber from 15 min, red from 45) | All |
| Dock balance | Share bar per tick (see 2.1) | Near |
| Vehicle queues | Existing `waiting` heat; the Jobs overlay adds "waits for door 2" on a vehicle behind a dock | Mid |
| Time | Clock chip, shift chip, day strip | Always |

Colour never carries a state alone: each state also has a glyph or number. Colours reuse `STATUS_COLORS`; there is no new palette.

## 6. Results and findings

Results gets a **Day** section, shown only when a calendar exists:

```
 Day                                             Mon-Fri, 5 days measured
 Trucks waiting at the gate (stacked) and vehicles busy vs staffed
 ▂▂▃▅█▇▅▃▂▂▂▂▁   gate wait           peak 38 min at 10:00 [Show on plan]
 ━━━━┓___┏━━━━    staffed (step)      ▅▆▇█ needed (bars): short 09:00-11:00
 By shift   Out/h  Doors  Vehicles  Gate p90  Limits
 Early       31     96 %    88 %     52 min   doors, forklifts
 Late        22     41 %    55 %      4 min   nothing
```

* Hours are the x axis of every new chart (`charts.js` bar and stacked bar already exist). A red band marks hours where needed exceeds staffed.
* **Doors card** (per door: share of trucks, utilisation, gate wait mean/p90, turnaround) and **Storage card** (fill by aisle, dock-to-stock time). Both hide without doors or racks.
* **Insights** are sentences with a place and a time. Rules added on the existing `candidate()` pattern (`insights/warehouse.js`); each returns `refs.window = { from, to }`. A calendar plant never shows a "good" insight while any peak hour fails, even when the daily average is fine.
* **Change card:** with a calendar the 600 s warm comparison is not honest. The card says "Time of day matters now. Compare whole days" and runs a one-day comparison in Experiments.

## 7. Guidance, validation, wizards

* **Next steps** (`computeNextSteps`) gain, in order: `add-doors` (Goods in or out without doors, once flows exist), `rack-no-access`, `staffing-below-need` (after the first run), and an `info` step `no-calendar` ("All figures are averages over a flat day. Add shifts to see peaks."), which never counts as a step to finish.
* **Checks** gain the codes from `ops` section 10 and one more, `shift-gap` (a gap between shifts while a fleet has no 24 h binding). Each has a Fix button wired through `fixForIssue`:

| Code | Message | Fix |
|---|---|---|
| `door-no-dock` | Goods in 1 has 4 doors but only 2 road cells touch it. | Extend the road along the edge |
| `aisle-shared-entrance` | Aisles 3 and 4 of Rack block 1 share one entrance, so only one vehicle can work in them at a time. | Show grid-fit aisle width |
| `doors-too-few` | At the peak you need about 4.9 doors busy at once and have 4. | Use 6 doors |
| `fleet-cannot-serve-rack` | Forklifts need 4.0 m aisles; Rack block 1 has 3.0 m. | Switch fleet to Reach truck |
| `staffing-needs-depot` | Off-duty vehicles need somewhere to park. | Add parking |

* **Wizards:** two only, the template questions (2.2) and **Resize to fit**. Shifts and doors are chips and steppers, never modal flows.

## 8. Defaults and example plants

An untouched warehouse must run on Play. **Add dock doors** sets 2 doors, check-in and check-out 5 min, a truck every 45 min (±30 %), 24 pallets (±25 %), staging 4 per door. A new rack brick is 8 × 6 cells (16 × 12 m): reach truck, 3.0 m aisle, 5 levels, "2 aisles × 5 bays × 3 × 2 × 5 levels = 300 positions". Goods out: 2 doors, a truck every 60 min, 24 pallets. No calendar means 24/7. The first preset click binds every door, picker and driven fleet to all shifts, so nothing starves by surprise. The Fleet add-menu lists **Reach truck (needs aisle ≥ 2.8 m, lifts to 10 m)**, **Pallet jack** and **VNA truck**.

| Example | Teaches | Shipped tips (verified by test, like the current ones) |
|---|---|---|
| Dock lab | One road, three docks. The original observation | Heat map before and after; read the share bars; add a fourth dock |
| Warehouse: first day | Doors against forklifts; one shift | At 4 doors the 10:00 peak queues; 3 forklifts, not 6 doors, is the cheaper fix |
| Distribution centre, two shifts | Staffing matrix, peak hour, aisle width | Switch to VNA: positions up, truck cost up; give Late one picker less |
| Cross-dock at peak | Timetable paste, no racks, staging | Paste 12 arrivals; find the staging depth that stops door blocking |
| Production supermarket | Load types, tuggers | Make Fast movers 40 %; watch the supermarket aisle bars |

## 9. Accessibility and touch

Door ticks have a hit area of at least 44 px whatever their drawn size; a tap opens a popover (state, share, "Move door"). Rack drag on touch reuses the existing 28 px threshold. The strip editors enhance the form table, which is the accessible primary; screen readers hear "Early shift, 06:00 to 14:00, Monday to Friday, break 09:00 to 09:30". The staffing matrix scrolls horizontally with a sticky first column on narrow screens. All new chips and steppers are real buttons and inputs with `aria-label`.

## 10. Exact copy for the five key moments

1. **Rack block placed (toast, 8 s, after release).** "Rack block 1: 4 aisles, 11 bays, 5 levels = 1,320 pallet positions, 1,254 usable with 5 % kept free. Vehicles enter the aisles from the road in front of them." Button: **Draw head road**.
2. **Doors line (inspector, live).** "At the 10:00 peak you need about 4.9 doors busy at once (6 trucks/h × 0.82 h each). You have 4, so trucks queue at the gate. 6 doors would run at 82 %. Door time includes waiting for forklifts: more forklifts shorten it." Button: **Use 6 doors**.
3. **Shift preset applied (toast plus note in Calendar).** "Two shifts applied: Early 06:00 to 14:00, Late 14:00 to 22:00, Monday to Friday. Time of day matters now, so the simulation restarts on Monday at 05:00 and runs 5 days. Results will show hours and shifts."
4. **Peak finding (Results, severity warning).** Title: "Trucks wait 38 minutes at the gate between 09:00 and 11:00". Detail: "Goods in 1 has 4 doors, busy 96 % of that time, and 7 trucks stood in the yard at the worst moment. The doors are not slow: 11 of the 39 minutes per truck were spent waiting for a free forklift." Suggestion: "Add a forklift to the Early shift (3 to 4), or open a fifth door from 09:00." Link: **Show on plan**.
5. **Rack without access (Checks, error).** "Rack block 2 has no entrance. No road cell touches the open end of its aisles, so no vehicle can store or fetch pallets there." Hint: "Draw a road along the short side of the block, or move the block next to an existing road." Button: **Draw head road**.

## 11. Asks of the sibling designs

1. `deriveRack(station, cellSize)` also returns `fitAisleWidths` (aisle widths that make the module a whole number of cells), per-aisle head cell and `entranceStatus` (`ok`, `shared`, `none`).
2. Door addressing as `side` plus index (arch D6) works for ticks; "move this door" rewrites the index. I prefer it to `ops` `pinned` cells.
3. `calendar.profiles[].hourly` has 24 entries; the UI groups `days` into three day types.
4. `ops.calendar` and `fleet.calendar` stay the stored form; the staffing matrix is only a view over them.
5. KPI additions: `byHour` arrays, `byShift`, per-dock visits/busy/wait (from `DockBook`), gate wait series, needed-vs-staffed vehicles per hour, per-aisle fill. Insights need `refs.window`.
6. `toolOptions` gains `form` and `aisles` in `store.js` (`PREF_KEYS` already persists `toolOptions`).

## 12. Non-goals, risks, open questions

**Non-goals.** Floor-plan underlay (declined for now); SKU master data, weights, dimensions; per-person rosters or skills; drawing individual shelves; scrubbing back in time; WMS or ERP import; 3D; inserting a template into an existing plant (v2); pedestrians; yard geometry.

| # | Risk | Mitigation |
|---|---|---|
| U1 | Hot files: `editor/tools.js`, `place.js`, `render/bricks.js`, `app.js`, `inspector.js` are in the roads/canvas wave | Ship inspector-only first (Form dropdown in Storage's inspector, no tool option, no new ghost); add the live-derivation ghost after the wave merges |
| U2 | Derived numbers look exact | Always show the formula; label results "indicative"; offer calibration |
| U3 | Calendar plants lose silent warm restart, so each edit costs a cold start | Honest copy (moment 3); open question 3; default view of results is one day |
| U4 | Results overload | Day, Doors and Storage appear only when their feature is on |
| U5 | Paste parsing ambiguity (`06.00`, `1,5`, merged cells) | Preview before apply, row-level errors, never guess silently |
| U6 | Templates breed trust in defaults | Banner on a template plant: "Illustrative defaults: replace them with your trucks and rates" |
| U7 | Eight tabs on a 360 px panel | Icon-only strip with the selected label (existing behaviour); badge on Calendar when a staffing shortfall exists |

**Open questions.**
1. First customer: pallet warehouse or case-picking DC? It decides whether the Pick zone or the Distribution centre template ships first.
2. Tab name: **Calendar**, or **Shifts**, the word planners use?
3. Is a cold restart per edit acceptable for calendar plants, or should the pre-roll start at the previous shift end?
4. Euro pallet or GMA pallet as the default, and metric only?
5. Doors pinned to cells, or `side` plus index only?
6. Should "Suggest staffing" write directly or show a diff first? I recommend a diff.
