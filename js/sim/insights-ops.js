// Insight rules of the warehouse module (docs/WAREHOUSE-DESIGN.md 6.9 and Appendix B), registered in EXTENSION_RULES of insights.js and run
// after the built-in rules. Same shape as those: a rule is (ctx) => candidate[], thresholds are named constants at the top, a candidate carries
// the magnitude that orders insights of one severity. A rule looks for its own section of the report (`report.ops.trucks`) and returns [] when
// the layout has no trucks, so a legacy report gets no new insight.
//
// STATE (milestone M1), per Goods in / Goods out that has trucks:
//   gate-queue-long            warning from a mean gate wait of 15 min, critical from 45 min: the symptom, with the likely cause in its advice
//   doors-bottleneck           warning: the doors are busy 85 % of the time or more and trucks wait 5 min or more, and the cause is not the
//                              vehicles (that is unload-limited-by-vehicles) nor, on a Goods out, the supply (outbound-short)
//   unload-limited-by-vehicles warning: the doors are busy or trucks queue, and pallets cannot be taken away fast enough (the Goods in is blocked,
//                              staging full, 25 % of the time or more, or pallets wait long for a vehicle): "the doors are not the problem, the
//                              forklifts are" - said only when the vehicles really are the limit
//   doors-idle                 info: two doors or more, busy less than 30 % of the time, trucks hardly wait
//   outbound-short             warning: 10 % of the trucks or more left a Goods out without a full load
//
// They never contradict an older rule. The advice about vehicles comes from the SAME verdict as the built-in rules (ctx.transport = transportState
// of insights.js: vehicles saturated, traffic congested, room at the destination, vehicles with time to spare), and a station whose docks are the
// narrow point (the built-in dock-bottleneck) is told to look there before it is told to add forklifts or doors. A warning from these rules suppresses
// the 'good' insight like any other warning; none of them is ever 'good'.
//
// The constants marked (insights.js) repeat a threshold of the built-in rules on purpose: this file imports nothing from insights.js (insights.js
// imports it), and tests/sim.trucks.insights.test.js asserts that the copies are equal.

import { DOOR_TARGET_UTILISATION } from '../model/doors.js';
import { formatDuration, formatNumber, formatPercent } from '../util/format.js';

/** Trucks needed in the window before a rule speaks: a mean of one or two trucks is noise. */
export const MIN_TRUCKS = 3;

export const GATE_WAIT_WARNING = 15 * 60; // s of mean gate wait
export const GATE_WAIT_CRITICAL = 45 * 60;
export const DOORS_BUSY_SHARE = 0.85; // doors-bottleneck, the same 85 % the door check aims for (DOOR_TARGET_UTILISATION)
export const DOORS_GATE_WAIT = 5 * 60; // s
export const UNLOAD_BLOCKED_SHARE = 0.25; // the Goods in could not hand over pallets (staging full) this much of the time ...
export const UNLOAD_PICKUP_WAIT = 120; // ... or pallets waited this long for a vehicle (insights.js FLEET_PICKUP_WAIT)
export const DOORS_IDLE_SHARE = 0.3;
export const DOORS_IDLE_GATE_WAIT = 60; // s
export const DOORS_IDLE_MIN_DOORS = 2;
export const OUTBOUND_SHORT_SHARE = 0.1;
// the dock queue of the built-in dock-bottleneck (insights.js DOCK_BUSY_SHARE, DOCK_WAIT_PER_VISIT, DOCK_MIN_VISITS)
export const DOCK_BUSY_SHARE = 0.6;
export const DOCK_WAIT_PER_VISIT = 8;
export const DOCK_MIN_VISITS = 10;

const pct = (x) => formatPercent(x);
const amount = (x) => formatNumber(x, x < 10 ? 1 : 0);
const count = (n, one, many) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const sum = (list) => list.reduce((a, b) => a + b, 0);

/** Candidate = an insight plus the magnitude used to order insights of equal severity (the same shape as in insights.js). */
function candidate(rule, ref, severity, magnitude, title, detail, suggestion, refs) {
  const insight = { id: ref == null ? rule : `${rule}:${ref}`, severity, title, detail };
  if (suggestion) insight.suggestion = suggestion;
  insight.refs = refs || {};
  return { magnitude: Number.isFinite(magnitude) ? Math.min(1, Math.max(0, magnitude)) : 0, insight };
}

// ---- one analysis per truck station, shared by the rules --------------------------------------------------------------

