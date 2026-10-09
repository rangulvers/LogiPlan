// Guidance (docs/ARCHITECTURE.md 6.9): the brain behind the coaching surfaces - the Next steps card, the canvas guide chip, the
// Getting started checklist and the Fix buttons of the Checks tab. No DOM in here: everything takes a layout (or the shared ctx)
// and returns plain data, so it runs and is tested in Node.
//
// The model this teaches. Vehicles are NOT assigned to stations. A flow says where loads go; every free vehicle automatically
// serves every flow (strategy in Simulate: nearest / oldest / balanced; a flow can be restricted to one fleet). So a second
// Goods in needs a flow of its own, and the same vehicles then serve it. A station must also touch a road (its dock) to be served.
//
//   computeNextSteps(layout, { issues, simRunning, simulatedSeconds, hasRun, resultsSeen, dismissed }) -> NextStep[]
//   NextStep = { id, severity: 'todo'|'warn'|'info', scopes, icon, title, text, refs, fix, alt?, dismissible }   (alt: a second way out)
//   fix      = { type: 'connect-flow', fromId, toId, pick: 'to'|'from', label }   one flow (the planner may pick the other end)
//            | { type: 'add-fleet', preset, count, fleetId?, label }              add a fleet, or raise the count of fleetId
//            | { type: 'set-tool', tool, label } | { type: 'focus', refs, hint?, label }
//            | { type: 'run', label } | { type: 'set-tab', tab, label } | { type: 'release-flow', flowId, label }   (any fleet may carry it)
//            | { type: 'add-doors', stationId, label } | { type: 'update-station' | 'extend-docks', ... }   trucks and dock doors (js/ui/guidance-ops.js, model/validate-ops.js)
//   computeChecklist(layout, { ran, resultsSeen }) -> { items, done, total, complete }
//   validDestinations / validOrigins (station objects, closest first), suggestDestination / suggestOrigin (a station or null),
//   connectFixFor(layout, stationId) (the ready-made "connect to the suggestion" fix), fixForIssue(layout, issue), applyFix(ctx, fix)
//   guidanceFor(ctx) -> shared per-app state (dismissals, session progress) and a memoised read(state) for every surface.
//
// Step ids are stable (kind + station/flow/fleet id), so a dismissal survives edits and reloads (localStorage
// 'logiplan:guidance-dismissed', guarded by try/catch; in memory when storage is missing).

import { FLEET_PRESETS, DISPATCH_STRATEGIES } from '../model/defaults.js';
import { flowCreatedText } from './editor/connect.js';
import { validateLayout } from '../model/validate.js';
import { getStation, getFleet, docksOf, flowsFrom, flowsTo, addFlow, addFleet, updateFleet, updateFlow } from '../model/layout.js';
import { addDockDoors, addDoorsSteps, applyOpsStoreFix, opsFixForIssue } from './guidance-ops.js';

/** Station types that may send loads / receive loads (docs/ARCHITECTURE.md 4.3). */
export const SENDER_TYPES = Object.freeze(['source', 'process', 'storage']);
export const RECEIVER_TYPES = Object.freeze(['process', 'storage', 'sink']);

/** The fleet "Add vehicles" creates. */
export const DEFAULT_FLEET = Object.freeze({ preset: 'agv', count: 2 });
/** Simulated seconds of measured time (after the warm-up) after which "Open Results" is suggested: the dashboard has its insights by then. */
export const RESULTS_AFTER_SECONDS = 300;
/** Simulated time at which the Results tab has something to say: the warm-up (not counted) plus RESULTS_AFTER_SECONDS. */
export const resultsAfter = (layout) => (Number(layout?.settings?.warmup) || 0) + RESULTS_AFTER_SECONDS;
export const DISMISS_KEY = 'logiplan:guidance-dismissed';
const MAX_DISMISSED = 300;

const TYPE_NAMES = { source: 'Goods in', process: 'Workstation', storage: 'Storage', sink: 'Goods out', depot: 'Depot' };
/** Planner wording of a station type: "Goods in", "Workstation", "Storage", "Goods out", "Depot". */
export const typeName = (type) => TYPE_NAMES[type] || type;
/** "Assembly (Workstation)": how a station is named in a choice list. */
export const stationLabel = (station) => `${station.name} (${typeName(station.type)})`;

const STRATEGY_PHRASE = { nearest: 'the nearest job first', oldest: 'the oldest job first', balanced: 'a balance of distance and waiting time' };

// ---------------------------------------------------------------------------------------------------------
// Station geometry and flow graph helpers
// ---------------------------------------------------------------------------------------------------------

const compareIds = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/** Distance between the centres of two stations in grid cells (Manhattan: vehicles drive along a grid). */
function distance(a, b) {
  return Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) + Math.abs((a.y + a.h / 2) - (b.y + b.h / 2));
}

const nearestFirst = (origin) => (a, b) => distance(origin, a) - distance(origin, b) || compareIds(a.id, b.id);

