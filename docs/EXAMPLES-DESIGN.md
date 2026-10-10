# LogiPlan examples: the ladder (definitive design)

Status: DESIGN, final. Written for the workflow that builds it. Nothing of the app was changed to produce this document: the six new examples exist as running prototypes (`/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship`) built through the real `js/model/layout.js` mutators, and every number below was measured on them. Measured on the working tree of 2026-10-10 (HEAD 73892e2 plus the uncommitted edits of the parallel statistics and overlay work; the second critic re-ran the first draft on this tree state and found its numbers digit for digit).

## 1. Purpose and the owner's request

The product owner asked for this: "expand the examples to include like six different examples from very simple to a super high complex setup with multiple ins and outs, and forklifts, and EV charging, and one plant and a second plant, and sharing goods between plants, all of that, so that we have cool examples."

The answer is a ladder of eleven gallery cards in five levels. Six are new and are ADDED after the five that exist; the five that exist (the three golden examples `starter`, `two-lines`, `congestion-lab` and the two M1 examples `dock-lab`, `warehouse-first-day`) keep their builders, ids, names, descriptions, tips and fixtures and only gain gallery metadata. The new six, simplest first: **hello-pallet** (one forklift, one road), **charging-corner** (six electric forklifts, two chargers), **yard-shuttle** (one truck, 280 metres), **morning-peak** (a cross-dock on a timetable, 2 goods in and 3 goods out), **components-plant** (a whole plant, three kinds of vehicle) and **twin-plants** (two plants on one baseplate, a shared warehouse, a shared charging hall and a shuttle fleet, goods in both directions).

How to read this document: section 2 is the overview, section 6 holds everything needed to rebuild one example (story, sketch, tables, notes, tips with their measured numbers, risks), sections 8 to 10 are the work orders for the next workflow (tests, build plan, acceptance criteria E1 to E40), section 11 lists what the owner still has to decide.

Owner decisions that hold for all of it (docs/WAREHOUSE-DESIGN.md section 12): the pallet is the load and the euro pallet the grain (every load is one pallet, trucks carry 3 to 24 of them), metric units, results in hours, minutes and counts (no money anywhere), dock doors are a count. The pallet warehouse is the first customer: four of the six new examples are warehouse flavoured (hello-pallet, charging-corner, yard-shuttle, morning-peak), two are plants (components-plant, twin-plants), and the finale contains both.

## 2. The ladder at a glance

| Rank | Level | Id | Name | | The one idea | Size (cells, m per cell) | Stations / vehicles / flows |
|---|---|---|---|---|---|---|---|
| 1 | 1 Start here | `hello-pallet` | Hello, pallet: one forklift, one road | **new** | a vehicle has a cycle time, so its capacity can be calculated | 36 x 14, 3 m | 3 / 1 / 1 |
| 2 | 1 Start here | `starter` | Starter: dock → assembly → shipping | existing | the smallest complete plant | 40 x 24, 2 m | 4 / 2 / 2 |
| 3 | 2 One idea at a time | `charging-corner` | Charging corner: six electric forklifts, two chargers | **new** | energy is a hidden capacity (batteries, chargers) | 56 x 30, 2 m | 4 / 6 / 2 |
| 4 | 2 One idea at a time | `yard-shuttle` | Yard shuttle: one truck, 280 metres | **new** | over a distance the batch decides (capacity, minimum batch, longest wait) | 60 x 44, 4 m | 5 / 1 / 2 |
| 5 | 2 One idea at a time | `dock-lab` | Dock lab: one street, three docks | existing | docks share the work only on their own side roads | 40 x 28, 2 m | 4 / 5 / 2 |
| 6 | 3 Several things at once | `two-lines` | Two production lines + warehouse | existing | forklifts and AGVs, a bill of materials, a bottleneck | 56 x 33, 2 m | 8 / 10 / 6 |
| 7 | 3 Several things at once | `congestion-lab` | Congestion lab | existing | traffic: a deliberately awkward plant | 48 x 28, 2 m | 5 / 9 / 3 |
| 8 | 3 Several things at once | `warehouse-first-day` | Warehouse: first day | existing | trucks, doors and forklifts: who limits the gate | 48 x 30, 2 m | 4 / 4 / 2 |
| 9 | 4 A whole plant | `morning-peak` | Morning peak: a cross-dock on appointments | **new** | the peak hour sizes doors and forklifts; a timetable is a lever | 60 x 44, 3 m | 7 / 8 / 5 |
| 10 | 4 A whole plant | `components-plant` | Components plant: one hall, three kinds of vehicle | **new** | find the bottleneck, then the roads that earn their keep | 79 x 42, 2 m | 16 / 22 / 13 |
| 11 | 5 Two plants, one campus | `twin-plants` | Two plants, one yard | **new** | a campus is one system: shared goods, a shuttle fleet, one charging hall | 170 x 52, 2 m | 33 / 30 / 32 |

**Recommended path:** hello-pallet, starter, then charging-corner, yard-shuttle and dock-lab in any order, then two-lines, congestion-lab, warehouse-first-day, then morning-peak and components-plant in any order, then twin-plants. Each new card reuses what the cards before it taught: the twin plants contain the yard trucks of the shuttle (batch and longest wait), the batteries and chargers of the corner (as one shared hall), the bill of materials and the fleets of the components plant, and the truck gates of the morning peak.

**Where the owner's words land:** very simple = hello-pallet; forklifts and EV charging = charging-corner; sharing goods over a distance = yard-shuttle; multiple ins and outs and the peak = morning-peak (2 in, 3 out) and twin-plants (3 in, 4 out); one plant = components-plant; a second plant and sharing goods between plants = twin-plants.

**Levels** (the gallery headings, section 7): 1 Start here, 2 One idea at a time, 3 Several things at once, 4 A whole plant, 5 Two plants, one campus.

## 3. Decisions, what the reviews found, what the plants teach

### 3.1 Decisions where the three designers disagreed

