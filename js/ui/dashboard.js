// Results dashboard (docs/ARCHITECTURE.md 6.6): the live KPI view of the running simulation.
//
//   const dash = createDashboard(ctx);   // dash.el, dash.update(state), dash.setVisible(bool), dash.destroy()
//
// Data. The panel never owns a timer or a subscription: the shell calls update(state) on every store change and about
// four times a second. Each call reads ctx.runner.kpis() (a KpiReport, js/sim/stats.js) and ctx.runner.insights()
// (js/sim/insights.js), both cached by the runner for 250 ms. Null (no simulation yet) shows the empty state; null
// FIELDS inside a report mean "no data" and render as an en dash. Nothing here throws on a missing section.
//
// Re-render strategy. The DOM is built once (the content lazily, on the first report) and then only patched:
// text nodes, attributes, CSS variables and chart data change in place, so nothing flickers, no chart is re-created
// and nothing moves. Lists (insights, fleets, workstations, flows, hot spots) are keyed: they are rebuilt only when
// their keys change. The expensive part (everything derived from the report) is skipped while the report and the
// insights are the very same objects as last time, while the panel is hidden (setVisible(false), or no layout box),
// and per section while that section is collapsed.
//
// Readings of the spec (also listed in the engineer's report):
//  * "Warming up n %" is the share of settings.warmup that has been simulated. The run chip shows one state at a time,
//    in this order: Not started, Warming up, Running, Paused. While warming up the KPI cards show dashes: the window is
//    discarded when the warm-up ends. Between the end of the warm-up and MIN_DATA_SECONDS of measured time the numbers
//    are shown dimmed under a "not enough data yet" notice, and the insights list waits for enough data.
//  * The bottleneck row of the workstation table is the one the insights call a bottleneck (id "bottleneck:<station>"),
//    so the table and the insights can never disagree. Rows are sorted by utilization, but re-sorted at most every
//    REORDER_MS and never while the pointer or the keyboard is in the table, so a row does not run away under the cursor.
//  * "Backlog" in the flows table is the window average (flows[].avgBacklog), as in the insights: the instantaneous
//    count flickers by a load or two. It falls back to the current count when a report has no average.
//  * The metric tooltips are a small shared popover (the kit's [data-tip] is clipped by the scrolling panel), reachable by
//    hover, keyboard focus and tap, and dismissed with Escape.
//  * The few layout rules the kit has no class for (KPI grid, bar cells, hot spot rows) are injected once as a scoped
//    <style>; they use tokens only. They can move to css/layout.css without changing any markup.

import { h } from '../util/dom.js';
import { clamp, formatClock, formatDistance, formatDuration, formatNumber } from '../util/format.js';
import {
  FLEET_CRITICAL_UTILIZATION, FLEET_OVERSIZED_UTILIZATION, FLEET_SATURATED_UTILIZATION, MIN_DATA_SECONDS,
  TRAFFIC_CRITICAL_WAIT_SHARE, TRAFFIC_WAIT_SHARE, TRANSPORT_BACKLOG,
} from '../sim/insights.js';
import { createLineChart, createSparkline, STATE_LABELS } from './charts.js';
import { icon } from './icons.js';
import { emptyState, kvList, segmentedField, SEVERITY, uid } from './panels/fields.js';
import { createImpactCard } from './panels/impact.js';
import { createDoorsSection } from './panels/doors-card.js';

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

