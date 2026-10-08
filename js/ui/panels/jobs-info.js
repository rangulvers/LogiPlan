// Who serves which flow: the pure helpers behind the "Where do loads go?" sections of the Properties tab, the "Jobs this fleet
// serves" section of the Fleet tab, the "Served by" lines of the Flows tab and the wording of the Help (docs/ARCHITECTURE.md 6.9).
// No DOM in here: everything takes a layout (an immutable snapshot) and returns plain data, so it runs and is tested in Node
// (tests/ui.jobsinfo.test.js). The drawing lives in jobs-view.js.
//
// The model these helpers describe. Vehicles are NOT assigned to stations. A flow says where loads go; every free vehicle serves
// every flow, unless the flow is restricted to one fleet (flow.fleetId). So "who can serve this flow" is either all fleets that have
// vehicles, or exactly one fleet, and "which flows can this fleet serve" is every unrestricted flow plus the ones dedicated to it.
//
//   servedFlows(layout, fleetId)      -> { any, only, other, all }   flows a fleet serves: unrestricted, dedicated, dedicated elsewhere
//   fleetsServing(layout, flowId)     -> { restricted, fleets, vehicles, servable, missingFleet }
//   describeServedBy(layout, flowId)  -> { value, tone, hint }       "any fleet (AGV ×2, Forklift ×1)" / "only AGV ×2"
//   describeSplit(layout, stationId)  -> { several, flows: [{ flow, to, percent, weight }] }   how a station divides its output
//   describeInflows(layout, stationId)-> { items, text }             what a workstation takes per cycle from each incoming flow
//   fleetJobsSummary(layout, fleetId) -> { flows, vehicles, text }   "4 flows share these 2 AGVs"
//   restrictedFleetProblems(layout)   -> Problem[]                   flows nobody can serve (dedicated to an empty fleet, no vehicles)
//   stepWeight(weight, direction)     -> number                      one click of a weight stepper
//   percentages(weights)              -> number[]                    whole percentages that add up to exactly 100

import { getStation, getFleet, getFlow, flowsFrom, flowsTo } from '../../model/layout.js';
import { formatNumber } from '../../util/format.js';

const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** Smallest and largest flow weight the model accepts (layout.js updateFlow clamps to the same range). */
export const WEIGHT_MIN = 0.01;
export const WEIGHT_MAX = 1000;

// ---------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------

/** Whole percentages of the weights that add up to exactly 100 (largest remainder), all 0 when there is no weight. */
export function percentages(weights) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return weights.map(() => 0);
  const raw = weights.map((w) => (w / total) * 100);
  const whole = raw.map(Math.floor);
  let left = 100 - whole.reduce((sum, w) => sum + w, 0);
  const byRemainder = raw.map((r, i) => [r - whole[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    whole[i] += 1;
    left -= 1;
  }
  return whole;
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * The weight after one click of the [-] (direction -1) or [+] (direction +1) of a stepper. Whole steps from 1 upwards; below 1 the
 * weight doubles or halves, so a weight of 0.5 typed in the Flows tab never jumps the wrong way. Stays within WEIGHT_MIN..WEIGHT_MAX.
 */
export function stepWeight(weight, direction) {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
  const next = direction >= 0 ? (w >= 1 ? Math.floor(w) + 1 : Math.min(1, w * 2)) : (w > 1 ? Math.ceil(w) - 1 : w / 2);
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, round2(next)));
}

// ---------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------

const NOUNS = { agv: 'AGV', forklift: 'forklift', tugger: 'tugger train', custom: 'vehicle' };
/** What one vehicle of a fleet is called in a sentence: "AGV", "forklift", "tugger train", "vehicle". */
export const vehicleNoun = (fleet) => NOUNS[fleet && fleet.preset] || 'vehicle';

const nameOf = (layout, stationId) => getStation(layout, stationId)?.name ?? 'a station';
/** "Goods receiving → Assembly": how a flow is named in a sentence. */
export const flowTitle = (layout, flow) => `${nameOf(layout, flow.from)} → ${nameOf(layout, flow.to)}`;

/** "AGV ×2": a fleet with its vehicle count. */
export const fleetCount = (fleet) => `${fleet.name} ×${formatNumber(fleet.count)}`;