const memo = new WeakMap();

/**
 * Mean time a truck waited at the gate: the mean of those that docked, or - when trucks are still waiting - Little's law (mean queue x window /
 * trucks that arrived), whichever is larger, so that a queue that only grows is not hidden by the few trucks that did get a door.
 */
function gateWaitOf(t, duration) {
  const docked = t.gateWait.mean === null ? 0 : t.gateWait.mean;
  const little = t.trucks.arrived > 0 && duration > 0 ? (t.gateQueue.mean * duration) / t.trucks.arrived : 0;
  return Math.max(docked, little);
}

/** Mean wait of a pallet for a vehicle on the flows that leave a station (trips-weighted), or null when none was carried. */
function pickupWaitOf(ctx, id) {
  let trips = 0;
  let total = 0;
  for (const flow of ctx.flowsFrom.get(id) || []) {
    const r = ctx.flows[flow.id];
    if (r && r.trips > 0 && r.avgPickupWait != null) {
      trips += r.trips;
      total += r.avgPickupWait * r.trips;
    }
  }
  return trips > 0 ? total / trips : null;
}

/** Vehicles queue for the docks of the station itself (the condition of the built-in dock-bottleneck). */
function dockQueue(s) {
  const docks = s.docks || [];
  if (docks.length === 0) return false;
  const visits = sum(docks.map((d) => d.visits));
  const busy = sum(docks.map((d) => d.busyShare)) / docks.length;
  return visits >= DOCK_MIN_VISITS && busy >= DOCK_BUSY_SHARE && (s.dockWaitTotal || 0) >= DOCK_WAIT_PER_VISIT * visits;
}

/**
 * What stops the vehicles that serve the flows of a station, by the verdict of the built-in rules (ctx.transport): 'docks' (they queue for the
 * station's own docks), 'traffic', 'vehicles' (every fleet that may serve the flow is saturated), 'destination' (no room downstream), 'free' (the
 * vehicles have time to spare) or 'none' (no vehicle may serve the flow / no flow). The first verdict that is not 'free' wins, in the order of the list.
 */
function transportCause(ctx, flows, s) {
  if (s && dockQueue(s)) return 'docks';
  if (!flows.length) return 'none';
  if (typeof ctx.transport !== 'function') return 'free';
  const verdicts = flows.map((flow) => ctx.transport(flow));
  for (const v of ['none', 'traffic', 'vehicles', 'destination']) if (verdicts.includes(v)) return v;
  return 'free';
}

/** The truck stations of the report with the numbers every rule needs. */
function analyses(ctx) {
  const known = memo.get(ctx);
  if (known) return known;
  const trucks = (ctx.report.ops && ctx.report.ops.trucks) || {};
  const list = [];
  for (const [id, t] of Object.entries(trucks)) {
    const s = ctx.byId.get(id) || {};
    const def = ctx.stationDefs.get(id) || {};
    const cfg = (def.ops && def.ops.trucks) || {};
    const wait = gateWaitOf(t, ctx.duration);
    const departed = t.trucks.departed;
    const a = {
      id, t, s, cfg, name: t.name || id, role: t.role, doors: t.doors, wait,
      util: t.doorUtilization, enough: t.trucks.arrived >= MIN_TRUCKS,
      shortShare: departed > 0 ? t.trucks.short / departed : 0,
      pickup: t.role === 'in' ? pickupWaitOf(ctx, id) : null,
      cause: null, unload: null,
    };
    if (t.role === 'in') {
      a.cause = transportCause(ctx, ctx.flowsFrom.get(id) || [], s);
      const evidence = (s.blocked >= UNLOAD_BLOCKED_SHARE) || (a.pickup !== null && a.pickup >= UNLOAD_PICKUP_WAIT);
      const symptom = a.util >= DOORS_BUSY_SHARE || wait >= DOORS_GATE_WAIT;
      a.unload = evidence && symptom && ['docks', 'traffic', 'vehicles'].includes(a.cause) ? a.cause : null;
      a.evidence = evidence;
    } else {
      a.cause = transportCause(ctx, ctx.flowsTo.get(id) || [], null);
    }
    list.push(a);
  }
  memo.set(ctx, list);
  return list;
}

/** Doors that would carry the same trucks at the target utilisation, at least one more than now when `more` is set. */
function doorsFor(a, more) {
  const needed = a.util * a.doors;
  let k = Math.max(1, Math.ceil(needed / DOOR_TARGET_UTILISATION - 1e-9));
  if (more && k <= a.doors) k = a.doors + 1;
  return { k, needed, util: needed / k };
}

