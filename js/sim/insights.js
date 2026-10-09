// Insights - turns a KpiReport into plain-language findings for the planner (docs/ARCHITECTURE.md section 5.4).
//
// Each rule looks at one aspect of the report (a workstation, a fleet, the traffic, ...) and may produce
// insights with a stable id (`rule` or `rule:ref`), a severity, a title that quotes the numbers, a longer
// detail, one concrete suggestion and refs the UI can select or zoom to. All thresholds are named constants
// below, so what counts as "busy" or "congested" is visible in one place and easy to tune.
//
// Ordering is deterministic: severity (critical, warning, info, good), then magnitude (the headline metric of
// the rule on a 0..1 scale, larger first; a deadlock count n maps to 1 - 1/(1 + n)), then id. A 'good' insight is added only when no
// critical or warning insight fired. While the warm-up is running, or with less than MIN_DATA_SECONDS of measured
// time, the only result is a single info insight: the first minutes of a plant that starts empty, and shares and
// queues of a few minutes, are not meaningful.
//
// Additions beyond the rules named in the spec: `blocked` (a workstation that cannot get rid of its output),
// `no-output` (nothing left the plant at all, so a stuck plant is never reported as 'good') and `unplaced`
// (vehicles that found no room on the road and do not take part in the simulation). Docks: `dock-bottleneck` (vehicles queue for a station whose
// docks are busy nearly all the time: add a dock), `dock-idle-vehicles` (the same queue, but the docks are taken by idle vehicles that stay on the
// road: let them park) and `docks-unbalanced` (one dock does the work while others stand unused and vehicles wait; said only when the report
// names the reason, stations[].dockSkew); all stay silent for docks that are balanced and idle.
//
// Advice about the number of vehicles comes from ONE verdict per flow (transportState), so the rules cannot
// contradict each other: "add a vehicle" is only said when every fleet that may serve the flow is saturated and
// traffic is not congested; congested traffic is answered with "relieve the congestion", spare vehicles with
// "something else holds the loads back". Waiting loads are judged on the window average of the report
// (flows[].avgBacklog), never on the instantaneous count, so a recommendation does not flicker with a single load.
//
// Resources that are not used (fleet-no-jobs, fleet-unused, vehicle-idle-some, source-unconnected-activity, station-never-used) are judged on a
// longer window (UNUSED_MIN_WINDOW, STATION_NEVER_USED_WINDOW). A fleet is "unused" by ONE verdict (barelyUsed) that the other
// fleet rules consult: an unused fleet is not also called oversized or broken-down-and-in-need-of-a-spare, and a saturated fleet is
// never told to buy vehicles while another fleet that may do the same jobs stands idle. A goods-in without any outgoing flow is
// explained by source-unconnected-activity, not by "delivers more than the plant takes".

import { formatDistance, formatDuration, formatNumber, formatPercent, round } from '../util/format.js';

/** Measured sim seconds needed before any rule is evaluated. */
export const MIN_DATA_SECONDS = 5 * 60;

// Workstation bottleneck: busy (working or broken down) this much AND (queue in front above average OR a
// successor is starved). Breakdown time counts because a broken machine has no spare capacity either.
export const BOTTLENECK_UTILIZATION = 0.9;
export const BOTTLENECK_CRITICAL_UTILIZATION = 0.97;
export const BOTTLENECK_MIN_QUEUE = 1; // loads waiting on average
export const SUCCESSOR_STARVED_SHARE = 0.2;
export const MACHINE_TARGET_UTILIZATION = 0.85; // load a suggestion aims for

// Fleet sizing.
export const FLEET_SATURATED_UTILIZATION = 0.85;
export const FLEET_CRITICAL_UTILIZATION = 0.95;
export const FLEET_PICKUP_WAIT = 120; // s a load waits for its vehicle on average
export const FLEET_PICKUP_WAIT_MIN_UTILIZATION = 0.6; // below this a long wait is a batching matter, not fleet size
export const FLEET_OVERSIZED_UTILIZATION = 0.35;
export const FLEET_UNUSED_UTILIZATION = 0.02; // below this a fleet did practically nothing
export const FLEET_TARGET_UTILIZATION = 0.75;
export const TRANSPORT_BACKLOG = 1; // loads that wait for a vehicle on average before transport is called a problem

// Resources that are not used. These need a longer window than the other rules: one trip more or less in five minutes means nothing.
export const UNUSED_MIN_WINDOW = 20 * 60; // measured s before a fleet or a vehicle is called unused (at 10 min the verdict came and went with the luck of a few trips)
export const FLEET_BARELY_USED_TRIPS_PER_HOUR = 0.3; // trips per vehicle and hour below which a fleet "hardly works" ...
export const FLEET_UNUSED_MIN_OTHER_TRIPS = 3; // ... provided other vehicles made this many trips on the flows it may serve too
export const VEHICLE_IDLE_SHARE = 0.2; // a vehicle with less than this share of the average trips of its fleet-mates hardly works
export const VEHICLE_IDLE_MIN_MEAN_TRIPS = 3; // ... provided its fleet-mates made at least this many trips on average
export const SOURCE_UNCONNECTED_MIN_YARD = 2; // loads piling up at a goods-in without any flow before it is reported
export const STATION_NEVER_USED_WINDOW = 15 * 60; // measured s a destination must have gone without a load to be reported
export const STATION_NEVER_USED_MIN_SUPPLY = 3; // loads the supplier produced meanwhile

// Traffic. The wait share is waiting / (driving + waiting) of the plant, and of a single fleet in the same way.
export const TRAFFIC_WAIT_SHARE = 0.12;
export const TRAFFIC_CRITICAL_WAIT_SHARE = 0.25;
export const TRAFFIC_HOTSPOT_CELLS = 3;

// Docks. A station's docks are busy this much on average (the share of the window a vehicle was SERVED on them: loading, unloading, pulling out)
// AND vehicles waited at least this long per visit for one of them: a queue at the station that more docks (or a shorter hand-over) would dissolve.
// Docks that an idle vehicle only stands on (fleets that stay on the road) are not busy but taken: with this share of the window taken that way
// and the same waiting the advice is to let the idle vehicles park, not to add docks.
export const DOCK_BUSY_SHARE = 0.6;
export const DOCK_HELD_SHARE = 0.25;
export const DOCK_WAIT_PER_VISIT = 8; // s
export const DOCK_MIN_VISITS = 10;
export const DOCK_WARNING_WAIT_PER_VISIT = 30; // s: a warning rather than a note

// Supply and buffers.
export const SUPPLY_BLOCKED_SHARE = 0.25;
export const SUPPLY_MIN_YARD = 3; // loads
export const SUPPLY_CRITICAL_YARD = 25; // loads
export const BUFFER_AVG_FILL = 0.8;
export const BUFFER_FULL_SHARE = 0.1;
export const BUFFER_CRITICAL_FULL_SHARE = 0.3;
export const BUFFER_GROWTH = 1.5; // factor in the "raise capacity" suggestion
export const BLOCKED_SHARE = 0.2;
export const BLOCKED_CRITICAL_SHARE = 0.4;
export const STARVED_SHARE = 0.3;
export const STARVED_WARNING_SHARE = 0.5;

// Driving efficiency, batteries, breakdowns.
export const EMPTY_DRIVING_SHARE = 0.6; // a shuttle between two stations already drives 50 % empty
export const EMPTY_DRIVING_MIN_TRIPS = 5;
export const EMPTY_DRIVING_MIN_UTILIZATION = 0.6; // empty kilometres only matter while the vehicles are busy
export const BATTERY_EMPTY = 0.001;
export const BATTERY_LOW = 0.1;
export const CHARGING_SHARE = 0.25;
export const BREAKDOWN_MIN_COUNT = 2;
export const BREAKDOWN_DOWN_SHARE = 0.05;
export const BREAKDOWN_WARNING_SHARE = 0.1;
export const VEHICLE_BROKEN_SHARE = 0.05;

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2, good: 3 };