const DISPATCH_WORDS = {
  nearest: 'the nearest job first',
  oldest: 'the oldest job first',
  balanced: 'a balance of distance and waiting time',
};

/** How a free vehicle chooses its next job, from the plant's dispatch setting: "the nearest job first". */
export const dispatchPhrase = (layout) => DISPATCH_WORDS[layout.settings?.dispatch] || DISPATCH_WORDS.nearest;

// ---------------------------------------------------------------------------------------------------------
// Fleets and flows
// ---------------------------------------------------------------------------------------------------------

const totalVehicles = (layout) => layout.fleets.reduce((sum, f) => sum + (f.count > 0 ? f.count : 0), 0);

/**
 * The flows a fleet may serve, in layout order. `any`: flows every fleet may serve; `only`: flows restricted to this fleet;
 * `all`: both together; `other`: flows restricted to another fleet (this fleet never carries them). Empty lists for an unknown fleet.
 * @returns {{ any: object[], only: object[], other: object[], all: object[] }}
 */
export function servedFlows(layout, fleetId) {
  const result = { any: [], only: [], other: [], all: [] };
  if (!getFleet(layout, fleetId)) return result;
  for (const flow of layout.flows) {
    if (!flow.fleetId) result.any.push(flow);
    else if (flow.fleetId === fleetId) result.only.push(flow);
    else result.other.push(flow);
    if (!flow.fleetId || flow.fleetId === fleetId) result.all.push(flow);
  }
  return result;
}

/**
 * Who can carry a flow. Unrestricted: every fleet that has vehicles. Restricted: that one fleet (listed even without vehicles, so the
 * caller can say so). `fleets` is [{ fleet, count }]; `vehicles` is their total; `servable` is false when no vehicle can ever do it
 * (a dedicated fleet without vehicles, a fleet that no longer exists, or no vehicles anywhere).
 * @returns {{ restricted: boolean, fleets: Array<{ fleet: object, count: number }>, vehicles: number, servable: boolean, missingFleet: boolean }}
 */
export function fleetsServing(layout, flowId) {
  const flow = getFlow(layout, flowId);
  const none = { restricted: false, fleets: [], vehicles: 0, servable: false, missingFleet: false };
  if (!flow) return none;
  if (flow.fleetId) {
    const fleet = getFleet(layout, flow.fleetId);
    if (!fleet) return { ...none, restricted: true, missingFleet: true };
    const count = Math.max(0, fleet.count);
    return { restricted: true, fleets: [{ fleet, count }], vehicles: count, servable: count > 0, missingFleet: false };
  }
  const fleets = layout.fleets.filter((f) => f.count > 0).map((fleet) => ({ fleet, count: fleet.count }));
  const vehicles = fleets.reduce((sum, f) => sum + f.count, 0);
  return { restricted: false, fleets, vehicles, servable: vehicles > 0, missingFleet: false };
}

/**
 * The "Served by" line of a flow: { value, tone: 'ok'|'warn', hint }. `value` reads "any fleet (AGV ×2, Forklift ×1)", "only AGV ×2"
 * or says what is missing; `hint` is a sentence for the planner (what to do) when the tone is 'warn', else ''.
 */
export function describeServedBy(layout, flowId) {
  const info = fleetsServing(layout, flowId);
  if (info.missingFleet) {
    return { value: 'a fleet that no longer exists', tone: 'warn', hint: 'Set this flow to any fleet, or pick another fleet for it.' };
  }
  if (info.restricted) {
    const { fleet, count } = info.fleets[0];
    if (!count) return { value: `only ${fleet.name}, which has no vehicles`, tone: 'warn', hint: `Raise the number of ${fleet.name} vehicles, or set the flow to any fleet.` };
    return { value: `only ${fleetCount(fleet)}`, tone: 'ok', hint: '' };
  }
  if (!info.servable) return { value: 'nobody yet: there are no vehicles', tone: 'warn', hint: 'Add vehicles in the Fleet tab. Every free vehicle serves every flow.' };
  return { value: `any fleet (${info.fleets.map(({ fleet }) => fleetCount(fleet)).join(', ')})`, tone: 'ok', hint: '' };
}

