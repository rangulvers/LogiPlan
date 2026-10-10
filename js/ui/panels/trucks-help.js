// The Help page "Trucks and dock doors" (docs/WAREHOUSE-DESIGN.md 7.2 "Guidance"): what a door is, why a row of docks blocks, how to read the gate queue, how the door
// check works and what a timetable and its clock change. Plain words for a planner who knows warehouses, not this tool; every number it quotes is a constant of
// model/doors.js, so the page cannot disagree with the inspector.
//
//   createTrucksHelp() -> Node        the content of the tab (dialogs.js puts it into the Help dialog)
//   createDocksDiagram() -> SVG       docks in a row on one lane, against one short side road per dock

import { h } from '../../util/dom.js';
import { formatDuration } from '../../util/format.js';
import {
  ASSUMED_UNLOAD_PER_PALLET, DOOR_TARGET_UTILISATION, DOORS_TOO_FEW_UTILISATION, MIN_TRUCK_GAP, OUT_TRUCK_GAP, PALLETS_PER_TRUCK,
} from '../../model/doors.js';
import { GATE_AMBER_SECONDS, GATE_RED_SECONDS } from '../render/ops.js';

const svg = (tag, attrs, ...children) => h(`svg:${tag}`, attrs, ...children);
const percent = (v) => `${Math.round(v * 100)} %`;

/**
 * Two small plans side by side: on the left three docks in a row on one lane (a vehicle standing at the first blocks the two behind it, which stand free),
 * on the right the same three docks on their own short side roads (three vehicles work at once). Colours come from the tokens, so it follows the theme.
 */
export function createDocksDiagram() {
  const road = (x, y, w, h2) => svg('rect', { x, y, width: w, height: h2, rx: 3, style: 'fill: var(--surface-3); stroke: var(--border-strong)' });
  const brick = (x, w, name) => svg('g', null,
    svg('rect', { x, y: 10, width: w, height: 34, rx: 6, style: 'fill: var(--st-source); stroke: var(--st-source-ink); stroke-opacity: .25' }),
    svg('text', { x: x + w / 2, y: 31, 'text-anchor': 'middle', style: 'fill: var(--st-source-ink); font: 600 12px var(--font-sans)' }, name));
  // a dock is the road cell that touches the brick: dashed while free, solid orange while a vehicle holds it
  const dock = (x, held) => svg('rect', { x, y: 44, width: 26, height: 26, rx: 3, style: `fill: ${held ? 'var(--warn-soft)' : 'var(--accent-soft)'}; stroke: ${held ? 'var(--warn)' : 'var(--accent)'}; stroke-width: 1.5; stroke-dasharray: ${held ? '0' : '3 2'}` });
  const vehicle = (x, y, queued) => svg('g', { transform: `translate(${x} ${y})` },
    svg('rect', { x: 0, y: 0, width: 22, height: 14, rx: 4, style: `fill: ${queued ? 'var(--warn)' : 'var(--accent-solid)'}; stroke: var(--surface); stroke-width: 1.5` }),
    svg('rect', { x: 4, y: 3, width: 7, height: 8, rx: 1.5, style: 'fill: var(--on-accent); opacity: .85' }));
  const label = (x, y, text, strong = false) => svg('text', { x, y, 'text-anchor': 'middle', style: `fill: ${strong ? 'var(--text)' : 'var(--text-dim)'}; font: ${strong ? 600 : 500} ${strong ? 13 : 11.5}px var(--font-sans)` }, text);
  return svg('svg', {
    viewBox: '0 0 460 180', role: 'img', style: 'display: block; width: 100%; height: auto; max-width: 560px; margin: 0 auto',
    'aria-label': 'Left: three docks in a row along one lane. A vehicle stands at the first dock it reaches and blocks the vehicle behind it, while the other two docks stand free. Right: three docks on their own short side roads, so three vehicles work at once.',
  },
  svg('title', null, 'Docks in a row against docks on side roads'),
  // left: one lane, the vehicles arrive from the right
  brick(14, 188, 'Goods in'),
  dock(24, false), dock(84, false), dock(144, true),
  road(8, 70, 206, 26),
  vehicle(146, 76, false), vehicle(180, 76, true),
  label(110, 122, 'Docks in a row', true),
  label(110, 140, 'A vehicle at the first dock'),
  label(110, 156, 'blocks the others.'),
  // right: a side road for each dock
  brick(246, 200, 'Goods in'),
  road(240, 96, 214, 26),
  dock(262, true), dock(322, true), dock(382, true),
  road(262, 70, 26, 26), road(322, 70, 26, 26), road(382, 70, 26, 26),
  vehicle(264, 50, false), vehicle(324, 50, false), vehicle(384, 50, false),
  label(347, 148, 'A side road for each dock', true),
  label(347, 166, 'All three work at once.'));
}

