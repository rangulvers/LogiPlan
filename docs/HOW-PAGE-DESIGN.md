# The landing page `/how/` — design

Status: built (design lead). Page: `how/index.html`, styles `how/css/page.css`. Facts: `scripts/how-facts.mjs` writes `how/facts.json`, `tests/how.page.test.js` checks the page against it.

Contents: 1 What the page is for. 2 Direction. 3 Storyline and final copy. 4 Claim ledger. 5 Visual system. 6 Visuals (slots and specs). 7 The live demo (contract). 8 File ownership. 9 Acceptance H1 to H15. 10 Known gaps.

## 1. What the page is for

`/how/` is a static page, served by `npm start` at `http://localhost:8080/how/` and by GitHub Pages at `<site>/how/` (Pages redirects `/how` to `/how/`; `scripts/serve.mjs` does since INTEG). It explains the whole project to four readers who have never heard of it, and is at the same time the showcase of the craft behind it:

| Reader | Wants to know | Where the page answers |
|---|---|---|
| Logistics planner | Can it answer my questions (how many vehicles, where does it jam)? | 01 problem, 02 how, 04 evidence |
| Plant manager | What is it worth? Can I trust the numbers? | 06 value, 09 limits |
| Engineer | How does the engine work? Is it real? | 03 live demo, 08 under the hood |
| Hiring manager | What was built, how well, how honestly? | all of it, 08 and 09 in particular, the colophon |

The brand of the project is honesty, so the page's own rule is: **every number is a fact (generated and tested), a quoted measurement with its source, or absent**; what is not built is said on the page.

## 2. Direction: blueprint meets control room

* **One product, bigger.** The page loads the planner's own `css/tokens.css` (colours in light and dark, station colours, focus, spacing, radii, motion) and logo, so it is visibly the same thing. It goes bigger on type (system font stack, tight tracking, weights 650 to 780, a monospace for labels and figures), on space and on the drawing.
* **Blueprint.** A faint engineering grid under the hero and the closing call; figures framed by crop marks; mono labels (`FIG. 2`, section numbers `01`..`09`); dashed "annotation" boxes for the real example and the self-check.
* **Control room.** Two always-dark bands (the live demo, the engineering section) and the footer redefine the planner's dark tokens locally, so they are dark in both themes and everything inside simply uses `var(--text)` and friends.
* **Baseplate.** The hero is an inline SVG of a small plant in the planner's own visual language (studded baseplate, road plates with a centre line, bricks in the five station colours with studs, dashed flow arrows, vehicles driving the loop with CSS motion paths). It is an illustration and says so in its caption; the screenshots and the live demo are the real thing.
* **Signature moment.** The live simulation (section 03), the real engine drawn by the planner's own renderer, in a dark "screen" with the figures read from the running report.
* **No theme switch.** Light and dark follow the system (`prefers-color-scheme`); there is no cookie, no storage and no preference to remember.

Typography: `--font-sans` and `--font-mono` from the tokens (system stacks only). Base 17 px / 1.6; h1 `clamp(2.4rem, 1rem + 4.2vw, 4.3rem)`; h2 `clamp(1.9rem, 1.2rem + 2.6vw, 3.1rem)`; lede `clamp(1.06rem, .98rem + .4vw, 1.3rem)`; measure at most 62 to 80 characters.

## 3. Storyline and final copy

The canonical text is `how/index.html` (it is what the tests read). Headlines and the load-bearing sentences:

| # | Section (id) | Job | Headline and core copy |
|---|---|---|---|
| – | Hero | Promise and first action | **Watch your plant run before you build it.** "Draw roads and stations on a baseplate. Say where the loads go. Add forklifts, AGVs and tugger trains, and press play. A live simulation shows the queues, the jams and the one thing that limits the whole plant." [Open the planner] [Run a plant right here]. Chips: free and open source (MIT) · runs in your browser · no account, nothing to install. |
| 01 | The problem (`problem`) | Name the pain | **A layout looks fine on paper. Then the forklifts meet at a junction.** Time and traffic problems that a drawing cannot show. Three questions: How many vehicles do I need? Where will it jam? What really limits the plant? Aside: spreadsheet, Lego mock-up or the first week of production; LogiPlan replaces the mock-up and keeps what made it useful. |
| 02 | How it works (`how`) | Show the product | **Four steps from an empty baseplate to an answer.** 1 Build the plant. 2 Describe the work. 3 Add vehicles. 4 Press play. Each with a real screenshot. |
| 03 | Live demo (`live`) | Prove it is real | **Run it here. This is the real engine.** "Nothing on this page is a recording..." Mount `demo`; three things to try. |
| 04 | Evidence (`understand`) | What you learn | **From a moving picture to numbers you can defend.** Dashboard that names the bottleneck; traffic heatmap; click anything for its statistics (vehicle routes drawn); trucks, gates and dock doors. |
| 05 | Decide (`decide`) | How a decision is made | **Keep several plans. Compare them fairly. Hand over the result.** Variants, sweeps, the coach, reports and links. |
| 06 | Value (`value`) | What it is worth | **What it is worth, as reasoning you can check.** No savings percentage ("one would have to be invented"). Four chains of reasoning (answers before the money is spent; the answer comes with its evidence; it teaches the physics; it is open) and one real example from the app, *Dock lab*. |
| 07 | Examples (`examples`) | The path in | **N plants, M levels, one path.** The ladder of the examples from the code (names, learn lines, levels), a preview of each, a link that opens the planner's example gallery. |
| 08 | Under the hood (`craft`) | Engineering credibility | **A simulation core you can run anywhere, and a UI that stays out of its way.** Four layers (model, simulation, store, interface) drawn as bricks; counts as lower bounds; deterministic by construction; no build step, no runtime dependencies; tested in tiers; versioned and honest about it; "this page follows its own rules". |
| 09 | Honest limits (`limits`) | What is not built | **What LogiPlan does not do, yet.** Not in the product: order picking; a multi-site model ("Two plants, one yard" is one plant model on one baseplate); racks, shift calendars, demand profiles (roadmap in `docs/WAREHOUSE-DESIGN.md`); pedestrians and traffic lights. Built with a caveat: trucks are events at a door; defaults are indicative; Chromium only verified, Firefox, Safari and touch not checked; very large plants run slowly. |
| – | Closing call | Act | **Build a plant. Press play.** [Open the planner] [Start from an example]. |
| – | Footer | Credit, links | Version, repository, licence, colophon: "Designed and built with Claude Code, Anthropic's coding agent, at the direction of the project owner. Set in your system's own fonts. This page sets no cookies and makes no requests to other sites." |

The nav ("The problem, How it works, Live demo, Evidence, Value, Examples, Under the hood, Limits") scrolls horizontally inside itself on narrow screens (no page scroll) and is sticky from 700 px up.

## 4. Claim ledger

### 4.1 Facts (generated, tested)

`node scripts/how-facts.mjs` derives these from the repository and writes `how/facts.json` (`{ facts: { key: { value, source } } }`). The page prints a value as `<span data-fact="key">value</span>`, a link as `data-fact-href="key"`, a meta tag as `data-fact-content="key"`. `tests/how.page.test.js` fails if any printed value differs from the repository, a key is unknown, or `facts.json` is stale. Counts that change with every commit are published as round lower bounds ("130+"), so the page stays true, and the test quiet, until a boundary is crossed. A digit that is not a fact (outside the structural section, step and level numbers and "Fig. N") fails the test.

