// The Help page "Statistics" (docs/ENTITY-INSIGHTS-DESIGN.md 5 and 9.1; MODEL part of S1): what the Statistics dock is, when it opens, the two windows, what the
// words mean, how to read the routes on the plan, and the counting rule of EVERY number. The rules are not written here: they come from the same table as the (i) of
// the tiles (stats-model.js DEFINITIONS and BLOCK_DEFINITIONS), so the page and the dock cannot drift apart (tests/ui.stats-help.test.js compares them).
//
//   createStatsHelp() -> Node        the content of the tab (dialogs.js puts it into the Help dialog)
//   STATS_HELP_GROUPS                the kinds of item the page covers, in order: { id, title, intro, ids: [definition ids], blocks: [block definition ids] }

import { h } from '../../util/dom.js';
import { BLOCK_DEFINITIONS, DEFINITIONS, HYSTERESIS, INDICATIVE_BELOW, LAST30_SECONDS, MIN_LEGS_FOR_USUAL, RAMP_MAX, RAMP_MIN, USUAL_SHARE_CLAIMED, VARIANT_DRAWN_SHARE, duration, pct } from './stats-model.js';

/** The ids of DEFINITIONS that start with `prefix`, in the order of the table. */
const idsOf = (prefix) => Object.keys(DEFINITIONS).filter((id) => id.startsWith(prefix));

export const STATS_HELP_GROUPS = Object.freeze([
  { id: 'vehicle', title: 'A vehicle', intro: 'Click a vehicle (or choose it in the Fleet tab) to see its own numbers, where its time goes, where it is held up, which trips it usually makes and what the fleet question says.', ids: idsOf('vehicle.'), blocks: ['time', 'held', 'trips', 'round'] },
  { id: 'vehicleReport', title: 'A vehicle, when the statistics of single vehicles are off', intro: 'Without "Collect statistics for clicked items" (Simulate tab) only the figures of the Results tab are known: the vehicle\'s trips and the numbers of its fleet.', ids: idsOf('vehicleReport.'), blocks: [] },
  { id: 'process', title: 'A workstation', intro: 'The numbers of the Results tab for this workstation, since the start.', ids: idsOf('process.'), blocks: [] },
  { id: 'source', title: 'A Goods in', intro: 'With dock doors the last two numbers are about the trucks; without them they are about the yard and the loads waiting.', ids: idsOf('source.'), blocks: [] },
  { id: 'storage', title: 'A storage', intro: 'Stock, what comes in and goes out, how long a load stays, and how often the storage is full or empty.', ids: idsOf('storage.'), blocks: [] },
  { id: 'sink', title: 'A Goods out', intro: 'What leaves the plant here, and how long the loads took.', ids: idsOf('sink.'), blocks: [] },
  { id: 'depot', title: 'A depot', intro: 'Parking and charging.', ids: idsOf('depot.'), blocks: [] },
  { id: 'flow', title: 'A flow', intro: 'One arrow of the plan: loads from one station to another.', ids: idsOf('flow.'), blocks: [] },
  { id: 'fleet', title: 'A fleet', intro: 'All vehicles of one kind.', ids: idsOf('fleet.'), blocks: [] },
  { id: 'cell', title: 'A road cell', intro: 'One square of road, or a dock cell of a station.', ids: idsOf('cell.'), blocks: [] },
  { id: 'several', title: 'Several items at once', intro: 'Select several items of one kind (a rectangle on the plan, or Shift and click) for a summary of them.', ids: idsOf('several.'), blocks: [] },
]);

