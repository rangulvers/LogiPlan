// Live status of one fleet (a strip inside the fleet card, js/ui/panels/fleet.js): how many of its vehicles work, wait in traffic,
// stand idle or are parked right now, how many trips they made so far and per vehicle and hour, the lowest battery when the fleet has
// one, and a "barely used" badge with the reason when the insights say that the fleet is not needed (insights fleet-unused /
// vehicle-idle-some, js/sim/insights.js - the same verdict the Results tab shows, so the two can never disagree).
//
//   const status = createFleetStatus(ctx, fleetId);   // status.el, status.update(state)
//
// Cheap by design: vehicle states are counted from runner.sim.vehicles (a loop over the fleet's vehicles) and everything else is read
// from runner.kpis() / runner.insights(), which the runner caches for 250 ms - the strip never asks the statistics for a report itself.
// The strip is built once and patched in place (golden rule of js/ui/panels/fields.js); it is hidden while there is no simulation.

import { h } from '../../util/dom.js';
import { formatNumber } from '../../util/format.js';

/** Live groups in display order: key, dot tone of the kit, word. `rare` groups only show while somebody is in them. */
export const STATUS_GROUPS = Object.freeze([
  { key: 'working', tone: 'driving', word: 'working', tip: 'Driving to a pickup or a drop, loading or unloading' },
  { key: 'waiting', tone: 'waiting', word: 'waiting', tip: 'Standing still in traffic: another vehicle, a junction or a broken-down vehicle is in the way' },
  { key: 'idle', tone: 'idle', word: 'idle', tip: 'Free and waiting for a job on the road' },
  { key: 'parked', tone: 'parked', word: 'parked', tip: 'Parked in a depot' },
  { key: 'charging', tone: 'charging', word: 'charging', tip: 'On the way to a charger or charging', rare: true },
  { key: 'down', tone: 'broken', word: 'out of service', tip: 'Broken down or out of battery', rare: true },
]);

const WORKING = new Set(['toPickup', 'loading', 'toDrop', 'unloading']);
const CHARGING = new Set(['charging', 'toCharger']);

/** Which live group a vehicle (VehicleRT of the simulation) counts in. */
export function statusGroup(vehicle) {
  const state = vehicle && vehicle.state;
  if (state === 'broken' || state === 'dead') return 'down';
  if (vehicle && vehicle.tv && vehicle.tv.waiting) return 'waiting';
  if (CHARGING.has(state)) return 'charging';
  if (state === 'parked') return 'parked';
  if (WORKING.has(state)) return 'working';
  return 'idle'; // idle, and toPark (on its way into the depot)
}