/** Ids of the stations that lead into (`forward` false) or are reached from (`forward` true) station `id` through flows. */
function reach(layout, id, forward) {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const here = stack.pop();
    for (const flow of layout.flows) {
      const [a, b] = forward ? [flow.from, flow.to] : [flow.to, flow.from];
      if (a === here && !seen.has(b)) {
        seen.add(b);
        stack.push(b);
      }
    }
  }
  return seen;
}

/** `layout` with extra flows (shallow copy): lets suggestions build on each other without touching the layout. */
const withFlow = (layout, from, to) => ({ ...layout, flows: [...layout.flows, { id: `~${from}>${to}`, from, to }] });

// ---------------------------------------------------------------------------------------------------------
// Valid ends of a flow and suggestions
// ---------------------------------------------------------------------------------------------------------

/**
 * Stations a new flow from `stationId` may legally go to, closest first (ties by id). Empty when the station cannot send
 * loads (Goods out, depot). Flows that exist already are left out.
 * @returns {object[]} stations
 */
export function validDestinations(layout, stationId) {
  const from = getStation(layout, stationId);
  if (!from || !SENDER_TYPES.includes(from.type)) return [];
  const taken = new Set(flowsFrom(layout, stationId).map((f) => f.to));
  return layout.stations.filter((s) => s.id !== stationId && RECEIVER_TYPES.includes(s.type) && !taken.has(s.id)).sort(nearestFirst(from));
}

/**
 * Stations a new flow into `stationId` may legally come from, closest first (ties by id). Empty when the station cannot
 * receive loads (Goods in, depot). Flows that exist already are left out.
 */
export function validOrigins(layout, stationId) {
  const to = getStation(layout, stationId);
  if (!to || !RECEIVER_TYPES.includes(to.type)) return [];
  const taken = new Set(flowsTo(layout, stationId).map((f) => f.from));
  return layout.stations.filter((s) => s.id !== stationId && SENDER_TYPES.includes(s.type) && !taken.has(s.id)).sort(nearestFirst(to));
}

/** The first of `list` (already nearest first) whose type is preferred, in the order of `types`. */
function pickByType(list, types) {
  for (const type of types) {
    const hit = list.find((s) => s.type === type);
    if (hit) return hit;
  }
  return null;
}

/**
 * Where the loads of `stationId` most likely go next, or null when there is no sensible place.
 * Goods in: the nearest Storage, else the nearest Workstation, else a Goods out. Workstation: the nearest station further
 * downstream (Workstation, Storage or Goods out) that does not already lead into it, so no loop is suggested. Storage: the
 * nearest Workstation or Goods out, again not upstream. Never a flow that exists already.
 * @returns {object|null} station
 */
export function suggestDestination(layout, stationId) {
  const from = getStation(layout, stationId);
  if (!from) return null;
  const upstream = reach(layout, stationId, false);
  const options = validDestinations(layout, stationId).filter((s) => !upstream.has(s.id));
  if (from.type === 'source') return pickByType(options, ['storage', 'process', 'sink']);
  if (from.type === 'process') return options[0] || null;
  if (from.type === 'storage') return options.find((s) => s.type !== 'storage') || null;
  return null;
}

/**
 * The ready-made fix "send this station's loads to the suggested destination" (what the Connect button of a toast applies), or null
 * when nothing fits. Hand it to applyFix.
 */
export function connectFixFor(layout, stationId) {
  const to = suggestDestination(layout, stationId);
  return to ? { type: 'connect-flow', fromId: stationId, toId: to.id, pick: 'to', label: 'Connect' } : null;
}

const ORIGIN_PREFERENCE = { process: ['source', 'storage', 'process'], storage: ['source', 'process'], sink: ['process', 'storage', 'source'] };

/**
 * Which station most likely feeds `stationId`, or null: the mirror of suggestDestination. A Workstation or Storage is fed by the
 * nearest Goods in first, a Goods out by the nearest Workstation first; stations further downstream are never suggested.
 * @returns {object|null} station
 */
export function suggestOrigin(layout, stationId) {
  const to = getStation(layout, stationId);
  if (!to || !ORIGIN_PREFERENCE[to.type]) return null;
  const downstream = reach(layout, stationId, true);
  return pickByType(validOrigins(layout, stationId).filter((s) => !downstream.has(s.id)), ORIGIN_PREFERENCE[to.type]);
}

// ---------------------------------------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------------------------------------

/** Issue codes the steps below already cover, so "open Checks" does not repeat them. */
const COVERED_CODES = new Set([
  'no-roads', 'no-stations', 'no-flows', 'no-fleets', 'station-no-dock', 'station-dock-isolated', 'source-no-outflow', 'process-no-inflow',
  'sink-no-inflow', 'flow-unreachable', 'flow-no-return', 'flow-fleet-missing',
]);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const vehicleCount = (layout) => layout.fleets.reduce((sum, f) => sum + (f.count > 0 ? f.count : 0), 0);
const fleetNoun = (preset) => ((FLEET_PRESETS[preset] || FLEET_PRESETS.custom).label.split(' (')[0]);