const refsOf = (a) => ({ stationIds: [a.id] });

/** The advice on vehicles that fits the verdict, in the words of the built-in transport advice. */
function vehicleAdvice(a) {
  switch (a.cause) {
    case 'docks': return `Vehicles queue for the docks of ${a.name}: give it another dock (any road cell touching the station) before adding forklifts or doors.`;
    case 'traffic': return 'Congestion holds the vehicles up: relieve the traffic before adding vehicles.';
    case 'vehicles': return 'Add a forklift (every vehicle that may serve the flow is busy), or shorten the load and unload time of the vehicles.';
    default: return 'Check what holds the pallets back: the room downstream, the minimum batch of the flow, and that the vehicles can reach both docks.';
  }
}

// ---- rules ------------------------------------------------------------------------------------------------------

/** Trucks wait at the gate. The symptom; the advice depends on the cause. */
export function gateQueueLong(ctx) {
  const out = [];
  for (const a of analyses(ctx)) {
    if (!a.enough || !(a.wait >= GATE_WAIT_WARNING)) continue;
    const cause = a.unload ? `Pallets wait ${a.pickup !== null ? `${formatDuration(a.pickup)} ` : ''}for a vehicle, so a truck holds its door long.` : `Every truck holds a door for ${a.t.doorTime.mean === null ? 'a long time' : formatDuration(a.t.doorTime.mean)} (check-in, unloading, check-out).`;
    let suggestion;
    if (a.role === 'out') suggestion = a.shortShare >= OUTBOUND_SHORT_SHARE ? 'Trucks wait for pallets that arrive too slowly: see the finding about trucks that leave short.' : `Open another door, or shorten the time a truck waits for its pallets (${a.cfg.maxDwell ? formatDuration(a.cfg.maxDwell) : 'until full'}).`;
    else if (a.unload) suggestion = vehicleAdvice(a);
    else {
      const d = doorsFor(a, true);
      suggestion = `Open another door: ${d.k} doors would be busy about ${pct(d.util)} of the time.`;
    }
    out.push(candidate('gate-queue-long', a.id, a.wait >= GATE_WAIT_CRITICAL ? 'critical' : 'warning', a.wait / GATE_WAIT_CRITICAL,
      `Trucks wait ${formatDuration(a.wait)} at the gate of ${a.name} on average.`,
      `${a.name} has ${count(a.doors, 'door', 'doors')}, busy ${pct(a.util)} of that time, and ${count(a.t.gateQueue.max, 'truck', 'trucks')} stood at the gate at the worst moment. ${cause}`,
      suggestion, refsOf(a)));
  }
  return out;
}

/** The doors themselves are the limit. */
export function doorsBottleneck(ctx) {
  const out = [];
  for (const a of analyses(ctx)) {
    if (!a.enough || !(a.util >= DOORS_BUSY_SHARE && a.wait >= DOORS_GATE_WAIT)) continue;
    if (a.unload) continue; // the vehicles are the limit: unload-limited-by-vehicles says so
    if (a.role === 'out' && a.shortShare >= OUTBOUND_SHORT_SHARE) continue; // the trucks wait for pallets: outbound-short says so
    if (a.role === 'in' && a.evidence && a.cause !== 'free') continue; // pallets are held back for a reason the older rules name (room downstream, no vehicle ...)
    const d = doorsFor(a, true);
    // On a Goods out most of the door time can be the wait for pallets: trucks that arrive faster than the plant ships fill one after the other, and a second
    // door only moves the wait from the gate to the door. The report cannot tell (it has no pallets-planned rate), so the advice says what to look at.
    const supplyHint = a.role === 'out' ? ' If the trucks mostly wait for their pallets and not for check-in, more doors only move the wait from the gate to the door: look at what feeds it.' : '';
    out.push(candidate('doors-bottleneck', a.id, 'warning', a.util,
      `The doors of ${a.name} are the bottleneck: busy ${pct(a.util)} of the time while trucks wait ${formatDuration(a.wait)}.`,
      `${a.name} has ${count(a.doors, 'door', 'doors')}. A truck holds a door for ${a.t.doorTime.mean === null ? 'a long time' : formatDuration(a.t.doorTime.mean)} on average (check-in ${formatDuration(a.cfg.checkIn ?? 0)}, check-out ${formatDuration(a.cfg.checkOut ?? 0)} included), so the trucks arrive faster than the doors can serve them.`,
      `Open another door: ${d.k} doors would be busy about ${pct(d.util)} of the time. Shorter check-in and check-out times help in the same way.${supplyHint}`,
      refsOf(a)));
  }
  return out;
}

