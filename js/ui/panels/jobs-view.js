// The drawing half of "who serves which flow" (browser only; the decisions are in jobs-info.js). Four pieces, each built ONCE and then
// refreshed in place (the golden rule of fields.js: a field the planner is typing in is never touched, nothing is rebuilt while a
// control inside it has the keyboard focus):
//
//   createLoadsSections(ctx, station)  -> { el, update(station, state) }   "Where do loads go?" / "Where do loads come from?" of the
//                                          station form in the Properties tab (a note for depots), with the Add destination / Add origin picker
//   createFleetJobs(ctx, fleetId)      -> { el, update(fleet, state), aside }   "Jobs this fleet serves" inside a fleet card of the Fleet tab
//   createServedBy(ctx, flowId)        -> { el, update(layout, report) }   "Served by: any fleet (AGV ×2)" and the live chips of a flow card
//   createVehiclesExplainer(ctx)       -> { el, update(layout) }           the collapsible "How vehicles find work" on top of the Flows tab
//   createVehiclesHelp()               -> Node                              the "How vehicles find work" page of the Help dialog, with its diagram
//
// Every layout change is a store.commit with a human label (undoable); deleting offers Undo in a toast like the rest of the app.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { getStation, getFlow, getFleet, flowsFrom, flowsTo, addFlow, updateFlow, removeFlow } from '../../model/layout.js';
import { formatNumber } from '../../util/format.js';
import { validDestinations, validOrigins, suggestDestination, suggestOrigin, stationLabel, applyFix, backToSelect, DEFAULT_FLEET } from '../guidance.js';
import { flowCreatedText, FLOW_CREATED } from '../editor/connect.js';
import { section, switchField, callout, uid } from './fields.js';
import {
  WEIGHT_MIN, WEIGHT_MAX, stepWeight, describeSplit, describeInflows, describeServedBy, servedFlows, fleetJobsSummary,
  restrictedFleetProblems, dispatchPhrase, flowTitle,
} from './jobs-info.js';

const quoted = (name) => `“${name}”`;
/** Said under the inputs of a workstation that has several: the model starts a cycle only when every input has delivered. */
const EVERY_INPUT_HINT = 'It starts a cycle only when every input has delivered. To let either one supply it alone, route both through a Storage.';
const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
const LIST = { listStyle: 'none', margin: '0', padding: '0' };
const SMALL_CONTROL = { '--control-h': 'var(--control-h-sm)' };

// ---------------------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------------------

/** Station chip with the type colour; the name is the only part that shrinks. `set(station)` refreshes it in place. */
function stationChip(station) {
  const swatch = h('span', { class: `swatch tone-${station.type}` });
  const name = h('span', { class: 'truncate' });
  const el = h('span', { class: `chip chip--${station.type}`, style: { minWidth: '0', maxWidth: '100%' } }, swatch, name);
  const chip = {
    el,
    set(next) {
      if (!next) return;
      const cls = `chip chip--${next.type}`;
      if (el.className !== cls) { el.className = cls; swatch.className = `swatch tone-${next.type}`; }
      setText(name, next.name);
      setAttr(el, 'title', next.name);
    },
  };
  chip.set(station);
  return chip;
}

/** Icon-only button. */
function iconButton(iconName, label, onclick, cls = 'btn btn--icon btn--sm btn--ghost') {
  return h('button', { class: cls, type: 'button', 'aria-label': label, title: label, onclick }, icon(iconName, { size: 14 }));
}

/** Toast with Undo that only fires while that edit is still the latest one (the pattern of the other panels). */
function undoToast(ctx, message) {
  const after = ctx.store.getState().layout;
  ctx.toast(message, { kind: 'info', action: { label: 'Undo', onClick: () => { if (ctx.store.getState().layout === after) ctx.store.undo(); } } });
}

/** Delete one flow (undoable). Returns true when it was removed. */
function removeFlowNow(ctx, flowId) {
  const layout = ctx.store.getState().layout;
  const flow = getFlow(layout, flowId);
  if (!flow) return false;
  const title = flowTitle(layout, flow);
  if (!ctx.store.commit(`Remove flow ${quoted(title)}`, (d) => removeFlow(d, flowId))) return false;
  undoToast(ctx, `Removed the flow ${quoted(title)}.`);
  return true;
}

/** Select a flow and open its card in the Flows tab (priority, batch size, vehicles). */
function openFlowSettings(ctx, flowId) {
  ctx.store.select('flow', [flowId]);
  ctx.actions.setRightTab('flows');
}

/**
 * Keep `host` lists in step with `items` without rebuilding rows. `groups` is [{ host, items }] (a row can move between hosts);
 * `rows` maps key -> row ({ el }). Returns { removedFocusAt } : the index (in the old order) of a removed row that held the focus, or -1.
 * A row that was moved keeps the keyboard focus (moving a node blurs it).
 */
function reconcile(groups, rows, keyOf, create, update, order) {
  const active = document.activeElement;
  const wanted = new Set(groups.flatMap((g) => g.items.map(keyOf)));
  let removedFocusAt = -1;
  for (const [key, row] of rows) {
    if (wanted.has(key)) continue;
    if (row.el.contains(active)) removedFocusAt = Math.max(0, order.indexOf(key));
    row.el.remove();
    rows.delete(key);
  }
  for (const { host, items } of groups) {
    items.forEach((item, i) => {
      const key = keyOf(item);
      if (!rows.has(key)) rows.set(key, create(item));
      const row = rows.get(key);
      update(row, item);
      if (host.children[i] !== row.el) host.insertBefore(row.el, host.children[i] || null);
    });
  }
  if (removedFocusAt < 0 && active && active !== document.activeElement && active.isConnected && active !== document.body) active.focus({ preventScroll: true });
  return { removedFocusAt };
}

