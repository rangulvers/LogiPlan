// Insights - turns a KpiReport into plain-language findings for the planner (docs/ARCHITECTURE.md section 5.4).
//
// Each rule looks at one aspect of the report (a workstation, a fleet, the traffic, ...) and may produce
// insights with a stable id (`rule` or `rule:ref`), a severity, a title that quotes the numbers, a longer
// detail, one concrete suggestion and refs the UI can select or zoom to. All thresholds are named constants
// below, so what counts as "busy" or "congested" is visible in one place and easy to tune.
//
// Ordering is deterministic: severity (critical, warning, info, good), then magnitude (the headline metric of
// the rule on a 0..1 scale, larger first; a deadlock count n maps to 1 - 1/(1 + n)), then id. A 'good' insight is added only when no
// critical or warning insight fired. With less than MIN_DATA_SECONDS of measured time the only result is a
// single info insight, because shares and queues of a few minutes are not meaningful.
//
// Additions beyond the rules named in the spec: `blocked` (a workstation that cannot get rid of its output)
// and `no-output` (nothing left the plant at all), so a stuck plant is never reported as 'good'.

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
export const FLEET_TRAFFIC_SHARE_OF_BUSY = 0.25; // waiting / working above this: fix traffic before adding vehicles

// Traffic.
export const TRAFFIC_WAIT_SHARE = 0.12;
export const TRAFFIC_CRITICAL_WAIT_SHARE = 0.25;
export const TRAFFIC_HOTSPOT_CELLS = 3;

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
export const EMPTY_DRIVING_SHARE = 0.6;
export const EMPTY_DRIVING_MIN_TRIPS = 5;
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
    const outgoing = ctx.flowsFrom.get(s.id) || [];
    const backlogged = outgoing
      .map((f) => ({ flow: f, backlog: ctx.flows[f.id]?.backlog || 0 }))
      .sort((a, b) => b.backlog - a.backlog)[0];
    const refs = { stationIds: [s.id] };
    let suggestion;
    if (backlogged && backlogged.backlog >= 1) {
      suggestion = `${plural(backlogged.backlog, 'load is', 'loads are')} waiting at ${s.name} for a vehicle: add a vehicle or raise the priority of the flow ${s.name} to ${ctx.name(backlogged.flow.to)}.`;
      refs.flowIds = [backlogged.flow.id];
    } else if (backlogged) {
      suggestion = `${ctx.name(backlogged.flow.to)} cannot take the loads fast enough: enlarge its input buffer or speed up the work there.`;
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
    const waiting = (ctx.flowsTo.get(s.id) || [])
      .map((f) => ({ flow: f, backlog: ctx.flows[f.id]?.backlog || 0 }))
      .sort((a, b) => b.backlog - a.backlog)[0];
    const supplier = (ctx.flowsTo.get(s.id) || []).map((f) => ctx.byId.get(f.from)).find((u) => u && u.type === 'source');
    const refs = { stationIds: [s.id] };
    let suggestion;
    if (bottleneck) {
      suggestion = `Fix ${bottleneck.name} first (${loadText(bottleneck)}): ${s.name} can only work as fast as it is fed.`;
      refs.stationIds.push(bottleneck.id);
    } else if (waiting && waiting.backlog >= 1) {
      suggestion = `${plural(waiting.backlog, 'load is', 'loads are')} ready at ${ctx.name(waiting.flow.from)} but not yet moved: add a vehicle or raise the priority of the flow ${ctx.name(waiting.flow.from)} to ${s.name}.`;
      refs.flowIds = [waiting.flow.id];
    } else if (supplier) {
      suggestion = `${supplier.name} delivers too slowly: shorten its arrival interval or raise the demand factor in the Simulate tab.`;
    } else {
      suggestion = `Check the supply into ${s.name}: its suppliers produce or deliver less often than it could work.`;
    }
    const severity = s.starved >= STARVED_WARNING_SHARE && !bottleneck ? 'warning' : 'info';
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
      `Raise the capacity of ${s.name} ${raise}, or take loads out faster by adding vehicles or raising the priority of the flow leaving it.`,
      { stationIds: [s.id] }));
  }
  return out;
}