/** The doors are not the problem: pallets are taken away too slowly. */
export function unloadLimitedByVehicles(ctx) {
  const out = [];
  for (const a of analyses(ctx)) {
    if (!a.enough || a.role !== 'in' || !a.unload) continue;
    const blocked = a.s.blocked >= UNLOAD_BLOCKED_SHARE ? ` and ${a.name} could not hand over pallets (staging full) ${pct(a.s.blocked)} of the time` : '';
    const waited = a.pickup !== null ? `Pallets waited ${formatDuration(a.pickup)} for a vehicle on average${blocked}.` : `${blocked.replace(/^ and /, '')}.`;
    out.push(candidate('unload-limited-by-vehicles', a.id, 'warning', Math.max(a.util, a.s.blocked || 0),
      `The doors of ${a.name} are not the problem, the vehicles are: pallets are taken away too slowly.`,
      `${a.name} has ${count(a.doors, 'door', 'doors')}, busy ${pct(a.util)} of the time, and trucks wait ${formatDuration(a.wait)} at the gate. The time a truck holds its door is the time the vehicles need to take its pallets away. ${waited}`,
      `${vehicleAdvice(a)} More doors would only let more trucks wait inside.`,
      refsOf(a)));
  }
  return out;
}

/** More doors than the trucks need. */
export function doorsIdle(ctx) {
  const out = [];
  for (const a of analyses(ctx)) {
    if (!a.enough || a.doors < DOORS_IDLE_MIN_DOORS || !(a.util < DOORS_IDLE_SHARE) || !(a.wait < DOORS_IDLE_GATE_WAIT)) continue;
    const d = doorsFor(a, false);
    if (d.k >= a.doors) continue;
    out.push(candidate('doors-idle', a.id, 'info', 1 - a.util,
      `${a.name} has ${count(a.doors, 'door', 'doors')}, but they are busy only ${pct(a.util)} of the time.`,
      `Trucks hardly wait (${formatDuration(a.wait)} at the gate on average), so the doors have time to spare.`,
      `${count(d.k, 'door', 'doors')} would carry the same trucks, busy about ${pct(d.util)} of the time. Keep the extra doors if peaks are expected.`,
      refsOf(a)));
  }
  return out;
}

/** Trucks leave a Goods out without a full load. */
export function outboundShort(ctx) {
  const out = [];
  for (const a of analyses(ctx)) {
    if (a.role !== 'out' || a.t.trucks.departed < MIN_TRUCKS || !(a.shortShare >= OUTBOUND_SHORT_SHARE)) continue;
    let suggestion;
    switch (a.cause) {
      case 'none': suggestion = `Nothing brings pallets to ${a.name}: draw a flow into it and give a fleet the job.`; break;
      case 'traffic': suggestion = 'Congestion holds the vehicles up: relieve the traffic before adding vehicles.'; break;
      case 'vehicles': suggestion = 'Every vehicle that may serve the flow into it is busy: add a vehicle, or raise the priority of that flow.'; break;
      default: suggestion = `The vehicles have time to spare, so pallets reach ${a.name} too slowly from upstream: check what feeds it (production, the storage it takes from) or let trucks wait longer than ${a.cfg.maxDwell ? formatDuration(a.cfg.maxDwell) : 'they do'}.`;
    }
    out.push(candidate('outbound-short', a.id, 'warning', a.shortShare,
      `${amount(a.t.trucks.short)} of ${amount(a.t.trucks.departed)} trucks left ${a.name} without a full load.`,
      `They waited ${a.cfg.maxDwell ? `the full ${formatDuration(a.cfg.maxDwell)}` : 'for pallets'}; over all trucks ${pct(a.t.fillRate === null ? 0 : a.t.fillRate)} of the planned pallets were loaded. Pallets reached the doors too slowly: look at the vehicles that serve the flow into ${a.name}.`,
      suggestion, refsOf(a)));
  }
  return out;
}

/** The rules of this file, in the order they are registered in EXTENSION_RULES. */
export const OPS_INSIGHT_RULES = Object.freeze([gateQueueLong, doorsBottleneck, unloadLimitedByVehicles, doorsIdle, outboundShort]);