/** The page of the Help dialog for the Statistics dock. */
export function createStatsHelp() {
  const p = (...parts) => h('p', { style: { margin: '0', lineHeight: 'var(--lh)', maxWidth: '78ch' } }, ...parts);
  const title = (text) => h('h3', { style: { margin: '0', fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' } }, text);
  const part = (heading, ...children) => h('div', { class: 'stack', style: { '--gap': '6px' } }, title(heading), ...children);
  const rules = (entries) => h('dl', { class: 'stats-help__rules', style: { margin: '0', display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '78ch' } },
    entries.map(([label, text]) => h('div', { class: 'stats-help__rule' }, h('dt', { style: { fontWeight: 'var(--fw-semibold)' } }, label), h('dd', { style: { margin: '0', lineHeight: 'var(--lh)' } }, text))));

  const intro = [
    part('What it is',
      p('Click an item on the plan (a vehicle, a station, a flow arrow, a road cell) and the ', h('strong', null, 'Statistics dock'), ' opens over the bottom of the plan, on a phone as a sheet you can pull up. It shows what a logistics planner asks about that item: six numbers first, then where the time goes, what is worth knowing and, for a vehicle, which trips it usually makes. The plan itself is never resized, so nothing under your pointer moves.'),
      p('It opens when you click without dragging. Pressing and dragging an item moves it and does not open the dock. ', h('strong', null, 'I'), ' opens or closes the dock for the selected item, ', h('strong', null, '[ and ]'), ' choose the previous and the next item of the same kind, ', h('strong', null, 'Esc'), ' clears the selection. At 600 times speed a vehicle crosses the plan too fast to click: choose it in the Fleet tab, or press [ and ].')),
    part('Since start and Last 30 min',
      p(`Since start is the whole measured run (the warm-up is not counted), the same window as the Results tab. Last 30 min is the last ${duration(LAST30_SECONDS)}; until that much has been measured it is the same as Since start, and the dock says so. Only vehicles have the 30-minute version for now: the other kinds show Since start and say why.`),
      p(`The dock says how long it has measured. Below ${duration(INDICATIVE_BELOW)} every verdict is called indicative, and no sentence about a share is spoken from less than 10 minutes. If the statistics were switched on after the run began ("counting since 0:50"), or the vehicles or stations of the plant changed during it ("counting since 0:50 (the plant changed)"), the figures count from that moment. A setting you changed during the run (demand, speed, dispatch, routing) is noted: figures from before it mix both. The list of trips remembers the newest 32,768 drives; on a very long run it says so ("the last 32,768 drives, since 3:12") and its per-hour figures are for that stretch.`)),
    part('Exact, sampled, estimated',
      p('The figures of a vehicle (time split, waiting, trips, battery) are exact to the simulation\'s time step. The figures of a station that the Results tab holds are the Results tab\'s. A number that is arithmetic and not a measurement says so: "estimate", or "workload arithmetic, not a simulation". The line under a number is usually the average of the same figure for the vehicle\'s fleet; an arrow (up or down) appears only when the difference is real, more than the noise of the count and more than 12 %.')),
    part('The words',
      rules([
        ['Busy, incl. waiting', 'The share of time a vehicle drives, waits, loads or unloads. Waiting counts as busy: a vehicle stuck in a queue looks busy.'],
        ['Held up', 'The share of time a vehicle is held up in traffic or in the queue for a dock. One word, because "waiting" means three different things in a plant.'],
        ['No job', 'No order, standing on the road.'],
        ['Loaded, empty, to depot', 'Drives with a load, on the way to a pickup, and to a depot or charger.'],
        ['Since start, Last 30 min', 'The two windows above.'],
      ])),
    part('The routes on the plan',
      p('While a vehicle is selected its usual trips are drawn where they really drive (switch them off with Routes on plan). The line is as wide as the number of trips, its colour is the share of the trip lost to waiting (calm blue to amber to red; the red end is the 90th percentile of what is on screen, between ', pct(RAMP_MIN), ' and ', pct(RAMP_MAX), ', and the key says it), a dashed line is an empty drive, a ring marks where the vehicle queues. Point at a trip in the list (or Tab to it) and that route is drawn strong while the others fade; Enter pins it, Esc lets go.'),
      p(`A trip is a loaded drive. A route is called usual only when one way carries at least ${pct(USUAL_SHARE_CLAIMED)} of the trips between two stations and there are at least ${MIN_LEGS_FOR_USUAL} complete trips; otherwise the dock says "N ways, the most used 41 %". With several docks the way depends on the dock the vehicle uses, so the dock pair is shown, and every way with at least ${pct(VARIANT_DRAWN_SHARE)} of the trips is drawn.`)),
    part('Facts that come and go',
      p(`A sentence under "Worth knowing" appears when its number reaches its threshold and goes when the number falls below ${pct(HYSTERESIS)} of it, so at high speed it does not flicker. At most four are shown. For anything but a vehicle they are the findings of the Results tab for that item, worded the same way.`)),
  ];

  const sections = STATS_HELP_GROUPS.map((g) => part(g.title,
    p(g.intro),
    rules([
      ...g.ids.map((id) => [DEFINITIONS[id].label, DEFINITIONS[id].text]),
      ...g.blocks.map((id) => [BLOCK_DEFINITIONS[id].label, BLOCK_DEFINITIONS[id].text]),
    ])));

  return h('div', { class: 'stack', style: { '--gap': '18px' }, dataset: { help: 'statistics' } },
    p(h('strong', null, 'Click anything on the plan to see its statistics. '), 'This page says what the dock shows and how every number is counted. The same rules appear in the dock itself: press the small (i) next to a number.'),
    ...intro,
    h('h3', { style: { margin: '6px 0 0', fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' } }, 'How every number is counted'),
    ...sections);
}