function makeStep(id, severity, scopes, icon, title, text, fix, { refs = {}, dismissible = false, alt = null } = {}) {
  const step = { id, severity, scopes: [].concat(scopes), icon, title, text, refs, fix, dismissible };
  if (alt) step.alt = alt;
  return step;
}

/** What to do when a station has nowhere to send its loads: place something to receive them. */
function placeReceiverFix(station) {
  return station.type === 'source'
    ? { type: 'set-tool', tool: 'process', label: 'Workstation' }
    : { type: 'set-tool', tool: 'sink', label: 'Goods out' };
}

const CONNECT_OUT_TEXT = {
  source: 'Where should its loads go? Vehicles pick up from every connected Goods in automatically.',
  process: 'Where should its finished loads go?',
  storage: 'Where should the loads go when they leave the storage?',
};

/** The step for a station that sends no loads anywhere yet; `suggestion` is a station or null. */
function connectOutStep(station, suggestion) {
  const id = `connect-out:${station.id}`;
  const refs = { stationIds: [station.id] };
  const severity = station.type === 'source' ? 'warn' : 'todo';
  const dismissible = station.type === 'process'; // the last workstation may legitimately end the line
  if (!suggestion) {
    const what = station.type === 'source' ? 'a Workstation, Storage or Goods out' : 'a Goods out';
    return makeStep(id, severity, 'flows', 'flow', `${station.name} is not connected yet`,
      `Place ${what} next to the road for its loads to go to.`, placeReceiverFix(station), { refs, dismissible });
  }
  return makeStep(id, severity, 'flows', 'flow', `${station.name} is not connected yet`, CONNECT_OUT_TEXT[station.type],
    { type: 'connect-flow', fromId: station.id, toId: suggestion.id, pick: 'to', label: 'Connect' }, { refs, dismissible });
}

function connectInStep(station, suggestion) {
  return makeStep(`connect-in:${station.id}`, station.type === 'storage' ? 'todo' : 'warn', 'flows', 'flow', `Nothing feeds ${station.name} yet`,
    'Which station should send it loads?', { type: 'connect-flow', fromId: suggestion.id, toId: station.id, pick: 'from', label: 'Connect' }, { refs: { stationIds: [station.id] } });
}

/** The connection steps (stations that send nowhere, stations nothing reaches), each suggestion built on the ones before it. */
function connectionSteps(layout) {
  const steps = [];
  let working = layout;
  for (const s of layout.stations) {
    if (!SENDER_TYPES.includes(s.type) || flowsFrom(layout, s.id).length) continue;
    const suggestion = suggestDestination(working, s.id);
    steps.push(connectOutStep(s, suggestion));
    if (suggestion) working = withFlow(working, s.id, suggestion.id);
  }
  for (const s of layout.stations) {
    if (!RECEIVER_TYPES.includes(s.type) || flowsTo(working, s.id).length) continue;
    const suggestion = suggestOrigin(working, s.id);
    if (!suggestion) continue; // nothing could feed it yet: the steps above say what to place
    steps.push(connectInStep(s, suggestion));
    working = withFlow(working, suggestion.id, s.id);
  }
  return steps;
}

function dockSteps(layout, issues) {
  const steps = [];
  for (const s of layout.stations) {
    if (docksOf(layout, s.id).length) continue;
    steps.push(makeStep(`no-dock:${s.id}`, 'warn', 'plant', 'warning', `${s.name} does not touch a road`,
      'Vehicles cannot reach it. Drag it next to a road, or draw a road up to it.',
      { type: 'focus', refs: { stationIds: [s.id] }, hint: 'Select the station and drag it next to a road.', label: 'Show me' }, { refs: { stationIds: [s.id] } }));
  }
  const names = new Map(layout.stations.map((s) => [s.id, s.name]));
  for (const issue of issues) {
    if (issue.code !== 'station-dock-isolated' || !issue.refs?.stationId) continue;
    steps.push(makeStep(`dock-isolated:${issue.refs.stationId}`, 'warn', 'plant', 'warning', `The road at ${names.get(issue.refs.stationId) || 'a station'} is not joined to the rest`,
      'Draw the road on from that plate so it connects to the road network.',
      { type: 'focus', refs: { stationIds: [issue.refs.stationId], cells: issue.refs.cells }, label: 'Show me' }, { refs: { stationIds: [issue.refs.stationId] } }));
  }
  return steps;
}

