// Properties panel (docs/ARCHITECTURE.md 6.5): a context-sensitive form for whatever is selected on the plan - a station,
// obstacle, label, road cell, flow, fleet, several things at once - or, with nothing selected, the plant settings.
//
//   const panel = createInspectorPanel(ctx);   // ctx: see docs/ARCHITECTURE.md 6.8
//   container.append(panel.el);  panel.update(store.getState());  // on every store change, ~4 Hz while the simulation runs
//
// The form for a selection is built ONCE per structural signature (kind, ids, station type, neighbouring road cells) and
// afterwards only refreshed in place by update(); a field the planner is typing in is never touched (the golden rule of
// fields.js). Every edit is a store.commit with a readable label; typing and dragging commit with a `coalesce` key so a
// burst of edits is one undo step. Pure helpers that carry decisions (road link states, resize losses, plant summary,
// breakdown text, live status wording) are exported and unit-tested in tests/ui.panels1.test.js.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { STATION_TYPES, STATION_TYPE_ORDER, OBSTACLE_KINDS, FLEET_PRESETS, GRID_LIMITS } from '../../model/defaults.js';
import {
  getStation, getFlow, getFleet, flowsFrom, flowsTo, docksOf, roadAt, hasLink, cloneLayout, roadLengthMeters,
  updateStation, resizeStation, duplicateStation, removeStation, updateObstacle, removeObstacle, updateLabel, removeLabel,
  eraseRoadCell, eraseLink, paintRoadPath, setRoadLimit, setNotes, updateSettings, resizeGrid, setCellSize,
} from '../../model/layout.js';
import { DX, DY, opposite, parseKey } from '../../util/grid.js';
import { formatNumber, formatPercent, formatDistance, round } from '../../util/format.js';
import { numberField, selectField, textField, rangeField, segmentedField, stepperField, distField, section, humanSeconds } from './fields.js';
import { createGuidanceHeader } from './nextsteps.js';

const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const quoted = (name) => `“${name}”`;
/** Planner wording for the station types: [singular, plural]. */
const TYPE_NAMES = { source: ['Goods in', 'Goods in'], process: ['Workstation', 'Workstations'], storage: ['Storage', 'Storages'], sink: ['Goods out', 'Goods out'], depot: ['Depot', 'Depots'] };
const typeName = (type, n = 1) => TYPE_NAMES[type][n === 1 ? 0 : 1];
const DIR_WORDS = ['north', 'east', 'south', 'west'];
const DIR_ARROWS = ['↑', '→', '↓', '←'];
const INLINE_W = '120px';
const PAD = { padding: '12px', '--gap': '12px' };

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

/** The four ways a link between two neighbouring road cells can be set. */
export const LINK_OPTIONS = Object.freeze([
  { value: 'both', label: 'Two-way' },
  { value: 'out', label: 'One-way, out of this cell' },
  { value: 'in', label: 'One-way, into this cell' },
  { value: 'none', label: 'Not linked' },
]);

/**
 * State of the link between road cell (cx, cy) and its neighbour in direction `dir`:
 * 'both', 'out' (this cell -> neighbour), 'in' (neighbour -> this cell) or 'none'.
 */
export function linkState(layout, cx, cy, dir) {
  const out = hasLink(layout, cx, cy, dir);
  const back = hasLink(layout, cx + DX[dir], cy + DY[dir], opposite(dir));
  if (out && back) return 'both';
  if (out) return 'out';
  return back ? 'in' : 'none';
}

/**
 * Set the link between road cell (cx, cy) and its neighbour in `dir` to an exact state (see linkState), built from the
 * layout.js link mutators. False when the neighbour is not a road cell (nothing is changed then).
 */
export function setLinkState(layout, cx, cy, dir, state) {
  const nx = cx + DX[dir];
  const ny = cy + DY[dir];
  if (!roadAt(layout, cx, cy) || !roadAt(layout, nx, ny)) return false;
  eraseLink(layout, cx, cy, dir);
  eraseLink(layout, nx, ny, opposite(dir));
  if (state === 'both') paintRoadPath(layout, [[cx, cy], [nx, ny]]);
  else if (state === 'out') paintRoadPath(layout, [[cx, cy], [nx, ny]], { oneWay: true });
  else if (state === 'in') paintRoadPath(layout, [[nx, ny], [cx, cy]], { oneWay: true });
  return true;
}

/** Bit mask of the neighbours of cell (cx, cy) that are road cells (the structural signature of a road cell form). */
export function roadNeighbourMask(layout, cx, cy) {
  let mask = 0;
  for (let d = 0; d < 4; d++) if (roadAt(layout, cx + DX[d], cy + DY[d])) mask |= 1 << d;
  return mask;
}

/** Numbers behind the "Plant settings" summary. */
export function plantSummary(layout) {
  const { cols, rows, cellSize } = layout.grid;
  const byType = Object.fromEntries(STATION_TYPE_ORDER.map((t) => [t, 0]));
  for (const s of layout.stations) byType[s.type] += 1;
  return {
    byType,
    stations: layout.stations.length,
    roadCells: Object.keys(layout.roads).length,
    roadMeters: roadLengthMeters(layout),
    widthM: cols * cellSize,
    heightM: rows * cellSize,
    areaM2: cols * cellSize * rows * cellSize,
    vehicles: layout.fleets.reduce((sum, f) => sum + f.count, 0),
    fleets: layout.fleets.length,
    flows: layout.flows.length,
  };
}

const listJoin = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/**
 * What a grid resize would cost: compares the layout before with the dry-run result (resizeGrid on a clone).
 * `total` is 0 when nothing is lost or cut short; `text` is the sentence for the confirm dialog.
 */
