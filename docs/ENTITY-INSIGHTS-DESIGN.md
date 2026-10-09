# LogiPlan entity statistics and vehicle routes: definitive design and build plan

Status: design for build, 2026-10-09, at repository HEAD `50cb134` (the code of `js/` is identical to `10e68f2`; only docs and tests differ). **Nothing of this is built.** The one piece of code that exists is a
reference collector and its spikes in the scratchpad of the design session; they are starting points, not files of the repository (paths in section 14).
Where this document and the code differ, the code is authoritative, say so in the report and fix whichever is wrong.
**Reading order for a builder:** section 6.4 (the collector API, the contract between the sim and the UI), section 3 (every definition), section 9 (the plan of your step), section 10 (the tests).

Written by the finalizer of a design workflow: three independent designs (planner, engine, UX) were merged into one concept, spiked on the real engine, and then reviewed by two critics (a planning angle and an engine/UI angle). Every high and medium finding of the review is applied here
(section 13 lists each one and what was done); each changed number was measured again on the real engine in this stage and is marked **run**. What was not run is said in section 12.

Contents: 1 What the product owner asked and the principles. 2 What the planner sees (interaction, anatomy, wireframes, keyboard). 3 The statistics of every item, with exact definitions. 4 Vehicle routes. 5 Honesty rules. 6 Data model, collector API, seams, why the golden tests stay byte-identical.
7 UI architecture and touch points. 8 Performance budget with the measured numbers. 9 Milestones S1 to S3 with the build plan of each (file ownership, order, acceptance criteria). 10 Test plan. 11 What is deliberately not built. 12 Risks, known defects of the mock-ups, what was not run, open questions.
13 How the review findings were handled. 14 Index of spikes and mock-ups.

---

## 1. What was asked, and the principles

### 1.1 The request (verbatim, the product owner)

> "when I click on any of the items like goods in, goods out, vehicle, or anything else, I wanted to show some statistics. So, when I click on it, there are some statistics coming up, like whatever makes sense for somebody who does logistical planning so that they have a better overview.
> And also, when I click on a car or any of the vehicles, that it shows which route that car usually takes, and some other intelligent information that makes sense to display here."

Two asks: (1) a click on **any** item shows statistics that a logistics planner needs; (2) a click on a **vehicle** shows the route it usually takes, plus other intelligent information.

### 1.2 One page

**What the planner gets.** A click on an item opens a **Statistics dock** that is drawn over the bottom of the plan (on a phone: a bottom sheet). It always has the same shape: a header with what the item is doing now and a window switch (*Since start* | *Last 30 min*),
a strip of six numbers (the first three are the headline numbers; each has the peer or fleet value and an (i) button with the exact counting rule), and three blocks: *where the time goes*, *worth knowing* (at most four plain sentences; the existing insights of that item first, so that the Results tab and the dock cannot disagree)
and the item's *trips, loads, docks*. On the plan the item's trips are drawn where they really drive: **line width = trips, colour = share of the trip lost to waiting, dashed = empty, ring = where it queues**.
A click on a **vehicle** now selects that vehicle (before: its fleet; the fleet is one click away in the dock header) and shows its usual trips (with the dock it takes), its usual round, where it is held up, how its time splits, and what the fleet question is (is the vehicle needed).

**How the data is collected.** Every number the report already holds is reused unchanged (`sim.kpis()`, the golden fixtures and the Results tab are untouched). What the report cannot give (which cells a vehicle drove, where it queued, the time split of one vehicle, the wait of a pallet in the yard, 30-minute windows,
which input starves a workstation) comes from **one optional collector, `js/sim/detail.js`**, reached only through `sim.detail`. Only the UI turns it on (headless runs, experiments, sweeps, tests do not pay for it). It is fed by a poll after each tick plus the event bus and cannot stop the simulation (section 6.6).

**What was measured (run, section 8).** Exact against the engine's own report to 6e-12 vehicles; 43 golden runs byte-identical with the collector on; 80 of 80 full-state fingerprints identical with the collector switched on, off and on again in the middle of a run; 94 of 94 hostile plants with a vehicle removed in the middle of a run keep running;
collector on costs +8 to +18 % CPU over the same tree with it off (still 16,500 to 63,500x real time on the five examples); on the largest plant the app allows (320 x 320 cells, 225 stations, 100 vehicles) 518x to 620x real time (gate 500x), 2.6 MB of typed columns.

**Build in three shippable steps (section 9).** **S1 vehicle first**: collector, dock, the whole vehicle view, the routes on the plan, and a six-number strip for every other item (about 26 to 34 engineer-days). **S2 every other item** in full: workstation, Goods in with trucks and yard, storage, Goods out with the lead-time chain, depot, flow, road cell, fleet, several selected
(about 13 to 18 days). **S3 overview and polish**: plant overview, peaks, the measured what-if, copy as table, follow a vehicle, help (about 9 to 12 days). Total 48 to 64 days in the convention of the warehouse design; the first estimate (29 to 38) was about 1.5x short, section 9.0.

### 1.3 Principles

