// Flows panel (docs/ARCHITECTURE.md 6.5): where loads go next. A form at the top adds one flow between two stations (only
// valid endpoints are offered, and a disabled button always says why) or a whole chain of stations in order; below it a card
// per flow with its settings, and a small bar that shows how each station splits its output over its outgoing flows.
//
//   const panel = createFlowsPanel(ctx);   // ctx: see docs/ARCHITECTURE.md 6.8
//   container.append(panel.el);  panel.update(store.getState());  // on every store change
//
// Cards are built once per flow and afterwards only refreshed in place (the golden rule of fields.js). Every edit is a
// store.commit with a readable label; typing commits with a `coalesce` key so a burst of edits is one undo step. Using a
// card selects the flow on the plan and selecting a flow on the plan highlights, opens and scrolls to its card. Pure helpers
// (endpoint rules, output shares, chain planning, wording) are exported and unit-tested in tests/ui.panels2.test.js.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { getStation, getFleet, getFlow, flowsFrom, addFlow, updateFlow, removeFlow } from '../../model/layout.js';
import { formatNumber } from '../../util/format.js';
import { numberField, selectField, segmentedField, section, emptyState, humanSeconds } from './fields.js';
import { createGuidanceHeader, forFlows } from './nextsteps.js';
import { createServedBy, createVehiclesExplainer } from './jobs-view.js';
import { percentages } from './jobs-info.js';

const INLINE_W = '120px';
const quoted = (name) => `“${name}”`;
const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const hintLine = (text) => h('p', { class: 'field__hint' }, text);

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

/** Station types that may send loads / receive loads (docs/ARCHITECTURE.md 4.3; layout.js addFlow enforces the same). */
export const SENDERS = Object.freeze(['source', 'process', 'storage']);
export const RECEIVERS = Object.freeze(['process', 'storage', 'sink']);

const TYPE_NAMES = { source: 'Goods in', process: 'Workstation', storage: 'Storage', sink: 'Goods out', depot: 'Depot' };
/** Planner name of a station type: "Goods in", "Workstation", "Storage", "Goods out", "Depot". */
export const typeName = (type) => TYPE_NAMES[type] || type;

export const PRIORITIES = Object.freeze([{ value: 1, label: 'Normal' }, { value: 2, label: 'High' }, { value: 3, label: 'Urgent' }]);
const PRIORITY_TEXT = { 1: 'Normal priority', 2: 'High priority', 3: 'Urgent' };

/**
 * Why a flow from station `fromId` to station `toId` cannot be added, as a sentence for the planner, or null when it can.
 * With `allowExisting` a flow that is already there is not a problem (the chain helper skips those).
 */
export function pairProblem(layout, fromId, toId, { allowExisting = false } = {}) {
  const from = getStation(layout, fromId);
  const to = getStation(layout, toId);
  if (!from) return 'Pick the station where the loads start.';
  if (!to) return 'Pick the station the loads go to.';
  if (from.id === to.id) return 'A station cannot send loads to itself.';
  if (!SENDERS.includes(from.type)) return `${typeName(from.type)} cannot send loads.`;
  if (!RECEIVERS.includes(to.type)) return `${typeName(to.type)} cannot receive loads.`;
  if (!allowExisting && layout.flows.some((f) => f.from === from.id && f.to === to.id)) return `There is already a flow from ${from.name} to ${to.name}.`;
  return null;
}

/** Stations that can start a flow / end one, in layout order. */
export const senders = (layout) => layout.stations.filter((s) => SENDERS.includes(s.type));
export const receivers = (layout) => layout.stations.filter((s) => RECEIVERS.includes(s.type));

/** Sentence for a disabled "Add flow" button when the plant lacks the stations, or null when both lists have entries. */
export function missingStations(layout) {
  if (!senders(layout).length) return 'Place a Goods in, Workstation or Storage on the plan first: only those stations send loads.';
  if (!receivers(layout).length) return 'Place a Workstation, Storage or Goods out on the plan first: only those stations receive loads.';
  return null;
}