// ---- small helpers -----------------------------------------------------------------------------------------

const pct = (x) => formatPercent(x);
const amount = (x) => formatNumber(x, x < 10 ? 1 : 0);
const isOne = (x) => round(x, 1) === 1;
const plural = (x, one, many) => `${amount(x)} ${isOne(x) ? one : many}`;
const sum = (list) => list.reduce((a, b) => a + b, 0);
/** Share of time a workstation had no spare capacity: working or broken down, never waiting for input or blocked. */
const saturation = (s) => Math.min(1, (s.utilization || 0) + (s.down || 0));
const hasDowntime = (s) => s.down >= 0.005;
/** "busy 77 %" or "busy 77 %, broken down 23 %" for use inside a suggestion. */
const loadText = (s) => `busy ${pct(s.utilization)}${hasDowntime(s) ? `, broken down ${pct(s.down)}` : ''}`;
const cellText = (c) => `(${c.cx}, ${c.cy})`;
const cellList = (cells) => cells.map(cellText).join(', ');

/** Candidate = an insight plus the magnitude used to order insights of equal severity. */
function candidate(rule, ref, severity, magnitude, title, detail, suggestion, refs) {
  const insight = { id: ref == null ? rule : `${rule}:${ref}`, severity, title, detail };
  if (suggestion) insight.suggestion = suggestion;
  insight.refs = refs || {};
  return { magnitude: Number.isFinite(magnitude) ? magnitude : 0, insight };
}

/** Read-only lookups over report and layout that several rules need. */
function buildContext(report, layout) {
  const lay = layout || {};
  const stations = Object.entries(report.stations || {}).map(([id, s]) => ({ ...s, id }));
  const fleets = Object.entries(report.fleets || {}).map(([id, f]) => ({ ...f, id }));
  const byId = new Map(stations.map((s) => [s.id, s]));
  const flowsFrom = new Map();
  const flowsTo = new Map();
  for (const f of lay.flows || []) {
    if (!flowsFrom.has(f.from)) flowsFrom.set(f.from, []);
    if (!flowsTo.has(f.to)) flowsTo.set(f.to, []);
    flowsFrom.get(f.from).push(f);
    flowsTo.get(f.to).push(f);
  }
  const ctx = {
    report,
    layout: lay,
    duration: report.window.duration,
    stations,
    fleets,
    byId,
    stationDefs: new Map((lay.stations || []).map((s) => [s.id, s])),
    fleetDefs: new Map((lay.fleets || []).map((f) => [f.id, f])),
    flowsFrom,
    flowsTo,
    traffic: report.traffic || {},
    flows: report.flows || {},
    saturationCache: new Map(),
    name: (id) => (byId.get(id) ? byId.get(id).name : id),
    /** Workstations reached from `id` along flows, passing through storages only. */
    workstationsBeyond: (id, direction) => walkFlows(ctx, id, direction),
  };
  return ctx;
}

/** Report entries of the workstations connected to `id` in `direction` ('down' = consumers, 'up' = suppliers). */
function walkFlows(ctx, id, direction) {
  const next = direction === 'down' ? ctx.flowsFrom : ctx.flowsTo;
  const found = [];
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    for (const f of next.get(stack.pop()) || []) {
      const other = direction === 'down' ? f.to : f.from;
      if (seen.has(other)) continue;
      seen.add(other);
      const station = ctx.byId.get(other);
      if (!station) continue;
      if (station.type === 'process') found.push(station);
      else if (station.type === 'storage') stack.push(other);
    }
  }
  return found;
}

function hotspotCells(ctx, count = TRAFFIC_HOTSPOT_CELLS) {
  return (ctx.traffic.hotspots || []).slice(0, count);
}

/** " around (12, 1), (13, 1)" for the worst traffic cells, or nothing when there are none. */
function aroundHotspots(ctx, count) {
  const spots = hotspotCells(ctx, count);
  return spots.length ? ` around ${cellList(spots)}` : '';
}

// ---- transport verdicts: the single source of truth for every "add a vehicle" / "fewer vehicles" statement ------

/** Share of a fleet's driving time spent waiting in traffic: the same measure as traffic.waitShare. */
function fleetWaitShare(f) {
  const waiting = f.shares?.waiting || 0;
  const moving = (f.shares?.driving || 0) + waiting;
  return moving > 0 ? waiting / moving : 0;
}

/** True when more vehicles would only add to the traffic: the plant, or the fleet itself, loses too much time waiting. */
const congested = (ctx, f) => ctx.traffic.waitShare >= TRAFFIC_WAIT_SHARE || fleetWaitShare(f) >= TRAFFIC_WAIT_SHARE;

/**
 * Fleet with several vehicles that works only a small part of the time it could work. Vehicles that charge or
 * are broken cannot work, so they do not count as idle time.
 */
function oversized(f) {
  const available = 1 - (f.shares?.charging || 0) - (f.shares?.broken || 0);
  return f.count >= 2 && available > 0 && f.utilization / available < FLEET_OVERSIZED_UTILIZATION;
}

/** The flows (layout definitions) a fleet may serve. */
const servedFlows = (ctx, f) => (ctx.layout.flows || []).filter((flow) => !flow.fleetId || flow.fleetId === f.id);

/** A load that arrives at this station has to wait for room: a saturated workstation or a (nearly) full buffer. */
function destinationConstrained(ctx, id) {
  const s = ctx.byId.get(id);
  if (!s) return false;
  if (s.type === 'process') return saturation(s) >= BOTTLENECK_UTILIZATION;
  return s.type === 'storage' && (s.avgFill >= BUFFER_AVG_FILL || s.blocked >= BUFFER_FULL_SHARE);
}

/**
 * Mean time loads waited for a pickup by this fleet. Flows that deliver into a saturated workstation or a full
 * buffer are left out: there a load waits for room at the destination (the dispatcher only sends a vehicle when
 * the load fits), and more vehicles do not create room. null when nothing is left to judge.
 */
function pickupWait(ctx, f) {
  const flows = servedFlows(ctx, f);
  const open = flows.filter((flow) => !destinationConstrained(ctx, flow.to));
  if (open.length === flows.length) return f.avgPickupWait;
  let trips = 0;
  let total = 0;
  for (const flow of open) {
    const r = ctx.flows[flow.id];
    if (r && r.trips > 0 && r.avgPickupWait != null) {
      trips += r.trips;
      total += r.avgPickupWait * r.trips;
    }
  }
  return trips > 0 ? total / trips : null;
}

/** Is the fleet the limit of the plant? Busy all the time, or busy enough while loads wait long for it. */
function saturationOf(ctx, f) {
  if (!ctx.saturationCache.has(f.id)) {
    const wait = f.count >= 1 ? pickupWait(ctx, f) : null;
    const longWait = wait != null && wait >= FLEET_PICKUP_WAIT;
    const saturated = f.count >= 1 && (f.utilization >= FLEET_SATURATED_UTILIZATION
      || (longWait && f.utilization >= FLEET_PICKUP_WAIT_MIN_UTILIZATION));
    ctx.saturationCache.set(f.id, { saturated, longWait, wait });
  }
  return ctx.saturationCache.get(f.id);
}

/**
 * What limits the transport of a flow:
 *  'none' no vehicle may serve it, 'destination' the loads wait for room at the destination, 'traffic' congestion
 *  holds the vehicles up, 'vehicles' every fleet that may serve it is saturated, 'free' the vehicles have time to
 *  spare (so something else holds the loads back).
 */
function transportState(ctx, flow) {
  const serving = ctx.fleets.filter((f) => f.count >= 1 && (!flow.fleetId || flow.fleetId === f.id));
  if (serving.length === 0) return 'none';
  if (destinationConstrained(ctx, flow.to)) return 'destination';
  if (serving.some((f) => congested(ctx, f))) return 'traffic';
  return serving.every((f) => saturationOf(ctx, f).saturated) ? 'vehicles' : 'free';
}