/**
 * [-] value [+] in the small control height. `next(value, direction)` gives the value one click moves to; `int` accepts whole numbers only.
 * onChange(value) fires on every valid change (a click or an edit); an invalid text is reverted when the field is left.
 */
function miniStepper({ min, max, next, int = false, onChange }) {
  let last = min;
  const fmt = (v) => String(Math.round(v * 100) / 100);
  const input = h('input', { class: 'stepper__input tnum', type: 'number', min, max, step: 'any', inputmode: int ? 'numeric' : 'decimal' });
  const apply = (v) => {
    last = Math.min(max, Math.max(min, v));
    input.value = fmt(last);
    onChange(last);
  };
  const dec = h('button', { class: 'stepper__btn', type: 'button', onclick: () => apply(next(last, -1)) }, icon('minus', { size: 12 }));
  const inc = h('button', { class: 'stepper__btn', type: 'button', onclick: () => apply(next(last, 1)) }, icon('plus', { size: 12 }));
  const el = h('div', { class: 'stepper', role: 'group', style: SMALL_CONTROL }, dec, input, inc);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    if (input.value === '' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) return;
    last = v;
    onChange(v);
  });
  input.addEventListener('change', () => { input.value = fmt(last); });
  return {
    el,
    /** The words a screen reader hears: "weight of Goods in 1 → Assembly". */
    setLabel(what) {
      setAttr(el, 'aria-label', what);
      setAttr(input, 'aria-label', what);
      setAttr(dec, 'aria-label', `Lower the ${what}`);
      setAttr(inc, 'aria-label', `Raise the ${what}`);
    },
    set(v) {
      if (!Number.isFinite(v)) return;
      last = v;
      if (document.activeElement !== input && input.value !== fmt(v)) input.value = fmt(v);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Properties: "Where do loads go?" / "Where do loads come from?"
// ---------------------------------------------------------------------------------------------------------

/** What each empty state says, by direction and station type: tone, words, what to place when nothing could be connected. */
const EMPTY = {
  out: {
    source: {
      tone: 'warn', title: 'Not connected yet', text: 'Loads pile up at this gate. Pick a destination.',
      none: 'Nothing can receive loads yet. Place a Workstation, Storage or Goods out next to the road.', tool: ['process', 'Workstation'],
    },
    process: {
      tone: 'info', title: 'Nothing leaves this workstation', text: 'Finished loads leave the plant right here. Pick a destination to send them on.',
      none: 'Nothing can receive its loads yet. Place a Storage, Workstation or Goods out next to the road.', tool: ['sink', 'Goods out'],
    },
    storage: {
      tone: 'warn', title: 'Nothing leaves this storage', text: 'Loads that arrive stay here. Pick a destination to send them on.',
      none: 'Nothing can receive its loads yet. Place a Workstation or Goods out next to the road.', tool: ['sink', 'Goods out'],
    },
  },
  in: {
    process: {
      tone: 'warn', title: 'Nothing feeds this workstation', text: 'It waits for material that never comes. Pick where its loads come from.',
      none: 'Nothing can send loads here yet. Place a Goods in next to the road.', tool: ['source', 'Goods in'],
    },
    storage: {
      tone: 'info', title: 'Nothing is sent here yet', text: 'This storage stays empty. Pick which station sends it loads.',
      none: 'Nothing can send loads here yet. Place a Goods in next to the road.', tool: ['source', 'Goods in'],
    },
    sink: {
      tone: 'warn', title: 'Nothing is sent here yet', text: 'No loads can leave the plant through this Goods out. Pick which station sends it loads.',
      none: 'Nothing can send loads here yet. Place a Workstation next to the road.', tool: ['process', 'Workstation'],
    },
  },
};

const CALLOUT_ICON = { warn: 'warning', info: 'info' };

/** One flow of a station: arrow, the station at the other end, share, settings and delete; below it the weight (several outgoing flows) or the loads per cycle. */
function createFlowRow(ctx, { dir, flowId, otherType }) {
  const { store } = ctx;
  const out = dir === 'out';
  const arrow = h('span', { class: 'text-faint', 'aria-hidden': 'true', style: { flex: 'none' } }, out ? '→' : '←');
  const chip = stationChip({ type: otherType, name: '' });
  const share = h('span', { class: 'text-dim tnum', style: { flex: 'none', fontSize: 'var(--fs-sm)' } });
  const settings = iconButton('sliders', 'Flow settings', () => openFlowSettings(ctx, flowId));
  const remove = iconButton('trash', 'Remove flow', () => removeFlowNow(ctx, flowId), 'btn btn--icon btn--sm btn--danger-ghost');
  const line = h('div', { class: 'row', style: { '--gap': '6px' } }, arrow, h('span', { style: { flex: '1 1 auto', minWidth: '0', display: 'flex' } }, chip.el), share, settings, remove);
  const currentTitle = () => { const l = store.getState().layout; const f = getFlow(l, flowId); return f ? flowTitle(l, f) : ''; };

  const editKey = out ? 'weight' : 'perCycle';
  const stepper = miniStepper(out
    ? { min: WEIGHT_MIN, max: WEIGHT_MAX, next: stepWeight, onChange: (v) => commit(v) }
    : { min: 1, max: 1000, next: (v, d) => v + d, int: true, onChange: (v) => commit(v) });
  function commit(value) {
    store.commit(`Change ${out ? 'weight' : 'loads per cycle'} of flow ${quoted(currentTitle())}`, (d) => updateFlow(d, flowId, { [editKey]: value }), { coalesce: `flow:${flowId}:${editKey}` });
  }
  const tag = h('span', { class: 'text-dim', style: { fontSize: 'var(--fs-sm)' } }, out ? 'Weight' : 'Needs');
  const unit = h('span', { class: 'text-dim', style: { fontSize: 'var(--fs-sm)' } }, out ? '' : 'per cycle');
  const second = h('div', { class: 'row', style: { '--gap': '8px', paddingLeft: '22px' } }, tag, stepper.el, unit);
  const el = h('li', { class: 'stack', style: { '--gap': '6px' }, dataset: { flow: flowId } }, line, second);

  return {
    el,
    focusTarget: settings, // where the keyboard focus goes when a neighbouring row is removed (never onto a delete button)
    /** `showSecond`: the weight line only matters from two outgoing flows on; loads per cycle only for a workstation. */
    update({ flow, other, percent, several, layout, showSecond }) {
      chip.set(other);
      const title = flowTitle(layout, flow);
      setText(share, out && several ? `${percent} %` : '');
      share.hidden = !(out && several);
      setAttr(share, 'title', out && several ? `${percent} % of the loads from ${getStation(layout, flow.from)?.name ?? ''} go this way` : '');
      setAttr(settings, 'aria-label', `Flow settings for ${title}`);
      setAttr(remove, 'aria-label', `Remove flow ${title}`);
      second.hidden = !showSecond;
      stepper.setLabel(out ? `weight of ${title}` : `loads per cycle from ${getStation(layout, flow.from)?.name ?? 'this station'}`);
      stepper.set(out ? flow.weight : flow.perCycle);
    },
  };
}

/**
 * One of the two blocks. `dir` 'out': the flows that leave the station and the "Add destination" picker; 'in': the flows that arrive and
 * "Add origin". The picker is a choice of station (closest first, the best guess preselected) and a Connect button; with no flow yet it
 * sits in a callout that says what is wrong, otherwise behind the "+ Add ..." button. Connecting stays on this station.
 */
function createLoadsBlock(ctx, station, dir) {
  const { store } = ctx;
  const id = station.id;
  const out = dir === 'out';
  const words = EMPTY[dir][station.type];
  const rows = new Map();
  let order = [];
  let open = false; // the planner opened the picker (callout mode shows it anyway)
  let chosen = null; // the station the planner picked in the list; null while the suggestion is used
  let shown = null; // signature of the options on screen
  let latest = null;

  const headId = uid('loads-title');
  const heading = h('h3', { id: headId, style: { margin: '0', fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' } }, out ? 'Where do loads go?' : 'Where do loads come from?');
  const count = h('span', { class: 'badge', hidden: true });
  const list = h('ul', { class: 'stack', style: { '--gap': '10px', ...LIST } });
  const weightHint = h('p', { class: 'field__hint', hidden: true });
  const cycleHint = h('p', { class: 'field__hint', hidden: true });
  const status = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

  // ---- the add control: a callout while the station has no flow, else a button that opens the picker
  const selectId = uid('loads-pick');
  const select = h('select', { class: 'input input--sm', id: selectId, style: { flex: '1 1 150px', minWidth: '0' } });
  const selectLabel = h('label', { class: 'sr-only', for: selectId });
  const connect = h('button', { class: 'btn btn--sm btn--primary', type: 'button', onclick: connectNow }, icon('flow', { size: 14 }), 'Connect');
  const cancel = iconButton('close', 'Cancel', () => setOpen(false, true));
  const picker = h('div', { class: 'row row--wrap', style: { '--gap': '6px' } }, selectLabel, select, connect, cancel);
  const toggle = h('button', { class: 'btn btn--sm', type: 'button', 'aria-expanded': 'false', style: { alignSelf: 'flex-start' }, onclick: () => setOpen(!open, !open) }, icon('plus', { size: 14 }), out ? 'Add destination' : 'Add origin');
  const calloutIcon = h('span', { class: 'callout__icon', 'aria-hidden': 'true' });
  const calloutTitle = h('div', { class: 'callout__title' });
  const calloutText = h('div', { class: 'callout__text' });
  const noneText = h('p', { class: 'field__hint', style: { margin: '0' } });
  const toolButton = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => ctx.actions.setTool(words.tool[0]) }, icon(words.tool[0], { size: 14 }), words.tool[1]);
  const noneBox = h('div', { class: 'stack', style: { '--gap': '6px', alignItems: 'flex-start' }, hidden: true }, noneText, toolButton);
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0', flex: '1 1 auto' } }, calloutTitle, calloutText, toggle, picker, noneBox);
  const addBox = h('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } }, calloutIcon, body);
  picker.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    e.stopPropagation(); // the editor would clear the selection
    setOpen(false, true);
  });
  select.addEventListener('change', () => {
    chosen = select.value;
    if (latest) paint(latest);
  });

  const el = h('section', { class: 'stack', style: { padding: '12px', '--gap': '10px', borderTop: '1px solid var(--border)' }, 'aria-labelledby': headId, dataset: { loads: dir } },
    h('div', { class: 'row' }, heading, count), list, weightHint, cycleHint, addBox, status);

  const options = (layout) => (out ? validDestinations(layout, id) : validOrigins(layout, id));
  const suggestion = (layout) => (out ? suggestDestination(layout, id) : suggestOrigin(layout, id));

  function setOpen(value, focus) {
    open = value;
    if (latest) paint(latest);
    if (focus) (open ? select : toggle).focus();
  }

  function connectNow() {
    const layout = store.getState().layout;
    const other = getStation(layout, select.value);
    const self = getStation(layout, id);
    if (!other || !self) return;
    const [from, to] = out ? [self, other] : [other, self];
    let created = null;
    const done = store.commit(`Connect ${from.name} → ${to.name}`, (d) => { created = addFlow(d, from.id, to.id); if (!created) return false; });
    if (!done || !created) {
      ctx.toast(`${from.name} cannot send loads to ${to.name}.`, { kind: 'warn' });
      return;
    }
    chosen = null;
    open = false;
    backToSelect(ctx);
    const message = flowCreatedText(store.getState().layout, created);
    setText(status, `Connected ${from.name} to ${to.name}. ${message.slice(FLOW_CREATED.length + 1)}`.trim()); // read out by a screen reader
    undoToast(ctx, message); // and shown to everyone else: this is where "vehicles will serve it automatically" is said
    paint(store.getState());
    // back to the button that opened the picker; when nothing is left to add, to the row that was just created
    (toggle.hidden ? rows.get(created.id)?.focusTarget : toggle)?.focus();
  }

  /** The planner removed a flow (or something else did): the focus goes to a neighbour, never to the page. */
  function placeFocus(index) {
    const row = rows.get(order[Math.min(index, order.length - 1)]);
    if (row) row.focusTarget.focus({ preventScroll: true });
    else (picker.hidden ? toggle : select).focus({ preventScroll: true });
  }

  function paint(state) {
    const { layout } = state;
    const self = getStation(layout, id);
    if (!self) return;
    const flows = out ? flowsFrom(layout, id) : flowsTo(layout, id);
    const split = out ? describeSplit(layout, id) : null;
    const percentOf = new Map(split ? split.flows.map((s) => [s.flow.id, s.percent]) : []);
    const several = out && flows.length > 1;
    const isProcessIn = !out && self.type === 'process';
    const items = flows.map((flow) => ({ flow, other: getStation(layout, out ? flow.to : flow.from), percent: percentOf.get(flow.id) ?? 100, several, layout, showSecond: out ? several : isProcessIn }));
    const { removedFocusAt } = reconcile([{ host: list, items }], rows, (item) => item.flow.id,
      (item) => createFlowRow(ctx, { dir, flowId: item.flow.id, otherType: item.other?.type || 'process' }), (row, item) => row.update(item), order);
    order = items.map((item) => item.flow.id);
    list.hidden = flows.length === 0;
    count.hidden = flows.length === 0;
    setText(count, String(flows.length));
    weightHint.hidden = !several;
    setText(weightHint, 'Weights are relative: 2 and 1 send two thirds and one third.');
    const needs = isProcessIn ? describeInflows(layout, id).text : '';
    cycleHint.hidden = !(needs && flows.length > 1);
    setText(cycleHint, needs ? `${needs} ${EVERY_INPUT_HINT}` : '');

    // the add control
    const choices = options(layout);
    const empty = flows.length === 0;
    const callMode = empty && Boolean(words);
    const visible = callMode || open;
    const typing = document.activeElement === select;
    const signature = choices.map((s) => `${s.id}|${stationLabel(s)}`).join(';');
    if (!typing) {
      if (signature !== shown) {
        shown = signature;
        select.replaceChildren(...choices.map((s) => h('option', { value: s.id }, stationLabel(s))));
      }
      if (chosen && !choices.some((s) => s.id === chosen)) chosen = null;
      const hint = suggestion(layout);
      const wanted = chosen || (choices.some((s) => s.id === hint?.id) ? hint.id : choices[0]?.id || '');
      if (select.value !== wanted) select.value = wanted;
    }
    const tone = callMode ? words.tone : '';
    const cls = tone ? `callout callout--${tone}` : '';
    if (addBox.className !== cls) addBox.className = cls;
    if (tone && calloutIcon.dataset.tone !== tone) { calloutIcon.dataset.tone = tone; calloutIcon.replaceChildren(icon(CALLOUT_ICON[tone], { size: 16 })); }
    calloutIcon.hidden = !tone;
    calloutTitle.hidden = calloutText.hidden = !tone;
    if (words) { setText(calloutTitle, words.title); setText(calloutText, words.text); }
    toggle.hidden = callMode || !choices.length;
    setAttr(toggle, 'aria-expanded', String(visible && !callMode));
    picker.hidden = !visible || !choices.length;
    cancel.hidden = callMode;
    connect.disabled = !choices.length;
    noneBox.hidden = choices.length > 0;
    if (!choices.length) {
      toolButton.hidden = !empty;
      setText(noneText, empty ? words.none : out ? 'Every possible destination is connected already.' : 'Every possible origin is connected already.');
      noneText.style.color = callMode ? 'var(--text)' : ''; // the dim hint colour is only guaranteed on the plain panel, not on a tinted callout
    }
    setText(selectLabel, out ? `Where should ${self.name} send its loads?` : `Which station sends loads to ${self.name}?`);
    const picked = getStation(layout, select.value);
    setAttr(connect, 'aria-label', picked ? `Connect ${out ? `${self.name} to ${picked.name}` : `${picked.name} to ${self.name}`}` : 'Connect');
    if (removedFocusAt >= 0) placeFocus(removedFocusAt);
  }

  return { el, update: (state) => { latest = state; paint(state); } };
}

/**
 * The two blocks of the station form. A Goods in only sends, a Goods out only receives, a Workstation and a Storage do both, a depot
 * takes part in no flow and gets a note instead. `update(station, state)` refreshes everything in place.
 * @param {object} ctx the shared ctx (store, toast, actions.{setTool, setRightTab})
 * @param {object} station the station the form is built for (its id and type do not change for the life of the form)
 * @returns {{ el: HTMLElement[], update(station: object, state: object): void }}
 */
export function createLoadsSections(ctx, station) {
  if (station.type === 'depot') {
    const note = h('div', { class: 'callout callout--info', style: { margin: '12px' } }, icon('info', { size: 16, class: 'callout__icon' }),
      h('div', { class: 'callout__body' }, h('div', { class: 'callout__title' }, 'Parking spot for idle vehicles'),
        h('div', { class: 'callout__text' }, 'It is not part of any flow. Vehicles park here when they have no job.')));
    return { el: [note], update() {} };
  }
  const blocks = [];
  if (EMPTY.out[station.type]) blocks.push(createLoadsBlock(ctx, station, 'out'));
  if (EMPTY.in[station.type]) blocks.push(createLoadsBlock(ctx, station, 'in'));
  return { el: blocks.map((b) => b.el), update(_station, state) { for (const b of blocks) b.update(state); } };
}

// ---------------------------------------------------------------------------------------------------------
// Fleet: "Jobs this fleet serves"
// ---------------------------------------------------------------------------------------------------------

/** One flow of the list: from and to, and the switch that dedicates it to this fleet. */
function createFleetFlowRow(ctx, fleetId, flowId, layout) {
  const { store } = ctx;
  const flow = getFlow(layout, flowId);
  const from = stationChip(getStation(layout, flow.from));
  const to = stationChip(getStation(layout, flow.to));
  const only = switchField({ label: 'Only this fleet', checked: flow.fleetId === fleetId, onChange: (on) => set(on) });
  function set(on) {
    const l = store.getState().layout;
    const f = getFlow(l, flowId);
    const fleet = getFleet(l, fleetId);
    if (!f || !fleet) return;
    const title = quoted(flowTitle(l, f));
    store.commit(on ? `Dedicate flow ${title} to ${fleet.name}` : `Release flow ${title} to any fleet`, (d) => updateFlow(d, flowId, { fleetId: on ? fleetId : null }));
  }
  const chips = h('span', { class: 'row', style: { '--gap': '6px', minWidth: '0', flex: '1 1 auto' } }, from.el, h('span', { class: 'text-faint', 'aria-hidden': 'true', style: { flex: 'none' } }, '→'), to.el);
  const el = h('li', { class: 'row row--wrap', style: { '--gap': '6px 12px', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)' }, dataset: { flow: flowId } }, chips, only.el);
  return {
    el,
    focusTarget: only.input,
    update({ flow: f, layout: l }) {
      from.set(getStation(l, f.from));
      to.set(getStation(l, f.to));
      if (only.input.checked !== (f.fleetId === fleetId)) only.set(f.fleetId === fleetId);
      setAttr(only.input, 'aria-label', `Only this fleet serves ${flowTitle(l, f)}`);
    },
  };
}

/**
 * The "Jobs this fleet serves" body of a fleet card: what the model is, how many flows share how many vehicles, the flows this fleet may
 * serve (any fleet / only this fleet, each with the switch) and the problems (a dedicated flow with no vehicles to carry it).
 * `aside` holds the short text for the section header ("4 flows").
 */
export function createFleetJobs(ctx, fleetId) {
  const { store } = ctx;
  const rows = new Map();
  let order = [];
  const explain = h('p', { class: 'field__hint', style: { margin: '0' } });
  const summary = h('p', { style: { margin: '0', fontWeight: 'var(--fw-semibold)' }, 'aria-live': 'polite' });
  const problems = h('div', { class: 'stack', style: { '--gap': '8px' } });
  let problemsKey = null;
  const group = (title, hint) => {
    const list = h('ul', { class: 'stack', style: { '--gap': '0', ...LIST } });
    const count = h('span', { class: 'text-faint tnum', style: { fontSize: 'var(--fs-sm)' } });
    const head = h('div', { class: 'row' }, h('h4', { class: 'eyebrow', style: { margin: '0' } }, title), count);
    const el = h('div', { class: 'stack', style: { '--gap': '6px' }, hidden: true }, head, hint ? h('p', { class: 'field__hint', style: { margin: '0' } }, hint) : null, list);
    return { el, list, count };
  };
  const anyGroup = group('Any fleet', 'Every free vehicle of every fleet may take these.');
  const onlyGroup = group('Only this fleet', 'Other fleets leave these flows alone.');
  const others = h('p', { class: 'field__hint', style: { margin: '0' }, hidden: true });
  const flowTool = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => ctx.actions.setTool('flow') }, icon('flow', { size: 14 }), 'Flow tool');
  const noFlows = h('div', { class: 'stack', style: { '--gap': '6px', alignItems: 'flex-start' }, hidden: true },
    h('p', { class: 'field__hint', style: { margin: '0' } }, 'Connect two stations with a flow, and the vehicles of this fleet serve it automatically.'), flowTool);
  const el = h('div', { class: 'stack', style: { '--gap': '12px' } }, explain, summary, problems, anyGroup.el, onlyGroup.el, others, noFlows);
  const info = { aside: '' };

  const addVehicles = () => h('button', { class: 'btn btn--sm', type: 'button', onclick: () => {
    const current = getFleet(store.getState().layout, fleetId);
    if (current) applyFix(ctx, { type: 'add-fleet', preset: current.preset, fleetId, count: DEFAULT_FLEET.count, label: 'Add vehicles' });
  } }, icon('plus', { size: 14 }), `Add ${DEFAULT_FLEET.count} vehicles`);

  /** Flows nobody can carry: those dedicated to this fleet while it has no vehicles, and (once) every open flow while no fleet has any. */
  function paintProblems(layout) {
    const all = restrictedFleetProblems(layout);
    const dedicated = all.filter((p) => p.code === 'restricted-fleet-empty' && p.fleetId === fleetId);
    const open = all.filter((p) => p.code === 'no-vehicles');
    const key = [...dedicated, ...open].map((p) => p.id).join('|');
    if (key === problemsKey) return;
    problemsKey = key;
    const nodes = dedicated.map((p) => callout({
      severity: 'warning', title: 'Nothing carries this flow', text: `${p.message} ${p.hint}`,
      actions: h('div', { class: 'row row--wrap', style: { marginTop: '6px' } }, addVehicles(),
        h('button', { class: 'btn btn--sm', type: 'button', onclick: () => {
          const l = store.getState().layout;
          const f = getFlow(l, p.flowId);
          if (f) store.commit(`Release flow ${quoted(flowTitle(l, f))} to any fleet`, (d) => updateFlow(d, p.flowId, { fleetId: null }));
        } }, 'Set to any fleet')),
    }));
    if (open.length) {
      nodes.unshift(callout({
        severity: 'warning', title: 'No vehicle can carry your flows yet',
        text: `${plural(open.length, 'flow is', 'flows are')} waiting for vehicles. Every free vehicle serves every flow, so one fleet with vehicles is enough.`,
        actions: h('div', { class: 'row row--wrap', style: { marginTop: '6px' } }, addVehicles()),
      }));
    }
    problems.replaceChildren(...nodes);
  }

  return {
    el,
    get aside() { return info.aside; },
    update(fleet, state) {
      const { layout } = state;
      const served = servedFlows(layout, fleetId);
      const summ = fleetJobsSummary(layout, fleetId);
      setText(explain, `Vehicles are not assigned to stations. A free vehicle takes whichever flow needs transport next (${dispatchPhrase(layout)}). Restrict a flow to a fleet to dedicate it.`);
      setText(summary, summ.text);
      info.aside = summ.flows ? plural(summ.flows, 'flow') : '';
      paintProblems(layout);
      // show the groups before moving rows into them: a control inside a hidden group cannot hold the focus
      anyGroup.el.hidden = served.any.length === 0;
      onlyGroup.el.hidden = served.only.length === 0;
      const make = (item) => createFleetFlowRow(ctx, fleetId, item.flow.id, layout);
      const items = (list) => list.map((flow) => ({ flow, layout }));
      const { removedFocusAt } = reconcile([{ host: anyGroup.list, items: items(served.any) }, { host: onlyGroup.list, items: items(served.only) }], rows,
        (item) => item.flow.id, make, (row, item) => row.update(item), order);
      order = [...served.any, ...served.only].map((f) => f.id);
      if (removedFocusAt >= 0) (rows.get(order[Math.min(removedFocusAt, order.length - 1)])?.focusTarget || flowTool).focus({ preventScroll: true });
      setText(anyGroup.count, String(served.any.length));
      setText(onlyGroup.count, String(served.only.length));
      others.hidden = served.other.length === 0;
      setText(others, `${plural(served.other.length, 'other flow is', 'other flows are')} dedicated to other fleets.`);
      noFlows.hidden = layout.flows.length > 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Flows: "Served by" and the live numbers
// ---------------------------------------------------------------------------------------------------------

/**
 * The line under a flow card's title: "Served by: any fleet (AGV ×2, Forklift ×1)" or "Served by: only AGV ×2", a warning with what to do
 * when nothing can carry the flow, and, while a simulation exists, how many loads wait for pickup and how many were delivered.
 * `update(layout, report)` takes the cached KpiReport of the runner (or null); it never asks the simulation for anything itself.
 */
export function createServedBy(ctx, flowId) {
  const label = h('span', { class: 'text-dim' }, 'Served by:');
  const value = h('span', { style: { fontWeight: 'var(--fw-medium)' } });
  const waiting = h('span', { class: 'chip chip--outline tnum', hidden: true });
  const delivered = h('span', { class: 'chip chip--outline tnum', hidden: true });
  const live = h('span', { class: 'row', style: { '--gap': '6px', marginLeft: 'auto' } }, waiting, delivered);
  const warnText = h('span', null);
  const open = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Open Fleet tab');
  const warn = h('div', { class: 'row row--wrap', style: { '--gap': '6px', color: 'var(--warn-text)' }, hidden: true }, icon('warning', { size: 14 }), warnText, open);
  const line = h('div', { class: 'row row--wrap', style: { '--gap': '4px 6px' } }, h('span', null, label, ' ', value), live);
  const el = h('div', { class: 'stack', style: { '--gap': '4px', padding: '0 12px 10px 32px', fontSize: 'var(--fs-sm)' }, dataset: { servedBy: flowId } }, line, warn);
  let fleetToOpen = null;
  open.addEventListener('click', () => {
    if (fleetToOpen) ctx.store.select('fleet', [fleetToOpen]);
    ctx.actions.setRightTab('fleet');
  });
  return {
    el,
    update(layout, report) {
      const info = describeServedBy(layout, flowId);
      setText(value, info.value);
      el.dataset.tone = info.tone;
      warn.hidden = info.tone !== 'warn';
      setText(warnText, info.hint);
      fleetToOpen = getFlow(layout, flowId)?.fleetId || null;
      const row = report && report.flows ? report.flows[flowId] : null;
      live.hidden = !row;
      if (!row) return;
      waiting.hidden = delivered.hidden = false;
      setText(waiting, `${formatNumber(row.backlog)} ${row.backlog === 1 ? 'load' : 'loads'} waiting`);
      setText(delivered, `${formatNumber(row.delivered)} delivered`);
      setAttr(waiting, 'title', 'Loads that are ready at the start of this flow and that no vehicle has taken yet');
      setAttr(delivered, 'title', 'Loads delivered to the destination since the results started counting');
    },
  };
}

const EXPLAINER_KEY = 'logiplan:flows-explainer';
const readOpen = () => {
  try {
    return globalThis.localStorage?.getItem(EXPLAINER_KEY) !== '0';
  } catch {
    return true;
  }
};
const writeOpen = (open) => {
  try {
    globalThis.localStorage?.setItem(EXPLAINER_KEY, open ? '1' : '0');
  } catch {
    // not remembered across visits this time
  }
};

/** The collapsible "How vehicles find work" on top of the Flows tab: four short sentences and a way into the Help. Open until the planner closes it (remembered). */
export function createVehiclesExplainer(ctx) {
  const strategy = h('span');
  const help = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', style: { display: 'inline-flex', verticalAlign: 'baseline', height: 'auto', padding: '0 4px', color: 'var(--accent-text)' }, onclick: () => ctx.dialogs?.openHelp?.({ tab: 'vehicles' }) }, 'More in Help');
  const text = h('p', { style: { margin: '0', lineHeight: 'var(--lh)' } },
    'A flow says where loads go. Vehicles are not tied to stations: every free vehicle serves every flow, so a second Goods in only needs a flow of its own. ',
    'A free vehicle takes ', strategy, ' (Simulate tab); a higher priority goes first. ',
    'To dedicate vehicles, choose a fleet for a flow below or in the Fleet tab. ', help);
  const sec = section({ title: 'How vehicles find work', open: readOpen() }, text);
  sec.el.addEventListener('toggle', () => writeOpen(sec.el.open));
  const el = h('div', { class: 'card', style: { margin: '12px 12px 0' }, dataset: { explainer: 'vehicles' } }, sec.el);
  return { el, update(layout) { setText(strategy, dispatchPhrase(layout)); } };
}

// ---------------------------------------------------------------------------------------------------------
// Help: "How vehicles find work"
// ---------------------------------------------------------------------------------------------------------

const svg = (tag, attrs, ...children) => h(`svg:${tag}`, attrs, ...children);

/**
 * Small inline picture: two Goods in and an Assembly along one road, a flow arrow from each Goods in to the Assembly, and one vehicle on the
 * road that serves both. Colours come from the tokens, so it follows the theme.
 */
export function createHowDiagram() {
  const brick = (x, name, type) => svg('g', null,
    svg('rect', { x, y: 70, width: 108, height: 40, rx: 6, style: `fill: var(--st-${type}); stroke: var(--st-${type}-ink); stroke-opacity: .25` }),
    svg('text', { x: x + 54, y: 94.5, 'text-anchor': 'middle', style: `fill: var(--st-${type}-ink); font: 600 13px var(--font-sans)` }, name));
  const dock = (x) => svg('rect', { x, y: 110, width: 32, height: 32, rx: 3, style: 'fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 3 2' });
  const arrowHead = (x, y) => svg('path', { d: 'M-4.5 -5 L0 3 L4.5 -5 z', transform: `translate(${x} ${y})`, style: 'fill: var(--accent)' });
  const flowLine = (d) => svg('path', { d, style: 'fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round' });
  const tag = (x, y, text, style = '') => svg('text', { x, y, 'text-anchor': 'middle', style: `fill: var(--text-dim); font: 500 12px var(--font-sans); ${style}` }, text);

  return svg('svg', {
    viewBox: '0 0 400 214', role: 'img', style: 'display: block; width: 100%; height: auto; max-width: 520px; margin: 0 auto',
    'aria-label': 'Two Goods in stations and an Assembly stand along one road. A flow arrow leads from each Goods in to the Assembly. One vehicle drives along the road and serves both flows.',
  },
  svg('title', null, 'How vehicles find work'),
  // the road, then the dock cells (the road cells that touch a station) and the stations that touch them
  svg('rect', { x: 8, y: 110, width: 384, height: 32, rx: 5, style: 'fill: var(--surface-3); stroke: var(--border-strong)' }),
  svg('line', { x1: 16, y1: 126, x2: 384, y2: 126, style: 'stroke: var(--text-faint); stroke-width: 1.5; stroke-dasharray: 8 7' }),
  dock(58), dock(180), dock(310),
  brick(20, 'Goods in 1', 'source'), brick(142, 'Goods in 2', 'source'), brick(272, 'Assembly', 'process'),
  // the flows: logical arrows, one per Goods in
  flowLine('M74 68 C 74 12, 350 12, 350 62'), arrowHead(350, 66),
  flowLine('M196 68 C 196 34, 310 34, 310 62'), arrowHead(310, 66),
  tag(212, 17, 'flow 1'), tag(253, 58, 'flow 2'),
  tag(74, 157, 'pickup dock'), tag(196, 157, 'pickup dock'), tag(326, 157, 'drop-off dock'),
  // the one vehicle, on its way to the Assembly
  svg('g', { transform: 'translate(234 116)' },
    svg('rect', { x: 0, y: 0, width: 46, height: 20, rx: 5, style: 'fill: var(--accent-solid); stroke: var(--surface); stroke-width: 1.5' }),
    svg('rect', { x: 8, y: 4, width: 12, height: 12, rx: 2, style: 'fill: var(--on-accent); opacity: .9' }),
    svg('path', { d: 'M46 5 L53 10 L46 15 z', style: 'fill: var(--accent-solid)' })),
  tag(200, 187, 'One fleet serves both flows', 'font-weight: 600; font-size: 13px; fill: var(--text)'),
  tag(200, 204, 'Each Goods in needs a flow; each station a dock.'));
}

const HELP_LOOP = [
  'A load appears at a Goods in (or leaves a workstation or a storage).',
  'Its flow says where it goes next.',
  'A free vehicle picks the best job: the nearest, the oldest, or a balance of both (Simulate tab, Dispatch strategy). A higher priority goes first.',
  'It drives to the pickup dock and loads.',
  'It drives to the destination dock and unloads.',
  'Then it takes the next job, or parks.',
];

/** The page of the Help dialog that explains how vehicles find work: plain words, the diagram and what to try when loads pile up. */
export function createVehiclesHelp() {
  const p = (...parts) => h('p', { style: { margin: '0', lineHeight: 'var(--lh)', maxWidth: '78ch' } }, ...parts);
  const title = (text) => h('h3', { style: { margin: '0', fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' } }, text);
  const part = (heading, ...children) => h('div', { class: 'stack', style: { '--gap': '6px' } }, title(heading), ...children);
  const list = (items, ordered = false) => h(ordered ? 'ol' : 'ul', { style: { margin: '0', paddingLeft: '22px', display: 'flex', flexDirection: 'column', gap: '6px', lineHeight: 'var(--lh)', maxWidth: '78ch' } },
    items.map((item) => h('li', null, item)));
  return h('div', { class: 'stack', style: { '--gap': '18px' }, dataset: { help: 'vehicles' } },
    p(h('strong', null, 'Vehicles are not assigned to stations. '), 'Flows say where loads go, and every free vehicle serves every flow automatically. So when you add a second Goods in, give it a flow, and the vehicles you already have will serve it as well.'),
    h('figure', { style: { margin: '0', padding: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--surface-2)' } }, createHowDiagram()),
    part('The loop', list(HELP_LOOP, true)),
    part('What a dock is', p('A dock is a road cell that touches a station. Vehicles stop on it to load and unload, and block it while they do. A station that touches no road is never served: drag it next to a road. The Checks tab lists every station without a dock.')),
    part('Which dock does a vehicle use?', p('A station has a dock on every road cell that touches it, and a vehicle does not simply take the nearest one. It drives to the dock where it can start loading ',
      h('strong', null, 'soonest'), ': the drive there, plus the time the vehicles already standing on that dock or on their way to it still need, plus any vehicle standing in the way. A free dock therefore beats a busy one that is closer, as long as the detour there and back is shorter than the wait, and a vehicle that is still on its way switches to another dock when that one has become clearly better. A vehicle longer than a road cell that docks on a side road of one cell keeps to the nearest dock: it overhangs the junction, and spreading such vehicles out jams the main road. ',
      'So more docks mean more vehicles loading at the same time. Docks that lie one behind the other on one lane block each other, because a vehicle cannot drive past one that is standing: give each extra dock a short side road of its own. The Jobs overlay marks every dock with a dot: hollow when it is free, a ring while a vehicle is on its way to it, filled while a vehicle stands on it.')),
    part('More than one Goods in', p('Each Goods in needs a flow of its own. Select it and pick a destination under ', h('strong', null, 'Where do loads go?'), ', or use the Flow tool (F). Two Goods in that feed one Assembly are two flows, served by the same vehicles. The Assembly then needs a load from each of them before every cycle; if either one may supply it alone, send both into a Storage and connect the Storage to the Assembly. There is nothing else to set up.')),
    part('Dedicating vehicles', p('To keep a fleet for one job, open the Fleet tab, find ', h('strong', null, 'Jobs this fleet serves'), ' and switch on ', h('strong', null, 'Only this fleet'), ' for that flow. You can also choose the fleet in the flow’s card in the Flows tab. Other fleets then leave that flow alone, so give the fleet at least one vehicle.')),
    part('Priority, batch size and capacity', p('The priority of a flow (Flows tab) decides which one is served first when several are waiting: Urgent, then High, then Normal. The batch size says how many loads one trip carries, and a vehicle never carries more than its capacity. A bigger batch means fewer trips, but the loads wait until it is full or the longest wait has passed.')),
    part('When loads pile up', p('Loads that wait a long time at a Goods in or a workstation mean the transport cannot keep up. Try, one at a time:'),
      list(['Add vehicles to the fleet that serves the flow.', 'Use faster vehicles, or ones that carry more loads.', 'Shorten the routes: move the stations closer together or add a shortcut road.',
        'Give a busy station a second dock, so two vehicles can work there at once.', 'Add a bypass lane, so a vehicle that stops at a dock does not block the others.'])),
    part('Where to see it', p('Switch on the ', h('strong', null, 'Jobs'), ' overlay above the plan: a dashed line leads from each vehicle to the station it is heading for, and a badge shows how many loads are waiting at a station. The Flows tab counts the loads waiting and delivered for every flow while the simulation runs, and the Results tab shows the pickup waiting time and the backlog per flow.')));
}