| Key | Value today | Source |
|---|---|---|
| `version` | package version | `package.json` |
| `license` | MIT | `LICENSE` |
| `repo.url`, `repo.license_url`, `site.url`, `site.og_image` | links | `package.json` repository |
| `examples.count`, `examples.levels` | 11, 5 | `js/model/examples.js` |
| `ex.<id>.name`, `.level`, `.learn`, `.stations`, `.vehicles` | per example | the registry and `build()` |
| `level.<n>.title`, `.caption` | the five levels | `js/ui/examples-gallery.js` |
| `vehicle.presets` | 4 | `FLEET_PRESET_ORDER` |
| `speed.min`, `speed.max` | 1, 1200 | `js/ui/runner.js` SPEEDS |
| `grid.max` | 320 | `GRID_LIMITS` |
| `trucks.pallets`, `trucks.checkin_min` | 24, 5 | `TRUCK_DEFAULTS` |
| `code.files.floor`, `code.lines.floor`, `code.model.floor`, `code.sim.floor`, `code.ui.floor` | lower bounds | `js/**/*.js` |
| `tests.files.floor`, `tests.golden` | lower bound, exact | `tests/*.test.js`, `tests/fixtures/golden/*.json` |
| `code.deps` | 0 | `package.json` dependencies |

### 4.2 Claims without a number, and where they come from

| Claim on the page | Source in the repository |
|---|---|
| Roads, one-way lanes, slow zones; Goods in, Workstation, Storage, Goods out, Parking and charging; undo; the baseplate grows | README "What you can do" |
| Flows: share, consumption per cycle, batch size, priority; trucks on a rate or a pasted timetable, gate, doors | README, `docs/WAREHOUSE-DESIGN.md` |
| Fleets: speed, acceleration, capacity, load time, batteries and chargers, breakdowns, parking; any free vehicle serves any flow, nearest, oldest or balanced | README "How the model works", `js/model/defaults.js` |
| Collision-free traffic with junction blocking, reversing at dead ends, deadlock detection | README, `docs/ARCHITECTURE.md` 5.2 |
| What-if changes apply while it runs | README "Simulate" |
| KPI dashboard, per station and per fleet, plain-language findings, heatmap, Jobs overlay | README "Understand" |
| Statistics panel: counting rules behind an (i); vehicle routes drawn (width = trips, colour = time lost waiting, dashes = empty runs); "indicative" when too short | README "Statistics on click" |
| Variants, repeated runs, sweeps, the coach, HTML / print / PDF report, PNG, JSON, share link | README "Decide", "Get guidance" |
| Same plant and seed give the same results; golden tests pin the example plants | README "How the model works", `tests/sim.golden.*` |
| One seeded generator, forked per subsystem | `js/sim/engine.js` (`rng.fork`) |
| The engine has no DOM and runs in Node and the browser | README, `docs/ARCHITECTURE.md` 3 |
| No build step, no runtime dependency; an import checker; fast and heavy test tiers; a test proves every test file runs in one job | README "Develop", `scripts/check-imports.mjs`, `tests/test-tiers.test.js` |
| The planner shows its version, says when a newer one is live, never reloads by itself, stamps reports | README "Versioning" |
| Not built: order picking (M6 stretch, not scheduled); racks, shifts, demand profiles (M2, M3 on the roadmap); pedestrians and traffic lights; multi-site | `docs/WAREHOUSE-DESIGN.md` 9, README "Known limits" |
| Trucks are events at a door; Chromium only; very large plants slow; experiments on the main thread | README "Known limits" |
| This page loads nothing from other sites, sets no cookies; numbers are generated and tested | `tests/how.page.test.js` (static) and `tests/e2e/how.mjs` (request log in a browser) |
| "Moving a brick takes a second, and a simulated shift takes seconds of computing time (the demo above measures it on your machine)" | the demo's *Run a whole shift* button reports the measured wall time (7 below); the sentence has no number |

### 4.3 What the page never says

No customers, quotes, logos, awards, benchmarks against competitors, savings or ROI percentages, "x times faster" without a measurement shown live, uptime or user counts. The test rejects digits, `%`, currency signs and the words ROI, customer, award, testimonial in the prose.

## 5. Visual system