/** The flow with the highest average backlog (the first one when none waits), with that backlog. */
function busiestFlow(ctx, flows) {
  let best = null;
  for (const flow of flows) {
    const backlog = ctx.flows[flow.id]?.avgBacklog || 0;
    if (!best || backlog > best.backlog) best = { flow, backlog };
  }
  return best;
}

/** busiestFlow, but only when loads wait for transport on average. */
function waitingFlow(ctx, flows) {
  const best = busiestFlow(ctx, flows);
  return best && best.backlog >= TRANSPORT_BACKLOG ? best : null;
}

/** What to do about a destination without room (see destinationConstrained). */
function roomAdvice(ctx, id) {
  const s = ctx.byId.get(id);
  return s.type === 'storage'
    ? `${s.name} is nearly full (${pct(s.avgFill)} on average): raise its capacity or take loads out of it faster`
    : `${s.name} cannot take more work (${loadText(s)}): add capacity there or enlarge its input buffer`;
}

/** The advice for loads that wait at the start of a flow, from the transport verdict of that flow. */
function transportAdvice(ctx, { flow, backlog }) {
  const from = ctx.name(flow.from);
  const to = ctx.name(flow.to);
  const route = `${from} to ${to}`;
  const waiting = `On average ${amount(backlog)} ${isOne(backlog) ? 'load waits' : 'loads wait'} at ${from} for a vehicle`;
  switch (transportState(ctx, flow)) {
    case 'vehicles':
      return `${waiting} and every vehicle that may serve the flow is busy: add a vehicle or raise the priority of the flow ${route}.`;
    case 'traffic':
      return `${waiting}, but congestion holds the vehicles up${aroundHotspots(ctx)}: relieve the traffic before adding vehicles.`;
    case 'none':
      return `No vehicle may serve the flow ${route}: add a fleet or remove the fleet restriction of the flow.`;
    case 'destination':
      return `${waiting}, but they wait for room at ${to}: ${roomAdvice(ctx, flow.to)}.`;
    default:
      return `${waiting}, although the vehicles have time to spare: check the room at ${to}, the minimum batch of the flow ${route} and that its vehicles can reach both docks.`;
  }
}

// ---- rules: stations -----------------------------------------------------------------------------------------

function bottlenecks(ctx) {
  const works = ctx.stations.filter((s) => s.type === 'process');
  const meanQueue = works.length ? sum(works.map((s) => s.avgIn)) / works.length : 0;
  const out = [];
  for (const s of works) {
    const load = saturation(s);
    if (!(load >= BOTTLENECK_UTILIZATION)) continue;
    const queued = s.avgIn >= BOTTLENECK_MIN_QUEUE && s.avgIn >= meanQueue;
    const starvedNext = ctx.workstationsBeyond(s.id, 'down')
      .filter((n) => n.starved >= SUCCESSOR_STARVED_SHARE)
      .sort((a, b) => b.starved - a.starved || (a.id < b.id ? -1 : 1))[0];
    if (!queued && !starvedNext) continue;

    const busy = hasDowntime(s)
      ? `busy ${pct(s.utilization)} and broken down ${pct(s.down)} of the time`
      : `busy ${pct(s.utilization)} of the time`;
    const title = queued
      ? `${s.name} is the bottleneck: ${busy} while ${amount(s.avgIn)} ${isOne(s.avgIn) ? 'load waits' : 'loads wait'} in front of it.`
      : `${s.name} is the bottleneck: ${busy} and ${starvedNext.name} downstream is starved ${pct(starvedNext.starved)} of the time.`;
    const detail = [
      `Over ${formatDuration(ctx.duration)}, ${s.name} was working ${pct(s.utilization)} of the time (down ${pct(s.down)}, blocked ${pct(s.blocked)}).`,
      queued ? `Its input queue held ${amount(s.avgIn)} loads on average, at most ${formatNumber(s.maxIn)}.` : '',
      starvedNext && queued ? `${starvedNext.name} downstream waited for input ${pct(starvedNext.starved)} of the time.` : '',
      s.produced > 0 && ctx.duration > 0 ? `It finished about ${formatNumber((s.produced / ctx.duration) * 3600)} loads per hour, and the whole plant cannot deliver more than that.` : 'The whole plant cannot deliver more than this station allows.',
    ].filter(Boolean).join(' ');

    const machines = ctx.stationDefs.get(s.id)?.params?.machines;
    const cut = Math.max(1, Math.ceil((1 - MACHINE_TARGET_UTILIZATION / load) * 100));
    const suggestion = machines >= 1
      ? `Add a machine to ${s.name} (now ${machines}), which would bring its load down to about ${pct((load * machines) / (machines + 1))}, or shorten its cycle time by about ${cut} %.`
      : `Shorten the cycle time of ${s.name} by about ${cut} % or add a parallel machine.`;
    const severity = load >= BOTTLENECK_CRITICAL_UTILIZATION ? 'critical' : 'warning';
    out.push(candidate('bottleneck', s.id, severity, load, title, detail, suggestion, { stationIds: [s.id] }));
  }
  return out;
}

function blockedWorkstations(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    if (s.type !== 'process' || !(s.blocked >= BLOCKED_SHARE)) continue;
    const outgoing = busiestFlow(ctx, ctx.flowsFrom.get(s.id) || []);
    const waiting = outgoing && outgoing.backlog >= TRANSPORT_BACKLOG ? outgoing : null;
    const refs = { stationIds: [s.id] };
    let suggestion;
    if (waiting) {
      suggestion = transportAdvice(ctx, waiting);
      refs.flowIds = [waiting.flow.id];
    } else if (outgoing) {
      suggestion = `${ctx.name(outgoing.flow.to)} cannot take the loads fast enough: enlarge its input buffer or speed up the work there.`;
    } else {
      suggestion = `Enlarge the output buffer of ${s.name}.`;
    }
    out.push(candidate('blocked', s.id, s.blocked >= BLOCKED_CRITICAL_SHARE ? 'critical' : 'warning', s.blocked,
      `${s.name} is blocked ${pct(s.blocked)} of the time: its finished loads are not taken away fast enough.`,
      `Over ${formatDuration(ctx.duration)}, ${s.name} had to hold finished loads for ${pct(s.blocked)} of its machine time because its output buffer was full. It worked ${pct(s.utilization)} of the time.`,
      suggestion, refs));
  }
  return out;
}

function starvedWorkstations(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    if (s.type !== 'process' || !(s.starved >= STARVED_SHARE)) continue;
    const bottleneck = ctx.workstationsBeyond(s.id, 'up').filter((u) => saturation(u) >= BOTTLENECK_UTILIZATION)[0];
    const waiting = waitingFlow(ctx, ctx.flowsTo.get(s.id) || []);
    const supplier = (ctx.flowsTo.get(s.id) || []).map((f) => ctx.byId.get(f.from)).find((u) => u && u.type === 'source');
    const refs = { stationIds: [s.id] };
    let suggestion;
    if (bottleneck) {
      suggestion = `Fix ${bottleneck.name} first (${loadText(bottleneck)}): ${s.name} can only work as fast as it is fed.`;
      refs.stationIds.push(bottleneck.id);
    } else if (waiting) {
      suggestion = transportAdvice(ctx, waiting);
      refs.flowIds = [waiting.flow.id];
    } else if (supplier) {
      suggestion = `${supplier.name} delivers too slowly: shorten its arrival interval or raise the demand factor in the Simulate tab.`;
    } else {
      suggestion = `Check the supply into ${s.name}: its suppliers produce or deliver less often than it could work.`;
    }
    // A workstation that simply gets less work than it could do is spare capacity (info). It becomes a problem when
    // ready loads are waiting to be moved to it.
    const severity = s.starved >= STARVED_WARNING_SHARE && waiting && !bottleneck ? 'warning' : 'info';
    out.push(candidate('starved', s.id, severity, s.starved,
      `${s.name} waits for input ${pct(s.starved)} of the time.`,
      `Over ${formatDuration(ctx.duration)}, ${s.name} was idle for lack of input loads ${pct(s.starved)} of the time and worked ${pct(s.utilization)}.${bottleneck ? ` Its supplier ${bottleneck.name} is the bottleneck.` : ''}`,
      suggestion, refs));
  }
  return out;
}