/** Whole percentages of the weights that add up to exactly 100 (largest remainder), all 0 when there is no weight (lives in jobs-info.js, shared with the Properties tab). */
export { percentages };

/** Stations with several outgoing flows and each flow's share of their output: [{ station, shares: [{ flow, to, percent }] }]. */
export function outputSplits(layout) {
  const splits = [];
  for (const station of layout.stations) {
    const flows = flowsFrom(layout, station.id);
    if (flows.length < 2) continue;
    const percent = percentages(flows.map((f) => f.weight));
    splits.push({ station, shares: flows.map((flow, i) => ({ flow, to: getStation(layout, flow.to), percent: percent[i] })) });
  }
  return splits;
}

/** Share of the origin's output that goes along `flow`, in whole percent (100 when it is the only flow). */
export function outputShare(layout, flow) {
  const siblings = flowsFrom(layout, flow.from);
  return percentages(siblings.map((f) => f.weight))[siblings.findIndex((f) => f.id === flow.id)] ?? 100;
}

/** One line for a collapsed flow card: "67 % of output · 2 per cycle · Urgent · Forklifts" (`withFleet: false` leaves the vehicles out: the card's "Served by" line says it). */
export function flowSummary(layout, flow, { withFleet = true } = {}) {
  const parts = [flowsFrom(layout, flow.from).length > 1 ? `${outputShare(layout, flow)} % of output` : 'All output'];
  const to = getStation(layout, flow.to);
  if (to && to.type === 'process' && flow.perCycle > 1) parts.push(`${flow.perCycle} per cycle`);
  if (flow.priority > 1) parts.push(PRIORITY_TEXT[flow.priority] || 'High priority');
  const fleet = flow.fleetId ? getFleet(layout, flow.fleetId) : null;
  if (withFleet) parts.push(fleet ? fleet.name : 'any fleet');
  return parts.join(' · ');
}

/** Hint under the weight field: what the weight means for this origin right now. */
export function weightHint(layout, flow) {
  const from = getStation(layout, flow.from);
  const siblings = flowsFrom(layout, flow.from);
  if (siblings.length < 2) return `${from.name} has only this one flow, so all its loads go here. Weights only matter once it has two or more flows.`;
  return `${outputShare(layout, flow)} % of the loads from ${from.name} go this way. Weights are relative: 2 and 1 mean two thirds and one third.`;
}

/** Stations that may come after the last one of a chain (or start it): senders first, then receivers that are not in the chain yet. */
export function chainChoices(layout, chain) {
  if (!chain.length) return senders(layout);
  const last = getStation(layout, chain[chain.length - 1]);
  if (!last || !SENDERS.includes(last.type)) return [];
  return receivers(layout).filter((s) => !chain.includes(s.id));
}

