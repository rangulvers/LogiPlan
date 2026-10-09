# LogiPlan

**Plan a factory layout and its in-plant logistics in the browser — then watch it run.**

LogiPlan replaces the Lego mock-up. Build a plant on a baseplate (roads, one-way lanes, goods-in docks, workstations, storage, shipping, parking), say where the loads go, add vehicle fleets (AGVs, forklifts, tugger trains) and press play. Vehicles drive, queue at junctions, load and unload while a live simulation shows throughput, lead times, vehicle utilisation, traffic jams and bottlenecks. Change a speed, add a vehicle, widen an aisle, compare two variants, and come to a final plan you can export as a report.

It is a **static web app** (vanilla ES modules, no build step, no runtime dependencies, no network access needed), so it runs straight from GitHub Pages.

> Live site (after the first deploy): `https://<your-user>.github.io/<repo>/`

---

## What you can do

| | |
|---|---|
| **Build** | Draw two-way and one-way roads, slow zones and walls; place Goods in, Workstations, Storage, Goods out and Parking & charging depots as Lego-style bricks. Roads stay straight on their own while you drag (**Smart**: a wobble of your hand makes no jog, a clear turn makes one corner); hold **Shift** for one perfectly straight line, or choose Straight or Free in the Draw switch. Undo/redo everything, multi-select, move, resize, duplicate. The plan grows with your work: draw or place something beyond its edge (or click a **+** on an edge) and it extends by blocks of 8 cells, up to 320 × 320 cells; Properties > Plant settings also has Extend and Trim to content. |
| **Describe the work** | Draw **flows** (arrows) between stations: where loads go next, in what share, how many a process consumes per cycle, batch sizes, priorities, optional restriction to one fleet. |
| **Add vehicles** | Fleets of AGVs, forklifts, tugger trains or custom vehicles: speed, acceleration, length, capacity, load/unload time, batteries and charging, breakdowns, parking behaviour. |
| **Simulate** | Live, 1× to 1200×. Collision-free traffic with junction blocking, dead-end reversing, deadlock detection, machine and vehicle breakdowns, battery charging. What-if sliders (demand, vehicle speed, process time) apply while it runs. |
| **Understand** | KPI dashboard (throughput, lead time, work in progress, utilisation, time stuck in traffic), per-station and per-fleet views, a traffic heatmap, a "Jobs" overlay showing where every vehicle is heading, and plain-language findings such as *"Final assembly is the bottleneck: busy 96 % while 8 loads wait in front of it."* |
| **Decide** | Keep several **variants** (A, B, C…), compare them side by side with repeated runs, sweep a parameter ("how many AGVs do I need?"), and export a self-contained **report** (HTML/print/PDF), a PNG of the layout, or the project as JSON. Share a plant as a link. |
| **Get guidance** | A "next steps" coach tells you what a plant still needs ("Goods in 2 is not connected yet — where should its loads go?"), with one-click fixes, a connector handle on the canvas, and a Help chapter on how vehicles find work. |

### How the model works (the short version)

* **Roads** are plates on a grid; every plate has directed links to its neighbours. Vehicles cannot U-turn mid-road; they reverse only at dead ends. Junction cells let one vehicle in at a time and never enter if they cannot get out the other side.
* **Stations dock on the road cells that touch them.** A station that touches no road cannot be served. A vehicle loading at a dock occupies that cell — put busy docks on side bays to keep traffic flowing. A station with several docks lets several vehicles work at once: each vehicle drives to the dock where it can start soonest (the drive plus the wait for vehicles already there or on their way), so a free dock beats a busy one that is a little closer (the way there and back counts, so a dock far off is only worth it when the wait at the near one is clearly longer).
* **Flows decide where loads go; vehicles are not assigned to stations.** Every free vehicle serves every flow (nearest job first, oldest first, or balanced — your choice in *Simulate*), unless a flow is restricted to a fleet. So adding a second Goods in means adding a flow from it; the same AGVs serve both.
* Everything is **deterministic**: the same plant and seed give the same results; compare variants with repeated seeds for confidence.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Run it

```bash
git clone <this repo> && cd LogiPlan
npm start                 # http://localhost:8080  (Node 20+, no install needed)
```

Opening `index.html` directly from disk does not work (browsers block ES modules on `file://`); use `npm start` or any static server.

### Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| `V` | Select / move / resize | `H`, `Space`-drag | Pan |
| `R` | Two-way road | `O` | One-way road |
| `Z` | Slow zone | `E` | Eraser |
| `1` … `5` | Goods in, Workstation, Storage, Goods out, Parking | `W` / `T` | Wall / label |
| `F` | Flow tool (connect two stations) | `0` | Fit plant to window |
| `Space` | Play / pause | `.` | Step |
| `+` / `−` | Simulation speed | `?` | Help |
| `Ctrl/⌘ Z`, `Shift+Z` / `Y` | Undo, redo | `Ctrl/⌘ D`, `Del` | Duplicate, delete |
| `Shift`-drag (road tools) | One straight line | `Shift`-click | Line from the end of the last road |

