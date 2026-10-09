// Plan checks of the warehouse module (docs/WAREHOUSE-DESIGN.md Appendix B): trucks and doors (M1), calendar (M2), racks and aisles (M3),
// plans (M4), load types (M5). Called once by validateLayout (validate.js) after its own checks, with the same context and `add`.
//
//   validateOps(ctx, add)   ctx is the internal context of validate.js (layout, docks by station, graph …); `add(severity, code, ref,
//                           message, hint, refs)` records an issue with the stable id `${code}:${ref}`.
//   OPS_CHECKS              the checks to run, in order; each is (ctx, add) => void and runs only on stations that use the feature it
//                           checks, so a legacy plant (no `ops`) gets no new issue.
//
// STATE (milestone M1): trucks and dock doors, for every station that has `ops.trucks` (ref = the station id):
//   doors-too-few       warning  the door check (doors.js, Little's law) says the doors are busy more than 95 % of the time
//   doors-exceed-docks  warning  more doors than road cells touch the station (vehicles serve the doors through those cells)
//   docks-share-lane    warning  two or more dock cells lie in a row on one lane (see dockLanes): a vehicle on the first blocks the others
//   timetable-empty     warning  the station runs a timetable without a single row
//
// The Fix of an issue is DATA, not code: opsFixFor(layout, issue) returns what the Fix button does ({ type: 'update-station', ... },
// { type: 'extend-docks', ... } or the existing { type: 'focus', ... }), and applyOpsFix(draft, fix) performs the two model-level types on a
// layout draft, so the UI wires `fixForIssue` to one call and commits it in one undo step. This file may import layout.js (it is not
// imported by it): extending a road is a layout edit.

import { opposite, E, S } from '../util/grid.js';
import { docksOf, getStation, hasLink, isCellFree, paintRoadPath, roadAt, updateStation } from './layout.js';
import { trucksOf } from './ops.js';
import { PALLETS_PER_TRUCK, doorCheck } from './doors.js';
import { formatTimeOfDay } from './calendar.js';

const MAX_CELLS_PER_ISSUE = 100;
/** The time of day of the row that the Fix of `timetable-empty` adds. */
export const FIX_ROW_AT = 6 * 3600;

const nameOf = (s) => (typeof s.name === 'string' && s.name.trim() ? s.name : String(s.id ?? 'unnamed'));
const q = (s) => `“${nameOf(s)}”`;
const count = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------
// Geometry: which docks share a lane
// ---------------------------------------------------------------------------------------------------------

/**
 * The four sides of a station: each the strip of cells that touch it (in increasing x or y), the step along the strip, and the step that
 * leads AWAY from the station. The strips are exactly the cells `docksOf` considers (the corners are not docks).
 */
function sidesOf(s) {
  const along = (n, at) => Array.from({ length: n }, (_, i) => at(i));
  return [
    { cells: along(s.w, (i) => [s.x + i, s.y - 1]), step: E, away: [0, -1] }, // above the station
    { cells: along(s.w, (i) => [s.x + i, s.y + s.h]), step: E, away: [0, 1] }, // below
    { cells: along(s.h, (j) => [s.x - 1, s.y + j]), step: S, away: [-1, 0] }, // left
    { cells: along(s.h, (j) => [s.x + s.w, s.y + j]), step: S, away: [1, 0] }, // right
  ];
}

/** Is there a link between road cells a and b (neighbours along a strip), in either direction? */
const linked = (layout, a, b, step) => hasLink(layout, a[0], a[1], step) || hasLink(layout, b[0], b[1], opposite(step));

/**
 * The dock lanes of a station: groups of two or more dock cells that lie in a ROW on ONE LANE.
 *
 * Definition (Appendix B, made precise). Take one side of the station: the strip of cells that touch it. Two neighbouring cells A and B of the
 * strip belong to a lane when (1) both are road cells (docks of the station), (2) the road is connected between them (a link A to B or B to A,
 * so they are one road and not two plates side by side), and (3) the cells on their FAR SIDE, one step away from the station behind A and
 * behind B, are not road cells: there is no parallel road behind them that a vehicle could use to get past one that is standing at a dock.
 * A dock lane is a maximal run of cells joined by such pairs. A vehicle that stops on the first dock of a lane cannot be passed by one that
 * wants a dock further along it (the dock book already knows: docks.js, "docks lined up on one lane block each other"), so the docks behind
 * stand free while vehicles queue on the road.
 *
 * Docks that are not neighbours (three separate short side roads, the "bays" of the Dock lab) are never in a lane; neither are two
 * neighbouring dock cells that have a road behind them or that are not linked; a dock row on one side of the station is separate from one
 * on another side (corners are not docks).
 *
 * @param {object} layout
 * @param {object} station a station of `layout`
 * @returns {Array<Array<[number, number]>>} each lane as its cells in order along the strip; [] when there is none
 */