function routeSteps(layout, issues) {
  const steps = [];
  const nameOf = (id) => getStation(layout, id)?.name || 'a station';
  for (const issue of issues) {
    const flow = issue.refs?.flowId ? layout.flows.find((f) => f.id === issue.refs.flowId) : null;
    if (!flow || (issue.code !== 'flow-unreachable' && issue.code !== 'flow-no-return')) continue;
    const refs = { flowIds: [flow.id] };
    const fix = { type: 'focus', refs, label: 'Show me' };
    if (issue.code === 'flow-unreachable') {
      steps.push(makeStep(`no-route:${flow.id}`, 'warn', 'flows', 'route', `No route from ${nameOf(flow.from)} to ${nameOf(flow.to)}`,
        'Vehicles cannot drive there. Look for a gap in the road or a one-way piece pointing the wrong way.', fix, { refs }));
    } else {
      steps.push(makeStep(`no-return:${flow.id}`, 'warn', 'flows', 'route', `Vehicles cannot get back from ${nameOf(flow.to)}`,
        'A one-way road or a dead end traps them. Add a return road so the route becomes a loop.', fix, { refs }));
    }
  }
  return steps;
}

/** A flow dedicated to a fleet without vehicles (or without a fleet): nothing will ever carry it. */
function carrierSteps(layout, issues) {
  const steps = [];
  for (const issue of issues) {
    const flow = issue.code === 'flow-fleet-missing' && issue.refs?.flowId ? layout.flows.find((f) => f.id === issue.refs.flowId) : null;
    if (!flow) continue;
    const name = `${getStation(layout, flow.from)?.name ?? 'a station'} → ${getStation(layout, flow.to)?.name ?? 'a station'}`;
    const fleet = getFleet(layout, flow.fleetId);
    const any = { type: 'release-flow', flowId: flow.id, label: 'Any fleet' };
    steps.push(fleet
      ? makeStep(`no-carrier:${flow.id}`, 'warn', ['flows', 'fleet'], 'truck', `Nothing carries ${name}`,
        `It is dedicated to ${fleet.name}, which has no vehicles. Add vehicles, or let any fleet carry this flow.`,
        { type: 'add-fleet', preset: fleet.preset, fleetId: fleet.id, count: DEFAULT_FLEET.count, label: `Add ${DEFAULT_FLEET.count} vehicles` },
        { refs: { flowIds: [flow.id], fleetIds: [fleet.id] }, alt: any })
      : makeStep(`no-carrier:${flow.id}`, 'warn', ['flows', 'fleet'], 'truck', `Nothing carries ${name}`,
        'It is dedicated to a fleet that no longer exists. Let any fleet carry this flow.', any, { refs: { flowIds: [flow.id] } }));
  }
  return steps;
}

function fleetStep(layout) {
  if (!layout.flows.length || vehicleCount(layout) > 0) return null;
  const empty = layout.fleets[0];
  if (empty) {
    return makeStep(`fleet-empty:${empty.id}`, 'todo', 'fleet', 'truck', `${empty.name} has no vehicles`,
      'Raise the vehicle count so the loads get moved. Every vehicle serves every flow.',
      { type: 'add-fleet', preset: empty.preset, fleetId: empty.id, count: DEFAULT_FLEET.count, label: `Add ${DEFAULT_FLEET.count} vehicles` }, { refs: { fleetIds: [empty.id] } });
  }
  return makeStep('no-fleet', 'todo', 'fleet', 'truck', 'Add vehicles to move the loads',
    'Vehicles carry the loads along your flows. Two AGVs are a good start; each free vehicle serves every flow automatically.',
    { type: 'add-fleet', ...DEFAULT_FLEET, label: 'Add vehicles' });
}

/**
 * The ordered list of things a planner should do next on this plant (see the header for the shape). Order is the order of work:
 * road, stations, docks, connections, routes, vehicles, run, results; notes (severity 'info') come last and never block.
 * @param {object} layout
 * @param {{ issues?: object[], simRunning?: boolean, simulatedSeconds?: number, hasRun?: boolean, resultsSeen?: boolean, dismissed?: { has(id: string): boolean } }} [opts]
 *   `issues`: validateLayout result (computed here when missing); `simulatedSeconds`: the longest simulated time seen, `hasRun`: the
 *   plant was run before (a restart on an edit does not make it "never run" again); `dismissed`: hides dismissed dismissible steps.
 * @returns {object[]} NextStep[]
 */