---

## Deploy to GitHub Pages

1. Push to GitHub and make `main` the default branch.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Merge to `main`. `.github/workflows/pages.yml` runs the import check and the fast tests, then publishes the site (`scripts/build-site.mjs` assembles `index.html`, `css/`, `js/`, `assets/`); the heavy tests run beside it (see *Tests and CI*).

All asset URLs are relative, so it works under `https://<user>.github.io/<repo>/`. `…/version.json` shows which commit is live.

---

## Develop

```bash
# the tests need Node 22.1 or later (node:test name filters); the app itself runs on Node 20+
npm run test:fast         # the quick tests: logic, model, UI helpers (~30 s)
npm run test:heavy        # the slow ones: seeded fuzz runs, performance bounds, long simulations (~3.5 min one after the other)
npm test                  # everything, test by test (node:test), ~3 min
npm run test:quiet        # everything, compact output
npm run check             # every import resolves, every named import is exported
npm run test:e2e          # browser tests (real Chromium via Playwright, screenshots in e2e-output/)
node scripts/perf-baseline.mjs        # CPU seconds per simulated hour of the three examples (--root DIR compares two checkouts in one run)
node scripts/rebaseline-golden.mjs    # re-record the golden fixtures (tests/fixtures/golden): a pull request that does must say why the legacy results changed
```

The golden tests (`tests/sim.golden.*.test.js`) pin the KPI reports of the example plants and of some dock-dense scratch plants bit for bit, so a change that was meant to leave existing plants alone cannot change them unnoticed.

The browser tests need Playwright, which is deliberately **not** a dependency of the app:
`npm i --no-save playwright && npx playwright install chromium`.

### Tests and CI

`scripts/test-tiers.mjs` cuts the suite in two. A test file is **fast** unless the script lists it as **heavy**, so a new test file runs in CI without any registration; if it takes more than about 10 s, add it to a heavy shard (`npm run test:timings` shows which files are slow). The heavy tier is split into 5 shards of similar length, one CI job each (the longest file, the engine review, is cut into three by test name). `tests/test-tiers.test.js` fails if a test file would run in no job or in two, if a shard names a file that no longer exists, or if a workflow does not run every shard; to add a shard, add it to `HEAVY_SHARDS` and to the `shard: [...]` list and the job name of `ci.yml` and `pages.yml`, and the test tells you what is still missing.

| Workflow | Runs | What happens | Takes about |
|---|---|---|---|
| `ci.yml` | every pull request | `check`, `fast` and the 5 `heavy` shards run at the same time, then one verdict, **All checks** (make that the required check of `main`) | 1.5 min |
| `pages.yml` | every push to `main` | import check + fast tier, then the deploy. The heavy shards run beside it and do not hold it back; if one fails the run turns red | live after 1.5 min |
| `e2e.yml` | on demand, Mondays | the browser tests above in headless Chromium; screenshots and logs are kept when they fail | 10 min |

The times are estimates from running every job's command here (fast tier 32 s, heavy shards 32 to 60 s, the whole suite 181 s on one 4-core machine that was busy with other work) plus about 15 s per job for starting the runner. Before the split, a pull request waited about 3.5 min for the whole suite, and the deploy ran the whole suite a second time before it published (about 4 to 5 min from merge to live).

```
index.html, css/        the app shell and design system (tokens, components, layout)
js/model/               layout data model, validation, serialisation, example plants
js/sim/                 road graph, traffic, logistics, statistics, insights, engine, experiments
js/store/               application state: undo/redo, variants, autosave
js/ui/                  renderer, editor tools, panels, dashboard, dialogs, guidance, app shell
tests/                  unit/integration tests; tests/e2e/ browser tests
docs/                   ARCHITECTURE.md (module contracts), UI-KIT.md (design system)
```

The simulation modules (`js/model`, `js/sim`) have no DOM dependency and run identically in Node, which is how the tests and the headless experiment runner use them.

## Known limits

* Experiments (variant comparison, sweeps) run on the main thread; the UI stays responsive but drops to ~30 fps while they run.
* Very large plants (hundreds of stations, 100+ vehicles) run live at 10×–300×; beyond that "speed limited" is shown.
* The plan is at most 320 × 320 cells. A plant that fills it with 16 000 road cells, 300 stations and 50 vehicles builds in about 0.1 s, but it runs live at only 5×–10×, and checking it after every edit (the Checks tab) takes seconds; the examples and plants of ordinary size are not affected (Two lines on a 320 × 320 baseplate runs at 60 fps at 600×).
* Verified in Chromium; Firefox and Safari should work (no browser-specific APIs without fallbacks) but have not been tested yet.
* Vehicles are point-to-point on a grid road network; shift calendars, pedestrians and traffic lights are not modelled.

## License

[MIT](LICENSE): free to use, copy, modify and share, for any purpose, no strings attached.

LogiPlan is an experiment, provided as is. Its simulation is a planning aid with simplified models (see *Known limits*); verify important decisions with real data before building anything.