export function describeResize(before, after) {
  const afterStations = new Map(after.stations.map((s) => [s.id, s]));
  const afterObstacles = new Map(after.obstacles.map((o) => [o.id, o]));
  const cut = (item, kept) => kept && (kept.w !== item.w || kept.h !== item.h);
  const roads = Object.keys(before.roads).length - Object.keys(after.roads).length;
  const stations = before.stations.length - after.stations.length;
  const obstacles = before.obstacles.length - after.obstacles.length;
  const labels = before.labels.length - after.labels.length;
  const flows = before.flows.length - after.flows.length;
  const clipped = before.stations.filter((s) => cut(s, afterStations.get(s.id))).length
    + before.obstacles.filter((o) => cut(o, afterObstacles.get(o.id))).length;
  const lost = [];
  if (roads) lost.push(plural(roads, 'road cell'));
  if (stations) lost.push(plural(stations, 'station') + (flows ? ` (with ${plural(flows, 'flow')})` : ''));
  if (obstacles) lost.push(plural(obstacles, 'obstacle'));
  if (labels) lost.push(plural(labels, 'label'));
  const sentences = [];
  if (lost.length) sentences.push(`This removes ${listJoin(lost)}.`);
  if (clipped) sentences.push(`${plural(clipped, 'station or obstacle', 'stations and obstacles')} at the edge will be cut shorter.`);
  return { roads, stations, obstacles, labels, flows, clipped, total: roads + stations + obstacles + labels + clipped, text: sentences.join(' ') };
}

/** Wording for the Breakdowns section from MTBF and MTTR in seconds (0 = never fails). */
export function breakdownSummary(mtbf, mttr) {
  if (!(mtbf > 0)) return { aside: 'never', hint: 'This workstation never breaks down.', warn: false };
  const every = `every ${humanSeconds(mtbf)}`;
  if (!(mttr > 0)) return { aside: every, hint: 'Also set a repair time, otherwise the breakdowns have no effect.', warn: true };
  const available = Math.round((mtbf / (mtbf + mttr)) * 100);
  return { aside: every, hint: `Breaks down about ${every} and needs ${humanSeconds(mttr)} to repair: available about ${available} % of the time.`, warn: false };
}

const STATE_TONE = { normal: 'busy', busy: 'busy', starved: 'starved', blocked: 'blocked', full: 'blocked', down: 'down', idle: 'idle' };
const STATE_LABEL = {
  source: { normal: 'Delivering', blocked: 'Yard is backing up' },
  process: { busy: 'Working', starved: 'Waiting for material', blocked: 'Output buffer full', down: 'Broken down' },
  storage: { normal: 'Open', full: 'Full' },
  sink: { normal: 'Receiving' },
  depot: { normal: 'In service' },
};
const FILL_LABEL = { source: 'Output buffer', process: 'Input buffer', storage: 'Stored', depot: 'Places used' };

/** Live status of a station runtime object (StationRT) as { tone, label, detail, fill, fillText }. */
export function stationStatus(rt) {
  const machines = rt.type === 'process' && Array.isArray(rt.machines) ? rt.machines : [];
  const working = machines.filter((m) => m.state === 'busy').length;
  const text = FILL_LABEL[rt.type] ? `${FILL_LABEL[rt.type]} ${rt.fillLabel}` : '';
  return {
    tone: STATE_TONE[rt.state] || 'idle',
    label: (STATE_LABEL[rt.type] || {})[rt.state] || 'Idle',
    detail: machines.length > 1 ? `${working} of ${machines.length} machines working` : '',
    fill: Math.min(1, Math.max(0, Number(rt.fill) || 0)),
    fillText: text,
  };
}

/** Delete the selected things from a layout draft; returns how many were removed. */
export function removeSelection(layout, kind, ids) {
  const remove = {
    station: removeStation,
    obstacle: removeObstacle,
    label: removeLabel,
    cell: (draft, key) => eraseRoadCell(draft, ...parseKey(key)),
  }[kind];
  return remove ? ids.filter((id) => remove(layout, id)).length : 0;
}

// ---------------------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------------------

/** A padded column for loose content, and an edge-to-edge column that holds the collapsible sections. */
const pad = (...children) => h('div', { class: 'stack', style: PAD }, ...children);
const flush = (...children) => h('div', { class: 'stack', style: { '--gap': '0' } }, ...children);

function actionButton(text, iconName, onclick, cls = 'btn btn--sm', title = null) {
  return h('button', { class: cls, type: 'button', onclick, title }, icon(iconName, { size: 14 }), text);
}

function typeChip(type) {
  const meta = STATION_TYPES[type];
  return h('span', { class: `chip chip--${type}`, title: meta.description },
    h('span', { class: `swatch tone-${type}` }), icon(type, { size: 14 }), typeName(type));
}

/** Read-only "label: value" rows whose values can be replaced in place. */
function readout(labels) {
  const values = labels.map(() => h('dd'));
  const el = h('dl', { class: 'kv' }, labels.flatMap((label, i) => [h('dt', null, label), values[i]]));
  return {
    el,
    set(texts) { texts.forEach((t, i) => { if (values[i].textContent !== t) values[i].textContent = t; }); },
  };
}

/** Re-render `host` only when the signature changed, so lists with buttons keep keyboard focus between updates. */
function keyedRender(host) {
  let last = null;
  return (signature, build) => {
    if (signature === last) return;
    last = signature;
    host.replaceChildren(...build());
  };
}

/** `section()` that remembers (in `memory`) whether the planner collapsed it, across form rebuilds. */
function rememberedSection(memory, title, aside, ...children) {
  const s = section({ title, aside, open: memory.get(title) !== false }, ...children);
  s.el.addEventListener('toggle', () => memory.set(title, s.el.open));
  return s;
}

function hintLine(text) {
  return h('p', { class: 'field__hint' }, text);
}