export function computeNextSteps(layout, opts = {}) {
  const { simRunning = false, simulatedSeconds = 0, hasRun = false, resultsSeen = false, dismissed = null } = opts;
  const issues = opts.issues || validateLayout(layout);
  const ran = hasRun || simRunning || simulatedSeconds > 0;
  const stations = layout.stations;
  const roads = Object.keys(layout.roads).length;
  const has = (type) => stations.some((s) => s.type === type);
  const steps = [];
  const push = (...list) => {
    for (const s of list) if (s && !(s.dismissible && dismissed && dismissed.has(s.id))) steps.push(s);
  };

  if (!roads) {
    push(makeStep('no-road', 'todo', 'plant', 'road', 'Draw your first road',
      'Vehicles drive on roads. Pick the Road tool and drag across the plan.', { type: 'set-tool', tool: 'road', label: 'Road tool' }));
  }
  if (!stations.length) {
    push(makeStep('place-stations', 'todo', 'plant', 'source', 'Place a Goods in and a Workstation next to the road',
      'Goods in creates the loads and a Workstation works on them. A station must touch a road so vehicles can reach it.',
      { type: 'set-tool', tool: 'source', label: 'Goods in' }));
  } else if (!has('source')) {
    push(makeStep('no-source', 'todo', 'plant', 'source', 'Add a Goods in where loads enter the plant',
      'Without a Goods in nothing arrives. Place one next to the road.', { type: 'set-tool', tool: 'source', label: 'Goods in' }, { dismissible: true }));
  }
  if (roads) push(...dockSteps(layout, issues)); // without any road the first step already says it
  push(...connectionSteps(layout));
  push(...routeSteps(layout, issues));
  const carriers = carrierSteps(layout, issues);
  push(...carriers);
  const noVehicles = fleetStep(layout);
  push(noVehicles);

  const structural = steps.length;
  // an empty fleet is already said by the step that names it (a flow dedicated to it, or no vehicles at all)
  const named = new Set([...carriers.flatMap((c) => c.refs.fleetIds || []), ...(noVehicles ? noVehicles.refs.fleetIds || [] : [])]);
  const leftover = issues.filter((i) => (i.severity === 'error' || i.severity === 'warning') && !COVERED_CODES.has(i.code)
    && !(i.code === 'fleet-count-zero' && named.has(i.refs?.fleetId)));
  if (leftover.length) {
    push(makeStep('open-checks', 'warn', 'run', 'warning', `${plural(leftover.length, 'thing')} to check`,
      'The Checks tab explains each one and how to fix it.', { type: 'set-tab', tab: 'checks', label: 'Open Checks' }));
  }
  // an error the steps above do not name (a workstation that can never start, a missing depot) is not a plant to press play on
  const ready = structural === 0 && layout.flows.length > 0 && vehicleCount(layout) > 0 && !leftover.some((i) => i.severity === 'error');
  if (ready && !ran) {
    push(makeStep('run:press-play', 'todo', 'run', 'play', 'Press play to watch it run',
      'Vehicles pick up loads and deliver them along your flows.', { type: 'run', label: 'Run' }));
  }
  if (ran && simulatedSeconds >= resultsAfter(layout) && !resultsSeen) {
    push(makeStep('run:open-results', 'todo', 'run', 'chart', 'Open Results to find the bottleneck',
      'The first results are in. They show where loads wait and how busy the vehicles are.',
      { type: 'set-tab', tab: 'results', label: 'Open Results' }, { dismissible: true }));
  }

  if (vehicleCount(layout) > 0 && !has('depot')) {
    push(makeStep('info:no-depot', 'info', 'fleet', 'depot', 'Give idle vehicles a place to park',
      'Idle vehicles wait on the road. Add a Parking & charging depot so they park out of the way.',
      { type: 'set-tool', tool: 'depot', label: 'Add parking' }, { dismissible: true }));
  }
  const sources = stations.filter((s) => s.type === 'source');
  if (sources.length >= 2 && sources.every((s) => flowsFrom(layout, s.id).length > 0)) {
    const phrase = STRATEGY_PHRASE[layout.settings?.dispatch] || STRATEGY_PHRASE.nearest;
    const agvs = layout.fleets.length > 0 && layout.fleets.every((f) => f.preset === 'agv');
    push(makeStep('info:vehicles-serve-all', 'info', ['flows', 'fleet'], 'info', `Your ${agvs ? 'AGVs' : 'vehicles'} serve every Goods in automatically`,
      `Every free ${agvs ? 'AGV' : 'vehicle'} takes ${phrase}, whichever Goods in it comes from. Change this in Simulate › Dispatch strategy.`,
      { type: 'set-tab', tab: 'simulate', label: 'Open Simulate' }, { dismissible: true }));
  }
  push(...addDoorsSteps(layout)); // trucks and dock doors: a note once the plant has flows (guidance-ops.js)
  return steps;
}

/** Steps that still need doing (everything but notes). */
export const openSteps = (steps) => steps.filter((s) => s.severity !== 'info');

/** The dispatch strategy name a note quotes, for tests and tooltips. */
export const strategyLabel = (key) => (DISPATCH_STRATEGIES[key] || DISPATCH_STRATEGIES.nearest).label;

// ---------------------------------------------------------------------------------------------------------
// Fixes for issues of the Checks tab
// ---------------------------------------------------------------------------------------------------------

/**
 * The one-click fix guidance can offer for a validateLayout issue, or null. A connect-flow fix carries `pick` ('to' | 'from'), the end
 * the planner may choose; `toId`/`fromId` hold the suggestion. When no station could receive (send) the loads, the fix is a set-tool
 * fix that says what to place instead.
 */