export function dockLanes(layout, station) {
  const lanes = [];
  for (const side of sidesOf(station)) {
    const { cells, step, away } = side;
    const isLane = cells.map((c) => roadAt(layout, c[0], c[1]) !== null && roadAt(layout, c[0] + away[0], c[1] + away[1]) === null);
    let lane = null;
    for (let i = 0; i + 1 < cells.length; i++) {
      if (isLane[i] && isLane[i + 1] && linked(layout, cells[i], cells[i + 1], step)) {
        if (!lane) lane = [cells[i]];
        lane.push(cells[i + 1]);
      } else if (lane) {
        lanes.push(lane);
        lane = null;
      }
    }
    if (lane) lanes.push(lane);
  }
  return lanes;
}

/**
 * Extend the road along the edge of a station so that `wanted` more of its road cells become docks ("Extend the road along the edge", the Fix
 * of `doors-exceed-docks`): next to a road cell that already touches the station, the free cells of the same side are painted two-way, one
 * after the other, on the side with the most docks first. Needs a dock to start from (a station without one has `station-no-dock`). Edits the
 * draft in place; returns how many cells were added (fewer than `wanted` when a side is blocked by a brick, an obstacle or the edge of the plan).
 * The new docks lie in a row, so `docks-share-lane` may then say so; side roads are the better plan.
 * @param {object} layout
 * @param {string} stationId
 * @param {number} wanted
 * @returns {number}
 */
