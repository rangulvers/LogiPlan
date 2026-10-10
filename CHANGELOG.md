# Changelog

What changed in LogiPlan, newest version first, written for the people who plan with it. The same list is shown in the app: click the version
number at the bottom right of the window. The format follows [Keep a Changelog](https://keepachangelog.com/): each version has a date and its
changes under **Added**, **Improved** and **Fixed**; what is not released yet is collected under **Unreleased**.

LogiPlan gave itself no version number in its first days. The versions below 0.6.0 were assigned afterwards, one per merged step of the project, so
that the history can be read. How to cut a new version is described in the README under *Versioning*.

## [Unreleased]

### Added
- **A page that explains LogiPlan: "How LogiPlan works".** It lives next to the planner (`/how/`) and is linked from the version dialog. It tells the story
  from the problem to a decision, shows real screenshots of every step and has a live simulation of an example plant that runs the planner's own engine in
  your browser: play, pause, switch on a second forklift and compare, or run a whole shift and see how long your machine needs. Every figure on it is
  generated from the project or read from the running simulation, and it says plainly what the planner does not do yet. It sets no cookies and loads
  nothing from other sites.
- **Six new examples, from very simple to a two-plant campus.** The examples window is now a ladder in five levels. New: *Hello, pallet* (one forklift),
  *Charging corner* (six electric forklifts), *Yard shuttle* (one truck over 280 metres), *Morning peak* (a cross-dock on a timetable),
  *Components plant* (three kinds of vehicle) and *Two plants, one yard* (two plants on one baseplate that share a warehouse and a charging hall; one
  plant model, not a multi-site one). Open an example and press *Things to try*, or use the new **Examples** tab in Help: every number there was measured.
- **Click any item to see its statistics.** Click a workstation, Goods in, storage, Goods out, depot, flow, road cell, fleet or several items and a
  **Statistics** panel opens over the bottom of the plan with six numbers. Each has an (i) that says exactly how it is counted. The panel shows
  *Since start* or *Last 30 min*, says how long it has measured, and calls anything under 20 minutes *indicative*. It opens when your click ends on an
  item and never in the middle of a drag, so the plan does not move under your pointer. **I** shows or hides it, **[** and **]** step to the previous or
  next item of the same kind, **Esc** closes it. On a phone it is a sheet with three heights.
- **Click a vehicle to see where it goes.** A vehicle can now be selected on its own (or chosen in the *Fleet* tab). The panel shows where its time
  goes (driving loaded, empty, to a depot, waiting in traffic, in a dock queue, loading, unloading, no job, parked, charging, broken), where it is held
  up (the docks it queues for and the junctions that block it), its usual trips with the docks they use, its usual round and a few plain sentences,
  including a labelled estimate of whether the fleet needs this vehicle.
- **The routes of a vehicle are drawn on the plan.** Line width shows how often a trip is driven, colour how much time is lost waiting, dashes
  mark empty drives and drives to a depot. Hover a trip in the panel to see just that route. The *Routes on plan* switch and the *Routes* chip of the
  overlay bar turn them off.
- **New settings in Simulate.** *Collect statistics for clicked items* (on) and *Statistics on click*: when the simulation has data (default),
  always, or never. Statistics only count while the collector is on; it changes none of the numbers in Results.
- **Help explains every counting rule** in the new *Statistics* page.
- **The version is shown in the app.** The number of the running version and the short code of its build (for example *v0.6.0 a45ce49*) sit at the bottom
  right of the window. The number changes with a release, the code with every update of the site. Click it to see which build you are using and when it
  was made, to copy that information for a bug report in one click, and to read this list of changes. When the window is too small for the bottom line,
  the *More* menu has the same window, and so does the Help window (*About and what is new*).
- **A hint when a newer version is available.** If the site has been updated while your page was open, the version number gets an *Update* mark
  (and the *More* button a dot) and the About window a Reload button. LogiPlan never reloads by itself, so a running simulation or an edit is never
  interrupted. *Reload now* keeps your plant, which is saved in this browser first, and fetches the new files even if the browser still holds old ones;
  a running simulation, its results and the undo history start again.
- **Reports say which version made them.** The footer of the HTML report names the version of LogiPlan that created it.

### Improved
- **Typing a time in the truck timetable or the plant clock** no longer restarts the simulation with every digit; the time is applied when you have
  finished typing it.
- **Run one day and Run one week** tell you more honestly how long they take on this kind of plant, and that they also set the run length of the plant.
- **Switching a Goods in or Goods out to a timetable keeps your trucks.** The trucks of the rate become the rows of one day, so the plant receives the
  same load until you edit the rows, paste your own or remove them.
- **Pasting from English Excel works.** Times such as 6:00 AM and 06:00:00 are read, and a time that cannot be read says what to change in the
  spreadsheet (for example a time copied as the number 0.25, which is how Excel stores 06:00).
- **A plant with a timetable explains what an edit does.** The simulation starts again at the start of the clock, a line says that the time of day
  matters and opens Experiments, and comparisons start from whole days.
- **The gate chip and the number of doors stay visible when you zoom out**, also on stations that are only two cells high.
- **Remove trucks offers Undo**, and the trucks section says where the demand setting enters its numbers and when doors beyond the road cells of a
  station cannot be unloaded any faster.

### Fixed
- **Delete and Backspace on a button, tab or link** (for example the delete button of a timetable row) no longer delete the station that is
  selected on the plan.
- **Typing a number above the limit in the Doors field** (33 doors) ends at the limit instead of at the first digit you typed, and a very long
  station name wraps inside a message instead of running out of it.
- **A pasted row without an arrival time** (an empty cell before the number of pallets) says so instead of calling the pallets a bad time.

## [0.6.0] - 2026-10-09

### Added
- **Two new examples** in the gallery. *Dock lab* shows one street with three docks and why docks in a row cannot share the work; *Warehouse: first day*
  is a small warehouse with a truck timetable, doors and forklifts that you can run for a whole day.

### Improved
- **Add dock doors on a Goods out** sizes the trucks to what the plant really shipped in your last run (when there was one), and the message says so.
  Without a run the trucks leave short if the plant ships less than the default, and the message says that too.
- **The door check is honest about its assumption.** A line under it says that 90 seconds per pallet is only an assumption until a run has measured the
  real door time, which your vehicles set.
- **The Doors card** shows how many trucks arrived only when that is a meaningful figure, says how many were turned away or did not come, and no longer shows
  a gate wait of under a second as if it were a delay.
- The wording of the door check and of the messages about trucks was revised.

## [0.5.0] - 2026-10-09

### Added
- **Trucks and dock doors.** Give a Goods in or a Goods out dock doors with one button, *Add dock doors*. Trucks arrive at a rate you set or on a
  timetable, wait at the gate, check in, are unloaded or loaded by your forklifts and AGVs, check out and leave.
- **Paste a truck timetable from Excel.** The paste window shows every line it understood and every line it skipped, and changes nothing until you
  confirm. German and English spreadsheets (decimal comma, 06.00, 6:30) are read.
- **A clock for the plant.** A plant can start at a time of day and a weekday, show the time of day in the simulation bar, and run for a whole day or
  a week with one button.
- **Dock doors on the plan.** The doors are drawn on the lower edge of the station, with the trucks at them, and a *Gate* chip shows how many trucks
  wait and for how long (amber from 15 minutes, red from 45).
- **Results for the doors.** A Doors card per station shows the wait at the gate, the time a truck needs at the door, how busy the doors are and
  whether the doors or the forklifts are the limit.
- **Checks for docks and doors** with one-click fixes: *Use N doors*, *Add a row* to the timetable, and a warning when the docks of a station lie in
  a row on one road and cannot share the work.
- **A Help page** about trucks and dock doors.

### Improved
- The report lists the truck settings of every station and the door results.

## [0.4.0] - 2026-10-09

### Improved
- **Preparation for the warehouse features.** Plants, project files and share links have room for what comes next, and your existing plants keep giving
  exactly the same results as before: the three examples give the same numbers to the last digit.
- **A project file says which version of LogiPlan it needs.** A file that uses nothing new still opens everywhere without a message. A file that needs
  a newer version is recognised by an older copy (for example a browser tab that was opened before an update), which tells you that newer details may be
  missing, as LogiPlan already did, instead of silently leaving them out.

## [0.3.0] - 2026-10-09

### Added
- **Roads stay straight while you draw.** In the *Smart* drawing mode a wobble of your hand makes no jog in the road and a clear turn makes exactly one
  corner. Hold **Shift** for one perfectly straight line, and Shift-click to carry on from the end of the last road. The *Draw* switch over the plan lets
  you choose Smart, Straight or Free.
- **The plan grows with your work.** Draw or place something beyond the edge of the plan, or click a **+** on an edge, and it extends by blocks of 8 cells,
  up to 320 x 320 cells. *Properties > Plant settings* also has Extend and *Trim to content*.
- **A licence.** LogiPlan is free to use, copy and change under the MIT licence.

### Improved
- **Vehicles choose a free dock first.** At a Goods in or Goods out with several docks, a vehicle now drives to the dock where it can start soonest, so
  a free dock wins over a busy one that is only a little closer. Before, every vehicle went to the same dock and queued while the others stood free.
- **Findings about docks.** Results list how busy every dock of a station was, and the findings say when vehicles queue for docks that are always busy,
  when idle vehicles block a dock, and when one dock does all the work.

## [0.2.0] - 2026-10-08

### Added
- **Next steps.** A coach tells you what the plant still needs, for example *"Goods in 2 is not connected yet - where should its loads go?"*, with a
  one-click fix. It shows at the top of the Properties, Flows and Fleet tabs, as a small chip over the plan (*2 steps to finish*) and as a Getting
  started checklist.
- **A handle to connect stations.** Select a station and drag from its handle to another station to create a flow; valid targets light up while you drag.
  Right after you place a station, a message offers to connect it.
- **Who serves which flow.** Every station says where its loads go and where they come from; every fleet says which flows it serves and can be set to
  serve one flow only; every flow says which fleets serve it.
- **The Jobs overlay.** While the simulation runs, a line from each vehicle shows where it is heading, and a badge on a station shows how many loads wait
  for pickup.
- **Instant feedback on edits.** Change the plant after a simulation has run and LogiPlan quietly runs the new plant ahead, so you do not wait for a
  fresh start. An *Effect of your change* card in the Results tab sets the figures before and after side by side (throughput, lead time, work in progress,
  utilisation, time in traffic). It compares the old and the new plant over the same stretch of time with the same random numbers, so a change that cannot
  matter reads exactly zero, and it colours a figure only when it moved by more than the run-to-run noise.
- **Keep as baseline** and **Compare properly**: make the old plant the reference of the next edit, or add it as a variant and compare both over several runs.
- **Findings about unused resources**: a fleet that hardly works, a vehicle that is mostly idle, a Goods in nobody collects from, a station that is never used.
- **Help: how vehicles find work.** One page that explains that vehicles are not tied to stations and how several flows share the same vehicles.

### Improved
- Messages after placing or connecting something say what happened and what it means for the plant, for example that a workstation with two inputs needs
  a load from both before every cycle.
- Station names are shortened legibly when you zoom out.

## [0.1.0] - 2026-10-08

### Added
- **The first usable LogiPlan.** Build a plant on a Lego-style baseplate in the browser: two-way and one-way roads, slow zones and walls, and bricks for
  Goods in, Workstations, Storage, Goods out and Parking and charging. Undo and redo, multi-select, move, resize and duplicate.
- **Material flows.** Draw arrows between stations to say where loads go next, in what share, how many a process uses per cycle, in what batches and with what
  priority, and optionally limit a flow to one fleet.
- **Vehicle fleets.** AGVs, forklifts, tugger trains or your own type, with speed, acceleration, length, capacity, load and unload time, batteries and charging,
  breakdowns and parking.
- **A live simulation** from 1x to 1200x with collision-free traffic: vehicles queue at junctions, reverse at dead ends, and deadlocks are detected. Machines and
  vehicles can break down. What-if sliders for demand, vehicle speed and process time work while it runs.
- **Results you can read.** A dashboard with throughput, lead time, work in progress, vehicle utilisation and time stuck in traffic, per-station and per-fleet
  views, a traffic heatmap, and plain-language findings such as *"Final assembly is the bottleneck: busy 96 % while 8 loads wait in front of it."*
- **Variants and experiments.** Keep several variants of a plant (A, B, C), compare them side by side with repeated runs, and sweep one setting to answer
  questions like *"how many AGVs do I need?"*.
- **Share and export.** A self-contained HTML report (also for print and PDF), a picture of the layout (PNG), the project as a file, and a link that carries
  the whole plant. Your work is saved in your browser automatically.
- **Three examples to start from:** the Starter plant, Two production lines with a warehouse, and the Congestion lab.
- **Light and dark colours, keyboard shortcuts, a Help window and a layout for narrow screens** with the details panel as a drawer.