export function fixForIssue(layout, issue) {
  const station = issue.refs?.stationId ? getStation(layout, issue.refs.stationId) : null;
  switch (issue.code) {
    case 'source-no-outflow': {
      if (!station) return null;
      const to = suggestDestination(layout, station.id);
      return to ? { type: 'connect-flow', fromId: station.id, toId: to.id, pick: 'to', label: 'Connect' } : placeReceiverFix(station);
    }
    case 'process-no-inflow':
    case 'sink-no-inflow': {
      if (!station) return null;
      const from = suggestOrigin(layout, station.id);
      return from ? { type: 'connect-flow', fromId: from.id, toId: station.id, pick: 'from', label: 'Connect' } : { type: 'set-tool', tool: 'source', label: 'Goods in' };
    }
    case 'flow-fleet-missing': return carrierSteps(layout, [issue])[0]?.fix || null;
    case 'no-fleets': return fleetStep(layout)?.fix || { ...DEFAULT_FLEET, type: 'add-fleet', label: 'Add vehicles' };
    case 'fleet-count-zero': {
      const fleet = issue.refs?.fleetId ? getFleet(layout, issue.refs.fleetId) : null;
      return fleet ? { type: 'add-fleet', preset: fleet.preset, fleetId: fleet.id, count: DEFAULT_FLEET.count, label: `Add ${DEFAULT_FLEET.count} vehicles` } : null;
    }
    case 'no-roads': return { type: 'set-tool', tool: 'road', label: 'Road tool' };
    default: return opsFixForIssue(layout, issue); // doors-too-few, doors-exceed-docks, docks-share-lane, timetable-empty (model/validate-ops.js)
  }
}

// ---------------------------------------------------------------------------------------------------------
// Getting started checklist
// ---------------------------------------------------------------------------------------------------------

/** First station type the plant still lacks for a minimal plant, in teaching order. */
function missingStationTool(layout) {
  const has = (...types) => layout.stations.some((s) => types.includes(s.type));
  if (!has('source')) return 'source';
  if (!has('process', 'storage')) return 'process';
  if (!has('sink')) return 'sink';
  return 'source';
}

/**
 * The getting-started list with its live done-state.
 * @param {object} layout
 * @param {{ ran?: boolean, simulatedSeconds?: number, simRunning?: boolean, resultsSeen?: boolean }} [info]
 * @returns {{ items: Array<{ id: string, title: string, hint: string, done: boolean, current: boolean, fix: object }>, done: number, total: number, complete: boolean }}
 */
export function computeChecklist(layout, info = {}) {
  const ran = Boolean(info.ran || info.simRunning || info.simulatedSeconds > 0);
  const roads = Object.values(layout.roads).some((cell) => cell.out > 0);
  const placed = layout.stations.some((s) => s.type === 'source') && layout.stations.some((s) => s.type !== 'source' && s.type !== 'depot')
    && layout.stations.every((s) => docksOf(layout, s.id).length > 0);
  const needsFlow = (s) => (s.type === 'source' && !flowsFrom(layout, s.id).length)
    || ((s.type === 'process' || s.type === 'sink') && !flowsTo(layout, s.id).length);
  const connected = layout.flows.length > 0 && !layout.stations.some(needsFlow);
  const entries = [
    ['roads', 'Draw roads', 'Vehicles drive on roads. Drag with the Road tool.', roads, { type: 'set-tool', tool: 'road', label: 'Road tool' }],
    ['stations', 'Place stations next to the road', 'Goods in, Workstations, Storage and Goods out. Each one must touch a road.', placed,
      { type: 'set-tool', tool: missingStationTool(layout), label: 'Place a station' }],
    ['flows', 'Connect them with flows', 'A flow is an arrow that says where loads go next.', connected, { type: 'set-tool', tool: 'flow', label: 'Flow tool' }],
    ['fleet', 'Add vehicles', 'Every free vehicle serves every flow automatically.', vehicleCount(layout) > 0, { type: 'set-tab', tab: 'fleet', label: 'Open Fleet' }],
    ['run', 'Run the simulation', 'Press play (Space) and watch the vehicles work.', ran, { type: 'run', label: 'Run' }],
    ['results', 'Read the results', 'Open the Results tab to find the bottleneck.', Boolean(info.resultsSeen && ran), { type: 'set-tab', tab: 'results', label: 'Open Results' }],
  ];
  const firstOpen = entries.findIndex((e) => !e[3]);
  const items = entries.map(([id, title, hint, done, fix], i) => ({ id, title, hint, done, current: i === firstOpen, fix }));
  const doneCount = items.filter((i) => i.done).length;
  return { items, done: doneCount, total: items.length, complete: doneCount === items.length };
}

// ---------------------------------------------------------------------------------------------------------
// Dismissals and session progress
// ---------------------------------------------------------------------------------------------------------

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked storage throws on access
  }
}