function supplyExceedsCapacity(ctx) {
  const out = [];
  for (const s of ctx.stations) {
    if (s.type !== 'source' || !(s.blocked >= SUPPLY_BLOCKED_SHARE && s.yardNow >= SUPPLY_MIN_YARD)) continue;
    const next = (ctx.flowsFrom.get(s.id) || []).map((f) => ctx.byId.get(f.to)).filter(Boolean)
      .sort((a, b) => Math.max(b.utilization, b.avgFill) - Math.max(a.utilization, a.avgFill))[0];
    const backlog = sum((ctx.flowsFrom.get(s.id) || []).map((f) => ctx.flows[f.id]?.backlog || 0));
    let suggestion;
    if (next && next.type === 'process' && saturation(next) >= BOTTLENECK_UTILIZATION) {
      suggestion = `Add capacity at ${next.name} (${loadText(next)}): ${s.name} delivers faster than the line can take.`;
    } else if (backlog >= 1) {
      suggestion = `Add a vehicle or raise the flow priority: ${plural(backlog, 'load is', 'loads are')} ready at ${s.name} but not yet moved.`;
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
    if (!(f.count >= 1)) continue;
    const longWait = f.avgPickupWait != null && f.avgPickupWait >= FLEET_PICKUP_WAIT;
    const busy = f.utilization >= FLEET_SATURATED_UTILIZATION;
    if (!busy && !(longWait && f.utilization >= FLEET_PICKUP_WAIT_MIN_UTILIZATION)) continue;

    const trafficShare = f.utilization > 0 ? (f.shares?.waiting || 0) / f.utilization : 0;
    const extra = Math.max(1, Math.ceil((f.count * f.utilization) / FLEET_TARGET_UTILIZATION) - f.count);
    const spot = hotspotCells(ctx, 1)[0];
    const suggestion = trafficShare >= FLEET_TRAFFIC_SHARE_OF_BUSY
      ? `A lot of the busy time is spent waiting in traffic (${pct(f.shares.waiting)} of the fleet's time): relieve the congestion${spot ? ` around ${cellText(spot)}` : ''} before buying more vehicles.`
      : `Add ${plural(extra, 'vehicle', 'vehicles')} to the ${f.name} fleet (now ${f.count}): at the current workload that brings utilization down to about ${pct((f.utilization * f.count) / (f.count + extra))}. Faster vehicles or shorter routes help too.`;
    out.push(candidate('fleet-saturated', f.id, f.utilization >= FLEET_CRITICAL_UTILIZATION ? 'critical' : 'warning', f.utilization,
      `${f.name} fleet is saturated: its ${plural(f.count, 'vehicle is', 'vehicles are')} busy ${pct(f.utilization)} of the time${longWait ? `, and loads wait ${formatDuration(f.avgPickupWait)} for a pickup` : ''}.`,
      `Over ${formatDuration(ctx.duration)}, a ${f.name} vehicle spent ${pct(f.shares?.driving || 0)} of its time driving, ${pct(f.shares?.waiting || 0)} waiting in traffic and ${pct((f.shares?.loading || 0) + (f.shares?.unloading || 0))} loading or unloading, and made ${amount(f.tripsPerVehicleHour)} trips per hour.${f.avgPickupWait != null ? ` Loads waited ${formatDuration(f.avgPickupWait)} for pickup on average.` : ''}`,
      suggestion, { fleetIds: [f.id] }));
  }
  return out;
}

function oversizedFleets(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    if (!(f.count >= 2 && f.utilization < FLEET_OVERSIZED_UTILIZATION)) continue;
    const fewer = Math.max(1, Math.ceil((f.count * f.utilization) / FLEET_TARGET_UTILIZATION));
    const suggestion = f.utilization < FLEET_UNUSED_UTILIZATION
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
    if (!(f.emptyShare > EMPTY_DRIVING_SHARE && f.trips >= EMPTY_DRIVING_MIN_TRIPS)) continue;
    const suggestion = dispatch === 'oldest'
      ? 'Switch the dispatch strategy from "Oldest job first" to "Nearest job first" in the Simulate tab so vehicles pick up close to where they just delivered.'
      : 'Let vehicles carry more per trip (higher batch minimum or larger vehicles) or place pickup and drop stations so a vehicle can return with a load.';
    out.push(candidate('empty-driving', f.id, 'info', f.emptyShare,
      `${f.name} vehicles drive empty ${pct(f.emptyShare)} of the distance.`,
      `Of ${formatDistance(f.distance)} driven by the fleet, ${formatDistance(f.distance * f.emptyShare)} were without a load, over ${formatNumber(f.trips)} trips.`,
      suggestion, { fleetIds: [f.id] }));
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

function vehicleBreakdowns(ctx) {
  const out = [];
  for (const f of ctx.fleets) {
    const broken = f.shares?.broken || 0;
    if (!(broken >= VEHICLE_BROKEN_SHARE)) continue;
    out.push(candidate('breakdowns', f.id, broken >= BREAKDOWN_WARNING_SHARE ? 'warning' : 'info', broken,
      `${f.name} vehicles are broken down ${pct(broken)} of the time.`,
      `A broken vehicle blocks its lane until it is repaired${ctx.traffic.brokenWait > 0 ? `; other vehicles lost ${formatDuration(ctx.traffic.brokenWait)} in total waiting behind broken ones` : ''}.`,
      `Add a spare vehicle to the fleet (now ${f.count}) and give the busiest aisles a bypass so one breakdown does not stop the traffic behind it.`,
      { fleetIds: [f.id] }));
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
  saturatedFleets, oversizedFleets, emptyDriving, batteryProblems, vehicleBreakdowns, trafficCongestion, deadlocks, noOutput,
];

function notEnoughData(report) {
  const seconds = report && report.window && Number.isFinite(report.window.duration) ? report.window.duration : 0;
  const warming = report && report.window && report.window.warmingUp;
  return {
    id: 'not-enough-data',
    severity: 'info',
    title: 'Not enough data yet',
    detail: `Only ${formatDuration(seconds)} of simulated time have been measured${warming ? ' (the warm-up period is not counted)' : ''}. Queues and shares of such a short run are not reliable.`,
    suggestion: `Let the simulation run for at least ${formatDuration(MIN_DATA_SECONDS)} of measured time, then look at the insights again.`,
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
  if (!report || !report.window || !(report.window.duration >= MIN_DATA_SECONDS)) return [notEnoughData(report)];
  const ctx = buildContext(report, layout);
  const found = RULES.flatMap((rule) => rule(ctx));
  if (!found.some((c) => c.insight.severity === 'critical' || c.insight.severity === 'warning')) found.push(goodNews(ctx));
  found.sort((a, b) =>
    SEVERITY_RANK[a.insight.severity] - SEVERITY_RANK[b.insight.severity]
    || b.magnitude - a.magnitude
    || (a.insight.id < b.insight.id ? -1 : a.insight.id > b.insight.id ? 1 : 0));
  return found.map((c) => c.insight);
}