function bufferProblems(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    if (s.type !== 'storage') continue;
    const full = s.blocked;
    if (!(s.avgFill >= BUFFER_AVG_FILL || full >= BUFFER_FULL_SHARE)) continue;
    const capacity = ctx.stationDefs.get(s.id)?.params?.capacity;
    const raise = capacity >= 1 ? `from ${capacity} to ${Math.ceil(capacity * BUFFER_GROWTH)} loads` : 'by about 50 %';
    out.push(candidate('buffer-full', s.id, full >= BUFFER_CRITICAL_FULL_SHARE ? 'critical' : 'warning', Math.max(s.avgFill, full),
      full > 0
        ? `${s.name} is nearly full: ${pct(s.avgFill)} on average and completely full ${pct(full)} of the time.`
        : `${s.name} is nearly full: ${pct(s.avgFill)} on average, peaking at ${pct(s.maxFill)}.`,
      `Over ${formatDuration(ctx.duration)}, ${s.name} held ${pct(s.avgFill)} of its capacity on average. While it is full, everything upstream has to wait.`,
      `Raise the capacity of ${s.name} ${raise}, or let the next step take loads faster: speed up the workstation behind it or raise the priority of the flow leaving it.`,
      { stationIds: [s.id] }));
  }
  return out;
}

function supplyExceedsCapacity(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    if (s.type !== 'source' || !(s.blocked >= SUPPLY_BLOCKED_SHARE && s.yardNow >= SUPPLY_MIN_YARD)) continue;
    if (!(ctx.flowsFrom.get(s.id) || []).length) continue; // nothing is connected to it: source-unconnected-activity explains that
    const next = (ctx.flowsFrom.get(s.id) || []).map((f) => ctx.byId.get(f.to)).filter(Boolean)
      .sort((a, b) => Math.max(b.utilization, b.avgFill) - Math.max(a.utilization, a.avgFill))[0];
    const waiting = waitingFlow(ctx, ctx.flowsFrom.get(s.id) || []);
    let suggestion;
    if (next && next.type === 'process' && saturation(next) >= BOTTLENECK_UTILIZATION) {
      suggestion = `Add capacity at ${next.name} (${loadText(next)}): ${s.name} delivers faster than the line can take.`;
    } else if (waiting) {
      suggestion = transportAdvice(ctx, waiting);
    } else {
      suggestion = `Slow the supply down (demand factor below 1 in the Simulate tab) or enlarge the output buffer of ${s.name}.`;
    }
    out.push(candidate('supply', s.id, s.yardNow >= SUPPLY_CRITICAL_YARD ? 'critical' : 'warning', s.blocked,
      `${s.name} delivers more than the plant takes: ${plural(s.yardNow, 'load is', 'loads are')} piling up in its yard.`,
      `Over ${formatDuration(ctx.duration)}, the output buffer of ${s.name} was full ${pct(s.blocked)} of the time. The backlog in front of it peaked at ${formatNumber(s.yardMax)} loads and stands at ${formatNumber(s.yardNow)} now.`,
      suggestion, { stationIds: [s.id] }));
  }
  return out;
}

function stationBreakdowns(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    if (s.type !== 'process' || !(s.breakdowns >= BREAKDOWN_MIN_COUNT && s.down >= BREAKDOWN_DOWN_SHARE)) continue;
    const def = ctx.stationDefs.get(s.id);
    const machines = def?.params?.machines;
    const mttr = def?.params?.mttr;
    const suggestion = machines === 1
      ? `Add a second machine at ${s.name} so production continues during a repair, or cut the mean repair time${mttr > 0 ? ` (now ${formatDuration(mttr)})` : ''}.`
      : `Cut the mean repair time of ${s.name}${mttr > 0 ? ` (now ${formatDuration(mttr)})` : ''} or its failure rate with better maintenance.`;
    out.push(candidate('breakdowns', s.id, s.down >= BREAKDOWN_WARNING_SHARE ? 'warning' : 'info', s.down,
      `${s.name} broke down ${formatNumber(s.breakdowns)} times and was out of service ${pct(s.down)} of the time.`,
      `Over ${formatDuration(ctx.duration)}, machine time lost to breakdowns at ${s.name} was ${pct(s.down)}. Every outage stops production there until the repair is done.`,
      suggestion, { stationIds: [s.id] }));
  }
  return out;
}

// ---- rules: fleets ---------------------------------------------------------------------------------------------

function saturatedFleets(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    const { saturated, longWait, wait } = saturationOf(ctx, f);
    if (!saturated) continue;

    const extra = Math.max(1, Math.ceil((f.count * f.utilization) / FLEET_TARGET_UTILIZATION) - f.count);
    const own = fleetWaitShare(f) >= TRAFFIC_WAIT_SHARE;
    const helpers = idleHelpers(ctx, f);
    let suggestion;
    if (helpers.length) { // never ask for more vehicles while others that may do the same jobs stand idle
      suggestion = `The ${helpers.map((o) => o.name).join(' and ')} ${helpers.length === 1 ? 'fleet' : 'fleets'} may serve the same flows but hardly ${helpers.length === 1 ? 'works' : 'work'}: find out why those vehicles are not used (can they reach the docks?) before adding vehicles here.`;
    } else if (own) {
      suggestion = `A lot of the busy time is spent waiting in traffic (${pct(f.shares.waiting)} of the fleet's time): relieve the congestion${aroundHotspots(ctx, 1)} before buying more vehicles.`;
    } else if (congested(ctx, f)) {
      suggestion = `Traffic costs ${pct(ctx.traffic.waitShare)} of the driving time across the plant: relieve the congestion${aroundHotspots(ctx, 1)} before buying more vehicles.`;
    } else {
      suggestion = `Add ${plural(extra, 'vehicle', 'vehicles')} to the ${f.name} fleet (now ${f.count}): at the current workload that brings utilization down to about ${pct((f.utilization * f.count) / (f.count + extra))}. Faster vehicles or shorter routes help too.`;
    }
    out.push(candidate('fleet-saturated', f.id, f.utilization >= FLEET_CRITICAL_UTILIZATION ? 'critical' : 'warning', f.utilization,
      `${f.name} fleet is saturated: its ${plural(f.count, 'vehicle is', 'vehicles are')} busy ${pct(f.utilization)} of the time${longWait ? `, and loads wait ${formatDuration(wait)} for a pickup` : ''}.`,
      `Over ${formatDuration(ctx.duration)}, a ${f.name} vehicle spent ${pct(f.shares?.driving || 0)} of its time driving, ${pct(f.shares?.waiting || 0)} waiting in traffic and ${pct((f.shares?.loading || 0) + (f.shares?.unloading || 0))} loading or unloading, and made ${amount(f.tripsPerVehicleHour)} trips per hour.${f.avgPickupWait != null ? ` Loads waited ${formatDuration(f.avgPickupWait)} for pickup on average.` : ''}`,
      suggestion, { fleetIds: [f.id] }));
  }
  return out;
}

/** No flow may use this fleet: the plant has flows, and every one of them is restricted to another fleet. */
const noJobs = (ctx, f) => f.count >= 1 && (ctx.layout.flows || []).length > 0 && servedFlows(ctx, f).length === 0;

/** A load that this fleet may carry is waiting for transport on average. */
const loadsWaitFor = (ctx, f) => servedFlows(ctx, f).some((flow) => (ctx.flows[flow.id]?.avgBacklog || 0) >= TRANSPORT_BACKLOG);