* **Tokens.** `../css/tokens.css` first, then `css/page.css`. Page tokens (`--page-max: 1180px`, `--gutter`, `--sec-y`, `--grid-line`, `--plate`, `--road`, `--tick`, `--em-a/b`) are redefined for dark. `.sec--dark` and `.foot` redefine the planner's dark values locally.
* **Contrast.** All text meets WCAG AA in light and dark (scripted check over every text node, large text at 3:1); accent text uses `--accent-text`, buttons `--accent-solid` with white text. The gradient in the hero's second line runs from `--accent-text` to a violet that stays above 3:1 at its large size.
* **Layout.** One column, `max-width 1180 px + gutters`, a 12-column feeling made of 2- and 3-column grids that collapse below 820 to 940 px. Section rhythm `clamp(64px, 9vw, 120px)`. Alternation: hero (grid), problem (surface), how (page), **live (dark)**, evidence (page), decide (surface), value (page), examples (surface), **craft (dark)**, limits (page), closing (surface with grid), **footer (dark)**.
* **Components.** Buttons (min 44/48/56 px, primary / ghost), chips, question cards with a ghost "?" , step blocks with an outlined numeral, figures with crop marks, a dashed "annotation" box, brick-shaped layer cards with studs, a six-cell figures strip, two-column limits cards.
* **Motion.** Only the hero: vehicles drive the loop (CSS `offset-path`, transform only) and the flow arrows march. Both exist only under `prefers-reduced-motion: no-preference`; otherwise the vehicles stand at fixed spots and nothing moves. Anchor scrolling is smooth only in the same case. No scroll-driven reveal (a skipped section must never be invisible).
* **Preferences.** `prefers-color-scheme` (both themes), `prefers-contrast: more` (text colours to full, borders to `--text-dim`), `forced-colors: active` (no gradients or crop marks, system colours for buttons, solid headline), print (light, links spelled out with their URL, no demo, no sticky header, cards do not split).
* **Touch.** Every control and link target is at least 44 px high; the nav row scrolls inside itself.
* **Stability.** All images carry width and height and sit in boxes with a fixed aspect ratio (`16 / 10`; ladder thumbnails `8 / 5`); the demo frame reserves its still's box until the demo takes over.

## 6. Visuals (owner: VISUALS, except the hero SVG)

The hero SVG and the page's CSS graphics (crop marks, studs, grids) are the lead's and live in `how/index.html` / `page.css`. Everything below is `how/img/*`, produced by `scripts/capture-how.mjs` from the real app (fixed seeds, fixed viewport, fixed simulated time, no wall-clock content), optimised without external tools (in-browser canvas WebP is fine), with a manifest `how/img/manifest.json`.

Naming: `<slot>.light.webp` and `<slot>.dark.webp` (the page picks one by `prefers-color-scheme`); the page already references them. Provisional files made by the lead for layout review are in `how/img/` (full-window screenshots of *Two lines + warehouse*; several slots are still identical); **VISUALS replaces all of them** and owns the folder from now on.

| Slot | Size | Shows (stage it; **crop to the relevant region**, the page shows it about 600 to 700 px wide, so UI text in a full window is unreadable) | Alt text now in the HTML |
|---|---|---|---|
| `build` | 1600 x 1000 | Editor with the tool palette, a plant with roads, bricks and flow arrows, the details panel | "The LogiPlan editor: a palette of road and station tools on the left, a plant on the baseplate with roads, coloured station bricks and flow arrows, and a details panel on the right." |
| `flows` | 1600 x 1000 | A workstation selected with its in and out arrows and the Flows panel (share, batch, priority) | "A workstation selected on the plan, with its incoming and outgoing flow arrows and the flows panel listing share, batch size and priority." |
| `fleet` | 1600 x 1000 | The Fleet tab of a forklift fleet next to the plan | "The Fleet tab: a forklift fleet with its speed, capacity, load time, battery and parking settings next to the plan." |
| `run` | 1600 x 1000 | The same plant running at a fixed simulated time: vehicles on the roads, a queue before a station, the KPI strip | "The plant running: vehicles on the roads, loads queuing in front of a workstation, and the key figures along the top of the window." |
| `results` | 1600 x 1000 | Results tab: KPIs and an insight naming the bottleneck | "The Results tab: throughput, lead time, work in progress and utilisation, with a plain-language finding that names the bottleneck." |
| `traffic` | 1600 x 1000 | Traffic heatmap overlay on a busy plant | "A traffic heatmap laid over the plan: the busiest and most blocked road cells glow in warm colours." |
| `stats` | 1600 x 1000 | A vehicle selected, its routes drawn, the Statistics panel with where its time goes | "A vehicle selected on the plan, its usual routes drawn as lines of different widths, and the Statistics panel showing how its time is spent." |
| `docks` | 1600 x 1000 | Warehouse first day with the doors card (gate wait, door time) | "A warehouse with a truck timetable and dock doors: gate wait, door time and how busy the doors are." |
| `compare` | 1600 x 1000 | Two variants side by side with repeated-run figures | "Two variants of a plant compared side by side with their key figures from repeated runs." |
| `demo-still` | 1600 x 1000, **dark only** (`demo-still.dark.webp`) | The first frame of the demo's default plant exactly as the live renderer draws it (same crop and fit as the demo), also the no-JS fallback | "A still frame of the demo plant: a forklift on a road between a Goods in and a Goods out, with a parking bay." |
| `ex-<id>` for the 11 examples | 640 x 400 | The plan only, as the planner's own preview draws it, centred | decorative (`alt=""`, the name is next to it) |
| `og.png` | 1200 x 630 | Social card: the logo, "Watch your plant run before you build it.", a plan | n/a (meta) |

