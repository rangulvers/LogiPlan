# LogiPlan

**Plan a factory layout and its in-plant logistics in the browser — then watch it run.**

LogiPlan replaces the Lego mock-up. Build a plant on a baseplate (roads, one-way lanes, goods-in docks, workstations, storage, shipping, parking), say where the loads go, add vehicle fleets (AGVs, forklifts, tugger trains) and press play. Vehicles drive, queue at junctions, load and unload while a live simulation shows throughput, lead times, vehicle utilisation, traffic jams and bottlenecks. Change a speed, add a vehicle, widen an aisle, compare two variants, and come to a final plan you can export as a report.

It is a **static web app** (vanilla ES modules, no build step, no runtime dependencies, no network access needed), so it runs straight from GitHub Pages.

> Live site (once GitHub Pages is switched on, see *Deploy*): `https://rangulvers.github.io/LogiPlan/`. The version number and the short code of the build at the bottom right of the window say which deploy you are looking at; click it for the build, its date and what is new (see *Versioning*).

---

## What you can do

| | |
|---|---|
| **Build** | Draw two-way and one-way roads, slow zones and walls; place Goods in, Workstations, Storage, Goods out and Parking & charging depots as Lego-style bricks. Roads stay straight on their own while you drag (**Smart**: a wobble of your hand makes no jog, a clear turn makes one corner); hold **Shift** for one perfectly straight line, or choose Straight or Free in the Draw switch. Undo/redo everything, multi-select, move, resize, duplicate. The plan grows with your work: draw or place something beyond its edge (or click a **+** on an edge) and it extends by blocks of 8 cells, up to 320 × 320 cells; Properties > Plant settings also has Extend and Trim to content. |
| **Describe the work** | Draw **flows** (arrows) between stations: where loads go next, in what share, how many a process consumes per cycle, batch sizes, priorities, optional restriction to one fleet. |
| **Add vehicles** | Fleets of AGVs, forklifts, tugger trains or custom vehicles: speed, acceleration, length, capacity, load/unload time, batteries and charging, breakdowns, parking behaviour. |
| **Receive and ship trucks** | Give a Goods in or Goods out **dock doors** with one button: trucks arrive at a rate or on a timetable you paste from Excel, wait at a gate, check in, are unloaded or loaded by your forklifts and AGVs, and leave. Results shows the gate wait, the door time and how busy the doors are, says whether the doors or the forklifts are the limit, and warns when the docks of a station lie in a row and cannot share the work. The examples **Dock lab** and **Warehouse: first day** show both. |
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

All asset URLs are relative, so it works under `https://<user>.github.io/<repo>/`. `…/version.json` shows which version and commit are live (see *Versioning*).

---

## Versioning

LogiPlan has one version number, `x.y.z` (it stays `0.x` until the first stable release), kept in `package.json`. Every copy of the app knows what it **is** and says so:

| Where | What you see |
|---|---|
| **The version chip**, bottom right of the window (`v0.6.0 a45ce49`: the number, which changes with a release, and the code of the build, which changes with every deploy; a development copy shows `v0.6.0 dev`; a phone shows the number only) | Click it (or Tab to it and press Enter) for the **About** window: version, build (the commit, linked to GitHub), when it was built (your time and UTC), whether this is the live site or a local copy, a *Copy version info* button for bug reports, and **What is new**: the changelog of the project, newest version open, older ones closed. Where the status line is hidden (a window lower than 521 px: a phone held sideways, 200 % zoom on a Full HD monitor) the *More* menu is there at every width and has *About and what is new*, and so has the narrow layout and the Help window. |
| **A newer version is live** | If the site has been updated while your page was open (or the browser kept an old copy), the chip gets a dot and the word *Update* (and the *More* button a dot), and the About window a *Reload now* button. A new deploy of the same version number counts too: the window then says "a newer build". LogiPlan checks `version.json` once after start, when you come back to the tab and every 30 minutes while the tab stays in front, at most every 5 minutes. It never reloads by itself and never interrupts a running simulation or an edit. *Reload now* saves your plant first (and refuses to reload when it could not be saved in full), fetches the new files past the browser cache and reloads; a running simulation, its results and the undo history start again. A development copy never checks. Anything that goes wrong (offline, no file, junk) is silent. |
| **The HTML report** | Its footer says *Generated with LogiPlan v0.6.0 (a45ce49)*. |
| **`/version.json`** on the site | `{ name, version, commit, shortCommit, builtAt, channel, builtFrom }` of the build that is live: the pipeline's `GITHUB_SHA`, the build time (UTC) and the branch. |

The version is **not** written into project files or share links, so the same plant always exports to the same bytes.

**How it is made.** `js/build-info.js` holds the identity of the running copy. In the repository it is the development default (`commit: 'dev'`); `scripts/build-site.mjs` writes the real one (version from `package.json`, `GITHUB_SHA`, the build time, channel `live`) into the **site it assembles only**, together with `version.json` and a copy of `CHANGELOG.md`. Nothing in the pipeline changes the repository.