/**
 * The fleet hardly works although there is work: fewer than FLEET_BARELY_USED_TRIPS_PER_HOUR trips per vehicle and hour over a long
 * window, other vehicles carried at least FLEET_UNUSED_MIN_OTHER_TRIPS loads on the flows it may serve too, and no load waits for a
 * vehicle (then the vehicles would be needed, and something else is wrong). null when it does not hold; the single source of this
 * verdict, which the other fleet rules consult so that they never ask for more vehicles of a fleet that is not used.
 */
function barelyUsed(ctx, f) {
  if (!ctx.barelyUsedCache) ctx.barelyUsedCache = new Map();
  if (ctx.barelyUsedCache.has(f.id)) return ctx.barelyUsedCache.get(f.id);
  let verdict = null;
  // vehicles that stand in a queue all day make no trips either, but they are busy (utilization counts waiting): not "unused"
  if (ctx.duration >= UNUSED_MIN_WINDOW && f.count >= 1 && f.tripsPerVehicleHour < FLEET_BARELY_USED_TRIPS_PER_HOUR && f.utilization < FLEET_OVERSIZED_UTILIZATION) {
    const onServed = sum(servedFlows(ctx, f).map((flow) => ctx.flows[flow.id]?.trips || 0));
    const others = Math.max(0, onServed - (f.trips || 0));
    if (others >= FLEET_UNUSED_MIN_OTHER_TRIPS && !loadsWaitFor(ctx, f)) verdict = { trips: f.trips || 0, others };
  }
  ctx.barelyUsedCache.set(f.id, verdict);
  return verdict;
}

/** Other fleets that hardly work although they may serve a flow that fleet `f` serves too. */
const idleHelpers = (ctx, f) => ctx.fleets.filter((o) => o.id !== f.id && barelyUsed(ctx, o)
  && servedFlows(ctx, o).some((flow) => servedFlows(ctx, f).some((mine) => mine.id === flow.id)));

function oversizedFleets(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    if (!oversized(f)) continue;
    if (barelyUsed(ctx, f) || noJobs(ctx, f)) continue; // fleet-unused / fleet-no-jobs say it better: the other vehicles cover every job / no flow may use this fleet
    const unused = f.utilization < FLEET_UNUSED_UTILIZATION;
    if (!unused && loadsWaitFor(ctx, f)) continue; // loads wait although vehicles are free: not a matter of fleet size
    const fewer = Math.max(1, Math.ceil((f.count * f.utilization) / FLEET_TARGET_UTILIZATION));
    const suggestion = unused
      ? `None of the ${f.count} ${f.name} vehicles did any real work: check that a flow allows this fleet (fleet restriction) and that its vehicles can reach the docks, or remove the fleet.`
      : `Try ${plural(fewer, 'vehicle', 'vehicles')} instead of ${f.count}: utilization would rise to about ${pct((f.utilization * f.count) / fewer)}, and fewer vehicles also mean less traffic.`;
    out.push(candidate('fleet-oversized', f.id, 'info', 1 - f.utilization,
      `${f.name} fleet is mostly idle: its ${f.count} vehicles work only ${pct(f.utilization)} of the time.`,
      `Over ${formatDuration(ctx.duration)}, ${pct((f.shares?.idle || 0) + (f.shares?.parked || 0))} of the vehicle time was spent idle or parked and ${pct(f.shares?.charging || 0)} charging.`,
      suggestion, { fleetIds: [f.id] }));
  }
  return out;
}

function emptyDriving(ctx) {
  const out = [];
  const dispatch = ctx.layout.settings?.dispatch;
  for (const f of ctx.fleets) {
    if (!(f.emptyShare > EMPTY_DRIVING_SHARE && f.trips >= EMPTY_DRIVING_MIN_TRIPS && f.utilization >= EMPTY_DRIVING_MIN_UTILIZATION)) continue;
    const carriesMore = ctx.fleetDefs.get(f.id)?.capacity > 1;
    let suggestion;
    if (dispatch === 'oldest') {
      suggestion = 'Switch the dispatch strategy from "Oldest job first" to "Nearest job first" in the Simulate tab so vehicles pick up close to where they just delivered.';
    } else if (carriesMore) {
      suggestion = 'Let vehicles carry more per trip (a higher batch minimum for the flows) or place pickup and drop stations so a vehicle can return with a load.';
    } else {
      suggestion = 'Place pickup and drop stations so a vehicle can return with a load, for example a drop-off next to the next pickup.';
    }
    out.push(candidate('empty-driving', f.id, 'info', f.emptyShare,
      `${f.name} vehicles drive empty ${pct(f.emptyShare)} of the distance.`,
      `Of ${formatDistance(f.distance)} driven by the fleet, ${formatDistance(f.distance * f.emptyShare)} were without a load, over ${formatNumber(f.trips)} trips. The vehicles are busy ${pct(f.utilization)} of the time, so every empty kilometre costs capacity.`,
      suggestion, { fleetIds: [f.id] }));
  }
  return out;
}

function unplacedVehicles(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    if (!(f.unplaced >= 1)) continue;
    const planned = f.count + f.unplaced;
    out.push(candidate('unplaced', f.id, 'warning', f.unplaced / planned,
      `${f.name} fleet: ${plural(f.unplaced, 'vehicle', 'vehicles')} of ${planned} did not fit on the road and ${isOne(f.unplaced) ? 'is' : 'are'} not simulated.`,
      `At the start the road network had no free cell for ${plural(f.unplaced, 'vehicle', 'vehicles')} where they could work (a one-way branch that vehicles cannot drive back out of is not used), so the simulation runs with ${f.count} instead of ${planned} ${f.name} vehicles. The results describe the smaller fleet.`,
      `Add road length or a depot where vehicles can park, or lower the vehicle count of the ${f.name} fleet to ${f.count}.`,
      { fleetIds: [f.id] }));
  }
  return out;
}

function batteryProblems(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    if (f.minBattery == null) continue;
    const def = ctx.fleetDefs.get(f.id);
    const depot = (def?.home && ctx.stationDefs.get(def.home)) || [...ctx.stationDefs.values()].find((s) => s.type === 'depot' && s.params?.chargers > 0);
    const chargers = depot?.params?.chargers || 0;
    const lowPct = def?.battery?.lowPct;
    const fix = chargers > 0
      ? `add a charger at ${depot.name} (now ${chargers})`
      : 'add a depot with chargers';
    const raise = lowPct >= 0 ? `Send vehicles to charge earlier (from ${lowPct} % to ${Math.min(60, lowPct + 15)} %) or ${fix}.` : `Send vehicles to charge earlier or ${fix}.`;
    const refs = { fleetIds: [f.id], ...(depot ? { stationIds: [depot.id] } : {}) };
    if (f.minBattery <= BATTERY_EMPTY) {
      out.push(candidate('battery', f.id, 'critical', 1,
        `${f.name} vehicles ran out of battery: at least one stopped on the road.`,
        `The lowest charge reached 0 %. A vehicle with an empty battery stops where it is and blocks its lane. Vehicles spent ${pct(f.shares?.charging || 0)} of their time charging.`,
        raise, refs));
    } else if (f.minBattery < BATTERY_LOW) {
      out.push(candidate('battery', f.id, 'warning', 1 - f.minBattery,
        `${f.name} battery dropped to ${pct(f.minBattery)}: vehicles come close to running empty.`,
        `The lowest charge in ${formatDuration(ctx.duration)} was ${pct(f.minBattery)}. Vehicles spent ${pct(f.shares?.charging || 0)} of their time charging.`,
        raise, refs));
    } else if ((f.shares?.charging || 0) >= CHARGING_SHARE) {
      out.push(candidate('battery', f.id, 'info', f.shares.charging,
        `${f.name} vehicles spend ${pct(f.shares.charging)} of their time charging.`,
        `Charging takes ${pct(f.shares.charging)} of the fleet's time, so fewer vehicles are available for transport. The lowest charge was ${pct(f.minBattery)}.`,
        chargers > 0 ? `Add a charger at ${depot.name} (now ${chargers}) so vehicles spend less time waiting for a free one, or choose vehicles with a longer battery runtime.` : 'Add a depot with chargers or choose vehicles with a longer battery runtime.',
        refs));
    }
  }
  return out;
}