1. **Overview first.** Six numbers, then three blocks, then (on demand) the detail. The first three numbers answer "is this item a problem". The default state of the dock is the strip only (about 150 px); the blocks open on demand and remember it.
2. **Plain language.** Sentences a planner can read aloud ("AGVs 1 waits 7 % of its time, 69 % of that in the queue for a dock"), never a code or an internal state name. Words are fixed per concept (section 2.6).
3. **Every number is defined.** Each tile has an (i) button with the counting rule and the window; the dock says how long it has measured ("2 h 6 min measured, warm-up excluded") and since when ("counted since 0:10").
4. **Honest windows.** A number is over a window of simulated time: *Since start* (the report's own window, warm-up excluded) or *Last 30 min*. A number never silently changes its window: a figure that has no 30-minute version keeps its since-start value and says "since start" next to it. A printed share never exceeds 100 %
   because numerator and denominator always come from the same window (a property test, section 10).
5. **Exact, sampled, estimate.** Three kinds of number are never mixed without a word (tags R, C, S, E, L, section 3.0). Estimates are called estimates on screen. Counts say what they are based on, and no verdict is spoken from fewer than 5 legs, 10 events or 10 minutes.
6. **The report and the dock agree.** Where the report has the number, the dock shows the report's number. The collector only supplies what the report cannot, and it is cross-checked against the report by test.
7. **No cost where it is not used.** Plants that do not turn the collector on (every headless run, every test, every sweep) are bit for bit and within about 2 to 3 % CPU what they are today.
8. **The statistics never change what they measure.** The collector reads and records; it uses no random numbers, calls nothing that mutates, and a query never changes what the collector records next (run: digests equal with and without a query every 7 s).

---

## 2. What the planner sees

### 2.1 Where the dock appears, and when it opens

**The dock is an overlay, not a grid row.** It is positioned over the bottom of the stage (`position: absolute` in the stage cell, `max-height: 44vh`). The canvas is never resized, so the camera never re-fits and the world point under a held pointer never moves.
(The first concept made it a new row of the app grid. That resizes the canvas through the `ResizeObserver` in `app.js` (`createCameraControl().resized()`), which re-fits an untouched whole-plant view: the plan re-zooms on every open and close, and the first drag after a select-click jumps the station by about 5 cells.
Run: a still pointer at (500, 300), a dock of 300 px, zoom 16 px/m: the world point under it jumps 9.38 m = 4.7 cells. Both critics found this.)

* **When it opens.** On a click that ends (`pointerup`, no drag) on an item, and only when the editor tool is not busy (`ed.currentTool.busy()` is false). A selection that a press makes (`select.js armMove` selects an unselected station on `pointerdown`) is therefore **not** the trigger: the dock waits for the gesture to end and does not open at all
  when the gesture was a drag, a resize or a marquee. The selection that insights and checks make through `ctx.actions.focus()` opens it at once (no gesture). The shell holds one subscription on the store selection and one `pointerup` capture listener on the canvas; nothing in the editor changes.
* **Preference "Statistics on click"** (Simulate tab, `ui.statsDock`): *when the simulation has data* (default: the runner has measured at least 30 s), *always*, *never*. Below the threshold a click shows one line in the status bar ("Press play to see statistics for AGVs 1") and no dock; the station figures of an empty report would be zeros.
  Key `I` toggles the dock for the current selection whatever the preference says (the letters v h r o z e w t f and the digits 1 to 5 are tool keys; `I`, `[` and `]` are free at HEAD).
* **While a drag gesture runs** the dock gets `pointer-events: none` and 50 % opacity, so that a drag can end beneath it and the planner sees the plan.
* **States.** *closed* (nothing selected, or dismissed with X until the next click-select), *compact* (header and the six numbers, about 150 px; **the default the first time**), *open* (the three blocks too; content height up to 44 vh, the grip at its top drags the height, which is remembered).
  The state and height are remembered per viewer in `localStorage['logiplan:stats-dock']` (wrapped in try/catch; the page works without it). The route overlay is drawn in every state except *closed*, so a click on a vehicle shows its routes even in the compact state.
* **Camera.** The shell adds `coveredAtBottom()` (the height of the dock when it is not closed) beside the existing `coveredAtTop()` of `createCameraControl`: `fit()` fits into the free part, and a new `revealMinimal(rect)` pans by the least that brings the item (or the bounding box of its routes) out from under the dock and the top bars.
  It **never zooms**, never runs while `ed.busy()`, and never moves while the planner pans (`pointerdown` already stops a glide). A button *Show route on plan* in the dock does fit the route's bounding box (that one may zoom). The floating controls of the stage (zoom buttons, the options chip) move up by the dock height (`--dock-covered`).
* **Narrow screens (< 900 px, phones).** The same element is a bottom sheet above the tool strip with three snap points: *peek* (96 px: title, live state, the three headline numbers), *half* (54 %: six numbers and the trips), *full* (86 %). A tap on the plan does not close it.
* **Which items have a dock.** Station (every type), flow, fleet (the fleet's page), vehicle (new selection kind), road cell(s) including dock cells, several items of one kind, and nothing selected (S3: the plant). **Walls (`obstacle`) and text labels (`label`) have no dock**: selecting one closes the dock and the status line says "Walls and labels have no statistics".
  A truck at a door is not a hit target (a click selects the station underneath); the Goods in and Goods out pages therefore carry a block "Trucks at the doors" (section 3.3).

### 2.2 Anatomy (desktop 1440 x 900, open state)

```
+--------------------------------------------------------------------------------------------------------------------------+
| LogiPlan   plan name  Saved   [A][+]                                         Examples  Share  Export  Help  theme         |
+-----+-------------------------------------------------------------------------------------------------+------------------+
|tools| STAGE: the canvas keeps its full size; the dock is drawn over the lower part of it               | PROPERTIES       |
|     |  [sim bar]  [Grid Studs Flows Docks Jobs Labels ... heatmap]                                     | (unchanged; for  |
|     |                                                                                                  | a vehicle: the   |
|     |      (central warehouse)====>=====>=====>=====>(Press line)           1  <- rank of the pair     | fleet summary    |
|     |           width = trips   colour = time lost waiting   ---- dashed = empty   (o) = queues here   | "AGVs 1" and     |
|     |                                                                                         [+][-][ ]| "Edit in Fleet   |
|     | .----------------------------------------------------------------------------------------------. |  tab")           |
|     | |                                    ===  (grip: drag to resize, double click: compact/open)   | |                  |
|     | | [Vehicle] AGVs 1  in AGVs   (o) Carrying 1 load to Press line    [Since start|Last 30 min] [x] Routes  v  X | |                  |
|     | |----------------------------------------------------------------------------------------------| |                  |
|     | | TRIPS PER HOUR  | BUSY, INCL. WAITING | HELD UP   | DRIVEN        | AVG LOADED TRIP | BATTERY    | |                  |
|     | | 18.6 /h    (i)  | 78 %           (i)  | 7 %  (i)  | 1.9 km/h (i)  | 54 s       (i)  | 49 %  (i)  | |                  |
|     | | fleet 17.9      | fleet 73 %          | fleet 6 % | loaded 43 ... | fleet 51 s      | 2 stops    | |                  |
|     | |----------------------------------------------------------------------------------------------| |                  |
|     | | WHERE ITS TIME GOES   | WORTH KNOWING (<= 4)         | TRIPS                       top 3 of 4  | |                  |
|     | | [stacked bar, 11 parts]| (i) AGVs 1 waits 7 % ...    | 1  [shape] Press line -> Final assembly | |                  |
|     | | legend + sparkline    | (i) Its main trip ...        |    16 trips - 7.6/h - 54 m - 62 s ...   | |                  |
|     | | Where it is held up   | (i) 15 % of its time goes to | 2  [shape] Central warehouse -> ...     | |                  |
|     | |  min per hour, rows   |     park or charge           | Usual round ...  [Show on plan]         | |                  |
|     | |  + other places       | (i) Fleet: Borderline ...    | > Other drives  39 empty - 27 to depot  | |                  |
|     | '----------------------------------------------------------------------------------------------' |                  |
+-----+-------------------------------------------------------------------------------------------------+------------------+
| status line: hover text, plan size, version                                                                              |
+--------------------------------------------------------------------------------------------------------------------------+
```

Compact state (what a first click shows; the plan keeps its whole area, the routes are on it):

```
|     | .----------------------------------------------------------------------------------------------. |
|     | | [Vehicle] AGVs 1  in AGVs   (o) Carrying 1 load to Press line    [Since start|Last 30 min] [x] Routes  ^  X | |
|     | | 18.6 /h | 78 % | 7 % | 1.9 km/h | 54 s | 49 %    (six numbers, each with its fleet value and (i))   | |
|     | '----------------------------------------------------------------------------------------------' |
```

Narrow (390 x 844, sheet at *half*; peek shows the title row, the live line and the first three numbers):

```
+------------------------------+
| LogiPlan  name        ...  = |   top bar
| [A] [+] v                    |
+------------------------------+
| [Display]                    |   plan (full width); the route is drawn on it
|        (===== route ===)     |
|     o 1       3              |
+----------- ===== ------------+   <- grip (tap: next snap point; swipe)
| [Vehicle] AGVs 1 in AGVs   X |
| (o) Carrying 1 load to ...   |
| [Since start|Last 30]  (x)Rt |
| 18.6/h  | 78 %    | 7 %      |
| fleet.. | fleet.. | fleet..  |
| 1.9 km/h| 54 s    | 49 %     |
|------------------------------|
| TRIPS             top 3 of 4 |   <- on a phone the order of the blocks is
| 1 [shape] Press line -> ...  |      trips, sentences, time split
| 2 [shape] Central wareh. ... |
+------------------------------+
| Select  Pan  Road  One-way ..|   tool strip
| status                       |
+------------------------------+
```

Mock-ups of this concept (the real app in Chromium, numbers from the revised collector; the dock and its blocks are real HTML with the app's kit classes, the route overlay is an SVG that stands in for the canvas layer): vehicle open, scrolled, compact, Last 30 min, dark, phone peek, phone half; Goods in with three doors, light and dark (section 14).

### 2.3 The six numbers and the three blocks

1. **Header:** kind chip, name, crumb ("in AGVs", a link that selects the fleet), the live state (vehicles only: "Carrying 1 load to Press line", metres to go; for a station the live line is dropped while the Properties tab is visible, because its status card already says it), the window switch, the *Routes on plan* switch, details/minimise, close.
2. **Strip of six tiles.** Tiles 1 to 3 are the headline numbers. Each has the value, the fleet or peer value, and an (i) button whose text is the counting rule. A ▲/▼ appears next to the peer value only when the difference is real (section 3.0, rule A): a floor and about two standard deviations of the count; run: 4 of 56 vehicle tiles
   with the new rule against 25 of 56 with the old 12 % rule.
3. **Three blocks.** *Where its time goes* (stacked bar and legend, a sparkline of the last 30 minutes, then *where it is held up*), *Worth knowing* (at most four sentences, each with a *Show on plan* link where it has a place; one line "Counted since 0:10 (warm-up excluded)" with *How is this counted?*),
   and *Trips* (vehicles, Goods in, flows) or *Docks* (stations). Rows are buttons: hover or focus draws that path strong and dims the others to 28 %; Enter pins it; Esc unpins.
4. **Duplication.** The Properties panel keeps editing and its status card; the dock never repeats a sentence that the status card says (the live line rule above).

### 2.4 Keyboard, screen reader, motion, touch

The region is labelled with the item (`role="region"`, `aria-label="Statistics for AGVs 1"`); the numbers are a `dl`; the stacked bar and the sparkline are `role="img"` with a generated sentence ("Time split: Driving loaded 23 %, ..."); tables are real tables; the window switch is a button group with `aria-pressed`;
route rows are buttons whose `aria-label` is the whole sentence; hover highlight also fires on focus. **No `aria-live` anywhere in the dock** (the live line changes every 100 ms at 600x): one polite announcement when the selection changes ("AGVs 1 selected: carrying 1 load to Press line, busy 78 %, held up 7 %").
Keyboard route to a vehicle: the Fleet tab lists the vehicles of each fleet as buttons (state dot, trips/h) and Enter selects one; `[` and `]` cycle the selection within its kind; Esc clears the selection and closes the dock; `I` toggles it.
`prefers-reduced-motion`: no pulsing ring, no chart transitions. Touch targets 40 px on coarse pointers (kit). Colour never carries a state alone (dashes, numbers, ring plus text). Clicking a moving vehicle at 600x is unreliable by nature (it crosses hundreds of cells per second): the Fleet tab list and the select-by-id route are the reliable ways, a **follow** toggle is in S3.
**Designed, not run** (no axe pass, no screen reader pass yet).

### 2.5 Update cadence

The dock updates in place at 4 Hz or less from the runner's `kpis` event plus the collector's queries for the one selected item (0.01 to 0.3 ms each on a full 32,768-row leg log, section 8). It has no inputs except the window switch, the overlay switch and the details toggle, so the rule of `fields.js` (never rebuild a form with focus) holds;
the DOM is rebuilt only when the selection signature changes. The route overlay recomputes its route set at 2 Hz or less, or when the selection, the window, the camera or `detail.version` change; path geometry is cached per path id (`Path2D`).

### 2.6 Words (fixed)

| Concept | Word on screen | Not |
|---|---|---|
| share of the window a vehicle drives, waits, loads or unloads | **Busy, incl. waiting** | "Working" (three different meanings in the product: report utilization counts waiting and drives to a charger or to park; the fleet strip counts a drive to a charger as charging and a drive to park as idle) |
| share the vehicle was held up (traffic, junction, broken vehicle ahead, queue for a dock) | **Held up** (split bar: *Traffic wait*, *Dock queue*) | "Waiting" for three different things |
| no order and standing on the road | **No job** | "Waiting for a job" (collides with waiting) |
| a place where trucks dock / where vehicles dock | **Door 1 to 3** / **Dock 1 to 4**; the cell is a tooltip and the second line of a table | "dock (8, 5)" for a door, a cell, or both |
| drive with a load / to a pickup / to a depot or charger | **loaded**, **empty**, **to depot** | |
| the window | **Since start** (the report's window, warm-up excluded), **Last 30 min** | |

---

## 3. The statistics of every item

### 3.0 Conventions (apply to every table below)

**Source tags.** **R** the KPI report (`sim.kpis()`), exact, identical to the Results tab, since start only. **C** the collector, exact at tick resolution (0.1 s) or at the event. **S** the collector, sampled once per simulated second (measured error 0.0005 to 0.0007 in a share on the examples).
**E** estimate (arithmetic on other numbers; called an estimate or "workload arithmetic" on screen). **L** live state, no window. **W** column: `S` = Since start, `L` = Last 30 min, `S L` = both.
`hours` = window length / 3600.

**The windows.** *Since start* is `report.window` (start = end of `settings.warmup`; duration = the sum of the measured ticks). *Last 30 min* is 30.0 to 30.5 minutes ending now (60 closed buckets of 30 s plus the open one; its real length is printed, e.g. "1820 s"); below 30 minutes of run it equals *Since start* and the switch says so.
Below 20 minutes measured every verdict is called "indicative" (`UNUSED_MIN_WINDOW` of `insights.js`). Vehicles and stations get *Last 30 min* from the snapshot ring (the difference of the current cumulative figure and the oldest ring row; float32 ring: a week-long run still reads to 0.06 s);
legs are in the window when they **started** in it. What has no 30-minute version: every R number (the report is cumulative), the cell tables (hot cells, idle places), histogram percentiles (wait for a vehicle, lead time), road figures. Those keep their since-start value under *Last 30 min* with the words "since start" beside the number (rule B).

**Rule A (arrows).** A ▲/▼ is shown next to a peer value only when `|difference|` exceeds both a floor and the noise of the count, and a relative 12 %: shares need 3 points; a rate from a count needs at least 20 counted events and `2 x sqrt(count) / hours`.
A *Held up* tile is coloured only from 12 % (`TRAFFIC_WAIT_SHARE`). Implemented as `deltaMark()` in the spike (`final2/rules.mjs`); run on the real vehicle spreads of four examples: 4 of 56 tiles with an arrow, against 25 of 56 with the old rule.

**Rule B (window label).** A tile with no 30-minute version shows its since-start value and "since start". Never a number of another window without the label.

**Rule C (shares).** A share printed anywhere has numerator and denominator from the same window and is at most 100 %. A unit test asserts it for every share of every kind, both windows, on the examples and on hostile plants (section 10).

**Rule D (verdicts).** No verdict is spoken below 5 complete legs, 10 events or 10 minutes; below 20 minutes measured the verdict word is "indicative".

**Facts engine** (`js/ui/panels/stats-model.js`, pure, tested in Node like `insights.js`): a fact is `{ tone, text, refs, action? }`, at most four per item. The insights of `sim.insights()` whose `refs` name the item come first; every number quotes its window. Thresholds are imported from `insights.js` where a rule exists there
(`BOTTLENECK_UTILIZATION` 0.9, `STARVED_SHARE` 0.3, `BLOCKED_SHARE` 0.2, `FLEET_TARGET_UTILIZATION` 0.75, `FLEET_CRITICAL_UTILIZATION` 0.95, `TRAFFIC_WAIT_SHARE` 0.12, `DOCK_*`, `MIN_DATA_SECONDS`, `UNUSED_MIN_WINDOW`) and named at the top of the file otherwise:
`MIN_LEGS_FOR_USUAL` 5, `USUAL_SHARE_CLAIMED` 0.5, `VARIANT_DRAWN_SHARE` 0.1, `WAIT_SHARE_NOTABLE` 0.05 with at least 60 s, `QUEUE_SHARE` 0.4, `EMPTY_SHARE_NOTABLE` 0.35 with more than 200 m, `DEPOT_DRIVE_SHARE` 0.08 with at least 3 drives, `NEED_NEEDED_FROM` 0.9, `NEED_BORDERLINE_FROM` 0.75.
Two exports are added to `insights.js` so that there is one source of the "more vehicles do not help" test: `fleetWaitShare(f)` and `congested(ctx, f)` (two `export` keywords, no behaviour change; a parity test compares them with the "relieve the congestion" suggestion of the `fleet-saturated` insight).
Hysteresis is on the value, not on time (at 600x a time rule means nothing): a fact appears at its threshold and goes below 0.85 x threshold.

### 3.1 A single vehicle (the centrepiece; id `fleetId#n`, a new selection kind `vehicle`)

Strip, in this order. Tiles 1 to 3 are the headline.

| # | Tile | Definition | Tag | W |
|---|---|---|---|---|
| 1 | **Trips per hour** (+ fleet mean) | deliveries (`vr.trips`) in the window / hours: the number of the Results tab (`fleets[f].vehicleTrips[id]`). For a fleet with capacity above 1 the reference line adds "x.x loads/h" and the (i) says "carries up to 2 loads, the average trip had 1.8" (loads carried = sum of `order.qty` of the loaded legs) | R, C | S L |
| 2 | **Busy, incl. waiting** (+ fleet mean) | (driving + traffic wait + dock queue + loading + unloading) / window. Driving includes drives to a charger and to park (the report's definition). Waiting counts as busy: a vehicle stuck in a queue looks busy. Equal to the vehicle's part of the fleet `utilization` (cross-checked, 1e-13) | C | S L |
| 3 | **Held up** (+ fleet mean) | (traffic wait + dock queue) / window: only seconds in which the vehicle is in a driving state and `tv.waiting` (below half of its free speed because of a vehicle, a junction or a broken vehicle ahead). The same quantity as `fleets[f].shares.waiting` and the traffic KPI | C | S L |
| 4 | **Driven** per hour | (loaded + empty + park metres) / hours from the odometers; the reference line shows the three shares of the metres: "loaded 43 % · empty 31 % · to depot 26 %" | R | S L |
| 5 | **Avg loaded trip** (+ fleet) | mean duration of the complete loaded legs, arrival at the pickup to arrival at the destination; unloading is not included and a breakdown's repair is excluded. The fleet value is the mean of the same quantity over the fleet's legs (not `avgTransit`, which includes unloading: 54 s against 65 s, not like for like) | C | S L |
| 6 | **Lowest battery** / **Parked** | fleets with a battery: the lowest charge reached **inside the window** (one Float32 per vehicle since the window began; the minimum of the bucket minima for *Last 30 min*) and the charge sessions that ended in the window. Fleets without: the parked share | C | S L |

Blocks:

| Block | Content and definition | Tag | W |
|---|---|---|---|
| **Where its time goes** | one stacked bar of **11 pieces** that sum to 100 % of the window: *driving loaded*, *driving empty*, *to depot / charger* (the three parts of driving), *traffic wait*, *dock queue*, *loading*, *unloading*, *no job*, *parked*, *charging*, *broken or dead*. A sparkline of "busy" per 30 s bucket over the last 30 minutes | C | S L |
| **Where it is held up** | *minutes per hour*. At most **four rows plus "Other places"**, so the rows add up to the *Held up* tile: (1) **Queue for X's dock**, seconds in the dock queue (`DockBook.waitsForDock`, per tick) of the legs that started in the window and went to station X; (2) cells named by what they are (*junction at Press line*, *dock of Central warehouse*, *road near Final assembly*): seconds booked on the cell that blocks (`traffic.waitNodeOf`, exactly what `nodeWait` counts), **without** the seconds already in a dock-queue row. *Other places* = tile minus the rows (never negative). Cell rows exist for *Since start* only; under *Last 30 min* the block shows the queue rows and "Other places (road cells: since start only)". A cell's share is its seconds divided by that vehicle's booked waiting of the same window. Footnote: "Booked on the cell that blocks (a junction or a dock), not where the vehicle stands" | C | S (cells), S L (queues) |
| **Trips** | the loaded origin-destination pairs by trips, up to 3 (section 4): trips, trips per hour, metres and mean time of the usual path, mean waiting, and how many ways (`usual`/`N ways`, grouped by the docks at both ends: "Dock 2 → Dock 1 61 % · Dock 1 → Dock 1 31 %"); "too few trips for a usual route" below 5 complete legs. **Usual round**: the most frequent pair of consecutive loaded trips between two visits of a depot ("Central warehouse → Press line, then Central warehouse → Machining, 3 of 11 pairs of trips, 27 %"; the empty drive between is implied; ties go to the one seen first; needs 3 occurrences). **Other drives** (disclosure): "39 empty · 27 to depot or charger", each with metres and mean time | C | S L |
| **Live line** (header) | state, target station, loads carried, metres to go on the route (`route.edges.indexOf(tv.edge)`, nothing stored); "did not fit on the road" for a vehicle in `fleets[f].unplaced` (it has no `VehicleRT`) | L | none |

**Facts** (at most four, in this order of priority; every number from the shown window):
1. *Held up.* "AGVs 1 is held up 7 % of its time (fleet 6 %); 69 % of that in the queue for a dock, about 3.1 min in every hour." when the tile is at least 5 % and 60 s. The queue share is `queue seconds / tile` of the same window, so it cannot exceed 100 %. Else the top cell with at least 40 % of the vehicle's booked waiting. Under *Last 30 min* only the queue form exists.
2. *Main trip.* "Its main trip Press line → Final assembly: 16 trips (7.6 an hour), 62 s each; always the same way." or "3 ways, the most used 41 % (Dock 2 → Dock 1 41 %, Dock 1 → Dock 1 33 %, ...): the dock chosen changes the way."
3. *Driving to park or charge.* "15 % of AGVs 1's time goes to driving to park or charge (27 times in 2 h 6 min); 26 % of its metres." at 8 % or more and at least 3 drives (run on Two lines, AGVs 1 over 2 h 6 min: 15 % of its time, 26 % of its metres, 27 times). Else *empty share*: 35 % or more of the metres and more than 200 m.
4. *The fleet question* (since start only; section 3.9): a statement about the **fleet**, shown on every vehicle of it.

Not in S1 (S2 and S3): idle on a dock ("stands idle on dock 3 for 7 % of the time and blocks it"), detour factor of the usual path (metres against the Manhattan distance of the dock cells; a fact from 1.6 and 20 m longer), share of the fleet's trips, p90 wait for a vehicle per origin.

### 3.2 Workstation

| Tile | Definition | Tag | W |
|---|---|---|---|
| **Output per hour** (+ capacity) | `produced` / hours; capacity = machines x 3600 / mean cycle x loads per cycle, headroom in cycles per hour | R, E | S |
| **Busy** | `utilization` (mean over machines) with the machine count | R, S | S L |
| **Waits for material** | `starved` share; the reference line names the input that was short (seconds the station starved while input link L had fewer than `perCycle` loads; the inputs can overlap) | R, S | S L (S for the input) |
| **Waits for removal** | `blocked` share | R, S | S L |
| **Waiting in front** | `avgIn` and `maxIn` of `inCap x inputs`; live count now | R, L | S |
| **Parts wait for a vehicle** | trip-weighted `avgPickupWait` of its outgoing flows (the Results number); p90 from the histogram of loads that left here; "waiting now: N, the oldest M min" (live) | R, C, L | S |

Blocks: the stacked bar busy / starved / blocked / down with the verdict word of `insights.js` ("limits the plant", "waits for material", "waits for removal", "breakdowns"); facts (the existing insight first; "busy 91 % with a queue: one more machine would bring its load to about 76 %"); a table of who brings loads (per supplier: trips per hour, mean approach
time of the legs that ended here) and the `docks[]` table (visits per hour, in service `busyShare`, only stood on `heldShare`, queue per visit `waitBefore / visits`); breakdowns (count, down share). *Time at the station* (Little: (mean input queue + busy machines) / arrival rate) is shown only with a stable queue (stock changed by less than 25 % over the window).

### 3.3 Goods in (source), with or without trucks and doors

A pallet's way: **truck arrives, gate, door, check-in, release to the yard, waits in the yard for room in the output buffer, waits in the output buffer for a vehicle, is picked up.** The first concept showed only the third wait and called it the vehicle wait; on Warehouse first day that wait is 8:33 min while the pallet needs 23:51 min from release to pickup.
`load.createdAt` is the truck's arrival (a plain source: the arrival), `load.readyAt` is the moment the pallet entered the output buffer (`flushYard`); the release is the end of check-in (event `truckReady`).

| Tile | Definition | Tag | W |
|---|---|---|---|
| **Arrivals** | `produced` / hours (pallets released; with trucks also "9 trucks in 2 h 50 min") | R | S |
| **In buffer** | `avgOut` and `maxOut` of the output buffer size | R | S |
| **Release to pickup** (headline) | mean of (yard wait + buffer wait) of the pallets picked up in the window: the yard part is measured per pallet (release, or creation for a plain source, until it enters the output buffer), the buffer part is the report's. Reference line: "yard 15:18 + buffer 8:33". Shown as "about"; the two parts are means over the same pallets. Under *Last 30 min* the buffer part is the collector's order-level mean of the window (same definition, not the cumulative report figure) | C, R | S L |
| **Buffer wait** (+ p90) | the report's **wait for a vehicle** (`avgPickupWait`, trip-weighted over the outgoing flows: first load of the order ready until pickup); p90 from a log histogram of the orders (8 bins per octave, within 4.5 %), since start | R, C | S (L: mean only) |
| **Doors busy** | `doorUtilization` of N doors; trucks that left | R | S |
| **Gate wait** | `gateWait` mean and p90 ("none: a door was always free" below 60 s) | R | S |

Blocks: *Output buffer and yard* (the `blocked` share as a bar, then "A pallet's way": truck gate and check-in, waiting in the yard (+ p90), waiting in the output buffer (+ p90), **waiting now: N loads, the oldest M min** (live: the loads that are ready and unclaimed; a mean of picked-up loads cannot see a load that is still waiting));
*Trucks at the doors* (only with `ops.trucks`: arrived, no-show, turned away, gate wait, door time, check-in + pallets taken away + check-out, gate queue); *Docks* (a table "Dock 1 to 4" with the cell as a second line: visits per hour, in service, queue per visit; "Door 1 to 3" for trucks); who serves it (visits by vehicle and fleet with the mean approach).
Facts: the existing insight first ("the doors are not the problem, the vehicles are"), the yard sentence ("A pallet needs 23:51 min from its release to the pickup: 15:18 in the yard (90 % under 25:12), 8:33 in the output buffer. 10 are waiting now, the oldest for 14:57."), the full-buffer sentence, the dock skew ("Dock 4 takes 66 % of the 226 visits").
Run (3 h, 224 pallets after warm-up): yard 15.3 min mean, p90 25.2; creation to release (gate and check-in) 5.0 min; buffer 8.6 per order and 8.7 per pallet; under *Last 30 min*: yard 4.5 min, buffer 9.5 min (the yard has drained).

### 3.4 Storage

Stock = `avgFill` x capacity (mean) with `maxFill` and the capacity; throughput = `produced` and `consumed` per hour [R, S]; **stays** = Little: mean stock / outflow per second, next to the configured dwell [E]; full share = `blocked`, empty share = `starved` [R, S L];
**trend over the last 30 minutes** = change of the sampled stock per hour, and only when |change| is at least 2 loads per hour the time to full or empty at that pace (indicative) [S, L]; docks as 3.2. Reads as: "falling 52 loads per hour and empty in about 1 h".

### 3.5 Goods out (sink), with or without trucks

Tiles: **Shipped per hour** and share of the plant's output (`throughput.bySink[id]`) [R]; **Lead time** mean, median, 90th percentile (creation of the oldest input to leaving here; a `SampleSet(2000)` per sink on `loadCompleted`, exact up to 2000 samples) [C, since start];
**Trucks** loaded / left short, pallets loaded of planned, `fillRate` [R]; **Door time** and doors busy [R]; **Staging** fill [R]; where the loads come from (loaded trips per origin with the mean transit) [C].

**Where the lead time goes** (replaces the first concept's sentence "the trip takes 28 s, so transport is not what makes the lead time long", which was false on the example it was written for): a table along the busiest chain upstream of the Goods out, built only from numbers the report and the collector already hold, labelled an **estimate**:
(1) *before a vehicle sees the load* = mean of (`readyAt - createdAt`) of the pallets that left the first Goods in (truck check-in and yard; collector, per pallet); (2) per flow on the chain: *waiting for a vehicle* (`avgPickupWait`) and *driving and unloading* (`avgTransit`); (3) per storage on the chain: the *stay* by Little minus the pickup wait already counted;
(4) *rest* = measured mean lead time minus the explained parts (machines, batching, branches, the Goods out's own staging). The sentence names transport as the cause only when waiting plus driving is at least half of the lead time; it says "waiting for a vehicle" when that part alone is 30 % or more.
Run (`final2/rules.mjs leadChain`, `lead2.out`): Warehouse first day, mean lead time 66.8 min = before a vehicle 20.3 + waiting for a vehicle 39.0 (8.6 + 30.5) + driving 1.7 + storage stay 1.2 + rest 4.5; sentence: "58 % of the mean lead time is loads waiting for a vehicle on the way; driving takes 3 %. 30 % passes before a vehicle first sees the load: truck check-in and the yard of the Goods in."
Dock lab: 84.0 min = 11.4 + 61.5 + 1.7 + 0 + 9.4 (73 % waiting for a vehicle). Two lines: 13.8 min, waiting 35 %, driving 29 %.

### 3.6 Depot (parking and charging)

Parked now and mean (`avgFill`; live `parked.length`) [R, L]; **chargers busy** = charging vehicle-seconds / (chargers x window) [C, S L]; charge stops per hour and mean stop length (session log of 2,048 rows) [C]; chargers in use now, the lowest battery now and whose vehicle [L]; which fleets use it (share of the parked seconds) [C]; vehicles waiting for a charger now [L].
Reads as: "chargers busy 91 %: vehicles probably wait for one".

### 3.7 Flow (arrow)

Delivered per hour and trips (`delivered`, `trips`) [R]; **wait for a vehicle** (`avgPickupWait`, mean of the loads that were picked up) with the p90 [R, C] **and "waiting now": loads ready and unclaimed, the oldest M min** [L] (the mean cannot see loads still waiting: a fleet with too few vehicles shows a short mean wait because the long waiters are not delivered yet);
`backlog` now and `avgBacklog` [R]; **transit** (`avgTransit`: picked up to delivered, includes unloading) and the part of it spent held up (loaded legs' waiting / leg time) [R, C]; load per trip against the capacity [R]; the usual route of the flow (section 4), its share, metres, mean time and the number of other ways [C];
carried by (share of the trips by fleet and vehicle) [C]; trend of the deliveries per hour in the last 30 minutes [C, S3].

### 3.8 Road cell, stretch of road, dock cell

Vehicles per hour = passes over the incoming links (`Stats.cellStats`, S2; in S1 `heat()` once a second for the one cell) [R]; **waiting here** = vehicle-minutes per hour booked on the cell (`nodeWait`), its share of all waiting, its rank among `traffic.hotspots` [R]; delay per vehicle = waiting seconds / passes [R];
**who passes here** = loaded and empty trips that cross it, by flow (a scan of the path pool, 2.4 to 3.3 ms, cached by `detail.version`) [C]; what it is: junction (one vehicle at a time), one-way or two-way, slow-zone factor, dock of station X [L]. A stretch (several cells): length, busiest cell, total and per-cell passes, summed waiting.
A dock cell shows its station's `docks[]` row on top (visits per hour, in service, only stood on, queue per visit, share of the station's visits, "one dock does the work" with `dockSkew.reason`). Since start only (the switch is disabled with a note).

### 3.9 Fleet

Tiles: **Busy** = `utilization` and the count; **trips per vehicle and hour** with the range over its vehicles; **held up** = `shares.waiting`; **empty share** (`emptyShare`); **load wait** (`avgPickupWait`, with the survivorship caveat of 3.7); **the fleet question**. Blocks: the fleet `shares` bar; a table of the vehicles (busy, trips per hour, held up, battery) whose rows select a vehicle [C]; lowest battery and breakdowns [R].
The fleet strip of `fleet-status.js` stays as it is; its tooltip gets one sentence that says how its "working" differs ("a drive to a charger counts as charging, a drive to park as idle").

**The fleet question** (replaces "is it needed" and "vehicles needed" of the first concept, which were arithmetically wrong, see 13). Inputs from the report: `n` = vehicles, `W = n x utilization` (work in vehicles), `Wp = W - n x shares.waiting` (the work without the waiting: queueing is not work and shrinks with fewer vehicles).
1. **Withheld while the fleet or the plant is congested** (`congested()`: waiting is 12 % or more of the moving time of the fleet or of the plant): "Vehicles queue (28 % of their moving time): the number of vehicles is not what limits this fleet, so no count is suggested. Look at the docks and the roads first."
2. Otherwise **forecast `F = Wp / (n - 1)`**: how busy the other n - 1 would have to be if one vehicle were taken away and all its work stayed (an estimate, not a simulation). `F` above 100 % or at least 90 %: *Needed*; above 75 % (`FLEET_TARGET_UTILIZATION`): *Borderline*; 75 % or less: *Spare capacity*. Never red.
3. A fleet that is busy at 95 % or more (`FLEET_CRITICAL_UTILIZATION`) hides how much work there is (W is cut off at n): the text says so and **no count of vehicles is printed**. Otherwise "At 75 % load the work would need about N vehicles" (an integer; `ceil(Wp / 0.75)`, the rule of the `fleet-saturated` insight).
4. Always: "Workload arithmetic, not a simulation: Test it with a sweep of the fleet size." (S3: the button opens the Experiments dialog with parameter `fleet.<id>.count` and the values n - 1, n, n + 1.) Since start only, 20 minutes measured at least, two vehicles at least.

Run (`final2/needed2.mjs`, `needed2.out`, 3 seeds, 2 h after warm-up, the real engine with one vehicle less):

| Plant / fleet | n | busy now | verdict and forecast | simulated busy at n - 1 | output per hour now → n - 1 | load wait now → n - 1 |
|---|---|---|---|---|---|---|
| starter / AGV | 2 | 71 % | needed, 135 % | 100 % | 20.0 → 18.8 | 44 → 194 s |
| two lines / forklifts | 3 | 61 % | borderline, 83 % | 85 % | 20.3 → 20.3 | 92 → 98 s |
| two lines / AGVs | 7 | 75 % | borderline, 77 % | 81 % | 20.3 → 20.5 | 61 → 68 s |
| congestion lab / AGV | 9 | 76 % | withheld (queueing 28 %) | 82 % | 35.7 → 35.3 | 136 → 138 s |
| dock lab / forklifts | 5 | 55 % | spare, 71 % (needs ~4) | 65 % | 39.0 → 38.3 | 1016 → 1023 s |
| warehouse first day / forklifts | 4 | 98 % | needed, 130 %, no count (cut off) | 100 % | 57.8 → 53.5 | 853 → 729 s |

The forecast is within 6 points of the simulated busy share (2, 4 and 6 points) on the three fleets that are neither withheld nor above 100 %; the two fleets with a forecast above 100 % saturate at 100 % in the simulation, as the verdict "needed" says. The first concept said "without it the other 6 would work 72 %" (the mean current share of the others, which for an average vehicle equals the fleet's utilization) and "needs 6.8": on Warehouse first day its "needs" followed the current count (4.0, 5.3, 6.1, 6.5, 7.3 for n = 3 to 8) while the output stayed at 60 per hour from n = 4.
Now: n = 3 and 4 no count (cut off), n = 5 "~6", n = 6 "~7", n = 8 withheld (queueing 18 %). What the arithmetic cannot know (a limit that is not vehicles) is why the sweep button is part of the sentence.

### 3.10 Several items selected

Replaces "n items selected" (Duplicate, Delete and the editing forms stay in Properties). Stations of one kind: one comparison table (busy / starved / blocked / queue; stock / throughput; arrivals / release to pickup; shipped / lead time); the worst value of a column carries the word "worst"; sorted by the clicked heading.
Vehicles: busy, trips per hour, held up and a fleet-mean row, and the routes of all drawn together. Road cells: total length, busiest cell (a button that narrows the selection), summed waiting and its share. Flows: delivered per hour, wait for a vehicle, transit. Sums only where a sum means something.

### 3.11 Nothing selected: the plant (S3)

Loads shipped per hour, lead time mean and p90, work in progress, vehicles busy, held up in traffic (deadlocks when above 0), the busiest workstation [R]; busiest routes by loaded metres [C]; the three most severe insights, each clickable; **peak 15 minutes and longest wait** from the profile ring (S3, section 6.9). A button *Open Results* leads to the full dashboard.

### 3.12 Item kinds without statistics

Walls and text labels: no dock (section 2.1). A truck at a door: part of the Goods in and Goods out pages ("Trucks at the doors"). An unplaced vehicle: the live line "did not fit on the road". A fleet with no vehicles: the fleet page shows the configuration only.

---

## 4. Vehicle routes: the exact definitions and the overlay

### 4.1 Definitions (all counted by the collector, section 6)

* **Leg** = one drive between two standstills: the engine states `toPickup`, `toDrop`, `toCharger`, `toPark`. It starts at `vr.stateSince` of the state and ends in the tick in which the state is left (arrival). A breakdown pauses a leg (its duration excludes the repair; run: 27 breakdowns, 18 paused legs on Two lines with breakdowns);
  a dead battery drops it; a deadlock relocation (`tv.teleports` changes) marks it **relocated**; a new route object (late dock choice, replan) marks it **re-routed** (the path is the route actually driven: `traffic.reroute` keeps the cells already driven);
  a leg already driving when the window starts counts as a trip but not in the time statistics (**partial**); a leg whose target is the cell the vehicle stands on begins and ends inside one tick (**zero length**, path -2, a trip, not drawn).
  Row: vehicle, kind, origin station, destination station, flow, path id, start time, duration, seconds held up, seconds queued for a dock, loads carried, flags (1 re-routed, 2 relocated, 4 ends at a waiting cell, 8 paused by a breakdown, 16 partial, 32 zero length).
* **Origin of a leg.** A loaded leg's origin is the **station of its order**, whatever cell its (re)planned route starts on. (The first reference collector overwrote it with "a road cell" when a deadlock relocation re-planned the route: 26 of 34 relocated loaded legs lost their origin and fell out of every pair table. Fixed and run: 0 of 34.) An empty leg keeps the first origin it had.
* **Trip** = a loaded leg; an **empty drive** = a `toPickup` leg; a **drive to depot** = a `toCharger` or `toPark` leg. The trips per hour tile is the report's delivery count; the route tables count loaded legs. They agree exactly (run, 6.3 and 13.3): a delivery whose leg the poll could not see is reconstructed from the engine's own `orderDelivered` order
  (36 of 49 zero-length loaded legs on 270 plants - 220 hostile truck plants, 40 hostile plants, the 5 frozen dock plants and the 5 examples - were invisible to the state sequence), and the only legs without a delivery are the unloading in progress and orders cancelled on the way (32 of 5,385). The (i) of the trips list says "a trip is a loaded drive; Results counts deliveries".
* **Origin-destination pair** = (kind, origin station, destination station). A **path** is a distinct sequence of road cells. A **variant** of a pair is a distinct *drawable* path of its legs; zero-length (-2), pool-overflow (-1) and relocated legs are trips but not variants and not in the share (reported as "N trips not drawn").
* **Usual route.** The most frequent drawable path of a pair (ties: the lower path id, i.e. the path seen first; pairs with equal trips are ordered by metres, then by station order), with trips and trips per hour, **the share of the pair's drawable trips it carries**, the number of other ways, metres, and mean time and mean waiting over its complete legs. **"Usual" is claimed only when that share is at least 50 % and the pair has at least 5 complete legs.**
  Between 5 legs and a share of 50 % the row says "N ways, the most used 41 %"; below 5 complete legs "too few trips for a usual route".
* **With several docks the route depends on the dock.** On the examples with docks the modal share is 29 to 74 % with 3 to 7 variants per pair (Dock lab and Warehouse first day; 100 % on Two lines and Congestion lab), and the variants are exactly the pairs (start dock, end dock): no pair of docks has two paths in the examples (critic run). So the trips list groups by
  docks: "Dock 2 → Dock 1 61 % · Dock 1 → Dock 1 31 %", and the dock choice is itself a finding (it links to the `dockSkew` insight). The plan draws **every variant with at least 10 % of the pair's trips**, each with its own width, not "the usual plus one thin".
* **Usual round.** The most frequent sequence of 2 consecutive loaded trips (origin → destination pairs) between two visits of a depot or charger; the empty drive between them is implied. It answers "which route does this car usually take" as a loop. Counted over the window's legs of the vehicle, ties go to the sequence seen first, at least 3 occurrences, shown with its count of all pairs of trips
  ("3 of 11, 27 %"). Run: Two lines AGVs 25 to 33 % (3 of 9 to 4 of 14); the forklifts of Warehouse first day 46 to 50 % ("Goods in → Storage, then Goods in → Storage", 33 to 35 of about 70). *Show on plan* draws the two usual paths numbered 1 and 2 and the implied empty drive dashed between them.
* **Delay** of a trip = seconds held up during the leg / leg duration (exact, from the engine's own `tv.waiting`), split into traffic wait and dock queue (`DockBook.waitsForDock`). Held-up seconds in a state that is not a driving state (after a breakdown) are not the leg's.
  Run (critic, Two lines): the excess of a loaded trip over the best leg on the same path was 4.7 s against 4.2 s flagged waiting; on Warehouse 2.3 s against 1.8 s: "waits N s" does explain the real delay.

### 4.2 Drawing (`js/ui/render/routes.js`, overlay flag `routes`, default on)

Drawn above the heat map and the flow arrows, below the vehicles. Flow arrows recede to 35 % while a route overlay shows; with heat on, the routes get a halo; the Jobs overlay is drawn only for the selected vehicle while routes show, so the two colour languages never compete.

* **Geometry.** A polyline along the cell centres, moved 0.22 cell to the right of the direction of travel on two-way roads (where the vehicles drive), so that loaded and empty do not cover each other; corner points only; cached as a `Path2D` per path id.
* **Width** = cell pixels x (0.20 + 0.32 x sqrt(trips / most trips)), clamped to 2.4 to 10 px, **per drawn variant** (a variant with 33 % of a pair's trips is a third as wide as the usual one in trips terms, not a thin ghost).
* **Colour** = share of the trip lost to waiting on a ramp blue (calm), amber, red. **The ramp is scaled to the routes on screen**: its red end is the 90th percentile of the shares drawn, rounded to 5 % and clamped to 8 to 30 %, so that a normal plant shows blue, amber and red (with a fixed 25 % the first mock-up showed nearly every route amber or red on Two lines: the planner critic's reading). The legend chip states the scale ("time lost waiting: none → 30 %+").
  Light and dark values are tokens (`--route-calm`, `--route-some`, `--route-much`, `--route-halo`, `--route-chevron`).
* **Dashed** = empty drives and drives to a depot (never colour alone); chevrons every 30 px on loaded routes; a rank badge 1 to 3 at the destination of the top pairs; a **ring where it queues** (sized by the seconds; the label on the biggest: "Queue for Press line's dock: 1.5 min/h"); a selection ring and a name chip on the vehicle; at most 6 loaded and 4 empty pairs per selection.
  Under *Last 30 min* only queue rings are drawn (cell rings are since start only).
* **Hover or focus** on a list row draws that path strong and dims the others to 28 %; Enter pins it; the key states the scale. On a phone lines are 1.6 to 4.8 px and *Show route on plan* fits the camera.
* **The same overlay serves the other kinds:** a station shows the corridors of its loaded trips (out and in), a flow its usual route, a cell the routes that cross it, a fleet the union of its vehicles' usual routes, the plant the busiest four routes plus the worst waiting cells.
* **Frame budget** (to be held by an e2e probe, not run): at most +0.5 ms per frame at 600x on the 100-vehicle plant. The planner's spike built 11 paths as `Path2D` in 0.17 ms and issued about 25 stroke calls in about 0.01 ms in headless Chromium (software raster); it was not re-run in this stage.

---

## 5. Honesty rules (what the dock promises)

1. Every headline number has an (i) with its counting rule and its window; the dock says "N min measured, warm-up excluded" and "counted since 0:10"; under 20 minutes "indicative".
2. Three kinds of number are never mixed without a word: exact (R, C), sampled (S: "sampled every second"), estimate (E: Little's law, time to full, the fleet question, the lead-time chain, the forecast: shown as "estimate" or "workload arithmetic, not a simulation"). Estimates are rounded to whole units (never "6.8 vehicles").
3. Counts say what they are based on ("based on 86 of 92 trips"); no verdict below 5 legs, 10 events or 10 minutes.
4. The collector's window starts when it is enabled. Enabled after the run started (the Simulate switch): "counting since 0:50" (run: window start 3,000 s while `kpis().window.start` stays 600 s). A runtime setting changed inside the window (demand factor, speed, dispatch, routing) is noted at the next 30-second bucket:
   "settings changed 10 min ago: earlier figures mix both" (run). When the number of vehicles or stations changes under a running collector it restarts its window with the notice "The vehicles or stations changed; the statistics start counting again here" (run).
5. A figure that has no 30-minute version keeps its since-start value and says so (rule B). Every printed share is at most 100 % (rule C).
6. A day plant (clock and timetable) restarts its simulation at the clock's start on every edit; its windows read "since 06:00".
7. Little's law and trends assume a stationary window; a queue that only grows withdraws them.
8. The report and the dock agree: where the report has a number the dock shows the report's (tag R); the collector's counterpart is cross-checked by test.
9. A mean over loads that were picked up cannot see a load that is still waiting. Wherever a wait for a vehicle is shown, "waiting now: N loads, the oldest M min" is shown beside it.
10. A statement about what to change is made only from what was measured: no "add vehicles" while vehicles queue, no "transport is not the cause" from a short transit time, no vehicle count from a fleet that is cut off at 100 %.

---

## 6. Data model, collector API and seams

Reference implementation (revision 2, **run**): `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m3/spike/final2/tree/C/js/sim/detail.js` (871 lines with comments) with the seams in the same tree (`engine.js`, `traffic.js`, `stats.js`); the untouched copy of the repo's `js/` is `.../spike/final/tree/A`.
The UI-side rules and view-model of the mock-ups: `.../spike/final2/rules.mjs`, `fobs.js`, `final-scene.js`, `overlay.js`. The build copies and hardens these; it does not re-design them.

### 6.1 Seams (the only edits outside new files)

```js
// js/sim/engine.js  (S1; about 25 lines, 10 of them comments)
import { Detail } from './detail.js';
...constructor:   this.detail = null;                 // set by enableDetail(); nothing in kpis() depends on it
                  this.detailError = null;            // why the collector was dropped (an Error), else null
...step(dt):      this.stats.sample(dt);
                  let fresh = false;
                  if (!this._measuring && this.time + WARMUP_EPS >= this.settings.warmup) { this._measuring = true; this.stats.reset(); fresh = true; }
                  if (this.detail !== null && !this.detail.afterTickSafe(dt, fresh)) this.dropDetail();   // never throws; the tick that ends the warm-up is not sampled, like Stats
enableDetail(opts) { if (this.detail === null) this.detail = new Detail(this, opts); return this.detail; }
dropDetail()       { this.detailError = this.detail.error || null; this.detail.detach(); this.detail = null; }   // called by step() only
disableDetail()    { if (this.detail !== null) { this.detail.detach(); this.detail = null; } }

// js/sim/traffic.js (S1): the cell this vehicle's waiting is booked on (what _bookkeep books to nodeWait); read only
waitNodeOf(tv) { return tv._blk === 2 ? tv._blkNode : this._cellOf(tv); }

// js/sim/stats.js (S2): window figures of ONE road cell without the allocation of heat()  (19 lines; run: equals heat() on all 119 cells of Congestion lab, 0.4 us against 15 us)
cellStats(node) -> { passes, passesByDir[4], wait, edgeWait } | null

// js/sim/insights.js (S1): export fleetWaitShare and congested (the one source of "more vehicles do not help"); no behaviour change
```

Headless runs, experiments, sweeps, the runner's paired control run and the tests never call `enableDetail()`. A **ledger test** (like `tests/sim.seams.test.js`) fails when anything outside `js/sim/detail.js`, `js/sim/engine.js`, `js/ui/runner.js`, `js/ui/panels/stats-*.js`, `js/ui/render/routes.js` reads `.detail`
(and a second ledger lists the roughly 25 sim internals the collector reads: `vr.stateSince`, `vr.state`, `vr.order`, `vr.route`, `vr.dock`, `vr.battery`, `vr.trips`, `tv.waiting`, `tv.teleports`, `tv.driving`, `tv.edge`, `tv.s`, `tv._blk`, `st.machines[].state`, `st.inLinks[].queue`, `st.outLinks[].queue/claimed`, `st.yard`, `lg.docks.waitsForDock`, `graph.stationsAt` ...,
so that an in-flight change to one of them fails a named test instead of silently changing the numbers).

### 6.2 What the collector holds (nothing grows with run length)

| Structure | Content | Size |
|---|---|---|
| Leg log (ring, struct of arrays) | vehicle u16, kind u8, from u16, to u16, flow u16, path i32, start f64, duration f32, held up f32, dock queue f32, loads u16, flags u8 = 36 B per row | 32,768 rows = 1,152 KiB. Measured 1,678 to 1,829 legs per simulated hour on the 100-vehicle plant, so a shift never reaches the cap; at the cap the oldest rows drop and the window text says "last 32,768 trips". The real build may start at 2,048 rows and double |
| Path pool | distinct drawable cell paths, interned by route object (`WeakMap`) then FNV hash with verification; start cell + 2 bits per step (N, E, S, W); decoded on demand | cap 16,384; 744 paths (shortest routing) / 1,277 (congestion routing) after 1 h on the big plant = 56 / 108 KiB; beyond the cap a leg keeps path -1: counted, not drawn |
| Time matrix | `Float64Array[vehicle x 12]`: the 9 slots (driving, waiting, dockQueue, loading, unloading, idle, parked, charging, broken) plus 3 sub-slots of driving (loaded, empty, to depot) | 10 KiB at 100 vehicles |
| Cell tables | four per vehicle, 24 cells each (key i32, seconds f32) plus a folded `other`: `hot` (waiting in a driving state, the tile's seconds), `hotQ` (the part of it that was a dock queue), `hotStray` (waiting in a state that is not a driving state: booked by traffic's `nodeWait`, not part of the tile), `idleHot` (where it stood without a job). Fed through a per-vehicle running streak, so a table is touched once per streak | about 77 KiB at 100 vehicles; 2,092 of 2,400 `hot` slots used after 1 h |
| Snapshot ring | every 30 s of window time one row of cumulative figures per vehicle (12 time columns, deliveries, loaded / empty / park metres, loads carried, battery now, lowest battery in the bucket) and per station (sampled integrals of fill, input queue, output queue, machine-seconds busy / starved / blocked / down; arrivals, produced, consumed; and the event sums of Goods in: orders, buffer wait, pallets, yard wait, creation-to-ready); 61 rows; float32; *Last 30 min* = current minus the oldest row | 1,203 KiB measured (100 vehicles, 225 stations) |
| Station integrals | sampled once per simulated second; `starvedBy[station x 8 links]` | 36 KiB |
| Events | `sinkLead` `SampleSet(2000)` per Goods out (`loadCompleted`); `pickWait` and `yardWait` log histograms (160 bins, 8 per octave) per origin station (`orderDelivered`, `orderPickedUp`); `releaseAt` truck id → release time (`truckReady`, deleted at `truckDeparted`) | lazily, a few KiB per used station |
| Charge sessions | start, minutes, battery before and after; ring of 2,048 rows | 45 KiB |
| Depot seconds, what-if log | parked and charging vehicle-seconds per depot; `[{ t, key, from, to }]` of runtime setting changes | tiny |

Total **2,573 KiB of typed columns** on the 320 x 320 plant after 1 simulated hour (shortest routing; 2,625 KiB with congestion routing), +3.2 MB of process footprint (run); the examples hold about 1.2 MB (the leg log is preallocated).

### 6.3 What runs per tick (the poll)

Per vehicle and tick, allocation-free:
1. One float compare and one string-pointer compare (`vr.stateSince !== last || vr.state !== lastState`; both are needed: a change in the very first tick of a run keeps `stateSince` = 0) find every state change; on a change the open leg closes and a new one opens. A change of `vr.order` or `vr.targetId` while a leg is open counts as a change too.
2. One integer compare `vr.trips !== lastTrips`: the engine counted a delivery. Every delivery has a loaded leg; if `vr.trips - base - credit - legsLoaded` is positive, that many zero-length loaded legs are filed from the order of the engine's own `orderDelivered` event (a drop on the cell the vehicle stands on with unloadTime 0, or a load and a drop inside one tick, begin and end inside a tick and the state sequence never shows them).
   `credit` = 1 for a vehicle that was unloading when the window began (its delivery has no leg inside the window).
3. While a leg is open: `vr.route` identity (a late dock choice or a replan = re-routed), `tv.teleports` (relocated).
4. `vr.battery` against the vehicle's running minimum and the bucket minimum (two float compares).
5. `tv.waiting`: the seconds go to the vehicle's cell table by `traffic.waitNodeOf(tv)` (driving states only; others to `hotStray`), to the open leg's held-up seconds and, when `docks.waitsForDock(vr, vr.dock)` is true, to the leg's dock-queue seconds and to `hotQ`.
6. `dt` to the vehicle's slot: the base slot of its state, except that a vehicle in a driving state with `tv.waiting` is "traffic wait" or "dock queue" (as `Stats.slotOf`; a held-up vehicle in another state is not "waiting"); a driving slot also adds `dt` to its sub-slot (loaded, empty, to depot).
Once per simulated second the stations are sampled; every 30 s a ring row is written and the what-if check runs. Events by `sim.on(name, fn)`, no wildcard: `loadCompleted`, `orderDelivered`, `orderPickedUp`, `truckReady`, `truckDeparted`. The collector reads only; it calls nothing that mutates (`waitsForDock` is a pure read) and uses no random numbers.

### 6.4 Public queries (the contract between the sim builder and the UI builders)

Allocating queries, meant for the one selected item at UI pace. `w` is a window object: `windowOf('start' | 'last30')` → `{ kind, t0, seconds, row, zero }`. Indices `i` are vehicle indices (`det.V[i]`, the order of `sim.vehicles`) and station indices (`det.stations[i]`, `det.stIndex.get(id)`).

```js
class Detail {
  constructor(sim, { legCap = 32768, pathCap = 16384 } = {})
  // state
  windowStart, version /* bumps on every leg close and bucket close: the overlay redraws when it changes */, notices /* [{ t, text }] */, failed, error, memoryBytes, nV, nS
  afterTickSafe(dt, fresh) -> boolean   // the engine's entry; never throws; false = failed (the engine drops it)
  reset(t); detach()
  windowOf(kind) -> { kind, t0, seconds, row, zero }

  // vehicles
  timeSplit(i, w)  -> { seconds, driving, waiting, dockQueue, loading, unloading, idle, parked, charging, broken, drivingLoaded, drivingEmpty, drivingDepot }   // seconds = sum of the 9 slots; the 3 sub-slots sum to driving
  counts(i, w)     -> { trips, loaded, empty, park, qty }                          // the report's own counters for the window (trips = deliveries)
  workingSeries(i, n = 60) -> number[]                                              // busy share per 30 s bucket, oldest first
  batteryOf(i, w)  -> { now, min /* lowest inside the window */, stops: [{ t0, minutes, b0, b1 }] }
  routesOf(i, w, kinds /* [1] loaded, [0] empty, [2, 3] depot */) -> [{ kind, from, to, flow, trips, complete, meanTime, meanWait, meanDockWait, meanQty,
        pathId, pathShare, drawn, undrawn, variants, metres, usualTime, usualWait, disturbed, pathIds: [{ id, n, complete, meanTime, meanWait }] }]   // drawable variants only; relocated, -1, -2 legs are `undrawn`
  roundOf(i, w, jobs = 2) -> { jobs: [{ from, to }], count, of, share } | null
  queuesOf(i, w)   -> [{ station, seconds, legs, dockNode }]                       // dock queue by destination station, legs that started in the window
  hotspots(i, n)   -> { cells: [{ node, seconds }], total, folded }                // SINCE START only; without the dock-queue seconds; read-only
  idleSpots(i, n)  -> [{ node, seconds }]                                          // since start only
  metresToGo(i)    -> number | null                                                // live

  // stations and routes
  stationWindow(i, w) -> { seconds, fill, inQ, outQ, busy, starved, blocked, down, arrivals, produced, consumed, orders, bufferWait, pallets, yardWait, intakeWait }
  queueNow(i)      -> { loads, oldest }                                            // live: ready, unclaimed loads in the output buffers and the age of the oldest
  visitsTo(i, w)   -> { visits, meanApproach, meanDockQueue, byVehicle: [{ veh, visits }] }
  loadedRoutes({ from?, to? }, w) -> [...]     busiestRoutes(w, n) -> { total, routes }     cellUse(nodes, w) -> { legs, byFlow }
  pickWait, yardWait: Map(stationIdx -> LogHist{ n, sum, max, percentile(p) }); sinkLead: Map(stationIdx -> SampleSet)
  pool.nodes(pathId) -> Int32Array; pool.len[pathId]; pool.start[pathId]
}
```
S2 adds: the per-flow delivered ring, `depotUse(i, w)`, `starvedBy(i)`, a per-bucket sampled stock series; S3 the profile ring (6.9). A query never changes what the collector records next (run: digests of the collector state after a run with every query called every 7 s equal those of a run without queries on three plants).
The UI side `stats-model.js` turns `report + insights + queries` into view-models and facts; it is pure and the only place with sentences.

### 6.5 Reset, warm restart, windows, late enabling

`reset(t)` runs at the end of the warm-up, at the same instant as `stats.reset()` (through the `fresh` flag), clears the window's data, keeps identities and the path pool, and turns drives in progress into *partial* legs. A warm restart builds a new `Simulation`, enables a **new** collector before the pre-roll and swaps both in together; the old collector goes with the old simulation. A cold restart, reset or variant switch starts a fresh one.
The collector's state is a pure function of layout and seed, not of how the run was cut into slices (run: identical digests for a straight run, a repeat, 7.3 s slices, a run cut at 900 s, and a warm-restart pre-roll to 1,200 s, on Two lines and Warehouse first day, with the revised collector).
`ui.detail` (default on, "Collect statistics for clicked items", Simulate tab) switches it off with `disableDetail()`; the dock then shows the tile strip of the report-only figures. Enabled late, the window starts when it is enabled and the dock says so.

### 6.6 Failure containment (added after the review)

The collector is optional and must not be able to stop the simulation. `afterTickSafe` catches everything, event listeners run through `guard()`, and a failure sets `failed` and `error`; the engine then drops the collector (`dropDetail`), keeps `sim.detailError` and the dock shows "Statistics stopped: <reason>. Turn them on again in the Simulate tab" while the simulation runs on.
Because `Logistics.removeVehicle` exists ("a vehicle sold or scrapped while the plant runs") the collector compares `lg.vehicles` and `lg.stations` (identity and length) every tick; on a change it re-allocates its arrays, restarts the window and records a notice (the UI normally rebuilds the Simulation instead, so this is a safety net, not a feature).
Run: 94 of 94 hostile plants with a `removeVehicle` action keep running with the collector on (the first reference threw `Cannot read properties of undefined (reading 'stateSince')` on every later tick in 70 of these 94: 19 of 26 in seeds 1 to 60 and 51 of 68 in seeds 61 to 220), 70 show the notice, kpis identical to the run without a collector; a listener that throws and an `afterTick` that throws both leave the run complete, `sim.detail === null`, `detailError` set, kpis identical.

### 6.7 Why the golden tests stay byte-identical

1. Nothing in `kpis()` or `report()` reads the collector; `stats.js` gets one new method (`cellStats`, S2) that no existing path calls; `engine.js` gets one pointer test per tick, `traffic.js` one read-only accessor.
2. The collector only reads simulation state, uses no random stream and mutates nothing; its listeners are appended after those of `Stats` and cannot throw into the bus.
3. Evidence (**run**): 43 golden runs (the three legacy examples x seeds, the dock variants, the five frozen dock plants; `tests/fixtures/golden`) compared as text with the untouched tree, the seams without a collector and the seams with the collector on: all three equal the fixture byte for byte;
   80 hostile plants run with a full-state fingerprint (positions, states, odometers, statistics) after a run in which the collector is switched on, off and on again in the middle: 80 of 80 identical; Dock lab and Warehouse first day: kpis, heat map and vehicle poses identical with the collector on.
4. The build extends `tests/sim.golden.*` so that each recorded run is repeated with `sim.enableDetail()` and compared with the same fixture text.

### 6.8 Station figures from the poll: what is sampled

A station is sampled once per simulated second (fill, queues, machine states, which input of a starving workstation is short). Measured error against the report: below 0.0007 in a share on the examples; counters (produced, consumed, arrivals) are exact. Sums over a window come from the float32 ring (error 1e-7 of the cumulative value; the yard mean of *Last 30 min* agrees with an independent tally to 0.01 s).

### 6.9 The profile ring (S3, designed, memory arithmetic only, not run)

For peaks and the shape of the day: a second, coarse ring of **288 buckets of 5 minutes (24 h)** for station and fleet aggregates only: per station produced (or consumed), busy machine-seconds and the input queue integral (3 float32); per fleet busy vehicle-seconds, held-up vehicle-seconds and trips. On the 225-station plant 225 x 288 x 3 x 4 B = 778 KB, so the biggest plant would hold about 3.4 MB of columns.
"Peak 15 minutes" = the highest sum of three consecutive buckets x 4 per hour; "longest wait" = the largest `waitForPickup` seen per origin station (one scalar from the event). The ring is written once per 5 minutes: no per-tick cost. A day plant (24 h of clock) fits exactly; longer runs keep the last 24 h. The first step of S3 is a spike that re-measures memory and bucket cost.

---

## 7. UI architecture: touch points

**New files:** `js/ui/panels/stats-dock.js` (shell: overlay element, states, header, window switch, sheet, open rule, keyboard), `js/ui/panels/stats-model.js` (pure: view-models, definitions text, windows text, arrows rule, facts engine, fleet question, cell and dock names; the only place with sentences),
`js/ui/panels/stats-view.js` (tiles with (i), split bar, tables, hover and pin, in-place update), `js/ui/render/routes.js` (the overlay), `css/stats.css`, `js/sim/detail.js`.

**Edited (small; after the in-flight workflows merge):**
* `js/ui/app.js`: mount the dock into the stage cell, `coveredAtBottom()` and `revealMinimal()` in `createCameraControl`, the `I` key and `[`/`]`, the open rule (store subscription + `pointerup` capture + `ed.currentTool.busy()`), the *Routes* switch in the overlay bar, `--dock-covered` for the floating controls.
* `css/layout.css`: the dock rules (a stage-cell overlay; the phone sheet), `index.html`: the stylesheet.
* `js/store/store.js`: `SELECTION_KINDS` += `vehicle` with its existence test (the fleet exists and 1 <= n <= count, so it survives warm restarts; a fleet shrunk by an edit falls back to the fleet selection with a toast), `PREF_KEYS` += `detail`, `statsDock`; `OVERLAY_FLAGS` += `routes`.
* `js/ui/editor/select.js`: `armPick` selects the vehicle (`kind: 'vehicle'`, id `fleetId#n`; Shift toggles); hover text "Vehicle AGVs 1. Click for statistics"; walls and labels clear the dock selection.
* `js/ui/panels/inspector.js`: `planFor` case `vehicle` → the fleet summary titled "AGVs 1" with "Edit the fleet in the Fleet tab" (no new form).
* `js/ui/runner.js`: two lines (`enableDetail()` after `new SimClass(layout)` in `buildSim` and in `startPriming`, guarded for stand-ins that have no such method) and `runner.detail()` returning `sim.detail`.
* `js/ui/renderer.js`: one call `drawRoutes` in `drawLayers`; the frame's `selFleet` highlight also marks a selected vehicle with a ring.
* `js/ui/panels/simulate.js`: the switch "Collect statistics for clicked items" and the select "Statistics on click"; `js/ui/panels/fleet.js`: the vehicles of a fleet as buttons (state dot, trips per hour); `js/ui/panels/fleet-status.js`: one tooltip sentence.
* `js/sim/engine.js`, `js/sim/traffic.js`, `js/sim/insights.js` (two exports), `js/sim/stats.js` (S2), `tests/helpers/fake-sim.js` (a scriptable `VehicleRT`, a `DockBook` stub, a fake collector), the golden tests, the tiers list, `docs/ARCHITECTURE.md` (3.1 a second, separate seam beside `stats.ext`; 5.4; 6.12), README, the Help page.

Tests that assert "a click on a vehicle selects its fleet" must change; candidates found by grep, to be checked one by one: `tests/e2e/integration.mjs`, `panels2.mjs`, `roads-canvas-combined.mjs`, `render-visual.mjs`, `tests/store.test.js`, `tests/ui.renderer.test.js`.
In flight at the time of writing in the same tree: `js/ui/**`, `js/sim/**`, `js/model/**` (examples, the M1 review fixes, the version display); `git status` at HEAD `50cb134` showed a clean tree, so the sim seams are mergeable at once, the UI edits after the in-flight work lands.

---

## 8. Performance budget and the measured numbers

Gates (WAREHOUSE-DESIGN 10.5): collector off within about 2 to 3 % CPU of today; collector on at least 500x real time on the shipped examples; golden and determinism unaffected; the app runs up to 1200x and plants up to 320 x 320 cells with about 100 vehicles.
**All numbers below: run in this stage on a 4-core machine with load average 0.4 to 2.3 (other workflows running), best of interleaved rounds; run-to-run noise is +-10 %, so smaller differences are "not measurable".**

| Measurement (script in `spike/final2/`) | Result |
|---|---|
| Collector off against the untouched tree (`overhead-final.mjs --rounds 12`, CPU seconds per simulated hour, best of 12) | starter -0.3 %, two-lines +0.2 %, congestion-lab -4.3 %, dock-lab -1.8 %, warehouse-first-day -1.4 % (negative = noise). Analytic cost: one pointer test per tick. The project's own `scripts/perf-baseline.mjs --root A --root C` was run on the first reference (-1.2 to -4.3 %); the off path of the revision is identical, it was not re-run |
| Collector on, over the same tree with it off | starter +18.3 % (0.057 against 0.048 s per hour, too small to resolve), two-lines +11.3 %, congestion-lab +10.9 %, dock-lab +9.5 %, warehouse-first-day +8.3 %; kpis identical in all five |
| Real-time factor with the collector on | starter 63,550x, two-lines 16,517x, congestion-lab 19,132x, dock-lab 36,819x, warehouse-first-day 33,087x (gate 500x) |
| Biggest plant (320 x 320, 17,010 road cells, 225 stations, 100 vehicles), 1,200 simulated s, shortest routing | sample 1 (load average 2.2, best of 4): untouched 615x, collector off 594x, **collector on 518x** (+14.8 % over off), `afterTick` 136 ns per vehicle and tick = 6.9 % of a 197 us tick. Sample 2 (load average 1.7, best of 6): untouched 640x, off 655x, **on 620x** (+5.8 %), 114 ns = 6.7 % of 170 us. The first reference measured 598x against 609x. **The margin to the 500x gate on this plant is thin and noisy**; the lever is a poll every k-th tick with sample-and-hold (like the dock book's 1 s `ACCOUNT_SPAN`), not built. Congestion routing: 160 to 170x with or without the collector (route search dominates) |
| Memory after 1 simulated hour on the biggest plant | typed columns 2,573 KiB (leg log 1,152, snapshot rings 1,203, path pool 56, cell tables about 77, integrals 36), process footprint +3.2 MB (the simulation holds 116 MB); congestion routing 2,625 KiB, +3.3 MB |
| Queries with a full leg log (32,768 rows, 10 vehicles), UI pace | `routesOf` 0.14 ms (loaded), 0.27 ms (all kinds), `roundOf` 0.13 ms, `queuesOf` 0.30 ms, `visitsTo` 0.19 ms, `hotspots` + `idleSpots` 0.009 ms, `stationWindow` + `queueNow` 0.002 ms; on the 100-vehicle plant `busiestRoutes` 0.6 ms, `cellUse` 2.4 to 3.3 ms (a path-pool scan: cache by `version`); for comparison `kpis()` 0.6 ms and `heat()` 1.0 ms there |
| UI cost | 4 Hz of 0.01 to 0.3 ms per query is below 1.3 % of a core. **Overlay frame time: not run** (see 4.2); hold it with an e2e probe |
| Pre-roll of a warm restart | the collector adds its 6 to 18 % inside the existing `PRIME_MAX_MS` cap (4 s): the largest plants reach slightly less simulated time in the pre-roll |

The UI runs the 100-vehicle plant at about 600x at best (CPU bound, `runner.limited` as today), so 1200x is reachable only on the examples, where the collector is invisible. For plants of 1,000 vehicles (`MAX_FLEET`) the lever above is needed; not built.

Why the first number moved: the revision adds per-vehicle work (the delivery compare, the battery minimum, the sub-slot, the disjoint dock-queue table) and larger rings (19 floats per vehicle and 15 per station instead of 15 and 10): +0.6 to +5.9 points of CPU over the first reference on the four larger examples, +0.35 MB.

---

## 9. Milestones and the build plan of each

Each milestone ships on its own and leaves the product consistent. Effort is in **engineer-days in the convention of `docs/WAREHOUSE-DESIGN.md` 9.0** (adjusted for UI, examples, tests and review fixes; M1 trucks and doors, a milestone with model, simulation, UI and e2e, was estimated 7 to 9 there), **plus or minus 30 %**. They are estimates; nothing in this section was run.
They replace the first concept's 29 to 38 days (6 to 8 for the report-only step, 14 to 18 for the collector, vehicle view and routes, 9 to 12 for the rest), which the engine critic found "about 1.5x short". The new total is 48 to 64: the first count's scope times 1.5, plus what the review added (the phone sheet and the open rule, the collector hardening, the tile strips, the yard and lead-time work, the profile ring).
S1 is about four times M1 because it carries the collector, a new kind of UI element (an overlay dock with a phone sheet) and a canvas layer with a frame budget. A cheaper cut line exists (9.4). Builder names are roles of a following workflow; **a file has one owner**, a builder never edits another's file (the one exception is a named hand-over).

### 9.0 Overview

| Step | What the planner gets | Days (low-high) | By role |
|---|---|---|---|
| **S1 Vehicle first** | click a vehicle: dock with the six numbers, the time split, where it is held up, the facts incl. the fleet question, usual trips by dock, the usual round; the routes on the plan; Last 30 min; click any other item: its six numbers (tile strip, from the report). The collector, the overlay, the phone sheet | **26-34** | SIM 6-8, SHELL 8-10, MODEL 6-8 (incl. the strips), OVERLAY 3-4, VERIFY 3-4 |
| **S2 Every other item** | the full page of a workstation, Goods in with trucks, yard and docks, storage, Goods out with the lead-time chain, depot, flow, road cell and dock cell, fleet table, several selected | **13-18** | SIM 2-3, MODEL 7-9, SHELL 1-2, OVERLAY 1, VERIFY 2-3 |
| **S3 Overview and polish** | plant overview with peaks, the measured what-if (sweep of the fleet size), baseline chips, copy as table, follow a vehicle, status-line hover numbers, help page, accessibility pass | **9-12** | SIM 2-3, MODEL 3-4, SHELL 2, OVERLAY 0.5-1, VERIFY 1.5-2 |
| Total | | **48-64** | |

With SIM, MODEL and SHELL working in parallel the calendar time of S1 is the length of the dock shell plus integration, about two thirds of the sum. The collector itself is mostly done: the reference exists and is verified (section 6); SIM's 6 to 8 days are production hardening, the unit and fuzz tests, the seams and the ledger.

### 9.1 S1 Vehicle first

**Ships.** Click a vehicle (or choose it in the Fleet tab): the Statistics dock with the six numbers, *where its time goes* (11 pieces), *where it is held up* (at most four rows plus other places), the facts (including the fleet question), the trips by origin and destination with the docks they use, the usual round, other drives; the routes on the plan (width, colour, dashes, queue rings, variants of at least 10 %);
*Since start* and *Last 30 min*; compact, open and closed states; the phone sheet; the `vehicle` selection kind. Click any other item (station, flow, fleet, road cell, several): the dock shows its **six numbers** from the report (the tile strip, no blocks yet), so that "any of the items" shows numbers from the first release.
The Simulate tab gets the switch "Collect statistics for clicked items" and the select "Statistics on click". **Not in S1:** the blocks of the other kinds (S2), the plant overview, the sweep button, follow, profile ring, copy as table (S3).

**Builders and file ownership**

| Role | Owns (creates or edits) | Must not touch |
|---|---|---|
| **SIM** | `js/sim/detail.js` (new, from the reference collector), `js/sim/engine.js` (seam), `js/sim/traffic.js` (`waitNodeOf`), `js/sim/insights.js` (two exports), `tests/sim.detail.*.test.js` (new), the golden tests `tests/sim.golden.*` (neutrality extension), `tests/sim.seams.test.js` (the ledger), `tests/helpers/fake-sim.js` (scriptable vehicles, dock book stub, fake collector), `scripts/test-tiers.mjs` entries for its tests, `docs/ARCHITECTURE.md` 3.1 and 5 | any `js/ui/**` file, `kpis()` code |
| **SHELL** | `js/ui/panels/stats-dock.js`, `css/stats.css`, `css/layout.css` (dock rules), `index.html`, `js/ui/app.js`, `js/store/store.js`, `js/ui/editor/select.js`, `js/ui/panels/inspector.js` (one case), `fleet.js`, `simulate.js`, `fleet-status.js` (a tooltip), `js/ui/runner.js` (two lines + `detail()`), `tests/ui.stats-dock.test.js`, the store / select / inspector test updates, `docs/ARCHITECTURE.md` 6 | `stats-model.js`, `stats-view.js`, `render/**` |
| **MODEL** | `js/ui/panels/stats-model.js`, `js/ui/panels/stats-view.js`, `tests/ui.stats-model.test.js`, `tests/helpers/stats-fixtures.js` and the fixtures `tests/fixtures/stats/*.json`, the Help page `js/ui/panels/stats-help.js` registered in `dialogs.js` (one import and one entry: a named hand-over from SHELL) | `stats-dock.js`, `app.js` |
| **OVERLAY** | `js/ui/render/routes.js`, `js/ui/renderer.js` (one call and the vehicle ring), `tests/ui.routes-render.test.js`, the `tests/ui.renderer.test.js` updates | everything else |
| **VERIFY** | `tests/e2e/entity-stats.mjs` (and its line in `tests/e2e/run.mjs`), screenshots, README, the e2e `exclusive` frame-time probe | production code |

**Order** (`->` = must finish before; the rest runs in parallel)
* **S1.0 Contract freeze (SIM lead, 0.5 day):** section 6.4 is the API; SIM commits the reference collector's query outputs as fixtures (`tests/fixtures/stats/two-lines-agv1.json`, `warehouse-goods-in.json`, produced by a throw-away script from the reference, not a runtime file) so MODEL and OVERLAY can work against data before `detail.js` exists.
* **SIM:** `detail.js` + seams + `fake-sim` extension -> unit tests -> cross-checks, golden extension, determinism, fuzz, perf tests -> docs.
* **MODEL** (parallel with SIM, against the fixtures): `stats-model.js` for the vehicle and the tile strips of the other kinds -> `stats-view.js` -> unit tests -> definitions text.
* **SHELL** (parallel): store kind and prefs -> select tool and hover -> dock shell (overlay, states, open rule, window switch) -> camera `coveredAtBottom` / `revealMinimal` -> phone sheet -> runner hook (needs SIM's `enableDetail`) -> Simulate switches -> Fleet tab list.
* **OVERLAY** (after MODEL's route shapes are in the fixtures): `routes.js` -> renderer hook (after SHELL's `routes` flag) -> hover dim and pin (needs MODEL's row events).
* **Integration (SHELL lead):** dock + model + view + overlay on a real runner. **VERIFY:** e2e, screenshots, perf probe, docs. **Merge order into the tree:** SIM first (small, mergeable now), then MODEL, SHELL, OVERLAY after the in-flight UI workflows land.

**Acceptance criteria** (each is checkable by a verifier; "heavy" = the heavy test tier)

| # | Criterion | How it is checked |
|---|---|---|
| S1.1 | **Golden neutrality.** The 43 recorded golden runs repeated with `sim.enableDetail()` equal their fixtures byte for byte; a plain `new Simulation(layout).detail === null`; kpis with the collector toggled on, off and on mid-run equal; the ledger test lists every reader of `.detail` | extended `tests/sim.golden.*` (heavy); `tests/sim.seams.test.js`; full-state fingerprint test on 80 hostile plants (heavy) |
| S1.2 | **Containment.** `removeVehicle` mid-run with the collector on does not throw, leaves it attached with a notice, kpis equal the run without; a throwing listener and a throwing `afterTick` leave the run complete, `sim.detail === null`, `sim.detailError` set, kpis equal | hostile plants with a removal action (94 of 94 in the spike), plus the two forced failures (heavy) |
| S1.3 | **Exact against the report.** On the five examples and the five frozen dock plants: time split = fleet shares to 1e-9 vehicles; seconds per vehicle = the window to one tick; waiting seconds equal; the top 3 hot spots equal (`hot` + `hotStray`); dock-queue seconds within 3 % of the dock book; the three driving sub-slots sum to driving; lowest battery equals an independent per-tick observer (both windows); `Last 30 min` equals a direct reading to 1e-5; deliveries balance (never fewer loaded legs than deliveries, surplus at most 1 + cancelled orders) on 220 hostile truck plants, 40 hostile plants, the dock plants and the examples; relocated loaded legs keep their origin | `tests/sim.detail.exact.test.js` (heavy), the spike scripts `verify2.mjs` and `verify2b.mjs` as the starting point |
| S1.4 | **Determinism.** The collector digest is equal for a straight run, a repeat, 7.3 s slices, a run cut in two and a warm-restart pre-roll (seeds 1 to 3); calling every query every 7 s does not change the digest | `tests/sim.detail.determinism.test.js` |
| S1.5 | **Performance.** Collector on: at least 500x real time on the five examples (measured 16,500 to 63,500x), at most +25 % CPU of off on Two lines (best of 9; measured +11 %); on the 320 x 320 / 225 / 100 plant at least 500x (measured 518x to 620x; if the verifier measures below 500x the sampling lever of section 8 is built before release); collector off within noise of the untouched tree (`scripts/perf-baseline.mjs --root`); typed columns at most 3.5 MB on the big plant after 1 h | heavy tier with loose bounds; the perf-baseline gate by hand; `big-final.mjs` as the starting point |
| S1.6 | **Selection.** A click on a vehicle selects `{ kind: 'vehicle', ids: ['v2#1'] }`; Shift toggles; a marquee still selects what it selected; the selection survives a warm restart and falls back to the fleet with a toast when the vehicle no longer exists; Delete and Duplicate do nothing for it; the hover text says "Click for statistics"; Properties shows the fleet summary titled with the vehicle; the Fleet tab lists the vehicles as buttons and Enter selects one | store and select unit tests; e2e |
| S1.7 | **The gesture rule.** (a) Press and drag an unselected station by 5 cells with the dock enabled: the station moves exactly 5 cells, `canvas.getBoundingClientRect()` and the camera (x, y, zoom) are identical before and after, the dock did not open. (b) A click on a vehicle opens the dock after `pointerup`; the canvas size is unchanged and the camera zoom is identical (a pan is allowed). (c) Clicking empty ground to deselect does not move the plan | e2e with real pointer events; the Node check `critic/t7-camera.mjs` shows what the old design did (9.38 m) |
| S1.8 | **Dock states.** First open is compact; expand and minimise work; X closes until the next click-select; the remembered state and height work with `localStorage` unavailable (try/catch); the grip resizes up to 44 vh; the floating controls move above the dock; `I` toggles; Esc clears the selection; a walls or label selection closes it; phone: three snap points, the plan stays tappable | unit with a fake DOM; e2e 1440 and 390 px |
| S1.9 | **The numbers.** Every vehicle tile equals the collector's query for the shown window; trips per hour and held up equal the Results fleet table for the same window (rounding); the rows of *where it is held up* plus *other places* equal the tile (3 %); no printed share above 100 % in either window on the examples and hostile plants (property test); no NaN or "Infinity" for an empty window, a plant without vehicles, a vehicle that never moved; the placeholder before the first measured second | `stats-model` unit tests on the fixtures (no sim); e2e on Congestion lab at 600x to 30 min |
| S1.10 | **Windows.** *Last 30 min* shows no cell rows and says why; a tile without a 30-minute version keeps its since-start value and says "since start"; the window text counts from the collector's start ("counting since 0:50" when enabled late); "indicative" below 20 minutes; a runtime setting change shows the note | unit + e2e |
| S1.11 | **Routes.** Variants with at least 10 % of a pair are drawn, each with its own width; "usual" is claimed only at 50 % and 5 complete legs, else "N ways"; the ramp is scaled (red end = the 90th percentile of the shown shares, 8 to 30 %); queue rings are drawn at the dock cell; hover or focus on a trip row dims the others to 28 %, Enter pins, Esc unpins; flows recede to 35 %; a canvas pixel probe finds the route colour on the cells of the usual path and the plan colour next to them; frame time at 600x on the 100-vehicle plant is at most +0.5 ms over the same view without routes (60 fps) | `ui.routes-render.test.js` with a fake canvas context (no per-frame allocation after the first frame); e2e pixel probe and the exclusive frame-time probe |
| S1.12 | **Facts and the fleet question.** Each fact appears at its threshold and not just below, and goes below 0.85 x threshold; the fleet question reproduces the table of 3.9 (verdict, forecast within 1 point, "no count" when cut off, withheld while congested) from fixtures; `congested()` agrees with the `fleet-saturated` insight's suggestion text; the arrow rule at its boundaries (3 points, 2 sigma, 20 events) | `ui.stats-model.test.js` |
| S1.13 | **Tile strips of the other kinds.** Station, flow, fleet, road cell and several selected each show six tiles whose report numbers equal the Results tab; they work with `ui.detail` off (no collector) and show "Press play to see statistics" before the first measured second | e2e: one click per kind, no console error |
| S1.14 | **Accessibility.** Region labelled; no `aria-live` in the dock subtree (a unit test greps the DOM); the stacked bar and sparkline have `role="img"` with a sentence; route rows are buttons with the whole sentence as label; the keyboard-only journey Fleet tab -> Enter -> Tab through trip rows -> focus highlights the path -> Esc works; reduced motion disables the ring pulse; touch targets 40 px on coarse pointers | unit + e2e; an automated accessibility pass if one is available in CI (none was run in this design) |
| S1.15 | **Repository hygiene.** `npm run check` (import layering: `js/sim` imports nothing from `js/ui`), new tests registered in `scripts/test-tiers.mjs` (fast or heavy shard) so `tests/test-tiers.test.js` passes, `ARCHITECTURE.md` 3.1 (a second, separate seam beside `stats.ext`), 5.4 and a new 6.12, README, the Help page | CI |
| S1.16 | **Screenshots** reviewed by a human: vehicle compact, open and *Last 30 min*, one strip of another kind, in light and dark at 1440 x 900 and 390 x 844 | `e2e-output/*.png` |

**Test plan of S1** (details in section 10): unit with the fake sim and the fixtures (model, view, dock, overlay with a fake canvas context, store, select), the golden extension, the exactness, determinism and fuzz tests on the real engine (heavy), the perf gate, one e2e journey script, screenshots.

**Risks of S1.** The layout row is gone (overlay), but the dock covers the lower part of the plan: the camera reveal must not fight a planner who is panning (`pointerdown` already stops a glide). `vehicle` selection touches editing, undo (selection is pruned on commit) and warm restart. Path-pool overflow on very long congestion-routing runs (counted, not drawn, said in the window text).
Clutter of routes + heat + flow arrows (flows recede, heat gets a halo). The phone sheet's snap points and swipe are new interaction code. Merge conflicts in `app.js` and `select.js` with the in-flight workflows: SHELL rebases on the merged tree and keeps its edits to named insertion points.

### 9.2 S2 Every other item

**Ships.** The full pages of section 3.2 to 3.10: workstation (with the missing input and the supplier table), Goods in with or without trucks (yard, release to pickup, waiting now, trucks at the doors, docks "Dock 1 to 4"), storage (stays, trend), Goods out (lead time and its chain), depot (chargers busy, charge stops), flow (usual route, waiting now, carried by), road cell and dock cell (who passes here, `cellStats`), fleet (table of vehicles, the fleet question), several selected (comparison tables), *Last 30 min* for stations and flows, the overlay for those kinds, the fleet strip tooltip sentence.

**Builders.** SIM (2 to 3 days): in `detail.js` the per-flow delivered ring, `depotUse`, `starvedBy` accessor, the sampled stock series, `pickWait`/`yardWait`/`sinkLead` accessors for the UI, `Stats.cellStats` (19 lines in `stats.js`), tests (yard wait against an independent tally, 30-minute windows against an event log, `cellStats` against `heat()` on every cell).
MODEL (7 to 9 days): per kind a view-model, definitions, facts, tables; the lead-time chain; the several-selected tables; tests with fixtures per kind. SHELL (1 to 2): the table interactions, sort, "worst", the sweep placeholder, narrowing a stretch. OVERLAY (1): corridors per kind, the cell and fleet unions. VERIFY (2 to 3): one e2e click per kind, screenshots.

**Ownership** as in S1: SIM owns `js/sim/detail.js`, `js/sim/stats.js` (`cellStats`) and `tests/sim.detail.*`; MODEL owns `stats-model.js`, `stats-view.js`, `tests/ui.stats-model.test.js` and the per-kind fixtures; SHELL owns `stats-dock.js` (table interaction hooks only); OVERLAY owns `routes.js`; VERIFY owns `tests/e2e/entity-stats.mjs`. The S1 test layers (section 10) apply to each kind.

**Order.** SIM first (accessors), MODEL per kind in this order of value: Goods in, workstation, Goods out, storage, flow, depot, cell, fleet, several; each kind merges on its own behind the existing strip.

**Acceptance criteria**

| # | Criterion |
|---|---|
| S2.1 | Every kind has its tile list, blocks and definitions of section 3; each fact appears at its threshold and not just below; each kind has an e2e click with no console error, in light and dark. |
| S2.2 | **Goods in yard.** The yard wait per pallet equals an independent tally that reads `truck.releaseAt` (exact); *Last 30 min* equals an event log to 0.01 s; "waiting now" equals the count of ready, unclaimed loads; the headline equals yard + buffer; a plain source (no trucks) works. Reference (run): Warehouse first day 3 h, yard 15.3 min, buffer 8.6, release to pickup 23.9. |
| S2.3 | **Lead-time chain.** Reproduces 66.8 = 20.3 + 39.0 + 1.7 + 1.2 + 4.5 min on Warehouse first day (0.1 min), 84.0 on Dock lab, 13.8 on Two lines; the sentence names waiting for a vehicle at 30 % and transport only at 50 % (boundary tests); never "transport is not the cause" while waiting is 30 % or more. |
| S2.4 | **Sampled station figures.** *Last 30 min* busy / starved / blocked equals a direct reading to 1e-5; the missing-input share equals a brute-force recomputation; the trend sentence appears only for 2 loads per hour or more. |
| S2.5 | **Cells.** `cellStats` equals `heat()` on every road cell of Congestion lab; the dock cell page equals the Results hot-spot table and the `docks[]` row for the same cell. |
| S2.6 | **Fleet.** The table rows select vehicles; the fleet question equals the table of 3.9; the fleet strip tooltip says how its "working" differs. |
| S2.7 | **Several selected.** Comparison tables per kind, "worst" marks, sort by heading, the narrowing button for a stretch; sums only where a sum means something. |
| S2.8 | **Words.** "Dock 1 to 4" and "Door 1 to 3" everywhere, the cell as a tooltip; "No job"; "Held up". A grep test lists the retired words ("Working" as a tile label, "Waiting for a job"). |
| S2.9 | **Equality with Results.** Every number tagged R equals the Results tab (a test per kind compares the dock model with `sim.kpis()`); the plant overview is S3. |
| S2.10 | Overlay for station, flow, cell and fleet kinds draws with the same layer; frame time with three overlays within the S1 budget. |

**Risks.** Many views, so many small definitions: the (i) texts are the review surface. The Goods in release stamp depends on the truck events (`truckReady`, `truckDeparted`): they are in the ledger test of internals.

### 9.3 S3 Overview and polish

**Ships.** The plant overview when nothing is selected (loads shipped, lead time, vehicles busy and held up, the busiest workstation, the busiest routes, the three worst insights; every shared number equals Results); **peaks** from the profile ring (6.9: "peak 15 minutes", "longest wait") on the key tiles of stations and fleets; the **measured what-if** ("Test it": opens the Experiments dialog with `fleet.<id>.count` and the values n - 1, n, n + 1, 3 replications);
baseline chips ("was 74 %", the noise bands of `impact.js`, report-derived numbers only); the hover line in the status bar ("Packing - busy 82 %"); **copy as table** (the visible tiles and tables as tab-separated text to the clipboard, and a download of the same as CSV); **follow** a selected vehicle (the camera keeps it in the free area at 5 Hz or less); facts "idle on dock", "empty drives start at a depot", detour factor, share of the fleet's trips; p90 wait per Goods in and flow; the Help page; an accessibility pass.

**Builders.** SIM 2-3 (profile ring and its spike, a sampling lever if S1.5 was close), MODEL 3-4, SHELL 2 (follow, copy, status line, the experiments hand-over), OVERLAY 0.5-1, VERIFY 1.5-2.

**Ownership** as in S1; new for S3: SIM owns the profile ring in `detail.js`; SHELL owns the follow toggle, copy as table and the status-line hover in `app.js` / `stats-dock.js`; MODEL owns the plant card, baseline chips and the help text generation; the Experiments hand-over is a named edit of `js/ui/dialogs.js` by SHELL. **Order:** the profile-ring spike first (memory, bucket cost), then SIM, MODEL, SHELL in parallel, VERIFY last.

**Acceptance criteria**

| # | Criterion |
|---|---|
| S3.1 | The profile ring's memory on the big plant is at most 1 MB more than S1 (spike first: measure and report; the arithmetic says 0.8 MB); a day plant's 24 h fit; the peak of 15 minutes equals a direct recomputation from a per-tick tally. |
| S3.2 | The plant card equals Results for every shared number; the three worst insights open the item; the busiest routes equal `busiestRoutes()`. |
| S3.3 | "Test it" opens the Experiments dialog with the right parameter and values; the same sweep is reproducible by `sweep()` in Node (a test). |
| S3.4 | Baseline chips appear only for report-derived numbers, only with a baseline, and inside the noise band show "no change". |
| S3.5 | Copy as table: the text equals the visible numbers (a test parses it); CSV download has the same cells. |
| S3.6 | Follow keeps the vehicle inside the free area at 600x and stops when the planner pans; a vehicle that finished (parked) stays centred. |
| S3.7 | Help page describes every statistic's counting rule (generated from the same definitions as the (i) texts, so they cannot drift: a test compares them). |
| S3.8 | Accessibility: a screen reader pass of the vehicle and Goods in pages is done and written down; if the automated pass was unavailable before it is run now. |

### 9.4 The cheaper cut line (if the budget is short)

"S1-lite" (about 19 to 23 days: SIM 5-6, SHELL 5-6, MODEL 4-5, OVERLAY 3, VERIFY 2-3): the collector and its tests, the vehicle view on desktop (compact and open), the trips list with the dock grouping, the overlay with the usual routes and queue rings, *Since start* only, the tile strips of the other kinds. Left out: the phone sheet (the dock then opens as a fixed half sheet), *Last 30 min*, the usual round, the other drives, the fleet question, the Simulate preference (fixed to "when the simulation has data").
Every one of these is added later without a rework (the window switch and the sheet are already in the structure of the shell). The review findings that are not cut (containment, the overlay dock and gesture rule, the honest windows, the sentences) stay.

---

## 10. Test plan

Fixtures and helpers: `tests/helpers/fake-sim.js` gets a scriptable `VehicleRT` (state, stateSince, order, targetId, route, `tv` fields), a `DockBook` stub and a fake collector that returns the fixtures; `tests/fixtures/stats/*.json` hold query outputs of the reference collector for fixed plants and seeds.

1. **Collector with a fake sim (fast):** one leg row per drive with kind, from, to, flow, duration, held-up and dock-queue seconds and loads; a breakdown pauses and resumes a leg (duration excludes the repair); a dead battery drops it; a state left and re-entered in one tick still gives two legs; route object reuse gives one path id, equal cells in another object intern to the same id; pool overflow keeps counting; packed paths decode to their routes;
   the cell table folds into `other` at 25 cells; `hotQ` is a part of `hot`; waiting in a non-driving state goes to `hotStray` only; the per-vehicle split sums to the elapsed time every tick; `reset` clears the window and marks drives in progress partial; the ring wraps after 60 buckets; the leg ring wraps and reports the moved window start; charge sessions; the origin of a loaded leg survives a replan.
2. **Regression tests named after what the spikes found** (all four are in the build): `STAT-T0` (warm-up 0: a state change in the very first tick is seen), `STAT-STRAY` (a held-up vehicle that is not in a driving state is not "waiting"), `STAT-ZERO` (frozen dock plant 44: loaded legs balance against deliveries; zero-length legs present),
   `STAT-BALANCE` (a whole job inside one tick with unloadTime 0: filed from the `orderDelivered` order), `STAT-ORIGIN` (a relocated loaded leg keeps its origin), `STAT-REMOVE` (a vehicle removed under a running collector), `STAT-THROW` (a throwing listener and `afterTick`).
3. **Cross-check against the report** on the three legacy examples, Dock lab, Warehouse first day and the five frozen dock plants, with and without warm-up, with breakdowns and batteries (S1.3). Starting point: `spike/final2/verify2.mjs`, `verify2b.mjs`, `stress-final.mjs` (180 audits).
4. **Golden neutrality** (S1.1) and the **fingerprint** test (80 hostile plants, collector on/off/on mid-run).
5. **Determinism / warm restart** (S1.4), seeds 1 to 3, plus "queries do not change the digest".
6. **Fuzz (heavy)** with the generators `tests/helpers/*-gen.js` and the collector on, including removal actions: every 120 s the per-vehicle split sums to the window; every logged path is a chain of linked cells; leg start times are non-decreasing per vehicle; ring counts consistent; plants with trucks, depots with batteries, deadlocks.
7. **Properties (fast, on fixtures and heavy on real runs):** every printed share is at most 100 % in both windows; the rows of *where it is held up* plus *other places* equal the tile; the three driving sub-slots sum to driving; a number with no 30-minute version carries the "since start" label; no NaN or Infinity anywhere in any view-model for an empty window, an empty plant, a plant without vehicles, a vehicle that never moved, a dead vehicle.
8. **Perf (heavy, loose bounds):** collector on at least 500x on the five examples; CPU on at most +25 % of off on Two lines (best of 9); query times on a full log (`routesOf` below 2 ms); the off-path gate by hand with `scripts/perf-baseline.mjs --root`; the big-plant measurement by hand with `big-final.mjs`.
9. **UI unit** (harness `ctx` like `ui.panels*.test.js`): the dock for each kind builds from a real runner on the real engine and updates in place without replacing nodes; the placeholder before data; the open rule (pointerup, not busy, preference); multi-select tables and "worst" marks; store: `vehicle` selection cleaned against fleet counts; the select tool selects the vehicle and Shift toggles;
   renderer: the routes layer with a fake canvas context allocates nothing per frame after the first (like `ui.ops-render.test.js`); hit-test priority unchanged; no `aria-live` in the dock.
10. **E2E** (`tests/e2e/entity-stats.mjs`, real Chromium, light and dark, 1440 and 390 px): Congestion lab at 600x to 30 min; click an AGV: dock with the numbers and trips, route pixels on the path cells (pixel probe), hover a row dims the others, Esc closes; the gesture rule (S1.7); one click each on Goods in, workstation, storage, Goods out, depot, flow arrow, road cell, dock cell (numbers and (i), no console error);
    a marquee of 3 workstations gives a table; edit the plant while a vehicle is selected: warm restart keeps the selection and the numbers continue; keyboard only: Fleet tab vehicle list, Enter, Tab through trip rows, focus highlights the path, Esc; phone: tap a vehicle, peek, half; frame-time probe at 600x with the overlay on a 100-vehicle plant (exclusive).
11. **Docs and CI:** new files in the tiers lists (`scripts/test-tiers.mjs`: heavy tests in `HEAVY_SHARDS`), the ledger tests, `ARCHITECTURE.md` sections, `npm run check`.
12. **Screenshots light and dark, desktop and narrow,** reviewed by a person (S1.16), regenerated per step.

---

## 11. What is deliberately not built

* Nothing in `kpis()` / `report()` changes; no new key in the report; no change of simulation behaviour, random streams or tick order.
* No statistics for walls and labels; no editing from the dock (it has no inputs but the window, the overlay and the details toggle); no drag of items from the dock.
* No per-vehicle trajectory replay, Gantt chart, scrubber or per-load tracing; no cost model, no forecast beyond the labelled arithmetic; no statistics across runs except the existing impact card.
* No export other than copy as table (S3) and the existing report; no PDF.
* No automatic "fix it" actions beyond the existing insight actions; the sweep button only opens the Experiments dialog.
* The sample-and-hold poll for plants of 1,000 vehicles (`MAX_FLEET`) is not built until S1.5 or a user needs it.
* No per-cell attribution under *Last 30 min* (a ring of cell tables would cost about 1.2 MB for little value): the cell rows say "since start only".
* No collector for plants that do not turn it on, and no way to read the past before it was enabled.
* Shifts, racks, load types (warehouse milestones M2 to M5) get no statistics here; the structure (kinds, tiles, windows) takes them later.

---

## 12. Risks, known defects of the mock-ups, what was not run, open questions

**Risks.** Parallel edits of `js/ui/**` and `js/sim/**` (touch points in section 7; everything else is new files). The collector reads about 25 simulation internals; the ledger test names them so that a change fails a test. The collector cannot be enabled late without losing the past (said on screen).
Few trips mislead (5 to 17 per vehicle in the first hour): thresholds, the corridor, "indicative". The fleet question and the lead-time chain are arithmetic: never red, labelled, linked to the sweep. A `vehicle` selection kind touches editing, undo and warm restart. The phone sheet is new interaction code.

**Known defects of the mock-ups** (static pictures of a prototype running in the real app; the numbers are real, the layer is not): the route overlay is an SVG that stands in for the canvas layer (widths, halo and chevrons will differ at 1x and 2x); the hover, focus and pin states are not drawn; at 44 vh the open dock needs scrolling to show all three blocks (the "scrolled" pictures show the lower half);
row labels in *where it is held up* truncate at 150 px ("Queue for Press line's d..."); the Goods in mock still shows the live line (truncated, "2 of 3 doors ...") and a docks table whose last column is cut off at the right edge (design: the live line is dropped for stations while Properties is visible; the table needs a narrower first column); on the phone the mock's camera fit leaves free space above the plan (the real `fit()` fits into the free part);
the Goods in mock has no *Last 30 min* picture. All mock-ups were read.

**Not run.** The live app with a real dock and the real renderer layer; keyboard and screen-reader behaviour; touch; the frame time of the overlay; an automated accessibility pass; the open-rule gesture (derived from the code of `select.js` and `app.js` and from a Node computation with the real `Camera` class, which shows the 9.38 m jump of the old design; the new design has no resize to measure);
the profile ring (arithmetic only); the sweep button; plants of 1,000 vehicles; runs longer than 8 simulated hours except the ring-wrap check (8 h: 28 wraps, worst difference to an independent run 3.9e-4 s); the planner critic's measurements that are quoted and marked (the excess-of-a-trip check); `scripts/perf-baseline.mjs` for the revision (the off path is unchanged from the run first reference).
The engine critic's findings 3 to 10 were cut off in the input of the finalizer (section 13); they were reconstructed from its scripts and re-run.

**Open questions for the product owner** (each with the default taken here): (1) A click on a vehicle selects the vehicle, with the fleet one click away in the dock header: acceptable? (default: yes). (2) The dock sits over the bottom of the plan, compact at first; or a panel on the right? (default: dock). (3) "Statistics on click" default *when the simulation has data*, routes switch on, collection on (costs 8 to 18 % CPU the planner cannot notice at 1200x or less on the examples)? (default: yes).
(4) Show the fleet question at all, given that it is arithmetic? (default: yes, labelled, with the sweep button in S3). (5) Wording: "Since start" or "Whole run"; "Held up" or "Waiting in traffic"? (default: Since start, Held up).

---

## 13. How the review findings were handled

Two critics reviewed the first concept. **The planner critic** (statistics and sentences; scripts `critic-planner/a1` to `a12`) raised 6 high, 12 medium and 4 low findings; **the engine critic** (collector and UI integration; scripts `spike/critic/t1` to `t8`) raised 2 high findings that reached the finalizer in full, and a summary
("golden neutrality, determinism, overhead and memory hold; vehicle removal and the dock layout break"; "the spec's 29 to 38 engineer-days looks about 1.5x short; see finding 10"). **The text of the engine critic's findings 3 to 10 was cut off in the input of the finalizer.** They were reconstructed from the critic's scripts (what each one probes) and **all of them were re-run on the revised collector**;
anything those scripts show is listed in 13.3. If the full list contains a finding that is not covered there, it is open.

### 13.1 Planner critic

| # | Sev | Finding | Disposition |
|---|---|---|---|
| P1 | high | "Without it the other 6 would work 72 %" is not a forecast (it is the mean current share; the right arithmetic is W/(n-1)) | **Applied** (3.9): a fleet statement `F = Wp/(n-1)`, thresholds 90 % / 75 %, verdict words not colours, since start only, labelled workload arithmetic, validated against a real n - 1 simulation on 6 fleets (within 6 points on the three that are neither withheld nor above 100 %; run). The measured what-if is the sweep button (S3): reusing the Experiments `sweep()` instead of a second control-run path in the runner |
| P2 | high | "The fleet needs about 6.8 at 75 %" is circular in dock- and queue-bound plants | **Applied** (3.9): withheld while `congested()`, no count for a fleet at 95 % or more (cut off), integers only, the sweep link. Run: Warehouse n = 3 to 8 now gives no count, no count, "~6", "~7", withheld |
| P3 | high | Last 30 min mixes a since-start numerator with a 30-minute denominator (174 %, 74 %) | **Applied** (3.0 rules B and C, 3.1): cell tables are since start only and hidden under Last 30 min with a note; shares have numerator and denominator from one window; property test. A per-bucket ring of cell tables was **refused**: about 1.2 MB for little value |
| P4 | high | The Goods in "vehicle wait" leaves out the yard | **Applied** (3.3): yard wait per pallet from the release stamp (`truckReady`), headline "release to pickup", block "Output buffer and yard", "waiting now". Run: 15.3 min in the yard (the critic's check-in of 10 min was an assumption: measured 5.0 min, so 20.3 min creation to ready = 5.0 + 15.3), 8.6 in the buffer, 23.9 in all |
| P5 | high | The Goods out lead-time sentence blames the wrong thing | **Applied** (3.5): the lead-time chain with its sentence rules; run: 66.8 = 20.3 + 39.0 + 1.7 + 1.2 + 4.5 min on Warehouse first day |
| P6 | high | The dock opens on pointer-down, resizes the stage, the camera re-fits, the first drag jumps | **Applied** (2.1, S1.7): an overlay (no resize), `coveredAtBottom`, open at pointerup and only when the tool is not busy, the preference, no camera zoom, no nudge while busy. Not run live in a browser (12) |
| P7 | med | With several docks the usual route is 29 to 61 % and hides the dock choice | **Applied** (4.1, 4.2): grouped by dock pair, every variant of 10 % or more drawn with its own width, "usual" only at 50 %, else "N ways" |
| P8 | med | Drives to park and charge (15 % of the time, 26 % of the metres) are missing | **Applied** (3.1): three parts of driving, "to depot" in the Driven tile, the other-drives disclosure, the fact; run: 15 % and 26 % on Two lines AGVs 1 |
| P9 | med | The list is pairs, not a loop | **Applied** (4.1): the usual round (2 jobs), "Show on plan"; run on Two lines and Warehouse |
| P10 | med | Capacity above one: loads per hour and the load factor | **Applied** (3.1 tile 1) |
| P11 | med | The arrow rule flags noise | **Applied** (3.0 rule A); run: 4 of 56 against 25 of 56 |
| P12 | med | Three meanings of "working" | **Applied** (2.6, 3.1): "Busy, incl. waiting", "Held up", the (i) names drives to park and charge, the fleet strip tooltip gets a sentence |
| P13 | med | The battery tile uses another window | **Applied** (3.1 tile 6, 6.2): the minimum since the window began and per bucket; run against an independent observer (6.5e-9) |
| P14 | med | The listed waiting places do not add to the tile | **Applied** (3.1): at most four rows plus other places, named by what they are, disjoint accounting (`hotQ`, `hotStray`); run: rows / tile at most 1.000 |
| P15 | med | Only means and a 30-minute sparkline: no peaks | **Deferred to S3** (6.9, 3.11): a coarse 24 h ring of 5-minute buckets, 0.8 MB, not run |
| P16 | med | Obstacles, labels and trucks have no defined behaviour | **Applied** (2.1, 3.12) |
| P17 | med | A 44 vh dock leaves 430 px of plan; duplication with the Properties status card | **Applied** (2.1, 2.3): the compact default (about 150 px) with the blocks on demand; the live line only for vehicles; the overlay does not take plan area |
| P18 | med | A collector exception would stop the run | **Applied** (6.6): containment, tests |
| P19 | low | Zero-length and overflow paths count as variants | **Applied** (4.1, 6.4): drawable variants only; run |
| P20 | low | Dock, door, cell wording; "waiting" has three meanings | **Applied** (2.6) |
| P21 | low | `aria-live` on a 10 Hz text; the legend ramp differs from the spec | **Applied** (2.4, 4.2): no `aria-live`, one definition of the ramp, scaled to the routes shown |
| P22 | low | Clicking a vehicle at 600x is unreliable; unplaced vehicles | **Partly**: the Fleet tab list and `[`/`]` in S1, "did not fit on the road" in S1, follow in S3 (2.4) |
| P23 | low | Phasing: the owner's wow arrives only in the second step; effort optimistic; no export | **Applied** (9): vehicle first, copy as table in S3, estimates redone |
| (verdict) | | "Fix the high items and the vehicle route view becomes the strongest part; build the collector and the vehicle view first" | **Applied**: S1 is the vehicle |

### 13.2 Engine critic (the two findings that arrived in full, and the summary)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| E1 | high | `removeVehicle` makes the collector throw out of `Simulation.step()` on every later tick; no containment | **Applied** (6.6, S1.2). Run: 94 hostile plants with a removal keep running (the first reference threw in 70 of them); two forced failures contained |
| E2 | high | A dock that resizes the stage re-zooms the plan and breaks select-then-drag (the world point under a held pointer jumps 9.38 m = 4.7 cells) | **Applied** (2.1): the same fix as P6; the number was re-run with the real `Camera` class |
| (E3-E10) | | Not visible. Probed by `t2` to `t8` and the plan-cost remark (10) | See 13.3 |

### 13.3 What the engine critic's scripts probe, re-run on the revised collector

| Script | Probes | Result now (run) |
|---|---|---|
| `t2-edge` | no vehicles, no stations, dt 1 / 0.5 / 0.05, late enable and toggling, runtime changes, every example for an hour | all pass; working share equals the report to 1e-16 to 3e-13 at every dt; split sums to the window to 2.5e-9 s |
| `t3-fuzz` (+ `t3b`, `t3c`) | hostile truck plants with and without removals | removal fixed (E1). **Loaded legs fewer than deliveries** (seeds 127 and 183: 2 per vehicle, the first reference could not see a whole job inside one tick with unloadTime 0): fixed by the balance against `vr.trips` with the order of `orderDelivered`; run: 0 unbalanced in 270 plants, 1,358 vehicles, 5,385 deliveries |
| `t4-reloc` | which pair a deadlock-relocated loaded leg is filed under | **26 of 34 had lost their origin** (the replanned route starts on a road cell) and fell out of every pair table: fixed (the origin is the order's station); run: 0 of 34; relocated legs are trips, not variants |
| `t5-report` | the keys of the report | used for the tags of section 3 (no defect) |
| `t6-long` | 8 simulated hours, 28 ring wraps: Last 30 min against an independent run | worst difference 3.9e-4 s |
| `t7-camera` | the real `Camera` with a stage shrunk by the dock | 9.38 m jump: removed by the overlay |
| `t8-fingerprint` | positions, states, odometers and kpis with the collector on / off / on | 80 of 80 identical |
| (plan cost) | the first estimate | redone, section 9 |

### 13.4 Found by the finalizer while changing the spike

* Waiting seconds of a held-up vehicle that is not in a driving state (after a breakdown) are in `nodeWait` but not in the *Held up* tile: a cell list built from one table could add up to 1.82 times the tile. Now `hotStray` holds them and the cell rows follow the tile.
* The first `hotspots()` and `idleSpots()` flushed the running streak into the table, so a query changed what the collector would record next. Now read-only (run: digests equal with a query of everything every 7 s).
* The Little's-law storage stay includes the time loads wait there for a vehicle, which the chain counted twice (31.6 min "stay" on Warehouse first day, of which 30.5 min were the pickup wait). Now net.
* A mean over loads that were picked up cannot see a load that is still waiting (a fleet with too few vehicles shows a short wait): "waiting now" beside every wait for a vehicle (rule 9).
* The 12 % waiting gate does not catch a fleet that is limited by something other than vehicles (Warehouse n = 4 to 6: waiting 3 to 5 %, output flat from n = 4): no count for a fleet cut off at 95 %, and the sweep button.
* Loaded legs without a delivery exist (an order cancelled on the way, an unloading interrupted by a breakdown or a dead battery): the balance is "never fewer legs than deliveries", not equality (32 of 5,385).

---

## 14. Index of spikes and mock-ups (starting points; absolute paths; the repository was not edited)

Root: `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m3/` (below `M3/`). One node or browser process at a time; the machine has 4 cores.

**Revision 2 (this stage, `M3/spike/final2/`)**

| File | What it is |
|---|---|
| `tree/C/js/sim/detail.js` (871 lines), `engine.js`, `traffic.js`, `stats.js` | the revised reference collector and the seams, in a scratch copy of the repo's `js/`; `tree/A` is a link to the untouched copy (`M3/spike/final/tree/A`) |
| `verify2.mjs` (`verify2.out`) | exactness against the report, 43 golden runs, determinism, windows, `cellStats`: 68 checks, 0 failed (`node verify2.mjs [--skip-golden]`) |
| `verify2b.mjs` (`verify2b.out`) | containment, loaded-leg balance on 270 plants, driving sub-split, battery, where-held-up disjointness, Goods in yard, undrawn legs, usual round: 35 checks, 0 failed (`node verify2b.mjs 220`) |
| `stress-final.mjs` (`stress2.out`) | 180 audits on dock-dense plants, breakdowns, batteries, deadlocks: 0 failures |
| `t8-fingerprint2.mjs`, `t4-reloc-2.mjs`, `t6-long-2.mjs`, `t7-camera-2.mjs` (`t8.out`, `t4.out`) | the critic's scripts pointed at the revised tree |
| `queries-pure.mjs` (`queries-pure.out`), `query-cost2.mjs` (`query-cost2.out`) | queries do not change state; query cost on a full log |
| `overhead-final.mjs --rounds 12` (`overhead2.out`), `big-final.mjs` (`big2.out`, `big2b.out`; `node --expose-gc`) | CPU and memory |
| `rules.mjs` | the pure rules: `fleetQuestion`, `deltaMark`, `usualWording`, `drawnVariants`, `dockName`, `cellLabel`, `leadChain` (the seed of `stats-model.js`) |
| `needed2.mjs` (`needed2.out`), `lead2.mjs` (`lead2.out`), `arrows2.mjs` (`arrows2.out`) | the fleet question against a real n - 1 run; the lead-time chain; the arrow rule on real spreads |
| `fobs.js`, `final-scene.js`, `overlay.js`, `final.css`, `final-build.mjs`, `page-lib.mjs` | the page-side model, the dock and the overlay of the mock-ups; `node final-build.mjs <vehicle\|source> <light\|dark> [desktop\|phone] [peek\|half] [start\|last30] [open\|compact] [scroll px]` writes `M3/mock/final2-*.png` |

**Mock-ups of the definitive design (`M3/mock/`, all read):** `final2-vehicle-light.png`, `final2-vehicle-light-scrolled.png` (the lower half of the open dock), `final2-vehicle-light-compact.png` (what a first click shows), `final2-vehicle-light-last30-scrolled.png`, `final2-vehicle-dark.png`, `final2-vehicle-light-phone-peek.png`, `final2-vehicle-light-phone-half.png`,
`final2-source-light.png`, `final2-source-dark.png` (Goods in with three doors on Warehouse first day). Earlier concept mock-ups (`final-*.png`, `planner-*`, `engine-*`, `ux-*`) are superseded where they differ.

**Earlier stages (`M3/`):** `spec-v1.md` (the concept this document replaces), `spike/final/` (the first reference collector, `verify-final.mjs`, `overhead-final.mjs`, `big-final.mjs`, their `.out` files), `spike/planner`, `spike/engine`, `spike/ux` (the three designers' spikes, the UX prototype dock stylesheet `insight.css` that `final-build.mjs` serves), `critic-planner/` (`a1` to `a12`, `verify.out`), `spike/critic/` (`t1` to `t8`).