**How to cut a version.**

1. While you work, add a line for every change a planner will notice under `## [Unreleased]` in `CHANGELOG.md`, in plain words (what they can now do), under **Added**, **Improved** or **Fixed**. No file names, no jargon.
2. To release: `npm run version:bump -- minor` (or `patch`, `major`, or an exact `1.2.3`; `--date YYYY-MM-DD` and `--dry-run` exist). It sets `package.json` and `js/build-info.js` to the new version and moves the Unreleased lines under `## [x.y.z] - date`, and prints what to do next. An empty Unreleased section gets a `TODO` stub that the tests refuse until you write it.
3. `npm run version:check` (also part of the tests) fails when `package.json`, `js/build-info.js` and the newest released entry of `CHANGELOG.md` name different versions, when that entry has no valid date, or when `js/build-info.js` is not the development default.
4. Commit, open the pull request, merge to `main`. The Pages workflow publishes it; optionally tag the merge commit `vx.y.z`.

---

## Develop

```bash
# the tests need Node 22.1 or later (node:test name filters); the app itself runs on Node 20+
npm run test:fast         # the quick tests: logic, model, UI helpers (~30 s)
npm run test:heavy        # the slow ones: seeded fuzz runs, performance bounds, long simulations (~3.5 min one after the other)
npm test                  # everything, test by test (node:test), ~3 min
npm run test:quiet        # everything, compact output
npm run check             # every import resolves, every named import is exported
npm run version:check     # package.json, js/build-info.js and CHANGELOG.md name the same version (npm run version:bump -- minor cuts a new one)
npm run test:e2e          # browser tests (real Chromium via Playwright, screenshots in e2e-output/)
node scripts/perf-baseline.mjs        # CPU seconds per simulated hour of the three examples (--root DIR compares two checkouts in one run)
node scripts/rebaseline-golden.mjs    # re-record the golden fixtures (tests/fixtures/golden): a pull request that does must say why the legacy results changed
```

The golden tests (`tests/sim.golden.*.test.js`) pin the KPI reports of the example plants and of some dock-dense scratch plants bit for bit, so a change that was meant to leave existing plants alone cannot change them unnoticed.

The browser tests need Playwright, which is deliberately **not** a dependency of the app:
`npm i --no-save playwright && npx playwright install chromium`.

### Tests and CI

`scripts/test-tiers.mjs` cuts the suite in two. A test file is **fast** unless the script lists it as **heavy**, so a new test file runs in CI without any registration; if it takes more than about 10 s, add it to a heavy shard (`npm run test:timings` shows which files are slow). The heavy tier is split into 7 shards of 30 to 80 s, one CI job each (the longest file, the engine review, is cut into three by test name). `tests/test-tiers.test.js` fails if a test file would run in no job or in two, if a shard names a file that no longer exists, or if a workflow does not run every shard; to add a shard, add it to `HEAVY_SHARDS` and to the `shard: [...]` list and the job name of `ci.yml` and `pages.yml`, and the test tells you what is still missing.

| Workflow | Runs | What happens | Takes about |
|---|---|---|---|
| `ci.yml` | every pull request | `check`, `fast` and the 7 `heavy` shards run at the same time, then one verdict, **All checks** (make that the required check of `main`) | 2 min |
| `pages.yml` | every push to `main` | import check + fast tier, then the deploy. The heavy shards run beside it and do not hold it back; if one fails the run turns red | live after 1.5 min |
| `e2e.yml` | on demand, Mondays | the browser tests above in headless Chromium; screenshots and logs are kept when they fail | 10 min |

The times are estimates from running every job's command here (fast tier 44 s, heavy shards 28 to 77 s, the whole suite about 4 minutes on one idle 4-core machine) plus about 15 s per job for starting the runner. Before the split, a pull request waited about 3.5 min for the whole suite, and the deploy ran the whole suite a second time before it published (about 4 to 5 min from merge to live).

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
* Vehicles are point-to-point on a grid road network; shift calendars, pedestrians and traffic lights are not modelled (a clock exists only for truck timetables).
* Trucks are events at a door, not vehicles on the road, and a door is a count, not a place on the wall. The door check assumes 90 s per pallet until a run has measured the door time, which your vehicles set; the defaults (24 pallets per truck, 5 minutes of check-in and check-out) are typical values, labelled indicative. Shifts and breaks, rack geometry and load types are not modelled yet (docs/WAREHOUSE-DESIGN.md).

## License

[MIT](LICENSE): free to use, copy, modify and share, for any purpose, no strings attached.

LogiPlan is an experiment, provided as is. Its simulation is a planning aid with simplified models (see *Known limits*); verify important decisions with real data before building anything.