/** A spare vehicle only makes sense when the fleet is not mostly idle already and traffic is not congested. */
const moreVehiclesHelp = (ctx, f) => !congested(ctx, f) && !oversized(f) && !barelyUsed(ctx, f) && !noJobs(ctx, f);

function vehicleBreakdowns(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    const broken = f.shares?.broken || 0;
    if (!(broken >= VEHICLE_BROKEN_SHARE)) continue;
    out.push(candidate('breakdowns', f.id, broken >= BREAKDOWN_WARNING_SHARE ? 'warning' : 'info', broken,
      `${f.name} vehicles are broken down ${pct(broken)} of the time.`,
      `A broken vehicle blocks its lane until it is repaired${ctx.traffic.brokenWait > 0 ? `; other vehicles lost ${formatDuration(ctx.traffic.brokenWait)} in total waiting behind broken ones` : ''}.`,
      moreVehiclesHelp(ctx, f)
        ? `Add a spare vehicle to the fleet (now ${f.count}) and give the busiest aisles a bypass so one breakdown does not stop the traffic behind it.`
        : `Reduce the downtime (maintenance, quicker repairs) and give the busiest aisles a bypass so one breakdown does not stop the traffic behind it.`,
      { fleetIds: [f.id] }));
  }
  return out;
}

// ---- rules: resources that are not used ------------------------------------------------------------------------------

/** "#3" for the vehicle "f2#3". */
const vehicleNumber = (id) => `#${String(id).split('#').pop()}`;

/** Vehicles that no flow may use: all flows are dedicated to other fleets, so they stand idle however much work there is. */
function fleetsWithoutJobs(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    if (!noJobs(ctx, f)) continue;
    const owners = [...new Set((ctx.layout.flows || []).map((flow) => ctx.fleetDefs.get(flow.fleetId)?.name || flow.fleetId))];
    const them = f.count === 1 ? 'it' : 'them';
    out.push(candidate('fleet-no-jobs', f.id, 'info', 1,
      `The ${plural(f.count, 'vehicle', 'vehicles')} of the ${f.name} fleet ${f.count === 1 ? 'has' : 'have'} no job: every flow is restricted to another fleet.`,
      `All flows of this plant are dedicated to ${owners.join(' and ')}. A vehicle only takes jobs from flows that allow its fleet, so the ${f.name} ${f.count === 1 ? 'vehicle stands' : 'vehicles stand'} idle however much work there is.`,
      `Allow ${f.name} on a flow (Fleet → Jobs this fleet serves, or the fleet setting of a flow in the Flows tab), or remove ${them} (now ${f.count}).`,
      { fleetIds: [f.id] }));
  }
  return out;
}

function unusedFleets(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    const verdict = barelyUsed(ctx, f);
    if (!verdict) continue;
    const trips = plural(verdict.trips, 'trip', 'trips');
    out.push(candidate('fleet-unused', f.id, congested(ctx, f) ? 'warning' : 'info', 1 - f.tripsPerVehicleHour / FLEET_BARELY_USED_TRIPS_PER_HOUR,
      `The ${plural(f.count, 'vehicle', 'vehicles')} of the ${f.name} fleet ${f.count === 1 ? 'hardly works' : 'hardly work'} (${trips} in ${formatDuration(ctx.duration)}).`,
      `Over ${formatDuration(ctx.duration)} the ${f.name} ${f.count === 1 ? 'vehicle' : 'vehicles'} made ${trips}, ${amount(f.tripsPerVehicleHour)} per vehicle and hour, while the other vehicles made ${formatNumber(verdict.others)} trips on the flows ${f.count === 1 ? 'it' : 'they'} may serve too.`,
      `The other vehicles already cover every job. Remove ${f.count === 1 ? 'it' : 'them'} (now ${f.count}), or give ${f.count === 1 ? 'it' : 'them'} their own flows under Fleet → Jobs this fleet serves.`,
      { fleetIds: [f.id] }));
  }
  return out;
}

/** Some vehicles of a fleet that is otherwise busy hardly get a job: they are the ones to take away. */
function idleVehicles(ctx) {
  const out = [];
  if (!(ctx.duration >= UNUSED_MIN_WINDOW)) return out;
  for (const f of ctx.fleets) {
    const entries = Object.entries(f.vehicleTrips || {});
    const n = entries.length;
    // a fleet that is unused, oversized or saturated as a whole has its own, more fitting verdict
    if (n < 2 || barelyUsed(ctx, f) || oversized(f) || saturationOf(ctx, f).saturated) continue;
    const total = sum(entries.map(([, t]) => t));
    const quiet = entries.filter(([, t]) => {
      const mates = (total - t) / (n - 1);
      return mates >= VEHICLE_IDLE_MIN_MEAN_TRIPS && t < VEHICLE_IDLE_SHARE * mates;
    });
    if (!quiet.length || quiet.length === n) continue;
    const busyMean = (total - sum(quiet.map(([, t]) => t))) / (n - quiet.length);
    const named = quiet.slice(0, 3).map(([id, t]) => `${vehicleNumber(id)} (${plural(t, 'trip', 'trips')})`);
    const more = quiet.length > 3 ? ` and ${quiet.length - 3} more` : '';
    const keep = n - quiet.length;
    const one = quiet.length === 1;
    out.push(candidate('vehicle-idle-some', f.id, 'info', quiet.length / n,
      `${quiet.length} of ${n} vehicles in the ${f.name} fleet ${one ? 'hardly works' : 'hardly work'}.`,
      `Over ${formatDuration(ctx.duration)}, ${named.join(', ')}${more} made far fewer trips than ${one ? 'the other vehicles of the fleet' : 'their fleet-mates'}, who averaged ${amount(busyMean)} trips each.`,
      `Try ${plural(keep, 'vehicle', 'vehicles')} instead of ${n}: a job goes to the vehicle that can start soonest, so vehicles that wait far from the docks rarely get one. Or park the idle ones closer to the work (Fleet → Parking).`,
      { fleetIds: [f.id] }));
  }
  return out;
}

/** A goods-in that keeps receiving loads while no flow leads away from it: its yard just grows. */
function unconnectedSources(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    if (s.type !== 'source' || (ctx.flowsFrom.get(s.id) || []).length > 0) continue;
    if (!(s.arrivals >= 1 && s.yardNow >= SOURCE_UNCONNECTED_MIN_YARD)) continue;
    out.push(candidate('source-unconnected-activity', s.id, s.yardNow >= SUPPLY_MIN_YARD ? 'warning' : 'info', 1 - 1 / (1 + s.yardNow),
      `${s.name} receives loads, but no flow takes them away: ${plural(s.yardNow, 'load is', 'loads are')} piling up in its yard.`,
      `Over ${formatDuration(ctx.duration)}, ${s.name} received ${formatNumber(s.arrivals)} ${s.arrivals === 1 ? 'load' : 'loads'}. No flow starts at this station, so no vehicle ever collects them and the yard holds ${formatNumber(s.yardNow)} now.`,
      `Connect ${s.name} to a workstation, a buffer or a shipping station with a flow (drag from its flow handle, or use the Flow tool), or remove the station.`,
      { stationIds: [s.id] }));
  }
  return out;
}