/** Show the station-state dot, label and buffer bar while a simulation exists. */
function createStatusStrip() {
  const dot = h('span', { class: 'dot dot--lg tone-idle' });
  const label = h('strong', null);
  const detail = h('span', { class: 'text-dim' });
  const fillText = h('span', { class: 'text-dim tnum' });
  const bar = h('div', { class: 'progress__bar' });
  const track = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Buffer fill', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
  const el = h('div', { class: 'card card--flat', hidden: true, 'aria-label': 'Live status', role: 'group' },
    h('div', { class: 'card__body stack', style: { '--gap': '6px' } },
      h('div', { class: 'row row--wrap' }, dot, label, detail),
      h('div', { class: 'row' }, h('div', { style: { flex: '1 1 auto' } }, track), fillText)));
  return {
    el,
    update(rt) {
      el.hidden = !rt;
      if (!rt) return;
      const s = stationStatus(rt);
      dot.className = `dot dot--lg tone-${s.tone}`;
      label.textContent = s.label;
      detail.textContent = s.detail ? `· ${s.detail}` : '';
      fillText.textContent = s.fillText;
      bar.style.setProperty('--w', `${Math.round(s.fill * 100)}%`);
      track.setAttribute('aria-valuenow', String(Math.round(s.fill * 100)));
      track.classList.toggle('progress--warn', s.fill >= 0.9);
      track.hidden = !s.fillText;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Edits shared by several forms
// ---------------------------------------------------------------------------------------------------------

/** Run a commit that deletes things; offers Undo in the toast while that edit is still the latest one. */
function deleteWithUndo(ctx, label, mutator, message) {
  if (!ctx.store.commit(label, mutator)) return;
  const after = ctx.store.getState().layout;
  ctx.toast(message, { kind: 'info', action: { label: 'Undo', onClick: () => { if (ctx.store.getState().layout === after) ctx.store.undo(); } } });
}

const NOUN = { station: 'station', obstacle: 'obstacle', label: 'label', cell: 'road cell', flow: 'flow', fleet: 'fleet' };

function deletedMessage(kind, ids, layout) {
  if (kind !== 'station') return `Deleted ${plural(ids.length, NOUN[kind])}.`;
  const flows = layout.flows.filter((f) => ids.includes(f.from) || ids.includes(f.to)).length;
  const what = ids.length === 1 ? quoted(getStation(layout, ids[0]).name) : plural(ids.length, 'station');
  return `Deleted ${what}${flows ? ` and ${plural(flows, 'flow')}` : ''}.`;
}

function deleteSelected(ctx, kind, ids) {
  const layout = ctx.store.getState().layout;
  const single = kind === 'station' && ids.length === 1;
  const label = single ? `Delete station ${quoted(getStation(layout, ids[0]).name)}` : `Delete ${plural(ids.length, NOUN[kind])}`;
  deleteWithUndo(ctx, label, (d) => { if (!removeSelection(d, kind, ids)) return false; }, deletedMessage(kind, ids, layout));
}

/** Copy stations to the nearest free spot and select the copies. */
function duplicateStations(ctx, ids) {
  const copies = [];
  const layout = ctx.store.getState().layout;
  const label = ids.length === 1 ? `Duplicate station ${quoted(getStation(layout, ids[0]).name)}` : `Duplicate ${plural(ids.length, 'station')}`;
  ctx.store.commit(label, (d) => {
    for (const id of ids) {
      const copy = duplicateStation(d, id);
      if (copy) copies.push(copy.id);
    }
    if (!copies.length) return false;
  });
  if (copies.length) ctx.store.select('station', copies);
  else ctx.toast('There is no free space for a copy.', { kind: 'warn' });
}

// ---------------------------------------------------------------------------------------------------------
// Station form
// ---------------------------------------------------------------------------------------------------------

const NUMBER_PARAM = { inline: true, controlW: INLINE_W, int: true, step: 1 };

/** A whole-number station parameter bound to `params[key]`. */
function paramNumber(env, key, opts) {
  const control = numberField({ ...NUMBER_PARAM, ...opts, value: env.initial.params[key], onChange: env.setParam(opts.what, key) });
  return env.bind(control, (st) => st.params[key]);
}

function sourceSections(env) {
  const { initial, setParam, bind, memory } = env;
  const arrivals = distField({ label: 'Time between arrivals', hint: 'How often a delivery reaches this dock.', value: initial.params.interArrival, onChange: setParam('arrival pattern', 'interArrival') });
  return [rememberedSection(memory, 'Deliveries', '',
    bind(arrivals, (st) => st.params.interArrival),
    paramNumber(env, 'batch', { label: 'Loads per arrival', unit: 'loads', min: 1, max: 100, what: 'loads per arrival', hint: 'Pallets or parts that arrive together.' }),
    paramNumber(env, 'startDelay', { label: 'Start delay', unit: 's', int: false, step: 'any', min: 0, max: 86400, what: 'start delay', hint: 'Quiet period at the start before the first delivery.' }),
    paramNumber(env, 'outCap', { label: 'Output buffer slots per destination', unit: 'loads', min: 1, max: 1000, what: 'output buffer', hint: 'Loads that can wait for pickup for each destination. When it is full, new arrivals queue up in the yard.' }))];
}

function processSections(env) {
  const { initial, setParam, bind, memory, syncs } = env;
  const cycle = distField({ label: 'Cycle time', hint: 'How long one machine needs for one cycle.', value: initial.params.cycle, onChange: setParam('cycle time', 'cycle') });
  const machines = stepperField({ label: 'Machines in parallel', min: 1, max: 100, value: initial.params.machines, controlW: INLINE_W, onChange: setParam('machine count', 'machines') });
  const toMinutes = (key) => (st) => round(st.params[key] / 60, 4);
  const mtbf = numberField({ label: 'Time between breakdowns', unit: 'min', inline: true, controlW: INLINE_W, min: 0, max: 100000, value: toMinutes('mtbf')(initial), hint: '0 = never breaks down.', onChange: (v) => setParam('breakdown interval', 'mtbf')(round(v * 60, 2)) });
  const mttr = numberField({ label: 'Repair time', unit: 'min', inline: true, controlW: INLINE_W, min: 0, max: 100000, value: toMinutes('mttr')(initial), onChange: (v) => setParam('repair time', 'mttr')(round(v * 60, 2)) });
  const summary = hintLine('');
  const breakdowns = rememberedSection(memory, 'Breakdowns', '', bind(mtbf, toMinutes('mtbf')), bind(mttr, toMinutes('mttr')), summary);
  syncs.push((st) => {
    const text = breakdownSummary(st.params.mtbf, st.params.mttr);
    breakdowns.setAside(text.aside);
    summary.textContent = text.hint;
    summary.style.color = text.warn ? 'var(--warn-text)' : '';
  });
  return [
    rememberedSection(memory, 'Work', '',
      bind(cycle, (st) => st.params.cycle),
      bind(machines, (st) => st.params.machines),
      paramNumber(env, 'outPerCycle', { label: 'Loads produced per cycle', unit: 'loads', min: 1, max: 100, what: 'loads per cycle', hint: 'Finished loads that leave at the end of each cycle.' })),
    rememberedSection(memory, 'Buffers', '',
      paramNumber(env, 'inCap', { label: 'Input slots per incoming flow', unit: 'loads', min: 1, max: 1000, what: 'input buffer', hint: 'Loads that can wait at the machine for each incoming flow.' }),
      paramNumber(env, 'outCap', { label: 'Output slots per outgoing flow', unit: 'loads', min: 1, max: 1000, what: 'output buffer', hint: 'Finished loads waiting for pickup, per outgoing flow. When full, the machine is blocked.' })),
    breakdowns,
  ];
}

function storageSections(env) {
  return [rememberedSection(env.memory, 'Storage', '',
    paramNumber(env, 'capacity', { label: 'Capacity', unit: 'loads', min: 1, max: 100000, what: 'capacity', hint: 'Total loads the storage can hold. When it is full, deliveries have to wait.' }),
    paramNumber(env, 'dwell', { label: 'Minimum dwell time', unit: 's', int: false, step: 'any', min: 0, max: 1e6, what: 'dwell time', hint: 'How long a load must stay before it may leave (cooling, curing). 0 = available at once.' }))];
}

function sinkSections(env) {
  return [rememberedSection(env.memory, 'Goods out', '',
    hintLine('Finished loads that arrive here leave the plant and count towards throughput. There is nothing to set up.'))];
}

function depotSections(env) {
  const { initial, memory, syncs, bind } = env;
  const slots = paramNumber(env, 'slots', { label: 'Parking slots', unit: 'places', min: 1, max: 1000, what: 'parking slots', hint: 'How many idle vehicles can park here, off the road.' });
  // The charger limit is the number of parking slots and numberField fixes its limits when it is built: rebuild it when the slots change.
  const host = h('div');
  let limit = -1;
  let chargers = null;
  const mountChargers = (st) => {
    limit = st.params.slots;
    chargers = numberField({ ...NUMBER_PARAM, label: 'Charging slots', unit: 'places', min: 0, max: limit, value: st.params.chargers, onChange: env.setParam('charging slots', 'chargers'), hint: 'Parking places that can charge a battery at the same time.' });
    host.replaceChildren(chargers.el);
  };
  mountChargers(initial);
  syncs.push((st) => {
    if (st.params.slots !== limit && !host.contains(document.activeElement)) mountChargers(st);
    else chargers.set(st.params.chargers);
  });
  return [rememberedSection(memory, 'Parking and charging', '', slots, host)];
}

const SECTION_BUILDERS = { source: sourceSections, process: processSections, storage: storageSections, sink: sinkSections, depot: depotSections };

function sizeSection(env, ctx) {
  const { initial, bind, memory, syncs, id } = env;
  const { store } = ctx;
  const stepperFor = (axis, label) => stepperField({ label, min: 1, max: 99, value: initial[axis], controlW: INLINE_W, onChange: (n) => resize({ [axis]: n }) });
  const width = stepperFor('w', 'Width (cells)');
  const height = stepperFor('h', 'Height (cells)');
  const note = hintLine('');
  const where = readout(['Position']);

  function resize(patch) {
    let rejected = false;
    const name = getStation(store.getState().layout, id).name;
    store.commit(`Resize station ${quoted(name)}`, (d) => {
      const s = getStation(d, id);
      rejected = !resizeStation(d, id, { x: s.x, y: s.y, w: s.w, h: s.h, ...patch });
      if (rejected) return false;
    }, { coalesce: `size:${id}` });
    if (!rejected) return;
    const s = getStation(store.getState().layout, id);
    const { cols, rows } = store.getState().layout.grid;
    const beyondEdge = s.x + (patch.w ?? s.w) > cols || s.y + (patch.h ?? s.h) > rows;
    ctx.toast(beyondEdge ? 'That would go past the edge of the plant.' : 'Something is in the way. Move the neighbouring station, obstacle or road first.', { kind: 'warn' });
    width.set(s.w);
    height.set(s.h);
  }

  syncs.push((st, state) => {
    const size = state.layout.grid.cellSize;
    note.textContent = `${formatNumber(st.w * size, 1)} × ${formatNumber(st.h * size, 1)} m on the plan`;
    where.set([`column ${st.x}, row ${st.y}`]);
  });
  return rememberedSection(memory, 'Size and position', '', bind(width, (st) => st.w), bind(height, (st) => st.h), note, where.el);
}

function flowsSection(env, ctx) {
  const { memory, syncs, id } = env;
  const list = h('div', { class: 'stack', style: { '--gap': '4px' } });
  const render = keyedRender(list);
  const sec = rememberedSection(memory, 'Connected flows', '', list);
  const addButton = actionButton('Add a flow', 'flow', () => ctx.actions.setTool('flow'));

  const row = (f, layout) => {
    const a = getStation(layout, f.from);
    const b = getStation(layout, f.to);
    return h('button', {
      class: 'btn btn--ghost btn--sm', type: 'button', style: { justifyContent: 'flex-start', width: '100%' },
      title: 'Select this flow', onclick: () => ctx.store.select('flow', [f.id]),
    }, icon('flow', { size: 14 }),
    h('span', { class: 'truncate', style: { minWidth: 0 } }, `${a.name} → ${b.name}`),
    h('span', { class: 'spacer' }),
    h('span', { class: 'chip chip--outline', title: 'Relative share of the origin’s output' }, `weight ${formatNumber(f.weight, 2)}`));
  };

  syncs.push((st, state) => {
    const flows = [...flowsTo(state.layout, id), ...flowsFrom(state.layout, id)];
    sec.setAside(flows.length ? String(flows.length) : '');
    const signature = JSON.stringify(flows.map((f) => [f.id, getStation(state.layout, f.from).name, getStation(state.layout, f.to).name, f.weight]));
    render(signature, () => (flows.length
      ? flows.map((f) => row(f, state.layout))
      : [hintLine('No flows yet. A flow says where this station’s loads come from or go to.'), h('div', null, addButton)]));
  });
  return sec;
}

function docksLine(env) {
  const host = h('div', { class: 'row row--wrap' });
  const render = keyedRender(host);
  env.syncs.push((st, state) => {
    const n = docksOf(state.layout, env.id).length;
    render(String(n), () => (n
      ? [icon('road', { size: 14 }), h('span', { class: 'text-dim' }, `${plural(n, 'road cell')} touch${n === 1 ? 'es' : ''} this station`)]
      : [h('span', { class: 'chip chip--warn' }, icon('warning', { size: 14 }), 'No road touches this station'),
        h('span', { class: 'text-dim' }, 'Vehicles cannot load or unload here.')]));
  });
  host.setAttribute('aria-live', 'polite');
  return host;
}

/** The whole form of one station. */
function stationView(ctx, initial, memory) {
  const { store } = ctx;
  const id = initial.id;
  const syncs = [];
  const env = { initial, id, memory, syncs };
  const current = () => getStation(store.getState().layout, id);
  const label = (what) => `Change ${what} of ${quoted(current().name)}`;
  env.bind = (control, read) => { syncs.push((st) => control.set(read(st))); return control.el; };
  env.setParam = (what, key) => (value) => store.commit(label(what), (d) => updateStation(d, id, { params: { [key]: value } }), { coalesce: `param:${id}:${key}` });

  const name = textField({ label: 'Name', value: initial.name, maxLength: 80, onChange: (v) => store.commit(`Rename station ${quoted(current().name)}`, (d) => updateStation(d, id, { name: v }), { coalesce: `name:${id}` }) });
  const strip = createStatusStrip();
  syncs.push((st) => name.set(st.name));
  syncs.push(() => strip.update(ctx.runner?.sim?.logistics?.stationById?.get(id) || null));

  const header = pad(
    h('div', { class: 'row row--wrap' }, typeChip(initial.type), h('span', { class: 'spacer' }),
      actionButton('Duplicate', 'copy', () => duplicateStations(ctx, [id]), 'btn btn--sm', 'Duplicate (Ctrl+D)'),
      actionButton('Delete', 'trash', () => deleteSelected(ctx, 'station', [id]), 'btn btn--sm btn--danger-ghost', 'Delete (Del)')),
    name.el, strip.el, docksLine(env));
  const sections = SECTION_BUILDERS[initial.type](env).map((s) => s.el);
  const flows = initial.type === 'depot' ? null : flowsSection(env, ctx).el; // depots take part in no flows
  const el = flush(header, ...sections, sizeSection(env, ctx).el, flows);
  return { el, update(state) { const st = getStation(state.layout, id); if (st) for (const sync of syncs) sync(st, state); } };
}

// ---------------------------------------------------------------------------------------------------------
// Obstacle, label, road cell
// ---------------------------------------------------------------------------------------------------------

const OBSTACLE_LABELS = { wall: 'Wall', rack: 'Rack', column: 'Column' };

function obstacleView(ctx, initial) {
  const { store } = ctx;
  const id = initial.id;
  const where = readout(['Position']);
  const patch = (what, p) => {
    let rejected = false;
    store.commit(`Change obstacle ${what}`, (d) => { rejected = !updateObstacle(d, id, p); if (rejected) return false; }, { coalesce: `obstacle:${id}:${what}` });
    if (rejected) {
      ctx.toast('Something is in the way. Move the neighbouring station, obstacle or road first.', { kind: 'warn' });
      sync(store.getState());
    }
  };
  const kind = segmentedField({ label: 'Kind', value: initial.kind, options: OBSTACLE_KINDS.map((k) => ({ value: k, label: OBSTACLE_LABELS[k] })), onChange: (k) => patch('kind', { kind: k }) });
  const width = stepperField({ label: 'Width (cells)', min: 1, max: 99, value: initial.w, controlW: INLINE_W, onChange: (n) => patch('size', { w: n }) });
  const height = stepperField({ label: 'Height (cells)', min: 1, max: 99, value: initial.h, controlW: INLINE_W, onChange: (n) => patch('size', { h: n }) });
  const el = flush(
    pad(h('div', { class: 'row' }, h('span', { class: 'chip chip--outline' }, icon('obstacle', { size: 14 }), 'Obstacle'), h('span', { class: 'spacer' }),
      actionButton('Delete', 'trash', () => deleteSelected(ctx, 'obstacle', [id]), 'btn btn--sm btn--danger-ghost')),
    kind.el, width.el, height.el, where.el,
    hintLine('Vehicles cannot drive through obstacles, and roads cannot be drawn over them.')));
  function sync(state) {
    const o = state.layout.obstacles.find((e) => e.id === id);
    if (!o) return;
    kind.set(o.kind);
    width.set(o.w);
    height.set(o.h);
    where.set([`column ${o.x}, row ${o.y}`]);
  }
  return { el, update: sync };
}

function labelView(ctx, initial) {
  const { store } = ctx;
  const id = initial.id;
  const where = readout(['Position']);
  const edit = (what, p) => store.commit(`Change label ${what}`, (d) => updateLabel(d, id, p), { coalesce: `label:${id}:${what}` });
  const text = textField({ label: 'Text', value: initial.text, maxLength: 200, onChange: (v) => edit('text', { text: v }) });
  const size = numberField({ label: 'Text size', unit: 'cells', inline: true, controlW: INLINE_W, min: 0.25, max: 8, value: initial.size ?? 1, hint: 'Height of the letters, in grid cells.', onChange: (v) => edit('size', { size: v }) });
  const el = flush(
    pad(h('div', { class: 'row' }, h('span', { class: 'chip chip--outline' }, icon('label', { size: 14 }), 'Label'), h('span', { class: 'spacer' }),
      actionButton('Delete', 'trash', () => deleteSelected(ctx, 'label', [id]), 'btn btn--sm btn--danger-ghost')),
    text.el, size.el, where.el));
  return {
    el,
    update(state) {
      const l = state.layout.labels.find((e) => e.id === id);
      if (!l) return;
      text.set(l.text);
      size.set(l.size ?? 1);
      where.set([`column ${formatNumber(l.x, 2)}, row ${formatNumber(l.y, 2)}`]);
    },
  };
}

function cellView(ctx, key) {
  const { store } = ctx;
  const [cx, cy] = parseKey(key);
  const start = store.getState().layout;
  const links = [];
  for (let dir = 0; dir < 4; dir++) {
    if (!roadAt(start, cx + DX[dir], cy + DY[dir])) continue;
    const control = selectField({
      label: `${DIR_ARROWS[dir]} To the ${DIR_WORDS[dir]}`, inline: true, controlW: '188px', options: LINK_OPTIONS, value: linkState(start, cx, cy, dir),
      onChange: (state) => store.commit('Change road direction', (d) => setLinkState(d, cx, cy, dir, state)),
    });
    links.push({ dir, control });
  }
  const limit = rangeField({
    label: 'Speed limit', min: 10, max: 100, step: 5, value: Math.round((roadAt(start, cx, cy)?.limit ?? 1) * 100), resetValue: 100,
    format: (v) => `${v} %`, hint: 'Vehicles slow down to this share of their normal speed on this cell: crossings, tight corners, pedestrian zones.',
    onChange: (v) => store.commit('Change speed limit', (d) => setRoadLimit(d, cx, cy, v / 100), { coalesce: `limit:${key}` }),
  });
  const info = readout(['Position', 'Dock of']);
  const el = flush(
    pad(h('div', { class: 'row' }, h('span', { class: 'chip chip--outline' }, icon('road', { size: 14 }), 'Road cell'), h('span', { class: 'spacer' }),
      actionButton('Remove road cell', 'trash', () => deleteSelected(ctx, 'cell', [key]), 'btn btn--sm btn--danger-ghost')),
    info.el),
    section({ title: 'Directions' },
      ...(links.length ? links.map((l) => l.control.el) : [hintLine('No neighbouring road cells, so this is a lone plate. Draw a road next to it to connect it.')]),
      links.length ? hintLine('Vehicles only drive from cell to cell along links.') : null).el,
    pad(limit.el));
  return {
    el,
    update(state) {
      const road = roadAt(state.layout, cx, cy);
      if (!road) return;
      for (const { dir, control } of links) control.set(linkState(state.layout, cx, cy, dir));
      limit.set(Math.round(road.limit * 100));
      const docks = state.layout.stations.filter((s) => docksOf(state.layout, s.id).some(([x, y]) => x === cx && y === cy));
      info.set([`column ${cx}, row ${cy}`, docks.length ? docks.map((s) => s.name).join(', ') : 'No station']);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Flow, fleet and multi-selection summaries
// ---------------------------------------------------------------------------------------------------------

const PRIORITY_TEXT = { 1: 'Normal', 2: 'High', 3: 'Urgent' };

/** A read-only summary of a flow or fleet (no inputs, so it may be rebuilt whenever its data change) with a jump to the editing tab. */
function summaryView(ctx, { describe, tab, buttonLabel }) {
  const host = h('div', { class: 'stack', style: PAD });
  const draw = keyedRender(host);
  return {
    el: host,
    update(state) {
      const info = describe(state.layout);
      draw(JSON.stringify(info), () => [
        h('div', { class: 'row' }, h('span', { class: 'chip chip--outline' }, icon(info.icon, { size: 14 }), info.kind), h('strong', { class: 'truncate', style: { minWidth: 0 } }, info.title)),
        h('dl', { class: 'kv' }, info.rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        h('div', null, actionButton(buttonLabel, 'edit', () => ctx.actions.setRightTab(tab))),
      ]);
    },
  };
}

function describeFlow(id) {
  return (layout) => {
    const flow = getFlow(layout, id);
    const a = getStation(layout, flow.from);
    const b = getStation(layout, flow.to);
    const fleet = flow.fleetId ? getFleet(layout, flow.fleetId) : null;
    const siblings = flowsFrom(layout, flow.from);
    const share = flow.weight / siblings.reduce((sum, f) => sum + f.weight, 0);
    const batch = flow.batchMax > 0 ? `${flow.batchMin} to ${flow.batchMax} loads` : `${flow.batchMin}+ loads (up to a full vehicle)`;
    const rows = [
      [`Share of ${a.name}\u2019s output`, `${formatPercent(share)} (weight ${formatNumber(flow.weight, 2)})`],
      ['Loads per cycle', formatNumber(flow.perCycle)], ['Loads per trip', batch], ['Priority', PRIORITY_TEXT[flow.priority] || 'Normal'],
      ['Vehicles', fleet ? fleet.name : 'Any fleet'],
    ];
    if (flow.maxWait > 0) rows.splice(3, 0, ['Longest wait for a batch', humanSeconds(flow.maxWait)]);
    return { kind: 'Flow', icon: 'flow', title: `${a.name} \u2192 ${b.name}`, rows };
  };
}

function describeFleet(id) {
  return (layout) => {
    const f = getFleet(layout, id);
    const home = f.home ? getStation(layout, f.home) : null;
    return {
      kind: 'Fleet', icon: f.preset === 'forklift' ? 'forklift' : 'truck', title: f.name,
      rows: [
        ['Vehicles', `${f.count} \u00d7 ${(FLEET_PRESETS[f.preset] || FLEET_PRESETS.custom).label.split(' (')[0]}`],
        ['Top speed', `${formatNumber(f.speed, 1)} m/s (${formatNumber(f.speed * 3.6, 1)} km/h)`], ['Carries', plural(f.capacity, 'load')],
        ['Home depot', home ? home.name : 'None'], ['When idle', f.idle === 'park' ? 'Park in a depot' : 'Wait on the road'],
        ['Battery', f.battery.enabled ? `${humanSeconds(f.battery.runtimeMin * 60)} per charge` : 'Not modelled'],
      ],
    };
  };
}

function multiView(ctx, kind, ids) {
  const { store } = ctx;
  const layout = store.getState().layout;
  const breakdown = kind === 'station'
    ? STATION_TYPE_ORDER.map((t) => [t, ids.filter((id) => getStation(layout, id)?.type === t).length]).filter(([, n]) => n)
    : [];
  const tab = { flow: ['flows', 'Edit in Flows tab'], fleet: ['fleet', 'Edit in Fleet tab'] }[kind];
  const el = pad(
    h('div', { class: 'row' }, h('strong', null, `${plural(ids.length, NOUN[kind])} selected`)),
    breakdown.length ? h('div', { class: 'row row--wrap' }, breakdown.map(([t, n]) => h('span', { class: `chip chip--${t}` }, h('span', { class: `swatch tone-${t}` }), `${n} ${typeName(t, n)}`))) : null,
    h('div', { class: 'row row--wrap' },
      kind === 'station' ? actionButton('Duplicate', 'copy', () => duplicateStations(ctx, ids)) : null,
      tab ? actionButton(tab[1], 'edit', () => ctx.actions.setRightTab(tab[0])) : actionButton('Delete', 'trash', () => deleteSelected(ctx, kind, ids), 'btn btn--sm btn--danger-ghost')),
    hintLine('Select a single item to edit its properties.'));
  return { el, update() {} };
}

// ---------------------------------------------------------------------------------------------------------
// Plant settings (nothing selected)
// ---------------------------------------------------------------------------------------------------------

async function applyGrid(ctx, cols, rows, restore) {
  const { store } = ctx;
  const layout = store.getState().layout;
  if (cols === layout.grid.cols && rows === layout.grid.rows) return;
  const probe = cloneLayout(layout);
  const { removed } = resizeGrid(probe, cols, rows);
  const loss = describeResize(layout, probe);
  if (removed > 0 || loss.total > 0) {
    const ok = await ctx.dialogs.confirm({
      title: 'Make the plant smaller?',
      text: `The plant becomes ${cols} × ${rows} cells. ${loss.text} You can undo this afterwards.`,
      confirmLabel: 'Make it smaller', danger: true,
    });
    if (!ok) { restore(); return; }
  }
  store.commit(`Resize plant to ${cols} × ${rows}`, (d) => { resizeGrid(d, cols, rows); });
}

function summaryBlock() {
  const chips = h('div', { class: 'row row--wrap' });
  const draw = keyedRender(chips);
  const facts = readout(['Road network', 'Floor area', 'Vehicles', 'Flows']);
  let lastLayout = null;
  return {
    el: h('div', { class: 'stack', style: { '--gap': '8px' } }, chips, facts.el),
    update(layout) {
      if (layout === lastLayout) return; // layouts are immutable snapshots: the summary only changes with a new one
      lastLayout = layout;
      const s = plantSummary(layout);
      draw(JSON.stringify(s.byType), () => (s.stations
        ? STATION_TYPE_ORDER.filter((t) => s.byType[t]).map((t) => h('span', { class: `chip chip--${t}` }, h('span', { class: `swatch tone-${t}` }), `${s.byType[t]} ${typeName(t, s.byType[t])}`))
        : [h('span', { class: 'text-dim' }, 'No stations yet. Pick a station in the toolbar and click on the plan.')]));
      facts.set([
        s.roadCells ? `${formatDistance(s.roadMeters)} (${plural(s.roadCells, 'cell')})` : 'None yet',
        `${formatNumber(s.widthM, 1)} × ${formatNumber(s.heightM, 1)} m = ${formatNumber(s.areaM2)} m²`,
        s.vehicles ? `${s.vehicles} in ${plural(s.fleets, 'fleet')}` : 'None yet',
        String(s.flows),
      ]);
    },
  };
}

function plantView(ctx, memory) {
  const { store } = ctx;
  const start = store.getState().layout;
  const commit = (label, fn, key) => store.commit(label, fn, { coalesce: `plant:${key}` });
  // One name for the planner: this is the project name of the top bar, which also names the file, the window and the report.
  const name = textField({ label: 'Plant name', value: store.getState().project.name, maxLength: 80, onChange: (v) => { store.renameProject(v); } });
  const notes = textField({ label: 'Notes', value: start.notes, multiline: true, rows: 4, maxLength: 20000, hint: 'Assumptions, sources, open questions. Saved with the plant and included in the report.', onChange: (v) => commit('Edit plant notes', (d) => setNotes(d, v), 'notes') });

  const gridField = (label, key, limits) => {
    const control = numberField({ label, unit: 'cells', int: true, step: 1, min: limits[0], max: limits[1], value: start.grid[key] });
    control.input.addEventListener('change', () => {
      const cols = key === 'cols' ? Number(control.input.value) : store.getState().layout.grid.cols;
      const rows = key === 'rows' ? Number(control.input.value) : store.getState().layout.grid.rows;
      applyGrid(ctx, cols, rows, () => {
        // a declined change is an explicit answer, so the text goes back even if the field still has focus
        const value = store.getState().layout.grid[key];
        control.set(value);
        control.input.value = String(value);
      });
    });
    return control;
  };
  const cols = gridField('Columns', 'cols', [GRID_LIMITS.minCols, GRID_LIMITS.maxCols]);
  const rows = gridField('Rows', 'rows', [GRID_LIMITS.minRows, GRID_LIMITS.maxRows]);
  const cell = numberField({ label: 'Metres per cell', unit: 'm', min: GRID_LIMITS.minCell, max: GRID_LIMITS.maxCell, value: start.grid.cellSize, hint: 'The scale of the plan: the real length of one grid square. It sets all distances, so travel times change with it.', onChange: (v) => commit('Change plant scale', (d) => setCellSize(d, v), 'cellSize') });
  const handedness = segmentedField({
    label: 'Lane side', value: start.settings.handedness,
    options: [{ value: 'right', label: 'Right-hand traffic' }, { value: 'left', label: 'Left-hand traffic' }],
    onChange: (v) => store.commit('Change lane side', (d) => updateSettings(d, { handedness: v })),
  });
  handedness.el.append(hintLine('Which side of a two-way road vehicles drive on.'));
  const summary = summaryBlock();

  const el = flush(
    pad(h('div', { class: 'row' }, h('span', { class: 'eyebrow' }, 'Plant settings'), h('span', { class: 'spacer' }),
      actionButton('Fit view', 'fit', () => ctx.actions.fitView())), summary.el),
    rememberedSection(memory, 'Plant', '', name.el, notes.el).el,
    rememberedSection(memory, 'Grid and scale', '', h('div', { class: 'field-grid' }, cols.el, rows.el), cell.el, handedness.el).el);

  return {
    el,
    update(state) {
      const { layout } = state;
      name.set(state.project.name);
      notes.set(layout.notes);
      for (const [control, key] of [[cols, 'cols'], [rows, 'rows']]) if (document.activeElement !== control.input) control.set(layout.grid[key]);
      cell.set(layout.grid.cellSize);
      handedness.set(layout.settings.handedness);
      summary.update(layout);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------------------

/** Which form the selection needs: { signature, create() } (the signature changes only when the form's structure does). */
function planFor(ctx, state, memory) {
  const { kind, ids } = state.ui.selection;
  const { layout } = state;
  if (!kind) return { signature: 'plant', create: () => plantView(ctx, memory) };
  if (ids.length > 1) return { signature: `multi:${kind}:${ids.join(',')}`, create: () => multiView(ctx, kind, ids) };
  const id = ids[0];
  if (kind === 'station') {
    const st = getStation(layout, id);
    if (st) return { signature: `station:${id}:${st.type}`, create: () => stationView(ctx, st, memory) };
  } else if (kind === 'obstacle') {
    const o = layout.obstacles.find((e) => e.id === id);
    if (o) return { signature: `obstacle:${id}`, create: () => obstacleView(ctx, o) };
  } else if (kind === 'label') {
    const l = layout.labels.find((e) => e.id === id);
    if (l) return { signature: `label:${id}`, create: () => labelView(ctx, l) };
  } else if (kind === 'cell') {
    const [cx, cy] = parseKey(id);
    if (roadAt(layout, cx, cy)) return { signature: `cell:${id}:${roadNeighbourMask(layout, cx, cy)}`, create: () => cellView(ctx, id) };
  } else if (kind === 'flow' && getFlow(layout, id)) {
    return { signature: `flow:${id}`, create: () => summaryView(ctx, { describe: describeFlow(id), tab: 'flows', buttonLabel: 'Edit in Flows tab' }) };
  } else if (kind === 'fleet' && getFleet(layout, id)) {
    return { signature: `fleet:${id}`, create: () => summaryView(ctx, { describe: describeFleet(id), tab: 'fleet', buttonLabel: 'Edit in Fleet tab' }) };
  }
  return { signature: 'plant', create: () => plantView(ctx, memory) };
}

/**
 * Create the Properties panel.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): store, runner, toast, dialogs.confirm, actions.{setRightTab, setTool, fitView}
 * @returns {{ el: HTMLElement, update(state: object): void, destroy(): void }}
 */
export function createInspectorPanel(ctx) {
  const memory = new Map();
  const guide = createGuidanceHeader(ctx, { checklist: true, follow: true }); // Next steps (and, with nothing selected, Getting started)
  const form = h('div');
  const el = h('div', { 'data-panel': 'inspector' }, guide.el, form);
  let view = null;
  let signature = null;
  let resync = null;

  function update(state) {
    guide.update(state);
    const plan = planFor(ctx, state, memory);
    if (plan.signature !== signature) {
      view = plan.create();
      signature = plan.signature;
      form.replaceChildren(view.el);
    }
    view.update(state);
  }

  // A field that was being typed in may hold text the model rejected or clamped: show the real value once the planner leaves it.
  el.addEventListener('focusout', () => {
    clearTimeout(resync);
    resync = setTimeout(() => update(ctx.store.getState()), 0);
  });

  update(ctx.store.getState());
  return { el, update, destroy() { clearTimeout(resync); guide.destroy(); el.remove(); } };
}