export function extendDockRoad(layout, stationId, wanted) {
  const station = getStation(layout, stationId);
  const target = Math.floor(Number(wanted));
  if (!station || !(target > 0)) return 0;
  const sides = sidesOf(station)
    .map((side) => ({ ...side, road: side.cells.map((c) => roadAt(layout, c[0], c[1]) !== null) }))
    .filter((side) => side.road.some(Boolean))
    .sort((a, b) => b.road.filter(Boolean).length - a.road.filter(Boolean).length); // Array#sort is stable: ties keep the order of sidesOf
  let added = 0;
  for (let progress = true; progress && added < target;) {
    progress = false;
    for (const side of sides) {
      for (let i = 0; i < side.cells.length && added < target; i++) {
        if (side.road[i] || !(side.road[i - 1] || side.road[i + 1])) continue;
        const cell = side.cells[i];
        if (!isCellFree(layout, cell[0], cell[1])) continue;
        const from = side.road[i - 1] ? side.cells[i - 1] : side.cells[i + 1];
        if (paintRoadPath(layout, [from, cell]) < 2) continue;
        side.road[i] = true;
        added++;
        progress = true;
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------------

/** The stations that have truck options, with their block. */
function* truckStations(ctx) {
  for (const station of ctx.layout.stations) {
    const trucks = trucksOf(station);
    if (trucks) yield [station, trucks];
  }
}

/** The dock cells of a station from the context (validate.js computes them once), else from the layout. */
const docksFrom = (ctx, station) => (ctx.docks && ctx.docks.get(station.id)) || [];

/** `doors-too-few`: the door check (doors.js, 6.3.4) puts the doors above 95 % busy. */
function checkDoorsTooFew(ctx, add) {
  for (const [station, trucks] of truckStations(ctx)) {
    const check = doorCheck(trucks, { demandFactor: ctx.layout.settings && ctx.layout.settings.demandFactor });
    if (!check.tooFew) continue;
    const { parts } = check;
    const message = `At the busiest hour ${q(station)} needs about ${parts.need} doors busy at once (${count(parts.trucks, 'truck', 'trucks')} an hour, ${count(parts.minutes, 'minute', 'minutes')} at a door each), but it has ${check.doors}, so trucks will queue at the gate.`;
    const better = check.action ? `${count(parts.better, 'door', 'doors')} would be busy ${parts.util} % of the time. ` : '';
    const basis = check.basis === 'measured' ? 'Measured in the last run.' : `This is an estimate from ${parts.tPallet} s per pallet; Results shows the real figure after a run.`;
    add('warning', 'doors-too-few', station.id, message, `${better}Door time includes waiting for forklifts, so more forklifts shorten it. ${basis}`, { stationId: station.id });
  }
}

/** `doors-exceed-docks`: more doors than road cells touch the station. A station with no dock at all has `station-no-dock`. */
function checkDoorsExceedDocks(ctx, add) {
  for (const [station, trucks] of truckStations(ctx)) {
    const docks = docksFrom(ctx, station);
    if (docks.length === 0 || !Number.isFinite(trucks.doors) || trucks.doors <= docks.length) continue;
    add('warning', 'doors-exceed-docks', station.id,
      `${q(station)} has ${count(trucks.doors, 'door', 'doors')} but only ${count(docks.length, 'road cell touches', 'road cells touch')} it. Vehicles serve the doors through those cells, so they queue there while the trucks wait for their pallets.`,
      'Extend the road along the edge of the station, or give it side roads, until at least as many road cells touch it as it has doors.',
      { stationId: station.id, cells: docks.slice(0, MAX_CELLS_PER_ISSUE) });
  }
}

/** `docks-share-lane`: docks lie in a row on one lane (dockLanes). */
function checkDocksShareLane(ctx, add) {
  for (const [station] of truckStations(ctx)) {
    const lanes = dockLanes(ctx.layout, station);
    if (lanes.length === 0) continue;
    add('warning', 'docks-share-lane', station.id,
      `The docks of ${q(station)} lie in a row on one lane. A vehicle standing at the first dock blocks the others, so vehicles queue on the road while the docks behind stand free.`,
      'Give each dock its own short side road.',
      { stationId: station.id, cells: lanes.flat().slice(0, MAX_CELLS_PER_ISSUE) });
  }
}

/** `timetable-empty`: schedule mode without a row. */
function checkTimetableEmpty(ctx, add) {
  for (const [station, trucks] of truckStations(ctx)) {
    if (trucks.mode !== 'schedule' || (Array.isArray(trucks.schedule) && trucks.schedule.length > 0)) continue;
    add('warning', 'timetable-empty', station.id,
      `The truck timetable of ${q(station)} has no rows, so no truck ever arrives.`,
      'Add a row (an arrival time and a number of pallets), paste a timetable from a spreadsheet, or switch back to “Generate from rate”.',
      { stationId: station.id });
  }
}

/** The checks of the warehouse module, in the order their issues are recorded (the order of Appendix B). */
export const OPS_CHECKS = [checkDoorsTooFew, checkDoorsExceedDocks, checkDocksShareLane, checkTimetableEmpty];

/** Run every check of the warehouse module. */
export function validateOps(ctx, add) {
  for (const check of OPS_CHECKS) check(ctx, add);
}

// ---------------------------------------------------------------------------------------------------------
// The Fix buttons
// ---------------------------------------------------------------------------------------------------------

/**
 * The one-click fix of an issue of this module, as data, or null. The shapes:
 *   { type: 'update-station', stationId, patch, label, undoLabel }   `updateStation(draft, stationId, patch)`
 *   { type: 'extend-docks', stationId, count, label, undoLabel }     `extendDockRoad(draft, stationId, count)`
 *   { type: 'focus', refs: { stationIds, cells }, label }             the existing fix type: select and show on the plan
 * `label` is the button; `undoLabel` is the label of the single undo step. applyOpsFix performs the first two.
 * @param {object} layout the layout the issue was found in
 * @param {{ code: string, refs?: { stationId?: string } }} issue
 * @returns {object|null}
 */
export function opsFixFor(layout, issue) {
  const station = issue && issue.refs && issue.refs.stationId ? getStation(layout, issue.refs.stationId) : null;
  const trucks = trucksOf(station);
  if (!station || !trucks) return null;
  switch (issue.code) {
    case 'doors-too-few': {
      const { action } = doorCheck(trucks, { demandFactor: layout.settings && layout.settings.demandFactor });
      return action ? { type: 'update-station', stationId: station.id, patch: { ops: { trucks: { doors: action.doors } } }, label: action.label, undoLabel: 'Set dock doors' } : null;
    }
    case 'doors-exceed-docks': {
      const need = trucks.doors - docksOf(layout, station.id).length;
      return need > 0 ? { type: 'extend-docks', stationId: station.id, count: need, label: 'Extend the road', undoLabel: 'Extend dock road' } : null;
    }
    case 'docks-share-lane':
      return { type: 'focus', refs: { stationIds: [station.id], cells: dockLanes(layout, station).flat() }, label: 'Show docks' };
    case 'timetable-empty':
      return {
        type: 'update-station', stationId: station.id, patch: { ops: { trucks: { schedule: [{ at: FIX_ROW_AT, pallets: PALLETS_PER_TRUCK }] } } },
        label: 'Add a row', undoLabel: `Add timetable row at ${formatTimeOfDay(FIX_ROW_AT)}`,
      };
    default:
      return null;
  }
}

/**
 * Perform a fix of opsFixFor on a layout draft (inside `store.commit`). 'focus' fixes change nothing and give false.
 * @param {object} layout a draft, edited in place
 * @param {{ type: string }} fix
 * @returns {boolean} whether the layout was edited
 */
export function applyOpsFix(layout, fix) {
  if (!fix || typeof fix !== 'object') return false;
  if (fix.type === 'update-station') return updateStation(layout, fix.stationId, fix.patch);
  if (fix.type === 'extend-docks') return extendDockRoad(layout, fix.stationId, fix.count) > 0;
  return false;
}