/** What creating the flows of a chain would do: { pairs: [[from, to]] new flows, existing: how many are there already, problem }. */
export function chainPlan(layout, chain) {
  const plan = { pairs: [], existing: 0, problem: null };
  for (let i = 0; i + 1 < chain.length; i++) {
    const problem = pairProblem(layout, chain[i], chain[i + 1], { allowExisting: true });
    if (problem) plan.problem = plan.problem || problem;
    else if (layout.flows.some((f) => f.from === chain[i] && f.to === chain[i + 1])) plan.existing += 1;
    else plan.pairs.push([chain[i], chain[i + 1]]);
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------------------

/** Station chip with the type colour; the name is the only part that shrinks. */
function stationChip(station) {
  const name = h('span', { class: 'truncate' }, station.name);
  const el = h('span', { class: `chip chip--${station.type}`, style: { minWidth: 0, maxWidth: '100%' }, title: `${typeName(station.type)}: ${station.name}` },
    h('span', { class: `swatch tone-${station.type}` }), name);
  return { el, setName(text) { if (name.textContent !== text) { name.textContent = text; el.title = `${typeName(station.type)}: ${text}`; } } };
}

function actionButton(text, iconName, onclick, cls = 'btn btn--sm') {
  return h('button', { class: cls, type: 'button', onclick }, icon(iconName, { size: 14 }), text);
}

/** Re-render `host` only when the signature changed, so buttons inside keep keyboard focus between updates. */
function keyedRender(host) {
  let last = null;
  return (signature, build) => {
    if (signature === last) return;
    last = signature;
    host.replaceChildren(...build());
  };
}

/** Replace the hint under a field built by fields.js (the field must have been built with some hint text). */
function setHint(control, text) {
  control.el.querySelector('.field__hint').textContent = text;
}

const stationLabel = (s) => `${s.name} (${typeName(s.type)})`;
const optionKey = (options) => options.map((o) => `${o.value}|${o.label}|${!!o.disabled}`).join(';');

// ---------------------------------------------------------------------------------------------------------
// "Add a flow" form
// ---------------------------------------------------------------------------------------------------------

/** Why the Add button is disabled (a sentence for the planner), or null. `targets`: the receivers offered for this start. */
function addProblem(layout, fromId, toId, targets) {
  const missing = missingStations(layout);
  if (missing) return missing;
  const from = getStation(layout, fromId);
  if (!targets.length) return `No other station can receive loads from ${from.name} yet. Place a Workstation, Storage or Goods out.`;
  if (!toId) return `Every possible flow from ${from.name} exists already. Pick another start.`;
  return pairProblem(layout, fromId, toId);
}

function createAddForm(ctx) {
  const { store } = ctx;
  let fromId = '';
  let toId = '';
  let shownKeys = [null, null];
  const from = selectField({ label: 'From', inline: true, controlW: '210px', options: [], onChange: (v) => { fromId = v; refresh(store.getState().layout); } });
  const to = selectField({ label: 'To', inline: true, controlW: '210px', options: [], onChange: (v) => { toId = v; refresh(store.getState().layout); } });
  const note = h('p', { class: 'field__hint', 'aria-live': 'polite' });
  const add = h('button', { class: 'btn btn--primary', type: 'button', onclick: addNow }, icon('plus', { size: 16 }), 'Add flow');
  const el = h('div', { class: 'stack', style: { '--gap': '10px' } }, from.el, to.el, note, h('div', null, add));

  function addNow() {
    const layout = store.getState().layout;
    const a = getStation(layout, fromId);
    const b = getStation(layout, toId);
    let created = null;
    store.commit(`Add flow ${quoted(`${a.name} → ${b.name}`)}`, (d) => { created = addFlow(d, fromId, toId); if (!created) return false; });
    if (created) store.select('flow', [created.id]);
  }

  /** Re-read the stations, keep the planner's choices where they are still valid, and explain a disabled button. */
  function refresh(layout) {
    const origins = senders(layout);
    if (!origins.some((s) => s.id === fromId)) fromId = origins.length ? origins[0].id : '';
    const targets = receivers(layout).filter((s) => s.id !== fromId);
    const toOptions = targets.map((s) => {
      const taken = layout.flows.some((f) => f.from === fromId && f.to === s.id);
      return { value: s.id, label: `${stationLabel(s)}${taken ? ' – already connected' : ''}`, disabled: taken };
    });
    const free = toOptions.find((o) => !o.disabled);
    if (!toOptions.some((o) => o.value === toId && !o.disabled)) toId = free ? free.value : '';
    const fromOptions = origins.map((s) => ({ value: s.id, label: stationLabel(s) }));
    const keys = [optionKey(fromOptions), optionKey(toOptions)];
    if (keys[0] !== shownKeys[0]) from.setOptions(fromOptions.length ? fromOptions : [{ value: '', label: 'No station can send loads yet', disabled: true }], fromId);
    if (keys[1] !== shownKeys[1]) to.setOptions(toOptions.length ? toOptions : [{ value: '', label: 'No station can receive loads yet', disabled: true }], toId);
    shownKeys = keys;
    from.set(fromId);
    to.set(toId);
    const problem = addProblem(layout, fromId, toId, targets);
    add.disabled = !!problem;
    note.textContent = problem || `Loads leaving ${getStation(layout, fromId).name} will go to ${getStation(layout, toId).name}.`;
    note.style.color = problem ? 'var(--warn-text)' : '';
  }
  return { el, update: (state) => refresh(state.layout) };
}

// ---------------------------------------------------------------------------------------------------------
// "Chain stations in order" helper
// ---------------------------------------------------------------------------------------------------------

function createChainBuilder(ctx, memory) {
  const { store } = ctx;
  let chain = [];
  const picker = h('div', { class: 'row row--wrap', style: { '--gap': '6px' } });
  const path = h('ol', { class: 'row row--wrap', style: { '--gap': '6px', listStyle: 'none', margin: 0, padding: 0 }, 'aria-label': 'Chain so far' });
  const note = h('p', { class: 'field__hint', 'aria-live': 'polite' });
  const create = actionButton('Create flows', 'flow', createFlows, 'btn btn--primary btn--sm');
  const undoLast = actionButton('Remove last', 'undo', () => { chain = chain.slice(0, -1); redraw(store.getState().layout, true); });
  const clear = actionButton('Start over', 'close', () => { chain = []; redraw(store.getState().layout, true); }, 'btn btn--ghost btn--sm');
  let drawn = null;
  const sec = section({ title: 'Chain stations in order', aside: '', open: memory.get('chain') === true },
    hintLine('Click the stations a load passes through, one after the other. A flow is created between each neighbouring pair.'),
    path, picker, note, h('div', { class: 'row row--wrap' }, create, undoLast, clear));
  sec.el.addEventListener('toggle', () => memory.set('chain', sec.el.open));

  function createFlows() {
    const layout = store.getState().layout;
    const plan = chainPlan(layout, chain);
    const created = [];
    store.commit(`Chain ${plural(chain.length, 'station')} with flows`, (d) => {
      for (const [a, b] of plan.pairs) {
        const flow = addFlow(d, a, b);
        if (flow) created.push(flow.id);
      }
      if (!created.length) return false;
    });
    if (!created.length) { ctx.toast('Those flows already exist.', { kind: 'info' }); return; }
    store.select('flow', created);
    ctx.toast(`Created ${plural(created.length, 'flow')}.`, { kind: 'success' });
    chain = [];
    redraw(store.getState().layout, false);
  }

  /** Rebuild the chain and the buttons for the next station; `keepFocus` moves focus to the first button that is left. */
  function redraw(layout, keepFocus) {
    const gone = chain.findIndex((id) => !getStation(layout, id));
    if (gone >= 0) chain = chain.slice(0, gone);
    const choices = chainChoices(layout, chain);
    const plan = chainPlan(layout, chain);
    const signature = JSON.stringify([chain.map((id) => getStation(layout, id).name), choices.map((s) => [s.id, s.name])]);
    if (signature !== drawn) {
      drawn = signature;
      path.replaceChildren(...chain.map((id, i) => h('li', { class: 'row', style: { '--gap': '6px' } }, i ? icon('chevron-right', { size: 14 }) : null, stationChip(getStation(layout, id)).el)));
      picker.replaceChildren(...choices.map((s) => h('button', {
        class: 'btn btn--sm', type: 'button', title: typeName(s.type), onclick: () => { chain = [...chain, s.id]; redraw(store.getState().layout, true); },
      }, h('span', { class: `swatch tone-${s.type}` }), s.name)));
    }
    picker.hidden = choices.length === 0;
    path.hidden = chain.length === 0;
    undoLast.hidden = clear.hidden = chain.length === 0;
    create.disabled = chain.length < 2 || !!plan.problem || plan.pairs.length === 0;
    note.textContent = chainNote(layout, chain, choices, plan);
    sec.setAside(chain.length ? plural(chain.length, 'station') : '');
    if (keepFocus) (picker.querySelector('button') || (create.disabled ? clear : create)).focus();
  }

  return { el: sec.el, update: (state) => redraw(state.layout, false) };
}

function chainNote(layout, chain, choices, plan) {
  if (!chain.length) return senders(layout).length ? 'Start with the station where the loads begin.' : missingStations(layout);
  if (plan.problem) return plan.problem;
  if (chain.length < 2) return choices.length ? 'Now pick the next station.' : 'No station can come after this one. Start over with another.';
  const last = getStation(layout, chain[chain.length - 1]);
  const parts = [plan.pairs.length ? `Will create ${plural(plan.pairs.length, 'flow')}` : 'All these flows exist already'];
  if (plan.existing && plan.pairs.length) parts.push(`${plan.existing} already ${plan.existing === 1 ? 'exists' : 'exist'}`);
  const more = choices.length && SENDERS.includes(last.type) ? 'Pick another station to continue the chain, or create the flows now.' : 'The chain ends here.';
  return `${parts.join('; ')}. ${more}`;
}

// ---------------------------------------------------------------------------------------------------------
// Output split
// ---------------------------------------------------------------------------------------------------------

/** How each station divides its output between its outgoing flows (only stations with two or more). */
function createSplitSection(memory) {
  const body = h('div', { class: 'stack', style: { '--gap': '14px' } });
  const sec = section({ title: 'Output split', aside: '', open: memory.get('split') !== false }, body);
  sec.el.addEventListener('toggle', () => memory.set('split', sec.el.open));
  const render = keyedRender(body);
  return {
    el: sec.el,
    update(layout) {
      const splits = outputSplits(layout);
      sec.el.hidden = splits.length === 0;
      const signature = JSON.stringify(splits.map((s) => [s.station.id, s.station.name, s.shares.map((x) => [x.flow.id, x.to.name, x.percent])]));
      render(signature, () => splits.map(splitBlock));
      sec.setAside(splits.length ? plural(splits.length, 'station') : '');
    },
  };
}

function splitBlock({ station, shares }) {
  const spoken = shares.map((s) => `${s.to.name} ${s.percent} %`).join(', ');
  const bars = shares.map((s, i) => h('div', { class: 'progress__bar', style: { '--c': `var(--series-${(i % 8) + 1})`, '--w': `${s.percent}%` } }));
  return h('div', { class: 'stack', style: { '--gap': '6px' } },
    h('div', { class: 'row' }, stationChip(station).el, h('span', { class: 'text-dim', style: { fontSize: 'var(--fs-sm)' } }, 'sends its output to')),
    h('div', { class: 'progress progress--lg progress--stacked', role: 'img', 'aria-label': `${station.name} sends: ${spoken}` }, bars),
    h('ul', { class: 'chart-legend', style: { listStyle: 'none', margin: 0, padding: 0 } }, shares.map((s, i) => h('li', { class: 'chart-legend__item' },
      h('span', { class: 'chart-legend__key', style: { '--c': `var(--series-${(i % 8) + 1})` } }), `${s.to.name} `, h('strong', { class: 'tnum' }, `${s.percent} %`)))));
}

// ---------------------------------------------------------------------------------------------------------
// One flow card
// ---------------------------------------------------------------------------------------------------------

const flowTitle = (layout, flow) => `${getStation(layout, flow.from)?.name ?? '?'} → ${getStation(layout, flow.to)?.name ?? '?'}`;

/** Structure signature of a card: the card is rebuilt when a flow id comes back with other endpoints. */
const cardKey = (layout, flow) => `${flow.id}|${flow.from}|${flow.to}|${getStation(layout, flow.to)?.type}`;

function fleetChoices(layout) {
  return [{ value: '', label: 'Any fleet' }, ...layout.fleets.map((f) => ({ value: f.id, label: `${f.name} (${f.count})` }))];
}

/** The form fields of one flow; returns the elements to show and registers their refreshers in `syncs`. */
function flowFields(ctx, initial, syncs, toType) {
  const { store } = ctx;
  const id = initial.id;
  const current = () => getFlow(store.getState().layout, id);
  const edit = (what, key) => (value) => store.commit(
    `Change ${what} of flow ${quoted(flowTitle(store.getState().layout, current() || initial))}`,
    (d) => updateFlow(d, id, { [key]: value }), { coalesce: `flow:${id}:${key}` });
  const count = (label, key, what, opts) => numberField({ label, int: true, step: 1, unit: 'loads', value: initial[key], onChange: edit(what, key), ...opts });

  const weight = numberField({ label: 'Weight', inline: true, controlW: INLINE_W, min: 0.01, max: 1000, value: initial.weight, hint: ' ', onChange: edit('weight', 'weight') });
  const perCycle = count('Loads per cycle', 'perCycle', 'loads per cycle', { inline: true, controlW: INLINE_W, min: 1, max: 1000, hint: 'Loads the workstation uses from this flow in every cycle, for example 2 pressed parts per assembly.' });
  const batchMin = count('At least', 'batchMin', 'smallest batch', { min: 1, max: 1000 });
  const batchMax = count('At most', 'batchMax', 'largest batch', { min: 0, max: 1000 });
  const maxWait = numberField({ label: 'Longest wait for a batch', unit: 's', inline: true, controlW: INLINE_W, min: 0, max: 1e6, value: initial.maxWait, hint: ' ', onChange: edit('longest wait', 'maxWait') });
  const priority = segmentedField({ label: 'Priority', options: PRIORITIES, value: initial.priority, onChange: edit('priority', 'priority') });
  const setFleet = edit('vehicles', 'fleetId');
  const fleet = selectField({ label: 'Vehicles', inline: true, controlW: '170px', options: fleetChoices(store.getState().layout), value: initial.fleetId ?? '', hint: ' ', onChange: (v) => setFleet(v || null) });
  const batchHint = hintLine('How many loads one vehicle moves at once. At most 0 means as many as the vehicle can carry.');

  let fleetKey = '';
  syncs.push((flow, state) => {
    const layout = state.layout;
    weight.set(flow.weight);
    setHint(weight, weightHint(layout, flow));
    perCycle.set(flow.perCycle);
    batchMin.set(flow.batchMin);
    batchMax.set(flow.batchMax);
    maxWait.set(flow.maxWait);
    setHint(maxWait, flow.maxWait > 0 ? `A partial batch (at least 1 load) leaves after waiting ${humanSeconds(flow.maxWait)}.` : '0 = always wait for the smallest batch, however long it takes.');
    priority.set(flow.priority);
    const choices = fleetChoices(layout);
    if (optionKey(choices) !== fleetKey) { fleetKey = optionKey(choices); fleet.setOptions(choices, flow.fleetId ?? ''); }
    fleet.set(flow.fleetId ?? '');
    const chosen = flow.fleetId ? getFleet(layout, flow.fleetId) : null;
    setHint(fleet, chosen && chosen.count === 0 ? `${chosen.name} has no vehicles, so nothing moves on this flow.` : 'Which fleet may carry these loads.');
  });
  return [weight.el, toType === 'process' ? perCycle.el : null, h('div', { class: 'field-grid' }, batchMin.el, batchMax.el), batchHint, maxWait.el, priority.el, fleet.el];
}

/** One flow: { el, update(flow, state), setSelected(bool), reveal() }. */
function createFlowCard(ctx, initial, layout, open) {
  const { store } = ctx;
  const id = initial.id;
  const syncs = [];
  const from = stationChip(getStation(layout, initial.from));
  const to = stationChip(getStation(layout, initial.to));
  const summary = h('div', { class: 'text-dim', style: { padding: '0 12px 4px 32px', fontSize: 'var(--fs-sm)' } });
  const served = createServedBy(ctx, id); // "Served by: any fleet (AGV ×2)" and, while a simulation runs, the loads waiting and delivered
  const body = h('div', { class: 'stack', style: { padding: '4px 12px 14px', borderTop: '1px solid var(--border)', paddingTop: '12px' }, id: `flow-body-${id}` },
    ...flowFields(ctx, initial, syncs, getStation(layout, initial.to).type));
  let expanded = open;

  const chevron = icon('chevron-right', { size: 14, class: 'section__chevron' });
  chevron.style.marginTop = '3px';
  const toggle = h('button', { class: 'section__header', type: 'button', 'aria-expanded': 'false', 'aria-controls': body.id, style: { flex: '1 1 auto', minWidth: 0, alignItems: 'flex-start' }, onclick: onToggle },
    chevron,
    h('span', { class: 'stack', style: { '--gap': '4px', minWidth: 0, alignItems: 'flex-start' } },
      from.el, h('span', { class: 'row', style: { '--gap': '6px', minWidth: 0, maxWidth: '100%' } }, h('span', { class: 'text-faint', 'aria-hidden': 'true' }, '→'), to.el)));
  const remove = h('button', { class: 'btn btn--icon btn--sm btn--danger-ghost', type: 'button', onclick: removeNow, title: 'Delete flow' }, icon('trash', { size: 16 }));
  const el = h('div', { class: 'card', role: 'group', dataset: { flow: id } }, h('div', { class: 'row', style: { '--gap': '2px', paddingRight: '8px' } }, toggle, remove), summary, served.el, body);

  function setExpanded(value) {
    expanded = value;
    body.hidden = !value;
    toggle.setAttribute('aria-expanded', String(value));
  }
  function isSelected() {
    const s = store.getState().ui.selection;
    return s.kind === 'flow' && s.ids.length === 1 && s.ids[0] === id;
  }
  function onToggle() {
    const wasSelected = isSelected();
    if (!wasSelected) store.select('flow', [id]);
    setExpanded(wasSelected ? !expanded : true);
  }
  function removeNow() {
    const layoutNow = store.getState().layout;
    const title = flowTitle(layoutNow, getFlow(layoutNow, id));
    if (!store.commit(`Delete flow ${quoted(title)}`, (d) => removeFlow(d, id))) return;
    const after = store.getState().layout;
    ctx.toast(`Deleted flow ${quoted(title)}.`, { kind: 'info', action: { label: 'Undo', onClick: () => { if (store.getState().layout === after) store.undo(); } } });
  }
  setExpanded(open);

  // Working inside a card selects its flow on the plan.
  el.addEventListener('focusin', () => { if (!isSelected()) store.select('flow', [id]); });

  return {
    el,
    update(flow, state, report = null) {
      from.setName(getStation(state.layout, flow.from).name);
      to.setName(getStation(state.layout, flow.to).name);
      const title = flowTitle(state.layout, flow);
      el.setAttribute('aria-label', `Flow ${title}`);
      toggle.setAttribute('aria-label', `Flow ${title}`);
      remove.setAttribute('aria-label', `Delete flow ${title}`);
      summary.textContent = flowSummary(state.layout, flow, { withFleet: false });
      served.update(state.layout, report);
      for (const sync of syncs) sync(flow, state);
    },
    setSelected(on) { el.classList.toggle('card--selected', on); },
    /** Open and scroll to a flow that was selected elsewhere, unless the planner is working inside this card right now. */
    reveal() {
      if (el.contains(document.activeElement)) return;
      setExpanded(true);
      el.scrollIntoView({ block: 'nearest' });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------------------

/**
 * Create the Flows panel.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): store, toast, actions.setTool
 * @returns {{ el: HTMLElement, update(state: object): void, destroy(): void }}
 */
export function createFlowsPanel(ctx) {
  const { store } = ctx;
  const memory = new Map();
  const cards = new Map();
  let lastSelection = '';

  const summary = h('span', { class: 'text-dim', style: { fontSize: 'var(--fs-sm)' } });
  const addForm = createAddForm(ctx);
  const chain = createChainBuilder(ctx, memory);
  const splits = createSplitSection(memory);
  const top = h('div', { class: 'row', style: { padding: '12px 12px 8px', alignItems: 'flex-start' } },
    h('div', { class: 'stack', style: { '--gap': '2px', minWidth: 0 } }, h('span', { class: 'eyebrow' }, 'Material flows'), summary), h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn--sm', type: 'button', title: 'Draw flows on the plan (F)', onclick: () => ctx.actions.setTool('flow') }, icon('flow', { size: 14 }), 'Flow tool', h('kbd', { class: 'kbd' }, 'F')));
  const form = h('div', { class: 'card', style: { margin: '0 12px 12px' } },
    h('div', { class: 'card__header' }, h('h3', { class: 'card__title' }, 'Add a flow')),
    h('div', { class: 'card__body' }, addForm.el), chain.el);
  const list = h('div', { class: 'stack', style: { padding: '0 12px 12px', '--gap': '12px' } });
  const empty = emptyState({
    iconName: 'flow', title: 'No flows yet',
    text: 'Flows say where loads go next. Pick two stations above or use the Flow tool (F).',
    actions: [h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => ctx.actions.setTool('flow') }, icon('flow', { size: 14 }), 'Use the Flow tool')],
  });
  const guide = createGuidanceHeader(ctx, { filter: forFlows }); // what is still unconnected, and how vehicles find these flows
  const explainer = createVehiclesExplainer(ctx); // "How vehicles find work": four sentences, collapsible
  const el = h('div', { 'data-panel': 'flows' }, guide.el, explainer.el, top, form, splits.el, list, empty);

  /** Create cards for new flows, drop cards of removed ones and put the rest in layout order. */
  function syncCards(layout) {
    const keys = new Set(layout.flows.map((f) => cardKey(layout, f)));
    for (const [key, card] of cards) if (!keys.has(key)) { card.el.remove(); cards.delete(key); }
    layout.flows.forEach((flow, i) => {
      const key = cardKey(layout, flow);
      if (!cards.has(key)) cards.set(key, createFlowCard(ctx, flow, layout, layout.flows.length <= 2));
      const card = cards.get(key);
      if (list.children[i] !== card.el) list.insertBefore(card.el, list.children[i] || null);
    });
  }

  function update(state) {
    const { layout } = state;
    guide.update(state);
    addForm.update(state);
    chain.update(state);
    splits.update(layout);
    syncCards(layout);
    explainer.update(layout);
    // the runner caches its KpiReport (250 ms): the loads waiting and delivered of every flow come from there, never from the simulation itself
    const report = ctx.runner && ctx.runner.sim && typeof ctx.runner.kpis === 'function' ? ctx.runner.kpis() : null;
    for (const flow of layout.flows) cards.get(cardKey(layout, flow)).update(flow, state, report);
    summary.textContent = layout.flows.length ? plural(layout.flows.length, 'flow') : '';
    empty.hidden = layout.flows.length > 0;
    list.hidden = layout.flows.length === 0;
    showSelection(state);
  }

  function showSelection(state) {
    const { selection } = state.ui;
    const ids = selection.kind === 'flow' ? selection.ids : [];
    const byId = new Map(state.layout.flows.map((f) => [f.id, cards.get(cardKey(state.layout, f))]));
    for (const [id, card] of byId) card.setSelected(ids.includes(id));
    const signature = ids.join(',');
    if (signature !== lastSelection) {
      lastSelection = signature;
      if (ids.length) byId.get(ids[0])?.reveal();
    }
  }

  // A field that was being typed in may hold text the model rejected or clamped: show the real value once the planner leaves it.
  let resync = null;
  el.addEventListener('focusout', () => {
    clearTimeout(resync);
    resync = setTimeout(() => update(store.getState()), 0);
  });

  update(store.getState());
  return { el, update, destroy() { clearTimeout(resync); guide.destroy(); el.remove(); } };
}
