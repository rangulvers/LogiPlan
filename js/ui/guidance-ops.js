// Coaching for trucks and dock doors (docs/WAREHOUSE-DESIGN.md 7.2 "Guidance", 7.6), the part js/ui/guidance.js calls:
//
//   addDoorsSteps(layout)          the note "add dock doors" for computeNextSteps: severity 'info' (never counted as a step to finish), dismissible,
//                                  once the plant has flows and a Goods in or Goods out without trucks. At most ONE note per plant.
//   addDockDoors(ctx, stationId)   what the button "Add dock doors" does, from the inspector section and from that note: convertToDoors in ONE undo
//                                  step labelled "Add dock doors", the station selected, copy 1 of 7.6 as a toast (8 s) with the action "Show doors"
//   applyOpsStoreFix(ctx, fix)     the Fix buttons of the Checks tab for the codes of model/validate-ops.js: { type: 'update-station' | 'extend-docks' }
//                                  data from opsFixFor, performed inside ONE store.commit (undoLabel), with a toast that offers Undo
//   opsFixForIssue(layout, issue)  opsFixFor, so that guidance.js has a single import for it
//
// Pure except for the two functions that take a `ctx` (store, toast, actions): Node tests drive them with a real store and a stub toast.

import { docksOf, getStation, updateStation } from '../model/layout.js';
import { TRUCK_TYPES, trucksOf } from '../model/ops.js';
import { convertToDoors, dockDoorsToast, legacyPalletsPerHour } from '../model/doors.js';
import { applyOpsFix, opsFixFor } from '../model/validate-ops.js';
import { formatTimeOfDay } from '../model/calendar.js';

/** The id of the note; a planner who dismisses it dismisses it for every station (the dismissal is stored by id). */
export const ADD_DOORS_ID = 'info:add-doors';

/** Re-export so guidance.js imports the fix data and its performer from one module. */
export const opsFixForIssue = opsFixFor;

/** Can this layout station get doors, and has it none yet? */
export const canAddDoors = (station) => Boolean(station) && TRUCK_TYPES.includes(station.type) && !trucksOf(station);

/**
 * The station the note talks about: the first Goods in with an outgoing flow, else the first Goods out with an incoming one (both without trucks).
 * A plant without flows has nothing to receive or ship yet.
 */
export function doorsCandidate(layout) {
  const flows = Array.isArray(layout && layout.flows) ? layout.flows : [];
  if (flows.length === 0) return null;
  const stations = Array.isArray(layout.stations) ? layout.stations : [];
  const sender = stations.find((s) => s.type === 'source' && canAddDoors(s) && flows.some((f) => f.from === s.id));
  if (sender) return sender;
  return stations.find((s) => s.type === 'sink' && canAddDoors(s) && flows.some((f) => f.to === s.id)) || null;
}

/** The copy of the note (7.2: "add-doors"). Plain words for a planner who has never seen a truck in the tool. */
export function addDoorsText(station) {
  return station.type === 'sink'
    ? {
      title: `Trucks collect the goods at ${station.name}`,
      text: 'At the moment the loads leave at once. Add dock doors to let trucks collect them, and see whether the doors or the forklifts limit the shipping.',
    }
    : {
      title: `Trucks bring the goods to ${station.name}`,
      text: 'At the moment the loads arrive one by one. Add dock doors to let them arrive on trucks, in bunches, and see how many doors you need.',
    };
}

/**
 * The note for computeNextSteps, as an array of zero or one steps in the shape guidance.js builds (id, severity 'info', scopes, icon, title, text,
 * refs, fix, dismissible). Its fix is { type: 'add-doors', stationId, label: 'Add dock doors' }.
 * @param {object} layout
 * @returns {object[]}
 */
export function addDoorsSteps(layout) {
  const station = doorsCandidate(layout);
  if (!station) return [];
  const { title, text } = addDoorsText(station);
  return [{
    id: ADD_DOORS_ID, severity: 'info', scopes: ['plant'], icon: 'truck', title, text,
    refs: { stationIds: [station.id] }, fix: { type: 'add-doors', stationId: station.id, label: 'Add dock doors' }, dismissible: true,
  }];
}

/**
 * "Add dock doors": the conversion of 6.3.1 in one undo step, the station selected so that the section of the inspector shows, copy 1 as a toast.
 * @param {object} ctx the shared ctx (docs/ARCHITECTURE.md 6.8): store, toast, actions.focus
 * @param {string} stationId
 * @returns {boolean} whether the doors were added (false: no such station, a type without doors, or it has trucks already)
 */
export function addDockDoors(ctx, stationId) {
  const { store } = ctx;
  const station = getStation(store.getState().layout, stationId);
  if (!canAddDoors(station)) return false;
  const trucks = convertToDoors(station);
  if (!trucks) return false;
  const before = station.type === 'source' ? legacyPalletsPerHour(station.params) : undefined;
  if (!store.commit('Add dock doors', (d) => { if (!updateStation(d, station.id, { ops: { trucks } })) return false; })) return false;
  store.select('station', [station.id]);
  ctx.toast(dockDoorsToast({ name: station.name, type: station.type, trucks, before }), {
    kind: 'info', ms: 8000, action: { label: 'Show doors', onClick: () => ctx.actions?.focus?.({ stationIds: [station.id] }) },
  });
  return true;
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What a performed fix says in its toast. `before` is the layout the fix started from, `after` the one it made. */
export function opsFixDoneText(before, after, fix) {
  const name = (getStation(after, fix.stationId) || getStation(before, fix.stationId) || { name: 'The station' }).name;
  if (fix.type === 'extend-docks') {
    const added = Math.max(0, docksOf(after, fix.stationId).length - docksOf(before, fix.stationId).length);
    return `${count(added, 'road cell', 'road cells')} more touch${added === 1 ? 'es' : ''} ${name}. They lie in a row, so vehicles can only share the work if each dock gets its own side road.`;
  }
  const trucks = fix.patch && fix.patch.ops && fix.patch.ops.trucks;
  if (trucks && Number.isFinite(trucks.doors)) return `${name} now has ${count(trucks.doors, 'door', 'doors')}.`;
  if (trucks && Array.isArray(trucks.schedule) && trucks.schedule[0]) {
    const row = trucks.schedule[0];
    return `Added a row to the timetable of ${name}: ${formatTimeOfDay(row.at)}${Number.isFinite(row.pallets) ? `, ${count(row.pallets, 'pallet', 'pallets')}` : ''}.`;
  }
  return `${fix.label}: done.`;
}

/**
 * Perform a Fix of model/validate-ops.js ({ type: 'update-station' | 'extend-docks' }) inside one store.commit labelled `fix.undoLabel`, and say
 * so with a toast whose action Undo takes it back while it is still the latest edit.
 * @returns {boolean} whether the plant changed
 */
export function applyOpsStoreFix(ctx, fix) {
  const { store } = ctx;
  const start = store.getState().layout;
  if (!store.commit(fix.undoLabel || fix.label, (d) => { if (!applyOpsFix(d, fix)) return false; })) {
    ctx.toast(`${fix.label} changed nothing: the plant has no room for it.`, { kind: 'warn' });
    return false;
  }
  const after = store.getState().layout;
  ctx.toast(opsFixDoneText(start, after, fix), { kind: 'success', action: { label: 'Undo', onClick: () => { if (store.getState().layout === after) store.undo(); } } });
  return true;
}