/**
 * How a station divides its output over its outgoing flows. `several` is true from two flows on (only then do weights matter);
 * `percent` is a whole percentage (100 for a single flow) and the percentages of one station add up to 100.
 * @returns {{ several: boolean, flows: Array<{ flow: object, to: object|null, percent: number, weight: number }> }}
 */
export function describeSplit(layout, stationId) {
  const flows = flowsFrom(layout, stationId);
  const percent = flows.length > 1 ? percentages(flows.map((f) => f.weight)) : flows.map(() => 100);
  return {
    several: flows.length > 1,
    flows: flows.map((flow, i) => ({ flow, to: getStation(layout, flow.to) || null, percent: percent[i], weight: flow.weight })),
  };
}

/**
 * What a station takes in per cycle. Each item is an incoming flow with its origin and `perCycle` (loads a workstation consumes from it
 * every cycle: the bill of materials). `text` is one sentence for a workstation with incoming flows, else ''.
 * @returns {{ items: Array<{ flow: object, from: object|null, perCycle: number }>, text: string }}
 */
export function describeInflows(layout, stationId) {
  const station = getStation(layout, stationId);
  const items = flowsTo(layout, stationId).map((flow) => ({ flow, from: getStation(layout, flow.from) || null, perCycle: flow.perCycle }));
  if (!station || station.type !== 'process' || !items.length) return { items, text: '' };
  const parts = items.map((i) => `${plural(i.perCycle, 'load')} from ${i.from ? i.from.name : 'a station'}`);
  const list = parts.length < 2 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return { items, text: `One cycle uses ${list}.` };
}

/**
 * The line at the top of a fleet's "Jobs this fleet serves": how many flows share how many vehicles.
 * "4 flows share these 2 AGVs", "1 flow is served by this forklift", "These 2 AGVs have no job yet.", "AGV has no vehicles yet, so it serves no flow."
 * @returns {{ flows: number, vehicles: number, text: string }}
 */
export function fleetJobsSummary(layout, fleetId) {
  const fleet = getFleet(layout, fleetId);
  if (!fleet) return { flows: 0, vehicles: 0, text: '' };
  const flows = servedFlows(layout, fleetId).all.length;
  const vehicles = Math.max(0, fleet.count);
  const noun = vehicleNoun(fleet);
  if (!vehicles) return { flows, vehicles, text: `${fleet.name} has no vehicles yet, so it serves no flow.` };
  const subject = vehicles === 1 ? `this ${noun}` : `these ${vehicles} ${noun}s`;
  if (!flows) return { flows, vehicles, text: `${vehicles === 1 ? `This ${noun} has` : `These ${vehicles} ${noun}s have`} no job yet.` };
  return { flows, vehicles, text: flows === 1 ? `1 flow is served by ${subject}` : `${flows} flows share ${subject}` };
}

/**
 * Flows nobody can carry, as sentences for the planner: [{ id, code, flowId, fleetId, message, hint }].
 * `restricted-fleet-empty`: the flow is dedicated to a fleet without vehicles; `restricted-fleet-missing`: its fleet does not exist
 * any more; `no-vehicles`: the flow is open to any fleet but the plant has no vehicles at all. Layout order.
 */
export function restrictedFleetProblems(layout) {
  const problems = [];
  const vehicles = totalVehicles(layout);
  for (const flow of layout.flows) {
    if (!getStation(layout, flow.from) || !getStation(layout, flow.to)) continue;
    const title = `“${flowTitle(layout, flow)}”`;
    const add = (code, message, hint) => problems.push({ id: `${code}:${flow.id}`, code, flowId: flow.id, fleetId: flow.fleetId || null, message, hint });
    if (flow.fleetId) {
      const fleet = getFleet(layout, flow.fleetId);
      if (!fleet) add('restricted-fleet-missing', `${title} is dedicated to a fleet that no longer exists, so nothing carries it.`, 'Set the flow to any fleet, or pick another fleet for it.');
      else if (!(fleet.count > 0)) add('restricted-fleet-empty', `${title} is dedicated to ${fleet.name}, which has no vehicles, so nothing carries it.`, `Raise the number of ${fleet.name} vehicles, or set the flow to any fleet.`);
    } else if (!vehicles) {
      add('no-vehicles', `Nobody can carry ${title} yet: there are no vehicles.`, 'Add vehicles in the Fleet tab. Every free vehicle serves every flow.');
    }
  }
  return problems;
}