/** The page of the Help dialog for trucks and dock doors. */
export function createTrucksHelp() {
  const p = (...parts) => h('p', { style: { margin: '0', lineHeight: 'var(--lh)', maxWidth: '78ch' } }, ...parts);
  const title = (text) => h('h3', { style: { margin: '0', fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' } }, text);
  const part = (heading, ...children) => h('div', { class: 'stack', style: { '--gap': '6px' } }, title(heading), ...children);
  const list = (items) => h('ul', { style: { margin: '0', paddingLeft: '22px', display: 'flex', flexDirection: 'column', gap: '6px', lineHeight: 'var(--lh)', maxWidth: '78ch' } }, items.map((item) => h('li', null, item)));
  return h('div', { class: 'stack', style: { '--gap': '18px' }, dataset: { help: 'trucks' } },
    p(h('strong', null, 'Trucks are events, not vehicles on the road. '), 'A Goods in or Goods out with dock doors receives (or loads) trucks: a truck arrives, waits at the gate for a free door, is checked in, is unloaded or loaded by your forklifts and AGVs, is checked out and leaves. Select the station and press ',
      h('strong', null, 'Add dock doors'), ' under Trucks and doors in the Properties tab. Nothing changes for a station that never presses it.'),
    part('What a door is',
      p('A door is a place for a truck and a count (doors: 1 to 32), not a road cell. The vehicles still drive to the dock cells of the station, the road cells that touch it, and the dock choice of the simulation decides which one they use. So the number of doors says how many trucks are served at once, and the dock cells say where the vehicles stand. Give a station at least as many road cells as doors: the Checks tab warns when it has fewer.')),
    part('What “Add dock doors” does',
      p(`It keeps the load of the plant. A Goods in that made one pallet every 3 minutes now receives a truck of ${PALLETS_PER_TRUCK} pallets every 72 minutes: the same 20 pallets an hour, but in bunches. Trucks come at least ${formatDuration(MIN_TRUCK_GAP)} apart; if the old rate would need them closer, they get more pallets instead. A Goods out gets trucks that carry what the plant shipped in the last run (run the plant first); before a run it gets one truck every ${formatDuration(OUT_TRUCK_GAP)} (${PALLETS_PER_TRUCK} pallets, 48 an hour), which leaves trucks without a full load when the plant ships less. A station gets two doors. When fewer road cells touch the station than it has doors (the Starter has one), the Checks tab says so: a door beyond the dock cells cannot be unloaded any faster, it only lets one more truck check in or out while the others are unloaded, so give the station a second dock. Undo takes it all back. “Remove trucks” returns to the plain arrivals and removes the doors, the check-in times and the timetable of that station (Undo brings them back); the arrivals you had set before stay in the Deliveries section.`)),
    part('Why a row of docks blocks',
      h('figure', { style: { margin: '0', padding: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--surface-2)' } }, createDocksDiagram()),
      p('A vehicle standing at a dock holds its road cell until it has loaded or unloaded. When the docks lie in a row on one lane, the vehicles behind it cannot pass to reach the docks further along, so they queue on the road while those docks stand free. Measured on a test plant: with six docks in a row all pallets used the first dock; with three separate short side roads the work was shared. The Checks tab says “docks lie in a row” and shows them. Give each dock its own short side road; a second road behind the docks does not help, the vehicles still use the first dock.')),
    part('How to read the gate queue',
      p('The gate is where trucks wait for a free door. The chip on the station reads, for example, “Gate 5 trucks, 38 min”: five trucks wait and the longest has waited 38 minutes. It turns amber from ',
        formatDuration(GATE_AMBER_SECONDS), ' and red from ', formatDuration(GATE_RED_SECONDS), ' (and carries a mark, so colour is not the only signal). A queue that grows all day means the doors cannot keep up; a queue that is short and empties again is fine. The Doors card in Results shows the gate wait, the door time, how busy the doors were, the gate queue over time and, for a Goods out, how many trucks left without a full load.'),
      p('Door time is how long a truck holds a door: check-in, the work of your vehicles, check-out. It includes waiting for a free forklift, so when the doors look busy it may be the forklifts that are too few. The Results page says so when the pallets of a truck waited long for a vehicle.')),
    part('The door check',
      p(`The line under the door settings estimates how many doors are busy at once at the busiest hour: trucks an hour × the time a truck holds a door. The time is assumed (check-in, ${ASSUMED_UNLOAD_PER_PALLET} s per pallet, check-out) until a run has measured it. Example: 6 trucks an hour of 26 pallets hold a door for 49 minutes each, so about 4.9 doors are busy at once; 5 doors would be busy 98 % of the time and the queue at the gate would grow without end, 6 doors 82 %. From ${percent(DOORS_TOO_FEW_UTILISATION)} busy the check calls the doors too few and offers the fewest doors that are busy at most ${percent(DOOR_TARGET_UTILISATION)} of the time. The numbers are typical values, labelled indicative: replace them with your own.`),
      p(`The ${ASSUMED_UNLOAD_PER_PALLET} seconds per pallet are a guess; your vehicles set the real door time. A truck is unloaded as fast as forklifts or AGVs take its pallets away: one or two vehicles at one dock need much longer than the guess, many vehicles less. After a run the check uses the door time measured in it, and the Doors card shows it. So doors and vehicles are traded together: when the doors look busy, look at the forklifts before adding a door.`)),
    part('Timetables, clock and starting again',
      list([
        'Choose “Use a timetable” to let trucks arrive at fixed times of day. A station that already has trucks at a rate starts with the trucks of one day at that rate as its rows, so the load does not change; edit them, paste your own or remove all rows. Rows without a number of pallets draw it from the pallets per truck. “Trucks arrive up to … early or late” and “No-shows” add the variation of a real day.',
        'Paste from spreadsheet reads two columns from Excel: tab, semicolon or comma between them, times such as 6:00, 06:00, 06:00:00, 06.00, 0600, 6:00 Uhr or 6:00 AM, numbers such as 24,0. A preview marks every row it could not read; nothing is applied until you press Use rows.',
        'A plant with a timetable has a clock. Plant settings shows where it starts (the time of day and weekday at simulation time 0), and the simulation bar shows the time of day. Run one day and Run one week simulate whole days.',
        'After an edit a plant with a timetable starts again at the start of its clock instead of continuing, because the time of day matters. The “Effect of your change” card is not shown then: compare whole days instead (Experiments). A plant with trucks in rate mode has no daily rhythm and keeps the quick restart.',
      ])),
    part('The demand slider',
      p('Demand scales the volume. In rate mode trucks come more often (the fields keep the rate you typed, the lines under them say what the demand setting makes of it); with a timetable the appointments stay where they are and the trucks carry more or fewer pallets.')));
}