/** Supply exists upstream of a station and the vehicles have time, but over a long window not one load reached it. */
function neverUsedStations(ctx) {
  const out = [];
  if (!(ctx.duration >= STATION_NEVER_USED_WINDOW)) return out;
  for (const s of ctx.stations) {
    if (s.type !== 'process' && s.type !== 'storage' && s.type !== 'sink') continue;
    const incoming = ctx.flowsTo.get(s.id) || [];
    if (!incoming.length || incoming.some((flow) => (ctx.flows[flow.id]?.delivered || 0) > 0 || (ctx.flows[flow.id]?.trips || 0) > 0)) continue;
    // the loads are there (made upstream or waiting for a pickup) and a vehicle that is not busy may carry them
    const supplied = incoming.filter((flow) => {
      const origin = ctx.byId.get(flow.from);
      // a storage keeps every load for its dwell time: with a dwell of half the window or more, nothing could have left it yet
      const held = ctx.stationDefs.get(flow.from);
      if (held && held.type === 'storage' && (held.params?.dwell || 0) >= ctx.duration / 2) return false;
      const waiting = (ctx.flows[flow.id]?.avgBacklog || 0) >= TRANSPORT_BACKLOG;
      return transportState(ctx, flow) === 'free' && (waiting || (origin && Math.max(origin.produced || 0, origin.arrivals || 0) >= STATION_NEVER_USED_MIN_SUPPLY));
    });
    if (!supplied.length) continue;
    const origin = ctx.byId.get(supplied[0].from);
    out.push(candidate('station-never-used', s.id, 'warning', 1,
      `Nothing reaches ${s.name}: no load arrived there in ${formatDuration(ctx.duration)}.`,
      `${origin ? origin.name : 'The station before it'} supplies ${s.name} and the vehicles have time to spare, yet not one trip to ${s.name} was made in ${formatDuration(ctx.duration)}. Either no vehicle can drive to its dock, or the flow waits for a batch that never fills.`,
      `Check the road to ${s.name}: it needs a road cell next to the station that vehicles can reach and leave again (not a one-way dead end). The Checks tab lists stations without a usable dock.`,
      { stationIds: [s.id], flowIds: supplied.map((flow) => flow.id) }));
  }
  return out;
}

// ---- rules: traffic --------------------------------------------------------------------------------------------