const DASH = '–';
/** Vehicle states in the order of the stacked bars (the same order and colours as the kit's STATE_KEYS). */
const VEHICLE_STATES = Object.freeze(['driving', 'waiting', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken']);
/** Workstation states in the order of the stacked mini bars. */
const STATION_STATES = Object.freeze(['busy', 'starved', 'blocked', 'down']);
const STATE_HINTS = Object.freeze({
  driving: 'Driving to a pickup, a drop-off or a depot',
  waiting: 'Standing still in traffic: another vehicle, a junction or a broken-down vehicle is in the way',
  loading: 'Picking up loads',
  unloading: 'Putting loads down',
  idle: 'Waiting for a job on the road',
  parked: 'Parked in a depot',
  charging: 'Charging the battery',
  broken: 'Broken down, waiting for repair',
  busy: 'Working on a load',
  starved: 'Waiting for input: nothing to work on',
  blocked: 'Finished, but the output buffer is full',
  down: 'Broken down, waiting for repair',
});
/** Insights shown before "Show all". */
export const INSIGHTS_COLLAPSED = 6;
/** Minimum time between two re-sorts of the workstation table (ms). */
export const REORDER_MS = 2500;
/** Workstation rows shown before "Show all" (the table is sorted, so these are the busiest). */
export const STATION_ROWS_COLLAPSED = 10;
/** Seconds per visit that vehicles must have queued for the only dock of a station before the Docks list shows it. */
export const DOCK_QUEUE_PER_VISIT = 5;
/** A dock an idle vehicle stood on for at least this share of the window says so next to its busy share. */
export const DOCK_HELD_SHOWN = 0.1;
/** Stations that appear in the workstation table. */
const TABLE_TYPES = Object.freeze(['process', 'storage']);
export const KPI_IDS = Object.freeze(['throughput', 'leadTime', 'wip', 'fleet', 'traffic', 'deadlocks']);
const HEAT_MODES = Object.freeze(['waiting', 'traffic']);

// ---------------------------------------------------------------------------------------------------------------------
// Pure view models (no DOM: unit-tested in tests/ui.dashboard.test.js). Every builder tolerates null at any depth.
// ---------------------------------------------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object';
/** A plain object, or an empty one. */
const rec = (v) => (isObj(v) && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v : []);
/** A finite number, or null. */
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A fraction clamped to 0..1, or null. */
const frac = (v) => { const n = fin(v); return n === null ? null : clamp(n, 0, 1); };
const text = (v, fallback = '') => (typeof v === 'string' && v ? v : fallback);

/**
 * formatNumber, memoized on the rounded value. Number.prototype.toLocaleString costs microseconds per call and a
 * dashboard formats hundreds of numbers per refresh, most of them repeating the same few hundred values; the cache
 * makes a refresh several times cheaper and returns exactly the text formatNumber would.
 */
const numberCache = [new Map(), new Map(), new Map()];
function number(v, digits) {
  const cache = numberCache[digits];
  const key = Math.round(v * 10 ** digits) + 0; // + 0: no negative zero (it would print as "-0")
  let out = cache.get(key);
  if (out === undefined) {
    if (cache.size > 4000) cache.clear();
    out = formatNumber(key / 10 ** digits, digits);
    cache.set(key, out);
  }
  return out;
}

/** "73 %", one decimal below 10 %; an en dash for no data. */
const pct = (v) => { const f = frac(v); return f === null ? DASH : `${number(f * 100, f > 0 && f < 0.1 ? 1 : 0)} %`; };
/** A count or rate: one decimal below 10 ("3.2"), none above ("112"). */
const amount = (v) => { const n = fin(v); return n === null ? DASH : number(n, Math.abs(n) < 10 ? 1 : 0); };
const whole = (v) => { const n = fin(v); return n === null ? DASH : number(n, 0); };
const dur = (v) => { const n = fin(v); return n === null || n < 0 ? DASH : formatDuration(n); };
const plural = (n, one, many) => `${number(n, 0)} ${n === 1 ? one : many}`;

/** "12.5 min" -> { value: '12.5', unit: 'min' } for the big KPI number and its small unit. */
function splitValue(str) {
  const i = str.indexOf(' ');
  return i < 0 ? { value: str, unit: '' } : { value: str.slice(0, i), unit: str.slice(i + 1) };
}

/**
 * How much data the report holds: 'none' (no report: no simulation yet), 'warming' (the warm-up is still running; its
 * window is discarded), 'short' (less than MIN_DATA_SECONDS measured: shown, but not reliable) or 'ready'.
 */
export function dataState(report) {
  if (!isObj(report)) return 'none';
  const w = rec(report.window);
  if (w.warmingUp === true) return 'warming';
  return (fin(w.duration) ?? 0) < MIN_DATA_SECONDS ? 'short' : 'ready';
}

/** Whole percent of the warm-up; never 100 while it is still running (the clock of the engine stops a tick early). */
const warmupPercent = (p) => Math.min(99, Math.round(p * 100));

/**
 * The run state for the status row.
 * @returns {{ key: 'idle'|'warming'|'running'|'paused', label: string, clock: string, windowText: string, progress: number|null }}
 */
export function runStatus({ report = null, playing = false, time = null, warmup = 0 } = {}) {
  const state = dataState(report);
  const clock = formatClock(fin(time) ?? fin(rec(rec(report).window).end) ?? 0);
  if (state === 'none') return { key: 'idle', label: 'Not started', clock, windowText: '', progress: null };
  const duration = fin(rec(report.window).duration);
  if (state === 'warming') {
    const p = fin(warmup) > 0 && duration !== null ? clamp(duration / warmup, 0, 1) : null;
    return {
      key: 'warming',
      label: p === null ? 'Warming up' : `Warming up ${warmupPercent(p)} %`,
      clock,
      windowText: playing ? '' : 'Paused',
      progress: p,
    };
  }
  return {
    key: playing ? 'running' : 'paused',
    label: playing ? 'Running' : 'Paused',
    clock,
    windowText: duration === null ? '' : `${formatDuration(duration)} measured`,
    progress: null,
  };
}

/** The notice above the cards while the numbers are not (yet) meaningful; null when they are. */
export function noticeModel(report, status) {
  const state = dataState(report);
  if (state === 'warming') {
    return {
      key: 'warming',
      title: status.progress === null ? 'Warming up' : `Warming up: ${warmupPercent(status.progress)} % done`,
      text: 'The plant starts empty, so the first minutes would give a misleading picture and are not counted. Results appear when the warm-up is over.',
      progress: status.progress,
    };
  }
  if (state === 'short') {
    const duration = fin(rec(report.window).duration) ?? 0;
    return {
      key: 'short',
      title: 'Not enough data yet',
      text: `Only ${dur(duration)} of simulated time have been measured. The figures below are preliminary; they become reliable after ${dur(MIN_DATA_SECONDS)}, and the insights appear then.`,
      progress: clamp(duration / MIN_DATA_SECONDS, 0, 1),
    };
  }
  return null;
}

/** Vehicle-weighted mean of the fleets' utilization (0..1), or null without vehicles. */
export function fleetUtilization(fleets) {
  let vehicles = 0;
  let weighted = 0;
  for (const raw of Object.values(rec(fleets))) {
    const f = rec(raw);
    const count = fin(f.count) ?? 0;
    const u = frac(f.utilization);
    if (count > 0 && u !== null) { vehicles += count; weighted += count * u; }
  }
  return vehicles > 0 ? weighted / vehicles : null;
}

const finiteSeries = (report, key) => list(rec(rec(report).series)[key]).map(fin);

const utilizationStatus = (u) => {
  if (u === null) return null;
  if (u >= FLEET_CRITICAL_UTILIZATION) return { tone: 'bad', label: 'Overloaded' };
  if (u >= FLEET_SATURATED_UTILIZATION) return { tone: 'warn', label: 'Saturated' };
  if (u < FLEET_OVERSIZED_UTILIZATION) return { tone: 'info', label: 'Mostly idle' };
  return { tone: 'good', label: 'Healthy' };
};

/**
 * The fleet card's verdict: a "fleet is saturated" insight wins (a fleet also counts as saturated when loads wait long for
 * it, whatever its utilization); otherwise the utilization thresholds the insights use decide.
 */
function fleetStatus(util, insights) {
  const saturated = list(insights).map(rec).find((i) => typeof i.id === 'string' && i.id.startsWith('fleet-saturated:'));
  if (saturated) return saturated.severity === 'critical' ? { tone: 'bad', label: 'Overloaded' } : { tone: 'warn', label: 'Saturated' };
  return utilizationStatus(util);
}

const trafficStatus = (share) => {
  if (share === null) return null;
  if (share >= TRAFFIC_CRITICAL_WAIT_SHARE) return { tone: 'bad', label: 'Congested' };
  if (share >= TRAFFIC_WAIT_SHARE) return { tone: 'warn', label: 'Queues forming' };
  return { tone: 'good', label: 'Flowing' };
};

function deadlockStatus(n, events) {
  if (n === null) return null;
  if (n === 0) return { tone: 'good', label: 'None' };
  return list(events).some((e) => rec(e).resolved === false) ? { tone: 'bad', label: 'Jam not resolved' } : { tone: 'warn', label: 'Resolved by moving a vehicle' };
}

/**
 * The six headline cards: { id, value, unit, note, status: {tone, label}|null, spark: number[]|null, muted }.
 * While warming up (or without a report) every value is an en dash: the window is discarded when the warm-up ends.
 */
export function kpiModels(report, state = dataState(report), insights = []) {
  if (state === 'none' || state === 'warming') {
    const note = state === 'warming' ? 'Not counted yet' : 'No data yet';
    return KPI_IDS.map((id) => ({ id, value: DASH, unit: '', note, status: null, spark: null, muted: true }));
  }
  const r = rec(report);
  const muted = state === 'short';
  const tp = rec(r.throughput);
  const lead = rec(r.leadTime);
  const wip = rec(r.wip);
  const traffic = rec(r.traffic);
  const total = fin(tp.total);
  const leadMean = splitValue(dur(lead.mean));
  const wipNow = fin(wip.now) ?? fin(wip.mean);
  const util = fleetUtilization(r.fleets);
  const vehicles = Object.values(rec(r.fleets)).reduce((n, f) => n + (fin(rec(f).count) ?? 0), 0);
  const share = frac(traffic.waitShare);
  const stuck = fin(traffic.deadlocks);
  const cards = [
    {
      id: 'throughput', value: amount(tp.perHour), unit: fin(tp.perHour) === null ? '' : '/h',
      note: total === null ? '' : `${plural(total, 'load', 'loads')} delivered`, status: null, spark: finiteSeries(r, 'throughput'),
    },
    {
      id: 'leadTime', value: leadMean.value, unit: leadMean.unit,
      note: fin(lead.p95) !== null ? `95 % within ${dur(lead.p95)}` : (fin(lead.count) === 0 ? 'No load delivered yet' : ''), status: null, spark: null,
    },
    {
      id: 'wip', value: whole(wipNow), unit: wipNow === null ? '' : 'loads',
      note: fin(wip.mean) === null ? '' : `avg ${amount(wip.mean)} · peak ${whole(wip.max)}`, status: null, spark: finiteSeries(r, 'wip'),
    },
    {
      id: 'fleet', value: util === null ? DASH : number(util * 100, 0), unit: util === null ? '' : '%',
      note: vehicles > 0 ? plural(vehicles, 'vehicle', 'vehicles') : 'No vehicles', status: fleetStatus(util, insights), spark: null,
    },
    {
      id: 'traffic', value: share === null ? DASH : number(share * 100, share > 0 && share < 0.1 ? 1 : 0), unit: share === null ? '' : '%',
      note: 'of the driving time', status: trafficStatus(share), spark: null,
    },
    {
      id: 'deadlocks', value: whole(stuck), unit: '',
      note: stuck === 0 ? 'No vehicles blocked each other' : stuck === null ? '' : 'Vehicles blocked each other in a circle', status: deadlockStatus(stuck, traffic.deadlockEvents), spark: null,
    },
  ];
  return cards.map((c) => ({ ...c, muted }));
}

/**
 * One entry per fleet: name, counts, the eight state shares (for the stacked bar) and the formatted metrics.
 * @returns {Array<{ id: string, name: string, countText: string, utilText: string, states: Array<{key: string, label: string, frac: number}>, aria: string,
 *   metrics: { traffic: string, trips: string, distance: string, empty: string, pickup: string, battery: string|null } }>}
 */
export function fleetModels(report) {
  return Object.entries(rec(rec(report).fleets)).map(([id, raw]) => {
    const f = rec(raw);
    const shares = rec(f.shares);
    const states = VEHICLE_STATES.map((key) => ({ key, label: STATE_LABELS[key], frac: frac(shares[key]) ?? 0 }));
    const count = fin(f.count) ?? 0;
    const unplaced = fin(f.unplaced) ?? 0;
    const trips = fin(f.tripsPerVehicleHour);
    const name = text(f.name, id);
    return {
      id,
      name,
      countText: unplaced > 0 ? `${count} of ${count + unplaced} vehicles on the road` : plural(count, 'vehicle', 'vehicles'),
      utilText: pct(f.utilization),
      states,
      aria: `${name}: ${states.filter((s) => s.frac >= 0.005).map((s) => `${s.label} ${pct(s.frac)}`).join(', ') || 'no data'}`,
      metrics: {
        traffic: pct(shares.waiting),
        trips: trips === null ? DASH : `${amount(trips)} /h`,
        distance: formatDistance(fin(f.distancePerVehicle) ?? NaN),
        empty: pct(f.emptyShare),
        pickup: dur(f.avgPickupWait),
        battery: frac(f.minBattery) === null ? null : pct(f.minBattery),
      },
    };
  });
}

/** Ids of the workstations the insights call a bottleneck. */
export function bottleneckIds(insights) {
  const ids = new Set();
  for (const ins of list(insights)) {
    const id = rec(ins).id;
    if (typeof id === 'string' && id.startsWith('bottleneck:')) ids.add(id.slice('bottleneck:'.length));
  }
  return ids;
}

/** Workstation and buffer rows (report order); see sortStationRows. */
export function stationRows(report, bottlenecks = new Set()) {
  const rows = [];
  for (const [id, raw] of Object.entries(rec(rec(report).stations))) {
    const s = rec(raw);
    if (!TABLE_TYPES.includes(s.type)) continue;
    const process = s.type === 'process';
    const util = frac(s.utilization) ?? (process ? null : frac(s.avgFill));
    const shares = process ? STATION_STATES.map((key) => ({ key, label: STATE_LABELS[key], frac: frac(key === 'busy' ? s.utilization : s[key]) ?? 0 })) : null;
    const fill = frac(s.avgFill) ?? 0;
    const name = text(s.name, id);
    rows.push({
      id,
      type: s.type,
      name,
      util,
      utilText: pct(util),
      shares,
      fill: process ? null : fill,
      avgText: amount(process ? s.avgIn : s.avgOut),
      maxText: whole(process ? s.maxIn : s.maxOut),
      bottleneck: bottlenecks.has(id),
      aria: process
        ? `${name}: ${shares.map((x) => `${x.label} ${pct(x.frac)}`).join(', ')}`
        : `${name}: on average ${pct(fill)} full`,
    });
  }
  return rows;
}

/** Highest utilization first (rows without data last), then by name: a stable order for equal values. */
export function sortStationRows(rows) {
  return rows.slice().sort((a, b) => (b.util ?? -1) - (a.util ?? -1) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Flow rows in layout order: "From → To" with delivered loads, trips, waits and the waiting backlog. */
export function flowRows(report) {
  const stations = rec(rec(report).stations);
  const nameOf = (id) => text(rec(stations[id]).name, typeof id === 'string' && id ? id : DASH);
  return Object.entries(rec(rec(report).flows)).map(([id, raw]) => {
    const f = rec(raw);
    const backlog = fin(f.avgBacklog) ?? fin(f.backlog);
    return {
      id,
      name: `${nameOf(f.from)} → ${nameOf(f.to)}`,
      delivered: whole(f.delivered),
      trips: whole(f.trips),
      pickup: dur(f.avgPickupWait),
      transit: dur(f.avgTransit),
      backlog: amount(backlog),
      backlogNow: whole(f.backlog),
      waiting: backlog !== null && backlog >= TRANSPORT_BACKLOG,
    };
  });
}

/** The traffic hot spots with their share of the worst one (for the bar length). */
export function hotspotRows(report) {
  const spots = list(rec(rec(report).traffic).hotspots).map(rec).filter((s) => fin(s.cx) !== null && fin(s.cy) !== null && fin(s.wait) !== null);
  const worst = Math.max(0, ...spots.map((s) => s.wait));
  return spots.map((s) => ({
    cx: s.cx, cy: s.cy, label: `(${s.cx}, ${s.cy})`, waitText: dur(s.wait), seconds: `${whole(s.wait)} s`, frac: worst > 0 ? s.wait / worst : 0,
  }));
}

/**
 * The docks of every station that has several (or that vehicles queued for): one row per station with its docks, how busy each was (share of
 * the window a vehicle was served on it; and, when an idle vehicle only stood on it, that share too) and its visits, and how long vehicles
 * queued for a dock of the station. Longest queue first.
 */
export function dockRows(report) {
  const rows = [];
  for (const [id, raw] of Object.entries(rec(rec(report).stations))) {
    const s = rec(raw);
    const docks = list(s.docks).map(rec);
    const wait = fin(s.dockWaitTotal) ?? 0;
    const visits = docks.reduce((n, d) => n + (fin(d.visits) ?? 0), 0);
    // a single dock says nothing the station's own figures do not, unless vehicles queued for it (5 s or more per visit)
    if (docks.length === 0 || (docks.length < 2 && !(visits > 0 && wait >= DOCK_QUEUE_PER_VISIT * visits))) continue;
    rows.push({
      id,
      name: text(s.name, id),
      wait,
      waitText: wait >= 1 ? `queued ${dur(wait)}` : '',
      docks: docks.map((d) => {
        const busy = frac(d.busyShare) ?? 0;
        const held = frac(d.heldShare) ?? 0;
        const label = `(${whole(d.cx)}, ${whole(d.cy)})`;
        const visitsText = plural(fin(d.visits) ?? 0, 'visit', 'visits');
        const heldText = held >= DOCK_HELD_SHOWN ? `idle vehicle on it ${pct(held)}` : '';
        return { label, busy, busyText: pct(busy), visitsText, heldText, aria: `Dock ${label}: busy ${pct(busy)} of the time, ${visitsText}${heldText ? `, ${heldText} of the time` : ''}` };
      }),
    });
  }
  return rows.sort((a, b) => b.wait - a.wait || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The "where did the waiting come from" figures, in the order of the key/value list. */
export function trafficBreakdown(report) {
  const t = rec(rec(report).traffic);
  return [
    ['Behind other vehicles', dur(t.vehicleWait)],
    ['At junctions', dur(t.junctionWait)],
    ['Behind broken-down vehicles', dur(t.brokenWait)],
  ];
}

/** The insights to list: the "not enough data" placeholder is the notice's job; `hidden` are those behind "Show all". */
export function visibleInsights(insights, showAll = false, limit = INSIGHTS_COLLAPSED) {
  const all = list(insights).filter((i) => isObj(i) && typeof i.id === 'string' && i.id !== 'not-enough-data' && text(i.title));
  const shown = showAll ? all : all.slice(0, limit);
  return { shown, total: all.length, hidden: all.length - shown.length };
}

/** The ctx.actions.focus argument for an insight's refs, or null when it points at nothing on the plan. */
export function focusTarget(refs) {
  const r = rec(refs);
  const target = {};
  for (const key of ['stationIds', 'flowIds', 'fleetIds']) if (list(r[key]).length) target[key] = r[key].slice();
  const cells = list(r.cells).filter((c) => Array.isArray(c) && c.length >= 2);
  if (cells.length) target.cells = cells.map((c) => [c[0], c[1]]);
  return Object.keys(target).length ? target : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------------------------------------------------

const KPI_DEFS = Object.freeze([
  { id: 'throughput', label: 'Throughput', color: '--series-1', unit: 'loads per hour', help: 'Finished loads leaving the plant per hour, counted since the warm-up ended. The line shows the last 10 minutes.' },
  { id: 'leadTime', label: 'Lead time', help: 'Average time a load needs from entering the plant to leaving it. The second figure says that 95 out of 100 loads were faster.' },
  { id: 'wip', label: 'Work in progress', color: '--series-2', unit: 'loads', help: 'Loads that are in the plant right now: waiting, on a vehicle or being worked on. Many loads mean long waits.' },
  { id: 'fleet', label: 'Fleet utilization', help: 'Share of time the vehicles are working: driving, waiting in traffic, loading or unloading. Above 85 % there is no room for peaks; below 35 % you probably have too many vehicles.' },
  { id: 'traffic', label: 'Time waiting in traffic', help: 'Share of the driving time that vehicles stand still because another vehicle, a junction or a broken-down vehicle is in the way.' },
  { id: 'deadlocks', label: 'Deadlocks', help: 'Times vehicles blocked each other in a circle so that none could move. In a real plant somebody would have to step in.' },
]);

const PLAY_HINT = 'Throughput, lead times, vehicle use and bottlenecks appear here while the simulation runs.';
const MEASURED_TITLE = 'The figures below cover the time since the warm-up ended.';

// ---------------------------------------------------------------------------------------------------------------------
// Scoped styles: only what the kit has no class for, tokens only (see the header comment).
// ---------------------------------------------------------------------------------------------------------------------

const STYLE_ID = 'dashboard-styles';
const CSS = `
.dash{container-type:inline-size;position:relative;display:flex;flex-direction:column;gap:var(--sp-4);min-width:0;padding:var(--sp-3)}
.dash__status{display:flex;flex-wrap:wrap;align-items:center;gap:6px var(--sp-3)}
.dash__meta{display:inline-flex;align-items:center;gap:6px;color:var(--text-dim);font-size:var(--fs-sm);font-variant-numeric:tabular-nums}
.dash__meta strong{color:var(--text);font-weight:var(--fw-semibold)}
.dash__notice .progress{margin-top:8px}
.dash__kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(max(150px,calc((100% - 2 * var(--sp-2)) / 3)),1fr));gap:var(--sp-2)}
.dash-kpi .kpi{height:100%}
.dash-kpi .kpi__label{display:flex;align-items:center;gap:2px;min-height:20px}
.dash-kpi .kpi__value{min-height:31px}
.dash-kpi .kpi__foot{margin-top:auto;padding-top:6px}
.dash-kpi.is-muted .kpi__value{color:var(--text-dim)}
.dash-kpi__meta{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--text-dim);font-size:var(--fs-sm);line-height:1.3}
.dash-status{display:inline-flex;align-items:center;gap:6px;color:var(--text);font-weight:var(--fw-medium)}
.dash-help{display:inline-grid;flex:none;place-items:center;width:24px;height:24px;margin:-4px 0;padding:0;border:0;border-radius:var(--radius-pill);background:transparent;color:var(--text-faint);cursor:help}
.dash-help:hover{background:var(--hover);color:var(--text)}
.dash-tip{z-index:var(--z-float);max-width:min(280px,calc(100% - 8px))}
.dash-sec>.section__header{border-radius:var(--radius-md);padding:6px var(--sp-2)}
.dash-sec__title{font-size:var(--fs-md)}
.dash-sec__body{display:flex;flex-direction:column;gap:var(--sp-2);padding-top:var(--sp-1)}
.dash-note{margin:0;padding:var(--sp-2) var(--sp-3);color:var(--text-dim);font-size:var(--fs-sm)}
.dash-actions{display:flex;flex-wrap:wrap;gap:var(--sp-2);margin-top:6px}
.dash-insights{display:flex;flex-direction:column;gap:var(--sp-2)}
.dash-insight[data-clickable]{cursor:pointer}
.dash-insight[data-clickable]:hover{box-shadow:inset 0 0 0 1px var(--border-hover)}
.dash-insight .dash-lead{font-weight:var(--fw-semibold)}
.dash-chart{padding:var(--sp-3)}
.dash-chart+.dash-chart{border-top:1px solid var(--border)}
.dash-chart__title{display:flex;flex-wrap:wrap;gap:0 6px;align-items:baseline;margin-bottom:4px;font-size:var(--fs-sm);font-weight:var(--fw-semibold)}
.dash-chart__title span{color:var(--text-dim);font-weight:var(--fw-regular)}
.dash-fleets{display:flex;flex-direction:column;gap:var(--sp-2)}
.dash-fleet .card__header{min-height:0;padding:10px var(--sp-3)}
.dash-fleet .card__title{min-width:0}
.dash-fleet__side{--gap:0;flex:none;text-align:right;white-space:nowrap}
.dash-fleet__util{font-size:var(--fs-lg);font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums}
.dash-states{gap:2px}
.dash-states .progress__bar{flex:1 1 0%;transition:flex-grow var(--t-slow) var(--ease)}
.dash-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:var(--sp-2) var(--sp-3);margin:var(--sp-3) 0 0}
.dash-metrics>div{display:flex;flex-direction:column;justify-content:space-between;gap:2px;min-width:0}
.dash-metrics dt{color:var(--text-dim);font-size:var(--fs-xs);line-height:1.3}
.dash-metrics dd{margin:0;font-size:var(--fs-md);font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums}
.dash-legend{margin:0;padding:0 var(--sp-2)}
.dash-table th,.dash-table td{padding:5px 6px}
.dash-table th{white-space:normal;line-height:1.2;vertical-align:bottom}
.dash-table td{vertical-align:middle}
.dash-table tbody tr[data-row]{cursor:pointer}
.dash-name{display:flex;align-items:center;gap:6px;min-width:0;max-width:104px}
.dash-table td.dash-wrap{min-width:84px;max-width:150px;white-space:normal}
.dash-clamp{display:-webkit-box;overflow:hidden;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dash-flag{display:inline-flex;flex:none;color:var(--warn-text)}
.dash-link{min-width:0;padding:0;border:0;background:none;overflow:hidden;color:var(--text);font:inherit;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.dash-link:hover{text-decoration:underline}
.dash-bar{min-width:64px}
.dash-docks{display:flex;flex-direction:column;gap:var(--sp-2);margin:0;padding:0;list-style:none}
.dash-docks__station{display:flex;flex-direction:column;gap:4px;padding:var(--sp-2) var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md)}
.dash-docks__head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--sp-2);min-width:0;font-weight:var(--fw-medium)}
.dash-docks__queue{flex:none;color:var(--warn-text);font-size:var(--fs-xs);font-variant-numeric:tabular-nums}
.dash-docks__list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.dash-docks__dock{display:grid;grid-template-columns:56px minmax(48px,1fr) minmax(0,auto);align-items:center;gap:var(--sp-2);font-size:var(--fs-sm)}
.dash-docks__cell,.dash-docks__val{color:var(--text-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.dash-spots{display:flex;flex-direction:column;margin:0;padding:var(--sp-1);list-style:none}
.dash-spot{display:grid;grid-template-columns:72px minmax(0,1fr) 64px;align-items:center;gap:var(--sp-3);width:100%;padding:6px var(--sp-2);border:0;border-radius:var(--radius-md);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dash-spot:hover{background:var(--hover)}
.dash-spot__val{text-align:right;font-weight:var(--fw-medium);font-variant-numeric:tabular-nums}
.dash-heat{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--sp-2) var(--sp-3);padding:var(--sp-3)}
.dash-heat .field{flex-direction:row;align-items:center;gap:var(--sp-2)}
.dash-panel-body{padding:var(--sp-3)}
@container (max-width:380px){
.dash-kpi .kpi__foot{flex-direction:column;align-items:stretch;gap:4px}
.dash-kpi .kpi__spark{max-width:none}
.dash-table{font-size:var(--fs-xs)}
.dash-table th,.dash-table td{padding:5px 4px}
.dash-name{max-width:84px}
.dash-bar{min-width:52px}
.dash-table td.dash-wrap{min-width:70px}
}
.dash-label{padding:var(--sp-2) var(--sp-3) 0}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  document.head.append(h('style', { id: STYLE_ID }, CSS));
}

// ---------------------------------------------------------------------------------------------------------------------
// In-place DOM helpers
// ---------------------------------------------------------------------------------------------------------------------

const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
const setVar = (el, name, value) => { if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value); };
const setGrow = (el, value) => { const v = String(value); if (el.style.flexGrow !== v) el.style.flexGrow = v; };
/** `el.hidden = value`, written only when it changes (a same-value write is still a DOM mutation). */
const setHidden = (el, value) => { if (el.hidden !== value) el.hidden = value; };
const setPressed = (el, on) => setAttr(el, 'aria-pressed', on ? 'true' : 'false');

/**
 * A keyed list inside `container`: `sync(data)` creates items for new keys, removes the ones that disappeared, updates every
 * item in place and puts the elements in the order of `data` (moving a node only when it is not where it belongs).
 * `create(datum)` returns { el, ...parts }; `update(item, datum)` patches it; an optional item.destroy() runs on removal.
 */
function keyedList(container, { key, create, update }) {
  const items = new Map();
  return {
    items,
    sync(data) {
      const wanted = new Set(data.map(key));
      for (const [k, item] of items) {
        if (wanted.has(k)) continue;
        item.destroy?.();
        item.el.remove();
        items.delete(k);
      }
      data.forEach((datum, i) => {
        const k = key(datum);
        let item = items.get(k);
        if (!item) { item = create(datum); items.set(k, item); }
        update(item, datum);
        if (container.children[i] !== item.el) container.insertBefore(item.el, container.children[i] || null);
      });
    },
    destroy() {
      for (const item of items.values()) item.destroy?.();
      items.clear();
    },
  };
}

/** A collapsible section (the kit's section header on a <details>). `paint` is set by the owner. */
function createSection(id, title, { open = true } = {}) {
  const aside = h('span', { class: 'section__aside' });
  const body = h('div', { class: 'dash-sec__body' });
  const el = h('details', { class: 'dash-sec', open, dataset: { section: id } },
    h('summary', { class: 'section__header' }, icon('chevron-right', { size: 14, class: 'section__chevron' }), h('span', { class: 'dash-sec__title' }, title), aside),
    body);
  return { el, body, aside, paint: null };
}

/** Shared metric popover: one bubble per dashboard, shown for hover, focus and tap, closed by Escape. */
function createHelp(root) {
  const tip = h('div', { class: 'chart-tooltip dash-tip', role: 'tooltip', hidden: true });
  root.append(tip);
  const hide = () => { tip.hidden = true; };
  function show(button, title, body) {
    tip.replaceChildren(h('div', { class: 'chart-tooltip__title' }, title), body);
    setHidden(tip, false);
    const box = root.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    const left = clamp(at.left - box.left + at.width / 2 - tip.offsetWidth / 2, 4, Math.max(4, box.width - tip.offsetWidth - 4));
    const below = at.bottom - box.top + 6;
    const top = below + tip.offsetHeight > box.height ? at.top - box.top - tip.offsetHeight - 6 : below;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  }
  /** A small "i" button that explains `body` for the metric `title`. */
  function button(title, body) {
    const describedBy = uid('dash-help');
    const b = h('button', { class: 'dash-help', type: 'button', 'aria-label': `About ${title}`, 'aria-describedby': describedBy },
      icon('info', { size: 14 }));
    b.append(h('span', { class: 'sr-only', id: describedBy }, body));
    const open = () => show(b, title, body);
    b.addEventListener('mouseenter', open);
    b.addEventListener('focus', open);
    b.addEventListener('mouseleave', () => { if (document.activeElement !== b) hide(); });
    b.addEventListener('blur', hide);
    b.addEventListener('click', open); // a tap focuses the button (which opens it) or, on a button that already has focus, re-opens it
    b.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    return b;
  }
  return { button, hide };
}

// ---------------------------------------------------------------------------------------------------------------------
// Parts of the page
// ---------------------------------------------------------------------------------------------------------------------

const STATUS_STYLE = Object.freeze({
  idle: { chip: 'chip chip--outline', icon: 'info' },
  warming: { chip: 'chip chip--info', icon: 'clock' },
  running: { chip: 'chip chip--good', icon: 'play' },
  paused: { chip: 'chip', icon: 'pause' },
});

/** Run state chip, simulated clock and the length of the measured window. */
function buildStatus() {
  const label = h('span');
  let key = null;
  let iconEl = icon('info', { size: 14 });
  const chip = h('span', { class: 'chip' }, iconEl, label);
  const clock = h('strong');
  const measured = h('span', { title: MEASURED_TITLE });
  const el = h('div', { class: 'dash__status', role: 'group', 'aria-label': 'Simulation status' },
    chip,
    h('span', { class: 'dash__meta', title: 'Simulated time' }, icon('clock', { size: 14 }), clock),
    measured);
  return {
    el,
    paint(status) {
      if (status.key !== key) {
        key = status.key;
        chip.className = STATUS_STYLE[key].chip;
        const next = icon(STATUS_STYLE[key].icon, { size: 14 });
        iconEl.replaceWith(next);
        iconEl = next;
      }
      setText(label, status.label);
      setText(clock, status.clock);
      setText(measured, status.windowText);
      setAttr(measured, 'title', status.windowTitle || MEASURED_TITLE);
    },
  };
}

/** "Warming up" / "Not enough data yet" notice with a progress bar. */
function buildNotice() {
  const title = h('div', { class: 'callout__title' });
  const body = h('div', { class: 'callout__text' });
  const bar = h('div', { class: 'progress__bar' });
  const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
  const el = h('div', { class: 'callout callout--info dash__notice', hidden: true },
    icon('info', { size: 16, class: 'callout__icon' }),
    h('div', { class: 'callout__body' }, title, body, progress));
  return {
    el,
    paint(model) {
      setHidden(el, !model);
      if (!model) return;
      setText(title, model.title);
      setText(body, model.text);
      setAttr(progress, 'aria-label', model.key === 'warming' ? 'Warm-up progress' : 'Measured time so far');
      setHidden(progress, model.progress === null);
      if (model.progress !== null) {
        const percent = Math.round(model.progress * 100);
        setVar(bar, '--w', `${percent}%`);
        setAttr(progress, 'aria-valuenow', String(percent));
      }
    },
  };
}

/** The six headline cards. */
function buildKpis(help) {
  const cards = new Map();
  const grid = h('div', { class: 'dash__kpis', role: 'group', 'aria-label': 'Headline figures' });
  for (const def of KPI_DEFS) {
    const value = h('span');
    const unit = h('span', { class: 'kpi__unit' });
    const note = h('span');
    const statusText = h('span');
    const statusDot = h('span', { class: 'dot' });
    const status = h('span', { class: 'dash-status', hidden: true }, statusDot, statusText);
    const spark = def.color ? createSparkline({ values: [], color: def.color, unit: def.unit, height: 28 }) : null;
    const el = h('div', { class: 'card dash-kpi', dataset: { kpi: def.id } },
      h('div', { class: 'kpi' },
        h('div', { class: 'kpi__label' }, h('span', null, def.label), help.button(def.label, def.help)),
        h('div', { class: 'kpi__value tnum' }, value, unit),
        h('div', { class: 'kpi__foot' },
          h('div', { class: 'dash-kpi__meta' }, status, note),
          spark ? h('div', { class: 'kpi__spark' }, spark.el) : null)));
    grid.append(el);
    cards.set(def.id, { el, value, unit, note, status, statusDot, statusText, spark, sparkSig: '' });
  }
  return {
    el: grid,
    cards,
    paint(models) {
      for (const m of models) {
        const c = cards.get(m.id);
        c.el.classList.toggle('is-muted', m.muted);
        setText(c.value, m.value);
        setText(c.unit, m.unit);
        setHidden(c.unit, !m.unit);
        setText(c.note, m.note);
        setHidden(c.note, !m.note);
        setHidden(c.status, !m.status);
        if (m.status) {
          setAttr(c.statusDot, 'class', `dot tone-${m.status.tone}`);
          setText(c.statusText, m.status.label);
        }
        if (c.spark) paintSpark(c, m.spark || []);
      }
    },
    destroy() { for (const c of cards.values()) c.spark?.destroy(); },
  };
}

/** Sparkline data only when it changed (length and last value identify a new point in a growing series). */
function paintSpark(card, values) {
  const sig = `${values.length}:${values[values.length - 1]}:${values[0]}`;
  if (sig === card.sparkSig) return;
  card.sparkSig = sig;
  card.spark.update({ values });
}

/** Insights list: callouts, most severe first, "Show all" beyond INSIGHTS_COLLAPSED. */
function buildInsights(ctx, section) {
  const opened = new Set(); // insight ids whose details are expanded
  let showAll = false;
  let last = null;
  const box = h('div', { class: 'dash-insights' });
  const note = h('p', { class: 'dash-note' });
  const more = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-expanded': 'false', onclick: () => { showAll = !showAll; if (last) paint(last); } });
  section.body.append(note, box, more);

  const focusOn = (target) => ctx.actions?.focus?.(target);

  function create(ins) {
    const item = { target: null }; // read at click time: the refs of an insight (e.g. its cells) change while the simulation runs
    const lead = h('strong', { class: 'dash-lead' }, 'What to do: ');
    const suggestion = h('span');
    const title = h('div', { class: 'callout__title' });
    const advice = h('div', { class: 'callout__text' }, lead, suggestion);
    const detail = h('div', { class: 'callout__text', hidden: !opened.has(ins.id) });
    const toggle = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', 'aria-expanded': String(opened.has(ins.id)) }, 'Details');
    const show = h('button', { class: 'btn btn--sm', type: 'button', onclick: (e) => { e.stopPropagation(); focusOn(item.target); } }, icon('target', { size: 14 }), 'Show on plan');
    let iconEl = icon('info', { size: 16, class: 'callout__icon' });
    let severity = null;
    const el = h('div', { class: 'callout dash-insight', dataset: { insight: ins.id } }, iconEl,
      h('div', { class: 'callout__body' }, title, advice, detail, h('div', { class: 'dash-actions' }, show, toggle)));
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = detail.hidden;
      setHidden(detail, !open);
      if (open) opened.add(ins.id); else opened.delete(ins.id);
      setAttr(toggle, 'aria-expanded', String(open));
    });
    // A click anywhere on the card does what "Show on plan" does, unless the planner is selecting text.
    el.addEventListener('click', () => { if (item.target && !String(window.getSelection())) focusOn(item.target); });
    return Object.assign(item, {
      el, title, advice, suggestion, detail, toggle, show,
      setSeverity(next) {
        if (next === severity) return;
        severity = next;
        const style = SEVERITY[next] || SEVERITY.info;
        el.className = `callout ${style.cls} dash-insight`;
        const fresh = icon(style.icon, { size: 16, class: 'callout__icon' });
        iconEl.replaceWith(fresh);
        iconEl = fresh;
      },
    });
  }

  function update(item, ins) {
    item.setSeverity(ins.severity);
    item.target = focusTarget(ins.refs);
    setHidden(item.show, !item.target);
    if (item.target) setAttr(item.el, 'data-clickable', ''); else item.el.removeAttribute('data-clickable');
    setText(item.title, text(ins.title));
    const advice = text(ins.suggestion);
    setHidden(item.advice, !advice);
    setText(item.suggestion, advice);
    setText(item.detail, text(ins.detail));
    setHidden(item.toggle, !ins.detail);
  }

  const rows = keyedList(box, { key: (ins) => ins.id, create, update });

  function paint(model) {
    last = model;
    const { shown, total } = visibleInsights(model.insights, showAll);
    rows.sync(shown);
    setText(section.aside, total ? plural(total, 'insight', 'insights') : '');
    setHidden(note, total > 0);
    setText(note, model.state === 'ready' ? 'Nothing to report.' : `Insights appear once ${dur(MIN_DATA_SECONDS)} of simulated time have been measured.`);
    setHidden(more, total <= INSIGHTS_COLLAPSED);
    setText(more, showAll ? 'Show fewer' : `Show all ${total} insights`);
    setAttr(more, 'aria-expanded', String(showAll));
  }
  section.paint = paint;
}

/** Throughput, work in progress and vehicle charts over simulated time. */
function buildCharts(section) {
  const x = (r) => finiteSeries(r, 't');
  const block = (title, subtitle, chart) => h('div', { class: 'dash-chart' }, h('div', { class: 'dash-chart__title' }, title, h('span', null, subtitle)), chart.el);
  const empty = 'The first point appears after one minute of measured time.';
  const throughput = createLineChart({ x: [], xAxis: 'time', yLabel: 'Loads per hour', height: 150, empty, ariaLabel: 'Throughput over time',
    series: [{ name: 'Throughput', y: [], area: true, color: '--series-1' }] });
  const wip = createLineChart({ x: [], xAxis: 'time', yLabel: 'Loads in the plant', height: 150, empty, ariaLabel: 'Work in progress over time',
    series: [{ name: 'Work in progress', y: [], area: true, color: '--series-2' }] });
  const vehicles = createLineChart({ x: [], xAxis: 'time', yLabel: 'Vehicles', height: 150, empty, ariaLabel: 'Vehicles at work over time',
    series: [{ name: 'At work', y: [], color: '--state-driving' }, { name: 'Waiting in traffic', y: [], color: '--state-waiting' }] });
  section.body.append(h('div', { class: 'card' },
    block('Throughput', 'loads per hour, last 10 minutes', throughput),
    block('Work in progress', 'loads in the plant, average per minute', wip),
    block('Vehicles', 'average number per minute', vehicles)));
  let signature = '';
  section.paint = (model) => {
    const r = model.report;
    const t = x(r);
    const tp = finiteSeries(r, 'throughput');
    const w = finiteSeries(r, 'wip');
    const working = finiteSeries(r, 'vehiclesWorking');
    const waiting = finiteSeries(r, 'vehiclesWaiting');
    const sig = `${t.length}:${t[t.length - 1]}:${tp[tp.length - 1]}:${w[w.length - 1]}:${working[working.length - 1]}:${waiting[waiting.length - 1]}`;
    if (sig === signature) return;
    signature = sig;
    throughput.update({ x: t, series: [{ name: 'Throughput', y: tp, area: true, color: '--series-1' }] });
    wip.update({ x: t, series: [{ name: 'Work in progress', y: w, area: true, color: '--series-2' }] });
    vehicles.update({ x: t, series: [{ name: 'At work', y: working, color: '--state-driving' }, { name: 'Waiting in traffic', y: waiting, color: '--state-waiting' }] });
  };
  return { destroy() { throughput.destroy(); wip.destroy(); vehicles.destroy(); } };
}

/** A small legend: coloured key + label for each state (the keys come from the kit's tone classes). */
function stateLegend(keys, extra = '') {
  return h('ul', { class: `chart-legend dash-legend ${extra}`.trim(), 'aria-label': 'Colour key' },
    keys.map((key) => h('li', { class: 'chart-legend__item', title: STATE_HINTS[key] }, h('span', { class: `chart-legend__key tone-${key}` }), STATE_LABELS[key])));
}

/** One card per fleet: working share, the eight state shares as a stacked bar and the fleet's key figures. */
function buildVehicles(ctx, section) {
  const box = h('div', { class: 'dash-fleets' });
  const note = h('p', { class: 'dash-note', hidden: true }, 'This plant has no vehicles. Add a fleet in the Fleet tab.');
  section.body.append(stateLegend(VEHICLE_STATES), note, box);

  const METRICS = [
    ['traffic', 'In traffic', 'Share of the fleet’s time spent waiting in traffic'],
    ['trips', 'Trips per vehicle', 'Average number of transport trips one vehicle makes per hour'],
    ['distance', 'Distance per vehicle', 'Average distance one vehicle drove in the measured time'],
    ['empty', 'Driving empty', 'Share of the driven distance without a load'],
    ['pickup', 'Wait for pickup', 'Average time a load waits until a vehicle of this fleet picks it up'],
    ['battery', 'Lowest battery', 'The lowest battery charge any vehicle of the fleet reached'],
  ];

  function create(m) {
    const name = h('div', { class: 'card__title truncate', title: m.name });
    const count = h('span', { class: 'card__subtitle truncate' });
    const util = h('span', { class: 'dash-fleet__util' });
    const bars = new Map(VEHICLE_STATES.map((key) => [key, h('div', { class: `progress__bar tone-${key}`, dataset: { state: key } })]));
    const bar = h('div', { class: 'progress progress--lg progress--stacked dash-states', role: 'img' }, [...bars.values()]);
    const cells = new Map(METRICS.map(([key, label, tip]) => [key, { dd: h('dd'), wrap: h('div', { title: tip }, h('dt', null, label)) }]));
    for (const { dd, wrap } of cells.values()) wrap.append(dd);
    const el = h('article', { class: 'card dash-fleet', dataset: { fleet: m.id }, 'aria-label': `Fleet ${m.name}` },
      h('div', { class: 'card__header' }, h('div', { class: 'stack', style: { '--gap': '0', flex: '1 1 auto' } }, name, count),
        h('div', { class: 'stack dash-fleet__side' }, util, h('span', { class: 'card__subtitle' }, 'working'))),
      h('div', { class: 'card__body' }, bar, h('dl', { class: 'dash-metrics' }, [...cells.values()].map((c) => c.wrap))));
    return { el, name, count, util, bars, bar, cells };
  }

  function update(item, m) {
    setText(item.name, m.name);
    setAttr(item.name, 'title', m.name);
    setText(item.count, m.countText);
    setText(item.util, m.utilText);
    for (const s of m.states) {
      const bar = item.bars.get(s.key);
      setHidden(bar, s.frac < 0.002);
      setGrow(bar, s.frac);
      setAttr(bar, 'title', `${s.label} ${pct(s.frac)}`);
    }
    setAttr(item.bar, 'aria-label', m.aria);
    for (const [key, cell] of item.cells) {
      const v = m.metrics[key];
      setHidden(cell.wrap, v === null);
      if (v !== null) setText(cell.dd, v);
    }
  }

  const fleets = keyedList(box, { key: (m) => m.id, create, update });
  section.paint = (model) => {
    fleets.sync(model.fleets);
    setHidden(note, model.fleets.length > 0);
    setText(section.aside, model.fleets.length ? plural(model.fleets.length, 'fleet', 'fleets') : '');
  };
}

/** Workstations and buffers: state mini bars, utilization and queues; the bottleneck is marked; a click selects the station. */
function buildStations(ctx, section) {
  const tbody = h('tbody');
  const headers = [
    ['Station', null], ['Time in state', 'How the workstation spent its time: working, waiting for input, blocked by a full output or broken down. Buffers show their average fill.'],
    ['Used', 'Share of the time the workstation worked. Buffers: average fill.'],
    ['Avg queue', 'Loads waiting in front of a workstation on average. Buffers: loads held.'],
    ['Max queue', 'The most loads that waited in front of a workstation at one time. Buffers: most loads held.'],
  ];
  const table = h('table', { class: 'table dash-table', 'aria-label': 'Workstations and buffers' },
    h('thead', null, h('tr', null, headers.map(([label, tip], i) => h('th', { scope: 'col', class: i > 1 ? 'num' : null, title: tip }, label)))), tbody);
  const wrap = h('div', { class: 'table-wrap' }, table);
  const note = h('p', { class: 'dash-note', hidden: true }, 'This plant has no workstations or buffers yet.');
  section.body.append(stateLegend(STATION_STATES), note, wrap);

  let order = [];
  let sortedAt = -Infinity;
  const focusOn = (id) => ctx.actions?.focus?.({ stationIds: [id] });

  function create(m) {
    const link = h('button', { class: 'dash-link', type: 'button', onclick: (e) => { e.stopPropagation(); focusOn(m.id); } });
    const swatch = h('span', { class: `swatch tone-${m.type}`, 'aria-hidden': 'true' });
    const flag = h('span', { class: 'dash-flag', title: 'Bottleneck: this station limits the whole plant', hidden: true }, icon('warning', { size: 14 }), h('span', { class: 'sr-only' }, 'Bottleneck'));
    const bars = new Map(STATION_STATES.map((key) => [key, h('div', { class: `progress__bar tone-${key}` })]));
    const fillBar = h('div', { class: 'progress__bar tone-storage' });
    const bar = m.type === 'process'
      ? h('div', { class: 'progress progress--stacked dash-bar', role: 'img' }, [...bars.values()])
      : h('div', { class: 'progress dash-bar', role: 'img' }, fillBar);
    const util = h('td', { class: 'num' });
    const avg = h('td', { class: 'num' });
    const max = h('td', { class: 'num' });
    const el = h('tr', { dataset: { row: m.id, station: m.id }, onclick: () => focusOn(m.id) },
      h('td', null, h('div', { class: 'dash-name' }, swatch, link, flag)), h('td', null, bar), util, avg, max);
    return { el, link, flag, bars, fillBar, bar, util, avg, max };
  }

  function update(item, m) {
    setText(item.link, m.name);
    setAttr(item.link, 'title', m.name);
    setAttr(item.link, 'aria-label', `Select ${m.name} on the plan${m.bottleneck ? ' (bottleneck)' : ''}`);
    setHidden(item.flag, !m.bottleneck);
    if (m.shares) {
      for (const s of m.shares) {
        const bar = item.bars.get(s.key);
        setHidden(bar, s.frac < 0.002);
        setGrow(bar, s.frac);
      }
    }
    else setVar(item.fillBar, '--w', `${Math.round(m.fill * 100)}%`);
    setAttr(item.bar, 'aria-label', m.aria);
    setText(item.util, m.utilText);
    item.util.classList.toggle('is-worst', m.bottleneck);
    setText(item.avg, m.avgText);
    setText(item.max, m.maxText);
  }

  const rows = keyedList(tbody, { key: (m) => m.id, create, update });
  const busy = () => table.matches(':hover') || table.contains(document.activeElement);

  /** The display order: sorted by utilization, but kept while the planner is working in the table. */
  function arrange(data, now) {
    const known = new Set(order);
    const same = order.length === data.length && data.every((m) => known.has(m.id));
    if (!same || (now - sortedAt >= REORDER_MS && !busy())) {
      order = sortStationRows(data).map((m) => m.id);
      sortedAt = now;
    }
    const byId = new Map(data.map((m) => [m.id, m]));
    return order.map((id) => byId.get(id));
  }

  let selected = [];
  let showAll = false;
  let shownOrder = [];
  const more = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-expanded': 'false', onclick: () => { showAll = !showAll; mark(); } });
  section.body.append(more);

  /** Mark the selected row(s) and hide rows beyond the collapsed limit (a selected row is always shown). */
  function mark() {
    shownOrder.forEach((id, i) => {
      const item = rows.items.get(id);
      const on = selected.includes(id);
      setHidden(item.el, !(showAll || i < STATION_ROWS_COLLAPSED || on));
      item.el.classList.toggle('is-selected', on);
      if (on) setAttr(item.el, 'aria-current', 'true'); else item.el.removeAttribute('aria-current');
    });
    setHidden(more, shownOrder.length <= STATION_ROWS_COLLAPSED);
    setText(more, showAll ? 'Show fewer' : `Show all ${shownOrder.length} stations`);
    setAttr(more, 'aria-expanded', String(showAll));
  }

  section.paint = (model) => {
    const ordered = arrange(model.stations, performance.now());
    rows.sync(ordered);
    shownOrder = ordered.map((m) => m.id);
    setHidden(note, model.stations.length > 0);
    setText(section.aside, model.stations.length ? String(model.stations.length) : '');
    mark();
  };
  section.selection = (selection) => {
    selected = selection && selection.kind === 'station' && Array.isArray(selection.ids) ? selection.ids : [];
    mark();
  };
}

/** Docks per station: a bar for how busy each dock was and how many vehicles it served, so an unused dock beside a busy one shows. */
function buildDocks(ctx, section) {
  const list = h('ul', { class: 'dash-docks' });
  const note = h('p', { class: 'dash-note', hidden: true }, 'No station has several docks, and no single dock has a queue.');
  section.body.append(note, list);
  const rows = keyedList(list, {
    key: (m) => m.id,
    create(m) {
      const link = h('button', { class: 'dash-link', type: 'button', onclick: () => ctx.actions?.focus?.({ stationIds: [m.id] }) });
      const queued = h('span', { class: 'dash-docks__queue' });
      const body = h('ul', { class: 'dash-docks__list' });
      return { el: h('li', { class: 'dash-docks__station', dataset: { dockStation: m.id } }, h('div', { class: 'dash-docks__head' }, link, queued), body), link, queued, body, count: -1, bars: [], vals: [] };
    },
    update(item, m) {
      setText(item.link, m.name);
      setText(item.queued, m.waitText);
      if (item.count !== m.docks.length) { // the docks of a station do not change while a simulation runs; rebuild only when they do
        item.count = m.docks.length;
        item.bars = m.docks.map(() => h('div', { class: 'progress__bar tone-busy' }));
        item.vals = m.docks.map(() => h('span', { class: 'dash-docks__val' }));
        item.body.replaceChildren(...m.docks.map((d, i) => h('li', { class: 'dash-docks__dock' },
          h('span', { class: 'dash-docks__cell' }, d.label), h('div', { class: 'progress dash-bar', role: 'img', dataset: { dock: String(i) } }, item.bars[i]), item.vals[i])));
      }
      m.docks.forEach((d, i) => {
        setVar(item.bars[i], '--w', `${Math.round(d.busy * 100)}%`);
        setText(item.vals[i], `${d.busyText} · ${d.visitsText}${d.heldText ? ` · ${d.heldText}` : ''}`);
        setAttr(item.bars[i].parentElement, 'aria-label', d.aria);
      });
    },
  });
  section.paint = (model) => {
    rows.sync(model.docks);
    setHidden(note, model.docks.length > 0);
    setText(section.aside, model.docks.length ? String(model.docks.length) : '');
  };
}

/** Flow table: what was delivered, how long loads waited for a vehicle and how many still wait. */
function buildFlows(section) {
  const tbody = h('tbody');
  const headers = [
    ['Flow', null], ['Delivered', 'Loads delivered along this flow'], ['Trips', 'Transport trips made for this flow'],
    ['Pickup wait', 'Average time a load waited for a vehicle after it was ready'], ['Transit', 'Average driving time from pickup to delivery'],
    ['Backlog', 'Loads that are ready but not yet picked up, on average over the measured time'],
  ];
  const table = h('table', { class: 'table dash-table', 'aria-label': 'Material flows' },
    h('thead', null, h('tr', null, headers.map(([label, tip], i) => h('th', { scope: 'col', class: i ? 'num' : null, title: tip }, label)))), tbody);
  const note = h('p', { class: 'dash-note', hidden: true }, 'This plant has no material flows yet.');
  section.body.append(note, h('div', { class: 'table-wrap' }, table));

  function create(m) {
    const name = h('span', { class: 'dash-clamp' });
    const cells = ['delivered', 'trips', 'pickup', 'transit', 'backlog'].map((key) => [key, h('td', { class: 'num' })]);
    return { el: h('tr', { dataset: { flow: m.id } }, h('td', { class: 'dash-wrap' }, name), cells.map(([, td]) => td)), name, cells: new Map(cells) };
  }

  function update(item, m) {
    setText(item.name, m.name);
    setAttr(item.name, 'title', m.name);
    for (const [key, td] of item.cells) setText(td, m[key]);
    const backlog = item.cells.get('backlog');
    backlog.classList.toggle('is-worst', m.waiting);
    setAttr(backlog, 'title', `Now: ${m.backlogNow}`);
  }

  const rows = keyedList(tbody, { key: (m) => m.id, create, update });
  section.paint = (model) => {
    rows.sync(model.flows);
    setHidden(note, model.flows.length > 0);
    setText(section.aside, model.flows.length ? String(model.flows.length) : '');
  };
}

/** Traffic: where vehicles waited longest, why, and the heatmap switch for the plan. */
function buildTraffic(ctx, section) {
  const ul = h('ul', { class: 'dash-spots', 'aria-label': 'Places with the longest waiting' });
  const note = h('p', { class: 'dash-note', hidden: true }, 'No vehicle had to wait in traffic so far.');
  const breakdown = kvList(trafficBreakdown(null));
  const dds = [...breakdown.querySelectorAll('dd')];
  const heatButton = h('button', { class: 'btn btn--sm', type: 'button', 'aria-pressed': 'false', title: 'Colour the plan by waiting or by traffic volume' },
    icon('heat', { size: 14 }), 'Show heatmap');
  let lastMode = 'waiting';
  let heat = null; // the overlay as last mirrored from the store
  const setHeat = (mode) => ctx.store?.setUi?.({ overlays: { heat: mode } });
  heatButton.addEventListener('click', () => setHeat(heat && heat !== 'off' ? 'off' : lastMode));
  const modes = segmentedField({
    label: 'Heatmap shows',
    options: [
      { value: 'waiting', label: 'Waiting', title: 'Where vehicles stood still the longest' },
      { value: 'traffic', label: 'Traffic', title: 'Where most vehicles drove' },
    ],
    value: null,
    block: false,
    onChange: (mode) => { lastMode = mode; setHeat(mode); },
  });
  section.body.append(
    h('div', { class: 'card' },
      h('div', { class: 'dash-heat' }, heatButton, modes.el),
      h('div', { class: 'eyebrow dash-label' }, 'Longest waiting'),
      note, ul,
      h('div', { class: 'eyebrow dash-label' }, 'Waiting by cause'),
      h('div', { class: 'dash-panel-body', style: { paddingTop: '0' } }, breakdown)));

  function create(m) {
    const cell = h('span', { class: 'tnum' });
    const bar = h('span', { class: 'progress', 'aria-hidden': 'true' }, h('span', { class: 'progress__bar tone-waiting' }));
    const value = h('span', { class: 'dash-spot__val' });
    const cellOf = { cx: 0, cy: 0 };
    const button = h('button', { class: 'dash-spot', type: 'button', onclick: () => ctx.actions?.focus?.({ cells: [[cellOf.cx, cellOf.cy]] }) }, cell, bar, value);
    return { el: h('li', null, button), button, cell, bar: bar.firstChild, value, cellOf };
  }

  function update(item, m) {
    item.cellOf.cx = m.cx;
    item.cellOf.cy = m.cy;
    setText(item.cell, m.label);
    setVar(item.bar, '--w', `${Math.round(m.frac * 100)}%`);
    setText(item.value, m.waitText);
    setAttr(item.value, 'title', `${m.seconds} of waiting, all vehicles added up`);
    setAttr(item.button, 'aria-label', `Show cell ${m.label} on the plan: ${m.waitText} of waiting`);
  }

  const spots = keyedList(ul, { key: (m) => `${m.cx},${m.cy}`, create, update });
  section.paint = (model) => {
    spots.sync(model.spots);
    setHidden(ul, model.spots.length === 0);
    setHidden(note, model.spots.length > 0);
    model.breakdown.forEach(([, v], i) => setText(dds[i], v));
  };
  /** Mirror the store's heatmap overlay into the toggle and the mode switch. */
  section.heat = (mode) => {
    const next = HEAT_MODES.includes(mode) ? mode : 'off';
    if (next === heat) return;
    heat = next;
    if (heat !== 'off') lastMode = heat;
    setPressed(heatButton, heat !== 'off');
    modes.set(heat === 'off' ? null : heat);
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Create the Results dashboard.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): store, runner (kpis, insights, playing, sim, time, play), actions.focus
 * @returns {{ el: HTMLElement, update(state: object): void, setVisible(visible: boolean): void, destroy(): void }}
 */
export function createDashboard(ctx) {
  injectStyles();
  const status = buildStatus();
  const play = h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => { Promise.resolve(ctx.runner?.play?.()).catch(() => {}); } },
    icon('play', { size: 14 }), 'Run simulation');
  const empty = emptyState({ iconName: 'chart', title: 'Press play to see results', text: PLAY_HINT, actions: [play] });
  const root = h('div', { class: 'dash', 'data-panel': 'dashboard' }, status.el, empty);
  const help = createHelp(root);

  let visible = null; // null: decide by layout (offsetParent); the shell can force it with setVisible
  let destroyed = false;
  let content = null;
  let shown = { report: undefined, insights: undefined };
  let lastModel = null;
  let lastState = null;
  let stale = true; // something changed while hidden

  const isShown = () => (visible === null ? root.offsetParent !== null : visible);

  /** Build the report-driven part once, on the first report. */
  function ensureContent() {
    if (content) return content;
    const notice = buildNotice();
    const kpis = buildKpis(help);
    const sections = {
      insights: createSection('insights', 'Insights'),
      charts: createSection('charts', 'Over time'),
      vehicles: createSection('vehicles', 'Vehicles'),
      stations: createSection('stations', 'Workstations & buffers'),
      docks: createSection('docks', 'Docks'),
      flows: createSection('flows', 'Material flows'),
      traffic: createSection('traffic', 'Traffic hot spots'),
    };
    buildInsights(ctx, sections.insights);
    const charts = buildCharts(sections.charts);
    buildVehicles(ctx, sections.vehicles);
    buildStations(ctx, sections.stations);
    buildDocks(ctx, sections.docks);
    buildFlows(sections.flows);
    buildTraffic(ctx, sections.traffic);
    const impact = createImpactCard(ctx); // "Effect of your change": at the top, only while there is something to compare
    const doors = createDoorsSection(ctx); // one card per Goods in / Goods out with trucks; hidden without (panels/doors-card.js)
    const el = h('div', { class: 'stack', style: { '--gap': 'var(--sp-4)' }, hidden: true }, impact.el, notice.el, kpis.el, doors.el, Object.values(sections).map((s) => s.el));
    for (const section of Object.values(sections)) {
      // A section that was collapsed while the data moved on catches up as soon as it is opened.
      section.el.addEventListener('toggle', () => { if (section.el.open && lastModel) section.paint(lastModel); });
    }
    root.append(el);
    content = { el, notice, kpis, sections, charts, impact, doors };
    return content;
  }

  function readTime(report) {
    const runner = ctx.runner;
    return fin(runner?.time) ?? fin(runner?.sim?.time) ?? fin(rec(rec(report).window).end);
  }

  function readWarmup(state) {
    return fin(ctx.runner?.sim?.settings?.warmup) ?? fin(state?.layout?.settings?.warmup) ?? 0;
  }

  /** Everything derived from one report, computed once per report. */
  function buildModel(report, insights, state, runState) {
    return {
      report,
      insights,
      state,
      kpis: kpiModels(report, state, insights),
      notice: noticeModel(report, runState),
      fleets: fleetModels(report),
      stations: stationRows(report, bottleneckIds(insights)),
      docks: dockRows(report),
      flows: flowRows(report),
      spots: hotspotRows(report),
      breakdown: trafficBreakdown(report),
    };
  }

  function paintReport(report, insights, state, runState) {
    setHidden(empty, state !== 'none');
    if (state === 'none') {
      if (content) setHidden(content.el, true);
      lastModel = null;
      return;
    }
    const c = ensureContent();
    setHidden(c.el, false);
    lastModel = buildModel(report, insights, state, runState);
    c.notice.paint(lastModel.notice);
    c.kpis.paint(lastModel.kpis);
    for (const section of Object.values(c.sections)) if (section.el.open) section.paint(lastModel);
  }

  /** The parts that depend on the store (heatmap, selection) rather than on the report. */
  function paintStore(state) {
    if (!content || !state) return;
    content.sections.traffic.heat?.(state.ui?.overlays?.heat);
    content.sections.stations.selection?.(state.ui?.selection);
  }

  function refresh(state, force) {
    const runner = ctx.runner;
    const report = runner?.kpis?.() ?? null;
    const insights = report ? (runner?.insights?.() ?? []) : [];
    const dstate = dataState(report);
    const runState = runStatus({ report, playing: Boolean(runner?.playing), time: readTime(report), warmup: readWarmup(state) });
    if (runner?.warm && runState.windowText && runState.key !== 'warming') { // a warm restart ran the first minutes silently
      const since = formatClock(fin(rec(rec(report).window).start) ?? 0);
      runState.windowText = `${runState.windowText} since ${since} (pre-run)`;
      runState.windowTitle = `After your change the updated plant was simulated silently up to ${formatClock(fin(runner.warm.preRoll) ?? 0)} (the pre-run), so the figures already cover the time since ${since}.`;
    }
    status.paint(runState);
    if (force || report !== shown.report || insights !== shown.insights) {
      shown = { report, insights };
      paintReport(report, insights, dstate, runState);
    }
    content?.impact.update(report);
    content?.doors.update(report, state);
    paintStore(state);
    stale = false;
  }

  return {
    el: root,
    update(state) {
      if (destroyed) return;
      lastState = state || lastState;
      if (!isShown()) { stale = true; return; }
      refresh(lastState, stale);
    },
    /** The shell tells the dashboard when its tab is on screen; hidden panels do no work. */
    setVisible(next) {
      visible = Boolean(next);
      if (!visible) { help.hide(); return; }
      if (!destroyed) refresh(lastState, true);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      content?.kpis.destroy();
      content?.charts.destroy();
      content?.impact.destroy();
      content?.doors.destroy();
      root.remove();
    },
  };
}