1. **Skeleton = the pedagogy ladder** (one idea per card, each reused by the next, gallery order = order of the ideas). The realism and capability ladders were sets of good plants without a path from card to card.
2. **Level 1 is `hello-pallet`, not realism's `first-forklift`**: the first forklift's battery lesson shows only after 4.5 simulated hours; hello-pallet's napkin lesson shows in the first minute and the battery lesson is level 2.
3. **EV charging = `charging-corner` (capability)**, not pedagogy's `charge-lab`, realism's `cold-store` or `first-forklift`: the owner said "forklifts and EV charging"; it has the cleanest levers on one store and 130 road cells.
4. **Batching over a distance = `yard-shuttle` (pedagogy)**, not realism's `tugger-shuttle`: one vehicle states the lesson in numbers (a second truck changes nothing; capacity 1 costs 71 %).
5. **Warehouse side of level 4 = `morning-peak` (realism's cross-dock, tightened)**, not pedagogy's `distribution-hub` (timetable-limited output) or capability's `morning-peak`/`four-gates`. The id is NOT `cross-dock`: docs/WAREHOUSE-DESIGN.md 8.1 reserves `cross-dock` and `dc-two-shifts` for M2.
6. **Production side of level 4 = `components-plant` (pedagogy)** with a two-way ring (the one-way ring costs the forklifts a fifth of their time and does not reduce waiting). `morning-peak` keeps its one-way ring because there it buys calm (waiting in traffic 6 % against 20 %) and the trade-off is a tip.
7. **Finale = pedagogy's `twin-plants`**, not realism's 808 m ribbon (a thin line in a thumbnail) or capability's two small bike plants (10 pallets/h, little to read): both directions of goods, the strongest measured levers.
8. **Cell sizes follow the vehicles**: 3 m for hello-pallet and morning-peak (a 2.6 m forklift fits a cell), 4 m for the yard shuttle (3.5 m truck), 2 m elsewhere with the "compact" forklift (length 2, capacity 2) of dock-lab and two-lines; every vehicle is at most one cell long, so no "vehicle longer than a cell" hint appears.
9. **The two big plants have a 2 hour warm-up** (`settings.warmup` 7200 s) because the model has no initial stock; their trucks come on a **fixed rhythm** (see 3.3).
10. **Door counts stay generous**: the door check assumes 90 s per pallet; one door fewer in a prototype gave "doors too few" in Checks (tried and reverted); the price is "doors idle" infos in Results.
11. **Depots hold their fleets** (slots >= vehicles homed there): required by `model.examples.test.js`.
12. **Tips are measured, not copied**: every figure was re-run on this tree (seeds 1 to 5, 8 simulated hours); `proto/ship/check-claims.mjs` verifies that every figure printed in a tip is the measured mean (148 claims, 0 mismatches).

### 3.2 The two critics' findings and what was done about them

Two critics reviewed the first version of the ladder. Every high and medium finding was applied; the one part refused is marked.

| Finding | What was done |
|---|---|
| morning-peak: notes and tip 1 said "run to 10:00", but the quoted queue shows only from about 12:00 (gate wait is booked when a truck reaches a door) | Notes and tip 1 now say 14:00 (8 h, the moment the numbers were measured) and explain why 10:00 looks quiet; pallets/h is no longer a headline (the timetable pins it at 69); every edit restarts the day at 06:00 and the notes say so. Measured at 4, 6, 7 and 8 h: gate wait of the base 0.5, 18.9, 19.4 and 19.4 min. |
| twin-plants never settled (container yard with no outflow, stocks growing 60 to 70 loads an hour, critical findings by day 1) | Redesigned: the container return is gone; plant B sends the 5 % of units that fail the quality check back to plant A for rework (a flow with a consumer, so nothing piles up); inbound and outbound rates were balanced (3.3), the trucks come on a fixed rhythm, the machines were right-sized. 5 seeds: 151 loads in the plant at hour 8, 186 at hour 24; 3 seeds over 48 hours: 149 to 157 at hour 8, 239 to 263 at hour 48, no deadlock, no critical finding (3.3 and 6.6). |
| tips invisible in the app (only tests read `example.tips`) | Made a REQUIRED part of the build (section 7.4, task I2, acceptance E27): a Help tab "Examples" generated from `EXAMPLES` and an action on the toast that opens an example. The ladder is not shippable without it. |
| no tip told the user to raise the simulation speed (default 10×: the lesson starts 12 to 48 real minutes in) | Every notes text and every first tip now opens with the speed (600×; 8 hours take under a minute) and, where it matters, says that every edit starts the run again. |
| output tips of components-plant and twin-plants quoted 5-seed means with overlapping bands; the default seed-1 run showed something else | Two fixes: (1) the trucks of both plants now arrive on a fixed rhythm, so the seed bands are 3 % wide or less (components base 18.8 to 19.7 pallets/h, twin 17.5 to 18.0); (2) tips were rewritten on stable metrics (utilisation, waiting, loads in the plant) with the band quoted where the output is noisy (components demand 1.2: 18.7 to 22.3). The claims "+31 %", "-33 %" and "+8 % lead time" are gone. |
| components-plant tip 2 named the wrong next bottleneck (assembly); the +12 % / +19 % output claims did not hold per seed | Rewritten: with demand 1.2 and a second paint machine the paint shop falls to 52 % and the PRESS LINE (90 % busy against 74 %) is the next limit; the finding names it in 2 of 5 runs. |
| components-plant tips 3 to 5 could not be carried out as written (Slow zone tool paints only 0.5, 0.25, 0.75; erasing the cross aisle also erases the crossing cell) | Tip 3 says from just inside the west side to just inside the east side; tip 4 says "in two strokes, leave the crossing cell" and quotes what happens if you take it too (forklifts 54 % busy, waiting 16 %); tip 5 uses Alt-drag with the Slow zone tool, which takes the limit off (checked in `js/ui/editor/roads.js`, `strokeKind`). |
| charging-corner teaches one start-up wave; the finding at that moment says "add a vehicle" | Kept, and said so: a scan of six runtime / charge-time pairs over 24 hours (3.4) found no steady regime between "settles after the wave" and "collapses", so the wave is the lesson. Notes and tip 1 describe the hours 3 to 5, the misleading finding between hour 4 and 5 and the clean verdict at hour 8; tip 3 (one charger) is the persistent case. **Refused part:** "tune it so that charging stays visible in steady state": no such regime exists in the scan. |
| yard-shuttle tips misstated the numbers ("each way", "round trips") and omitted the Checks warning | "30 pallets/h each way, 60 in all", "7.6 loaded trips an hour (3.8 round trips)", the Checks warning is quoted in tip 4; the name says 280 metres (measured 284 m loaded one way, 244 m back). |
| hello-pallet: the napkin did not close with the numbers shown | The leg time is in the napkin now: about 35 s per 81 m leg (27 s at full speed plus speeding up and braking), so a trip is about 110 s. |
| the test plan missed existing tests that go red (sim.logistics.review) and e2e loops | Section 8.2 lists every test file that iterates `EXAMPLES`, with the result of running it against a scratch copy with the six added (one red: sim.logistics.review, because the twin's first pallet leaves at minute 84; one asserts the old id list; two need the size rules; the rest are green). |
| card descriptions were cut to 40 % (the "fits three lines" claim was false) | New descriptions are 105 to 123 characters (three lines at the card width of 274 px, about 42 characters a line); the `learn` line carries the rest; the twin card spans two columns; the level heading "A whole line" is now "Several things at once" because congestion-lab and warehouse-first-day are not lines. |
| morning-peak repeats warehouse-first-day, and its headline KPI never moves | Tips reordered: the timetable first, the route trucks that leave short second (output -16 %), the ring last; the doors-against-forklifts point is flagged as the one shared with Warehouse: first day. Pallets/h is out of the headline. |
| twin notes broader than what the model does; polish items (charging label, median not in the Results tab, ...) | Notes now say that the yard trucks also bring the brackets to A's weld cells, that the warehouse splits by fixed weights and that a pallet is a pallet; the label "Opportunity or shift charging?" became "Two chargers for six forklifts"; the median is gone from the tips (the Results tab shows "95 % within"). |

### 3.3 What the plants taught about building complex examples (rules for the next example maker)

Measured while fixing the twin plants (24 and 48 hour runs, `proto/ship/longrun2.mjs`):

1. **Independent pushed supplies make a multi-input plant drift.** Every input of a bill of materials arrives by its own supplier; the least-supplied input paces the plant and every other input piles up (the first twin had steel, plastics and parts at 121 to 126 % of what the plant used: 50 to 70 loads an hour of growth). Balance the inputs on the pull side (the outbound trucks) within 3 to 5 %.
2. **Random truck gaps need big margins, exact ones do not.** With normal gaps of +-30 % and uniform pallets, the plant needed 10 % margins and still wandered between seeds (5-seed output band 18 to 23 pallets/h). With constant gaps and pallets (`interArrival` kind `const`, `pallets` const 24) a 3 to 5 % margin holds and the seed bands shrink to 3 %. The two big plants use the fixed rhythm; the notes say so ("the trucks come on a fixed rhythm").
3. **The central warehouse splits its parts by fixed weights, at the moment a pallet arrives.** Weights must match the needs exactly (1 : 1 : 2 : 2 for two welds and two assemblies) and the supply needs a margin, otherwise the share with the least margin paces the plant (tip 3 of the twin plants turns this into a lesson).
4. **"Blocked" and "waits for input" are what a plant with spare capacity looks like**, and the Results tab calls a station blocked 40 % of the time critical. Right-size the cycle times: in the twin the presses run at 300 s (80 % busy, not blocked) instead of 180 s (blocked 45 to 55 % of the time, a critical finding), the welds at 250 s, paint 280 s, moulding one machine at 150 s, assemblies 300 s, quality 110 s, packing 120 s: every machine except the rework station is 54 to 80 % busy.
5. **A pipeline ships late.** The first outbound truck of a rate-mode gate arrives one gap after the start (twin: 78 minutes at the retail gate), so the first pallet leaves at minute 84; the check "goods leave within an hour" of sim.logistics.review has to run 90 minutes for such plants.
6. **Quote what the tab shows.** The Results tab says "95 % within X", not "95th percentile" or "median"; it has no per-plant figures; the Doors card has gate wait and door time.
7. **Every claim needs a reading time.** A cumulative figure moves while the run goes on (gate wait 0.5 min at 10:00, 19 min at 14:00; the charging wave is gone by hour 6).

Stationarity of the two big plants (loads in the plant after N hours, fixed rhythm, seeds 1 to 3):

```
hour                      8   16   24   32   40   48
twin-plants      seed 1  149  152  179  203  256  239
twin-plants      seed 2  157  158  179  208  225  263
twin-plants      seed 3  150  157  182  203  222  250
components-plant seed 1   83   46   77   50  167   84
components-plant seed 2   83   39   74   60  102  177
components-plant seed 3   66   40   78   49   85  128
```

The twin plants grow slowly after hour 24 (about 2.5 loads an hour: the central warehouse and the trim store fill, the first full store would come after more than 100 hours); the components plant oscillates with the truck rhythm and shows trucks leaving the spares gate short after about 40 hours (its output of 19.0 to 19.4 pallets/h is a hair below the 19.4 its trucks ask for). Both are listed in the risks of 6.5 and 6.6, and neither shows a critical finding or a deadlock.

### 3.4 The charging scan (why the wave is the lesson)

Lead time per 4-hour block over 24 hours (mean minutes, seeds 1 and 2) for battery runtime / charge time pairs, six forklifts, two chargers: 180 / 60 (the example): 7.5, 8.3, 4.2, 4.2, 4.2, 4.2 (settles); 120 / 60: 15.5, 7.9, 4.2, 4.2, 4.2, 4.3 (settles); 120 / 90: 21, 79, 114, 149, 181, 215 (collapses); 90 / 90: 30, 124, 210, 293, 377, 459 (collapses); 90 / 60: 23, 51, 64, 75, 87, 101 (collapses); 60 / 45: 28, 71, 107, 145, 180, 219 (collapses). There is no pair that stays in a bounded, visible queue. Hourly lead time of the example (seeds 1 to 5, by the hour the pallet left): 4.2, 4.1, 4.2, **23.0, 18.3**, 4.2, 4.2, 4.1, 4.2, 4.2 minutes; with one charger: 4.2, 4.1, 4.2, 28.2, 50.1, 52.7, 53.9, 55.3, 56.6, 57.4 (the wave never ends).

## 4. What the model cannot do (say so in the notes, the gallery and the docs)

- **No multi-site concept.** There is no site on a station, no per-site KPI or fleet row, no public-road leg between sites, no calendar or currency per site and no allocation or stock-transfer rule. The "second plant" of `twin-plants` is a second zone of one 340 x 104 m baseplate, joined by a yard road (section 5).
- **A vehicle serves one flow per trip** (no milk-run tours with several stops): the tugger trains are shuttles, and the yard trucks serve flows that go in both directions as separate trips.
- **No closed loops with identity.** A load is a pallet; nothing tells a returned unit from a new one. The twin's rework flow is a weighted split (5 % of the output of Quality goes back to plant A and comes out of the rework station as a frame again), not a tracked loop. An earlier draft returned empty containers into a storage with no outflow: it filled up (17 an hour) and was dropped; a sink would count the empties as goods leaving.
- **A process with several incoming flows needs loads from ALL of them every cycle** (a bill of materials): parallel stations cannot feed one process; use `machines: n` or a merge storage.
- **A storage hands its loads out by fixed weights**, decided when a load arrives (static weighted round robin), not by who is short.
- **No initial stock:** long pipelines need a warm-up (2 hours for the two big plants) and ship late (3.3, rule 5); a clock plant restarts cold from its start time after every edit (no impact card).
- **Insights:** "fleet saturated" can fire where the wait is for a batch or for room downstream (the pickup wait of a pull flow includes waiting for the truck); there is no charger-queue finding (vehicles waiting for a charger count as parked); "blocked" and "waits for input" fire on any plant with spare capacity; the door check assumes 90 s per pallet.
- **Batteries** drain only while a vehicle drives and all start full: a fleet charges in a wave (the first charge comes at about hour 2.7 in the charging corner).
- **Bays shorter than 3 cells** can deadlock now and then (a designer's finding for 2-cell bays in a draft, not re-run); there is no "bay too short" check. Every bay of the six is 3 cells or has a dock on the spur.
- **The tips of an example are not shown anywhere in the app today** (`example.tips` is read only by tests); section 7.4 makes that part of the build.

## 5. The two plants (twin-plants): the honest version

**What is modelled.** One 340 x 104 m baseplate (170 x 52 cells at 2 m) in three zones, labelled on the plan: PLANT A (west: steel and plastics gates, coil store, two press / weld / paint lines, moulding, trim store, a frame dispatch, rework, a customer gate), THE YARD (a parts gate, the central warehouse, one charging hall, the yard truck park) and PLANT B (east: frame receiving, two assembly lines, test buffer, quality, packing, a finished-goods store, retail, export and spares gates). A yard road (the mid street, two-way, slow zones at both plant gates) joins the rings of the two plants.

| Zone | Cells | Stations | Fleets | Gates |
|---|---|---|---|---|
| PLANT A (west) | x 1 to 69 | 16: Steel gate, Coil store, Press 1, Weld 1, Paint 1, Press 2, Weld 2, Paint 2, Plastics gate, Moulding, Trim store, Customer gate, Rework, Frame dispatch, Forklift park, AGV park | Forklifts A (3), AGVs A (7) | in: A Steel gate (3 doors), A Plastics gate (2); out: A Customer gate (1) |
| THE YARD | x 70 to 100 | 4: Yard Parts gate, Central warehouse, Charging hall, Yard truck park | Yard forklifts (2), Yard trucks (6) | in: Yard Parts gate (4 doors) |
| PLANT B (east) | x 96 to 165 | 13: Frame receiving, Assembly 1, Assembly 2, Test buffer, Quality, Packing, FG store, Retail gate, Export gate, Spares gate, Forklift park, AGV park, Tugger park | Tugger B (3), AGVs B (6), Forklifts B (3) | out: B Retail gate (3 doors), B Export gate (2), B Spares gate (1) |

The x ranges overlap a little because the yard stations sit on both sides of the mid street: the frame dispatch and the rework station (plant A) at x 62 to 69, the frame receiving of plant B and the yard truck park at x 96 to 103.

**How the plants share goods and what depends on what:**

- *Frames and trim A to B* by the six **yard trucks**, a dedicated shuttle fleet restricted by `fleetId` to the flows that cross the yard (frame dispatch to frame receiving, trim store to both assemblies, quality to rework) and to the brackets for A's weld cells; forklifts and AGVs never leave their plant. Batch and longest wait (6 pallets / 10 min for frames) are the lesson of yard-shuttle again.
- *Rejects B to A:* about 1 unit in 20 leaves Quality for plant A's rework station and comes out as a frame (a weighted flow with a consumer; see section 4).
- *Parts for both plants from one central warehouse* (brackets to A's welds, motors to B's assemblies), handed out by fixed weights: the sharing rule is a tip (the weights decide who starves).
- *One charging hall* (6 chargers, 48 slots) for the batteries of both plants and the yard: the one resource both depend on (tip 2: two chargers stop both plants).
- *Separate truck gates per plant:* A: steel, plastics, customer; yard: parts; B: retail, export, spares; every gate has its own doors and its own rhythm. Three goods in (steel, plastics, parts), four goods out (A customer, B retail, export, spares).
- *The limit of the whole is the slower plant* (tip 4: demand 1.5 shows the press lines and the moulding of plant A as the bottlenecks of the whole campus).

**What is NOT modelled** (so the notes, the gallery and this document say it): per-plant KPIs (compare the plants through their stations and fleets: the names carry the zone, "A ..." and "B ..."), a site tag, inter-site legs with their own travel time and schedule, transfer orders and allocation rules between stocks, per-site calendars and shifts, load identity across sites (the unit that goes back is anonymous), cost.

**What a real multi-site model would add (not to be built now):** a `site` tag on stations and fleets; per-site KPI, utilisation and lead-time rows in Results; inter-site legs with their own travel time, truck capacity and schedule (a public road, a ferry); transfer orders and allocation rules between stocks (who gets the scarce part: priority, fair share, by need); per-site calendars, shifts and clocks; load identity across sites (a frame is made in A and used in B, a unit is rejected in B and reworked in A); optionally cost. None of it is needed for the ladder.

## 6. The six examples

Each block holds what a builder needs: the story, a sketch of the plant, the stations, fleets and flows (enough to rebuild it; the prototype is the code), the exact notes and tips, the measured claims with seeds and duration, the edits the tips describe, the validation result, the performance budget and the risks. "Seeds 1 to 5, 8 h" means five runs of 8 simulated hours with the default settings of the layout (the KPI window is 8 h minus the warm-up), the convention of `tests/sim.engine.review.test.js`; the live app shows one run (seed 1). The reference hash is `sha1(JSON.stringify(build()))` of the prototype layout.

### 6.1 `hello-pallet`: Hello, pallet: one forklift, one road (level 1, rank 1)

- **Origin:** pedagogy (hello-pallet); notes and tips rewritten after the reviews (the napkin now closes with the leg time of 35 s).
- **Card description (112 characters):** One forklift, one road, one pallet every 2.5 minutes. How many can it carry? Work it out, then raise the demand.
- **Learn line (card):** A vehicle is a machine with a cycle time, so its capacity can be calculated.
- **Chips (card):** 1 forklift · napkin maths
- **Story:** A pallet arrives at Goods in every 150 seconds and one forklift carries it 81 m along a single road to Goods out. Press play, work out on the back of an envelope why one forklift can carry about 33 pallets an hour at most, then raise the demand and watch the pile appear.
- **Teaches:** A vehicle is a machine with a cycle time (drive loaded, hand over, drive back empty, hand over), so its capacity can be calculated; when demand exceeds it, throughput stops and the queue and the lead time are what grow. Also the first look at the Results tab (arrived against left, utilisation, lead time) and at two of the three what-if sliders.
- **Features:** forklift preset on 3 m cells (a 2.6 m truck fits a cell); one two-way road, a dead end at both ends, one parking bay; depot as parking (no chargers, no battery); the Demand and Vehicle speed sliders; Results basics.

**Notes text** (exact `layout.notes`, 680 characters; shown in the Properties tab > Plant > Notes and in the report):

> The smallest plant there is. A pallet arrives at Goods in every 150 seconds (24 an hour) and one forklift carries it along 81 metres of road to Goods out. A forklift is a machine like any other: a trip is a drive of about 35 seconds (27 at full speed, plus speeding up and braking), the hand-over, the drive back and the next hand-over, about 110 seconds in all, so it can carry at most about 33 pallets an hour. Press play (at 600× the 8 hours of the tips take under a minute), open the Results tab and compare the pallets that arrive with the pallets that leave. Then raise "Demand" in the Simulate tab above 1.4 and watch what a vehicle that has no time left does to the queue.

**Tips (exact strings of `tips`, 4):**

1. Press play and open the Results tab (set the speed in the bar above the plan to 600× and 8 hours take under a minute). Napkin first: each 81 m leg takes about 35 s (27 s at full speed, plus speeding up and braking) and the hand-over takes 20 s at each end, so one trip is about 110 s and one forklift can carry at most about 33 pallets an hour. The plant asks for 24, so the forklift is busy about 77 % of the time and a pallet is in the plant for under 2 minutes (over several runs: 24.0 pallets/h, lead time 1.6 min).
2. Try: raise "Demand" in the Simulate tab to 1.5. The forklift cannot do more than about 33 trips an hour, so the output stops at 32.8 pallets/h instead of the 36 asked for, the forklift is busy 100 % of the time, the lead time grows from 1.6 to 24 minutes and about 27 pallets are in the plant at the end of 8 hours.
3. Try: with "Demand" at 2, add a second forklift in the Fleet tab. The output is 48.1 pallets/h, each forklift is busy about 78 % of the time and the lead time is back at 1.6 minutes; with one forklift it was 79 minutes and 124 pallets were still in the plant after 8 hours.
4. Try: with "Demand" at 2, set "Vehicle speed" to 2 instead. A forklift twice as fast does not carry twice as much: the output is only 43.8 pallets/h, not about 66, and the forklift is still busy 100 % of the time, because the 40 s of hand-over and the speeding up and braking of every trip do not get faster.

**Layout:** 36 x 14 cells at 3 m (108 x 42 m), schema 1, no clock (stationary plant), warm-up 600 s, 29 road cells, 3 labels ("Goods in", "Goods out", "One road, 81 m"), 3 stations (0 with trucks), 1 flow, 1 fleet / 1 vehicle. Reference hash `23a18d22805728751583cb9cf78230b4133eb59e`.

Sketch (letters = stations, `.` two-way road, arrows one-way, `~` slow zone; one character = 1 x 1 cells):

```
 III                            OOO
 III............................OOO
                 .
                PPP
                PPP
```

Legend: I Goods in; O Goods out; P Forklift park.

| Station | Type | Cell (x, y) | Size | Parameters | Trucks and doors |
|---|---|---|---|---|---|
| Goods in | source | 1, 6 | 3 x 2 | arrival n(150 ±15 %), out buffer 6 |  |
| Goods out | sink | 32, 6 | 3 x 2 |  |  |
| Forklift park | depot | 16, 9 | 3 x 2 | slots 2, chargers 0 |  |

| Fleet | Preset | Count | Capacity | Speed (m/s) | Length (m) | Load / unload (s) | Battery | Home |
|---|---|---|---|---|---|---|---|---|
| Forklift | forklift | 1 | 1 | 3 | 2.6 | 20 / 20 | off | Forklift park |

| Flow | Fleet | Weight | Per cycle | Batch min / max wait | Priority |
|---|---|---|---|---|---|
| Goods in -> Goods out | any | 1 | 1 | - | 1 |

**Test claims** (seeds 1 to 5, 8 h unless the row says hour 24; mean [min .. max]; `results/ship/hello-a.json`, regenerated by `meas2.mjs`). The last column is the figure as printed in the tip; `check-claims.mjs` verified every row against the tip text.

| Tip | Variant | Metric | Measured mean [min .. max] | In the tip |
|---|---|---|---|---|
| 1 | base | pallets/h (`thr`) | 24.0 [23.6 .. 24.5] | 24.0 |
| 1 | base | forklift busy % (`Forklift_util`) | 77.0 [75.7 .. 78.4] | 77 |
| 1 | base | lead time, min (`leadMean`) | 1.6 [1.6 .. 1.7] | 1.6 |
| 2 | d15 | pallets/h (`thr`) | 32.8 [32.8 .. 32.8] | 32.8 |
| 2 | d15 | forklift busy % (`Forklift_util`) | 100 [100.0 .. 100] | 100 |
| 2 | d15 | lead time, min (`leadMean`) | 23.7 [21.1 .. 25.9] | 24 |
| 2 | d15 | pallets in the plant at the end (`wipNow`) | 26.8 [24.0 .. 30.0] | 27 |
| 3 | d2two | pallets/h (two forklifts) (`thr`) | 48.1 [47.7 .. 48.6] | 48.1 |
| 3 | d2two | forklift busy % (`Forklift_util`) | 78.1 [77.5 .. 78.7] | 78 |
| 3 | d2two | lead time, min (`leadMean`) | 1.6 [1.6 .. 1.6] | 1.6 |
| 3 | d2 | lead time, min (one forklift) (`leadMean`) | 78.9 [77.0 .. 80.7] | 79 |
| 3 | d2 | pallets in the plant at the end (one forklift) (`wipNow`) | 124 [122 .. 127] | 124 |
| 4 | d2fast2 | pallets/h (`thr`) | 43.8 [43.8 .. 43.8] | 43.8 |
| 4 | d2fast2 | forklift busy % (`Forklift_util`) | 100 [100 .. 100] | 100 |

**Findings claims** (the Results tab, number of the 5 runs of 8 h in which the finding appears):

- base: no finding except "No bottlenecks, congestion or deadlocks found" in 5 of 5 runs.
- tip 2, d15: Demand 1.5: the fleet finding turns critical (fleet saturated): 5 of 5 runs (severity critical).
- tip 2, d15: Demand 1.5: the supply finding (Goods in delivers more than the plant takes): 5 of 5 runs.

**Variant edits** (plain mutator calls, exactly what the tips describe; the claims table names the variants):

```js
d15: (l) => L.updateSettings(l, { demandFactor: 1.5 })
d2two: (l) => { variants.d2(l); variants.two(l); }
d2: (l) => L.updateSettings(l, { demandFactor: 2 })
d2fast2: (l) => { variants.d2(l); variants.fast2(l); }
```

**Expected validation result:** zero issues of any severity for the example and for every variant above.

**Performance budget:**

- speed 101,101x real time (gate 500x, target 2000x); CPU per 8 h run 0.32 s (seed 1); builder 0.2 ms warm;
- share link 1.5 KB (1553 characters); canvas (headless Chromium, fitted): first render 30.10 ms, fitted: render med 0.20 p95 0.60 max 1.80 ms, sim 1 s med 0.10 ms;
- the all-examples test loops cost 0.83 CPU s for this example;
- first load leaves at minute 2.

**Verification run** (this tree):

```
[hello-pallet] 36x14x3m, 3 stations, 1 vehicles, 29 road cells, schema 1
  validate: zero issues; errors 0; layout invariants []; fixed point true; json round trip true
  per-tick invariants over 1800 s: none violated (0.4 CPU s with the checker on)
  2 h seed 1: report sane (finite, shares sum to 1, percentiles ordered); 47 loads left the plant in 2 h (KPI window starts at 600 s: 43 counted, 23.5/h), deadlocks 0, stuck vehicles 0
  speed: 0.036 CPU s per simulated hour = 101101x real time (gate 500x, target 2000x)
  load: build layout + construct simulation + 60 s = 0.00 CPU s
```

```
hello-pallet: 36x14 cells at 3 m (108 x 42 m), schema 1, calendar none, warm-up 600 s
   3 stations (0 with trucks), 1 flows, 1 fleets / 1 vehicles, 29 road cells, 0 obstacles, 3 labels, notes 680 chars
   validate: zero issues (errors, warnings and infos); invariants []; fixed point true
   share link: 1553 chars
   2 h seed 1 (own warm-up): window 1.8 h, 23.5 pallets/h (43 left), 47 loads left in 2 h, lead 1.7 min, WIP 0.7, traffic wait 0%, deadlocks 0, unplaced 0; 24607x
      fleets: Forklift x1 76% busy
      insights: [good] No bottlenecks, congestion or deadlocks found.
   8 h seed 1: 24.5 pallets/h, lead 1.7 min (p95 1.9), WIP 0.7, traffic wait 0%, deadlocks 0; 0.32 CPU s = 89356x
      fleets: Forklift x1 78% busy
      insights: [good] No bottlenecks, congestion or deadlocks found.
```

Universal checks of the existing all-examples test loops (model.examples, sim.integration, sim.engine.routing, model.layout.grow), replayed by `sanity.mjs`: 12 of 12 checks ok.

**Risks and honest limits:**

- Small next to the Starter, which already has two processes: the gallery must show it as the entry card (rank 1, "Start here"), otherwise newcomers still land on the Starter.
- Tips 2 to 4 deliberately produce a pile-up; the Results tab then correctly says "fleet saturated" and "supply": the tip text expects it.
- The 43.8 against 66 figure depends on the forklift preset constants (hand-over 20 s + 20 s, acceleration 1 m/s2, braking 2 m/s2) in js/model/defaults.js: if the preset moves, the numbers move and the test band must follow.
- No finding fires on the base plant (5 of 5 seeds): the Results tab says "No bottlenecks, congestion or deadlocks found".

**Prototype:** `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/hello-pallet.mjs` (exports `build()`, `variants`, `meta`, `glyph`).

### 6.2 `charging-corner`: Charging corner: six electric forklifts, two chargers (level 2, rank 3)

- **Origin:** capability (charging-corner), ported to the shared helpers; notes and tips rewritten after the reviews (the wave is the lesson, the speed, the findings at hour 4 to 5).
- **Card description (116 characters):** Six electric forklifts, two chargers. The batteries start full and run low together: what does that do to the queue?
- **Learn line (card):** Energy is a hidden capacity: no charge, no work, and the chargers are a station like any other.
- **Chips (card):** electric forklifts · batteries · chargers
- **Story:** Six electric forklifts carry pallets from Goods in through a store to Goods out, one pallet a minute. Each battery lasts 3 h of driving and needs 60 min to fill from empty; below 30 % a forklift goes to the Charging bay, which has two chargers, and comes back at 90 %. All batteries start full, so they run low together at about hour 3.
- **Teaches:** Energy is a hidden capacity: a vehicle works only while it has charge, the chargers are a station like any other, and the levels (go charging below / back to work at), the charge time and the charger count decide how much of the fleet is away and for how long. Output hardly moves (the plant is demand-limited) but the lead time, its tail and the queue at Goods in do. First example of batteries, a depot with chargers and the charging share in the Results tab.
- **Features:** forklift preset with the four battery fields (runtime, charge time, go charging below, back to work at); a depot with exactly two chargers (8 slots); a storage with dwell; a two-way ring with three bays and a second door to the store.

**Notes text** (exact `layout.notes`, 855 characters; shown in the Properties tab > Plant > Notes and in the report):

> Six electric forklifts carry pallets from Goods in through the Store to Goods out; one pallet arrives every minute. Each battery lasts 3 hours of driving and needs 60 minutes to fill from empty (indicative values, shortened so that you see charging within one shift). A forklift whose battery falls below 30 % takes no more jobs and drives to the Charging bay, which has only two chargers; it comes back at 90 %. All batteries start full, so the forklifts run low at about the same time: that first charging wave, between hour 3 and hour 5, is what this plant is about. Set the speed to 600×, run it to hour 8 and watch the Results tab and the strip of the fleet in the Fleet tab: how many forklifts are away charging, and how long do pallets wait at Goods in? Every edit starts the run again from zero, so run to hour 8 again before you read the numbers.

**Tips (exact strings of `tips`, 5):**

1. Press play, set the speed to 600× and run to hour 8. The batteries start full, so the forklifts run low together: between hour 3 and hour 5 the lead time jumps from 4 to about 20 minutes and up to 20 pallets queue at Goods in; from hour 5 on it is back at 4 minutes, because the forklifts have drifted apart. Between hour 4 and hour 5 the Results tab warns that Goods in delivers more than the plant takes and that the forklifts are saturated: that is the wave, not a missing forklift (at hour 8 it says "No bottlenecks"). Over several runs, at hour 8: a forklift has spent about 16 % of its time on a charger, the fleet is busy 64 %, the mean lead time is 8.2 minutes, 95 % of the pallets are through within 27 minutes and the plant delivers 60.3 pallets/h.
2. Try: switch "Model the battery" off in the Fleet tab and run to hour 8 again. The output is the same (60.3 pallets/h), but the mean lead time falls from 8.2 to 4.1 minutes and the time within which 95 % of the pallets are through from 27 to 4.4 minutes: while there are spare forklifts, the charging wave costs time, not output.
3. Try: set "Charging slots" of the Charging bay to 1 (Properties tab). One charger cannot keep up with six forklifts, so the wave never ends: from hour 5 on a pallet waits about 50 minutes, the mean lead time over the 8 hours is 32 minutes, about 56 pallets are still in the plant at the end and the output falls to 53.6 pallets/h (-11 %). With three chargers the mean lead time is 6.5 minutes (8.2 with two): the third one helps much less than the second did.
4. Try: let the forklifts go back to work at 60 % instead of 90 % ("Back to work at" in the Fleet tab, Battery). Each stop is shorter, so the forklifts are back sooner: the mean lead time falls from 8.2 to 4.3 minutes and nobody queues at Goods in. The other way round, a slow charger of 120 minutes (Charge time) gives 50.4 pallets/h and 44 minutes.
5. Try: set "Go charging below" to 0 %. Nothing sends a forklift to the charger in time any more: all six run flat and stop where they stand (6 of 6 in all five runs), the output drops to 28.5 pallets/h (-53 %) and the Battery finding turns critical.

**Layout:** 56 x 30 cells at 2 m (112 x 60 m), schema 1, no clock (stationary plant), warm-up 600 s, 130 road cells, 3 labels ("Receiving", "Shipping", "Two chargers for six forklifts"), 4 stations (0 with trucks), 2 flows, 1 fleet / 6 vehicles. Reference hash `870a089777e682ffe2ca0b483cb679c710a2b3a6`.

Sketch (letters = stations, `.` two-way road, arrows one-way, `~` slow zone; one character = 1 x 1 cells):

```
            IIII
            IIII
              .
              .
     ..............................................
     .                  .   .                     .
     .                  .   .                     .
     .                  .   .                     .
     .             SSSSSSSSSS                     .
     .             SSSSSSSSSS                     .  OO
     .             SSSSSSSSSS                     .  OO
     .             SSSSSSSSSS                     ...OO
     .             SSSSSSSSSS                     .  OO
     .             SSSSSSSSSS                     .
     .             SSSSSSSSSS                     .
     .             SSSSSSSSSS                     .
     .                                            .
     .                                            .
     ..............................................
              .
              .
          CCCCCCCC
          CCCCCCCC
          CCCCCCCC
```

Legend: I Goods in; S Store; O Goods out; C Charging bay.

| Station | Type | Cell (x, y) | Size | Parameters | Trucks and doors |
|---|---|---|---|---|---|
| Goods in | source | 12, 3 | 4 x 2 | arrival n(60 ±20 %), out buffer 8 |  |
| Store | storage | 19, 11 | 10 x 8 | capacity 300, dwell 45 s |  |
| Goods out | sink | 53, 12 | 2 x 4 |  |  |
| Charging bay | depot | 10, 24 | 8 x 3 | slots 8, chargers 2 |  |

| Fleet | Preset | Count | Capacity | Speed (m/s) | Length (m) | Load / unload (s) | Battery | Home |
|---|---|---|---|---|---|---|---|---|
| E-forklifts | forklift | 6 | 1 | 3 | 2 | 20 / 20 | 3 h runtime, 60 min charge, low 30 %, resume 90 % | Charging bay |

| Flow | Fleet | Weight | Per cycle | Batch min / max wait | Priority |
|---|---|---|---|---|---|
| Goods in -> Store | any | 1 | 1 | - | 1 |
| Store -> Goods out | any | 1 | 1 | - | 1 |

**Test claims** (seeds 1 to 5, 8 h unless the row says hour 24; mean [min .. max]; `results/ship/charging-a.json`, regenerated by `meas2.mjs`). The last column is the figure as printed in the tip; `check-claims.mjs` verified every row against the tip text.

| Tip | Variant | Metric | Measured mean [min .. max] | In the tip |
|---|---|---|---|---|
| 1 | base | charging % (`Eforklifts_chg`) | 16.3 [16.1 .. 16.6] | 16 |
| 1 | base | busy % (`Eforklifts_util`) | 64.1 [63.6 .. 64.4] | 64 |
| 1 | base | lead time, min (`leadMean`) | 8.2 [7.3 .. 9.1] | 8.2 |
| 1 | base | lead time p95, min (`leadP95`) | 27.0 [23.1 .. 30.6] | 27 |
| 1 | base | pallets queued at Goods in (max) (`Goodsin_yardMax`) | 20.4 [18.0 .. 24.0] | 20 |
| 1 | base | pallets/h (`thr`) | 60.3 [59.6 .. 60.6] | 60.3 |
| 2 | nobat | pallets/h (`thr`) | 60.3 [59.6 .. 60.6] | 60.3 |
| 2 | nobat | lead time, min (`leadMean`) | 4.1 [4.1 .. 4.1] | 4.1 |
| 2 | nobat | lead time p95, min (`leadP95`) | 4.4 [4.4 .. 4.5] | 4.4 |
| 3 | ch1 | pallets/h (`thr`) | 53.6 [53.0 .. 54.3] | 53.6 |
| 3 | ch1 against base | output change % (`thr`) | -11 % | -11 % |
| 3 | ch1 | lead time, min (`leadMean`) | 32.3 [29.1 .. 35.4] | 32 |
| 3 | ch1 | pallets in the plant at the end (`wipNow`) | 56.2 [50.0 .. 64.0] | 56 |
| 3 | ch3 | lead time, min (3 chargers) (`leadMean`) | 6.5 [6.0 .. 6.9] | 6.5 |
| 4 | res60 | lead time, min (`leadMean`) | 4.3 [4.2 .. 4.5] | 4.3 |
| 4 | charge120 | pallets/h (`thr`) | 50.4 [49.8 .. 50.8] | 50.4 |
| 4 | charge120 | lead time, min (`leadMean`) | 44.3 [41.5 .. 46.2] | 44 |
| 5 | low0 | pallets/h (`thr`) | 28.5 [26.9 .. 29.7] | 28.5 |
| 5 | low0 against base | output change % (`thr`) | -53 % | -53 % |
| 5 | low0 | vehicles dead on the road (`dead`) | 6.0 [6.0 .. 6.0] | 6 |

**Findings claims** (the Results tab, number of the 5 runs of 8 h in which the finding appears):

- base: no finding except "No bottlenecks, congestion or deadlocks found" in 5 of 5 runs.
- tip 3, ch1: one charger: the finding "Goods in delivers more than the plant takes" is critical: 5 of 5 runs (severity critical).
- tip 5, low0: flat batteries: the Battery finding is critical: 5 of 5 runs (severity critical).

**Hourly lead time of the base and of the one-charger variant** (mean minutes of the pallets that left in that hour, seeds 1 to 5; the wave of tip 1 and the collapse of tip 3), `work/cc-hourly.mjs`:

```
base:
hour           1     2     3     4     5     6     7     8     9    10
lead min     4.2   4.1   4.2  23.0  18.3   4.2   4.2   4.1   4.2   4.2
wip now        4     4     7    30     5     4     5     4     5     4
ch1 (one charger):
hour           1     2     3     4     5     6     7     8     9    10
lead min     4.2   4.1   4.2  28.2  50.1  52.7  53.9  55.3  56.6  57.4
wip now        4     4     7    45    53    54    55    56    57    57
```

**What the Results tab says at several moments of the base run** (number of runs of 5; numbers replaced by #), `work/ins-at.mjs`:

```
--- at 3 h
  x5  good: No bottlenecks, congestion or deadlocks found.
--- at 4 h
  x1  warning: Goods in delivers more than the plant takes: # loads are piling up in its yard.
  x4  good: No bottlenecks, congestion or deadlocks found.
--- at 4.5 h
  x3  warning: E-forklifts fleet is saturated: its # vehicles are busy # % of the time, and loads wait # min for a pickup.
  x5  warning: Goods in delivers more than the plant takes: # loads are piling up in its yard.
--- at 5 h
  x5  warning: E-forklifts fleet is saturated: its # vehicles are busy # % of the time, and loads wait # min for a pickup.
--- at 6 h
  x2  warning: E-forklifts fleet is saturated: its # vehicles are busy # % of the time, and loads wait # min for a pickup.
  x3  good: No bottlenecks, congestion or deadlocks found.
--- at 8 h
  x5  good: No bottlenecks, congestion or deadlocks found.
```


**Variant edits** (plain mutator calls, exactly what the tips describe; the claims table names the variants):

```js
nobat: (l) => L.updateFleet(l, fl(l).id, { battery: { enabled: false } })
ch1: (l) => L.updateStation(l, st(l, 'Charging bay').id, { params: { chargers: 1 } })
ch3: (l) => L.updateStation(l, st(l, 'Charging bay').id, { params: { chargers: 3 } })
res60: (l) => L.updateFleet(l, fl(l).id, { battery: { resumePct: 60 } })
charge120: (l) => L.updateFleet(l, fl(l).id, { battery: { chargeTimeMin: 120 } })
low0: (l) => L.updateFleet(l, fl(l).id, { battery: { lowPct: 0 } })
```

**Expected validation result:** zero issues of any severity for the example and for every variant above.

**Performance budget:**

- speed 34,658x real time (gate 500x, target 2000x); CPU per 8 h run 0.93 s (seed 1); builder 0.5 ms warm;
- share link 2.1 KB (2165 characters); canvas (headless Chromium, fitted): first render 15.70 ms, fitted: render med 0.50 p95 1.10 max 229.00 ms, sim 1 s med 0.10 ms;
- the all-examples test loops cost 1.49 CPU s for this example;
- first load leaves at minute 4.

**Verification run** (this tree):

```
[charging-corner] 56x30x2m, 4 stations, 6 vehicles, 130 road cells, schema 1
  validate: zero issues; errors 0; layout invariants []; fixed point true; json round trip true
  per-tick invariants over 1800 s: none violated (0.9 CPU s with the checker on)
  2 h seed 1: report sane (finite, shares sum to 1, percentiles ordered); 119 loads left the plant in 2 h (KPI window starts at 600 s: 113 counted, 61.6/h), deadlocks 0, stuck vehicles 0
  speed: 0.104 CPU s per simulated hour = 34658x real time (gate 500x, target 2000x)
  load: build layout + construct simulation + 60 s = 0.01 CPU s
```

```
charging-corner: 56x30 cells at 2 m (112 x 60 m), schema 1, calendar none, warm-up 600 s
   4 stations (0 with trucks), 2 flows, 1 fleets / 6 vehicles, 130 road cells, 0 obstacles, 3 labels, notes 855 chars
   validate: zero issues (errors, warnings and infos); invariants []; fixed point true
   share link: 2165 chars
   2 h seed 1 (own warm-up): window 1.8 h, 61.6 pallets/h (113 left), 119 loads left in 2 h, lead 4.1 min, WIP 4.2, traffic wait 4%, deadlocks 0, unplaced 0; 11423x
      fleets: E-forklifts x6 73% busy
      insights: [good] No bottlenecks, congestion or deadlocks found.
   8 h seed 1: 60.5 pallets/h, lead 8.6 min (p95 29.3), WIP 8.7, traffic wait 5%, deadlocks 0; 0.93 CPU s = 30876x
      fleets: E-forklifts x6 64% busy 16% chg
      insights: [good] No bottlenecks, congestion or deadlocks found.
```

Universal checks of the existing all-examples test loops (model.examples, sim.integration, sim.engine.routing, model.layout.grow), replayed by `sanity.mjs`: 12 of 12 checks ok.

**Risks and honest limits:**

- The first charge happens at about hour 2.7 (batteries start full and drain only while driving): a user who runs 2 h sees nothing. Notes and tip 1 say "run to hour 8" and describe hours 3 to 5; at 600x that is under a minute.
- The wave is a one-off: from hour 5 the lead time is back at 4 minutes and a 24 h run shows almost no charging effect (the scan of section 3.4 found no runtime / charge-time pair with a bounded, visible steady queue). Tip 3 (one charger) is the persistent case.
- The finding between hour 4 and 5 says "add 1 vehicle" and "Goods in delivers more than the plant takes", which is the wrong cure: the tip says so. There is no charger-queue finding (vehicles waiting for a charger count as parked); only the flat-battery tip has a finding (Battery, critical, 5 of 5 runs).
- The runtime of 3 h is shortened from real equipment (6 to 8 h) so that charging shows within one shift: the notes say "indicative values, shortened".
- Throughput hardly moves with battery edits (demand-limited, 60 pallets/h): the tests assert lead time and its tail, not pallets/h (the exceptions are ch1, charge120 and low0).

**Prototype:** `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/charging-corner.mjs` (exports `build()`, `variants`, `meta`, `glyph`).

### 6.3 `yard-shuttle`: Yard shuttle: one truck, 280 metres (level 2, rank 4)

- **Origin:** pedagogy (yard-shuttle); wider station boxes so the names fit, four labels, notes and tips rewritten after the reviews (units of the figures, the Checks warning, the name says 280 metres: measured 284 m loaded one way, 244 m back).
- **Card description (105 characters):** A truck carries pallets 280 m down a yard road and empties back. How long should it wait for a full load?
- **Learn line (card):** Over a distance the batch decides: capacity and maximum wait set how many trucks you need.
- **Chips (card):** yard truck · batching · return load
- **Story:** A packing hall at the north end of a yard sends one pallet every 2 minutes to a warehouse 280 m away, and the warehouse sends one empty pallet every 2 minutes back on the same road. One yard truck carries 8 per trip and leaves when it is full or when its oldest pallet has waited 15 minutes.
- **Teaches:** Batching over a distance: capacity, minimum batch and longest wait decide how many trucks you need and how long a pallet waits; a shorter wait is paid for in truck time; a loaded return leg; a shuttle on a long dead-end road. First example of a custom vehicle and of the batch fields of a flow, and the same idea as the yard trucks of the finale.
- **Features:** custom vehicle (capacity 8, 5 m/s, 3.5 m long on 4 m cells, 60 s load and unload); batchMin and maxWait on both flows; two flows in opposite directions on one road (a return load); a long dead-end yard road with four side bays of 2 to 3 cells; depot as parking.

**Notes text** (exact `layout.notes`, 724 characters; shown in the Properties tab > Plant > Notes and in the report):

> A packing hall at the north end of the yard sends one pallet every 2 minutes to a warehouse 280 metres down the road, and the warehouse sends one empty pallet every 2 minutes back along the same road. One yard truck (8 pallets, 5 m/s, a full minute to load and a full minute to unload) does all the carrying. It leaves only when it has a full load of 8, or when the oldest pallet has waited 15 minutes. Over a long distance a trip is expensive, so what the truck takes per trip, and how long it waits for more, decides how many trucks you need and how long a pallet stays in the yard. Press play, set the speed to 600×, open the Results tab after 8 hours and look at the truck: is it busy, or parked and waiting for a batch?

**Tips (exact strings of `tips`, 5):**

1. Press play and open the Results tab (at 600× the 8 hours take under a minute). 30 pallets/h go each way, 60 in all, and the Results tab finds nothing wrong. The truck waits for a full load of 8, so over several runs it is busy 52 % of the time and parked 45 %, makes 7.6 loaded trips an hour (3.8 round trips) and a pallet is in the yard for 11.4 minutes.
2. Try: set "Vehicles" of the fleet to 2 in the Fleet tab. The output stays at 60.4 pallets/h and the lead time at 10.9 minutes, and each truck is busy only 28 % of the time: the truck was not the limit, the batch was.
3. Try: set "Longest wait for a batch" of both flows to 300 s in the Flows tab. The lead time falls from 11.4 to 6.9 minutes (-39 %) at the same 60 pallets/h, but the truck is now busy 99 % of the time (17.4 loaded trips an hour, 8.7 round trips, instead of 7.6 and 3.8) and the finding says it is saturated: a shorter wait is paid for in truck time.
4. Try: set the truck "Capacity" to 4 in the Fleet tab. The Checks tab warns that a batch of 8 can never be ready ("at most 4 can ever be ready"): the truck simply leaves with 4. The output is still 60.1 pallets/h, the lead time is 7.6 minutes and the truck is busy 93 % of the time. With "Capacity" 1 it carries one pallet per trip, only 17.7 pallets/h (-71 %) get through and about 340 pallets are waiting after 8 hours.
5. Try: raise "Demand" in the Simulate tab to 2. The same truck carries 121 pallets/h and is busy 94 % of the time, and the lead time falls from 11.4 to 8.1 minutes: the batches fill twice as fast, so each trip is shared by more pallets.

**Layout:** 60 x 44 cells at 4 m (240 x 176 m), schema 1, no clock (stationary plant), warm-up 600 s, 84 road cells, 4 labels ("Packing hall A", "Warehouse B", "The yard road, 280 m", "One truck, 8 pallets"), 5 stations (0 with trucks), 2 flows, 1 fleet / 1 vehicle. Reference hash `b701224c8d218ad2c2c6358d25a831df01a02217`.

Sketch (letters = stations, `.` two-way road, arrows one-way, `~` slow zone; one character = 1 x 1 cells):

```
     KKKKKKKK  PPP
     KKKKKKKK  PPP
       .        .
       .        .
    .............................................
            .                                   .
          EEEEEEEEE                             .
          EEEEEEEEE                             .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                                .
                                     eeeeeeeee  .
                                     eeeeeeeee...
                                                .
                                                .
                                                .  WWWWWWWW
                                                ...WWWWWWWW
                                                .
                                                .
                                                .
                                                .
```

Legend: K Packing A; E Empties store A; W Warehouse B; e Empties B; P Yard park.

| Station | Type | Cell (x, y) | Size | Parameters | Trucks and doors |
|---|---|---|---|---|---|
| Packing A | source | 5, 4 | 8 x 2 | arrival n(120 ±15 %), out buffer 16 |  |
| Empties store A | sink | 10, 10 | 9 x 2 |  |  |
| Warehouse B | sink | 51, 33 | 8 x 2 |  |  |
| Empties B | source | 37, 29 | 9 x 2 | arrival n(120 ±15 %), out buffer 16 |  |
| Yard park | depot | 15, 4 | 3 x 2 | slots 3, chargers 0 |  |

| Fleet | Preset | Count | Capacity | Speed (m/s) | Length (m) | Load / unload (s) | Battery | Home |
|---|---|---|---|---|---|---|---|---|
| Yard truck | custom | 1 | 8 | 5 | 3.5 | 60 / 60 | off | Yard park |

| Flow | Fleet | Weight | Per cycle | Batch min / max wait | Priority |
|---|---|---|---|---|---|
| Packing A -> Warehouse B | any | 1 | 1 | 8 / 900 s | 1 |
| Empties B -> Empties store A | any | 1 | 1 | 8 / 900 s | 1 |

**Test claims** (seeds 1 to 5, 8 h unless the row says hour 24; mean [min .. max]; `results/ship/yard-a.json`, regenerated by `meas2.mjs`). The last column is the figure as printed in the tip; `check-claims.mjs` verified every row against the tip text.

| Tip | Variant | Metric | Measured mean [min .. max] | In the tip |
|---|---|---|---|---|
| 1 | base | pallets/h (both directions) (`thr`) | 60.3 [59.5 .. 61.1] | 60 |
| 1 | base | truck busy % (`Yardtruck_util`) | 51.9 [49.4 .. 53.9] | 52 |
| 1 | base | truck parked % (`Yardtruck_park`) | 45.2 [43.2 .. 48.0] | 45 |
| 1 | base | loaded trips per hour (`Yardtruck_trips`) | 7.6 [7.5 .. 7.7] | 7.6 |
| 1 | base | lead time, min (`leadMean`) | 11.4 [11.0 .. 11.5] | 11.4 |
| 2 | two | pallets/h (`thr`) | 60.4 [60.0 .. 60.9] | 60.4 |
| 2 | two | lead time, min (`leadMean`) | 10.9 [10.8 .. 11.0] | 10.9 |
| 2 | two | truck busy % (`Yardtruck_util`) | 28.2 [27.9 .. 28.4] | 28 |
| 3 | wait300 | lead time, min (`leadMean`) | 6.9 [6.8 .. 6.9] | 6.9 |
| 3 | wait300 against base | lead time change % (`leadMean`) | -39 % | -39 % |
| 3 | wait300 | truck busy % (`Yardtruck_util`) | 99.4 [99.2 .. 99.5] | 99 |
| 3 | wait300 | loaded trips per hour (`Yardtruck_trips`) | 17.4 [17.4 .. 17.5] | 17.4 |
| 4 | cap4 | pallets/h (`thr`) | 60.1 [59.7 .. 60.8] | 60.1 |
| 4 | cap4 | lead time, min (`leadMean`) | 7.6 [7.5 .. 7.8] | 7.6 |
| 4 | cap4 | truck busy % (`Yardtruck_util`) | 93.0 [91.0 .. 94.9] | 93 |
| 4 | cap1 | pallets/h (capacity 1) (`thr`) | 17.7 [17.7 .. 17.7] | 17.7 |
| 4 | cap1 against base | output change % (`thr`) | -71 % | -71 % |
| 4 | cap1 | pallets in the plant at the end (capacity 1) (`wipNow`) | 339 [335 .. 344] | 340 |
| 5 | d2 | pallets/h (`thr`) | 121 [121 .. 122] | 121 |
| 5 | d2 | truck busy % (`Yardtruck_util`) | 93.6 [92.0 .. 95.1] | 94 |
| 5 | d2 | lead time, min (`leadMean`) | 8.1 [8.0 .. 8.3] | 8.1 |

**Findings claims** (the Results tab, number of the 5 runs of 8 h in which the finding appears):

- base: no finding except "No bottlenecks, congestion or deadlocks found" in 5 of 5 runs.
- two: no finding except "No bottlenecks, congestion or deadlocks found" in 5 of 5 runs.
- tip 3, wait300: longest wait 300 s: the fleet finding is critical (fleet saturated): 5 of 5 runs (severity critical).
- tip 4, cap4: capacity 4: the fleet finding is a warning (saturated): 5 of 5 runs (severity warning).

**Variant edits** (plain mutator calls, exactly what the tips describe; the claims table names the variants):

```js
two: (l) => L.updateFleet(l, l.fleets[0].id, { count: 2 })
wait300: (l) => { for (const f of l.flows) L.updateFlow(l, f.id, { maxWait: 300 }); }
cap4: (l) => L.updateFleet(l, l.fleets[0].id, { capacity: 4 })
cap1: (l) => L.updateFleet(l, l.fleets[0].id, { capacity: 1 })
d2: (l) => L.updateSettings(l, { demandFactor: 2 })
```

**Expected validation result:** zero issues of any severity for the example and for every variant above except `cap4` and `cap1` (two `batch-exceeds-capacity` warnings each: a minimum batch of 8 against a truck of 4 or 1).

**Performance budget:**

- speed 154,162x real time (gate 500x, target 2000x); CPU per 8 h run 0.21 s (seed 1); builder 0.3 ms warm;
- share link 1.9 KB (1922 characters); canvas (headless Chromium, fitted): first render 22.30 ms, fitted: render med 0.10 p95 0.40 max 1.00 ms, sim 1 s med 0.00 ms;
- the all-examples test loops cost 0.68 CPU s for this example;
- first load leaves at minute 17.

**Verification run** (this tree):

```
[yard-shuttle] 60x44x4m, 5 stations, 1 vehicles, 84 road cells, schema 1
  validate: zero issues; errors 0; layout invariants []; fixed point true; json round trip true
  per-tick invariants over 1800 s: none violated (0.7 CPU s with the checker on)
  2 h seed 1: report sane (finite, shares sum to 1, percentiles ordered); 112 loads left the plant in 2 h (KPI window starts at 600 s: 112 counted, 61.1/h), deadlocks 0, stuck vehicles 0
  speed: 0.023 CPU s per simulated hour = 154162x real time (gate 500x, target 2000x)
  load: build layout + construct simulation + 60 s = 0.00 CPU s
```

```
yard-shuttle: 60x44 cells at 4 m (240 x 176 m), schema 1, calendar none, warm-up 600 s
   5 stations (0 with trucks), 2 flows, 1 fleets / 1 vehicles, 84 road cells, 0 obstacles, 4 labels, notes 724 chars
   validate: zero issues (errors, warnings and infos); invariants []; fixed point true
   share link: 1922 chars
   2 h seed 1 (own warm-up): window 1.8 h, 61.1 pallets/h (112 left), 112 loads left in 2 h, lead 11.8 min, WIP 11.9, traffic wait 0%, deadlocks 0, unplaced 0; 33690x
      fleets: Yard truck x1 49% busy
      insights: [good] No bottlenecks, congestion or deadlocks found.
   8 h seed 1: 61.1 pallets/h, lead 11.4 min (p95 18.8), WIP 11.6, traffic wait 0%, deadlocks 0; 0.21 CPU s = 134786x
      fleets: Yard truck x1 51% busy
      insights: [good] No bottlenecks, congestion or deadlocks found.
```

Universal checks of the existing all-examples test loops (model.examples, sim.integration, sim.engine.routing, model.layout.grow), replayed by `sanity.mjs`: 12 of 12 checks ok.

**Risks and honest limits:**

- Throughput is insensitive to almost every edit (the plant is demand-limited): the lessons are the lead time and the truck utilisation, and the tests assert those.
- The Results tab says "fleet saturated" for the truck at a longest wait of 5 minutes, capacity 4 and the demand tip although the truck is only out of spare time, not out of capacity: the tips explain it ("a shorter wait is paid for in truck time").
- The second critic checked the Checks tab on the capacity variants: two batch-exceeds-capacity warnings (a batch of 8 against a truck of 4 or 1); the truck simply leaves with what fits (capacity 4 with a minimum batch of 4 gives the same numbers).
- A designer reported resolved deadlocks in 3 of 5 seeds for bays shorter than 3 cells in an earlier draft (not re-run); the bays of this plant (1 to 2 cells off the road) ran with 0 deadlocks in 40 runs of 8 h: do not shorten them.
- Plain picture (a long L-shaped road): the example is a number lesson, not a showpiece; the labels carry the story.

**Prototype:** `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/yard-shuttle.mjs` (exports `build()`, `variants`, `meta`, `glyph`).

### 6.4 `morning-peak`: Morning peak: a cross-dock on appointments (level 4, rank 9)

- **Origin:** realism (cross-dock), renamed to morning-peak, stations renamed short (Suppliers, Returns, Stores west/east, Express) and widened so the names fit, labels; notes and tips rewritten after the reviews (14:00, order of the tips, no pallets/h headline).
- **Card description (123 characters):** A grocery cross-dock on a timetable: 22 supplier trucks, a peak from 08:00 to 10:00, eight forklifts. Size it for the peak.
- **Learn line (card):** Size doors and forklifts for the peak hour, not the average: a better timetable is a lever too.
- **Chips (card):** day plant (clock) · timetables · 2 goods in, 3 goods out · one-way ring
- **Story:** A grocery cross-dock on a morning timetable: 22 supplier trucks have appointments from 06:00 to 11:00 with a peak of 6 an hour between 08:00 and 10:00, the pallets rest in staging lanes and leave on route trucks (two docks, a truck every 15 minutes) and an express truck, and eight forklifts do all the carrying on a one-way ring.
- **Teaches:** The day has a shape: doors and forklifts are sized for the peak hour, not the average, and four different levers (a better timetable, more forklifts, more doors, shorter trips) move four different numbers. Reading a timetable-driven plant: gate queue, door time, route trucks that leave short, the door check at the busiest hour, a pull destination (a Goods out only fetches pallets when a truck is ready), a day clock, a one-way ring as calm circulation that costs distance. The doors-against-forklifts point is the one it shares with Warehouse: first day; what it adds is the time of day.
- **Features:** trucks in schedule mode (22 rows, jitter, no-shows) next to rate mode (returns); a day plant with a clock (layout.calendar, schema 2), starting 06:00; 2 goods in and 3 goods out; outbound timetables with max dwell and staging: trucks that leave short; flow priority 3 on the express flow (no measurable effect, kept as data); a one-way ring with two-way spurs; six docks and six doors at the supplier gate; the door check at the busiest hour of a timetable ("doors too few", 4.8 needed).

**Notes text** (exact `layout.notes`, 971 characters; shown in the Properties tab > Plant > Notes and in the report):

> A cross-dock of a grocery chain, on a day clock that starts at 06:00. 22 supplier trucks have appointments between 06:00 and 11:00, with a peak of 6 an hour between 08:00 and 10:00; a returns truck comes about once an hour. The pallets rest in the staging lanes and leave on route trucks (two gates of two doors each, a truck about every 15 minutes in all, each leaving after 40 minutes at the latest with whatever it has) and on an express truck. Eight forklifts do all the carrying; the ring road is one-way, so they never meet head-on. The average hour is easy, the peak hour is not: set the speed to 600×, run the clock to 14:00 (8 hours; the queue of the peak shows from about noon, because a wait is booked when a truck reaches a door) and open the Results tab. Every edit restarts the day at 06:00, so run to 14:00 again before you read the numbers. (Times and truck sizes are indicative. Paste your own timetable into Suppliers, Properties tab, Trucks and doors.)

**Tips (exact strings of `tips`, 6):**

1. Press play, set the speed to 600× and let the clock (in the sim bar) run to 14:00, then open the Results tab. At 10:00 it still looks quiet: a truck's wait is booked when it reaches a door, so the queue of the peak shows from about noon. Over several runs trucks wait 19 minutes on average at the supplier gate (the worst about 76 minutes, 4 to 5 trucks standing at once), hold a door for 78 minutes, the eight forklifts are busy 88 % of the time and 95 % of the pallets are through within 168 minutes. The findings say it is not the doors, it is the forklifts, as in Warehouse: first day; what this plant adds is the time of day.
2. Try: replace the timetable of Suppliers by one truck every 15 minutes from 06:00 to 11:15 (Properties tab, Trucks and doors, Paste) and run to 14:00 again: the same 22 trucks. The gate wait falls from 19 to 8 minutes (-58 %), the worst from 76 to 42 minutes and the time within which 95 % of the pallets are through from 168 to 153 minutes, with the same forklifts. A better timetable does for the slowest pallets what two more forklifts do.
3. Try: cut the forklifts to 6. The pallets for the route trucks arrive late, so trucks leave short and the output falls (58 against 69 pallets/h, -16 %): about 13 of the 28 route and express trucks leave without a full load (on average 5.4 of the west trucks, 4.8 of the east trucks and 2.8 of the express trucks), and the gate wait is 39 minutes (the worst 130).
4. Try: raise the forklifts to 10 in the Fleet tab. The gate wait disappears (0.6 minutes, worst 6) and a truck holds its door for 53 instead of 78 minutes, but the forklifts are busy only 78 % of the time and waiting in traffic grows from 6.4 % to 9.6 %: capacity for the peak stands idle for the rest of the day.
5. Try: make the ring two-way (draw over it with the Road tool). Trips get shorter: the gate queue is gone, a truck holds its door for 30 minutes and the forklifts are busy 69 % of the time, but they now wait in traffic 20 % of the time (6 % before) and the Traffic finding appears. A one-way ring costs distance, a two-way ring costs meetings.
6. Try: set the doors of Suppliers to 4. The Checks tab says "doors too few" (4.8 doors are needed at the busiest hour of the timetable). The gate wait doubles to 38 minutes (the worst 109, 6 to 7 trucks queue) and a truck holds its door for 61 instead of 78 minutes, yet the same 69 pallets/h leave: fewer doors only move the queue from the doors to the gate.

**Layout:** 60 x 44 cells at 3 m (180 x 132 m), schema 2, day clock from 06:00 on Monday, warm-up 600 s, 238 road cells, 4 labels ("Supplier gate", "Route trucks", "One-way ring", "Express"), 7 stations (5 with trucks), 5 flows, 1 fleet / 8 vehicles. Reference hash `7bb8ac64feacf545db8b12a48f11c01af12091c1`.

Sketch (letters = stations, `.` two-way road, arrows one-way, `~` slow zone; one character = 2 x 2 cells):

```
       IIIIIII       RR
       IIIIIII       RR
       ......         .
  >>>>>>>>>>>>>>>>>>>>>>>>>v
  ^       . . . . .        v
  ^     LLLLLLLLLLLL       v
  ^     LLLLLLLLLLLL       v
  ^     LLLLLLLLLLLL       v
  ^PP   LLLLLLLLLLLL       v
  ^     LLLLLLLLLLLL       v
  ^     LLLLLLLLLLLL       v
  ^     LLLLLLLLLLLL       v
  ^     . .   . . .        v
  ^     . .   . . .        v
  ^<<<<<<<<<<<<<<<<<<<<<<<<<
     . .     . .      ..
    WWWWW   EEEEE    XXXX
    WWWWW   EEEEE    XXXX
```

Legend: I Suppliers; R Returns; L Staging lanes; W Stores west; E Stores east; X Express; P Forklift park.

| Station | Type | Cell (x, y) | Size | Parameters | Trucks and doors |
|---|---|---|---|---|---|
| Suppliers | source | 14, 5 | 13 x 2 | arrival n(120 ±10 %), out buffer 10 | 6 doors, timetable of 22 rows (06:00 to 11:00), pallets u(24 ±25 %), check-in/out 420/300 s, max dwell 60 min, staging 4, jitter 10 min, no-show 3 % |
| Returns | source | 43, 5 | 3 x 2 | arrival n(120 ±10 %), out buffer 8 | 1 door, a truck every n(3600 ±30 %) s, pallets u(8 ±40 %), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| Staging lanes | storage | 17, 15 | 23 x 12 | capacity 200, dwell 240 s |  |
| Stores west | sink | 9, 37 | 9 x 2 |  | 2 doors, timetable of 11 rows (07:30 to 12:30), pallets u(24 ±25 %), check-in/out 300/300 s, max dwell 40 min, staging 4 |
| Stores east | sink | 25, 37 | 9 x 2 |  | 2 doors, timetable of 11 rows (07:45 to 12:45), pallets u(24 ±25 %), check-in/out 300/300 s, max dwell 40 min, staging 4 |
| Express | sink | 43, 37 | 7 x 2 |  | 1 door, timetable of 6 rows (06:40 to 12:30), pallets u(24 ±25 %), check-in/out 180/180 s, max dwell 30 min, staging 4 |
| Forklift park | depot | 7, 20 | 3 x 2 | slots 10, chargers 0 |  |

| Fleet | Preset | Count | Capacity | Speed (m/s) | Length (m) | Load / unload (s) | Battery | Home |
|---|---|---|---|---|---|---|---|---|
| Forklifts | forklift | 8 | 1 | 3 | 2.6 | 20 / 20 | off | Forklift park |

| Flow | Fleet | Weight | Per cycle | Batch min / max wait | Priority |
|---|---|---|---|---|---|
| Suppliers -> Staging lanes | any | 1 | 1 | - | 1 |
| Returns -> Staging lanes | any | 1 | 1 | - | 1 |
| Staging lanes -> Stores west | any | 4 | 1 | - | 1 |
| Staging lanes -> Stores east | any | 4 | 1 | - | 1 |
| Staging lanes -> Express | any | 1.2 | 1 | - | 3 |

**Test claims** (seeds 1 to 5, 8 h unless the row says hour 24; mean [min .. max]; `results/ship/morning-t.json`, regenerated by `meas2.mjs`). The last column is the figure as printed in the tip; `check-claims.mjs` verified every row against the tip text.

| Tip | Variant | Metric | Measured mean [min .. max] | In the tip |
|---|---|---|---|---|
| 1 | base | gate wait, min (`Suppliers_gate`) | 19.4 [15.0 .. 24.8] | 19 |
| 1 | base | worst gate wait, min (`Suppliers_gmax`) | 76.2 [62.3 .. 89.4] | 76 |
| 1 | base | trucks at the gate at once (max) (`Suppliers_gq`) | 4.6 [4.0 .. 5.0] | 4 to 5 |
| 1 | base | door time, min (`Suppliers_door`) | 78.4 [75.3 .. 81.1] | 78 |
| 1 | base | forklifts busy % (`Forklifts_util`) | 87.7 [86.1 .. 89.5] | 88 |
| 1 | base | lead time p95, min (`leadP95`) | 168 [153 .. 182] | 168 |
| 2 | flat | gate wait, min (`Suppliers_gate`) | 8.2 [3.3 .. 13.0] | 8 |
| 2 | flat against base | gate wait change % (`Suppliers_gate`) | -58 % | -58 % |
| 2 | flat | worst gate wait, min (`Suppliers_gmax`) | 42.0 [18.9 .. 63.0] | 42 |
| 2 | flat | lead time p95, min (`leadP95`) | 153 [148 .. 159] | 153 |
| 3 | f6 | pallets/h (6 forklifts) (`thr`) | 58.0 [56.6 .. 59.7] | 58 |
| 3 | base | pallets/h (`thr`) | 69.2 [69.1 .. 69.3] | 69 |
| 3 | f6 against base | output change % (`thr`) | -16 % | -16 % |
| 3 | f6 | west trucks that left short (`Storeswest_short`) | 5.4 [5.0 .. 6.0] | 5.4 |
| 3 | f6 | east trucks that left short (`Storeseast_short`) | 4.8 [4.0 .. 5.0] | 4.8 |
| 3 | f6 | express trucks that left short (`Express_short`) | 2.8 [2.0 .. 3.0] | 2.8 |
| 3 | f6 | gate wait, min (`Suppliers_gate`) | 39.0 [30.1 .. 49.2] | 39 |
| 3 | f6 | worst gate wait, min (`Suppliers_gmax`) | 130 [102 .. 153] | 130 |
| 4 | f10 | gate wait, min (`Suppliers_gate`) | 0.6 [0.0 .. 1.5] | 0.6 |
| 4 | f10 | worst gate wait, min (`Suppliers_gmax`) | 6.1 [0.0 .. 12.5] | 6 |
| 4 | f10 | door time, min (`Suppliers_door`) | 53.4 [47.4 .. 56.4] | 53 |
| 4 | f10 | forklifts busy % (`Forklifts_util`) | 78.2 [76.8 .. 79.2] | 78 |
| 4 | base | waiting in traffic % (`wait`) | 6.4 [6.2 .. 6.8] | 6.4 |
| 4 | f10 | waiting in traffic % (`wait`) | 9.6 [9.0 .. 10.0] | 9.6 |
| 5 | twoWay | door time, min (`Suppliers_door`) | 29.7 [27.6 .. 31.9] | 30 |
| 5 | twoWay | forklifts busy % (`Forklifts_util`) | 68.8 [67.6 .. 70.4] | 69 |
| 5 | twoWay | waiting in traffic % (`wait`) | 20.1 [19.6 .. 20.7] | 20 |
| 5 | base | waiting in traffic % (`wait`) | 6.4 [6.2 .. 6.8] | 6 |
| 6 | doors4 | gate wait, min (`Suppliers_gate`) | 37.5 [32.0 .. 43.7] | 38 |
| 6 | doors4 | worst gate wait, min (`Suppliers_gmax`) | 109 [91.0 .. 124] | 109 |
| 6 | doors4 | trucks at the gate at once (max) (`Suppliers_gq`) | 6.6 [6.0 .. 7.0] | 6 to 7 |
| 6 | doors4 | door time, min (`Suppliers_door`) | 61.1 [59.2 .. 63.5] | 61 |
| 6 | doors4 | pallets/h (`thr`) | 69.2 [69.1 .. 69.3] | 69 |

**Findings claims** (the Results tab, number of the 5 runs of 8 h in which the finding appears):

- tip 1, base: the findings say it is the forklifts: fleet saturated: 5 of 5 runs.
- tip 1, base: the findings say the doors are not the problem: unload limited by vehicles at Suppliers: 5 of 5 runs.
- tip 1, base: gate queue long at Suppliers: 5 of 5 runs.
- tip 5, twoWay: two-way ring: the Traffic finding appears: 5 of 5 runs.
- tip 3, f6: six forklifts: outbound trucks leave short at the west, east and express gates: 5 of 5 runs.

**The same run read at four moments of the clock** (seeds 1 to 5, base, cumulative figures; `results/ship/morning-t.json`): 10:00 (4 h): gate wait 0.5 min, worst 7 min, door time 30 min; 12:00 (6 h): gate wait 18.9 min, worst 76 min, door time 69 min; 13:00 (7 h): gate wait 19.4 min, worst 76 min, door time 76 min; 14:00 (8 h): gate wait 19.4 min, worst 76 min, door time 78 min. A wait is booked when a truck reaches a door, so the queue of the peak is not in the figures at 10:00.


**Variant edits** (plain mutator calls, exactly what the tips describe; the claims table names the variants):

```js
flat: (l) => updateStation(l, byName(l, 'Suppliers').id, { ops: { trucks: { schedule: flatRows() } } })
f6: (l) => updateFleet(l, fl(l), { count: 6 })
f10: (l) => updateFleet(l, fl(l), { count: 10 })
twoWay: (l) => { paintRoadPath(l, [[4, 10], [55, 10], [55, 32], [4, 32], [4, 10]], { oneWay: false }); }
doors4: (l) => updateStation(l, byName(l, 'Suppliers').id, { ops: { trucks: { doors: 4 } } })
```

The edits use `fl(l)` = `l.fleets[0].id`, `byName(l, name)` = the station of that name and `flatRows()` = 22 rows `{ at: hhmm(6, 0) + i * 900, pallets: null }` (`hhmm(h, m)` = h * 3600 + m * 60).

**The cells of the road edit** `twoWay`: `paintRoadPath` over the ring (4,10) (55,10) (55,32) (4,32) (4,10) with `oneWay: false` (draw over the whole ring with the Road tool).

**Expected validation result:** zero issues of any severity for the example and for every variant above except `doors4` (one `doors-too-few` warning: 4.8 doors are needed at the busiest hour, the check of the Checks tab).

**Performance budget:**

- speed 30,414x real time (gate 500x, target 2000x); CPU per 8 h run 1.28 s (seed 1); builder 0.8 ms warm;
- share link 3.2 KB (3313 characters); canvas (headless Chromium, fitted): first render 18.50 ms, fitted: render med 0.20 p95 0.50 max 187.70 ms, sim 1 s med 0.00 ms;
- the all-examples test loops cost 2.23 CPU s for this example;
- first load leaves at minute 43.

**Verification run** (this tree):

```
[morning-peak] 60x44x3m, 7 stations, 8 vehicles, 238 road cells, schema 2
  validate: zero issues; errors 0; layout invariants []; fixed point true; json round trip true
  per-tick invariants over 1800 s: none violated (2.0 CPU s with the checker on)
  2 h seed 1: report sane (finite, shares sum to 1, percentiles ordered); 27 loads left the plant in 2 h (KPI window starts at 600 s: 27 counted, 14.7/h), deadlocks 0, stuck vehicles 0
  speed: 0.118 CPU s per simulated hour = 30414x real time (gate 500x, target 2000x)
  load: build layout + construct simulation + 60 s = 0.01 CPU s
```

```
morning-peak: 60x44 cells at 3 m (180 x 132 m), schema 2, calendar {"startTod":21600,"startDay":0}, warm-up 600 s
   7 stations (5 with trucks), 5 flows, 1 fleets / 8 vehicles, 238 road cells, 0 obstacles, 4 labels, notes 971 chars
   validate: zero issues (errors, warnings and infos); invariants []; fixed point true
   share link: 3313 chars
   2 h seed 1 (own warm-up): window 1.8 h, 14.7 pallets/h (27 left), 27 loads left in 2 h, lead 91.0 min, WIP 88.2, traffic wait 9%, deadlocks 0, unplaced 0; 9821x
      fleets: Forklifts x8 77% busy
      insights: [warning] Forklifts fleet is saturated: its 8 vehicles are busy 77 % of the time, and loads wait 3.9 min for a pickup. | [info] Suppliers has 6 doors, but they are busy only 20 % of the time.
   8 h seed 1: 69.3 pallets/h, lead 110.2 min (p95 152.8), WIP 131.4, traffic wait 6%, deadlocks 0; 1.28 CPU s = 22545x
      fleets: Forklifts x8 86% busy
      insights: [warning] Forklifts fleet is saturated: its 8 vehicles are busy 86 % of the time, and loads wait 7.8 min for a pickup. | [warning] The doors of Suppliers are not the problem, the vehicles are: pallets are taken away too slowly. | [warning] Trucks wait 15 min at the gate of Suppliers on average.
```

Universal checks of the existing all-examples test loops (model.examples, sim.integration, sim.engine.routing, model.layout.grow), replayed by `sanity.mjs`: 12 of 12 checks ok.

**Risks and honest limits:**

- A day plant: every edit restarts cold from 06:00 (decision 3 of docs/WAREHOUSE-DESIGN.md section 12): the user loses the running figures after a change; the impact card does not apply. Notes and tips say "run to 14:00 again".
- Jitter and no-shows make truck counts vary by seed; the tips quote means over 5 seeds with "about" and the claims table has bands.
- The 3-pallet express van at 06:40 exists so that goods leave within the first hour (the first load leaves at minute 43); it reads as a real first express run.
- The Results tab lists "fleet saturated", "unload limited by vehicles" and "gate queue long" at base (5 of 5 seeds): the first two say it is the forklifts, not the doors, which is the story; an info "doors idle" on one outbound gate is truthful (the door check assumes 90 s per pallet and needs those doors on paper).
- The one-way ring makes trips long (18 trips per forklift and hour): tip 5 shows that a two-way ring removes the gate queue and triples the waiting in traffic; that trade-off is deliberate.
- Why not `cross-dock`: that id (and `dc-two-shifts`) is reserved by docs/WAREHOUSE-DESIGN.md 8.1 for M2.

**Prototype:** `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/morning-peak.mjs` (exports `build()`, `variants`, `meta`, `glyph`).

### 6.5 `components-plant`: Components plant: one hall, three kinds of vehicle (level 4, rank 10)

- **Origin:** pedagogy (components-plant): ring made two-way, depot slots raised to the fleets, labels, trimGrid; after the reviews: the trucks on a fixed rhythm (constant gaps and pallets, balanced to the 19.4 pallets/h the outbound trucks ask for), tips rewritten on stable metrics and on edits the user can make.
- **Card description (120 characters):** A whole plant under one roof: press, weld, paint, assembly, three kinds of vehicle. Find the bottleneck, then the roads.
- **Learn line (card):** Reading a whole plant: which station limits it, which vehicle does which job, and which roads earn their keep.
- **Chips (card):** warm-up 2 h · forklifts, AGVs, tuggers · bill of materials · breakdowns · slow zone
- **Story:** A components plant under one roof: steel and parts come in at the west gates, run through press, weld, paint, assembly and packing and leave as finished goods or spares. Forklifts do the gates, AGVs the line, tugger trains the kits; the roads are a two-way ring with a slow zone on its west side, a mid street and a cross aisle.
- **Teaches:** Reading a whole plant: which station limits it (the paint shop, one machine that breaks down), what happens when demand rises and when the bottleneck is doubled (the next one shows: the press line), a bill of materials (the weld cell needs 2 pressed parts and a kit per cycle, assembly a frame and 2 kits), parallel machines with machines:n, which road earns its keep (mid street: yes; cross aisle: hardly), what a slow zone costs, and three fleets with fleet-restricted flows.
- **Features:** bill of materials: several incoming flows with perCycle on one process (weld cell, assembly); machines:n parallel machines (weld, assembly) and outPerCycle 2 (press); breakdowns (paint shop mtbf 3 h, mttr 12 min); three fleets (8 forklifts of capacity 2 with batteries, 10 AGVs with batteries, 4 tugger trains) with fleet-restricted flows; a slow zone (0.7) along 25 cells of the ring; second docks from the mid street, side bays; trucks in rate mode with constant gaps and pallets, pull-based outbound trucks with staging and max dwell; warm-up 7200 s (the line is two hours deep); depots with chargers (3 + 4) shared by whoever needs them.

**Notes text** (exact `layout.notes`, 913 characters; shown in the Properties tab > Plant > Notes and in the report):

> A components plant under one roof. Steel and parts arrive at the west gates; forklifts take them to the coil store and the supermarket. Steel runs through the press line, weld cell and paint shop to the frame buffer, assembly, packing and the finished goods store on AGVs; tugger trains bring the kits (the weld cell needs 2 pressed parts and 1 kit per cycle, assembly 1 frame and 2 kits) and forklifts load the trucks. The one machine of the paint shop breaks down about every 3 hours. The roads are a two-way ring with a slow zone on its west side, a mid street and a cross aisle. The trucks come on a fixed rhythm, so the plant settles instead of drifting. The line is two hours deep: the first two hours are warm-up. Set the speed to 600× and run to hour 8. Find what limits the plant, then which roads you could do without. Every edit starts the run again, so run to hour 8 again before you read the numbers.

**Tips (exact strings of `tips`, 5):**

1. Press play, set the speed to 600×, wait out the warm-up (two plant hours, the sim bar says "Warming up") and run to hour 8, then open the Results tab. Over several runs the plant delivers 19.3 pallets/h. The Paint shop, one machine that breaks down about every 3 hours, is the busiest station (85 % busy; the findings call it the bottleneck in 3 of 5 runs) and assembly waits for input 47 % of the time. Forklifts, AGVs and tugger trains are busy 44 %, 50 % and 52 % of the time and the vehicles spend 9 % of their driving time waiting in traffic.
2. Try: raise "Demand" in the Simulate tab to 1.2. The paint shop is now flat out (93 % busy, the bottleneck finding is critical in 5 of 5 runs), trucks begin to leave short, and the output rises by only 7 % (20.6 pallets/h, between 18.7 and 22.3 from run to run). Then set "Machines in parallel" of the Paint shop to 2 (Properties tab): the output is 23.0 pallets/h (+19 % against the start), the paint shop falls to 52 % and the Press line (90 % busy, against 74 % at the start) is the next one to limit the plant (the findings name it in 2 of 5 runs).
3. Try: erase the mid street (Eraser tool along the two-way street between the two bands, from just inside the west side of the ring to just inside the east side). The output does not change, but the vehicles lose their short cuts: forklifts go from 44 % to 63 % busy, tugger trains from 52 % to 79 %, and the share of driving time spent waiting in traffic grows from 9 % to 26 % (the Traffic finding turns critical).
4. Try: erase the cross aisle instead (the street that runs north to south between Press line and Weld cell; take it out in two strokes and leave the cell where it crosses the mid street). Hardly anything changes: forklifts 45 % busy instead of 44 %, waiting in traffic 10 % instead of 9 %. Not every road earns its keep; but take the crossing cell as well and the mid street is cut in two (forklifts 54 % busy, waiting 16 %).
5. Try: take the speed limit off the west side of the ring (Slow zone tool, hold Alt and drag along it). The forklifts are busy 40 % of the time instead of 44 % and waiting in traffic falls from 9.3 % to 8.0 %: a 0.7 zone along 25 cells costs the forklifts about 4 points of time.

**Layout:** 79 x 42 cells at 2 m (158 x 84 m), schema 2, no clock (stationary plant), warm-up 7200 s, 345 road cells, 4 labels ("Receiving", "Press, weld, paint", "Mid street", "Assembly, packing, shipping"), 16 stations (4 with trucks), 13 flows, 3 fleets / 22 vehicles. Reference hash `ec4a763733a7ca64ec39e9996596c175d4c7534b`.

Sketch (letters = stations, `.` two-way road, arrows one-way, `~` slow zone; one character = 2 x 2 cells):

```
      ~...........................
  GGG.~ . .   . ..   ..    . .   .
  GGG.~CCCC  RRRR.  WWWW  TTTTT  . QQQ
  GGG ~CCCC  RRRR.  WWWW  TTTTT  ..QQQ
  PPPP~CCCC  RRRR.  WWWW  TTTTT  . QQQ
  PPPP~  .     . .   .      .    .
   UUU~...........................
   UUU~   .    . . .     .    .  .
  ggg ~  SSS FFFF.KKK  AAAA BBBB .
  ggg.~  SSS FFFF.KKK  AAAA BBBB .
  ggg.~  SSS FFFF.KKK  AAAA BBBB .
  ggg.~  SSS FFFF.KKK  AAAA BBBB .
  OOO.~   ..  . .. .    . .  . . .
  OOO.............................
       .
       oo
       oo
```

Legend: G Steel gate; g Parts gate; O Customer gate; o Spares gate; C Coil store; R Press line; W Weld cell; T Paint shop; B Frame buffer; A Assembly; K Packing; F FG store; S Parts supermarket; P Forklift park; Q AGV charging; U Tugger park.

| Station | Type | Cell (x, y) | Size | Parameters | Trucks and doors |
|---|---|---|---|---|---|
| Steel gate | source | 4, 8 | 6 x 6 | arrival n(120 ±10 %), out buffer 8, first at 60 s | 2 doors, a truck every c(4440) s, pallets c(24), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| Parts gate | source | 4, 23 | 6 x 6 | arrival n(120 ±10 %), out buffer 8, first at 120 s | 3 doors, a truck every c(1480) s, pallets c(24), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| Customer gate | sink | 4, 30 | 6 x 3 |  | 2 doors, a truck every c(3000) s, pallets c(12), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| Spares gate | sink | 14, 36 | 4 x 3 |  | 1 door, a truck every c(7200) s, pallets c(10), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| Coil store | storage | 15, 10 | 7 x 6 | capacity 120, dwell 120 s |  |
| Press line | process | 27, 10 | 6 x 6 | cycle n(140 ±10 %), machines 1, 2 out per cycle, in 6, out 8 |  |
| Weld cell | process | 40, 10 | 7 x 6 | cycle n(200 ±10 %), machines 2, in 6, out 4 |  |
| Paint shop | process | 53, 10 | 8 x 6 | cycle n(160 ±10 %), machines 1, in 6, out 6, mtbf 3 h, mttr 12 min |  |
| Frame buffer | storage | 57, 23 | 6 x 6 | capacity 30, dwell 0 s |  |
| Assembly | process | 46, 23 | 8 x 6 | cycle n(200 ±10 %), machines 2, in 6, out 4 |  |
| Packing | process | 36, 23 | 6 x 6 | cycle n(90 ±10 %), machines 1, in 6, out 6 |  |
| FG store | storage | 27, 23 | 6 x 6 | capacity 150, dwell 60 s |  |
| Parts supermarket | storage | 18, 23 | 6 x 6 | capacity 200, dwell 60 s |  |
| Forklift park | depot | 5, 15 | 6 x 3 | slots 8, chargers 3 |  |
| AGV charging | depot | 70, 11 | 6 x 4 | slots 12, chargers 4 |  |
| Tugger park | depot | 7, 19 | 4 x 3 | slots 4, chargers 0 |  |

| Fleet | Preset | Count | Capacity | Speed (m/s) | Length (m) | Load / unload (s) | Battery | Home |
|---|---|---|---|---|---|---|---|---|
| Forklifts | forklift | 8 | 2 | 3 | 2 | 20 / 20 | 5 h runtime, 60 min charge, low 25 %, resume 90 % | Forklift park |
| AGVs | agv | 10 | 1 | 1.5 | 1.2 | 12 / 12 | 3 h runtime, 60 min charge, low 25 %, resume 90 % | AGV charging |
| Tugger trains | tugger | 4 | 4 | 2 | 2 | 45 / 45 | off | Tugger park |

| Flow | Fleet | Weight | Per cycle | Batch min / max wait | Priority |
|---|---|---|---|---|---|
| Steel gate -> Coil store | Forklifts | 1 | 1 | - | 1 |
| Parts gate -> Parts supermarket | Forklifts | 1 | 1 | - | 1 |
| Coil store -> Press line | Forklifts | 1 | 1 | - | 1 |
| Press line -> Weld cell | AGVs | 1 | 2 | - | 1 |
| Parts supermarket -> Weld cell | Tugger trains | 1 | 1 | 2 / 240 s | 1 |
| Weld cell -> Paint shop | AGVs | 1 | 1 | - | 1 |
| Paint shop -> Frame buffer | AGVs | 1 | 1 | - | 1 |
| Frame buffer -> Assembly | AGVs | 1 | 1 | - | 1 |
| Parts supermarket -> Assembly | Tugger trains | 2 | 2 | 4 / 240 s | 1 |
| Assembly -> Packing | AGVs | 1 | 1 | - | 1 |
| Packing -> FG store | Forklifts | 1 | 1 | - | 1 |
| FG store -> Customer gate | Forklifts | 3 | 1 | - | 1 |
| FG store -> Spares gate | Forklifts | 1 | 1 | - | 1 |

**Test claims** (seeds 1 to 5, 8 h unless the row says hour 24; mean [min .. max]; `results/ship/components-a.json`, regenerated by `meas2.mjs`). The last column is the figure as printed in the tip; `check-claims.mjs` verified every row against the tip text.

| Tip | Variant | Metric | Measured mean [min .. max] | In the tip |
|---|---|---|---|---|
| 1 | base | pallets/h (`thr`) | 19.3 [18.8 .. 19.7] | 19.3 |
| 1 | base | paint shop busy % (`Paintshop_u`) | 84.8 [82.8 .. 86.4] | 85 |
| 1 | base | assembly starved % (`Assembly_st`) | 46.8 [45.7 .. 48.0] | 47 |
| 1 | base | forklifts busy % (`Forklifts_util`) | 44.3 [42.5 .. 45.5] | 44 |
| 1 | base | AGVs busy % (`AGVs_util`) | 50.1 [49.2 .. 51.0] | 50 |
| 1 | base | tugger trains busy % (`Tuggertrains_util`) | 51.7 [50.4 .. 52.8] | 52 |
| 1 | base | waiting in traffic % (`wait`) | 9.3 [8.7 .. 10.0] | 9 |
| 2 | d12 | paint shop busy % (`Paintshop_u`) | 93.0 [84.3 .. 100] | 93 |
| 2 | d12 | pallets/h (`thr`) | 20.6 [18.7 .. 22.3] | 20.6 |
| 2 | d12 against base | output change % (`thr`) | 7 % | 7 % |
| 2 | d12 | pallets/h band (`thr`) | 20.6 [18.7 .. 22.3] | between 18.7 and 22.3 |
| 2 | d12paint2 | pallets/h (`thr`) | 23.0 [22.8 .. 23.0] | 23.0 |
| 2 | d12paint2 against base | output change % (`thr`) | 19 % | 19 % |
| 2 | d12paint2 | paint shop busy % (`Paintshop_u`) | 51.6 [51.3 .. 52.0] | 52 |
| 2 | d12paint2 | press line busy % (`Pressline_u`) | 90.0 [89.3 .. 90.9] | 90 |
| 2 | base | press line busy % (`Pressline_u`) | 74.4 [73.5 .. 75.0] | 74 |
| 3 | noMid | forklifts busy % (`Forklifts_util`) | 63.2 [62.0 .. 64.8] | 63 |
| 3 | noMid | tugger trains busy % (`Tuggertrains_util`) | 79.4 [78.4 .. 80.4] | 79 |
| 3 | noMid | waiting in traffic % (`wait`) | 26.2 [25.7 .. 26.7] | 26 |
| 4 | noCross | forklifts busy % (`Forklifts_util`) | 45.0 [44.5 .. 45.8] | 45 |
| 4 | noCross | waiting in traffic % (`wait`) | 10.3 [10.0 .. 10.7] | 10 |
| 4 | noCrossAll | forklifts busy % (crossing cell erased too) (`Forklifts_util`) | 54.3 [51.8 .. 56.4] | 54 |
| 4 | noCrossAll | waiting in traffic % (crossing cell erased too) (`wait`) | 16.4 [15.4 .. 17.4] | 16 |
| 5 | noSlow | forklifts busy % (`Forklifts_util`) | 40.1 [39.5 .. 40.9] | 40 |
| 5 | base | waiting in traffic % (`wait`) | 9.3 [8.7 .. 10.0] | 9.3 |
| 5 | noSlow | waiting in traffic % (`wait`) | 8.0 [7.8 .. 8.2] | 8.0 |

**Findings claims** (the Results tab, number of the 5 runs of 8 h in which the finding appears):

- tip 1, base: the findings call the paint shop the bottleneck: 3 of 5 runs.
- tip 2, d12: Demand 1.2: the bottleneck finding is critical: 5 of 5 runs (severity critical).
- tip 2, d12: Demand 1.2: trucks leave short at the outbound gates: 4 of 5 runs.
- tip 2, d12paint2: Demand 1.2 and two paint machines: the finding names the Press line: 2 of 5 runs.
- tip 3, noMid: mid street erased: the Traffic finding is critical: 5 of 5 runs (severity critical).

**Variant edits** (plain mutator calls, exactly what the tips describe; the claims table names the variants):

```js
d12: (l) => L.updateSettings(l, { demandFactor: 1.2 })
d12paint2: (l) => { variants.d12(l); variants.paint2(l); }
noMid: (l) => { for (let x = 15; x <= 67; x++) L.eraseRoadCell(l, x + GEO.dx, 23 + GEO.dy); }
noCross: (l) => { for (let y = 11; y <= 35; y++) if (y !== 23) L.eraseRoadCell(l, 35 + GEO.dx, y + GEO.dy); }
noCrossAll: (l) => { for (let y = 11; y <= 35; y++) L.eraseRoadCell(l, 35 + GEO.dx, y + GEO.dy); }
noSlow: (l) => { for (const [k, c] of Object.entries(l.roads)) if (c.limit) L.setRoadLimit(l, ...k.split(',').map(Number), 1); }
```

The edits use `GEO` = the offset that `trimGrid` applied (the cells below are final), `stn(l, name)` = the station of that name, and `L` = the layout.js mutators.

**The cells of the road edits** (final coordinates, after `trimGrid`):

- `noMid`, mid street erased (Eraser tool): row y 19: x 14 to 66 (53 cells)
- `noCross`, cross aisle erased in two strokes, the crossing cell kept: column x 34: y 7 to 18; column x 34: y 20 to 31 (24 cells)
- `noCrossAll`, cross aisle erased in one stroke (the crossing cell too): column x 34: y 7 to 31 (25 cells)
- `noSlow`, limit taken off (Slow zone tool, Alt-drag): column x 13: y 7 to 31 (25 cells), limit 0.7 to 1 (the zone is the west side of the ring)

**Expected validation result:** zero issues of any severity for the example and for every variant above.

**Performance budget:**

- speed 13,110x real time (gate 500x, target 2000x); CPU per 8 h run 2.30 s (seed 1); builder 1.8 ms warm;
- share link 3.9 KB (4014 characters); canvas (headless Chromium, fitted): first render 18.70 ms, fitted: render med 0.60 p95 1.10 max 130.90 ms, sim 1 s med 0.10 ms;
- the all-examples test loops cost 2.85 CPU s for this example;
- first load leaves at minute 55.

**Verification run** (this tree):

```
[components-plant] 79x42x2m, 16 stations, 22 vehicles, 345 road cells, schema 2
  validate: zero issues; errors 0; layout invariants []; fixed point true; json round trip true
  per-tick invariants over 1800 s: none violated (2.5 CPU s with the checker on)
  2 h seed 1: report sane (finite, shares sum to 1, percentiles ordered); 20 loads left the plant in 2 h (KPI window starts at 7200 s: 0 counted, 0.0/h), deadlocks 0, stuck vehicles 0
  speed: 0.275 CPU s per simulated hour = 13110x real time (gate 500x, target 2000x)
  load: build layout + construct simulation + 60 s = 0.01 CPU s
```

```
components-plant: 79x42 cells at 2 m (158 x 84 m), schema 2, calendar none, warm-up 7200 s
   16 stations (4 with trucks), 13 flows, 3 fleets / 22 vehicles, 345 road cells, 0 obstacles, 4 labels, notes 913 chars
   validate: zero issues (errors, warnings and infos); invariants []; fixed point true
   share link: 4014 chars
   2 h seed 1 (own warm-up): window 0.0 h, 0.0 pallets/h (0 left), 20 loads left in 2 h, lead 0.0 min, WIP 0.0, traffic wait 0%, deadlocks 0, unplaced 0; 6590x
      fleets: Forklifts x8 38% busy | AGVs x10 50% busy | Tugger trains x4 50% busy
      insights: [info] Not enough data yet
   2 h seed 1 (warm-up 0): window 2.0 h, 10.0 pallets/h (20 left), 20 loads left in 2 h, lead 72.3 min, WIP 58.0, traffic wait 9%, deadlocks 0, unplaced 0; 11544x
      fleets: Forklifts x8 41% busy | AGVs x10 46% busy | Tugger trains x4 48% busy
      insights: [warning] Assembly waits for input 57 % of the time. | [info] Parts gate has 3 doors, but they are busy only 21 % of the time. | [info] Packing waits for input 64 % of the time. | [info] Weld cell waits for input 48 % of the time. | [info] 1 of 10 vehicles in the AGVs fleet hardly works.
   8 h seed 1: 18.8 pallets/h, lead 86.4 min (p95 136.3), WIP 67.0, traffic wait 10%, deadlocks 0; 2.30 CPU s = 12510x
      fleets: Forklifts x8 44% busy 4% chg | AGVs x10 50% busy 14% chg | Tugger trains x4 51% busy
      insights: [warning] Paint shop is the bottleneck: busy 84 % and broken down 9 % of the time while 3 loads wait in front of it. | [warning] 1 of 3 trucks left Spares gate without a full load. | [info] Assembly: the dock at (50, 22) takes 94 % of the visits while (48, 29) and (52, 29) are hardly used. | [info] Steel gate has 2 doors, but they are busy only 10 % of the time. | [info] Parts gate has 3 doors, but they are busy only 21 % of the time. | [info] Packing waits for input 53 % of the time. | [info] Assembly waits for input 48 % of the time. | [info] Weld cell waits for input 44 % of the time. | [info] Paint shop broke down 4 times and was out of service 9 % of the time.
```

Universal checks of the existing all-examples test loops (model.examples, sim.integration, sim.engine.routing, model.layout.grow), replayed by `sanity.mjs`: 12 of 12 checks ok.

**Risks and honest limits:**

- No initial stock: the first two plant hours are warm-up (7200 s), the sim bar says "Warming up"; a 2 h report window is empty ("not enough data yet"), so the 2 h sanity test counts loads that left the plant (20 in 2 h at seed 1) instead of KPIs; the first load leaves at minute 55.
- The trucks come on a fixed rhythm (constant gaps and pallets) so that the plant settles and the seed bands are 3 % wide; the other examples keep random arrivals. The notes say so.
- Over 40 to 48 hours the plant shows the first signs of drift: the parts supermarket fills (30 to 104 pallets at hour 48), and the spares gate leaves trucks short (4 to 5 of 23): its output of 19.0 to 19.4 pallets/h is a hair below the 19.4 its trucks ask for. No critical finding, no deadlock (24 h gate in E18).
- The designer's one-way ring was changed to two-way: the simulation says the one-way ring costs the forklifts about a fifth of their time (58 % against 46 % busy) and does not reduce waiting. Measured on the earlier version, 5 seeds.
- A process with several incoming flows needs loads from ALL of them every cycle, so parallel stations cannot feed one process: the plant uses machines:n and a merge storage. Users who copy the pattern with two parallel stations will halve their throughput.
- The bottleneck finding names the paint shop in 3 of 5 runs at 8 h (and in every 24 h run): the tip says so. Results at base: the paint warning, and infos (doors idle, docks unbalanced, starved): about 9 lines, the first one is the story. The info "the dock at (50, 22) takes 94 % of the visits" says that the second docks are reached from the mid street.

**Prototype:** `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/components-plant.mjs` (exports `build()`, `variants`, `meta`, `glyph`).

### 6.6 `twin-plants`: Two plants, one yard (level 5, rank 11)

- **Origin:** pedagogy (twin-plants), redesigned after the reviews: the container return became a rework loop, the inbound and outbound rates were balanced, the trucks come on a fixed rhythm, the machines were right-sized (3.3), the tips were replaced by levers with stable metrics.
- **Card description (120 characters):** Two plants on one baseplate, joined by a yard road, one warehouse, one charging hall and a shuttle fleet shared by both.
- **Learn line (card):** A campus is one system: shared goods, a shuttle fleet, and the one resource both plants depend on.
- **Chips (card):** two plants (zones) · shared warehouse · shared charging hall · yard trucks · warm-up 2 h
- **Story:** Two plants stand on one baseplate, joined by a yard road: plant A presses, welds and paints car frames and moulds the trim, plant B assembles, tests and packs them (about one unit in twenty goes back to A for rework), and a central warehouse in the yard feeds the weld cells of A and the assembly lines of B. Six yard trucks shuttle frames, trim and rejects across the yard; one charging hall serves the vehicles of both plants.
- **Teaches:** Reading a campus as one system: goods shared and exchanged between two plants (frames and trim A to B, rejects B to A, parts from a shared warehouse to both), a dedicated shuttle fleet restricted to the flows that cross the yard, a shared charging hall as the single point where both plants depend on each other, a sharing rule (the warehouse weights) that decides who starves, and that the limit of the whole is the slower plant. The finale: everything of the earlier examples at once.
- **Features:** two plants on one baseplate (zones), 3 goods in and 4 goods out; a shared central warehouse and a shared charging hall (6 chargers, 48 slots); a dedicated shuttle fleet (6 custom yard trucks, capacity 6, 4 m/s, batteries) restricted to the flows that cross the yard; goods in both directions between the plants (frames and trim A to B, rejects B to A through a rework station); a bill of materials with perCycle in both plants; batches with max wait on the shuttle flows; batteries on six of seven fleets and a limited charger hall; slow zones (0.5) at both plant gates of the yard road; seven fleets, 30 vehicles, 33 stations, 32 flows on a 170 x 52 cell baseplate; trucks on a fixed rhythm, warm-up 7200 s.

**Notes text** (exact `layout.notes`, 1167 characters; shown in the Properties tab > Plant > Notes and in the report):

> Two plants on one baseplate, joined by a yard road. Plant A (west) presses, welds and paints car frames and moulds the trim; plant B (east) assembles, tests and packs them, and about one unit in twenty fails the quality check and goes back to plant A for rework. In the yard stand a parts gate, a central warehouse that feeds both plants and one charging hall for the electric vehicles of both. Six yard trucks may drive only the flows that cross the yard (frames and trim from A to B, rejects back to A) and the brackets for the weld cells of A; each plant has its own truck gates, forklifts and AGVs. LogiPlan has no site concept: the second plant is a zone of one big baseplate, so the Results tab has no per-plant figures; compare the plants through their stations and fleets. The central warehouse hands out its parts by fixed weights, not by who is short, and a pallet is a pallet: nothing tells a returned unit from a new one. The trucks come on a fixed rhythm, so the plant settles instead of drifting. The first two hours are warm-up and are not measured: set the speed to 600×, run to hour 8 and open the Results tab (a whole day takes 72 seconds at 1200×).

**Tips (exact strings of `tips`, 6):**

1. Press play, set the speed to 600× and run to hour 8 (the first two plant hours are warm-up), then open the Results tab. Over several runs 17.7 pallets/h leave through the four customer gates, about 150 pallets are in the plant (186 after 24 hours: the plant settles) and the mean lead time is 134 minutes. 30 vehicles in 7 fleets work in the plants and the yard; the one warning names the AGVs of plant A (62 % busy, a load waits about 2.4 minutes for one).
2. Try: set "Charging slots" of the Charging hall to 2 (Properties tab) and run to hour 8 again. It is the one thing both plants share, and it stops both: the output falls from 17.7 to 10.2 pallets/h (-42 %), the loads in the plant climb from 151 to 275, the AGVs of plant B are busy 33 % of the time instead of 60 % and parked 62 % instead of 19 % while they wait for a charger, and a load waits 20 minutes for one of them instead of 1.6. With 3 chargers the output is still 16.9 pallets/h (-5 %): the hall has a cliff, not a slope.
3. Try: halve the weights of the two flows from the Central warehouse to A Weld 1 and A Weld 2 (Flows tab, Weight 1 to 0.5). The warehouse hands out its parts by fixed weights, not by who is short: plant A now gets far fewer brackets than its welds need, the output falls from 17.7 to 10.7 pallets/h (-40 %), the loads in the plant climb from 151 to 418 and both press lines are blocked, while the parts of the other flows pile up in the warehouse (5 times as full as before).
4. Try: raise "Demand" in the Simulate tab to 1.5. The campus reaches its limit: the output rises by only 12 % (19.8 pallets/h, not the 27 that is asked for), the loads in the plant climb from 151 to 426, the mean lead time grows from 134 to 165 minutes, trucks at the retail and export gates leave short and the findings name the press lines and the moulding as bottlenecks (each in at least 3 of 5 runs).
5. Try: halve the yard trucks (3 instead of 6 in the Fleet tab). The output hardly changes (17.3 pallets/h, -2 %), but the trucks are busy 69 % of the time instead of 40 % and a load waits 16 minutes for one instead of 10: the fleet had twice the trucks the campus needs.
6. Try: let any vehicle drive the frame shuttle (Flows tab: A Frame dispatch to B Frame receiving, Vehicles: Any fleet). The AGVs of plant A now take the long trips between their own jobs: they are busy 70 % of the time instead of 62 % and the share of driving time spent waiting in traffic grows from 6.7 % to 10 %. A dedicated shuttle fleet protects the work inside the plants.

**Layout:** 170 x 52 cells at 2 m (340 x 104 m), schema 2, no clock (stationary plant), warm-up 7200 s, 711 road cells, 5 labels ("PLANT A: frames and trim", "THE YARD", "PLANT B: assembly and shipping", "Receiving", "Yard road"), 33 stations (7 with trucks), 32 flows, 7 fleets / 30 vehicles. Reference hash `ed864b027de23a48e46bdac7fbca6da9539abe8e`.

Sketch (letters = stations, `.` two-way road, arrows one-way, `~` slow zone; one character = 4 x 3 cells):

```
             JJ
             JJ
  ..............          ..............
GG. .. . .  .  .          . .  .. .    .
GG. CCRRRWWTTT .    HHHH  .AAA BBLK    .OO
GG. CCRRRWWTTT DDDggHHHHEE.AAA BBLK    .OO
  . .  . .  .  DDDggHHHHEE. .  . ..    .OO
PP. .  . .  .  DDD.. ...EE. .  . ..    ppp
PP.............~~~......~~~............ppp
NN. .  . .  .  YYZZZZZZZUU. .     .    .XX
NN.MMMrrrwwttt YYZZZZZZZ  .aaa   FFF   .XX
  .MMMrrrwwttt .         u.aaa   FFF   .SS
  .MMMrrrwwttt .          .aaa   FFF   .SS
  ..............          ..............
    II   QQ                  qqq
    II   QQ                  qqq
```

Legend: G A Steel gate; C A Coil store; R A Press 1; W A Weld 1; T A Paint 1; r A Press 2; w A Weld 2; t A Paint 2; I A Plastics gate; M A Moulding; N A Trim store; J A Customer gate; Y A Rework; D A Frame dispatch; P A Forklift park; Q A AGV park; g Yard Parts gate; H Central warehouse; Z Charging hall; U Yard truck park; E B Frame receiving; A B Assembly 1; a B Assembly 2; B B Test buffer; L B Quality; K B Packing; F B FG store; O B Retail gate; X B Export gate; S B Spares gate; p B Forklift park; q B AGV park; u B Tugger park.

| Station | Type | Cell (x, y) | Size | Parameters | Trucks and doors |
|---|---|---|---|---|---|
| A Steel gate | source | 1, 11 | 6 x 6 | arrival n(120 ±10 %), out buffer 8, first at 60 s | 3 doors, a truck every c(4550) s, pallets c(24), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| A Coil store | storage | 16, 12 | 7 x 6 | capacity 160, dwell 120 s |  |
| A Press 1 | process | 27, 12 | 6 x 6 | cycle n(300 ±10 %), machines 1, 2 out per cycle, in 6, out 8 |  |
| A Weld 1 | process | 36, 12 | 6 x 6 | cycle n(250 ±10 %), machines 1, in 6, out 4 |  |
| A Paint 1 | process | 46, 12 | 7 x 6 | cycle n(280 ±10 %), machines 1, in 6, out 6, mtbf 3 h, mttr 12 min |  |
| A Press 2 | process | 27, 31 | 6 x 6 | cycle n(300 ±10 %), machines 1, 2 out per cycle, in 6, out 8 |  |
| A Weld 2 | process | 36, 31 | 6 x 6 | cycle n(250 ±10 %), machines 1, in 6, out 4 |  |
| A Paint 2 | process | 46, 31 | 7 x 6 | cycle n(280 ±10 %), machines 1, in 6, out 6, mtbf 3 h, mttr 12 min |  |
| A Plastics gate | source | 17, 44 | 6 x 4 | arrival n(120 ±10 %), out buffer 8, first at 90 s | 2 doors, a truck every c(4720) s, pallets c(24), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| A Moulding | process | 15, 31 | 7 x 6 | cycle n(150 ±10 %), machines 1, in 6, out 8 |  |
| A Trim store | storage | 1, 27 | 6 x 4 | capacity 120, dwell 0 s |  |
| A Customer gate | sink | 53, 2 | 6 x 3 |  | 1 door, a truck every c(14400) s, pallets c(6), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| A Rework | process | 63, 27 | 6 x 4 | cycle n(170 ±10 %), machines 1, in 6, out 6 |  |
| A Frame dispatch | storage | 62, 15 | 8 x 7 | capacity 80, dwell 0 s |  |
| A Forklift park | depot | 2, 23 | 6 x 3 | slots 6, chargers 0 |  |
| A AGV park | depot | 37, 43 | 7 x 3 | slots 10, chargers 0 |  |
| Yard Parts gate | source | 72, 15 | 8 x 6 | arrival n(120 ±10 %), out buffer 8, first at 120 s | 4 doors, a truck every c(1560) s, pallets c(24), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| Central warehouse | storage | 82, 14 | 14 x 7 | capacity 500, dwell 120 s |  |
| Charging hall | depot | 70, 27 | 26 x 5 | slots 48, chargers 6 |  |
| Yard truck park | depot | 96, 27 | 5 x 3 | slots 8, chargers 0 |  |
| B Frame receiving | storage | 96, 15 | 8 x 7 | capacity 80, dwell 0 s |  |
| B Assembly 1 | process | 111, 12 | 7 x 6 | cycle n(300 ±10 %), machines 1, in 6, out 6 |  |
| B Assembly 2 | process | 111, 31 | 7 x 6 | cycle n(300 ±10 %), machines 1, in 6, out 6 |  |
| B Test buffer | storage | 124, 12 | 6 x 6 | capacity 30, dwell 0 s |  |
| B Quality | process | 130, 12 | 4 x 6 | cycle n(110 ±10 %), machines 1, in 6, out 6 |  |
| B Packing | process | 134, 12 | 6 x 6 | cycle n(120 ±10 %), machines 1, in 6, out 6 |  |
| B FG store | storage | 133, 31 | 8 x 6 | capacity 200, dwell 60 s |  |
| B Retail gate | sink | 160, 13 | 6 x 6 |  | 3 doors, a truck every c(4710) s, pallets c(12), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| B Export gate | sink | 160, 29 | 6 x 4 |  | 2 doors, a truck every c(7850) s, pallets c(12), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| B Spares gate | sink | 160, 35 | 6 x 3 |  | 1 door, a truck every c(15700) s, pallets c(8), check-in/out 300/300 s, max dwell 60 min, staging 4 |
| B Forklift park | depot | 159, 23 | 6 x 3 | slots 6, chargers 0 |  |
| B AGV park | depot | 119, 43 | 7 x 3 | slots 10, chargers 0 |  |
| B Tugger park | depot | 100, 33 | 4 x 3 | slots 3, chargers 0 |  |

| Fleet | Preset | Count | Capacity | Speed (m/s) | Length (m) | Load / unload (s) | Battery | Home |
|---|---|---|---|---|---|---|---|---|
| Forklifts A | forklift | 3 | 2 | 3 | 2 | 20 / 20 | 5 h runtime, 60 min charge, low 25 %, resume 90 % | A Forklift park |
| AGVs A | agv | 7 | 1 | 1.5 | 1.2 | 12 / 12 | 3 h runtime, 60 min charge, low 25 %, resume 90 % | A AGV park |
| Yard forklifts | forklift | 2 | 2 | 3 | 2 | 20 / 20 | 5 h runtime, 60 min charge, low 25 %, resume 90 % | Yard truck park |
| Yard trucks | custom | 6 | 6 | 4 | 2 | 40 / 40 | 4 h runtime, 60 min charge, low 25 %, resume 90 % | Yard truck park |
| Tugger B | tugger | 3 | 4 | 2 | 2 | 45 / 45 | off | B Tugger park |
| AGVs B | agv | 6 | 1 | 1.5 | 1.2 | 12 / 12 | 3 h runtime, 60 min charge, low 25 %, resume 90 % | B AGV park |
| Forklifts B | forklift | 3 | 2 | 3 | 2 | 20 / 20 | 5 h runtime, 60 min charge, low 25 %, resume 90 % | B Forklift park |

| Flow | Fleet | Weight | Per cycle | Batch min / max wait | Priority |
|---|---|---|---|---|---|
| A Steel gate -> A Coil store | Forklifts A | 1 | 1 | - | 1 |
| A Coil store -> A Press 1 | Forklifts A | 1 | 1 | - | 1 |
| A Coil store -> A Press 2 | Forklifts A | 1 | 1 | - | 1 |
| A Press 1 -> A Weld 1 | AGVs A | 1 | 2 | - | 1 |
| A Press 2 -> A Weld 2 | AGVs A | 1 | 2 | - | 1 |
| Yard Parts gate -> Central warehouse | Yard forklifts | 1 | 1 | - | 1 |
| Central warehouse -> A Weld 1 | Yard trucks | 1 | 1 | 2 / 300 s | 1 |
| Central warehouse -> A Weld 2 | Yard trucks | 1 | 1 | 2 / 300 s | 1 |
| A Weld 1 -> A Paint 1 | AGVs A | 1 | 1 | - | 1 |
| A Weld 2 -> A Paint 2 | AGVs A | 1 | 1 | - | 1 |
| A Paint 1 -> A Frame dispatch | AGVs A | 1 | 1 | - | 1 |
| A Paint 2 -> A Frame dispatch | AGVs A | 1 | 1 | - | 1 |
| A Frame dispatch -> B Frame receiving | Yard trucks | 12 | 1 | 6 / 600 s | 1 |
| A Frame dispatch -> A Customer gate | Forklifts A | 1 | 1 | - | 1 |
| A Plastics gate -> A Moulding | Forklifts A | 1 | 1 | - | 1 |
| A Moulding -> A Trim store | AGVs A | 1 | 1 | - | 1 |
| A Trim store -> B Assembly 1 | Yard trucks | 1 | 1 | 4 / 600 s | 1 |
| A Trim store -> B Assembly 2 | Yard trucks | 1 | 1 | 4 / 600 s | 1 |
| B Frame receiving -> B Assembly 1 | AGVs B | 1 | 1 | - | 1 |
| B Frame receiving -> B Assembly 2 | AGVs B | 1 | 1 | - | 1 |
| Central warehouse -> B Assembly 1 | Tugger B | 2 | 2 | 4 / 300 s | 1 |
| Central warehouse -> B Assembly 2 | Tugger B | 2 | 2 | 4 / 300 s | 1 |
| B Assembly 1 -> B Test buffer | AGVs B | 1 | 1 | - | 1 |
| B Assembly 2 -> B Test buffer | AGVs B | 1 | 1 | - | 1 |
| B Test buffer -> B Quality | AGVs B | 1 | 1 | - | 1 |
| B Quality -> B Packing | AGVs B | 19 | 1 | - | 1 |
| B Quality -> A Rework | Yard trucks | 1 | 1 | 2 / 900 s | 1 |
| A Rework -> A Frame dispatch | AGVs A | 1 | 1 | - | 1 |
| B Packing -> B FG store | Forklifts B | 1 | 1 | - | 1 |
| B FG store -> B Retail gate | Forklifts B | 5 | 1 | - | 1 |
| B FG store -> B Export gate | Forklifts B | 3 | 1 | - | 1 |
| B FG store -> B Spares gate | Forklifts B | 1 | 1 | - | 1 |

**Test claims** (seeds 1 to 5, 8 h unless the row says hour 24; mean [min .. max]; `results/ship/twin-a.json`, regenerated by `meas2.mjs`). The last column is the figure as printed in the tip; `check-claims.mjs` verified every row against the tip text.

| Tip | Variant | Metric | Measured mean [min .. max] | In the tip |
|---|---|---|---|---|
| 1 | base | pallets/h (`thr`) | 17.7 [17.5 .. 18.0] | 17.7 |
| 1 | base | pallets in the plant at hour 8 (`wipNow`) | 151 [149 .. 157] | 150 |
| 1 | base (hour 24) | pallets in the plant at hour 24 (`wipNow`) | 186 [179 .. 197] | 186 |
| 1 | base | lead time, min (`leadMean`) | 134 [134 .. 135] | 134 |
| 1 | base | AGVs A busy % (`AGVsA_util`) | 62.1 [61.7 .. 62.5] | 62 |
| 1 | base | AGVs A pickup wait, min (`AGVsA_pw`, s to min) | 2.4 [2.2 .. 2.6] | 2.4 |
| 2 | ch2 | pallets/h (2 chargers) (`thr`) | 10.2 [9.8 .. 10.7] | 10.2 |
| 2 | ch2 against base | output change % (`thr`) | -42 % | -42 % |
| 2 | ch2 | pallets in the plant (2 chargers) (`wipNow`) | 275 [249 .. 304] | 275 |
| 2 | ch2 | AGVs B busy % (2 chargers) (`AGVsB_util`) | 33.3 [30.6 .. 35.1] | 33 |
| 2 | base | AGVs B busy % (`AGVsB_util`) | 60.5 [60.0 .. 61.2] | 60 |
| 2 | ch2 | AGVs B parked % (2 chargers) (`AGVsB_park`) | 62.3 [60.1 .. 66.6] | 62 |
| 2 | base | AGVs B parked % (`AGVsB_park`) | 19.0 [18.0 .. 20.3] | 19 |
| 2 | ch2 | AGVs B pickup wait, min (2 chargers) (`AGVsB_pw`, s to min) | 20 [17 .. 23] | 20 |
| 2 | base | AGVs B pickup wait, min (`AGVsB_pw`, s to min) | 1.6 [1.5 .. 1.7] | 1.6 |
| 2 | ch3 | pallets/h (3 chargers) (`thr`) | 16.9 [16.5 .. 17.2] | 16.9 |
| 2 | ch3 against base | output change % (`thr`) | -5 % | -5 % |
| 3 | brkHalf | pallets/h (`thr`) | 10.7 [10.7 .. 10.7] | 10.7 |
| 3 | brkHalf against base | output change % (`thr`) | -40 % | -40 % |
| 3 | brkHalf | pallets in the plant (`wipNow`) | 418 [418 .. 418] | 418 |
| 3 | base | pallets in the plant (`wipNow`) | 151 [149 .. 157] | 151 |
| 4 | d15 | pallets/h (`thr`) | 19.8 [19.0 .. 20.5] | 19.8 |
| 4 | d15 against base | output change % (`thr`) | 12 % | 12 % |
| 4 | d15 | pallets in the plant (`wipNow`) | 426 [406 .. 446] | 426 |
| 4 | d15 | lead time, min (`leadMean`) | 165 [163 .. 167] | 165 |
| 5 | yt3 | pallets/h (`thr`) | 17.3 [16.8 .. 17.7] | 17.3 |
| 5 | yt3 against base | output change % (`thr`) | -2 % | -2 % |
| 5 | yt3 | yard trucks busy % (`Yardtrucks_util`) | 68.9 [67.4 .. 70.1] | 69 |
| 5 | base | yard trucks busy % (`Yardtrucks_util`) | 39.7 [39.1 .. 40.3] | 40 |
| 5 | yt3 | yard trucks pickup wait, min (3 trucks) (`Yardtrucks_pw`, s to min) | 16 [15 .. 20] | 16 |
| 5 | base | yard trucks pickup wait, min (`Yardtrucks_pw`, s to min) | 10 [10 .. 11] | 10 |
| 6 | anyFrame | AGVs A busy % (`AGVsA_util`) | 69.8 [68.6 .. 70.9] | 70 |
| 6 | anyFrame | waiting in traffic % (`wait`) | 10.0 [9.2 .. 11.0] | 10 |
| 6 | base | waiting in traffic % (`wait`) | 6.7 [6.5 .. 7.0] | 6.7 |

**Findings claims** (the Results tab, number of the 5 runs of 8 h in which the finding appears):

- tip 1, base: the AGVs of plant A are the fleet the findings call saturated (the one warning that every run has): 5 of 5 runs (severity warning).
- tip 3, brkHalf: brackets halved: both press lines are blocked (critical finding): 5 of 5 runs (severity critical).
- tip 4, d15: Demand 1.5: the findings name press line 1 as a bottleneck: 4 of 5 runs.
- tip 4, d15: Demand 1.5: the findings name press line 2 as a bottleneck: 4 of 5 runs.
- tip 4, d15: Demand 1.5: the findings name the moulding as a bottleneck: 3 of 5 runs.
- tip 4, d15: Demand 1.5: trucks leave short at the retail gate: 5 of 5 runs.
- tip 4, d15: Demand 1.5: trucks leave short at the export gate: 5 of 5 runs.
- tip 2, ch2: two chargers: trucks leave short at the retail gate: 5 of 5 runs.

**Variant edits** (plain mutator calls, exactly what the tips describe; the claims table names the variants):

```js
ch2: (l) => L.updateStation(l, stn(l, 'Charging hall').id, { params: { chargers: 2 } })
ch3: (l) => L.updateStation(l, stn(l, 'Charging hall').id, { params: { chargers: 3 } })
brkHalf: (l) => { for (const f of bracketFlows(l)) L.updateFlow(l, f.id, { weight: 0.5 }); }
d15: (l) => L.updateSettings(l, { demandFactor: 1.5 })
yt3: (l) => L.updateFleet(l, flt(l, 'Yard trucks').id, { count: 3 })
anyFrame: (l) => { for (const f of l.flows) if (stn2(l, f.from) === 'A Frame dispatch' && stn2(l, f.to) === 'B Frame receiving') L.updateFlow(l, f.id, { fleetId: null }); }
```

The edits use `stn(l, name)` = the station of that name, `flt(l, name)` = the fleet of that name, `stn2(l, id)` = the name of the station with that id, `bracketFlows(l)` = the two flows Central warehouse -> A Weld 1 / A Weld 2, `crossFlows(l)` = the flows between a station of A and a station of B (frame dispatch -> frame receiving, trim store -> both assemblies, quality -> rework) and `L` = the layout.js mutators. `anyFrame` touches only the flow A Frame dispatch -> B Frame receiving.

**Expected validation result:** zero issues of any severity for the example and for every variant above.

**Performance budget:**

- speed 7,296x real time (gate 500x, target 2000x); CPU per 8 h run 3.15 s (seed 1); builder 2.5 ms warm;
- share link 6.5 KB (6648 characters); canvas (headless Chromium, fitted): first render 14.50 ms, fitted: render med 0.80 p95 1.70 max 139.50 ms, sim 1 s med 0.10 ms;
- the all-examples test loops cost 3.81 CPU s for this example;
- first load leaves at minute 84.

**Verification run** (this tree):

```
[twin-plants] 170x52x2m, 33 stations, 30 vehicles, 711 road cells, schema 2
  validate: zero issues; errors 0; layout invariants []; fixed point true; json round trip true
  per-tick invariants over 1800 s: none violated (3.2 CPU s with the checker on)
  2 h seed 1: report sane (finite, shares sum to 1, percentiles ordered); 9 loads left the plant in 2 h (KPI window starts at 7200 s: 0 counted, 0.0/h), deadlocks 0, stuck vehicles 0
  speed: 0.493 CPU s per simulated hour = 7296x real time (gate 500x, target 2000x)
  load: build layout + construct simulation + 60 s = 0.03 CPU s
```

```
twin-plants: 170x52 cells at 2 m (340 x 104 m), schema 2, calendar none, warm-up 7200 s
   33 stations (7 with trucks), 32 flows, 7 fleets / 30 vehicles, 711 road cells, 0 obstacles, 5 labels, notes 1167 chars
   validate: zero issues (errors, warnings and infos); invariants []; fixed point true
   share link: 6648 chars
   2 h seed 1 (own warm-up): window 0.0 h, 0.0 pallets/h (0 left), 9 loads left in 2 h, lead 0.0 min, WIP 0.0, traffic wait 0%, deadlocks 0, unplaced 0; 7734x
      fleets: Forklifts A x3 33% busy | AGVs A x7 86% busy | Yard forklifts x2 100% busy | Yard trucks x6 33% busy | Tugger B x3 0% busy | AGVs B x6 100% busy | Forklifts B x3 33% busy
      insights: [info] Not enough data yet
   2 h seed 1 (warm-up 0): window 2.0 h, 4.5 pallets/h (9 left), 9 loads left in 2 h, lead 93.6 min, WIP 97.0, traffic wait 7%, deadlocks 0, unplaced 0; 7716x
      fleets: Forklifts A x3 49% busy | AGVs A x7 61% busy | Yard forklifts x2 37% busy | Yard trucks x6 25% busy | Tugger B x3 37% busy | AGVs B x6 41% busy | Forklifts B x3 18% busy
      insights: [warning] B Assembly 1 waits for input 54 % of the time. | [warning] B Assembly 2 waits for input 54 % of the time. | [info] A Rework waits for input 97 % of the time. | [info] Forklifts B fleet is mostly idle: its 3 vehicles work only 18 % of the time. | [info] Yard Parts gate has 4 doors, but they are busy only 18 % of the time. | [info] B Packing waits for input 68 % of the time. | [info] B Quality waits for input 67 % of the time. | [info] A Weld 2 waits for input 44 % of the time. | [info] A Weld 1 waits for input 44 % of the time. | [info] A Paint 2 waits for input 37 % of the time. | [info] A Paint 1 waits for input 35 % of the time.
   8 h seed 1: 17.8 pallets/h, lead 134.3 min (p95 198.1), WIP 124.3, traffic wait 7%, deadlocks 0; 3.15 CPU s = 9137x
      fleets: Forklifts A x3 41% busy 4% chg | AGVs A x7 62% busy 22% chg | Yard forklifts x2 35% busy | Yard trucks x6 40% busy 5% chg | Tugger B x3 51% busy | AGVs B x6 61% busy 18% chg | Forklifts B x3 36% busy 4% chg
      insights: [warning] AGVs A fleet is saturated: its 7 vehicles are busy 62 % of the time, and loads wait 2.6 min for a pickup. | [info] A Rework waits for input 96 % of the time. | [info] A Steel gate has 3 doors, but they are busy only 10 % of the time. | [info] Yard Parts gate has 4 doors, but they are busy only 18 % of the time. | [info] B Export gate has 2 doors, but they are busy only 23 % of the time. | [info] B Retail gate has 3 doors, but they are busy only 23 % of the time. | [info] B Quality waits for input 46 % of the time. | [info] B Packing waits for input 45 % of the time. | [info] A Weld 1 waits for input 35 % of the time. | [info] A Weld 2 waits for input 33 % of the time. | [info] A Paint 2 broke down 4 times and was out of service 9 % of the time. | [info] A Paint 1 broke down 2 times and was out of service 6 % of the time.
```

Universal checks of the existing all-examples test loops (model.examples, sim.integration, sim.engine.routing, model.layout.grow), replayed by `sanity.mjs`: 12 of 12 checks ok.

**Risks and honest limits:**

- The "second plant" is a zone of one baseplate, not a site: there are no per-plant KPIs; the notes say so and the plants are compared through station and fleet rows (the names carry the zone).
- The rework loop is a weighted flow, not a tracked loop (section 4): a returned unit is anonymous and comes out of the rework station as a frame again.
- The warehouse hands out its parts by fixed weights, so the plant is only as good as those weights and the margin of the supply (tip 3 is the lesson, section 3.3 the rule).
- The trucks come on a fixed rhythm (constant gaps and pallets) so that the plant settles and the seed bands are 3 % wide; the first outbound truck of a gate arrives one gap after the start, so the first pallet leaves at minute 84 (the 1 h check of sim.logistics.review must run 90 minutes).
- The plant is not strictly stationary: loads in the plant grow by about 2.5 an hour after hour 24 (central warehouse and trim store fill); at hour 48 the figure is 239 to 263. No critical finding, no deadlock.
- Balanced and demand-limited: most single-lever edits do nothing (batteries off: 17.7 pallets/h, the same; 8 yard trucks: the same; 4 chargers: the same); the six tips are the levers that do something.
- Wide plan (170 : 52): the gallery card spans two columns; the thumbnail is otherwise a thin strip. At fit zoom on a 1440 px screen the station names are not drawn; the plant labels (PLANT A, THE YARD, PLANT B) are.
- The heaviest example: about 3 to 4 CPU s per 8 h run; the warm restart after an edit primes 40 minutes of plant time (about 0.4 s) and the swapped-in plant is still warming up (the toast says so).
- The bays of this plant are 3 cells (2 to 3 on the yard): do not shorten them; 0 deadlocks in all runs of 8 to 48 h.

**Prototype:** `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/twin-plants.mjs` (exports `build()`, `variants`, `meta`, `glyph`).

### 6.7 What the Results tab shows at base, in one line each

| Example | Base findings (8 h, seed 1) |
|---|---|
| `hello-pallet` | [good] No bottlenecks, congestion or deadlocks found. |
| `charging-corner` | [good] No bottlenecks, congestion or deadlocks found. |
| `yard-shuttle` | [good] No bottlenecks, congestion or deadlocks found. |
| `morning-peak` | [warning] Forklifts fleet is saturated: its 8 vehicles are busy 86 % of the time, and loads wait 7.8 min for a pickup. ; [warning] The doors of Suppliers are not the problem, the vehicles are: pallets are taken away too slowly. ; [warning] Trucks wait 15 min at the gate of Suppliers on average. |
| `components-plant` | [warning] Paint shop is the bottleneck: busy 84 % and broken down 9 % of the time while 3 loads wait in front of it. ; [warning] 1 of 3 trucks left Spares gate without a full load. ; [info] Assembly: the dock at (50, 22) takes 94 % of the visits while (48, 29) and (52, 29) are hardly used. ; ... (6 more, infos) |
| `twin-plants` | [warning] AGVs A fleet is saturated: its 7 vehicles are busy 62 % of the time, and loads wait 2.6 min for a pickup. ; [info] A Rework waits for input 96 % of the time. ; [info] A Steel gate has 3 doors, but they are busy only 10 % of the time. ; ... (9 more, infos) |

## 7. Gallery design (js/ui/dialogs.js, js/model/examples.js)

Today the welcome dialog is one grid of cards (`openWelcome`, `exampleCard`): a thumbnail (16:9, `object-fit: contain`), the name, a three-line description (full text in the tooltip) and `layoutFacts` ("8 stations · 6 flows · 10 vehicles"). With eleven cards the grid needs a path.

### 7.1 Metadata on every `EXAMPLES` entry

New fields, no layout changes: `level` (1 to 5), `rank` (1 to 11, the recommended path), `learn` (one line, at most 110 characters) and `chips` (at most 4 short tags, the card shows up to 3). The array order of the first five stays (tests pin it); the six new entries are appended in ladder order; the gallery sorts by (level, rank), so the array order does not decide the display. The new descriptions are written for the card: the hook first, 105 to 123 characters, three lines at the card width of 274 px (about 42 characters a line); the `learn` line carries the lesson. The existing descriptions stay unchanged (they clip at the third line; the tooltip shows them in full).

| Rank | Level | Id | Name | Description (characters) | Learn line | Chips |
|---|---|---|---|---|---|---|
| 1 | 1 | `hello-pallet` | Hello, pallet: one forklift, one road | One forklift, one road, one pallet every 2.5 minutes. How many can it carry? Work it out, then raise the demand. (112) | A vehicle is a machine with a cycle time, so its capacity can be calculated. | 1 forklift, napkin maths |
| 2 | 1 | `starter` | Starter: dock → assembly → shipping | The smallest complete plant: pallets arrive, one assembly station works on them and two AGVs carry them around a loop road to shipping. (135) | The smallest complete plant: a source, a workstation, a sink and two AGVs. | 2 AGVs, loop road |
| 3 | 2 | `charging-corner` | Charging corner: six electric forklifts, two chargers | Six electric forklifts, two chargers. The batteries start full and run low together: what does that do to the queue? (116) | Energy is a hidden capacity: no charge, no work, and the chargers are a station like any other. | electric forklifts, batteries, chargers |
| 4 | 2 | `yard-shuttle` | Yard shuttle: one truck, 280 metres | A truck carries pallets 280 m down a yard road and empties back. How long should it wait for a full load? (105) | Over a distance the batch decides: capacity and maximum wait set how many trucks you need. | yard truck, batching, return load |
| 5 | 2 | `dock-lab` | Dock lab: one street, three docks | Trucks bring pallets to a Goods in with three docks, each on its own short side road, and forklifts carry them to a Storage. Turn the three side roads into a row and watch the docks stop sharing the work. (204) | Docks share the work only when each has its own side road. | trucks and doors, docks |
| 6 | 3 | `two-lines` | Two production lines + warehouse | Forklifts and battery AGVs serve a press line and a machining line from a central warehouse; final assembly needs two pressed parts and one machined part per product. (166) | Forklifts and AGVs, a bill of materials and the bottleneck it makes. | forklifts and AGVs, bill of materials, breakdowns |
| 7 | 3 | `congestion-lab` | Congestion lab | A plant with deliberate traffic problems: a narrow one-way loop, a packing dock right on the main aisle, a crossing, trucks that unload in bunches and too many vehicles. Watch the queues form, then fix them. (207) | Traffic: a deliberately awkward plant, and the fixes. | one-way loop, congestion |
| 8 | 3 | `warehouse-first-day` | Warehouse: first day | A small pallet warehouse: trucks arrive at three doors, four forklifts carry the pallets to the Storage and on to Goods out. Find out whether the doors or the forklifts decide how long trucks wait. (197) | Trucks, doors and forklifts: which one limits the gate? | trucks and doors, forklifts |
| 9 | 4 | `morning-peak` | Morning peak: a cross-dock on appointments | A grocery cross-dock on a timetable: 22 supplier trucks, a peak from 08:00 to 10:00, eight forklifts. Size it for the peak. (123) | Size doors and forklifts for the peak hour, not the average: a better timetable is a lever too. | day plant (clock), timetables, 2 goods in, 3 goods out, one-way ring |
| 10 | 4 | `components-plant` | Components plant: one hall, three kinds of vehicle | A whole plant under one roof: press, weld, paint, assembly, three kinds of vehicle. Find the bottleneck, then the roads. (120) | Reading a whole plant: which station limits it, which vehicle does which job, and which roads earn their keep. | warm-up 2 h, forklifts, AGVs, tuggers, bill of materials, breakdowns, slow zone |
| 11 | 5 | `twin-plants` | Two plants, one yard | Two plants on one baseplate, joined by a yard road, one warehouse, one charging hall and a shuttle fleet shared by both. (120) | A campus is one system: shared goods, a shuttle fleet, and the one resource both plants depend on. | two plants (zones), shared warehouse, shared charging hall, yard trucks, warm-up 2 h |

### 7.2 Layout of the dialog

1. **Group by level.** Five sections, each with a heading and a one-line caption: 1 "Start here" (One road, then one small plant.), 2 "One idea at a time" (Each plant teaches one thing: energy, distance, docks.), 3 "Several things at once" (Lines, traffic and trucks together in one plant.), 4 "A whole plant" (A day on a timetable, or a hall with three kinds of vehicle.), 5 "Two plants, one campus" (Shared goods, a shuttle fleet and one charging hall.). Inside a section the cards keep the auto-fill grid (`minmax(230px, 1fr)`); the section element keeps `aria-label`; the headings are real headings.
2. **Card additions.** A level badge with TEXT ("Level 2 of 5"; five small dots may accompany it but are `aria-hidden`), the `learn` line under the description (one line, dim), up to three chips (text, no colour coding), and the facts line as today. Nothing is auto-loaded: the app only loads an example when a card is picked.
3. **The twin plants card spans two columns** (`grid-column: span 2`, thumbnail aspect 21:9) because the plan is 170 : 52; at narrow widths it falls back to one column. The thumbnail is drawn by `thumbnailFor` (scale = min(1, 560 / (width_m x 20))); measured in headless Chromium: first render 14 to 30 ms per example, frame median 0.1 to 0.8 ms (p95 1.7 ms for the twin plants), no page errors.
4. **The empty-plant form stays below the examples**; with eleven cards plus five headings the dialog scrolls inside the modal: the primary button of the dialog keeps the focus it has today.
5. **Cost of opening the dialog:** all examples are built each time (`EXAMPLES.map(build)`): about 6 ms for the six new ones and 12 ms for the existing five (warm; builder times 0.2 ms hello-pallet to 2.5 ms twin-plants); the thumbnails are drawn one per task after the dialog is up.

### 7.3 What the card text must and must not say

The description names no number that a test does not check; it never promises "fits three lines" without the measurement of E26; it does not say "complex" for a plant that is not. The learn lines of the six new examples are the strings of section 6; the five existing ones get: starter "The smallest complete plant: a source, a workstation, a sink and two AGVs." (chips: 2 AGVs, loop road), dock-lab "Docks share the work only when each has its own side road." (trucks and doors, docks), two-lines "Forklifts and AGVs, a bill of materials and the bottleneck it makes." (forklifts and AGVs, bill of materials, breakdowns), congestion-lab "Traffic: a deliberately awkward plant, and the fixes." (one-way loop, congestion), warehouse-first-day "Trucks, doors and forklifts: which one limits the gate?" (trucks and doors, forklifts).

### 7.4 Make the tips visible (REQUIRED)

`example.tips` is read only by tests today, and the lessons of the ladder live in the tips. Without a visible place the six new examples are plants to press play on, not a ladder. The build therefore includes (task I2, acceptance E27):

1. **A Help tab "Examples"** (`openHelp({ tab: 'examples' })`, next to Quick start, Tools, Tips ...): generated from `EXAMPLES` in rank order, one block per example: name, level and learn line, a button "Open this example" (the same confirm-replace flow as the gallery, `ctx.actions.loadExample(id)`) and the tips as an ordered list, text identical to `example.tips` (one source of truth; the ladder tests already check it). The first lines of the tab say what a reader needs once: "The figures in the tips are means over five runs of 8 simulated hours (seeds 1 to 5). The app shows one run, so your numbers differ a little; use the Experiments tab for several runs. Set the speed in the bar above the plan to 600× and run to the hour the tip names."
2. **An action on the open-example toast** (`toast(text, { action })` already exists): "Things to try" opens that tab scrolled to the example just opened. The notes of the plant stay where they are (Properties tab, Plant, Notes) and in the report.
3. The five existing examples appear in the tab with their unchanged tips.
4. It is a card in a Help dialog, not a new panel: no change to the layout of the app; keyboard and screen-reader behaviour of the tabs as they are (arrow keys, `role=tab`).

### 7.5 Tests that follow

`tests/e2e/panels2.mjs` hard-codes 5 cards (lines 664, 667, 674, 681, 773, 1047, 1108): use `EXAMPLES.length`; add assertions for the five headings and their order; `tests/e2e/integration.mjs:159` already uses `EXAMPLES.length`; `sim.examples.warehouse.test.js:38` compares the whole id list and becomes `EXAMPLES.slice(0, 5)` (section 8.2).

## 8. Test plan

### 8.1 Rules

1. **The golden examples stay untouched.** `LEGACY_EXAMPLE_IDS` stays the three ids (`tests/helpers/golden.js`), `tests/fixtures/**` stay byte-identical, the five existing builders keep their bodies; the six new ones never enter a golden or legacy loop. Verifier check: `git diff` of the fixtures and of `js/sim/**` is empty for this work (the examples are data).
2. **No tip ships with a number the test does not reproduce** (the convention of `tests/sim.engine.review.test.js` 'tips' and `tests/sim.examples.warehouse.test.js`). Section 6 lists every figure of every tip as a claim (variant, metric, measured mean over seeds 1 to 5 at 8 h, band); 148 claims in all. `proto/ship/check-claims.mjs` verifies the text against the measurements; the ladder tests re-measure.
3. **Keep the cost in budget** (8.6): heavy work in worker threads and in its own shards, one fast file for the structure, the loops that already iterate over every example accept the six at about 12 CPU s.
4. **Variants are plain edits through the layout.js mutators** (as in `tests/helpers/warehouse-runs.js`): data that travels to a worker (`{ example, edit }`), the edit applied by name from `tests/helpers/ladder/<id>.js`.
5. **A failing tip test after an engine change means: re-measure and update the tip**, not loosen the band. `proto/ship/meas2.mjs` (`node meas2.mjs <id> --seeds 5 --at 8 --only a,b --json out.json`) regenerates the numbers; the measured table of section 6 is the reference.

### 8.2 The existing tests that iterate over EVERY example

Measured by appending the six prototypes to a scratch copy of the tree (`m2/ship-repo`, HEAD 73892e2 plus the working-tree edits) and running each file alone. "Result" is the result with eleven examples.

| Test file (line) | What it does with every example | Result with the six added | Edit |
|---|---|---|---|
| `model.examples.test.js` (15, 58 to 70, 103, 108, 120) | catalogue, fresh builds, normalized, validates without issues, every station has a dock and every flow routes, plant sizes 40x24 to 56x36 at 2 m, depots hold fleets | 12 of 14 pass; 2 red: "every station ... has a dock" (`flows.length >= 2`: hello-pallet has 1 flow) and "plant sizes" (cols, rows, 2 m cells) | `>= 1`; the size rule keeps for the five ids and gets a table (cols, rows, cell size, loop yes / no: hello-pallet and yard-shuttle have no loop by design) for the six |
| `sim.examples.warehouse.test.js` (38) | the whole id list equals the five ids | not run: red by construction | `EXAMPLES.slice(0, 5)` |
| `sim.logistics.review.test.js` (733, 752) | 900 s with Stats agree with the counters; 3600 s with every invariant and "goods leaving" | 56 of 57 pass; 1 red: "the shipped examples run for an hour ... goods leaving": twin-plants has shipped 0 loads after 1 h (first load at minute 84; components-plant has 5, morning-peak 3) | run 5400 s (90 minutes) instead of 3600; about +3 CPU s |
| `sim.integration.test.js` (45, 154) | 30 min with every invariant on every tick (seed 7), 2 runs compared, something delivered, nobody stands still | 20 of 20 pass (23 s wall) | none |
| `sim.engine.routing.test.js` (24, 161, 247) | routing budget 1 h, `canReach` over every node, distance ledger 1 h | 12 of 12 pass | none |
| `sim.stats.review.test.js` (660) | stats review loops over the real plants | 52 of 52 pass | none |
| `sim.trucks.stats.test.js` (36) | truck statistics of every example | 10 of 10 pass | none |
| `ui.dashboard.test.js` (282), `ui.guidance.test.js` (161), `ui.jobsinfo.test.js` (223), `ui.report.test.js` (690) | the dashboard, the guidance texts, the jobs info and the report on every example | 19, 54, 26 and 43 tests pass | none |
| `version.review.test.js` (1455) | loads every example through the share / open path | 73 of 73 pass | none |
| `model.layout.grow.test.js` (291), `model.reconcile.test.js` (95), `model.ops-trucks.fuzz.test.js` (35) | growGrid / trimGrid keep the content, reconcile, fuzz of documents built from every example | 11, 13 and 1 tests pass (the fuzz takes 12 s) | none |
| `m1.model.review.test.js` (319) | validate, serialize and reconcile every example | 50 of 51 pass; the one red is the layering test, caused by the absolute imports of the scratch patch (`check-imports` passes on the real tree: 120 modules), not by the examples | none |
| `sim.detail.fuzz.test.js` (65) and `sim.detail.perf.test.js` (30) (new, untracked tests of the statistics work) | loaded-leg balance on every example; 500 times real time on every example | 6 and 5 tests pass (18 s and 22 s wall) | none; they are in HEAVY_SHARDS of that work |
| `tests/e2e/panels2.mjs` (664, 667, 674, 681, 773, 1047, 1108), `integration.mjs` (around 159, 187, 1270), `edit-feedback.mjs` (around 665, 675) | the welcome dialog has N cards; every example opens, every station in view and hit-testable; edit while running on every example | not run in full; the hit-test part of integration.mjs was run for the six in the real app (0 stations out of view, no console error) | panels2: `EXAMPLES.length` and the headings (7.5); the others should pass unchanged and are part of E29 |
| `scripts/perf-baseline.mjs` | times the examples that every tree has | the six are timed when one tree is measured; not a gate (the gate is the legacy three) | none |

Everything not listed iterates `legacyExamples()` (the three golden ids) or names single examples and is unaffected. The golden, fuzz and hostile loops are not touched.

### 8.3 New test files

| File | Tier | What it asserts | CPU |
|---|---|---|---|
| `tests/model.examples.ladder.test.js` | fast | the catalogue (11 ids in the array order, levels, ranks 1 to 11, the first five unchanged); per new example: fresh and deterministic builds, JSON stable, fixed point of normalizeLayout, `validateLayout` zero issues of every severity, every station has a dock, depots hold their fleets, one connected road network, grid within `GRID_LIMITS`, the table of section 2 (size, cell, schema, clock only on morning-peak, warm-up 7200 s on the two big plants, counts of stations, flows, fleets, vehicles), notes of at least 400 characters that contain "600×", at least 3 labels (PLANT A / THE YARD / PLANT B on the twin), 4 to 6 tips of 30 to 700 characters each with at least one "Try:" and the speed in tip 1, description 105 to 125 characters (new), `learn` at most 110, `chips` at most 4, every claim of the table occurs in its tip, no currency symbol, the share link of every new example at most 8 KB and a share, open round trip equal | about 2 s |
| `tests/sim.examples.ladder.test.js` | heavy | per new example: 2 simulated hours at seed 1 are healthy (every invariant of `createSimChecker` on the 30-minute run of sim.integration is already covered; here: report sane, 0 deadlocks, no stuck vehicle), speed at least 500 times real time (best of 3 runs of 3600 s after the 600 s warm-up; the target of 2000 is logged), goods leave within 90 minutes (the first-load minutes of 8.5); the stationarity gate of E18 for the two big plants (24 h, seeds 1 to 3: about 70 CPU s) | about 80 CPU s |
| `tests/sim.examples.hello-pallet.test.js`, `...charging-corner...`, `...yard-shuttle...`, `...morning-peak...`, `...components-plant...`, `...twin-plants...` | heavy | the claims of section 6 for that example (seeds 1 to 5, 8 h, `runVariants` on worker threads), the qualitative claims (findings in n of 5 runs, hourly lead-time profile of the charging corner), the validation result of every tip variant (cap4 / cap1: two batch-exceeds-capacity warnings; doors4: doors-too-few; all others zero issues) | see 8.6 |
| `tests/helpers/ladder-runs.js` and `tests/helpers/ladder/<id>.js` | helper | the worker pool (the pattern of `warehouse-runs.js`: this file is also the worker script), `runOne(variant, seed, hours)` returning plain numbers (the metrics of `proto/ship/metrics.mjs`), and per example `edits` (name to function(layout)) and `claims` (data) | |

The ladder files are whole files, so `HEAVY_SHARDS` can pack them without the sliced-file mechanism (8.6).

### 8.4 How a tip number is asserted

The runs are deterministic (same code, same seeds, same numbers), so the bands only have to absorb future engine changes without flaking and without letting a tip become false: a figure printed in a tip with `d` digits passes when the measured mean is within max(half a unit of the last printed digit, 4 % of the figure, 2 points for a share of time); a relative change (-42 %) within 3 points; a band quoted in the tip ("between 18.7 and 22.3") when the measured minimum and maximum are within 10 % of it; a finding claim ("critical in 5 of 5 runs") when it holds in at least that many runs. Throughput is asserted only where the effect is large against the seed band (the exact rhythm makes the bands of the two big plants 3 % wide). Section 6 prints every claim as a table row; the same rows are the data of `tests/helpers/ladder/<id>.js`.

### 8.5 Speed, first goods, stationarity (measured, the numbers the tests pin)

Speed gate (A1.16; best of 3 runs of 3600 s after a 600 s warm-up; it varies about 10 % between runs on this shared machine):

| Example | Speed |
|---|---|
| hello-pallet | 101,101x real time (0.036 CPU s per simulated hour) |
| charging-corner | 34,658x real time (0.104 CPU s per simulated hour) |
| yard-shuttle | 154,162x real time (0.023 CPU s per simulated hour) |
| morning-peak | 30,414x real time (0.118 CPU s per simulated hour) |
| components-plant | 13,110x real time (0.275 CPU s per simulated hour) |
| twin-plants | 7,296x real time (0.493 CPU s per simulated hour) |

The first load leaves (the check "goods leave within an hour" of `sim.logistics.review.test.js` has to run 5400 s; first loads, minutes, seeds 1 to 5 are identical because the trucks have a fixed rhythm or a fixed first gap):

| Example | Loads left after 1 h, 1.5 h, 2 h, 2.5 h, 3 h (createRealWorld, seed 1) | First load, minute (seeds 1 to 5) |
|---|---|---|
| hello-pallet | 24, 35, 47, 59, 72 | 2 2 2 2 2 |
| charging-corner | 55, 87, 118, 149, 176 | 4 4 4 4 4 |
| yard-shuttle | 48, 80, 112, 143, 175 | 17 18 17 16 18 |
| morning-peak | 3, 3, 27, 51, 108 | 43 43 43 43 43 |
| components-plant | 5, 12, 20, 33, 46 | 55 55 55 55 55 |
| twin-plants | 0, 5, 9, 20, 29 | 84 84 84 84 84 |

Stationarity of the two big plants (E18): 24 simulated hours at seeds 1 to 3 without critical finding, without deadlock, no storage at 80 % of its capacity, loads in the plant at hour 24 at most 1.6 times those at hour 8 (measured: twin 1.2, components 1.0 to 1.1). The per-tick invariant checker of the tests is not used over 24 hours (its absolute tolerance of 1e-6 trips on float drift of about 1e-11 relative after 19 hours of the twin plants at seed 3, found by the second critic): the 30-minute run of sim.integration stays the per-tick check.

### 8.6 Cost of the tests

Measured with `process.cpuUsage` on four cores, other work idle where possible.

**A. The loops that already iterate over every example** (they gain the six; `proto/ship/testcost.mjs`; inv30 = per-tick invariants over 30 minutes, twice = two 30 minute runs compared, hand = logistics review loops, stats = stats review loops, canReach, budget = 1 h, distance = 1 h):

```
hello-pallet           inv30 0.46  twice 0.14  hand 0.11  stats 0.05  canReach 0.00  budget 0.03  distance 0.04  total 0.83
charging-corner        inv30 0.80  twice 0.19  hand 0.19  stats 0.09  canReach 0.01  budget 0.11  distance 0.10  total 1.49
yard-shuttle           inv30 0.34  twice 0.13  hand 0.03  stats 0.07  canReach 0.01  budget 0.06  distance 0.03  total 0.68
morning-peak           inv30 1.24  twice 0.31  hand 0.22  stats 0.19  canReach 0.01  budget 0.14  distance 0.12  total 2.23
components-plant       inv30 1.32  twice 0.32  hand 0.29  stats 0.20  canReach 0.10  budget 0.36  distance 0.26  total 2.85
twin-plants            inv30 1.55  twice 0.40  hand 0.38  stats 0.31  canReach 0.31  budget 0.44  distance 0.41  total 3.81
```

Total 11.9 CPU s on top of the existing loops, spread over `sim.integration`, `sim.engine.routing`, `sim.logistics.review`, `sim.stats.review` and the fast tier.

**B. The tip reproduction** (seeds 1 to 5, 8 h; CPU s per 8 h run as measured on the reference runs of section 6):

| Example | CPU s per 8 h run | Variants in the file | Suite (CPU s) |
|---|---|---|---|
| hello-pallet | 0.3 | base, d15, d2, d2two, d2fast2 (5) | 8 |
| charging-corner | 0.9 | base, nobat, ch1, ch3, res60, charge120, low0 (7), plus the hourly profile of base and ch1 | 32 |
| yard-shuttle | 0.2 | base, two, wait300, cap4, cap1, d2 (6) | 7 |
| morning-peak | 1.3 | base, flat, doors4, f10, f6, twoWay (6) | 42 |
| components-plant | 2.6 | base, d12, d12paint2, noMid, noCross, noCrossAll, noSlow (7) | 91 |
| twin-plants | 3.8 | base, ch2, ch3, brkHalf, d15, yt3, anyFrame (7) | 131 |
| ladder file (speed, 2 h sanity, first goods, stationarity 24 h x 3 seeds of the two big plants) | | | 80 |
| **Total** | | 39 variants x 5 seeds | **about 390 CPU s** (about 100 to 130 s wall on four worker threads, spread over three shards) |

With the fixed rhythm the two big plants give the same verdicts with 3 seeds instead of 5 (bands of 3 %): components 55 s and twin 80 s; keep 5 unless a shard runs long.

**Shards** (`scripts/test-tiers.mjs`, `HEAVY_SHARDS`; one runner each; `.github/workflows/ci.yml` and `pages.yml` list the shard numbers and the job names say "/7": both go to the new count, and `tests/test-tiers.test.js` proves that both workflows run every shard): **shard 8** = the ladder file and hello-pallet, charging-corner, yard-shuttle, morning-peak (about 170 CPU s, about 45 s wall), **shard 9** = components-plant (about 90 CPU s, about 25 s wall), **shard 10** = twin-plants (about 130 CPU s, about 35 s wall). The existing shards are 46 to 77 s; if shard 8 turns out too long, move the ladder file to a shard of its own.

### 8.7 End-to-end (Playwright, `npm run test:e2e`)

Edits to existing files: `panels2.mjs` (the card count and the five headings), `integration.mjs` (the `examples` loop at line 187 opens every example and asserts that every station is in view and hit-testable at its centre: run it for the eleven; it was run for the six here with the prototypes, 0 stations out of view or not hit-testable, render median 0.2 to 0.8 ms, no console errors), `edit-feedback.mjs` (the two loops at 665 and 675 edit every example while it runs: the two big plants warm-restart in a few seconds, the toast says they are still warming up). New: `tests/e2e/examples.mjs` (smoke for every example: open it from its card, press play at 600× for 5 real seconds, the clock advances, no console error or warning, the Results tab shows values once the warm-up is over; for the twin plants run to hour 3 at 1200×) and the Help tab of 7.4.

## 9. Build plan (for the next workflow)

### 9.1 Where the code goes

The five existing examples stay in `js/model/examples.js`, untouched. The six new ones go into a directory next to it, one module each, so that one builder owns one file and `examples.js` does not grow to a thousand lines:

```
js/model/examples.js                      registry: the five existing entries (+ metadata) and the six new ones (spread from ./examples/index.js)
js/model/examples/helpers.js              must, road, ring, station, flow, obstacles, label, arrivals, fleet, slow, attach, bay   (from /tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/lib.mjs)
js/model/examples/index.js                export const NEW_EXAMPLES = [hello, charging, yard, morning, components, twin]  (each: { ...meta, build })
js/model/examples/<id>.js                 export const meta = { id, name, level, rank, description, learn, chips, notes, tips }; export function build()
tests/helpers/ladder-runs.js              worker pool + runOne
tests/helpers/ladder/<id>.js              export const edits = {...}; export const claims = [...]
tests/sim.examples.<id>.test.js           the tip reproduction of one example
tests/sim.examples.ladder.test.js         speed, 2 h sanity, first goods, stationarity
tests/model.examples.ladder.test.js       the structure of all of them (fast tier)
```

`check-imports` walks `js/**`: relative imports with the `.js` extension only.

### 9.2 Roles and file ownership

| Role | Owns (writes only these) | Task |
|---|---|---|
| **F** foundation (first, one agent) | `js/model/examples/helpers.js`, `js/model/examples/index.js` and six stub modules, `tests/helpers/ladder-runs.js` | helpers copied from the prototype library, the registry skeleton, the worker pool |
| **B1..B6** builders (parallel, after F) | `js/model/examples/<id>.js`, `tests/helpers/ladder/<id>.js`, `tests/sim.examples.<id>.test.js` (one example each) | turn the prototype into the module and its test; nothing else |
| **I1** integrator, model and tests (after the builders) | `js/model/examples.js`, `tests/model.examples.ladder.test.js`, `tests/sim.examples.ladder.test.js`, the edits of the existing tests (8.2), `scripts/test-tiers.mjs`, `.github/workflows/ci.yml`, `pages.yml`, `tests/test-tiers.test.js` expectations | registry and metadata of the five, structure tests, shards, cost control |
| **I2** integrator, UI (may start once the metadata of 7.1 exists; before the builders if it works against stub metadata) | `js/ui/dialogs.js`, `js/ui/app.js` (`loadExample` toast), `css/*.css` if needed, `tests/e2e/panels2.mjs`, `integration.mjs`, `edit-feedback.mjs`, new `tests/e2e/examples.mjs`, screenshots | gallery, the Help tab and toast action (7.4), e2e, screenshots light and dark, desktop and narrow |
| **I3** docs | `README.md`, `docs/ARCHITECTURE.md` (examples section), `docs/WAREHOUSE-DESIGN.md` 8.1 "as built", `CHANGELOG.md`, this document (numbers that moved) | |
| **V** verifier (last, independent) | nothing (reads, runs, reports) | checks E1 to E40 and reports |

If two roles need the same file, the later role asks the earlier one; no two roles edit one file.

### 9.3 Order

1. **F.** 2. **B1..B6 in parallel** (and I2 against the stub registry). 3. **I1** (registry needs the six modules), then I3. 4. **V.** 5. A fix pass for what V finds (the owner of the file fixes).

### 9.4 What a builder does (B1..B6)

1. Copy `/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/<id>.mjs` to `js/model/examples/<id>.js`; replace the absolute imports by `../layout.js`, `./helpers.js`, `../defaults.js`; `build()` takes no argument (the prototypes accept an options object for experiments: drop it, keep the defaults); keep `trimGrid(layout, { margin: 4 })` in the two big plants (a public deterministic mutator) and remove the module-level `GEO` state (the test edits use the final cells printed in section 6).
2. `meta` = the prototype's `meta` (id, name, level, description, learn, chips, notes, tips) plus `rank` (section 2); the strings are final: change a tip only together with its claim.
3. `build()` sets the notes through `setNotes` and returns the layout; everything goes through the mutators; `must()` on every creation.
4. Prove it is the same plant: `sha1(JSON.stringify(build()))` equals the reference hash of section 6 (a one-time check, not a test).
5. Write `tests/helpers/ladder/<id>.js`: `edits` = the prototype `variants` named in the claims table of section 6 (the edits are plain mutator calls with explicit cells for the road edits), `claims` = the rows of the table. Write `tests/sim.examples.<id>.test.js` on `runVariants` and the tolerance rule of 8.4.
6. Run only your own files (one node process at a time; never the full suite); report CPU seconds of your test and E4 to E7, E10 to E12 and E19 for your example.

### 9.5 What the integrators do (I1, I2, I3)

**I1:** the registry (`EXAMPLES = [...existing five with level, rank, learn, chips, ...NEW_EXAMPLES]`, the existing five bodies untouched), `tests/model.examples.ladder.test.js`, `tests/sim.examples.ladder.test.js`, the test edits of 8.2, `HEAVY_SHARDS` and the workflow matrices, timings (`npm run test:timings`) and the comments with seconds in `test-tiers.mjs`.
**I2:** the grouped gallery of 7.2 (data from `level`, `rank`, `learn`, `chips`), the twin card across two columns, the Help tab and toast action of 7.4, the e2e of 8.7, screenshots of the gallery and of each new example in light and dark at 1440 x 900 and 390 x 844, reading every screenshot (clipped text, overlaps, contrast), the description clamp measurement of E26.
**I3:** README (the examples list of eleven and a link to this document), ARCHITECTURE (the examples section: directory, registry fields, tips surface), WAREHOUSE-DESIGN 8.1 (an "as built" note: `morning-peak` is the cross-dock-like card of level 4 and does not use the reserved id), CHANGELOG, and the numbers of this document if a tip moved.

## 10. Acceptance criteria (a verifier can check each one)

**Catalogue and data**

- **E1** `EXAMPLES` has 11 entries in this array order: starter, two-lines, congestion-lab, dock-lab, warehouse-first-day, hello-pallet, charging-corner, yard-shuttle, morning-peak, components-plant, twin-plants; ids are unique and match `[a-z0-9-]+`; names, levels and ranks equal section 7.1; new descriptions are 105 to 125 characters, `learn` at most 110, `chips` at most 4 of at most 24 characters.
- **E2** The five existing entries are unchanged except for the added fields: a diff of `js/model/examples.js` against HEAD shows only added lines in the `EXAMPLES` array and the new import; the bodies of `buildStarter`, `buildTwoLines`, `buildCongestionLab`, `buildDockLab`, `buildWarehouseFirstDay` and their notes and tips are byte-identical.
- **E3** The golden net is untouched: `tests/fixtures/**` and `tests/helpers/golden.js` byte-identical, `LEGACY_EXAMPLE_IDS` still three ids, `git diff js/sim` empty, every `sim.golden.*`, `m0.review` and `model.schema` test green.
- **E4** Each new builder reproduces its prototype: `sha1(JSON.stringify(build()))` equals the hash printed in section 6 (one-time check by the verifier).
- **E5** The builders use only exported mutators of `layout.js` (`createLayout`, `setNotes`, `updateSettings`, `updateCalendar`, `paintRoadPath`, `setRoadLimit`, `addStation`, `addFlow`, `addFleet`, `addLabel`, `trimGrid`) through `helpers.js`, with `must()` on every creation (code review).
- **E6** `build()` returns a fresh, equal layout on every call and across two processes; JSON round trip identical; fixed point of `normalizeLayout`; `checkInvariants` empty.
- **E7** `validateLayout` gives zero issues of any severity for all 11, and for every tip variant exactly the issues of section 6 (cap4 and cap1 of the yard shuttle: two `batch-exceeds-capacity` warnings; doors4 of the morning peak: `doors-too-few`; all others zero).
- **E8** The structure table: grid, cell size, schema (1 for hello-pallet, charging-corner, yard-shuttle; 2 for the other three), calendar only on morning-peak, warm-up (600 s; 7200 s on the two big plants), counts of stations, flows, fleets and vehicles equal section 2.
  - hello-pallet: 36 x 14 cells at 3 m, schema 1, no clock, warm-up 600 s, 3 stations (0 with trucks), 1 flow, 1 fleet / 1 vehicle, 29 road cells, 3 labels
  - charging-corner: 56 x 30 cells at 2 m, schema 1, no clock, warm-up 600 s, 4 stations (0 with trucks), 2 flows, 1 fleet / 6 vehicles, 130 road cells, 3 labels
  - yard-shuttle: 60 x 44 cells at 4 m, schema 1, no clock, warm-up 600 s, 5 stations (0 with trucks), 2 flows, 1 fleet / 1 vehicle, 84 road cells, 4 labels
  - morning-peak: 60 x 44 cells at 3 m, schema 2, clock from 06:00, warm-up 600 s, 7 stations (5 with trucks), 5 flows, 1 fleet / 8 vehicles, 238 road cells, 4 labels
  - components-plant: 79 x 42 cells at 2 m, schema 2, no clock, warm-up 7200 s, 16 stations (4 with trucks), 13 flows, 3 fleets / 22 vehicles, 345 road cells, 4 labels
  - twin-plants: 170 x 52 cells at 2 m, schema 2, no clock, warm-up 7200 s, 33 stations (7 with trucks), 32 flows, 7 fleets / 30 vehicles, 711 road cells, 5 labels
- **E9** Every station has a dock, every depot holds its fleet, one connected road network, the grid is within `GRID_LIMITS`, `trimGrid` was applied on the two big plants: `contentBounds` starts at y 4 and x 4 (components-plant) or y 2 and x 1 (twin-plants), no empty block at the edges.
- **E10** Each notes text has at least 400 characters and contains "600×"; charging-corner, morning-peak and components-plant say that an edit starts the run again; twin-plants says "no site concept" and that the Results tab has no per-plant figures.
- **E11** Each example has at least 3 labels (twin-plants: PLANT A, THE YARD, PLANT B).
- **E12** Each example has 4 to 6 tips of 30 to 700 characters, tip 1 names the speed ("600×"), at least one tip starts with "Try:", no tip contains a currency symbol.
- **E13** Metric units and pallets only; results in hours, minutes and counts; no money in any text.

**Simulation**

- **E14** `sim.integration.test.js` passes for all 11 (30 simulated minutes, every invariant on every tick).
- **E15** 2 simulated hours at seed 1: report sane, 0 deadlocks, no stuck vehicle, for each of the six.
- **E16** Speed at least 500 times real time for every example (target 2000 logged); measured values in 8.5 (the slowest, the twin plants, 7,296 times).
- **E17** Goods leave within 90 minutes for each of the six (8.5).
- **E18** Stationarity of the two big plants (8.5): 24 h, seeds 1 to 3, no critical finding, no deadlock, no storage at 80 % of capacity, loads in the plant at hour 24 at most 1.6 times those at hour 8.
- **E19** The claims of every tip (section 6) pass the tolerance rule of 8.4, qualitative claims included.
- **E20** The Results tab at 8 h: hello-pallet, charging-corner and yard-shuttle give no finding in 5 of 5 seeds; morning-peak gives fleet-saturated, gate-queue-long and unload-limited-by-vehicles in 5 of 5; components-plant names the paint shop in at least 2 of 5; twin-plants gives the AGVs of plant A as the one warning present in 5 of 5; no base run has a critical finding.

**Existing tests and cost**

- **E21** After the test edits of 8.2 every existing test file passes: `npm run test:fast` and `npm run test:heavy` are green; `tests/test-tiers.test.js` is green with the new shards and the workflow matrices.
- **E22** `npm run check` passes; no runtime dependency, no build step, Node 22.
- **E23** Test cost: the loops that already iterate over every example add at most 14 CPU s (measured 11.9); the new heavy files at most 400 CPU s in all, no shard above 90 s wall on four cores; the new fast file at most 3 s.
- **E24** Opening the welcome dialog builds the 11 examples in at most 40 ms warm; the thumbnails are drawn after the dialog is up.

**Gallery, tips and UI**

- **E25** The gallery shows the five headings in the order of 7.2, 11 cards sorted by rank, each with level badge text, name, description, learn line, up to 3 chips and the facts line; hello-pallet is first; the twin card spans two columns on a wide dialog and one on a narrow one.
- **E26** Every new description fits three lines at the card width (measured in Chromium by comparing the clamped height with the unclamped one); the tooltip shows the full text.
- **E27** The Help tab "Examples" lists all 11 examples in rank order with name, level, learn line, an "Open this example" button and the tips (text identical to `example.tips`); the toast after opening an example has the action "Things to try" that opens the tab at that example; the first lines say what the figures are (means of five runs, 8 hours, speed 600×).
- **E28** Keyboard and screen reader: the cards and the new tab work with Tab and arrow keys, have accessible names, the badge and chips are text; contrast holds in light and dark.
- **E29** e2e: `panels2` (card count equals `EXAMPLES.length`, headings), `integration` (every station of every example in view and hit-testable at its centre), `edit-feedback` (edit while running on every example), the new `examples.mjs` smoke: all pass in Chromium with no console error or warning.
- **E30** Screenshots of the gallery and of each new example in light and dark at 1440 x 900 and 390 x 844 were taken and read: no clipped text, no overlap; the plant labels are legible at fit zoom (station names on the twin plants need zoom, accepted).
- **E31** Share links of the six at most 8 KB (hello-pallet 1.5 KB, charging-corner 2.1 KB, yard-shuttle 1.9 KB, morning-peak 3.2 KB, components-plant 3.9 KB, twin-plants 6.5 KB) and the share, open round trip gives an equal layout.

**Docs and honesty**

- **E32** README (eleven examples, link to this document), ARCHITECTURE (examples section), WAREHOUSE-DESIGN 8.1 "as built" note, CHANGELOG.
- **E33** This document stays in the repo as the design record; where a tip moved, its claims table moved with it.
- **E34** The twin plants' notes, the Help tab intro and the gallery chips say "two plants (zones)" and never "sites".
- **E35** The speed in the texts is written as the UI writes it ("600×").
- **E36** `tests/helpers/ladder-runs.js` uses at most min(4, cores) workers and terminates them on failure (no leaked worker).
- **E37** The six `meta.tips` and `meta.notes` equal the strings of section 6 (or a changed tip comes with a changed claim and a new measurement).
- **E38** The variants of the tests are applied through mutators only; the road edits use the explicit cells of section 6.
- **E39** `.github/workflows/ci.yml` and `pages.yml` list shards 1 to N and the job names say "/N".
- **E40** No file outside the owner lists of 9.2 changed.

## 11. Open questions for the product owner

1. Is "no per-plant results" acceptable for the finale (a campus is read through station and fleet rows), or should a `site` tag (section 5) be scheduled before the finale ships?
2. Should `morning-peak` also be declared the delivery of docs/WAREHOUSE-DESIGN.md 8.1 row 4 (`cross-dock`, M2)? If yes the M2 row shrinks to the "staging depth" tip; if no the id stays free for a later, smaller example.
3. The Help tab "Examples" plus the toast action (7.4) is the specified home for the tips. Is that the place the owner wants, or a panel that opens with the plant?
4. The runtime of 3 hours in the charging corner is shortened from real batteries (6 to 8 hours) so that charging shows within one shift. Keep the indicative figure (current), or use 6 hours and accept that a newcomer sees the first charge only after about 5.3 plant hours (16 seconds at 1200×)?
5. Is a 2 hour warm-up on the two big plants acceptable, or should they wait for an "initial stock" feature (a model change)?
6. The two big plants have their trucks on a fixed rhythm (constant gaps and pallets) so that they settle and the tips are reproducible; the other examples keep random arrivals. Acceptable, or should every example be exact?

## 12. What was run and what was not

- **Run** (working tree, HEAD 73892e2 with the uncommitted edits of the parallel statistics work; 2026-10-10): the six final prototypes built, validated (zero issues of any severity), `checkInvariants`, normalize fixed point, JSON round trip, 30 minutes of per-tick invariants (seed 7) and 72 universal test-loop checks (`proto/ship/sanity.mjs`); the 2 h seed 1 reports with KPIs and findings, the 8 h seed 1 report (`report.mjs`); the 5-seed 8 h measurement of every variant a tip cites (`meas2.mjs`; morning-peak also at 4, 6, 7 and 8 h), 148 claims checked against the text (`check-claims.mjs`); the 24 and 48 hour stationarity runs of the two big plants (`longrun2.mjs`, seeds 1 to 3) and of the twin plants at 5 seeds; hourly lead time of the charging corner; the findings at 3, 4, 4.5, 5, 6 and 8 hours of the charging corner; the validation of every tip variant (`work/valvars.mjs`); the first-goods minutes (`work/firstgoods.mjs`); the speed gate; builder times; the CPU cost of the all-examples test loops (`testcost.mjs`); the canvas frame cost and first render in headless Chromium (`render-cost.mjs`); the six plants loaded into the real app (`work/hitcheck.mjs`: every station in view and hit-testable, no console error) and screenshots after 130 plant minutes (`m2/shots-ship/`, read: twin plants and components plant); 17 existing test files run against a scratch copy of the tree with the six appended (8.2).
- **NOT run:** the gallery and the Help tab in a browser (they do not exist yet), the e2e suite and the new e2e files, the full unit suite, the new test files (they are specified, not written), the Experiments tab and the warm restart on these plants, dark theme and narrow screens, sim.examples.warehouse.test.js (it fails on its id list by construction).
- **Tools** (`/tmp/claude-0/-home-user-LogiPlan/fe9804b9-9d0b-5410-8338-3bbf663c8c19/scratchpad/m2/proto/ship/`): the six prototypes (`<id>.mjs`: `build()`, `variants`, `meta`), `lib.mjs` (helpers), `claims.mjs` and `check-claims.mjs`, `meas2.mjs` and `metrics.mjs` (5-seed measurement, optional snapshots at several hours), `longrun2.mjs`, `verify.mjs`, `report.mjs`, `sanity.mjs`, `testcost.mjs`, `render-cost.mjs`, `shot.mjs`, `make-doc.mjs` (this document is generated from them), results in `m2/results/ship/`.
- **Not claimed:** any figure for another seed set or run length than the ones named; the tips say "about" and quote means.