function trafficCongestion(ctx) {
  const t = ctx.traffic;
  if (!(t.waitShare >= TRAFFIC_WAIT_SHARE)) return [];
  const spots = hotspotCells(ctx);
  const total = (t.vehicleWait || 0) + (t.junctionWait || 0) + (t.brokenWait || 0);
  const where = spots.length ? ` around ${cellList(spots)}` : '';
  let suggestion;
  if ((t.brokenWait || 0) >= Math.max(t.vehicleWait || 0, t.junctionWait || 0)) {
    suggestion = `Broken-down vehicles block the aisle${where}: add a bypass or a parking bay next to it so traffic can pass, and improve the reliability of the fleet.`;
  } else if ((t.junctionWait || 0) >= (t.vehicleWait || 0)) {
    suggestion = `Most waiting happens at junctions${where}: give the main route its own road, or make one of the crossing roads one-way.`;
  } else {
    suggestion = `Vehicles queue behind each other${where}: add a parallel road, make the aisle one-way, or reduce the number of vehicles sharing it.`;
  }
  const detail = [
    `Together, vehicles waited ${formatDuration(total)} in the last ${formatDuration(ctx.duration)}`
      + (total > 0 ? `: ${pct((t.vehicleWait || 0) / total)} behind other vehicles, ${pct((t.junctionWait || 0) / total)} for junctions and ${pct((t.brokenWait || 0) / total)} behind broken-down vehicles.` : '.'),
    spots.length ? `The worst spots are ${spots.map((c) => `${cellText(c)} with ${formatDuration(c.wait)}`).join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  return [candidate('traffic', null, t.waitShare >= TRAFFIC_CRITICAL_WAIT_SHARE ? 'critical' : 'warning', t.waitShare,
    `Traffic is costing time: vehicles spend ${pct(t.waitShare)} of their driving time waiting.`,
    detail, suggestion, spots.length ? { cells: spots.map((c) => [c.cx, c.cy]) } : {})];
}

// ---- rules: docks -------------------------------------------------------------------------------------------------

const cellsOf = (docks) => docks.map((d) => cellText(d));
/** "(12, 2)" or "(12, 2) and (15, 2)" or "(12, 2), (15, 2) and (18, 2)". */
const cellsText = (docks) => {
  const list = cellsOf(docks);
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

/** A queue in front of a station whose docks are busy nearly all the time: add a dock, or make the hand-over quicker. */
function dockBottlenecks(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    const docks = s.docks || [];
    if (docks.length === 0) continue;
    const visits = sum(docks.map((d) => d.visits));
    const wait = s.dockWaitTotal || 0;
    const busy = sum(docks.map((d) => d.busyShare)) / docks.length;
    if (!(visits >= DOCK_MIN_VISITS && busy >= DOCK_BUSY_SHARE && wait >= DOCK_WAIT_PER_VISIT * visits)) continue;
    const perVisit = wait / visits;
    const only = docks.length === 1;
    const title = only
      ? `Vehicles queue at ${s.name}: its only dock is busy ${pct(busy)} of the time and vehicles waited ${formatDuration(wait)}.`
      : `Vehicles queue at ${s.name}: its ${docks.length} docks are busy ${pct(busy)} of the time on average and vehicles waited ${formatDuration(wait)}.`;
    const detail = `Over ${formatDuration(ctx.duration)}, ${plural(visits, 'vehicle', 'vehicles')} stopped at ${s.name}; together they stood in a queue for a dock for ${formatDuration(wait)} (${formatDuration(perVisit)} per visit). `
      + `${only ? 'The dock' : 'The docks'} at ${cellsText(docks)} ${only ? 'was' : 'were'} occupied ${pct(busy)} of the time, so a vehicle that arrives usually finds ${only ? 'it' : 'every one of them'} taken.`;
    const suggestion = only
      ? 'Add a second dock - any road cell touching the station - or a bypass bay.'
      : 'Add another dock - any road cell touching the station - or shorten the load and unload time of the vehicles that stop here.';
    out.push(candidate('dock-bottleneck', s.id, perVisit >= DOCK_WARNING_WAIT_PER_VISIT ? 'warning' : 'info', Math.min(1, busy), title, detail, suggestion,
      { stationIds: [s.id], cells: docks.map((d) => [d.cx, d.cy]) }));
  }
  return out;
}

/** The same queue, but idle vehicles that stay on the road stand on the docks: more docks would only be taken by them too. */
function dockIdleVehicles(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    const docks = s.docks || [];
    if (docks.length === 0) continue;
    const visits = sum(docks.map((d) => d.visits));
    const wait = s.dockWaitTotal || 0;
    const busy = sum(docks.map((d) => d.busyShare)) / docks.length;
    const held = sum(docks.map((d) => d.heldShare || 0)) / docks.length;
    if (!(visits >= DOCK_MIN_VISITS && held >= DOCK_HELD_SHARE && busy < DOCK_BUSY_SHARE && wait >= DOCK_WAIT_PER_VISIT * visits)) continue;
    const perVisit = wait / visits;
    const only = docks.length === 1;
    out.push(candidate('dock-idle-vehicles', s.id, perVisit >= DOCK_WARNING_WAIT_PER_VISIT ? 'warning' : 'info', Math.min(1, held),
      `Idle vehicles stand on ${only ? 'the dock' : 'the docks'} of ${s.name} ${pct(held)} of the time and vehicles queue behind them.`,
      `Over ${formatDuration(ctx.duration)}, vehicles waited ${formatDuration(wait)} for a dock of ${s.name} (${formatDuration(perVisit)} per visit), although ${only ? 'it was' : 'they were'} only ${pct(busy)} of the time in use: `
        + `a vehicle with nothing to do stays where its last job ended, and ${only ? 'the dock at' : 'the docks at'} ${cellsText(docks)} ${only ? 'is' : 'are'} often where that is.`,
      'Set the fleet to "Park in depot" instead of "Stay on road" (Fleet tab; the plant needs a Parking station for that), so idle vehicles leave the docks free.',
      { stationIds: [s.id], cells: docks.map((d) => [d.cx, d.cy]) }));
  }
  return out;
}

const SKEW_TEXT = {
  trap: {
    why: (q) => `vehicles that drive to ${q.length === 1 ? 'it' : 'them'} cannot get back out again (a one-way dead end), so ${q.length === 1 ? 'it is' : 'they are'} only a last resort`,
    fix: (q) => `Make the road at ${cellsText(q)} two-way, or connect it onwards, so vehicles can leave again.`,
  },
  lane: {
    why: (q, b) => `the docks lie one behind the other on one lane, so a vehicle standing on ${cellText(b)} blocks the way to ${cellsText(q)}`,
    fix: (q) => `Give ${cellsText(q)} a side road of its own, or add a dock that can be reached without passing another one.`,
  },
  detour: {
    why: (q) => `${cellsText(q)} ${q.length === 1 ? 'is' : 'are'} a long way round, so vehicles only go there when the wait at the nearer dock is longer than the extra drive`,
    fix: (q, b) => `Bring the road to ${cellsText(q)} closer to where vehicles arrive, or add another dock next to ${cellText(b)}.`,
  },
};

/** One dock does nearly all the work while others stand unused and vehicles wait: only said when the report knows why. */
function docksUnbalanced(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    const skew = s.dockSkew;
    if (!skew || !SKEW_TEXT[skew.reason]) continue;
    const text = SKEW_TEXT[skew.reason];
    const wait = s.dockWaitTotal || 0;
    out.push(candidate('docks-unbalanced', s.id, skew.waitPerVisit >= DOCK_WARNING_WAIT_PER_VISIT ? 'warning' : 'info', skew.busy.share,
      `${s.name}: the dock at ${cellText(skew.busy)} takes ${pct(skew.busy.share)} of the visits while ${cellsText(skew.quiet)} ${skew.quiet.length === 1 ? 'is' : 'are'} hardly used.`,
      `Vehicles waited ${formatDuration(wait)} for a dock of ${s.name} in ${formatDuration(ctx.duration)} (${formatDuration(skew.waitPerVisit)} per visit), although ${skew.quiet.length === 1 ? 'another dock was' : 'other docks were'} free: ${text.why(skew.quiet, skew.busy)}.`,
      text.fix(skew.quiet, skew.busy),
      { stationIds: [s.id], cells: [skew.busy, ...skew.quiet].map((d) => [d.cx, d.cy]) }));
  }
  return out;
}

function deadlocks(ctx) {
  const t = ctx.traffic;
  if (!(t.deadlocks > 0)) return [];
  const events = t.deadlockEvents || [];
  const unresolved = events.some((e) => !e.resolved);
  const cols = ctx.layout.grid?.cols;
  const counts = new Map();
  for (const e of events) for (const node of e.nodes || []) counts.set(node, (counts.get(node) || 0) + 1);
  const cells = cols >= 1
    ? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, TRAFFIC_HOTSPOT_CELLS)
      .map(([node]) => ({ cx: node % cols, cy: Math.floor(node / cols) }))
    : [];
  const where = cells.length ? ` around ${cellList(cells)}` : '';
  const times = `${formatNumber(t.deadlocks)} ${t.deadlocks === 1 ? 'time' : 'times'}`;
  return [candidate('deadlocks', null, unresolved ? 'critical' : 'warning', 1 - 1 / (1 + t.deadlocks),
    `Vehicles blocked each other in a deadlock ${times}.`,
    unresolved
      ? `Vehicles waited on each other in a circle${where} and the jam was left standing, so those vehicles never moved again.`
      : `Vehicles waited on each other in a circle${where}. The simulation moved one vehicle out of the way each time; in a real plant someone would have to intervene.`,
    `Break the circle${where}: make the narrow aisle one-way, add a passing bay, or reduce the number of vehicles that use it at the same time.`,
    cells.length ? { cells: cells.map((c) => [c.cx, c.cy]) } : {})];
}

// ---- rules: whole plant ----------------------------------------------------------------------------------------

function noOutput(ctx) {
  if (ctx.report.throughput?.total > 0) return [];
  return [candidate('no-output', null, 'warning', 1,
    `No load has left the plant in ${formatDuration(ctx.duration)}.`,
    'Either the cycle times are longer than the time simulated so far, or loads are stuck somewhere on the way to a sink.',
    'Open the Checks tab: look for stations without a road next to them, flows without a route and missing vehicles. If the cycle times are long, simulate longer.')];
}

function goodNews(ctx) {
  const t = ctx.report.throughput || {};
  const lead = ctx.report.leadTime || {};
  const used = ctx.fleets.filter((f) => f.count > 0);
  const parts = [
    `Over ${formatDuration(ctx.duration)} the plant delivered ${formatNumber(t.perHour || 0)} loads per hour`
      + (lead.mean != null ? ` with a mean lead time of ${formatDuration(lead.mean)}.` : '.'),
    used.length ? `Vehicles were busy ${pct(sum(used.map((f) => f.utilization)) / used.length)} of the time on average and lost ${pct(ctx.traffic.waitShare || 0)} of their driving time waiting.` : '',
  ].filter(Boolean).join(' ');
  return candidate('good', null, 'good', 0,
    'No bottlenecks, congestion or deadlocks found.', parts,
    'Test the headroom: raise the demand factor to 1.2 in the Simulate tab and see which station saturates first.');
}

const RULES = [
  bottlenecks, blockedWorkstations, starvedWorkstations, bufferProblems, supplyExceedsCapacity, stationBreakdowns,
  saturatedFleets, oversizedFleets, emptyDriving, unplacedVehicles, batteryProblems, vehicleBreakdowns, trafficCongestion, deadlocks,
  noOutput, fleetsWithoutJobs, unusedFleets, idleVehicles, unconnectedSources, neverUsedStations, dockBottlenecks, dockIdleVehicles, docksUnbalanced,
];

function notEnoughData(report) {
  const seconds = report && report.window && Number.isFinite(report.window.duration) ? report.window.duration : 0;
  const warming = Boolean(report && report.window && report.window.warmingUp);
  return {
    id: 'not-enough-data',
    severity: 'info',
    title: 'Not enough data yet',
    detail: warming
      ? 'The simulation is still in its warm-up period. The plant starts empty, so its first minutes would give a misleading picture and are not counted.'
      : `Only ${formatDuration(seconds)} of simulated time have been measured. Queues and shares of such a short run are not reliable.`,
    suggestion: warming
      ? `Let the simulation run until the warm-up is over and for at least ${formatDuration(MIN_DATA_SECONDS)} after it, then look at the insights again.`
      : `Let the simulation run for at least ${formatDuration(MIN_DATA_SECONDS)} of measured time, then look at the insights again.`,
    refs: {},
  };
}

/**
 * Analyse a KPI report and return findings for the planner, most important first.
 * @param {object} report KpiReport from Stats#report (docs/ARCHITECTURE.md section 5.4)
 * @param {object} layout the layout the report was produced from (names, capacities, flows, grid size)
 * @returns {Array<{ id: string, severity: 'critical'|'warning'|'info'|'good', title: string, detail: string,
 *   suggestion?: string, refs: { stationIds?: string[], fleetIds?: string[], flowIds?: string[], cells?: number[][] } }>}
 */
export function generateInsights(report, layout) {
  const window = report && report.window;
  if (!window || window.warmingUp || !(window.duration >= MIN_DATA_SECONDS)) return [notEnoughData(report)];
  const ctx = buildContext(report, layout);
  const found = RULES.flatMap((rule) => rule(ctx));
  if (!found.some((c) => c.insight.severity === 'critical' || c.insight.severity === 'warning')) found.push(goodNews(ctx));
  found.sort((a, b) =>
    SEVERITY_RANK[a.insight.severity] - SEVERITY_RANK[b.insight.severity]
    || b.magnitude - a.magnitude
    || (a.insight.id < b.insight.id ? -1 : a.insight.id > b.insight.id ? 1 : 0));
  return found.map((c) => c.insight);
}