Budgets: all images together at most 2.5 MB (about 90 KB per large slot, 20 KB per thumbnail); `tests/how.page.test.js` checks the total. Alt texts above must stay true to what the image shows; change both together. If a light and a dark version look the same (plans on a canvas) a shared file is fine; keep the file names.

Hand-drawn SVGs (VISUALS may add, under the page's rules: no scripts, no external references, colours from CSS custom properties or a `prefers-color-scheme` block inside the file, `aria-hidden` or a `<title>`, each under 8 KB): `route-legend` (how to read the drawn vehicle routes), `dock-diagram` (truck, gate, door, forklift), `variant-diagram` (before and after of two variants). The page has HTML comments `<!-- slot:route-legend -->`, `slot:dock-diagram`, `slot:variant-diagram` where a figure may be inserted; VISUALS edits `how/index.html` only at those markers, and keeps `tests/how.page.test.js` green (alt, width, height, lazy, no digits in the prose).

## 7. The live demo (contract, owner: DEMO)

**Mount.** The page provides:

```html
<div class="demo" data-mount="demo" data-demo="hello-pallet">
  <figure class="demo__still" data-demo-fallback> ...the still picture (img with width, height, alt)... </figure>
  <noscript><p class="demo__note">...</p></noscript>
</div>
<script type="module" src="js/demo-boot.js"></script>   <!-- the only script of the page -->
```

* `how/js/demo-boot.js` is tiny, imports nothing, and loads `./demo.js` with `mountDemo(mount)` when the mount is within 900 px of the viewport (IntersectionObserver). On `file:` or without IntersectionObserver or canvas it leaves the still and adds `<p data-demo-note>`; the page styles `[data-demo-note]` and `.demo__note`.
* `mountDemo` builds everything else inside the mount (`.lp-demo`: controls, panes, figures, text equivalent), hides `[data-demo-fallback]` when the first frame is drawn (and shows it again on failure), and loads its own style (`how/css/demo.css`). The mount is dark in both themes (it sits in the dark band): use the tokens that band defines. The frame (border, radius, shadow, background) is the page's.
* The plant is chosen with `data-demo="<example id>"` on the mount; the still must show that plant's first frame.

**Behaviour required (acceptance H14).** The real engine (`js/sim/engine.js`, `js/model/examples.js`, the planner's renderer without its DOM); every figure from `sim.report()`/kpis, none invented, each labelled with what it counts; deterministic seed; starts only near the viewport; stops off screen and when the tab is hidden; a governor that drops simulated seconds, never frames, and says so; under `prefers-reduced-motion` it starts paused on a still frame with a Play button; Play/Pause, speed, restart, "change one thing" (the demo changes the vehicle count only, for example one more forklift, with the real before and after figures; the demand of Hello, pallet is fixed at twice the example) and **"Run a whole shift"** (reports the measured wall time on the visitor's machine, the only speed figure the page may show) are keyboard operable with 44 px targets; a text equivalent that is updated sparingly (not an aria-live stream); failure shows the still and a plain sentence. The demo script graph stays at or under 400 KB uncompressed on top of the engine modules shared with the app. No change to `js/sim`, `js/model`, `js/ui`: a missing seam is an open issue in the report.

## 8. File ownership

| File | Owner |
|---|---|
| `how/index.html`, `how/css/page.css`, `docs/HOW-PAGE-DESIGN.md`, `scripts/how-facts.mjs`, `how/facts.json`, `tests/how.page.test.js` | LEAD (page) |
| `how/js/*`, any `how/css/demo*.css`, `tests/how.demo.test.js` | DEMO |
| `scripts/capture-how.mjs`, `how/img/*`, `how/svg/*`, `tests/how.visuals.test.js` | VISUALS (edits `how/index.html` only at the `slot:` markers, and the `<img>`/`<picture>` attributes of images it re-cuts) |
| `tests/e2e/how.mjs`, the link from the app to the page (`js/ui/about.js` or the Help text, one line, test updated), `README.md`, `CHANGELOG.md` ([Unreleased]), the `package.json` scripts (`how:facts`, `capture:how`; never the version), serve redirect of `/how` | INTEG |
| `scripts/build-site.mjs` (copies `how/`), its check in `tests/how.page.test.js` | LEAD (done) |
| Everything else (app, engine, tests, golden fixtures) | unchanged |

## 9. Acceptance H1 to H15

| # | Item | How it is checked | Owner |
|---|---|---|---|
| H1 | Every number is a fact; the ledger is complete | `tests/how.page.test.js` (facts, digits) | LEAD |
| H2 | What is not built is on the page; no invented customers, quotes, logos, awards, benchmarks, ROI | section 09; test words; review | LEAD |
| H3 | No request leaves the origin; no cookies, storage, fonts, third-party anything | static test; browser request log (e2e) | LEAD, INTEG |
| H4 | Works under any path prefix (`/` and `/<repo>/`) | links and imports relative; e2e serves the site under a prefix | INTEG |
| H5 | Works without JavaScript for reading: all copy, the still instead of the demo | e2e with JS disabled | LEAD, INTEG |
| H6 | One h1, landmarks, heading order, skip link, visible focus, real alt text, the nav is named | static test; e2e keyboard walk | LEAD |
| H7 | WCAG AA in light and dark; prefers-contrast and forced-colors do not break it | scripted contrast over all text; screenshots in both | LEAD |
| H8 | `prefers-reduced-motion`: nothing moves by itself; the demo starts paused | screenshots with reduced motion; e2e | LEAD, DEMO |
| H9 | 320 px to 4K without horizontal scroll; targets of 44 px; a sensible print copy | e2e at 320, 390, 768, 1024, 1440, 3840; print emulation | LEAD |
| H10 | No layout shift | CLS measured over a scroll through the page | LEAD, DEMO |
| H11 | Critical path (HTML + CSS) gzip at most 150 KB, images at most 2.5 MB, demo graph at most 400 KB uncompressed | static test (first two); e2e (third) | LEAD, VISUALS, DEMO |
| H12 | Long tasks under 50 ms while scrolling; the demo idle off screen | e2e with a long-task observer, throttled CPU | DEMO, INTEG |
| H13 | No console error or warning, no failed request | e2e | INTEG |
| H14 | The demo: real engine, real figures, keyboard, pause, text equivalent, determinism, governor | `tests/how.demo.test.js` and e2e | DEMO |
| H15 | Real, reproducible screenshots; the site assembles with `how/`; the app links to the page and the page to the app | `tests/how.visuals.test.js`; `tests/how.page.test.js` (site); e2e | VISUALS, LEAD, INTEG |

## 10. Known gaps at hand-over

* (closed) `scripts/serve.mjs` now redirects `/how` to `/how/` like Pages and serves `.webp`.
* `how/img/*` are provisional full-window screenshots until VISUALS replaces them.
* The page was checked by reading screenshots at 1440, 1024, 768 (reduced motion), 390 and 320 wide in light and dark; no other browser than Chromium was used.