/**
 * The set of dismissed step ids, remembered in memory and (when storage works) in localStorage.
 * @param {{ storage?: { getItem(k: string): string|null, setItem(k: string, v: string): void }|null, key?: string }} [opts]
 */
export function createDismissals({ storage, key = DISMISS_KEY } = {}) {
  const store = storage === undefined ? browserStorage() : storage;
  const ids = new Set();
  const listeners = new Set();
  let version = 0;
  try {
    const list = JSON.parse(store?.getItem(key) ?? 'null');
    if (Array.isArray(list)) for (const id of list.slice(-MAX_DISMISSED)) if (typeof id === 'string') ids.add(id);
  } catch {
    // unreadable storage or junk in it: start empty
  }
  const changed = () => {
    version += 1;
    try {
      store?.setItem(key, JSON.stringify([...ids].slice(-MAX_DISMISSED)));
    } catch {
      // not remembered across visits this time
    }
    for (const fn of [...listeners]) fn();
  };
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (typeof id !== 'string' || ids.has(id)) return false;
      ids.add(id);
      changed();
      return true;
    },
    remove(id) {
      if (!ids.delete(id)) return false;
      changed();
      return true;
    },
    clear() {
      if (!ids.size) return false;
      ids.clear();
      changed();
      return true;
    },
    list: () => [...ids],
    get version() { return version; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** What happened in this session, per plant: has it run, how long at most, were the results opened afterwards. */
export function createProgress() {
  const byKey = new Map();
  const entry = (key) => {
    if (!byKey.has(key)) byKey.set(key, { ran: false, maxSeconds: 0, resultsSeen: false });
    return byKey.get(key);
  };
  return {
    /** Record what the runner and the tabs show now; returns the progress of `key`. */
    observe(key, { simRunning = false, simulatedSeconds = 0, rightTab = '' } = {}) {
      const e = entry(key);
      if (simRunning || simulatedSeconds > 0) e.ran = true;
      if (simulatedSeconds > e.maxSeconds) e.maxSeconds = simulatedSeconds;
      if (rightTab === 'results' && e.ran) e.resultsSeen = true;
      return e;
    },
    get: (key) => ({ ...entry(key) }),
    reset() { byKey.clear(); },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Applying a fix
// ---------------------------------------------------------------------------------------------------------

/** Toast with an Undo that only fires while that edit is still the latest one (the pattern of the Properties panel). */
function undoToast(ctx, message, kind = 'success') {
  const after = ctx.store.getState().layout;
  ctx.toast(message, { kind, action: { label: 'Undo', onClick: () => { if (ctx.store.getState().layout === after) ctx.store.undo(); } } });
}

/**
 * Wiring things up is not placing things: a placement tool left over from building the plant (Goods out, Road ...) would turn the
 * planner's next click on a station into "Cannot place Goods out here". Called after a Connect or Add vehicles button did its work.
 */
export function backToSelect(ctx) {
  const tool = ctx.store.getState().ui?.tool;
  if (tool && tool !== 'select' && tool !== 'pan') ctx.actions?.setTool?.('select');
}

function connectFlow(ctx, fix) {
  const { store } = ctx;
  const layout = store.getState().layout;
  const from = getStation(layout, fix.fromId);
  const to = getStation(layout, fix.toId);
  if (!from || !to) {
    ctx.toast('That station is gone. Pick another one.', { kind: 'warn' });
    return false;
  }
  let created = null;
  const done = store.commit(`Connect ${from.name} → ${to.name}`, (d) => {
    created = addFlow(d, from.id, to.id);
    if (!created) return false;
  });
  if (!done || !created) {
    ctx.toast(from.id === to.id || !SENDER_TYPES.includes(from.type) || !RECEIVER_TYPES.includes(to.type)
      ? `${from.name} cannot send loads to ${to.name}.` : `${from.name} already sends loads to ${to.name}.`, { kind: 'warn' });
    return false;
  }
  store.select('flow', [created.id]);
  backToSelect(ctx);
  undoToast(ctx, flowCreatedText(store.getState().layout, created));
  return true;
}

function addVehicles(ctx, fix) {
  const { store } = ctx;
  const count = Number.isFinite(fix.count) && fix.count > 0 ? Math.round(fix.count) : DEFAULT_FLEET.count;
  const preset = fix.preset || DEFAULT_FLEET.preset;
  const noun = fleetNoun(preset);
  let fleetId = null;
  if (fix.fleetId) {
    const fleet = getFleet(store.getState().layout, fix.fleetId);
    if (!fleet) return false;
    if (!store.commit(`Set ${fleet.name} to ${plural(count, 'vehicle')}`, (d) => { if (!updateFleet(d, fleet.id, { count })) return false; })) return false;
    fleetId = fleet.id;
  } else {
    let created = null;
    if (!store.commit(`Add ${noun} fleet`, (d) => { created = addFleet(d, preset, { count }); })) return false;
    fleetId = created.id;
  }
  store.select('fleet', [fleetId]);
  backToSelect(ctx);
  undoToast(ctx, `Added ${count} ${count === 1 ? noun : `${noun}s`}. They serve every flow automatically.`);
  return true;
}

/** Let any fleet carry a flow that was dedicated to one fleet. */
function releaseFlow(ctx, fix) {
  const { store } = ctx;
  const layout = store.getState().layout;
  const flow = layout.flows.find((f) => f.id === fix.flowId);
  if (!flow) return false;
  const name = `${getStation(layout, flow.from)?.name ?? 'a station'} → ${getStation(layout, flow.to)?.name ?? 'a station'}`;
  if (!store.commit(`Let any fleet carry ${name}`, (d) => { if (!updateFlow(d, flow.id, { fleetId: null })) return false; })) return false;
  store.select('flow', [flow.id]);
  undoToast(ctx, `Any fleet carries ${name} now.`);
  return true;
}

/**
 * Carry out a fix from a step, a checklist row or an issue. Layout changes go through ctx.store.commit with a readable label
 * (undoable); the rest drives the shell through ctx.actions / ctx.runner. Returns true when something was done.
 * @param {object} ctx the shared ctx (docs/ARCHITECTURE.md 6.8)
 * @param {object} fix see the header
 */
export function applyFix(ctx, fix) {
  if (!fix || typeof fix !== 'object') return false;
  switch (fix.type) {
    case 'connect-flow': return connectFlow(ctx, fix);
    case 'add-fleet': return addVehicles(ctx, fix);
    case 'release-flow': return releaseFlow(ctx, fix);
    case 'set-tool': ctx.actions.setTool(fix.tool); return true;
    case 'focus':
      ctx.actions.focus(fix.refs || {});
      if (fix.hint) ctx.toast(fix.hint, { kind: 'info' });
      return true;
    case 'run':
      if (!ctx.runner.playing) void ctx.runner.play();
      return true;
    case 'set-tab': ctx.actions.setRightTab(fix.tab); return true;
    case 'add-doors': return addDockDoors(ctx, fix.stationId);
    case 'update-station':
    case 'extend-docks': return applyOpsStoreFix(ctx, fix);
    default: return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The shared state of the surfaces
// ---------------------------------------------------------------------------------------------------------

/**
 * The state every coaching surface of one app shares (dismissals, session progress) plus a memoised read of the current steps and
 * checklist, so the chip and three cards that update together compute them once. `ctx` needs store, and optionally runner and issues().
 * @returns {{ read(state?: object): { steps: object[], open: object[], checklist: object, progress: object }, dismiss(id: string): void,
 *   dismissals: object, progress: object, apply(fix: object): boolean }}
 */
export function createGuidance(ctx, { storage } = {}) {
  const dismissals = createDismissals({ storage });
  const progress = createProgress();
  let memo = null;
  // Starting over (a new plant, an example, an opened file) is a new story: it has not run yet.
  ctx.store.subscribe?.((state, info) => { if (info && info.type === 'load') progress.reset(); });

  function read(state = ctx.store.getState()) {
    const key = state.project?.activeId ?? '';
    const runner = ctx.runner;
    const playing = Boolean(runner && runner.playing);
    const seen = progress.observe(key, { simRunning: playing, simulatedSeconds: Number(runner?.time) || 0, rightTab: state.ui?.rightTab });
    let issues = null; // a failing issue check must not take the coaching down: the steps then check the plant themselves
    try {
      issues = typeof ctx.issues === 'function' ? ctx.issues() : null;
    } catch {
      issues = null;
    }
    // The issue list is compared by content: a ctx that recomputes it on every call must not defeat the memo.
    const issueKey = issues ? issues.map((i) => `${i.id}:${i.severity}`).join('|') : '';
    const stamp = [state.layout, issueKey, dismissals.version, seen.ran, seen.maxSeconds >= resultsAfter(state.layout), seen.resultsSeen, playing];
    if (memo && stamp.every((v, i) => v === memo.stamp[i])) return memo.value;
    const opts = { issues: issues || undefined, simRunning: playing, simulatedSeconds: seen.maxSeconds, hasRun: seen.ran, resultsSeen: seen.resultsSeen, dismissed: dismissals };
    const steps = computeNextSteps(state.layout, opts);
    const value = { steps, open: openSteps(steps), checklist: computeChecklist(state.layout, { ran: seen.ran, resultsSeen: seen.resultsSeen }), progress: { ...seen } };
    memo = { stamp, value };
    return value;
  }

  return { read, dismiss: (id) => dismissals.add(id), dismissals, progress, apply: (fix) => applyFix(ctx, fix) };
}

const registry = new WeakMap();

/** The guidance state of this app (created on first use): all surfaces built from the same ctx share it. */
export function guidanceFor(ctx) {
  if (!registry.has(ctx)) registry.set(ctx, createGuidance(ctx));
  return registry.get(ctx);
}
