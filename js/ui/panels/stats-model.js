// The view-model of the Statistics dock (docs/ENTITY-INSIGHTS-DESIGN.md 3, 4.1, 5 and 2.3 to 2.6; MODEL part of S1).
//
// PURE: no DOM, no timers, no randomness. It turns what the simulation can say about ONE selected item (the KPI report, the insights and, for a
// vehicle, the optional collector sim/detail.js) into plain data: six numbers, the blocks under them, the sentences, the honest labels of the window.
// It is the only place with sentences. stats-view.js draws the data; stats-dock.js (the shell) calls `buildStatsModel` on every refresh and keeps the dock.
//
//   buildStatsModel(input) -> model | null
//     input = { selection: { kind, ids }, layout, runner?, sim, detail, report, insights, window: 'start' | 'last30', routes: boolean, state, narrow,
//               now?: number (ms; the clock of the small caches, default Date.now()), factMemory?: Map (the memory of the hysteresis, default one per simulation) }
//       sim = the Simulation (null before the first play); detail = sim.detail (the collector, null when switched off or dropped); report = sim.kpis();
//       insights = sim.insights(). Nothing else is read: a stand-in with these fields (tests/helpers/stats-fixtures.js) works.
//     null only for an item kind that has no dock (walls, labels); every other selection answers a model (a "waiting" or "gone" one when there is nothing to say).
//
//   model = {
//     signature, kind, variant,    signature changes only when the view's DOM has to be rebuilt (another item, another layout of tiles or blocks)
//     status: 'ready' | 'waiting' | 'gone',   'waiting': nothing measured yet ("Press play to see statistics": the tiles show a dash); 'gone': the item is not in the run
//     statusText,                  the sentence for a status that is not 'ready'
//     header: { live: { tone, strong, rest } },   chip / title / crumb are left to the shell (it knows the item); `live` is the line next to the title
//     ariaLabel, announce, bounds, windows: { last30, note }, routes,       the fields stats-dock.js reads (docs/ARCHITECTURE.md 6.12)
//     window: { kind, seconds, text, since, indicative, equalsStart, late },   what was measured, in words (rule "honest windows")
//     tiles: [ tile x 6 ],         tile = { id, label, def, value, unit, ref: { text, arrow, good }, tone, raw, share, since }
//     blocks: [ block ],           block = { id, type: 'time' | 'facts' | 'trips' | 'docks', title, aside, ... } (see the builders)
//   }
//   Text the shell shows in its header: `live`. Everything in `blocks` and `tiles` is the view's.
//
// THE FOCUS ID OF A ROUTE (the contract with js/ui/render/routes.js). stats-view.js tells the shell which route the planner hovers, focuses or pins with
// `host.focusRoute(id, { pinned })`, the shell publishes it as `renderer.view.stats.focus = { id, pinned }`, and the overlay draws that route strong and
// dims the others to 28 %. The id is `routeFocusId(kind, fromStationId, toStationId)`:   'loaded:s4>s5'  (a loaded trip, every drawn way of it),
// 'empty:s4>s5' (the empty drive to a pickup), 'depot:s4>s8' (to a depot or charger), and 'round' (the usual round of the selected vehicle: its two usual
// trips numbered 1 and 2 and the empty drive between them dashed). parseFocusId(id) is the inverse. The ids are station ids, not collector indices, so
// they survive a restart. The overlay may import both functions: they are pure.
//
// THE WINDOWS (docs/ENTITY-INSIGHTS-DESIGN.md 3.0). 'start' is the collector's window (it starts at the end of the warm-up, or when the planner switched
// the statistics on: then the dock says "counting since 0:50"); 'last30' is the last 30 minutes (equal to 'start' until 30 minutes were measured, and
// it says so). Only vehicles have a 30-minute version in this step; every other kind says `windows.last30 === false` and the shell shows 'start'.
// A printed share never exceeds 100 %, never NaN, never Infinity (every number goes through the formatters below; a test scans every view-model).
//
// WHAT IS NOT HERE (S2 and S3): the full pages of the other kinds (their tiles are the report's numbers), the lead-time chain, the yard of a Goods in, the
// plant overview, the measured what-if, copy as table.

import {
  BATTERY_LOW, BLOCKED_SHARE, BOTTLENECK_UTILIZATION, EMPTY_DRIVING_SHARE, FLEET_CRITICAL_UTILIZATION, FLEET_PICKUP_WAIT, FLEET_TARGET_UTILIZATION, STARVED_SHARE, TRAFFIC_WAIT_SHARE,
  UNUSED_MIN_WINDOW, congested, fleetWaitShare,
} from '../../sim/insights.js';
import { formatTimeOfDay, makeClock } from '../../model/calendar.js';
import { isDayPlant } from '../day-plant.js';

export { congested, fleetWaitShare };

// ---------------------------------------------------------------------------------------------------------
// Thresholds (named here when insights.js has no rule of its own; docs/ENTITY-INSIGHTS-DESIGN.md 3.0)
// ---------------------------------------------------------------------------------------------------------

export const MIN_LEGS_FOR_USUAL = 5; // complete legs before a pair has a usual route
export const USUAL_SHARE_CLAIMED = 0.5; // "usual" only when one path carries at least half of a pair's drawable trips; else "N ways"
export const VARIANT_DRAWN_SHARE = 0.1; // a way of a pair is drawn from this share of its trips
export const WAIT_SHARE_NOTABLE = 0.05; // "held up" is said from 5 % of the window ...
export const WAIT_NOTABLE_SECONDS = 60; // ... and at least this many seconds
export const QUEUE_SHARE = 0.4; // a place is named when it holds this share of the held-up time
export const EMPTY_SHARE_NOTABLE = EMPTY_DRIVING_SHARE; // empty metres, said from this share: the insights' 60 % (a shuttle between two stations already drives about 50 % empty, which is no finding) ...
export const EMPTY_NOTABLE_METRES = 200; // ... and this many metres driven
export const DEPOT_DRIVE_SHARE = 0.08; // driving to park or charge, said from this share of the time ...
export const DEPOT_DRIVE_MIN = 3; // ... and this many drives
export const NEED_NEEDED_FROM = 0.9; // fleet question: the others would have to work this much: "needed"
export const NEED_BORDERLINE_FROM = FLEET_TARGET_UTILIZATION; // ... this much: "borderline"
export const NEED_AVAILABLE_MIN = 0.5; // fleet question: at or below this share of the time in service (not charging, broken or dead) the vehicles cannot take work over, and no verdict is spoken
export const STORAGE_STEADY = 0.25; // Little's law for a storage: withdrawn when the stock changed by this share of its mean over the window
export const GATE_NONE_SECONDS = 1; // "no truck waited at the gate" only when the longest wait was below this
export const HYSTERESIS = 0.85; // a fact goes when its value falls below this share of its threshold (the value, not the time, decides)
export const VERDICT_MIN_SECONDS = 10 * 60; // no sentence about a share from less than 10 minutes measured
export const INDICATIVE_BELOW = UNUSED_MIN_WINDOW; // below 20 minutes measured every verdict is called indicative
export const LAST30_SECONDS = 30 * 60;
export const NEEDED_MIN_WINDOW = UNUSED_MIN_WINDOW; // the fleet question needs 20 minutes
export const ARROW_MIN_SHARE_POINTS = 0.03; // an arrow next to a peer value: shares need 3 points ...
export const ARROW_MIN_RELATIVE = 0.12; // ... and 12 % of the peer value
export const ARROW_SIGMAS = 2; // a rate from a count needs two standard deviations of the count ...
export const ARROW_MIN_COUNT = 20; // ... and this many counted events
export const WAIT_TONE_SOME = 0.06; // a trip row is amber from this share of the trip lost to waiting, red from the next
export const WAIT_TONE_MUCH = 0.15;
export const RAMP_MIN = 0.08; // the colour ramp of the routes: its red end is the 90th percentile of the shares drawn, in 5 % steps, between these
export const RAMP_MAX = 0.3;
export const TOP_TRIPS = 3; // trip rows shown
export const HELD_ROWS = 4; // where-it-is-held-up rows before "Other places"
export const FACTS_MAX = 4;
export const SHARE_EPS = 1e-9;
/** "No station" in the station columns of the collector (a waiting place on the road); the same number as js/sim/detail.js NO_STATION. */
export const NO_STATION = 0xffff;

// ---------------------------------------------------------------------------------------------------------
// Numbers and words. Everything printed goes through these: no NaN, no Infinity, no share above 100 %.
// ---------------------------------------------------------------------------------------------------------