/** Vehicle counts of one fleet right now: { total, working, waiting, idle, parked, charging, down }. */
export function countVehicles(vehicles, fleetId) {
  const counts = { total: 0, working: 0, waiting: 0, idle: 0, parked: 0, charging: 0, down: 0 };
  if (!vehicles) return counts;
  for (const v of vehicles) {
    if (v.fleetId !== fleetId) continue;
    counts.total += 1;
    counts[statusGroup(v)] += 1;
  }
  return counts;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const amount = (v) => formatNumber(v, Math.abs(v) < 10 ? 1 : 0);

/**
 * The badge for a fleet the insights call unused: { text, tip } or null. `insights` is runner.insights().
 * fleet-unused wins over vehicle-idle-some (the rules never fire for the same fleet, but the order documents the precedence).
 */
export function usageBadge(insights, fleetId) {
  const list = Array.isArray(insights) ? insights : [];
  const unused = list.find((i) => i && i.id === `fleet-unused:${fleetId}`);
  if (unused) return { text: 'barely used', tip: [unused.title, unused.suggestion].filter(Boolean).join(' ') };
  const some = list.find((i) => i && i.id === `vehicle-idle-some:${fleetId}`);
  if (some) return { text: 'some idle', tip: [some.title, some.suggestion].filter(Boolean).join(' ') };
  return null;
}

/**
 * Everything the strip shows, from plain data (no DOM): the counts, the figures of the fleet's entry in the KPI report and the badge.
 * @param {{ vehicles?: object[], fleetId: string, report?: object|null, insights?: object[] }} input
 */
export function fleetStatusModel({ vehicles, fleetId, report, insights }) {
  const counts = countVehicles(vehicles, fleetId);
  const entry = report && report.fleets && report.fleets[fleetId] ? report.fleets[fleetId] : null;
  const trips = entry && isNum(entry.trips) ? entry.trips : null;
  const perHour = entry && isNum(entry.tripsPerVehicleHour) ? entry.tripsPerVehicleHour : null;
  const battery = entry && isNum(entry.minBattery) ? Math.min(1, Math.max(0, entry.minBattery)) : null;
  return {
    counts,
    trips,
    tripsText: trips === null ? '' : `${formatNumber(trips)} ${trips === 1 ? 'trip' : 'trips'} so far`,
    perHourText: perHour === null || counts.total === 0 ? '' : `${amount(perHour)} ${Math.round(perHour * 10) / 10 === 1 ? 'trip' : 'trips'} per vehicle and hour`,
    batteryText: battery === null ? '' : `lowest battery ${formatNumber(battery * 100)} %`,
    badge: usageBadge(insights, fleetId),
  };
}

const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
const setHidden = (el, value) => { if (el.hidden !== value) el.hidden = value; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };

/**
 * Create the live status strip of fleet `fleetId`.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): runner.sim, runner.kpis(), runner.insights()
 * @param {string} fleetId
 * @returns {{ el: HTMLElement, update(state?: object): void }}
 */
export function createFleetStatus(ctx, fleetId) {
  const chips = STATUS_GROUPS.map((g) => {
    const text = h('span');
    const el = h('span', { class: 'fleet-status__chip', title: g.tip }, h('span', { class: `dot tone-${g.tone}`, 'aria-hidden': 'true' }), text);
    return { g, el, text };
  });
  const trips = h('li', { class: 'fleet-status__fact' });
  const perHour = h('li', { class: 'fleet-status__fact' });
  const battery = h('li', { class: 'fleet-status__fact' });
  const reason = h('span', { class: 'sr-only' });
  const badge = h('span', { class: 'badge badge--warn fleet-status__badge', hidden: true });
  const badgeItem = h('li', { class: 'fleet-status__fact' }, badge, reason);
  badgeItem.hidden = true;
  const el = h('div', { class: 'fleet-status', role: 'group', 'aria-label': 'Live status of this fleet', hidden: true, dataset: { fleetStatus: fleetId } },
    h('div', { class: 'fleet-status__chips', role: 'group', 'aria-label': 'Live status' }, chips.map((c) => c.el)), // the contract of tests/e2e/panels2.mjs: direct children, a number first
    h('ul', { class: 'fleet-status__facts', 'aria-label': 'Work done so far' }, trips, perHour, battery, badgeItem));

  function update() {
    const runner = ctx.runner;
    const sim = runner && runner.sim;
    if (!sim) { setHidden(el, true); return; }
    const model = fleetStatusModel({ vehicles: sim.vehicles, fleetId, report: runner.kpis?.() ?? null, insights: runner.insights?.() ?? [] });
    setHidden(el, false);
    for (const { g, el: chip, text } of chips) {
      const n = model.counts[g.key];
      setHidden(chip, g.rare && n === 0);
      chip.classList.toggle('is-zero', n === 0);
      setText(text, `${n} ${g.word}`);
    }
    for (const [item, value] of [[trips, model.tripsText], [perHour, model.perHourText], [battery, model.batteryText]]) {
      setHidden(item, !value);
      setText(item, value);
    }
    setHidden(badgeItem, !model.badge);
    setHidden(badge, !model.badge);
    if (model.badge) {
      setText(badge, model.badge.text);
      setAttr(badge, 'title', model.badge.tip);
      setText(reason, `: ${model.badge.tip}`);
    }
  }

  update();
  return { el, update };
}