const DASH = '–';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const n0 = (x) => (isNum(x) ? x : 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const safeDiv = (a, b) => (isNum(a) && isNum(b) && b > 0 ? a / b : 0);
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** A number with thousands separators and `d` decimals; a dash for anything that is not a finite number. */
export function num(x, d = 0) {
  if (!isNum(x)) return DASH;
  const f = 10 ** d;
  const r = Math.round(x * f) / f;
  return (r === 0 ? 0 : r).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** A share (0..1) as "73 %": never above 100 %, never below 0, a dash for a non-number. */
export function pct(x) {
  if (!isNum(x)) return DASH;
  return `${clamp(Math.round(x * 100), 0, 100)} %`;
}

/** Seconds as a duration: "45 s", "12.4 min" (below 10 min with a decimal), "2 h 6 min". */
export function duration(s) {
  if (!isNum(s)) return DASH;
  const a = Math.max(0, s);
  if (a < 90) return `${Math.round(a)} s`;
  if (a < 5400) return `${num(a / 60, a < 600 ? 1 : 0)} min`;
  const m = Math.round(a / 60);
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A short span for a trip: "62 s", "1.5 min", "12 min". */
export function secs(s) {
  if (!isNum(s)) return DASH;
  const a = Math.max(0, s);
  if (a < 90) return `${Math.round(a)} s`;
  const m = a / 60;
  return m < 10 ? `${num(m, 1)} min` : `${Math.round(m)} min`;
}

/** "23:51 min" for a wait of that many seconds. */
export function mmss(s) {
  if (!isNum(s)) return DASH;
  const a = Math.max(0, Math.round(s));
  return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')} min`;
}

export function metres(m) {
  if (!isNum(m)) return DASH;
  return m >= 1000 ? `${num(m / 1000, 1)} km` : `${Math.round(Math.max(0, m))} m`;
}

/** The simulation clock is a float sum of ticks (a start at 3000 s reads 2999.999999998): a minute is read from the time plus this much, so 50:00 is not "49". */
const CLOCK_EPS = 1e-6;

/** Elapsed simulation time as "0:50" (hours and minutes), the way the simulation bar counts. */
export function clockText(t) {
  const s = Math.max(0, Math.floor(n0(t) + CLOCK_EPS));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/** The time a window began: the time of day of a plant with a clock ("06:10"), else the elapsed time ("0:10"). */
export function sinceText(layout, t) {
  if (layout && isDayPlant(layout)) return formatTimeOfDay(makeClock(layout.calendar).tod(n0(t) + CLOCK_EPS));
  return clockText(t);
}

const oneOf = (n, one, many) => (n === 1 ? one : many);

/**
 * Whole percents of a set of shares so that they add up to exactly 100 (the largest-remainder method) when the shares are the parts of one whole (`total` 1): rounding each one
 * on its own gave 99 or 101 on 22 of 120 vehicle windows. `min`: a share above zero never prints as 0 (the pieces too small to print are left out by the caller before).
 */
export function wholePercents(shares, { total = null, min = 0 } = {}) {
  const xs = shares.map((x) => clamp(n0(x), 0, 1));
  const sum = xs.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return xs.map(() => 0);
  const target = Math.round(clamp(total === null ? sum : total, 0, 1) * 100);
  const out = xs.map((x) => (x > 0 ? Math.max(min, Math.floor(x * 100 + 1e-9)) : 0));
  let left = target - out.reduce((a, b) => a + b, 0);
  const order = xs.map((x, k) => k).filter((k) => xs[k] > 0).sort((a, b) => (xs[b] * 100 - Math.floor(xs[b] * 100 + 1e-9)) - (xs[a] * 100 - Math.floor(xs[a] * 100 + 1e-9)) || a - b);
  for (let k = 0; left > 0 && order.length; k++, left--) out[order[k % order.length]]++;
  const biggest = order.slice().sort((a, b) => out[b] - out[a] || a - b);
  for (let k = 0; left < 0 && biggest.length && k < 1000; k++) { const j = biggest[k % biggest.length]; if (out[j] > Math.max(min, 0)) { out[j]--; left++; } }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The counting rules (the (i) of every number, and the Help page generated from the same table: a test compares them)
// ---------------------------------------------------------------------------------------------------------

/**
 * id -> { label, text }. `label` is the words on the tile, `text` the rule. The windows are added where a tile is made ("Window: since start" ...).
 * Ids: 'vehicle.*' the six numbers of a vehicle, 'vehicleReport.*' the report-only version, 'process.*' 'source.*' 'storage.*' 'sink.*' 'depot.*' 'flow.*'
 * 'fleet.*' 'cell.*' the strip of that kind, 'several.*' the strip of a selection of several, 'block.*' the blocks.
 */
export const DEFINITIONS = Object.freeze({
  'vehicle.trips': { label: 'Trips per hour', text: 'Loaded deliveries this vehicle completed in the window, per hour of the window: the count of the Results tab. The line under it is the average of the vehicle\'s fleet, counted the same way.' },
  'vehicle.busy': { label: 'Busy, incl. waiting', text: 'Share of the window the vehicle spent driving (loaded, empty, or to a depot or charger), held up in traffic or in a dock queue, loading or unloading. Waiting counts as busy: a vehicle stuck in a queue looks busy. No job, parked, charging and out of service do not count. The fleet strip of the Fleet tab counts a drive to a charger as charging and a drive to park as idle, so its figure can differ.' },
  'vehicle.held': { label: 'Held up', text: 'Share of the window the vehicle was held up: driving below half of its free speed because of another vehicle, a junction, a broken-down vehicle ahead, or the queue for a dock. The same quantity as the traffic figure of the Results tab. Coloured from 12 % of the window; the insights use the same number, measured on the moving time of a fleet.' },
  'vehicle.driven': { label: 'Driven', text: 'Distance driven per hour of the window, from the odometers of the Results tab: with a load, empty on the way to a pickup, and to a depot or charger. The three shares add up to 100 %. It is the distance per hour of the window, standing still included, not a driving speed.' },
  'vehicle.loaded': { label: 'Avg loaded trip', text: 'Mean duration of the completed loaded drives: from leaving the pickup (loading done) to arriving at the destination. Loading and unloading are not included and a breakdown\'s repair time is left out; a delivery on the cell the vehicle already stands on counts as a drive of 0 s. The fleet value is the mean of the same quantity over the fleet\'s drives (the transit time of the Results tab includes unloading, so it is longer).' },
  'vehicle.battery': { label: 'Lowest battery', text: 'The lowest charge the battery reached inside the window, and the number of charging sessions that ended in it.' },
  'vehicle.parked': { label: 'Parked', text: 'Share of the window the vehicle stood parked in a depot. This fleet has no battery model.' },
  'vehicleReport.trips': { label: 'Trips per hour', text: 'Loaded deliveries this vehicle completed since the start, per hour: the count of the Results tab.' },
  'vehicleReport.busy': { label: 'Fleet busy', text: 'Share of the time the vehicles of this fleet spent driving, held up, loading or unloading: the utilization of the Results tab. The statistics of single vehicles are switched off, so this is the fleet\'s figure.' },
  'vehicleReport.held': { label: 'Fleet held up', text: 'Share of the time the vehicles of this fleet were held up in traffic (below half of their free speed): the waiting share of the fleet in the Results tab.' },
  'vehicleReport.driven': { label: 'Fleet driven', text: 'Distance one vehicle of this fleet drove per hour on average, from the odometers of the Results tab.' },
  'vehicleReport.loaded': { label: 'Fleet transit', text: 'Mean time from picking a load up to delivering it, including unloading, over the loads this fleet carried: the transit time of the Results tab.' },
  'vehicleReport.battery': { label: 'Fleet lowest battery', text: 'The lowest charge any battery of this fleet reached since the start, from the Results tab.' },
  'process.output': { label: 'Output per hour', text: 'Loads this workstation finished since the start, per hour. The capacity is an estimate: machines times 3600 s divided by the mean cycle time, times loads per cycle, at the current process speed (a factor above 1 makes the cycles longer) and without breakdowns.' },
  'process.busy': { label: 'Busy', text: 'Share of machine time the machines were working (the utilization of the Results tab, a mean over the machines). Sampled once per simulated second.' },
  'process.starved': { label: 'Waits for material', text: 'Share of machine time the machines stood idle for lack of input material (the "starved" figure of the Results tab).' },
  'process.blocked': { label: 'Waits for removal', text: 'Share of machine time the machines could not put their output down because the output buffer was full (the "blocked" figure of the Results tab).' },
  'process.queue': { label: 'Waiting in front', text: 'Average number of loads waiting in the input buffers in front of the machines, and the most there were at once, against the room those buffers have.' },
  'process.wait': { label: 'Parts wait for a vehicle', text: 'How long a finished load waited in the output buffer until a vehicle picked it up, averaged over the flows that leave here, weighted by their trips (the "wait for a vehicle" of the Results tab). A mean over loads that were picked up cannot see a load that is still waiting: "waiting now" counts those.' },
  'source.arrivals': { label: 'Arrivals', text: 'Loads released into this Goods in since the start, per hour. With dock doors the line under it counts the trucks that arrived.' },
  'source.buffer': { label: 'In buffer', text: 'Average number of loads waiting in the output buffer for a vehicle (time-weighted), and the most there were at once, against the buffer\'s capacity.' },
  'source.full': { label: 'Buffer full', text: 'Share of the time the output buffer was full, so that arrivals waited in the yard (the "blocked" figure of the Results tab).' },
  'source.wait': { label: 'Wait for a vehicle', text: 'How long a load waited in the output buffer until a vehicle picked it up, averaged over the flows that leave here, weighted by their trips (the Results tab). A mean over loads that were picked up cannot see a load that is still waiting: "waiting now" counts those.' },
  'source.yard': { label: 'In the yard now', text: 'Loads that arrived but are not yet in the output buffer because it is full, right now, and the most there were at once.' },
  'source.waiting': { label: 'Waiting now', text: 'Loads that are ready in the output buffer and that no vehicle has claimed yet, right now.' },
  'source.doors': { label: 'Doors busy', text: 'Share of the time the dock doors were occupied by a truck, and how many doors the station has.' },
  'source.gate': { label: 'Gate wait', text: 'Mean time a truck waited at the gate for a free door, with the longest wait. "None" is said only when at least one truck took a door and none of them waited a second or more.' },
  'storage.stock': { label: 'In stock', text: 'Average number of loads in the storage (time-weighted), and the most there were at once, against its capacity.' },
  'storage.in': { label: 'In per hour', text: 'Loads that arrived in the storage since the start, per hour.' },
  'storage.out': { label: 'Out per hour', text: 'Loads that left the storage since the start, per hour.' },
  'storage.stay': { label: 'Stays', text: 'An estimate by Little\'s law: the average stock divided by the loads leaving per second. It assumes the stock is steady, so it is withdrawn while the stock grows or falls by a quarter of its average or more over the window. It includes the time a load waits in the storage for a vehicle.' },
  'storage.full': { label: 'Full', text: 'Share of the time the storage was completely full (the "blocked" figure of the Results tab); the line under it is the share of the time it was completely empty.' },
  'storage.wait': { label: 'Wait for a vehicle', text: 'How long a load waited in the storage for a vehicle to pick it up, averaged over the flows that leave here, weighted by their trips (the Results tab). A mean over loads that were picked up cannot see a load that is still waiting: "waiting now" counts those.' },
  'sink.shipped': { label: 'Shipped per hour', text: 'Loads that left the plant through this Goods out since the start, per hour (the throughput of the Results tab).' },
  'sink.share': { label: 'Share of output', text: 'Share of everything the plant shipped that left through this Goods out.' },
  'sink.lead': { label: 'Lead time', text: 'Mean time from the creation of the oldest input of a load to its leaving here. Counted for this Goods out when the statistics are on; otherwise the figure is the whole plant\'s.' },
  'sink.lead90': { label: 'Lead time, 90 %', text: '90 % of the loads left within this time of their creation. Counted for this Goods out when the statistics are on; otherwise the figure is the whole plant\'s.' },
  'sink.doors': { label: 'Doors busy', text: 'Share of the time the dock doors were occupied by a truck, and how many doors the station has.' },
  'sink.fill': { label: 'Trucks full', text: 'Share of the planned pallets that were really loaded onto the trucks that left, and how many trucks left short.' },
  'sink.total': { label: 'Shipped in all', text: 'Loads that left the plant through this Goods out since the start.' },
  'sink.wip': { label: 'In the plant now', text: 'Loads that are somewhere in the plant right now (work in process of the Results tab).' },
  'depot.parked': { label: 'Parked or charging', text: 'Vehicles standing in this depot right now, parked or charging, against its slots.' },
  'depot.average': { label: 'Parked on average', text: 'Average number of parked vehicles (time-weighted), and the most there were at once.' },
  'depot.slots': { label: 'Slots used', text: 'Average share of the depot\'s slots that were taken.' },
  'depot.visits': { label: 'Visits per hour', text: 'Vehicles that docked here since the start, per hour (the dock services of the Results tab).' },
  'depot.queue': { label: 'Wait per visit', text: 'Average time a vehicle waited in a queue for a dock of this depot before it could be served.' },
  'depot.chargers': { label: 'Chargers', text: 'Number of chargers of this depot; the line under it is the lowest battery any vehicle that uses it reached.' },
  'flow.delivered': { label: 'Delivered per hour', text: 'Loads this flow delivered since the start, per hour (the Results tab).' },
  'flow.wait': { label: 'Wait for a vehicle', text: 'Mean time a load waited in the output buffer until a vehicle picked it up (the Results tab). A mean over loads that were picked up cannot see a load that is still waiting: "waiting now" counts those.' },
  'flow.backlog': { label: 'Waiting now', text: 'Loads of this flow that are ready and that no vehicle has claimed yet, right now; the line under it is the average over the window.' },
  'flow.transit': { label: 'Transit', text: 'Mean time from picking a load up to delivering it, including unloading (the Results tab).' },
  'flow.load': { label: 'Load per trip', text: 'Loads delivered divided by the trips made for this flow: how full the vehicles were on average.' },
  'flow.trips': { label: 'Trips per hour', text: 'Trips vehicles made for this flow since the start, per hour.' },
  'fleet.busy': { label: 'Busy', text: 'Share of vehicle time spent driving, held up, loading or unloading: the utilization of the Results tab. Waiting counts as busy.' },
  'fleet.trips': { label: 'Trips per vehicle', text: 'Deliveries per vehicle and hour (the Results tab); the line under it is the range from the least to the most used vehicle.' },
  'fleet.held': { label: 'Held up', text: 'Share of vehicle time held up in traffic: driving below half of the free speed because of another vehicle, a junction or a broken vehicle ahead.' },
  'fleet.empty': { label: 'Empty share', text: 'Share of the metres driven that were empty, on the way to a pickup (the Results tab). Drives to a depot or a charger are in the total, but they are not counted as empty.' },
  'fleet.wait': { label: 'Load wait', text: 'Mean time the loads this fleet carried waited for a vehicle (the Results tab). A mean over loads that were picked up cannot see a load that is still waiting: "waiting now" counts those.' },
  'fleet.question': { label: 'Needed?', text: 'Workload arithmetic, not a simulation: how busy the other vehicles would have to be if one were taken away and all its work stayed, as a share of the time they are in service (not charging, broken down or stopped). Withheld while vehicles queue, because then the number of vehicles is not what limits the fleet, and for a fleet that is out of service half of the time or more. A fleet that is busy all the time hides its real workload, so no verdict is spoken for it. Needs 20 minutes measured and two vehicles.' },
  'cell.passes': { label: 'Vehicles per hour', text: 'Vehicles that drove onto this road cell since the start, per hour (the passes of the heat map).' },
  'cell.wait': { label: 'Waiting here', text: 'Vehicle-minutes per hour that vehicles waited booked on this cell: the cell that blocks a vehicle (a junction or a dock), not the place where it stands.' },
  'cell.share': { label: 'Share of waiting', text: 'Share of all waiting on the plant\'s roads that was booked on this cell.' },
  'cell.delay': { label: 'Delay per vehicle', text: 'Waiting seconds booked on this cell divided by the vehicles that passed it.' },
  'cell.rank': { label: 'Rank', text: 'Where this cell stands among the road cells on which vehicles waited, the most waiting first.' },
  'cell.what': { label: 'What it is', text: 'A junction (one vehicle at a time), a plain road cell, or a dock of a station; with its direction and speed limit.' },
  'several.count': { label: 'Selected', text: 'How many items are selected.' },
  'several.worst': { label: 'Worst', text: 'The selected item with the highest value of this figure; the figure itself is the Results tab\'s.' },
  'several.sum': { label: 'Total', text: 'The sum over the selected items, where a sum means something.' },
  'several.mean': { label: 'Average', text: 'The average over the selected items (weighted by what they did where that matters).' },
});

/** The rule of one tile with the window it counts over. */
const withWindow = (id, windowWords) => `${DEFINITIONS[id] ? DEFINITIONS[id].text : ''}${windowWords ? ` ${windowWords}` : ''}`.trim();

// ---------------------------------------------------------------------------------------------------------
// Pure rules (the seed was the finalizer's rules.mjs; tested in tests/ui.stats-model.test.js)
// ---------------------------------------------------------------------------------------------------------

/**
 * An arrow next to a peer value, only when the difference is real: larger than a floor AND than the noise of the count AND than 12 % of the peer value.
 * kind 'share': a floor of 3 points. kind 'rate': a count of at least 20 events and two standard deviations of the count (sqrt(count) / hours).
 * @returns {'up' | 'down' | null}
 */
export function deltaMark(mine, peer, { kind, count = null, hours = null } = {}) {
  if (!(peer > 0) || !isNum(mine)) return null;
  const d = mine - peer;
  if (kind === 'share') {
    if (Math.abs(d) < ARROW_MIN_SHARE_POINTS || Math.abs(d / peer) < ARROW_MIN_RELATIVE) return null;
    return d > 0 ? 'up' : 'down';
  }
  if (!isNum(count) || !(hours > 0) || count < ARROW_MIN_COUNT) return null;
  const sigma = Math.sqrt(count) / hours;
  if (Math.abs(d) < ARROW_SIGMAS * sigma || Math.abs(d / peer) < ARROW_MIN_RELATIVE) return null;
  return d > 0 ? 'up' : 'down';
}

/** The words for how steady a pair's usual route is. "Usual" is claimed only from 5 complete legs and when one path carries at least half of the drawn trips. */
export function usualWording({ complete, variants, share }) {
  if (!(complete >= MIN_LEGS_FOR_USUAL)) return { usual: false, text: 'too few trips for a usual route' };
  if (variants <= 1) return { usual: true, text: 'always the same way' };
  if (share >= USUAL_SHARE_CLAIMED) return { usual: true, text: `${num(Math.round(100 * share))} % the same way` };
  return { usual: false, text: `${variants} ways, the most used ${num(Math.round(100 * share))} %` };
}

/** The ways of a pair that are drawn on the plan: the first (the usual one) and every other with at least 10 % of the drawn trips. `pathIds`: [{ id, n }]. */
export function drawnVariants(pathIds) {
  const total = pathIds.reduce((n, p) => n + n0(p.n), 0);
  return pathIds.filter((p, i) => i === 0 || (total > 0 && p.n / total >= VARIANT_DRAWN_SHARE));
}

/** The red end of the colour ramp for a set of shares lost to waiting: their 90th percentile in steps of 5 %, between 8 % and 30 % (25 % without any). */
export function rampMaxOf(shares) {
  const a = (shares || []).filter(isNum).sort((x, y) => x - y);
  if (!a.length) return 0.25;
  const p90 = a[Math.min(a.length - 1, Math.floor(0.9 * a.length))];
  return clamp(Math.ceil(p90 * 20 - 1e-9) / 20, RAMP_MIN, RAMP_MAX);
}

/** The stops of the colour ramp (shares of its length): blue holds to 14 %, turns amber by 34 % and holds to 62 %, turns red by 84 % and holds. The same ramp as js/ui/render/routes.js. */
export const RAMP_STOPS = Object.freeze([0, 0.14, 0.34, 0.62, 0.84, 1]);
const RAMP_TOKENS = Object.freeze(['--route-calm', '--route-calm', '--route-some', '--route-some', '--route-much', '--route-much']);

/**
 * The colour (a CSS value on the ramp blue -> amber -> red, tokens --route-calm / --route-some / --route-much, so it follows the theme) for a share of a trip lost to
 * waiting; `max` is the share that is fully red (rampMaxOf of what is on screen). The route overlay draws the same ramp (routes.js rampColor, with hex values for the
 * canvas); the small pictures of the trip rows use this one.
 */
export function rampColor(share, max = 0.25) {
  const t = isNum(share) && share > 0 && max > 0 ? Math.min(1, share / max) : 0;
  let j = 1;
  while (j < RAMP_STOPS.length - 1 && t > RAMP_STOPS[j]) j++;
  const a = RAMP_TOKENS[j - 1];
  const b = RAMP_TOKENS[j];
  if (a === b) return `var(${a})`;
  const k = (t - RAMP_STOPS[j - 1]) / (RAMP_STOPS[j] - RAMP_STOPS[j - 1]);
  return `color-mix(in oklab, var(${a}), var(${b}) ${Math.round(k * 100)}%)`;
}

/** "Dock 2" for the dock cell `node` of a station, from the report's `docks` of that station (the position in the list); null when it is not one of them. */
export function dockName(reportStation, node) {
  const k = ((reportStation && reportStation.docks) || []).findIndex((d) => d.node === node);
  return k < 0 ? null : `Dock ${k + 1}`;
}

/** The id of a route the planner points at (see the header): 'loaded:s4>s5', 'empty:s4>s5', 'depot:s4>s8'. */
export const routeFocusId = (kind, fromId, toId) => `${kind}:${fromId}>${toId}`;
export const ROUND_FOCUS_ID = 'round';
/** The inverse of routeFocusId: { kind, from, to }, or { kind: 'round' }, or null for anything else. */
export function parseFocusId(id) {
  if (id === ROUND_FOCUS_ID) return { kind: 'round', from: null, to: null };
  const m = /^(loaded|empty|depot):(.*)>(.*)$/.exec(String(id));
  return m ? { kind: m[1], from: m[2], to: m[3] } : null;
}

const KIND_WORDS = ['empty', 'loaded', 'depot', 'depot']; // the collector's leg kinds 0 (to a pickup), 1 (loaded), 2 (to a charger), 3 (to park)

// ---- the fleet question (docs/ENTITY-INSIGHTS-DESIGN.md 3.9) ----

/**
 * The fleet question, answered as arithmetic and labelled so. `f` is the fleet's entry of the report, `windowSeconds` the measured seconds since the start.
 *   W = count x utilization (work in vehicles);  Wp = W - count x shares.waiting (queueing is not work and shrinks with fewer vehicles);
 *   forecast = Wp / (count - 1): how busy the others would have to be (a share of ALL the time) if one vehicle were taken away and all its work stayed;
 *   load = forecast / available: the same as a share of the time the vehicles are IN SERVICE (not charging, broken or stopped: `available` = 1 - charging - broken, as insights.js
 *   oversized() reads it). The verdict follows `load`: 65 % of the whole time is 84 % of the time of a fleet that charges 23 % of it.
 * Withheld while the fleet or the plant is congested, and for a fleet that is in service less than half of the time. A fleet that is busy at 95 % or more (FLEET_CRITICAL_UTILIZATION)
 * hides how much work there is (its workload is cut off at 100 %, and the real limit may be something else): the answer is 'limit', with no verdict and no count of vehicles.
 * -> { n, W, Wp, available, forecast, load, verdict: 'indicative' | 'queueing' | 'unavailable' | 'limit' | 'needed' | 'borderline' | 'spare', needed, censored, text }
 */
export function fleetQuestion(report, f, windowSeconds) {
  const n = n0(f && f.count);
  const util = n0(f && f.utilization);
  const waiting = n0(f && f.shares && f.shares.waiting);
  const available = clamp(1 - n0(f && f.shares && f.shares.charging) - n0(f && f.shares && f.shares.broken), 0, 1);
  const W = n * util;
  const Wp = Math.max(0, W - n * waiting);
  const out = { n, W, Wp, available, forecast: null, load: null, verdict: 'indicative', needed: null, censored: false, text: '' };
  if (n < 2) { out.text = 'A fleet of one cannot be compared with itself.'; return out; }
  if (!(windowSeconds >= NEEDED_MIN_WINDOW)) { out.text = 'Measured for less than 20 minutes: too early to say.'; return out; }
  const ctx = { traffic: { waitShare: n0(report && report.traffic && report.traffic.waitShare) } };
  if (congested(ctx, f)) {
    const own = fleetWaitShare(f);
    out.verdict = 'queueing';
    out.queue = { own, plant: ctx.traffic.waitShare };
    out.text = own >= TRAFFIC_WAIT_SHARE
      ? `Vehicles queue (${pct(own)} of their moving time): the number of vehicles is not what limits this fleet, so no count is suggested. Look at the docks and the roads first.`
      : `Vehicles queue across the plant (${pct(ctx.traffic.waitShare)} of their moving time; this fleet's vehicles ${pct(own)}): more vehicles would only add to the traffic, so no count is suggested. Look at the docks and the roads first.`;
    return out;
  }
  out.forecast = Wp / (n - 1);
  if (available <= NEED_AVAILABLE_MIN) {
    out.verdict = 'unavailable';
    out.text = `Out of service ${pct(1 - available)} of the time (charging, broken down or stopped): the other vehicles cannot take its work over, and the busy share says little about whether it is needed. Look at the batteries and the breakdowns first.`;
    return out;
  }
  const others = n - 1;
  const load = out.forecast / available;
  out.load = load;
  // the same number twice only when the vehicles are away from work for a noticeable part of the time
  const busy = available < 0.95 ? `busy about ${pct(out.forecast)} of the time, ${pct(load)} of the time they are in service` : `busy about ${pct(out.forecast)} of the time`;
  if (util >= FLEET_CRITICAL_UTILIZATION) {
    out.censored = true;
    out.verdict = 'limit';
    out.text = 'At the limit: the fleet is busy all the time, so its real workload is cut off at 100 % and this arithmetic cannot say whether one vehicle fewer would cost output (the limit may be something other than vehicles). Workload arithmetic, not a simulation: to test it, run a sweep of the fleet size in the Experiments tab.';
    return out;
  }
  if (load > 1) {
    out.verdict = 'needed';
    out.text = `Needed: the work of ${n} vehicles does not fit into ${others}; the others would have to work more than all the time they are in service.`;
  } else if (load >= NEED_NEEDED_FROM) {
    out.verdict = 'needed';
    out.text = `Needed: without it the other ${others} would be ${busy}.`;
  } else if (load > NEED_BORDERLINE_FROM) {
    out.verdict = 'borderline';
    out.text = `Borderline: without it the other ${others} would be ${busy} (the insights aim for ${pct(FLEET_TARGET_UTILIZATION)}${available < 0.95 ? ' of the time in service' : ''}).`;
  } else {
    out.verdict = 'spare';
    out.text = `Spare capacity: the other ${others} could take over; they would be ${busy}.`;
  }
  out.needed = Math.max(1, Math.ceil(Wp / (FLEET_TARGET_UTILIZATION * available)));
  out.text += ` At ${pct(FLEET_TARGET_UTILIZATION)} load the work would need about ${plural(out.needed, 'vehicle')}.`;
  out.text += ' Workload arithmetic, not a simulation: to test it, run a sweep of the fleet size in the Experiments tab.';
  return out;
}

// ---- the memory of the facts (hysteresis on the value, not on time) ----

const MEMORIES = new WeakMap();
const NO_MEMORY_OWNER = {};

/** A fresh memory for the hysteresis of the facts. */
export const createFactMemory = () => new Map();

function factMemoryOf(input) {
  if (input.factMemory instanceof Map) return input.factMemory;
  const owner = input.sim || input.detail || input.report || NO_MEMORY_OWNER;
  if (!MEMORIES.has(owner)) MEMORIES.set(owner, new Map());
  return MEMORIES.get(owner);
}

/**
 * Does a fact hold? It appears when `value` reaches `threshold` and goes when it falls below HYSTERESIS x threshold, so at 600x it does not flicker.
 * `key` names the fact for one item and window. A memory without history behaves as a plain threshold.
 */
export function holds(memory, key, value, threshold) {
  if (!isNum(value)) { memory.delete(key); return false; }
  const was = memory.get(key) === true;
  const on = value >= threshold || (was && value >= threshold * HYSTERESIS);
  if (on) memory.set(key, true); else memory.delete(key);
  return on;
}

// ---------------------------------------------------------------------------------------------------------
// Items, names, windows
// ---------------------------------------------------------------------------------------------------------

const stationName = (layout, id) => {
  const st = layout && layout.stations ? layout.stations.find((s) => s.id === id) : null;
  return st ? st.name : String(id);
};
const stationDef = (layout, id) => (layout && layout.stations ? layout.stations.find((s) => s.id === id) : null) || null;

/** "v2#3" -> { fleetId: 'v2', n: 3 }; anything else -> { fleetId: id, n: 0 }. */
export function parseVehicleId(id) {
  const s = String(id);
  const at = s.lastIndexOf('#');
  const n = at > 0 ? Number(s.slice(at + 1)) : NaN;
  return at > 0 && Number.isInteger(n) ? { fleetId: s.slice(0, at), n } : { fleetId: s, n: 0 };
}

const fleetDefOf = (layout, id) => (layout && layout.fleets ? layout.fleets.find((f) => f.id === id) : null) || null;

/**
 * The window of the collector for a kind, with its honest words. `w` is detail.windowOf(kind).
 *  seconds   measured seconds in the window            equalsStart  'last30' while fewer than 30 minutes were measured: it IS 'start'
 *  indicative  fewer than 20 minutes: every verdict is called indicative       late  the collector started after the report's window did
 *  text      "2 h 6 min measured, warm-up excluded" / "counting since 0:50"   counted  the sentence under the facts
 */
export function windowInfo({ layout, report, detail }, w) {
  const kind = w && w.kind === 'last30' ? 'last30' : 'start';
  const seconds = Math.max(0, n0(w && w.seconds));
  const t0 = n0(w && w.t0);
  const reportStart = report && report.window ? n0(report.window.start) : t0;
  const late = kind === 'start' && t0 - reportStart > 1; // the collector's window began after the report's: it was switched on late
  // the window began because the vehicles or stations changed under a running collector (the report restarts with it, so the two windows still begin together)
  const restarted = kind === 'start' && Array.isArray(detail && detail.notices) && detail.notices.some((x) => x && isNum(x.t) && Math.abs(x.t - t0) < 1e-6);
  const equalsStart = kind === 'last30' && Boolean(w && w.zero);
  const indicative = seconds < INDICATIVE_BELOW;
  const since = sinceText(layout, t0);
  const span = duration(seconds);
  let text;
  let counted;
  if (kind === 'start') {
    text = restarted ? `counting since ${since} (the plant changed)` : late ? `counting since ${since}` : `${span} measured, warm-up excluded`;
    counted = restarted
      ? `Counting since ${since}: the vehicles or stations changed then, so earlier time is not in these figures.`
      : late
        ? `Counting since ${since}: the statistics were switched on then, so earlier time is not in these figures.`
        : `Counted since ${since} (warm-up excluded).`;
  } else if (equalsStart) {
    text = `${span} measured, the same as Since start until 30 minutes have passed`;
    counted = `Counted since ${since}. Under 30 minutes have been measured, so the last 30 minutes are the same as Since start.`;
  } else {
    text = `${span} measured`;
    counted = `The last 30 minutes, counted since ${since}.`;
  }
  if (indicative) text += ', indicative';
  const shortText = `${span} measured${indicative ? ', indicative' : ''}`;
  return { kind, seconds, hours: seconds / 3600, t0, since, text, shortText, counted, indicative, equalsStart, late, restarted };
}

const SETTING_WORDS = { demandFactor: 'Demand', speedFactor: 'Vehicle speed', processFactor: 'Process speed', dispatch: 'The dispatch rule', routing: 'Routing' };

/** Notes about what changed under the collector's feet: runtime settings (what-if log), a restart after the fleet changed. At most two, the newest first. */
export function changeNotes(detail, w, now) {
  const out = [];
  const t0 = n0(w && w.t0);
  const list = Array.isArray(detail && detail.whatIf) ? detail.whatIf : [];
  for (let k = list.length - 1; k >= 0 && out.length < 2; k--) {
    const c = list[k];
    if (!c || !isNum(c.t) || c.t < t0) continue;
    const word = SETTING_WORDS[c.key] || 'A setting';
    out.push(`${word} changed about ${duration(Math.max(0, n0(now) - c.t))} ago: figures from before then mix both.`); // the change is stamped when the next 30 s bucket closes
  }
  const notices = Array.isArray(detail && detail.notices) ? detail.notices : [];
  if (notices.length && out.length < 2) {
    const last = notices[notices.length - 1];
    if (last && typeof last.text === 'string') out.push(`${last.text.replace(/[.\s]+$/, '')} (at ${clockText(last.t)}).`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------------------

const NOREF = Object.freeze({ text: '', arrow: '', good: null });

/**
 * One number. `value` is the printed text, `raw` the number behind it (null when there is none: a test compares it with the report), `share` marks a share
 * (0..1) so that a test can assert it is at most 1. `since`: this figure is the since-start one although another window is shown (printed next to the label).
 */
function tile(id, spec, o = {}) {
  const meta = DEFINITIONS[spec] || { label: id, text: '' };
  return {
    id,
    spec, // the id of its counting rule in DEFINITIONS (the Help page lists the same text)
    label: o.label || meta.label,
    def: o.def || meta.text,
    value: o.value === undefined ? DASH : o.value,
    unit: o.unit || '',
    ref: o.ref ? { ...NOREF, ...o.ref } : NOREF,
    tone: o.tone || '',
    raw: isNum(o.raw) ? o.raw : null,
    share: Boolean(o.share),
    since: Boolean(o.since),
  };
}

/** The reference line of a tile: a peer value, with an arrow only when `mark` says the difference is real. higherIsGood decides the colour of the arrow. */
const peerRef = (mark, text, higherIsGood = true, extra = '') => ({
  text: `${text}${extra}`,
  arrow: mark === 'up' ? '▲' : mark === 'down' ? '▼' : '',
  good: mark ? (mark === 'up') === higherIsGood : null,
});

const shareTile = (id, spec, x, o = {}) => tile(id, spec, { value: isNum(x) ? pct(x) : DASH, raw: x, share: true, ...o });

// ---------------------------------------------------------------------------------------------------------
// A vehicle (docs/ENTITY-INSIGHTS-DESIGN.md 3.1 and 4.1)
// ---------------------------------------------------------------------------------------------------------

const DRIVING_STATES = { toPickup: true, toDrop: true, toCharger: true, toPark: true };
const PEER_TTL_MS = 1000; // the fleet mates' figures are recomputed at most once a second per fleet and window ...
const PEER_SIM_SHARE = 0.05; // ... and as soon as the simulation moved on by this share of the window (at 600x a wall second is ten simulated minutes: the vehicle's own figures are live) ...
const PEER_SIM_MIN_SECONDS = 30; // ... but never more often than every 30 simulated seconds
const PEER_BIG_FLEET = 40; // a fleet this big (each refresh would scan the leg log once per vehicle) keeps the plain one-second rule
const PEER_SAMPLE_MAX = 120; // a fleet above this is sampled (every k-th vehicle): the peer value says "about"

/** The 11 pieces of a vehicle's time (they add up to the window; the three kinds of driving are the parts of 'driving'). [slot, words, tone class]. */
export const SPLIT_PIECES = Object.freeze([
  ['drivingLoaded', 'Driving loaded', 'driving'], ['drivingEmpty', 'Driving empty', 'driving-empty'], ['drivingDepot', 'To depot / charger', 'driving-depot'],
  ['waiting', 'Traffic wait', 'waiting'], ['dockQueue', 'Dock queue', 'dockq'], ['loading', 'Loading', 'loading'], ['unloading', 'Unloading', 'unloading'],
  ['idle', 'No job', 'idle'], ['parked', 'Parked', 'parked'], ['charging', 'Charging', 'charging'], ['broken', 'Broken or dead', 'broken'],
]);

export const BLOCK_DEFINITIONS = Object.freeze({
  time: { label: 'Where its time goes', text: 'The window split into 11 pieces that add up to all of it. Driving has three parts: with a load, empty on the way to a pickup, and to a depot or charger. Traffic wait and dock queue are the time held up (driving below half of the free speed because of a vehicle, a junction or a broken vehicle ahead, or waiting for a dock). The line under it is the busy share of each 30 seconds over the last 30 minutes.' },
  held: { label: 'Where it is held up', text: 'Minutes per hour the vehicle was held up, by place. Queue rows count the time waiting for a dock of that station (for drives that started in the window). Road-cell rows are booked on the cell that blocks the vehicle (a junction or a dock), not where it stands, and exist for Since start only. The rows and "Other places" add up to the Held up number.' },
  trips: { label: 'Trips', text: 'A trip is a loaded drive from the station where the load was picked up to the station where it was delivered (Results counts deliveries; the two agree, apart from a drive still in progress and a load cancelled on the way). The usual route is the way most trips took; "usual" is said only when it carries at least half of the trips of the pair and there are at least 5 complete trips. With several docks the way depends on the docks used: the dock pair is shown. Waits are the mean seconds held up during a trip. The other drives are counted by drives started: a drive to a pickup that was re-targeted on the way counts again.' },
  round: { label: 'Usual round', text: 'The most frequent pair of consecutive loaded trips between two visits to a depot or charger; the empty drive between them is implied. It needs 3 occurrences.' },
});

// ---- the fleet mates (the reference value of the numbers), cached ----

const PEER_CACHE = new WeakMap();

function fleetPeers(det, fleetId, w, now, exact = false) {
  let byKey = PEER_CACHE.get(det);
  if (!byKey) { byKey = new Map(); PEER_CACHE.set(det, byKey); }
  const key = `${fleetId}|${w.kind}`; // one entry per fleet and window kind (a window that moved on replaces it: the map never grows)
  const hit = byKey.get(key);
  // `exact`: the simulation stands still, so nothing will refresh the dock again: the figures must be those of this very moment, not up to a second (600 simulated seconds at 600x) old
  const stale = hit && hit.count <= PEER_BIG_FLEET && w.seconds - hit.seconds >= Math.max(PEER_SIM_MIN_SECONDS, PEER_SIM_SHARE * w.seconds); // the peers would be a different window by now
  if (hit && !stale && Math.abs(n0(now) - hit.at) < PEER_TTL_MS && hit.nV === det.nV && hit.t0 === w.t0 && (!exact || hit.seconds === w.seconds)) return hit.value;
  const mates = [];
  for (let k = 0; k < det.V.length; k++) if (det.V[k].fleetId === fleetId) mates.push(k);
  const stride = Math.max(1, Math.ceil(mates.length / PEER_SAMPLE_MAX));
  let counted = 0; let busy = 0; let held = 0; let parked = 0; let trips = 0; let qty = 0; let legs = 0; let legTime = 0; let seconds = 0;
  for (let a = 0; a < mates.length; a += stride) {
    const k = mates[a];
    const t = det.timeSplit(k, w);
    if (!(t.seconds > 0)) continue;
    counted++;
    seconds += t.seconds;
    busy += (t.driving + t.waiting + t.dockQueue + t.loading + t.unloading) / t.seconds;
    held += (t.waiting + t.dockQueue) / t.seconds;
    parked += t.parked / t.seconds;
    const cn = det.counts(k, w);
    trips += n0(cn.trips);
    qty += n0(cn.qty);
    for (const r of det.routesOf(k, w, [1])) if (isNum(r.meanTime) && r.complete > 0) { legs += r.complete; legTime += r.meanTime * r.complete; }
  }
  const hours = counted > 0 ? seconds / counted / 3600 : 0;
  const value = {
    count: mates.length, counted, sampled: stride > 1,
    busy: safeDiv(busy, counted), held: safeDiv(held, counted), parked: safeDiv(parked, counted),
    tripsPerHour: hours > 0 ? trips / counted / hours : 0, qtyPerHour: hours > 0 ? qty / counted / hours : 0,
    meanLoaded: legs > 0 ? legTime / legs : null,
  };
  byKey.set(key, { at: n0(now), nV: det.nV, t0: w.t0, seconds: w.seconds, count: mates.length, value });
  return value;
}

// ---- cells and paths ----

/** A road cell named by what it is: "dock of Press line", "junction at Press line", "road near Press line", else "road cell (x, y)". */
export function cellLabel(graph, layout, report, node) {
  const cols = graph && graph.cols ? graph.cols : 1;
  const cx = node % cols;
  const cy = Math.floor(node / cols);
  const stations = (report && report.stations) || {};
  for (const id of Object.keys(stations)) {
    const st = stations[id];
    if (st && Array.isArray(st.docks) && st.docks.some((d) => d.node === node)) return `dock of ${st.name}`;
  }
  let best = null;
  let bestD = Infinity;
  for (const s of (layout && layout.stations) || []) {
    const d = Math.max(s.x - cx, 0, cx - (s.x + s.w - 1)) + Math.max(s.y - cy, 0, cy - (s.y + s.h - 1));
    if (d < bestD) { bestD = d; best = s; }
  }
  // a junction is a cell the engine controls (it holds one vehicle at a time: a junction, a merge, a crossing) and that is no dead end, the cells waiting is booked on; a graph that does
  // not say falls back to "three exits or more"
  const junction = graph && graph.controlled
    ? graph.controlled[node] === 1 && !(graph.deadEnd && graph.deadEnd[node] === 1)
    : Boolean(graph && graph.out && graph.out[node] && graph.out[node].length >= 3);
  const word = junction ? 'junction' : 'road';
  return best && bestD <= 8 ? `${word} ${junction ? 'at' : 'near'} ${best.name}` : `${word} cell (${cx}, ${cy})`;
}

/** The corner points of a path in cell coordinates (the shape of its small picture), from its road cells. */
export function shapeOf(nodes, cols) {
  const pts = [];
  for (let k = 0; k < nodes.length; k++) {
    const x = nodes[k] % cols;
    const y = Math.floor(nodes[k] / cols);
    const a = pts[pts.length - 1];
    const b = k + 1 < nodes.length ? [nodes[k + 1] % cols, Math.floor(nodes[k + 1] / cols)] : null;
    if (k === 0 || !a || !b || (x - a[0]) * (b[1] - y) - (y - a[1]) * (b[0] - x) !== 0) pts.push([x, y]);
  }
  return pts;
}

const graphOf = (det) => det.graph || { cols: 1, cellSize: 1 };
const cellSizeOf = (det) => n0(det.cell) || n0(graphOf(det).cellSize) || 1;

/** The world rectangle (metres) around a set of road cells. */
function rectOfNodes(nodes, cols, cs) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of nodes) {
    const x = n % cols; const y = Math.floor(n / cols);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x0 <= x1 ? { x: x0 * cs, y: y0 * cs, w: (x1 - x0 + 1) * cs, h: (y1 - y0 + 1) * cs } : null;
}

const mergeRects = (rects) => {
  const r = rects.filter(Boolean);
  if (!r.length) return null;
  const x0 = Math.min(...r.map((q) => q.x)); const y0 = Math.min(...r.map((q) => q.y));
  const x1 = Math.max(...r.map((q) => q.x + q.w)); const y1 = Math.max(...r.map((q) => q.y + q.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

// ---- the live line ----

function liveLine(layout, vr, toGo, held) {
  const named = (id) => (id === null || id === undefined ? '' : stationName(layout, id));
  const at = (word, id) => { const n = named(id); return n ? `${word} ${n}` : ''; };
  const o = vr.order;
  const loads = n0(vr.load && vr.load.length);
  const target = vr.targetId;
  const driving = DRIVING_STATES[vr.state] === true;
  let tone = 'idle'; let strong = vr.state || 'No job'; let rest = '';
  switch (vr.state) {
    case 'toPickup': tone = 'driving'; strong = at('Driving to', o ? o.from : target) || 'Driving to a pickup'; rest = 'to pick up a load'; break;
    case 'toDrop': tone = 'driving'; strong = [`Carrying ${plural(loads, 'load')}`, at('to', o ? o.to : target)].filter(Boolean).join(' '); break;
    case 'toCharger': tone = 'driving'; strong = at('Driving to', target) || 'Driving to a charger'; rest = 'to charge'; break;
    case 'toPark': tone = 'driving'; strong = at('Driving to', target) || 'Driving to a depot'; rest = 'to park'; break;
    case 'loading': tone = 'loading'; strong = at('Loading at', o ? o.from : target) || 'Loading'; break;
    case 'unloading': tone = 'unloading'; strong = at('Unloading at', o ? o.to : target) || 'Unloading'; break;
    case 'idle': tone = 'idle'; strong = 'No job'; rest = 'standing on the road'; break;
    case 'parked': tone = 'parked'; strong = 'Parked'; rest = at('in', vr.depot && vr.depot.id ? vr.depot.id : target); break;
    case 'charging': tone = 'charging'; strong = 'Charging'; rest = isNum(vr.battery) ? `${pct(vr.battery)} charged` : ''; break;
    case 'broken': tone = 'broken'; strong = 'Out of service'; rest = 'broken down, being repaired'; break;
    case 'dead': tone = 'broken'; strong = 'Stopped'; rest = 'battery empty, standing on the road'; break;
    default: break;
  }
  if (driving && held) { tone = 'waiting'; rest = [rest, 'held up now'].filter(Boolean).join(', '); }
  if (driving && isNum(toGo)) rest = [rest, `${metres(toGo)} to go`].filter(Boolean).join(' · ');
  return { tone, strong, rest };
}

// ---- the answer when there is nothing to show yet ----

const hasMeasured = (report) => Boolean(report && report.window && report.window.warmingUp !== true && isNum(report.window.duration) && report.window.duration > 0);

function statusModel({ kind, variant, ids, tiles, status, statusText, name, live = null, windows = { last30: false, note: 'Nothing has been measured yet.' } }) {
  return {
    kind, variant, status, statusText, ids,
    // before the first measured second the header says what to do, so that the compact dock (the body is closed) is not just dashes
    header: { live: live || (status === 'waiting' ? { tone: 'idle', strong: 'Press play', rest: 'to see the numbers' } : { tone: '', strong: '', rest: '' }) },
    ariaLabel: `Statistics for ${name}`,
    announce: `${name} selected. ${statusText}`,
    windows, routes: false,
    window: { kind: 'start', seconds: 0, text: '', shortText: '', counted: '', since: '', indicative: true, equalsStart: false, late: false },
    tiles,
    blocks: [{ id: 'status', type: 'status', title: '', text: statusText }],
  };
}

const dashTiles = (specs) => specs.map(([id, def, o]) => tile(id, def, o));

const VEHICLE_SPECS = (battery) => [['trips', 'vehicle.trips'], ['busy', 'vehicle.busy'], ['held', 'vehicle.held'], ['driven', 'vehicle.driven'], ['loaded', 'vehicle.loaded'], battery ? ['battery', 'vehicle.battery'] : ['parked', 'vehicle.parked']];
const VEHICLE_REPORT_SPECS = (battery) => [['trips', 'vehicleReport.trips'], ['busy', 'vehicleReport.busy'], ['held', 'vehicleReport.held'], ['driven', 'vehicleReport.driven'], ['loaded', 'vehicleReport.loaded'], ['battery', 'vehicleReport.battery', battery ? {} : { label: 'Fleet battery' }]];

// ---- the model of one vehicle ----

function vehicleModel(input, id) {
  const { layout, report, sim } = input;
  const det = input.detail;
  const windowKind = input.window === 'last30' ? 'last30' : 'start';
  const { fleetId, n } = parseVehicleId(id);
  const fleetDef = fleetDefOf(layout, fleetId);
  const fleetRep = report && report.fleets ? report.fleets[fleetId] : null;
  const battery = Boolean(fleetDef && fleetDef.battery && fleetDef.battery.enabled);
  const name = fleetDef ? `${fleetDef.name} ${n}` : String(id);
  const ids = [id];
  const specs = dashTiles(VEHICLE_SPECS(battery).map(([tid, def]) => [tid, def]));
  if (!fleetDef) return statusModel({ kind: 'vehicle', variant: 'vehicle', ids, tiles: specs, status: 'gone', statusText: 'This vehicle is not in the plant any more.', name });
  if (!hasMeasured(report)) {
    return statusModel({ kind: 'vehicle', variant: 'vehicle', ids, tiles: specs, status: 'waiting', statusText: `Press play to see statistics for ${name}. The numbers appear as soon as the simulation has measured something.`, name, windows: { last30: true } });
  }
  if (!det) return vehicleReportModel(input, id, { fleetDef, fleetRep, name, battery });
  const i = typeof det.vehicleIndex === 'function' ? det.vehicleIndex(id) : det.V.findIndex((v) => v.id === id);
  if (i < 0) {
    const unplaced = sim && sim.logistics && Array.isArray(sim.logistics.unplaced) ? sim.logistics.unplaced.includes(id) : n0(fleetRep && fleetRep.unplaced) > 0;
    const text = unplaced ? 'This vehicle did not fit on the road, so it takes no part in the run.' : 'This vehicle is not part of the run (the plant changed).';
    return statusModel({ kind: 'vehicle', variant: 'vehicle', ids, tiles: specs, status: 'gone', statusText: text, name, live: { tone: 'idle', strong: unplaced ? 'Did not fit on the road' : 'Not in the run', rest: '' } });
  }
  const w = det.windowOf(windowKind);
  if (!(n0(w.seconds) > 0)) {
    return statusModel({ kind: 'vehicle', variant: 'vehicle', ids, tiles: specs, status: 'waiting', statusText: `Press play to see statistics for ${name}. The numbers appear as soon as the simulation has measured something.`, name, windows: { last30: true } });
  }
  const vr = det.V[i];
  const info = windowInfo(input, w);
  const memory = factMemoryOf(input);
  const now = isNum(input.now) ? input.now : Date.now();

  const t = det.timeSplit(i, w);
  const seconds = Math.max(1e-9, n0(t.seconds));
  const hours = seconds / 3600;
  const c = det.counts(i, w);
  const share = (x) => clamp(safeDiv(x, seconds), 0, 1);
  const busy = share(n0(t.driving) + n0(t.waiting) + n0(t.dockQueue) + n0(t.loading) + n0(t.unloading));
  const held = share(n0(t.waiting) + n0(t.dockQueue));
  const peers = fleetPeers(det, fleetId, w, now, !(input.runner && input.runner.playing));
  // The leg log keeps the newest 32,768 legs. Once it has wrapped, everything made from the legs (the trip rows, the usual round, the drives to a depot, the queue by dock) counts the
  // legs since `legSince` only: its per-hour figures are divided by that span, not by the whole window, and the dock says so. The numbers of the time split and the report's counters
  // (the tiles) do not depend on the log.
  const cover = typeof det.legCoverage === 'function' ? det.legCoverage() : null;
  const wrapped = Boolean(cover && cover.wrapped);
  const legSince = wrapped ? Math.max(n0(w.t0), n0(cover.since)) : n0(w.t0);
  const legHours = wrapped ? Math.max(1e-9, n0(w.t0) + n0(w.seconds) - legSince) / 3600 : hours;
  const all = det.routesOf(i, w, [0, 1, 2, 3]);
  const capacity = Math.max(1, n0(vr.cfg && vr.cfg.capacity) || n0(fleetDef.capacity) || 1);
  const bat = battery ? det.batteryOf(i, w) : null;
  const cols = n0(graphOf(det).cols) || 1;
  const cs = cellSizeOf(det);
  const stId = (k) => (k === NO_STATION || !det.stations[k] ? null : det.stations[k].id);

  // ---- the trips: loaded pairs by trips, every drawable way of them, the dock pair of each way ----
  const pairs = [];
  for (const r of all) {
    if (r.kind !== 1) continue;
    const fromId = stId(r.from); const toId = stId(r.to);
    if (fromId === null || toId === null) continue;
    const fromRep = report.stations ? report.stations[fromId] : null;
    const toRep = report.stations ? report.stations[toId] : null;
    const multi = n0(fromRep && fromRep.docks && fromRep.docks.length) > 1 || n0(toRep && toRep.docks && toRep.docks.length) > 1;
    const variants = r.pathIds.map((p) => {
      const nodes = det.pool.nodes(p.id);
      const fromDock = dockName(fromRep, nodes[0]);
      const toDock = dockName(toRep, nodes[nodes.length - 1]);
      return {
        pathId: p.id, n: p.n, share: r.drawn > 0 ? p.n / r.drawn : 0, nodes, metres: n0(det.pool.len[p.id]) * cs, meanTime: p.meanTime, meanWait: p.meanWait,
        waitShare: isNum(p.meanTime) && p.meanTime > 0 ? clamp(n0(p.meanWait) / p.meanTime, 0, 1) : 0, docks: multi && fromDock && toDock ? `${fromDock} → ${toDock}` : null,
      };
    }).sort((a, b) => b.n - a.n);
    pairs.push({ r, fromId, toId, fromName: stationName(layout, fromId), toName: stationName(layout, toId), variants, perHour: r.trips / legHours });
  }
  pairs.sort((a, b) => b.r.trips - a.r.trips || n0(b.variants[0] && b.variants[0].metres) - n0(a.variants[0] && a.variants[0].metres));
  const loadedPairs = pairs;
  const top = loadedPairs.slice(0, TOP_TRIPS);

  const waysOf = (p) => {
    const labelled = p.variants.filter((v) => v.docks !== null);
    if (p.variants.length < 2 || labelled.length !== p.variants.length) return { text: null, groups: [] };
    const groups = new Map();
    for (const v of p.variants) groups.set(v.docks, (groups.get(v.docks) || 0) + v.n);
    const total = [...groups.values()].reduce((a, b) => a + b, 0);
    const list = [...groups].sort((a, b) => b[1] - a[1]).map(([label, k]) => ({ label, share: total > 0 ? k / total : 0 }));
    return { text: list.slice(0, 3).map((g) => `${g.label} ${pct(g.share)}`).join(' · '), groups: list };
  };

  const rows = top.map((p, k) => {
    const r = p.r;
    const usual = usualWording({ complete: r.complete, variants: p.variants.length, share: r.pathShare });
    const ways = waysOf(p);
    const v0 = p.variants[0];
    const lost = isNum(r.meanTime) && r.meanTime > 0 ? n0(r.meanWait) / r.meanTime : 0;
    const waitTone = lost >= WAIT_TONE_MUCH ? 'much' : lost >= WAIT_TONE_SOME ? 'some' : '';
    const showUsual = !(usual.usual && p.variants.length <= 1);
    const notes = [];
    if (r.complete === 0) notes.push('no complete trip yet');
    else if (r.complete < r.trips) notes.push(`times from ${r.complete} of ${r.trips} trips`);
    if (r.undrawn > 0) notes.push(`${plural(r.undrawn, 'trip')} not drawn`);
    const sentence = [
      `${k + 1}: ${p.fromName} to ${p.toName}`, plural(r.trips, 'trip'), `${num(p.perHour, 1)} an hour`, v0 ? metres(v0.metres) : null, isNum(r.meanTime) ? `${secs(r.meanTime)} each` : null,
      isNum(r.meanWait) ? `held up ${secs(r.meanWait)}` : null, usual.text, ways.text ? ways.text.replace(/ → /g, ' to ') : null, ...notes,
    ].filter(Boolean).join(', ');
    return {
      key: routeFocusId('loaded', p.fromId, p.toId), focusId: routeFocusId('loaded', p.fromId, p.toId), rank: k + 1, name: `${p.fromName} → ${p.toName}`,
      shape: v0 ? shapeOf(v0.nodes, cols) : [], shapeShare: v0 ? v0.waitShare : 0, trips: r.trips, perHour: p.perHour, metres: v0 ? v0.metres : null,
      meanTime: isNum(r.meanTime) ? r.meanTime : null, meanWait: isNum(r.meanWait) ? r.meanWait : null, waitTone, usual: showUsual ? usual.text : '', ways: ways.text, undrawn: r.undrawn, note: notes.join(' · '),
      meta: [plural(r.trips, 'trip'), `${num(p.perHour, 1)}/h`, v0 ? metres(v0.metres) : null, isNum(r.meanTime) ? secs(r.meanTime) : null].filter(Boolean).join(' · '),
      waits: isNum(r.meanWait) && isNum(r.meanTime) ? `waits ${secs(r.meanWait)}` : '', label: sentence,
    };
  });

  const drawnShares = top.flatMap((p) => drawnVariants(p.variants.map((v) => ({ id: v.pathId, n: v.n }))).map((d) => p.variants.find((v) => v.pathId === d.id).waitShare));
  const rampMax = rampMaxOf(drawnShares);

  // ---- the usual round ----
  const rawRound = det.roundOf(i, w, 2);
  let round = null;
  if (rawRound && Array.isArray(rawRound.jobs) && rawRound.jobs.length === 2) {
    const jobs = rawRound.jobs.map((j) => ({ fromId: stId(j.from), toId: stId(j.to) }));
    if (jobs.every((j) => j.fromId !== null && j.toId !== null)) {
      const names = jobs.map((j) => `${stationName(layout, j.fromId)} → ${stationName(layout, j.toId)}`);
      const usualOf = (j) => loadedPairs.find((p) => p.fromId === j.fromId && p.toId === j.toId);
      const nodes = jobs.flatMap((j) => { const p = usualOf(j); return p && p.variants[0] ? Array.from(p.variants[0].nodes) : []; });
      round = {
        focusId: ROUND_FOCUS_ID, jobs: names, count: rawRound.count, of: rawRound.of, share: clamp(n0(rawRound.share), 0, 1),
        text: `${rawRound.count} of ${rawRound.of} pairs of trips (${pct(rawRound.share)}), empty drive between`, bounds: rectOfNodes(nodes, cols, cs),
        label: `Usual round: ${names.join(', then ').replace(/ → /g, ' to ')}, ${rawRound.count} of ${rawRound.of} pairs of trips, ${pct(rawRound.share)}`,
      };
    }
  }

  // ---- the other drives ----
  const sumOf = (list) => ({ trips: list.reduce((a, r) => a + r.trips, 0), complete: list.reduce((a, r) => a + r.complete, 0), time: list.reduce((a, r) => a + (isNum(r.meanTime) ? r.meanTime * r.complete : 0), 0) });
  const empties = sumOf(all.filter((r) => r.kind === 0));
  const depots = sumOf(all.filter((r) => r.kind === 2 || r.kind === 3));
  // the metres come from the odometers of the whole window: beside the drives of a wrapped log they would be of another window, so they are left out then
  const driveText = (s, m) => `${plural(s.trips, 'drive')}${wrapped ? '' : ` · ${metres(m)}`}${s.complete > 0 ? ` · about ${secs(s.time / s.complete)} each` : ''}`;
  const other = {
    text: `${num(empties.trips)} empty · ${num(depots.trips)} to depot or charger`,
    items: [{ label: 'Empty, to a pickup', text: driveText(empties, n0(c.empty)) }, { label: 'To a depot or charger', text: driveText(depots, n0(c.park)) }],
  };

  // ---- where it is held up: queues for a dock by station, then road cells (since start only), the rest ----
  // The numbers of the Held up tile and of the queue for a dock come from the time split of the window (exact, one window); the logged legs only say WHERE the queue was: the rows
  // share the dock-queue seconds of the window in proportion to the queue seconds of the legs (a drive that started in the window), so numerator and denominator are of one window
  // (a leg still open, a drive that began before a window of 30 minutes, or a wrapped log would otherwise leave seconds out of the rows).
  const tileSeconds = n0(t.waiting) + n0(t.dockQueue);
  const queueSeconds = Math.min(tileSeconds, n0(t.dockQueue));
  const pool = new Map();
  const put = (label, sec, node, kind) => {
    const e = pool.get(label);
    if (e) e.seconds += sec; else pool.set(label, { label, seconds: sec, node, kind });
  };
  const legQueues = det.queuesOf(i, w).map((q) => ({ q, sid: stId(q.station) })).filter((x) => x.sid !== null && x.q.seconds > 0);
  const legQueueTotal = legQueues.reduce((a, x) => a + x.q.seconds, 0);
  if (queueSeconds > 0 && legQueueTotal > 0) for (const x of legQueues) put(`Queue for ${stationName(layout, x.sid)}’s dock`, (queueSeconds * x.q.seconds) / legQueueTotal, x.q.dockNode, 'queue');
  else if (queueSeconds > 0) put('Queue for a dock', queueSeconds, -1, 'queue'); // the legs have not seen where yet (the first drives are still open)
  let cellsTotal = 0;
  if (windowKind === 'start') {
    const hot = det.hotspots(i, HELD_ROWS + 4);
    cellsTotal = n0(hot.total);
    for (const cell of hot.cells) put(cellLabel(graphOf(det), layout, report, cell.node), cell.seconds, cell.node, 'cell');
  }
  const ordered = [...pool.values()].filter((e) => e.seconds > 0).sort((a, b) => b.seconds - a.seconds);
  const heldRows = [];
  let listed = 0;
  for (const e of ordered.slice(0, HELD_ROWS)) {
    const left = Math.max(0, tileSeconds - listed);
    const sec = Math.min(e.seconds, left); // the rows never add up to more than the Held up number
    if (!(sec > 0)) break;
    listed += sec;
    heldRows.push({ key: `${e.kind}:${e.label}`, label: e.label, seconds: sec, minPerHour: sec / hours / 60, share: clamp(safeDiv(sec, tileSeconds), 0, 1), kind: e.kind, node: e.node });
  }
  const otherSeconds = Math.max(0, tileSeconds - listed);
  heldRows.push({
    key: 'other', label: windowKind === 'start' ? 'Other places' : 'Other places (road cells: since start only)', seconds: otherSeconds, minPerHour: otherSeconds / hours / 60,
    share: clamp(safeDiv(otherSeconds, tileSeconds), 0, 1), kind: 'other', node: -1,
  });
  const heldBlock = tileSeconds >= 1 ? {
    title: 'Where it is held up', aside: `min per hour · together ${num(tileSeconds / hours / 60, tileSeconds / hours / 60 < 10 ? 1 : 0)}${info.indicative ? ' · indicative' : ''}`, rows: heldRows, total: tileSeconds,
    note: windowKind === 'start'
      ? 'Booked on the cell that blocks (a junction or a dock), not where the vehicle stands.'
      : 'Road cells are listed for Since start only; the queues for a dock are for the last 30 minutes.',
  } : null;

  // ---- the split of its time and the sparkline ----
  // the pieces too small to print (under 0.4 %) are left out; the printed ones add up to exactly 100 % (largest remainder)
  const pieces = SPLIT_PIECES.map(([key, label, tone]) => ({ key, label, tone, share: share(n0(t[key])) })).filter((p) => p.share > 0.004);
  const percents = wholePercents(pieces.map((p) => p.share), { total: 1, min: 1 });
  const items = pieces.map((p, k) => ({ ...p, text: `${percents[k]} %` }));
  const split = { items, label: `Time split: ${items.map((p) => `${p.label} ${p.text}`).join(', ')}` };
  const series = det.workingSeries(i, 60).map((x) => clamp(n0(x), 0, 1));
  let spark = null;
  if (series.length >= 3) {
    // the line is smoothed (a trailing mean of three buckets, 90 s), so the sentence names the smoothing and quotes the smoothed figures it draws
    const smooth = series.map((_, k) => { const win = series.slice(Math.max(0, k - 2), k + 1); return (win.reduce((a, b) => a + b, 0) / win.length) * 100; });
    const lo = Math.min(...smooth); const hi = Math.max(...smooth);
    spark = {
      values: smooth, caption: 'Busy, last 30 min (3-bucket average)', now: 'now',
      label: `Busy share of each 30 seconds over the last ${duration(series.length * 30)}, smoothed over three of them: now ${num(smooth[smooth.length - 1])} %, lowest ${num(lo)} %, highest ${num(hi)} %`,
    };
  }

  // ---- the six numbers ----
  const winWords = info.kind === 'start' ? 'Window: since start.' : info.equalsStart ? 'Window: the last 30 minutes (the same as since start until 30 minutes have been measured).' : 'Window: the last 30 minutes.';
  const driven = n0(c.loaded) + n0(c.empty) + n0(c.park);
  let loadedLegs = 0; let loadedTime = 0;
  for (const p of loadedPairs) if (isNum(p.r.meanTime) && p.r.complete > 0) { loadedLegs += p.r.complete; loadedTime += p.r.meanTime * p.r.complete; }
  const meanLoaded = loadedLegs > 0 ? loadedTime / loadedLegs : null;
  const fleetWord = `fleet ${peers.sampled ? 'about ' : ''}`;
  const tripsPerHour = c.trips / hours;
  const markTrips = deltaMark(tripsPerHour, peers.tripsPerHour, { kind: 'rate', count: c.trips, hours });
  // a rate from a few minutes is a guess: the tile says so (the header already does), and how many deliveries it stands on
  const rateNote = info.indicative ? ` Counted from ${plural(c.trips, 'delivery', 'deliveries')} in ${duration(seconds)}: indicative, the rate will move.` : ` Counted from ${plural(c.trips, 'delivery', 'deliveries')}.`;
  const driveParts = driven > 0 ? wholePercents([c.loaded / driven, c.empty / driven, c.park / driven], { total: 1 }) : [0, 0, 0];
  const tiles = [
    tile('trips', 'vehicle.trips', {
      value: num(tripsPerHour, 1), unit: '/h', raw: tripsPerHour, def: `${withWindow('vehicle.trips', winWords)}${rateNote}${capacity > 1 ? ` This vehicle carries up to ${capacity} loads; the average trip carried ${num(c.trips > 0 ? c.qty / c.trips : 0, 1)}, so it moved ${num(c.qty / hours, 1)} loads an hour.` : ''}`,
      ref: peerRef(markTrips, `${fleetWord}${num(peers.tripsPerHour, 1)}`, true, `${capacity > 1 ? ` · ${num(peers.qtyPerHour, 1)} loads/h` : ''}${info.indicative ? ' · indicative' : ''}`),
    }),
    shareTile('busy', 'vehicle.busy', busy, { def: withWindow('vehicle.busy', winWords), ref: peerRef(deltaMark(busy, peers.busy, { kind: 'share' }), `${fleetWord}${pct(peers.busy)}`) }),
    shareTile('held', 'vehicle.held', held, {
      def: withWindow('vehicle.held', winWords), tone: held >= TRAFFIC_WAIT_SHARE ? 'warn' : '', ref: peerRef(deltaMark(held, peers.held, { kind: 'share' }), `${fleetWord}${pct(peers.held)}`, false),
    }),
    tile('driven', 'vehicle.driven', {
      value: num(driven / hours / 1000, 1), unit: ' km/h', raw: driven / hours / 1000, def: withWindow('vehicle.driven', winWords),
      ref: driven > 0 ? { text: `loaded ${driveParts[0]} % · empty ${driveParts[1]} % · to depot ${driveParts[2]} %` } : { text: 'no distance driven yet' },
    }),
    tile('loaded', 'vehicle.loaded', {
      value: meanLoaded === null ? DASH : secs(meanLoaded), raw: meanLoaded, def: `${withWindow('vehicle.loaded', winWords)} Based on ${plural(loadedLegs, 'complete trip')}.`,
      ref: { text: meanLoaded === null ? 'no complete loaded trip yet' : (peers.meanLoaded !== null ? `${fleetWord}${secs(peers.meanLoaded)}` : '') },
    }),
    battery
      ? tile('battery', 'vehicle.battery', {
        label: windowKind === 'start' ? 'Lowest battery' : 'Lowest, 30 min', value: pct(bat.min), raw: bat.min, share: true, tone: bat.min <= BATTERY_LOW ? 'warn' : '',
        def: withWindow('vehicle.battery', winWords), ref: { text: `${plural(bat.stops.length, 'charge stop')} in the window` },
      })
      : shareTile('parked', 'vehicle.parked', share(n0(t.parked)), { def: withWindow('vehicle.parked', winWords), ref: { text: `${fleetWord}${pct(peers.parked)}` } }),
  ];

  // ---- the facts (at most four; hysteresis on the value) ----
  const facts = [];
  const hkey = (f) => `vehicle:${id}:${windowKind}:${f}`;
  const measuredLong = seconds >= VERDICT_MIN_SECONDS;
  const indicative = info.indicative;
  // a gate that is not met clears the memory of the fact (NaN never holds), so a fact does not come back at the hysteresis level without having reached its threshold
  const gated = (open, value) => (open ? value : NaN);
  if (holds(memory, hkey('held'), gated(measuredLong && tileSeconds >= WAIT_NOTABLE_SECONDS, held), WAIT_SHARE_NOTABLE)) {
    const queueShare = tileSeconds > 0 ? queueSeconds / tileSeconds : 0;
    const topQueue = ordered.find((e) => e.kind === 'queue');
    const topCell = ordered.find((e) => e.kind === 'cell');
    let text = `${name} is held up ${pct(held)} of its time (fleet ${pct(peers.held)})`;
    let rect = null;
    if (queueShare >= QUEUE_SHARE) { // the queue seconds are those of the time split: the same window as the Held up tile
      text += `; ${pct(Math.min(1, queueShare))} of that in the queue for a dock, about ${num(queueSeconds / hours / 60, 1)} min in every hour.`;
      rect = topQueue && topQueue.node >= 0 ? rectOfNodes([topQueue.node], cols, cs) : null;
    } else if (topCell && cellsTotal > 0 && topCell.seconds / cellsTotal >= QUEUE_SHARE) {
      text += `; ${pct(topCell.seconds / cellsTotal)} of it at the ${topCell.label}.`;
      rect = rectOfNodes([topCell.node], cols, cs);
    } else text += '.';
    facts.push({ id: 'held', tone: held >= TRAFFIC_WAIT_SHARE ? 'warn' : 'info', text, rect, indicative });
  }
  const main = loadedPairs.find((p) => p.r.complete >= MIN_LEGS_FOR_USUAL);
  if (main) {
    const u = usualWording({ complete: main.r.complete, variants: main.variants.length, share: main.r.pathShare });
    const ways = waysOf(main);
    const tail = u.usual ? `${u.text}.` : ways.text ? `${u.text} (${ways.text}): the dock chosen changes the way.` : `${u.text}.`;
    facts.push({ id: 'main', tone: 'info', text: `Its main trip ${main.fromName} → ${main.toName}: ${plural(main.r.trips, 'trip')} (${num(main.perHour, 1)} an hour)${isNum(main.r.meanTime) ? `, ${secs(main.r.meanTime)} each` : ''}; ${tail}`, rect: null, indicative });
  }
  const depotShare = share(n0(t.drivingDepot));
  if (holds(memory, hkey('depot'), gated(measuredLong && depots.trips >= DEPOT_DRIVE_MIN, depotShare), DEPOT_DRIVE_SHARE)) {
    facts.push({ id: 'depot', tone: 'info', text: `${pct(depotShare)} of ${name}’s time goes to driving to park or charge (${plural(depots.trips, 'time')} in ${duration(seconds)}); ${pct(safeDiv(c.park, driven))} of its metres.`, rect: null, indicative });
  } else if (holds(memory, hkey('empty'), gated(measuredLong && driven > EMPTY_NOTABLE_METRES, safeDiv(c.empty, driven)), EMPTY_SHARE_NOTABLE)) {
    facts.push({ id: 'empty', tone: 'info', text: `${pct(safeDiv(c.empty, driven))} of the metres ${name} drives are empty, on the way to a pickup (a shuttle between two stations already drives about half of them empty).`, rect: null, indicative });
  }
  if (measuredLong && c.trips === 0) {
    // the sentence names where the time went: the largest pieces of the split (dead or broken down, charging, held up, parked, without a job)
    const causes = [
      [n0(t.broken), 'out of service (broken down or battery empty)'], [n0(t.charging), 'charging'], [n0(t.waiting) + n0(t.dockQueue), 'held up'], [n0(t.parked), 'parked'], [n0(t.idle), 'without a job'],
    ].map(([x, words]) => [share(x), words]).filter(([x]) => x >= 0.05).sort((a, b) => b[0] - a[0]).slice(0, 2);
    const because = causes.length ? causes.map(([x, words], k) => `${k === 0 ? 'it was ' : ''}${words} ${pct(x)}`).join(' and ') : `it was driving, loading or unloading ${pct(busy)}`;
    facts.push({ id: 'none', tone: 'info', text: `${name} made no trip in ${duration(seconds)}: ${because} of the time.`, rect: null, indicative });
  }
  if (fleetRep && n0(fleetRep.count) >= 2 && report.window) {
    const q = fleetQuestion(report, fleetRep, report.window.duration);
    if (q.verdict !== 'indicative') facts.push({ id: 'fleet', tone: q.verdict === 'spare' ? 'good' : 'info', text: `Fleet${windowKind === 'last30' ? ', since start' : ''}: ${q.text}`, rect: null, indicative: false });
  }

  // ---- the blocks ----
  const definitions = [...tiles.map((x) => ({ label: x.label, text: x.def })), ...['time', 'held', 'trips', 'round'].map((k) => BLOCK_DEFINITIONS[k])];
  const wrapNote = wrapped
    ? `Only the newest ${num(cover.rows)} drives are kept: the trips, the usual round, the other drives and the queue by dock count the drives since ${sinceText(layout, legSince)} (${duration(legHours * 3600)}); the numbers of the strip and the time split count the whole window.`
    : null;
  const how = [info.counted, wrapNote, `A trip is a loaded drive; Results counts deliveries, which can differ by one. Figures are exact to the simulation's time step${sim && isNum(sim.dt) ? ` (${num(sim.dt, 1)} s)` : ''}.`, ...changeNotes(det, w, sim && isNum(sim.time) ? sim.time : 0)].filter(Boolean);
  const blocks = [
    { id: 'time', type: 'time', title: 'Where its time goes', aside: info.shortText, split, spark, held: heldBlock },
    { id: 'facts', type: 'facts', title: 'Worth knowing', facts: facts.slice(0, FACTS_MAX), how, definitions },
    {
      id: 'trips', type: 'trips', title: 'Trips', aside: [loadedPairs.length ? `top ${rows.length} of ${loadedPairs.length}` : '', wrapped ? `the last ${num(cover.rows)} drives, since ${sinceText(layout, legSince)}` : ''].filter(Boolean).join(' · '), rows, round, other,
      empty: rows.length ? '' : `No loaded trip in ${info.kind === 'start' ? 'this window' : 'the last 30 minutes'}.`, legend: { max: rampMax, text: `time lost waiting: none → ${Math.round(rampMax * 100)} %+` },
    },
  ];

  // ---- the header line, the announcement, what to bring into view ----
  const toGo = typeof det.metresToGo === 'function' ? det.metresToGo(i) : null;
  const live = liveLine(layout, vr, toGo, Boolean(vr.tv && vr.tv.waiting));
  const lowered = live.strong.charAt(0).toLowerCase() + live.strong.slice(1);
  const bounds = input.routes === false ? undefined : mergeRects(top.flatMap((p) => drawnVariants(p.variants.map((v) => ({ id: v.pathId, n: v.n }))).map((d) => rectOfNodes(p.variants.find((v) => v.pathId === d.id).nodes, cols, cs))));
  return {
    kind: 'vehicle', variant: 'vehicle', status: 'ready', statusText: '', ids, header: { live: { ...live, rest: [live.rest, info.shortText].filter(Boolean).join(' · ') } },
    ariaLabel: `Statistics for ${name}`, announce: `${name} selected: ${lowered}, busy ${pct(busy)}, held up ${pct(held)}.`, bounds, windows: { last30: true }, routes: true,
    window: info, tiles, blocks,
  };
}

/** A vehicle when the collector is not running: the report's own figures (its trips, and its fleet's other numbers), said so. */
function vehicleReportModel(input, id, { fleetDef, fleetRep, name, battery }) {
  const { layout, report } = input;
  const ids = [id];
  const specs = dashTiles(VEHICLE_REPORT_SPECS(battery).map(([tid, def, o]) => [tid, def, o]));
  const trips = fleetRep && fleetRep.vehicleTrips ? fleetRep.vehicleTrips[id] : undefined;
  if (!fleetRep || trips === undefined) {
    const unplaced = n0(fleetRep && fleetRep.unplaced) > 0;
    return statusModel({
      kind: 'vehicle', variant: 'vehicle-report', ids, tiles: specs, status: 'gone', name,
      statusText: unplaced ? 'This vehicle did not fit on the road, so it takes no part in the run.' : 'This vehicle is not part of the run (the plant changed).',
      live: { tone: 'idle', strong: unplaced ? 'Did not fit on the road' : 'Not in the run', rest: '' },
    });
  }
  const info = reportWindow(input);
  const hours = info.hours;
  const tripsPerHour = safeDiv(trips, hours);
  const fleetTrips = n0(fleetRep.tripsPerVehicleHour);
  const mark = deltaMark(tripsPerHour, fleetTrips, { kind: 'rate', count: trips, hours });
  const util = clamp(n0(fleetRep.utilization), 0, 1);
  const waiting = clamp(n0(fleetRep.shares && fleetRep.shares.waiting), 0, 1);
  const winWords = 'Window: since start.';
  const tiles = [
    tile('trips', 'vehicleReport.trips', { value: num(tripsPerHour, 1), unit: '/h', raw: tripsPerHour, def: withWindow('vehicleReport.trips', winWords), ref: peerRef(mark, `fleet ${num(fleetTrips, 1)}`) }),
    shareTile('busy', 'vehicleReport.busy', util, { def: withWindow('vehicleReport.busy', winWords), ref: { text: plural(fleetRep.count, 'vehicle') } }),
    shareTile('held', 'vehicleReport.held', waiting, { def: withWindow('vehicleReport.held', winWords), tone: waiting >= TRAFFIC_WAIT_SHARE ? 'warn' : '', ref: { text: 'fleet' } }),
    tile('driven', 'vehicleReport.driven', {
      value: num(safeDiv(fleetRep.distancePerVehicle, hours) / 1000, 1), unit: ' km/h', raw: safeDiv(fleetRep.distancePerVehicle, hours) / 1000, def: withWindow('vehicleReport.driven', winWords),
      ref: { text: isNum(fleetRep.emptyShare) ? `empty ${pct(fleetRep.emptyShare)} of the metres` : 'no distance driven yet' },
    }),
    tile('loaded', 'vehicleReport.loaded', { value: isNum(fleetRep.avgTransit) ? secs(fleetRep.avgTransit) : DASH, raw: fleetRep.avgTransit, def: withWindow('vehicleReport.loaded', winWords), ref: { text: 'includes unloading' } }),
    tile('battery', 'vehicleReport.battery', {
      value: battery && isNum(fleetRep.minBattery) ? pct(fleetRep.minBattery) : DASH, raw: battery ? fleetRep.minBattery : null, share: true, def: withWindow('vehicleReport.battery', winWords),
      ref: { text: battery ? '' : 'no battery model' }, tone: battery && isNum(fleetRep.minBattery) && fleetRep.minBattery <= BATTERY_LOW ? 'warn' : '',
    }),
  ];
  const facts = [{ id: 'off', tone: 'info', text: 'The statistics of single vehicles are not running, so only the figures of the Results tab are shown: this vehicle\'s trips and the numbers of its fleet. Switch on “Collect statistics for clicked items” in the Simulate tab to see its time split, its usual trips and where it is held up.', rect: null, indicative: false }];
  if (n0(fleetRep.count) >= 2) {
    const q = fleetQuestion(report, fleetRep, report.window.duration);
    if (q.verdict !== 'indicative') facts.push({ id: 'fleet', tone: q.verdict === 'spare' ? 'good' : 'info', text: `Fleet: ${q.text}`, rect: null, indicative: false });
  }
  const blocks = [{
    id: 'facts', type: 'facts', title: 'Worth knowing', facts, how: [info.counted],
    definitions: tiles.map((x) => ({ label: x.label, text: x.def })),
  }];
  return {
    kind: 'vehicle', variant: 'vehicle-report', status: 'ready', statusText: '', ids, header: { live: { tone: '', strong: '', rest: info.shortText } },
    ariaLabel: `Statistics for ${name}`, announce: `${name} selected: ${num(tripsPerHour, 1)} trips an hour; single-vehicle statistics are not running.`,
    windows: { last30: false, note: 'Without the statistics of single vehicles there is only the figure since start.' }, routes: false, window: info, tiles, blocks,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The other kinds: six numbers from the report (docs/ENTITY-INSIGHTS-DESIGN.md 3.2 to 3.10, the strip of step S1)
// ---------------------------------------------------------------------------------------------------------

const NOT_30 = 'For this item the figures are since start. The last 30 minutes are available for vehicles.';

/** The window of a model made from the report alone: since start, the report's own window. */
function reportWindow(input) {
  const rw = (input.report && input.report.window) || { start: 0, duration: 0 };
  return windowInfo(input, { kind: 'start', seconds: n0(rw.duration), t0: n0(rw.start), zero: true });
}

const flowsFrom = (layout, id) => (layout.flows || []).filter((f) => f.from === id);
const flowsTo = (layout, id) => (layout.flows || []).filter((f) => f.to === id);

/** The mean wait for a vehicle over some flows, weighted by their trips (the Results number of a station), and the loads waiting now. */
function pickupOf(report, flows) {
  let trips = 0; let weighted = 0; let now = 0; let avg = 0;
  for (const f of flows) {
    const r = report.flows && report.flows[f.id];
    if (!r) continue;
    now += n0(r.backlog);
    avg += n0(r.avgBacklog);
    if (isNum(r.avgPickupWait) && n0(r.trips) > 0) { trips += r.trips; weighted += r.avgPickupWait * r.trips; }
  }
  return { wait: trips > 0 ? weighted / trips : null, trips, now, avg };
}

const waitTile = (id, spec, p, winWords) => tile(id, spec, {
  value: p.wait === null ? DASH : secs(p.wait), raw: p.wait, def: withWindow(spec, winWords), tone: p.wait !== null && p.wait >= FLEET_PICKUP_WAIT ? 'warn' : '',
  ref: { text: p.wait === null ? 'no load picked up yet' : `waiting now: ${num(p.now)}` },
});

/** Does this finding of the Results tab name the item? */
function namesItem(insight, kind, id) {
  const r = (insight && insight.refs) || {};
  if (kind === 'station') return Array.isArray(r.stationIds) && r.stationIds.includes(id);
  if (kind === 'flow') return Array.isArray(r.flowIds) && r.flowIds.includes(id);
  if (kind === 'fleet') return Array.isArray(r.fleetIds) && r.fleetIds.includes(id);
  if (kind === 'cell') { const [x, y] = String(id).split(',').map(Number); return Array.isArray(r.cells) && r.cells.some((c) => c[0] === x && c[1] === y); }
  return false;
}

const TONE_OF_SEVERITY = { critical: 'bad', warning: 'warn', info: 'info', good: 'good' };

/** The findings of the Results tab (insights.js) that name this item, as facts: the dock and the Results tab cannot disagree. At most four. */
function insightFacts(insights, kind, ids, layout) {
  const out = [];
  for (const ins of Array.isArray(insights) ? insights : []) {
    if (out.length >= FACTS_MAX) break;
    if (!ins || typeof ins.title !== 'string') continue;
    if (!ids.some((id) => namesItem(ins, kind, id))) continue;
    const st = ins.refs && Array.isArray(ins.refs.stationIds) && ins.refs.stationIds.length ? stationDef(layout, ins.refs.stationIds[0]) : null;
    const cs = n0(layout && layout.grid && layout.grid.cellSize) || 1;
    out.push({
      id: `insight:${ins.id}`, tone: TONE_OF_SEVERITY[ins.severity] || 'info', text: ins.title, hint: typeof ins.suggestion === 'string' ? ins.suggestion : '', indicative: false,
      rect: st ? { x: st.x * cs, y: st.y * cs, w: st.w * cs, h: st.h * cs } : null,
    });
  }
  return out;
}

/** The common frame of a kind whose numbers come from the report. */
function reportKindModel(input, { kind, variant, ids, name, tiles, facts, extraBlocks = [], emptyFacts }) {
  const info = reportWindow(input);
  const definitions = tiles.map((x) => ({ label: x.label, text: x.def }));
  return {
    kind, variant, status: 'ready', statusText: '', ids, header: { live: { tone: '', strong: '', rest: info.shortText } },
    ariaLabel: `Statistics for ${name}`, announce: `${name} selected: ${tiles.slice(0, 3).map((x) => `${x.label} ${x.value}${x.unit}`).join(', ')}.`,
    windows: { last30: false, note: NOT_30 }, routes: false, window: info, tiles,
    blocks: [{ id: 'facts', type: 'facts', title: 'Worth knowing', facts: facts.slice(0, FACTS_MAX), how: [info.counted, 'These are the figures of the Results tab, since the start.'], definitions, empty: emptyFacts }, ...extraBlocks],
  };
}

const WAITING_FACTS = 'Nothing has been measured yet.';

/** The docks of a station from the report: visits per hour, how long they were in service, the queue per visit. */
function docksBlock(rep, hours) {
  const docks = rep && Array.isArray(rep.docks) ? rep.docks : [];
  if (!docks.length) return [];
  const most = Math.max(1, ...docks.map((d) => n0(d.visits)));
  return [{
    id: 'docks', type: 'docks', title: 'Docks', aside: `${docks.length} for vehicles`,
    rows: docks.map((d, k) => ({
      key: `dock${k + 1}`, name: `Dock ${k + 1}`, cell: `(${d.cx}, ${d.cy})`, visitsPerHour: safeDiv(d.visits, hours), barShare: clamp(n0(d.visits) / most, 0, 1), inService: clamp(n0(d.busyShare), 0, 1),
      queuePerVisit: n0(d.visits) > 0 ? n0(d.waitBefore) / d.visits : null,
    })),
    skew: rep.dockSkew && typeof rep.dockSkew.reason === 'string' ? rep.dockSkew.reason : '',
  }];
}

// ---- workstation ----

function processTiles(c) {
  const { rep, def, layout, report, hours, winWords, sim } = c;
  const p = def.params || {};
  const machines = Math.max(1, n0(p.machines) || 1);
  const cycle = n0(p.cycle && p.cycle.mean);
  // the process factor multiplies the CYCLE TIMES (2 = twice as long, half the capacity); the running simulation's value wins over the plant's (a what-if setting changes it)
  const factor = n0(sim && sim.settings && sim.settings.processFactor) || n0(layout.settings && layout.settings.processFactor) || 1;
  const capacity = cycle > 0 ? (machines * 3600 * Math.max(1, n0(p.outPerCycle) || 1)) / (cycle * factor) : null;
  const breaks = n0(p.mtbf) > 0 && n0(p.mttr) > 0;
  const outputs = safeDiv(rep.produced, hours);
  const inputs = Math.max(1, flowsTo(layout, def.id).length);
  const room = Math.max(1, n0(p.inCap) || 1) * inputs;
  const pick = pickupOf(report, flowsFrom(layout, def.id));
  return [
    tile('output', 'process.output', { value: num(outputs, 1), unit: ' loads/h', raw: outputs, def: withWindow('process.output', winWords), ref: { text: capacity === null ? '' : `capacity about ${num(capacity, 1)}/h (estimate${breaks ? ', without breakdowns' : ''})` } }),
    shareTile('busy', 'process.busy', clamp(n0(rep.utilization), 0, 1), { def: withWindow('process.busy', winWords), tone: rep.utilization >= BOTTLENECK_UTILIZATION ? 'warn' : '', ref: { text: plural(machines, 'machine') } }),
    shareTile('starved', 'process.starved', clamp(n0(rep.starved), 0, 1), { def: withWindow('process.starved', winWords), tone: rep.starved >= STARVED_SHARE ? 'warn' : '', ref: { text: 'of machine time' } }),
    shareTile('blocked', 'process.blocked', clamp(n0(rep.blocked), 0, 1), { def: withWindow('process.blocked', winWords), tone: rep.blocked >= BLOCKED_SHARE ? 'warn' : '', ref: { text: 'of machine time' } }),
    tile('queue', 'process.queue', { value: num(rep.avgIn, 1), unit: ' loads', raw: rep.avgIn, def: withWindow('process.queue', winWords), ref: { text: `most ${num(rep.maxIn)} of ${num(room)}` } }),
    waitTile('wait', 'process.wait', pick, winWords),
  ];
}

// ---- Goods in ----

function sourceTiles(c) {
  const { rep, def, layout, report, hours, winWords, sim } = c;
  const ops = report.ops && report.ops.trucks ? report.ops.trucks[def.id] : null;
  const outFlows = flowsFrom(layout, def.id);
  const pick = pickupOf(report, outFlows);
  // the room is per outgoing flow (each link has its own buffer of outCap places): the running station says the total, else outCap times the flows
  const rt = sim && sim.logistics && sim.logistics.stationById && typeof sim.logistics.stationById.get === 'function' ? sim.logistics.stationById.get(def.id) : null;
  const room = Math.max(1, rt && typeof rt.outCapacity === 'function' && rt.outCapacity() > 0 ? rt.outCapacity() : (n0(def.params && def.params.outCap) || 1) * Math.max(1, outFlows.length));
  const arrivals = safeDiv(rep.produced, hours);
  const span = duration(n0(report.window.duration));
  const head = [
    tile('arrivals', 'source.arrivals', { value: num(arrivals, 1), unit: ' loads/h', raw: arrivals, def: withWindow('source.arrivals', winWords), ref: { text: ops ? `${plural(ops.trucks.arrived, 'truck')} in ${span}` : `${num(rep.produced)} in ${span}` } }),
    tile('buffer', 'source.buffer', { value: num(rep.avgOut, 1), unit: ' loads', raw: rep.avgOut, def: withWindow('source.buffer', winWords), ref: { text: `most ${num(rep.maxOut)} of ${num(room)}` } }),
    waitTile('wait', 'source.wait', pick, winWords),
    shareTile('full', 'source.full', clamp(n0(rep.blocked), 0, 1), { def: withWindow('source.full', winWords), tone: rep.blocked >= BLOCKED_SHARE ? 'warn' : '', ref: { text: 'of the time' } }),
  ];
  if (ops) {
    // the gate: a dash while no truck has taken a door; "none" only when none of them waited (the longest wait, not the mean, decides); else the mean and the longest
    const gw = ops.gateWait || {};
    const docked = isNum(gw.mean);
    const gate = docked ? gw.mean : null;
    const longest = docked && isNum(gw.max) ? gw.max : null;
    const none = docked && longest !== null && longest < GATE_NONE_SECONDS;
    return [...head,
      shareTile('doors', 'source.doors', clamp(n0(ops.doorUtilization), 0, 1), { def: withWindow('source.doors', winWords), unit: ` of ${num(ops.doors)} doors`, ref: { text: `${plural(ops.trucks.departed, 'truck')} left` } }),
      tile('gate', 'source.gate', {
        value: !docked ? DASH : none ? 'none' : mmss(gate), raw: gate, def: withWindow('source.gate', winWords), tone: docked && gate >= 900 ? 'warn' : '',
        ref: { text: !docked ? 'no truck has taken a door yet' : none ? 'a door was always free' : `longest ${mmss(longest !== null ? longest : gate)}${isNum(gw.p90) ? ` · 90 % under ${mmss(gw.p90)}` : ''}` },
      })];
  }
  return [...head,
    tile('yard', 'source.yard', { value: num(rep.yardNow), unit: ' loads', raw: rep.yardNow, def: withWindow('source.yard', winWords), ref: { text: `most ${num(rep.yardMax)}` } }),
    tile('waiting', 'source.waiting', { value: num(pick.now), unit: ' loads', raw: pick.now, def: withWindow('source.waiting', winWords), ref: { text: `average ${num(pick.avg, 1)}` } })];
}

// ---- storage ----

/**
 * The room of a storage, from the RUNTIME station (`st.capacity`): the ledger of tests/sim.seams.test.js keeps layout-level reads of the capacity out of js/ (a rack changes
 * it later). null when the simulation does not say, then the figures that need it show a dash.
 */
function storageCapacity(sim, id) {
  const lg = sim && sim.logistics;
  const st = lg && lg.stationById && typeof lg.stationById.get === 'function' ? lg.stationById.get(id) : null;
  return st && isNum(st.capacity) && st.capacity > 0 ? st.capacity : null;
}

function storageTiles(c) {
  const { rep, def, layout, report, hours, winWords, sim } = c;
  const cap = storageCapacity(sim, def.id);
  const stock = cap === null ? null : n0(rep.avgFill) * cap;
  const outPerSecond = safeDiv(rep.produced, n0(report.window.duration));
  // Little's law needs a steady stock: while it grows or falls by a quarter of its mean or more over the window, the estimate is withdrawn (honesty rule 7)
  const drift = n0(rep.arrivals) - n0(rep.produced);
  const steady = stock === null || !(stock > 0) || Math.abs(drift) < STORAGE_STEADY * stock;
  const stay = steady && stock !== null && outPerSecond > 0 && stock > 0 ? stock / outPerSecond : null;
  const pick = pickupOf(report, flowsFrom(layout, def.id));
  const dwell = n0(def.params && def.params.dwell);
  return [
    tile('stock', 'storage.stock', {
      value: stock === null ? DASH : num(stock, 1), unit: stock === null ? '' : ' loads', raw: stock, def: withWindow('storage.stock', winWords),
      ref: { text: cap === null ? `most ${pct(rep.maxFill)} full` : `most ${num(Math.round(n0(rep.maxFill) * cap))} of ${num(cap)}` },
    }),
    tile('in', 'storage.in', { value: num(safeDiv(rep.arrivals, hours), 1), unit: ' loads/h', raw: safeDiv(rep.arrivals, hours), def: withWindow('storage.in', winWords), ref: { text: `${num(rep.arrivals)} loads` } }),
    tile('out', 'storage.out', { value: num(safeDiv(rep.produced, hours), 1), unit: ' loads/h', raw: safeDiv(rep.produced, hours), def: withWindow('storage.out', winWords), ref: { text: `${num(rep.produced)} loads` } }),
    tile('stay', 'storage.stay', {
      value: stay === null ? DASH : secs(stay), raw: stay, def: withWindow('storage.stay', winWords),
      ref: { text: steady ? `estimate${dwell > 0 ? ` · set to ${secs(dwell)}` : ''}` : `no estimate: the stock is ${drift > 0 ? 'growing' : 'falling'}` },
    }),
    shareTile('full', 'storage.full', clamp(n0(rep.blocked), 0, 1), { def: withWindow('storage.full', winWords), tone: rep.blocked >= BLOCKED_SHARE ? 'warn' : '', ref: { text: `empty ${pct(rep.starved)}` } }),
    waitTile('wait', 'storage.wait', pick, winWords),
  ];
}

// ---- Goods out ----

function sinkTiles(c) {
  const { rep, def, report, hours, winWords, detail } = c;
  const ops = report.ops && report.ops.trucks ? report.ops.trucks[def.id] : null;
  const by = report.throughput && report.throughput.bySink ? report.throughput.bySink[def.id] : null;
  const count = by ? n0(by.count) : n0(rep.consumed);
  const perHour = by && isNum(by.perHour) ? by.perHour : safeDiv(count, hours);
  const total = n0(report.throughput && report.throughput.total);
  const idx = detail && detail.stIndex ? detail.stIndex.get(def.id) : undefined;
  const lead = detail && detail.sinkLead && idx !== undefined ? detail.sinkLead.get(idx) : null;
  const leadN = lead ? n0(lead.count ?? lead.n) : 0;
  const own = leadN > 0;
  const plantLead = report.leadTime || {};
  const mean = own ? safeDiv(lead.sum, leadN) : (isNum(plantLead.mean) ? plantLead.mean : null);
  const p90 = own ? lead.percentile(0.9) : (isNum(plantLead.p90) ? plantLead.p90 : null);
  // the collector counts from the moment it was switched on (or restarted): when that is later than the report's window, it saw fewer loads than the card says were shipped
  const lateStart = own && detail && isNum(detail.windowStart) && report.window && detail.windowStart - n0(report.window.start) > 1;
  const whose = !own ? 'whole plant' : lateStart ? `this Goods out, based on ${plural(leadN, 'load')} since ${sinceText(c.layout, detail.windowStart)}` : 'this Goods out';
  const head = [
    tile('shipped', 'sink.shipped', { value: num(perHour, 1), unit: ' loads/h', raw: perHour, def: withWindow('sink.shipped', winWords), ref: { text: `${num(count)} in ${duration(n0(report.window.duration))}` } }),
    shareTile('share', 'sink.share', total > 0 ? clamp(count / total, 0, 1) : null, { def: withWindow('sink.share', winWords), ref: { text: 'of the plant\'s output' } }),
    tile('lead', 'sink.lead', { value: mean === null ? DASH : secs(mean), raw: mean, def: withWindow('sink.lead', winWords), ref: { text: whose } }),
    tile('lead90', 'sink.lead90', { value: p90 === null ? DASH : secs(p90), raw: p90, def: withWindow('sink.lead90', winWords), ref: { text: whose } }),
  ];
  if (ops) {
    return [...head,
      shareTile('doors', 'sink.doors', clamp(n0(ops.doorUtilization), 0, 1), { def: withWindow('sink.doors', winWords), unit: ` of ${num(ops.doors)} doors`, ref: { text: `${plural(ops.trucks.departed, 'truck')} left` } }),
      shareTile('fill', 'sink.fill', isNum(ops.fillRate) ? clamp(ops.fillRate, 0, 1) : null, { def: withWindow('sink.fill', winWords), ref: { text: `${plural(ops.trucks.short, 'truck')} left short` } })];
  }
  return [...head,
    tile('total', 'sink.total', { value: num(count), unit: ' loads', raw: count, def: withWindow('sink.total', winWords), ref: { text: 'since the start' } }),
    tile('wip', 'sink.wip', { value: num(n0(report.wip && report.wip.now)), unit: ' loads', raw: n0(report.wip && report.wip.now), def: withWindow('sink.wip', winWords), ref: { text: `most ${num(n0(report.wip && report.wip.max))}` } })];
}

// ---- depot ----

function depotTiles(c) {
  const { rep, def, layout, report, hours, winWords, sim } = c;
  const slots = Math.max(1, n0(def.params && def.params.slots) || 1);
  // vehicles standing in the depot right now: parked or charging (the average and "slots used" count both, so the number of now does too)
  const parkedNow = sim && Array.isArray(sim.vehicles)
    ? sim.vehicles.filter((v) => (v.state === 'parked' || v.state === 'charging') && ((v.depot && v.depot.id === def.id) || (!v.depot && v.targetId === def.id))).length : null;
  const visits = (rep.docks || []).reduce((a, d) => a + n0(d.visits), 0);
  const users = (layout.fleets || []).filter((f) => f.home === def.id).map((f) => report.fleets && report.fleets[f.id]).filter((f) => f && isNum(f.minBattery));
  const lowest = users.length ? Math.min(...users.map((f) => f.minBattery)) : null;
  const chargers = n0(def.params && def.params.chargers);
  return [
    tile('parked', 'depot.parked', { value: parkedNow === null ? DASH : num(parkedNow), unit: ' vehicles', raw: parkedNow, def: withWindow('depot.parked', winWords), ref: { text: `of ${num(slots)} slots` } }),
    tile('average', 'depot.average', { value: num(n0(rep.avgFill) * slots, 1), unit: ' vehicles', raw: n0(rep.avgFill) * slots, def: withWindow('depot.average', winWords), ref: { text: `most ${num(Math.round(n0(rep.maxFill) * slots))}` } }),
    shareTile('slots', 'depot.slots', clamp(n0(rep.avgFill), 0, 1), { def: withWindow('depot.slots', winWords), ref: { text: 'of the slots' } }),
    tile('visits', 'depot.visits', { value: num(safeDiv(visits, hours), 1), unit: '/h', raw: safeDiv(visits, hours), def: withWindow('depot.visits', winWords), ref: { text: `${num(visits)} visits` } }),
    tile('queue', 'depot.queue', { value: visits > 0 ? secs(n0(rep.dockWaitTotal) / visits) : DASH, raw: visits > 0 ? n0(rep.dockWaitTotal) / visits : null, def: withWindow('depot.queue', winWords), ref: { text: visits > 0 ? 'in a queue for a dock' : 'no visit yet' } }),
    tile('chargers', 'depot.chargers', { value: num(chargers), unit: chargers === 1 ? ' charger' : ' chargers', raw: chargers, def: withWindow('depot.chargers', winWords), ref: { text: lowest === null ? 'no battery model' : `lowest battery ${pct(lowest)}` } }),
  ];
}

function stationModel(input, id) {
  const { layout, report, sim, detail } = input;
  const def = stationDef(layout, id);
  const ids = [id];
  const SPECS = {
    process: ['output', 'busy', 'starved', 'blocked', 'queue', 'wait'].map((t) => [t, `process.${t}`]),
    source: ['arrivals', 'buffer', 'wait', 'full', 'yard', 'waiting'].map((t) => [t, `source.${t}`]),
    storage: ['stock', 'in', 'out', 'stay', 'full', 'wait'].map((t) => [t, `storage.${t}`]),
    sink: ['shipped', 'share', 'lead', 'lead90', 'total', 'wip'].map((t) => [t, `sink.${t}`]),
    depot: ['parked', 'average', 'slots', 'visits', 'queue', 'chargers'].map((t) => [t, `depot.${t}`]),
  };
  if (!def) return statusModel({ kind: 'station', variant: 'gone', ids, tiles: dashTiles(SPECS.process), status: 'gone', statusText: 'This station is not in the plant any more.', name: String(id) });
  const type = SPECS[def.type] ? def.type : 'process';
  const name = def.name;
  const rep = report && report.stations ? report.stations[id] : null;
  if (!hasMeasured(report) || !rep) {
    return statusModel({ kind: 'station', variant: type, ids, tiles: dashTiles(SPECS[type]), status: 'waiting', statusText: `Press play to see statistics for ${name}. The numbers appear as soon as the simulation has measured something.`, name, windows: { last30: false, note: NOT_30 } });
  }
  const info = reportWindow(input);
  const c = { rep, def, layout, report, sim, detail, hours: info.hours, winWords: 'Window: since start.' };
  const tiles = { process: processTiles, source: sourceTiles, storage: storageTiles, sink: sinkTiles, depot: depotTiles }[type](c);
  const facts = insightFacts(input.insights, 'station', ids, layout);
  return reportKindModel(input, { kind: 'station', variant: type, ids, name, tiles, facts, extraBlocks: docksBlock(rep, info.hours), emptyFacts: 'The Results tab has no finding for this station.' });
}

// ---- flow ----

function flowModel(input, id) {
  const { layout, report } = input;
  const def = (layout.flows || []).find((f) => f.id === id);
  const ids = [id];
  const SPEC = ['delivered', 'wait', 'backlog', 'transit', 'load', 'trips'].map((t) => [t, `flow.${t}`]);
  if (!def) return statusModel({ kind: 'flow', variant: 'flow', ids, tiles: dashTiles(SPEC), status: 'gone', statusText: 'This flow is not in the plant any more.', name: String(id) });
  const name = `${stationName(layout, def.from)} → ${stationName(layout, def.to)}`;
  const rep = report && report.flows ? report.flows[id] : null;
  if (!hasMeasured(report) || !rep) {
    return statusModel({ kind: 'flow', variant: 'flow', ids, tiles: dashTiles(SPEC), status: 'waiting', statusText: `Press play to see statistics for ${name}. The numbers appear as soon as the simulation has measured something.`, name, windows: { last30: false, note: NOT_30 } });
  }
  const info = reportWindow(input);
  const hours = info.hours;
  const winWords = 'Window: since start.';
  const delivered = safeDiv(rep.delivered, hours);
  const tiles = [
    tile('delivered', 'flow.delivered', { value: num(delivered, 1), unit: ' loads/h', raw: delivered, def: withWindow('flow.delivered', winWords), ref: { text: `${num(rep.delivered)} loads` } }),
    waitTile('wait', 'flow.wait', { wait: isNum(rep.avgPickupWait) ? rep.avgPickupWait : null, now: n0(rep.backlog) }, winWords),
    tile('backlog', 'flow.backlog', { value: num(rep.backlog), unit: ' loads', raw: rep.backlog, def: withWindow('flow.backlog', winWords), ref: { text: `average ${num(rep.avgBacklog, 1)}` } }),
    tile('transit', 'flow.transit', { value: isNum(rep.avgTransit) ? secs(rep.avgTransit) : DASH, raw: rep.avgTransit, def: withWindow('flow.transit', winWords), ref: { text: isNum(rep.avgTransit) ? 'includes unloading' : 'no load delivered yet' } }),
    tile('load', 'flow.load', { value: rep.trips > 0 ? num(rep.delivered / rep.trips, 1) : DASH, unit: rep.trips > 0 ? ' loads' : '', raw: rep.trips > 0 ? rep.delivered / rep.trips : null, def: withWindow('flow.load', winWords), ref: { text: `${num(rep.trips)} trips` } }),
    tile('trips', 'flow.trips', { value: num(safeDiv(rep.trips, hours), 1), unit: '/h', raw: safeDiv(rep.trips, hours), def: withWindow('flow.trips', winWords), ref: { text: `${num(rep.trips)} trips` } }),
  ];
  return reportKindModel(input, { kind: 'flow', variant: 'flow', ids, name, tiles, facts: insightFacts(input.insights, 'flow', ids, layout), emptyFacts: 'The Results tab has no finding for this flow.' });
}

// ---- fleet ----

function fleetModel(input, id) {
  const { layout, report } = input;
  const def = fleetDefOf(layout, id);
  const ids = [id];
  const SPEC = ['busy', 'trips', 'held', 'empty', 'wait', 'question'].map((t) => [t, `fleet.${t}`]);
  if (!def) return statusModel({ kind: 'fleet', variant: 'fleet', ids, tiles: dashTiles(SPEC), status: 'gone', statusText: 'This fleet is not in the plant any more.', name: String(id) });
  const name = def.name;
  const rep = report && report.fleets ? report.fleets[id] : null;
  if (!hasMeasured(report) || !rep) {
    return statusModel({ kind: 'fleet', variant: 'fleet', ids, tiles: dashTiles(SPEC), status: 'waiting', statusText: `Press play to see statistics for ${name}. The numbers appear as soon as the simulation has measured something.`, name, windows: { last30: false, note: NOT_30 } });
  }
  const info = reportWindow(input);
  const hours = info.hours;
  const winWords = 'Window: since start.';
  const per = Object.values(rep.vehicleTrips || {}).map((x) => safeDiv(x, hours));
  const q = fleetQuestion(report, rep, report.window.duration);
  const wordOf = { needed: 'Needed', borderline: 'Borderline', spare: 'Spare', queueing: 'Queueing', unavailable: 'Out of service', limit: 'At the limit', indicative: n0(rep.count) === 0 ? 'None' : n0(rep.count) < 2 ? 'One vehicle' : 'Too early' };
  const refOf = () => {
    if (q.verdict === 'queueing') return q.queue.own >= TRAFFIC_WAIT_SHARE ? `${pct(q.queue.own)} of moving time lost` : `${pct(q.queue.plant)} lost across the plant, this fleet ${pct(q.queue.own)}`;
    if (q.verdict === 'indicative') return n0(rep.count) === 0 ? 'no vehicle in this fleet' : n0(rep.count) < 2 ? 'nothing to compare with' : 'needs 20 min measured';
    if (q.verdict === 'unavailable') return `out of service ${pct(1 - q.available)} of the time`;
    if (q.verdict === 'limit') return 'busy all the time: cannot tell';
    return q.needed !== null ? `about ${plural(q.needed, 'vehicle')} at ${pct(FLEET_TARGET_UTILIZATION)}` : '';
  };
  // the loads this fleet may carry: the flows bound to it and those open to every fleet (insights.js servedFlows); "waiting now" counts the loads of those that no vehicle has claimed
  const served = (layout.flows || []).filter((f) => !f.fleetId || f.fleetId === id);
  const pick = pickupOf(report, served);
  const tiles = [
    shareTile('busy', 'fleet.busy', clamp(n0(rep.utilization), 0, 1), { def: withWindow('fleet.busy', winWords), tone: rep.utilization >= FLEET_CRITICAL_UTILIZATION ? 'warn' : '', ref: { text: plural(rep.count, 'vehicle') } }),
    tile('trips', 'fleet.trips', {
      value: num(rep.tripsPerVehicleHour, 1), unit: '/h', raw: rep.tripsPerVehicleHour, def: withWindow('fleet.trips', winWords),
      ref: { text: per.length ? `range ${num(Math.min(...per), 1)} to ${num(Math.max(...per), 1)}` : '' },
    }),
    shareTile('held', 'fleet.held', clamp(n0(rep.shares && rep.shares.waiting), 0, 1), { def: withWindow('fleet.held', winWords), tone: n0(rep.shares && rep.shares.waiting) >= TRAFFIC_WAIT_SHARE ? 'warn' : '', ref: { text: `${pct(fleetWaitShare(rep))} of moving time` } }),
    shareTile('empty', 'fleet.empty', isNum(rep.emptyShare) ? clamp(rep.emptyShare, 0, 1) : null, { def: withWindow('fleet.empty', winWords), ref: { text: 'of the metres driven' } }),
    tile('wait', 'fleet.wait', {
      value: isNum(rep.avgPickupWait) ? secs(rep.avgPickupWait) : DASH, raw: rep.avgPickupWait, def: withWindow('fleet.wait', winWords),
      tone: isNum(rep.avgPickupWait) && rep.avgPickupWait >= FLEET_PICKUP_WAIT ? 'warn' : '', ref: { text: served.length ? `waiting now: ${num(pick.now)}` : '' },
    }),
    tile('question', 'fleet.question', { value: wordOf[q.verdict], raw: q.forecast, def: withWindow('fleet.question', `${winWords} ${q.text}`), ref: { text: refOf() } }),
  ];
  const facts = insightFacts(input.insights, 'fleet', ids, layout);
  if (q.verdict !== 'indicative' && facts.length < FACTS_MAX) facts.push({ id: 'question', tone: q.verdict === 'spare' ? 'good' : 'info', text: q.text, hint: '', rect: null, indicative: false });
  return reportKindModel(input, { kind: 'fleet', variant: 'fleet', ids, name, tiles, facts, emptyFacts: 'The Results tab has no finding for this fleet.' });
}

// ---- a road cell (the heat of the plant, read once a second) ----

const HEAT_TTL_MS = 1000;
const HEAT_CACHE = new WeakMap();

/**
 * The congestion heat of the simulation (per-edge passes, per-node waiting), cached for a second: heat() allocates three arrays of the size of the road graph. The cache also
 * holds the total waiting and the waits of the cells that had any, sorted, so the rank of a cell is a binary search and not a walk over the whole graph at 4 Hz.
 */
function heatOf(sim, now) {
  const hit = HEAT_CACHE.get(sim);
  if (hit && Math.abs(n0(now) - hit.at) < HEAT_TTL_MS && n0(sim.time) >= hit.simTime) return hit;
  const heat = sim.heat();
  let total = 0;
  let positive = 0;
  for (let k = 0; k < heat.nodeWait.length; k++) { total += heat.nodeWait[k]; if (heat.nodeWait[k] > 0) positive++; }
  const waits = new Float64Array(positive);
  for (let k = 0, at = 0; k < heat.nodeWait.length; k++) if (heat.nodeWait[k] > 0) waits[at++] = heat.nodeWait[k];
  waits.sort(); // ascending
  const entry = { at: n0(now), simTime: n0(sim.time), heat, total, waits };
  HEAT_CACHE.set(sim, entry);
  return entry;
}

/** 1 + the number of cells that waited more than `wait` seconds in all: the rank among the cells with waiting. */
function rankIn(waits, wait) {
  let lo = 0; let hi = waits.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (waits[mid] > wait) hi = mid; else lo = mid + 1; }
  return waits.length - lo + 1;
}

function cellModel(input, key) {
  const { layout, report, sim } = input;
  const ids = [key];
  const SPEC = ['passes', 'wait', 'share', 'delay', 'rank', 'what'].map((t) => [t, `cell.${t}`]);
  const [cx, cy] = String(key).split(',').map(Number);
  const name = `road cell ${cx}, ${cy}`;
  const road = layout.roads && layout.roads[key];
  if (!road) return statusModel({ kind: 'cell', variant: 'cell', ids, tiles: dashTiles(SPEC), status: 'gone', statusText: 'There is no road on this cell any more.', name });
  if (!hasMeasured(report) || !sim || typeof sim.heat !== 'function' || !sim.graph) {
    return statusModel({ kind: 'cell', variant: 'cell', ids, tiles: dashTiles(SPEC), status: 'waiting', statusText: `Press play to see statistics for this ${name}. The numbers appear as soon as the simulation has measured something.`, name, windows: { last30: false, note: 'Road figures are since start only.' } });
  }
  const info = reportWindow(input);
  const hours = info.hours;
  const winWords = 'Window: since start.';
  const graph = sim.graph;
  const node = cy * graph.cols + cx;
  const { heat, total, waits } = heatOf(sim, isNum(input.now) ? input.now : Date.now());
  const into = graph.in && graph.in[node] ? graph.in[node] : [];
  let passes = 0;
  for (const e of into) passes += n0(heat.edgePasses[e]);
  const wait = n0(heat.nodeWait[node]);
  const rank = rankIn(waits, wait);
  const waiting = waits.length;
  const dockOf = Object.values(report.stations || {}).find((st) => st && Array.isArray(st.docks) && st.docks.some((d) => d.node === node));
  const exitList = graph.out && graph.out[node] ? Array.from(graph.out[node]) : [];
  const exits = exitList.length;
  const limit = n0(road.limit) > 0 ? road.limit : 1;
  // what the engine itself says about the cell: it holds one vehicle at a time when `controlled` (a junction, a merge, a crossing, a dead end); the road is one-way when no exit has a link back
  const edges = Array.isArray(graph.edges) ? graph.edges : null;
  const controlled = Boolean(graph.controlled && graph.controlled[node] === 1) || (!graph.controlled && exits >= 3);
  const deadEnd = Boolean(graph.deadEnd && graph.deadEnd[node] === 1);
  const oneWay = exits > 0 && (edges ? exitList.every((e) => edges[e] && edges[e].rev < 0) : exits <= 1);
  const what = dockOf ? 'Dock' : (graph.controlled ? controlled && !deadEnd : exits >= 3) ? 'Junction' : 'Road';
  const holds = deadEnd ? 'dead end, one vehicle at a time' : controlled ? 'one vehicle at a time' : '';
  const detail = [dockOf ? `of ${dockOf.name}` : '', holds, oneWay ? 'one-way' : 'two-way', limit < 1 ? `slow zone ${pct(limit)} speed` : ''].filter(Boolean).join(', ');
  const tiles = [
    tile('passes', 'cell.passes', { value: num(safeDiv(passes, hours), 1), unit: '/h', raw: safeDiv(passes, hours), def: withWindow('cell.passes', winWords), ref: { text: `${num(passes)} in all` } }),
    tile('wait', 'cell.wait', { value: num(wait / hours / 60, wait / hours / 60 < 10 ? 1 : 0), unit: ' min/h', raw: wait / hours / 60, def: withWindow('cell.wait', winWords), ref: { text: `${num(wait, 0)} vehicle-seconds in all` } }),
    shareTile('share', 'cell.share', total > 0 ? clamp(wait / total, 0, 1) : null, { def: withWindow('cell.share', winWords), ref: { text: 'of all waiting' } }),
    tile('delay', 'cell.delay', { value: passes > 0 && wait > 0 ? secs(wait / passes) : (passes > 0 ? '0 s' : DASH), raw: passes > 0 ? wait / passes : null, def: withWindow('cell.delay', winWords), ref: { text: passes > 0 ? 'per vehicle that passed' : 'no vehicle passed yet' } }),
    tile('rank', 'cell.rank', { value: wait > 0 ? num(rank) : DASH, raw: wait > 0 ? rank : null, def: withWindow('cell.rank', winWords), ref: { text: wait > 0 ? `of ${num(waiting)} cells with waiting` : 'no waiting booked here' } }),
    tile('what', 'cell.what', { value: what, def: withWindow('cell.what', winWords), ref: { text: detail } }),
  ];
  const m = reportKindModel(input, { kind: 'cell', variant: 'cell', ids, name, tiles, facts: insightFacts(input.insights, 'cell', ids, layout), emptyFacts: 'The Results tab has no finding for this road cell.' });
  m.windows = { last30: false, note: 'Road figures are since start only.' };
  return m;
}

// ---- several items selected (a strip of six; the comparison tables come with S2) ----

const SEVERAL_NOUN = { station: ['station', 'stations'], flow: ['flow', 'flows'], fleet: ['fleet', 'fleets'], vehicle: ['vehicle', 'vehicles'], cell: ['road cell', 'road cells'] };
const STATION_NOUN = { process: ['workstation', 'workstations'], source: ['Goods in', 'Goods in'], storage: ['storage', 'storages'], sink: ['Goods out', 'Goods out'], depot: ['depot', 'depots'] };

const worstOf = (list, f) => list.reduce((best, x) => (best === null || f(x) > f(best) ? x : best), null);

function severalModel(input, kind, ids) {
  const { layout, report } = input;
  const noun = SEVERAL_NOUN[kind] || ['item', 'items'];
  const name = `${ids.length} ${noun[1]}`;
  const winWords = 'Window: since start.';
  const SPEC = {
    station: [['count', 'several.count'], ['busiest', 'several.worst', { label: 'Busiest workstation' }], ['starved', 'several.worst', { label: 'Waits for material, worst' }], ['blocked', 'several.worst', { label: 'Waits for removal, worst' }], ['output', 'several.sum', { label: 'Output per hour' }], ['wait', 'several.worst', { label: 'Wait for a vehicle, worst' }]],
    vehicle: [['count', 'several.count'], ['trips', 'several.mean', { label: 'Trips per hour' }], ['busy', 'several.mean', { label: 'Busy, incl. waiting' }], ['held', 'several.mean', { label: 'Held up' }], ['driven', 'several.mean', { label: 'Driven' }], ['battery', 'several.worst', { label: 'Lowest battery' }]],
    flow: [['count', 'several.count'], ['delivered', 'several.sum', { label: 'Delivered per hour' }], ['wait', 'several.mean', { label: 'Wait for a vehicle' }], ['backlog', 'several.sum', { label: 'Waiting now' }], ['transit', 'several.mean', { label: 'Transit' }], ['trips', 'several.sum', { label: 'Trips per hour' }]],
    fleet: [['count', 'several.count'], ['vehicles', 'several.sum', { label: 'Vehicles' }], ['busy', 'several.mean', { label: 'Busy' }], ['held', 'several.mean', { label: 'Held up' }], ['trips', 'several.mean', { label: 'Trips per vehicle' }], ['empty', 'several.mean', { label: 'Empty share' }]],
    cell: [['count', 'several.count'], ['length', 'several.sum', { label: 'Length' }], ['passes', 'several.worst', { label: 'Busiest cell' }], ['wait', 'several.sum', { label: 'Waiting here' }], ['worst', 'several.worst', { label: 'Most waiting at' }], ['share', 'several.sum', { label: 'Share of waiting' }]],
  };
  const spec = SPEC[kind] || SPEC.station;
  const skeleton = dashTiles(spec.map(([id, def, o]) => [id, def, o]));
  const waitingModel = () => statusModel({
    kind, variant: `several-${kind}`, ids, tiles: skeleton, status: 'waiting', name, statusText: `Press play to see statistics for these ${noun[1]}. The numbers appear as soon as the simulation has measured something.`,
    windows: { last30: false, note: NOT_30 },
  });
  if (!hasMeasured(report)) return waitingModel();
  const info = reportWindow(input);
  const hours = info.hours;
  const countTile = (ref) => tile('count', 'several.count', { value: num(ids.length), raw: ids.length, ref: { text: ref }, def: DEFINITIONS['several.count'].text });
  const T = (id, def, o) => tile(id, def, { ...o, def: `${DEFINITIONS[def].text} ${winWords}`.trim() });
  let tiles = skeleton;
  let windows = { last30: false, note: NOT_30 };
  if (kind === 'station') {
    const items = ids.map((id) => ({ id, def: stationDef(layout, id), rep: report.stations && report.stations[id] })).filter((x) => x.def && x.rep);
    const procs = items.filter((x) => x.def.type === 'process');
    const kinds = {};
    for (const x of items) kinds[x.def.type] = (kinds[x.def.type] || 0) + 1;
    const mix = Object.entries(kinds).map(([k, v]) => `${v} ${(STATION_NOUN[k] || ['station', 'stations'])[v === 1 ? 0 : 1]}`).join(', ');
    const pickups = items.map((x) => ({ x, p: pickupOf(report, flowsFrom(layout, x.id)) })).filter((e) => e.p.wait !== null);
    const best = (list, f, id, label) => {
      const b = worstOf(list, f);
      return T(id, 'several.worst', { label, value: b ? pct(f(b)) : DASH, raw: b ? f(b) : null, share: true, ref: { text: b ? b.def.name : 'no workstation selected' } });
    };
    const out = procs.reduce((a, x) => a + safeDiv(x.rep.produced, hours), 0);
    const w = worstOf(pickups, (e) => e.p.wait);
    tiles = [
      countTile(mix),
      best(procs, (x) => clamp(n0(x.rep.utilization), 0, 1), 'busiest', 'Busiest workstation'),
      best(procs, (x) => clamp(n0(x.rep.starved), 0, 1), 'starved', 'Waits for material, worst'),
      best(procs, (x) => clamp(n0(x.rep.blocked), 0, 1), 'blocked', 'Waits for removal, worst'),
      T('output', 'several.sum', { label: 'Output per hour', value: procs.length ? num(out, 1) : DASH, unit: procs.length ? ' loads/h' : '', raw: procs.length ? out : null, ref: { text: 'workstations only' } }),
      T('wait', 'several.worst', { label: 'Wait for a vehicle, worst', value: w ? secs(w.p.wait) : DASH, raw: w ? w.p.wait : null, ref: { text: w ? w.x.def.name : 'no load picked up yet' } }),
    ];
  } else if (kind === 'flow') {
    const items = ids.map((id) => ({ id, def: (layout.flows || []).find((f) => f.id === id), rep: report.flows && report.flows[id] })).filter((x) => x.def && x.rep);
    const delivered = items.reduce((a, x) => a + n0(x.rep.delivered), 0);
    const trips = items.reduce((a, x) => a + n0(x.rep.trips), 0);
    const pick = pickupOf(report, items.map((x) => x.def));
    const transit = items.reduce((a, x) => a + (isNum(x.rep.avgTransit) ? x.rep.avgTransit * n0(x.rep.trips) : 0), 0);
    const transitTrips = items.reduce((a, x) => a + (isNum(x.rep.avgTransit) ? n0(x.rep.trips) : 0), 0);
    tiles = [
      countTile('flows'),
      T('delivered', 'several.sum', { label: 'Delivered per hour', value: num(safeDiv(delivered, hours), 1), unit: ' loads/h', raw: safeDiv(delivered, hours), ref: { text: `${num(delivered)} loads` } }),
      T('wait', 'several.mean', { label: 'Wait for a vehicle', value: pick.wait === null ? DASH : secs(pick.wait), raw: pick.wait, ref: { text: 'weighted by trips' } }),
      T('backlog', 'several.sum', { label: 'Waiting now', value: num(pick.now), unit: ' loads', raw: pick.now, ref: { text: `average ${num(pick.avg, 1)}` } }),
      T('transit', 'several.mean', { label: 'Transit', value: transitTrips > 0 ? secs(transit / transitTrips) : DASH, raw: transitTrips > 0 ? transit / transitTrips : null, ref: { text: 'weighted by trips' } }),
      T('trips', 'several.sum', { label: 'Trips per hour', value: num(safeDiv(trips, hours), 1), unit: '/h', raw: safeDiv(trips, hours), ref: { text: `${num(trips)} trips` } }),
    ];
  } else if (kind === 'fleet') {
    const items = ids.map((id) => ({ id, def: fleetDefOf(layout, id), rep: report.fleets && report.fleets[id] })).filter((x) => x.def && x.rep);
    const vehicles = items.reduce((a, x) => a + n0(x.rep.count), 0);
    const weigh = (f) => safeDiv(items.reduce((a, x) => a + n0(f(x.rep)) * n0(x.rep.count), 0), vehicles);
    const distance = items.reduce((a, x) => a + n0(x.rep.distance), 0);
    const trips = items.reduce((a, x) => a + n0(x.rep.trips), 0);
    tiles = [
      countTile('fleets'),
      T('vehicles', 'several.sum', { label: 'Vehicles', value: num(vehicles), raw: vehicles, ref: { text: 'all fleets together' } }),
      T('busy', 'several.mean', { label: 'Busy', value: pct(weigh((r) => r.utilization)), raw: weigh((r) => r.utilization), share: true, ref: { text: 'weighted by vehicles' } }),
      T('held', 'several.mean', { label: 'Held up', value: pct(weigh((r) => r.shares && r.shares.waiting)), raw: weigh((r) => r.shares && r.shares.waiting), share: true, ref: { text: 'weighted by vehicles' } }),
      T('trips', 'several.mean', { label: 'Trips per vehicle', value: num(safeDiv(trips, vehicles * hours), 1), unit: '/h', raw: safeDiv(trips, vehicles * hours), ref: { text: `${num(trips)} trips` } }),
      T('empty', 'several.mean', { label: 'Empty share', value: distance > 0 ? pct(safeDiv(items.reduce((a, x) => a + n0(x.rep.emptyShare) * n0(x.rep.distance), 0), distance)) : DASH, raw: distance > 0 ? safeDiv(items.reduce((a, x) => a + n0(x.rep.emptyShare) * n0(x.rep.distance), 0), distance) : null, share: true, ref: { text: 'weighted by distance' } }),
    ];
  } else if (kind === 'vehicle') {
    const det = input.detail;
    const w = det ? det.windowOf(input.window === 'last30' ? 'last30' : 'start') : null;
    const have = det && w && n0(w.seconds) > 0;
    if (have) {
      windows = { last30: true };
      const winInfo = windowInfo(input, w);
      const vWords = winInfo.kind === 'start' ? 'Window: since start.' : 'Window: the last 30 minutes.';
      const V = ids.map((id) => ({ id, i: typeof det.vehicleIndex === 'function' ? det.vehicleIndex(id) : det.V.findIndex((v) => v.id === id) })).filter((x) => x.i >= 0);
      let trips = 0; let busy = 0; let held = 0; let driven = 0; let seconds = 0; let low = null; let lowName = '';
      for (const x of V) {
        const t = det.timeSplit(x.i, w);
        const cn = det.counts(x.i, w);
        seconds += n0(t.seconds);
        trips += n0(cn.trips);
        busy += safeDiv(n0(t.driving) + n0(t.waiting) + n0(t.dockQueue) + n0(t.loading) + n0(t.unloading), t.seconds);
        held += safeDiv(n0(t.waiting) + n0(t.dockQueue), t.seconds);
        driven += n0(cn.loaded) + n0(cn.empty) + n0(cn.park);
        const fd = fleetDefOf(layout, parseVehicleId(x.id).fleetId);
        if (fd && fd.battery && fd.battery.enabled) { const b = det.batteryOf(x.i, w); if (low === null || b.min < low) { low = b.min; lowName = det.V[x.i].name; } }
      }
      const k = Math.max(1, V.length);
      const hrs = V.length ? seconds / V.length / 3600 : 0;
      const TV = (id, def, o) => tile(id, def, { ...o, def: `${DEFINITIONS[def].text} ${vWords}`.trim() });
      tiles = [
        countTile(V.length === ids.length ? 'vehicles' : `${V.length} in the run`),
        TV('trips', 'several.mean', { label: 'Trips per hour', value: num(safeDiv(trips / k, hrs), 1), unit: '/h', raw: safeDiv(trips / k, hrs), ref: { text: 'per vehicle' } }),
        TV('busy', 'several.mean', { label: 'Busy, incl. waiting', value: pct(busy / k), raw: busy / k, share: true, ref: { text: 'per vehicle' } }),
        TV('held', 'several.mean', { label: 'Held up', value: pct(held / k), raw: held / k, share: true, ref: { text: 'per vehicle' } }),
        TV('driven', 'several.mean', { label: 'Driven', value: num(safeDiv(driven / k, hrs) / 1000, 1), unit: ' km/h', raw: safeDiv(driven / k, hrs) / 1000, ref: { text: 'per vehicle' } }),
        TV('battery', 'several.worst', { label: 'Lowest battery', value: low === null ? DASH : pct(low), raw: low, share: true, ref: { text: low === null ? 'no battery model' : lowName } }),
      ];
      const m = severalFrame(input, { kind, ids, name, tiles, info: winInfo, windows });
      return m;
    }
    // no collector: the report alone has only the trips of each vehicle
    const trips = ids.reduce((a, id) => { const f = report.fleets && report.fleets[parseVehicleId(id).fleetId]; return a + n0(f && f.vehicleTrips && f.vehicleTrips[id]); }, 0);
    tiles = skeleton.map((t) => (t.id === 'count' ? countTile('vehicles') : t.id === 'trips' ? { ...t, value: num(safeDiv(trips / Math.max(1, ids.length), hours), 1), unit: '/h', raw: safeDiv(trips / Math.max(1, ids.length), hours), ref: { ...NOREF, text: 'per vehicle' }, def: `${t.def} ${winWords}` } : t));
  } else if (kind === 'cell') {
    const sim = input.sim;
    if (!sim || typeof sim.heat !== 'function' || !sim.graph) return waitingModel();
    const graph = sim.graph;
    const { heat, total } = heatOf(sim, isNum(input.now) ? input.now : Date.now());
    const cells = ids.map((key) => { const [cx, cy] = String(key).split(',').map(Number); return { key, cx, cy, node: cy * graph.cols + cx }; }).filter((x) => layout.roads && layout.roads[x.key]);
    const passesOf = (x) => (graph.in && graph.in[x.node] ? graph.in[x.node] : []).reduce((a, e) => a + n0(heat.edgePasses[e]), 0);
    const stat = cells.map((x) => ({ x, passes: passesOf(x), wait: n0(heat.nodeWait[x.node]) }));
    const busiest = worstOf(stat, (e) => e.passes);
    const worstWait = worstOf(stat, (e) => e.wait);
    const waitSum = stat.reduce((a, e) => a + e.wait, 0);
    const cs = n0(layout.grid && layout.grid.cellSize) || 1;
    tiles = [
      countTile('road cells'),
      T('length', 'several.sum', { label: 'Length', value: metres(cells.length * cs), raw: cells.length * cs, ref: { text: `${num(cells.length)} ${cells.length === 1 ? 'cell' : 'cells'} of ${metres(cs)}` } }),
      T('passes', 'several.worst', { label: 'Busiest cell', value: busiest ? `${num(safeDiv(busiest.passes, hours), 1)}/h` : DASH, raw: busiest ? safeDiv(busiest.passes, hours) : null, ref: { text: busiest ? `at ${busiest.x.cx}, ${busiest.x.cy}` : '' } }),
      T('wait', 'several.sum', { label: 'Waiting here', value: num(waitSum / hours / 60, waitSum / hours / 60 < 10 ? 1 : 0), unit: ' min/h', raw: waitSum / hours / 60, ref: { text: 'all selected cells' } }),
      T('worst', 'several.worst', { label: 'Most waiting at', value: worstWait && worstWait.wait > 0 ? `${worstWait.x.cx}, ${worstWait.x.cy}` : DASH, ref: { text: worstWait && worstWait.wait > 0 ? `${num(worstWait.wait / hours / 60, 1)} min/h` : 'no waiting booked' } }),
      T('share', 'several.sum', { label: 'Share of waiting', value: total > 0 ? pct(clamp(waitSum / total, 0, 1)) : DASH, raw: total > 0 ? clamp(waitSum / total, 0, 1) : null, share: true, ref: { text: 'of all waiting' } }),
    ];
    windows = { last30: false, note: 'Road figures are since start only.' };
  }
  return severalFrame(input, { kind, ids, name, tiles, info, windows });
}

function severalFrame(input, { kind, ids, name, tiles, info, windows }) {
  const definitions = tiles.map((x) => ({ label: x.label, text: x.def }));
  return {
    kind, variant: `several-${kind}`, status: 'ready', statusText: '', ids, header: { live: { tone: '', strong: '', rest: info.shortText } },
    ariaLabel: `Statistics for ${name}`, announce: `${name} selected: ${tiles.slice(0, 3).map((x) => `${x.label} ${x.value}${x.unit}`).join(', ')}.`, windows, routes: false, window: info, tiles,
    blocks: [{ id: 'facts', type: 'facts', title: 'Worth knowing', facts: [], how: [info.counted, 'Select a single item to see its own statistics; editing stays in the Properties tab.'], definitions, empty: 'Sums are shown only where a sum means something; the other numbers are averages or the worst item.' }],
  };
}

// ---------------------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------------------

/** What makes a view obsolete: another item, another layout of tiles or blocks. Row counts and numbers change in place. */
function signatureOf(m) {
  return [m.kind, m.variant, m.status, (m.ids || []).join('|'), m.tiles.map((t) => t.id).join(','), m.blocks.map((b) => `${b.id}:${b.type}`).join(',')].join('/');
}

/**
 * The view-model of the selection, or null when the selection has no dock (walls and labels) or there is nothing selected.
 * @param {object} input see the header
 */
export function buildStatsModel(input) {
  const sel = input && input.selection;
  if (!sel || !Array.isArray(sel.ids) || sel.ids.length === 0 || !input.layout) return null;
  const several = sel.ids.length > 1;
  let model = null;
  switch (sel.kind) {
    case 'vehicle': model = several ? severalModel(input, 'vehicle', sel.ids) : vehicleModel(input, sel.ids[0]); break;
    case 'station': model = several ? severalModel(input, 'station', sel.ids) : stationModel(input, sel.ids[0]); break;
    case 'flow': model = several ? severalModel(input, 'flow', sel.ids) : flowModel(input, sel.ids[0]); break;
    case 'fleet': model = several ? severalModel(input, 'fleet', sel.ids) : fleetModel(input, sel.ids[0]); break;
    case 'cell': model = several ? severalModel(input, 'cell', sel.ids) : cellModel(input, sel.ids[0]); break;
    default: return null;
  }
  model.signature = signatureOf(model);
  return model;
}
//