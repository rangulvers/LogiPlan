// Fleet panel (docs/ARCHITECTURE.md 6.5): one card per vehicle fleet. The header of a card always shows the most-used knob
// (how many vehicles) and, while a simulation exists, how many of them are working, waiting or idle. The body holds the
// vehicle data (type, colour, speed, loading times), the battery, breakdowns and parking rules.
//
//   const panel = createFleetPanel(ctx);   // ctx: see docs/ARCHITECTURE.md 6.8
//   container.append(panel.el);  panel.update(store.getState());  // on every store change, ~4 Hz while the simulation runs
//
// Every card is built ONCE per fleet and afterwards only refreshed in place (the golden rule of fields.js: a field the
// planner is typing in is never touched). Every edit is a store.commit with a readable label; typing and stepping commit
// with a `coalesce` key, so a burst of edits is one undo step. Selecting a card selects the fleet on the plan (its vehicles
// light up) and selecting a fleet elsewhere highlights its card. Pure helpers that carry decisions (vehicle presets, live
// counts, wording) are exported and unit-tested in tests/ui.panels2.test.js.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { inkFor } from '../theme.js';
import { FLEET_PRESETS, FLEET_PRESET_ORDER } from '../../model/defaults.js';
import { getFleet, addFleet, updateFleet, removeFleet, duplicateFleet } from '../../model/layout.js';
import { formatNumber, round } from '../../util/format.js';
import { numberField, selectField, textField, segmentedField, stepperField, switchField, section, emptyState, callout, humanSeconds, uid } from './fields.js';

const INLINE_W = '120px';
const quoted = (name) => `“${name}”`;
const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const joinWords = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const hintLine = (text) => h('p', { class: 'field__hint' }, text);

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

/** The eight colours a fleet can take (vehicles and their card on the plan). */
export const COLOR_CHOICES = Object.freeze([
  { value: '#2d7ff9', name: 'Blue' }, { value: '#12a594', name: 'Teal' }, { value: '#2f9e44', name: 'Green' }, { value: '#f08c00', name: 'Amber' },
  { value: '#e8590c', name: 'Orange' }, { value: '#d6336c', name: 'Pink' }, { value: '#7048e8', name: 'Violet' }, { value: '#495057', name: 'Slate' },
]);

/** The fleet values a vehicle type (preset) sets. */
export const PRESET_KEYS = Object.freeze(['speed', 'accel', 'decel', 'length', 'capacity', 'loadTime', 'unloadTime']);
const PRESET_WORDS = { speed: 'top speed', accel: 'acceleration', decel: 'braking', length: 'length', capacity: 'capacity', loadTime: 'loading time', unloadTime: 'unloading time' };

const presetOf = (name) => FLEET_PRESETS[name] || FLEET_PRESETS.custom;
/** "AGV", "Forklift", "Tugger train", "Custom vehicle". */
export const presetName = (name) => presetOf(name).label.split(' (')[0];

/** The values of a vehicle type, as a fleet patch. */
export function presetPatch(name) {
  const base = presetOf(name);
  return Object.fromEntries(PRESET_KEYS.map((key) => [key, base[key]]));
}

/** Keys of the vehicle values the planner changed from the fleet's own type. */
export function presetChanges(fleet) {
  const base = presetOf(fleet.preset);
  return PRESET_KEYS.filter((key) => Math.abs(fleet[key] - base[key]) > 1e-9);
}

/** "top speed and loading time": the changed values in words. */
export const describeChanges = (keys) => joinWords(keys.map((key) => PRESET_WORDS[key]));

/** One line about a fleet for a collapsed card: "AGV · 1.5 m/s · carries 1 load". */
export function fleetSummary(fleet) {
  if (fleet.count === 0) return 'No vehicles yet';
  return `${presetName(fleet.preset)} · ${formatNumber(fleet.speed, 1)} m/s · carries ${plural(fleet.capacity, 'load')}`;
}

const WORKING = new Set(['toPickup', 'loading', 'toDrop', 'unloading']);
const CHARGING = new Set(['charging', 'toCharger']);
const IDLE = new Set(['idle', 'parked', 'toPark']);

/** Which live group a vehicle (VehicleRT of the simulation) counts in: working, waiting (stuck in traffic), idle, charging or down. */
export function vehicleGroup(vehicle) {
  if (vehicle.state === 'broken' || vehicle.state === 'dead') return 'down';
  if (vehicle.tv && vehicle.tv.waiting) return 'waiting';
  if (CHARGING.has(vehicle.state)) return 'charging';
  if (IDLE.has(vehicle.state)) return 'idle';
  return WORKING.has(vehicle.state) ? 'working' : 'idle';
}

const emptyCounts = () => ({ total: 0, working: 0, waiting: 0, idle: 0, charging: 0, down: 0 });

/** Live vehicle counts per fleet id: Map(fleetId -> { total, working, waiting, idle, charging, down }). */
export function fleetCounts(vehicles) {
  const counts = new Map();
  for (const vehicle of vehicles || []) {
    if (!counts.has(vehicle.fleetId)) counts.set(vehicle.fleetId, emptyCounts());
    const c = counts.get(vehicle.fleetId);
    c.total += 1;
    c[vehicleGroup(vehicle)] += 1;
  }
  return counts;
}

/** Flows that only this fleet may serve. */
export const restrictedFlows = (layout, fleetId) => layout.flows.filter((flow) => flow.fleetId === fleetId);

/** Depots that can charge batteries. */
export const chargingDepots = (layout) => layout.stations.filter((s) => s.type === 'depot' && s.params.chargers > 0);

/** Wording for the Breakdowns section from MTBF and MTTR in seconds (0 = never fails): { aside, hint, warn }. */
export function vehicleBreakdownSummary(mtbf, mttr) {
  if (!(mtbf > 0)) return { aside: 'never', hint: 'Vehicles never break down.', warn: false };
  const every = `every ${humanSeconds(mtbf)}`;
  if (!(mttr > 0)) return { aside: every, hint: 'Also set a repair time, otherwise the breakdowns have no effect.', warn: true };
  const available = Math.round((mtbf / (mtbf + mttr)) * 100);
  return { aside: every, hint: `Each vehicle breaks down about ${every} and needs ${humanSeconds(mttr)} to repair: available about ${available} % of the time. A broken vehicle blocks its lane until it is repaired.`, warn: false };
}

/** Wording for the Battery section: { aside, hint }. Runtime and charge time are minutes, levels are percent. */
export function batterySummary(battery) {
  if (!battery.enabled) return { aside: 'off', hint: 'Vehicles never run out of charge.' };
  const run = humanSeconds(battery.runtimeMin * 60);
  return {
    aside: `${run} per charge`,
    hint: `A full battery lasts ${run}. At ${battery.lowPct} % a free vehicle drives to a charger, charges for up to ${humanSeconds(battery.chargeTimeMin * 60)} and returns to work at ${battery.resumePct} %.`,
  };
}

/** Choices for the home-depot select: "any depot" first, then every depot of the plant. */
export function homeOptions(layout) {
  const depots = layout.stations.filter((s) => s.type === 'depot');
  return [
    { value: '', label: 'Any depot with a free place' },
    ...depots.map((d) => ({ value: d.id, label: `${d.name} (${plural(d.params.slots, 'place')})` })),
  ];
}

/** Hint under the idle-policy buttons; says what really happens when the plant has no depot. */
export function idleHint(fleet, depotCount) {
  if (fleet.idle === 'stay') return 'An idle vehicle waits where its last job ended. On a busy road it can block the lane behind it.';
  if (!depotCount) return 'There is no depot in the plant yet, so idle vehicles wait on the road. Add one with the Parking tool (5).';
  return 'An idle vehicle drives to a depot with a free place and waits there, off the road.';
}

// ---------------------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------------------

/** Re-render `host` only when the signature changed, so buttons inside keep keyboard focus between updates. */
function keyedRender(host) {
  let last = null;
  return (signature, build) => {
    if (signature === last) return;
    last = signature;
    host.replaceChildren(...build());
  };
}

/** `section()` that remembers (in `memory`) whether the planner opened or closed it, across rebuilds. */
function rememberedSection(memory, key, defaultOpen, title, aside, ...children) {
  const open = memory.has(key) ? memory.get(key) : defaultOpen;
  const s = section({ title, aside, open }, ...children);
  s.el.addEventListener('toggle', () => memory.set(key, s.el.open));
  return s;
}

/** Replace the hint under a field built by fields.js (the field must have been built with some hint text). */
function setHint(control, text, warn = false) {
  const el = control.el.querySelector('.field__hint');
  el.textContent = text;
  el.style.color = warn ? 'var(--warn-text)' : '';
}

function actionButton(text, iconName, onclick, cls = 'btn btn--sm') {
  return h('button', { class: cls, type: 'button', onclick }, icon(iconName, { size: 14 }), text);
}

/** Deleting something: commit, then offer Undo in the toast while that edit is still the latest one. */
function deleteWithUndo(ctx, label, mutator, message) {
  if (!ctx.store.commit(label, mutator)) return;
  const after = ctx.store.getState().layout;
  ctx.toast(message, { kind: 'info', action: { label: 'Undo', onClick: () => { if (ctx.store.getState().layout === after) ctx.store.undo(); } } });
}

// ---------------------------------------------------------------------------------------------------------
// Split button: "Add fleet" adds an AGV fleet, the arrow offers the other vehicle types
// ---------------------------------------------------------------------------------------------------------

function createSplitMenu({ label, primaryTitle, items, onPrimary, onPick }) {
  let open = false;
  const menu = h('div', { class: 'menu dropdown__menu dropdown__menu--end', role: 'menu', 'aria-label': 'Vehicle types', hidden: true });
  const entries = items.map((item) => h('button', {
    class: 'menu__item', type: 'button', role: 'menuitem', tabindex: '-1',
    onclick: () => { close(true); onPick(item.value); },
  }, icon(item.icon, { size: 16, class: 'menu__icon' }), h('span', null, item.label), h('span', { class: 'menu__kbd' }, item.detail)));
  menu.append(h('div', { class: 'menu__label' }, 'Add a fleet of'), ...entries);
  const main = h('button', {
    class: 'btn btn--primary', type: 'button', title: primaryTitle, onclick: onPrimary,
    style: { borderTopRightRadius: '0', borderBottomRightRadius: '0' },
  }, icon('plus', { size: 16 }), label);
  const caret = h('button', {
    class: 'btn btn--primary btn--icon', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Choose another vehicle type',
    style: { borderTopLeftRadius: '0', borderBottomLeftRadius: '0' }, onclick: () => (open ? close(true) : show()),
    onkeydown: (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); show(); } },
  }, icon('chevron-down', { size: 16 }));
  const el = h('div', { class: 'dropdown' }, h('div', { class: 'row', style: { '--gap': '1px' } }, main, caret), menu);

  const outside = (e) => { if (!el.contains(e.target)) close(false); };
  function show() {
    open = true;
    menu.hidden = false;
    caret.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    entries[0].focus();
  }
  function close(refocus) {
    if (!open) return;
    open = false;
    menu.hidden = true;
    caret.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) caret.focus();
  }
  menu.addEventListener('keydown', (e) => {
    const at = entries.indexOf(document.activeElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: entries.length - 1 }[e.key];
    if (move !== undefined) { e.preventDefault(); entries[(move + entries.length) % entries.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  });
  return { el, destroy() { close(false); el.remove(); } };
}

// ---------------------------------------------------------------------------------------------------------
// Colour picker: eight swatches as a radio group
// ---------------------------------------------------------------------------------------------------------

/** Row of colour swatches. A colour outside the eight (from an imported file) shows as one extra swatch. */
function colorField({ label, value, onChange }) {
  const labelId = uid('fleet-color');
  const swatches = [...COLOR_CHOICES, { value: '', name: 'Current colour' }].map((choice) => h('button', {
    class: 'btn btn--icon', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': choice.name, title: choice.name, tabindex: '-1',
    style: { width: '28px', height: '28px', padding: '0', borderRadius: 'var(--radius-md)' }, onclick: () => pick(choice.value || current),
  }));
  const extra = swatches[swatches.length - 1];
  let current = value;

  function paint(button, color, selected) {
    button.style.background = color;
    button.style.borderColor = selected ? 'var(--text)' : 'var(--control-border)';
    button.style.boxShadow = selected ? '0 0 0 1px var(--text)' : 'none';
    button.setAttribute('aria-checked', String(selected));
    button.replaceChildren(...(selected ? [icon('check', { size: 16 })] : []));
    button.style.color = inkFor(color);
  }
  function show(color) {
    current = color;
    const known = COLOR_CHOICES.some((c) => c.value.toLowerCase() === color.toLowerCase());
    extra.hidden = known;
    swatches.forEach((button, i) => {
      const swatchColor = i < COLOR_CHOICES.length ? COLOR_CHOICES[i].value : color;
      const selected = i < COLOR_CHOICES.length ? swatchColor.toLowerCase() === color.toLowerCase() : !known;
      paint(button, swatchColor, selected);
      button.tabIndex = selected ? 0 : -1;
    });
  }
  function pick(color) { show(color); onChange(color); }

  const group = h('div', { class: 'row row--wrap', role: 'radiogroup', 'aria-labelledby': labelId, style: { '--gap': '6px' } }, swatches);
  group.addEventListener('keydown', (e) => {
    const visible = swatches.filter((b) => !b.hidden);
    const at = visible.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (at < 0 || step === undefined) return;
    e.preventDefault();
    const next = visible[(at + step + visible.length) % visible.length];
    next.focus();
    next.click();
  });
  show(value);
  return {
    el: h('div', { class: 'field' }, h('span', { class: 'field__label', id: labelId }, label), group),
    set(color) { if (typeof color === 'string' && color !== current) show(color); },
    get: () => current,
    setDisabled(d) { for (const b of swatches) b.disabled = !!d; },
  };
}

// ---------------------------------------------------------------------------------------------------------
// One fleet card
// ---------------------------------------------------------------------------------------------------------

const NUMBER_FIELDS = Object.freeze([
  { key: 'speed', label: 'Top speed', unit: 'm/s', min: 0.1, max: 15, what: 'top speed', live: true },
  { key: 'accel', label: 'Acceleration', unit: 'm/s²', min: 0.05, max: 10, what: 'acceleration' },
  { key: 'decel', label: 'Braking', unit: 'm/s²', min: 0.05, max: 10, what: 'braking' },
  { key: 'length', label: 'Length', unit: 'm', min: 0.2, max: 20, what: 'length', live: true },
  { key: 'capacity', label: 'Capacity', unit: 'loads', min: 1, max: 100, int: true, what: 'capacity', hint: 'Loads one vehicle carries per trip.' },
  { key: 'loadTime', label: 'Loading time', unit: 's', min: 0, max: 3600, what: 'loading time' },
  { key: 'unloadTime', label: 'Unloading time', unit: 's', min: 0, max: 3600, what: 'unloading time', hint: 'How long a vehicle stands at a dock for each pick-up or drop.' },
]);

/** Hint of the two number fields (`live`) whose hint follows the value: speed in km/h, length against the grid cell. */
function liveHint(key, fleet, layout) {
  if (key === 'speed') return { text: `= ${formatNumber(fleet.speed * 3.6, 1)} km/h`, warn: false };
  const cell = layout.grid.cellSize;
  if (fleet.length > cell) return { text: `Longer than a grid cell (${formatNumber(cell, 1)} m): the vehicle overhangs neighbouring cells in corners and at docks.`, warn: true };
  return { text: `A grid cell is ${formatNumber(cell, 1)} m long.`, warn: false };
}

/** Everything the sections of one card share: store access, commit helpers and the list of in-place refreshers. */
function cardEnv(ctx, initial, memory) {
  const { store } = ctx;
  const id = initial.id;
  const syncs = [];
  const current = () => getFleet(store.getState().layout, id);
  const label = (what) => `Change ${what} of fleet ${quoted(current()?.name ?? '')}`;
  return {
    ctx, id, initial, syncs, memory,
    current,
    /** Commit a fleet patch under a readable label; typing and dragging merge into one undo step per field. */
    edit: (what, key, patchOf) => (value) => store.commit(label(what), (d) => updateFleet(d, id, patchOf(value)), { coalesce: `fleet:${id}:${key}` }),
  };
}

function vehicleSection(env) {
  const { ctx, id, initial, current, edit, syncs, memory } = env;
  const { store } = ctx;
  const name = textField({
    label: 'Fleet name', value: initial.name, maxLength: 80,
    onChange: (v) => store.commit(`Rename fleet ${quoted(current().name)}`, (d) => updateFleet(d, id, { name: v }), { coalesce: `fleet:${id}:name` }),
  });
  const color = colorField({ label: 'Colour', value: initial.color, onChange: edit('colour', 'color', (c) => ({ color: c })) });
  const type = selectField({
    label: 'Vehicle type', options: FLEET_PRESET_ORDER.map((key) => ({ value: key, label: FLEET_PRESETS[key].label })), value: initial.preset,
    onChange: (next) => choosePreset(next),
  });
  const note = hintLine('');
  const reset = actionButton('Reset to standard values', 'reset', () => applyPreset(current().preset, `Reset ${quoted(current().name)} to the standard ${presetName(current().preset)}`), 'btn btn--ghost btn--sm');
  const numbers = NUMBER_FIELDS.map((spec) => {
    const control = numberField({
      ...spec, hint: spec.live ? ' ' : spec.hint, inline: true, controlW: INLINE_W, value: initial[spec.key],
      onChange: edit(spec.what, spec.key, (v) => ({ [spec.key]: v })),
    });
    return { spec, control };
  });

  function applyPreset(preset, label) {
    store.commit(label, (d) => updateFleet(d, id, { preset, ...presetPatch(preset) }));
  }

  async function choosePreset(next) {
    const fleet = current();
    if (next === fleet.preset) return;
    // "Custom" keeps the values as they are, so nothing can be lost; any other type replaces them.
    const changed = next === 'custom' ? [] : presetChanges(fleet);
    if (changed.length) {
      const ok = await ctx.dialogs.confirm({
        title: `Switch to ${presetName(next)}?`,
        text: `Your changes to ${describeChanges(changed)} will be replaced by the standard ${presetName(next)} values. You can undo this afterwards.`,
        confirmLabel: 'Switch type',
      });
      if (!ok) { type.input.value = fleet.preset; return; }
    }
    const label = `Change vehicle type of ${quoted(fleet.name)} to ${presetName(next)}`;
    if (next === 'custom') store.commit(label, (d) => updateFleet(d, id, { preset: next }));
    else applyPreset(next, label);
  }

  syncs.push((fleet, state) => {
    name.set(fleet.name);
    color.set(fleet.color);
    type.set(fleet.preset);
    const changes = fleet.preset === 'custom' ? [] : presetChanges(fleet);
    if (fleet.preset === 'custom') note.textContent = 'Your own vehicle: set every value freely.';
    else note.textContent = changes.length ? `Changed from the standard ${presetName(fleet.preset)}: ${describeChanges(changes)}.` : `Standard ${presetName(fleet.preset)} values.`;
    reset.hidden = changes.length === 0;
    for (const { spec, control } of numbers) {
      control.set(fleet[spec.key]);
      if (spec.live) { const hint = liveHint(spec.key, fleet, state.layout); setHint(control, hint.text, hint.warn); }
    }
  });
  return rememberedSection(memory, `${id}:vehicle`, true, 'Vehicle', '', name.el, type.el, h('div', { class: 'stack', style: { '--gap': '4px', alignItems: 'flex-start' } }, note, reset), color.el, ...numbers.map((n) => n.control.el));
}

function batterySection(env) {
  const { ctx, initial, edit, syncs, memory, id } = env;
  const battery = (what, key, convert = (v) => v) => edit(what, `battery:${key}`, (v) => ({ battery: { [key]: convert(v) } }));
  const enabled = switchField({ label: 'Model the battery', checked: initial.battery.enabled, onChange: battery('battery model', 'enabled') });
  const runtime = numberField({ label: 'Runtime per charge', unit: 'h', inline: true, controlW: INLINE_W, min: 0.05, max: 160, value: initial.battery.runtimeMin / 60, hint: 'How long a full battery lasts while driving and working.', onChange: battery('battery runtime', 'runtimeMin', (v) => round(v * 60, 2)) });
  const charge = numberField({ label: 'Charge time', unit: 'min', inline: true, controlW: INLINE_W, min: 1, max: 10000, value: initial.battery.chargeTimeMin, hint: 'Time to charge from empty to full.', onChange: battery('charge time', 'chargeTimeMin') });
  const low = numberField({ label: 'Go charging below', unit: '%', inline: true, controlW: INLINE_W, min: 0, max: 100, value: initial.battery.lowPct, hint: 'A free vehicle heads for a charger when its battery falls below this level.', onChange: battery('charging threshold', 'lowPct') });
  const resume = numberField({ label: 'Back to work at', unit: '%', inline: true, controlW: INLINE_W, min: 0, max: 100, value: initial.battery.resumePct, hint: 'It stays on the charger until it reaches this level (never below the level above).', onChange: battery('resume level', 'resumePct') });
  const summary = hintLine('');
  const warning = h('div');
  const details = h('div', { class: 'stack', style: { '--gap': '12px' } }, runtime.el, charge.el, low.el, resume.el, warning);
  const sec = rememberedSection(memory, `${id}:battery`, false, 'Battery', '', enabled.el, summary, details);
  const draw = keyedRender(warning);

  syncs.push((fleet, state) => {
    const b = fleet.battery;
    enabled.set(b.enabled);
    runtime.set(round(b.runtimeMin / 60, 4));
    charge.set(b.chargeTimeMin);
    low.set(b.lowPct);
    resume.set(b.resumePct);
    const text = batterySummary(b);
    sec.setAside(text.aside);
    summary.textContent = text.hint;
    details.hidden = !b.enabled;
    const depots = state.layout.stations.filter((s) => s.type === 'depot');
    const missing = b.enabled && !chargingDepots(state.layout).length;
    draw(`${missing}:${depots.map((d) => d.id)}`, () => (missing ? [chargerWarning(ctx, depots)] : []));
  });
  return sec;
}

/** Warning for a battery fleet in a plant without charging places. */
function chargerWarning(ctx, depots) {
  const action = depots.length
    ? actionButton('Show depots', 'target', () => ctx.actions.focus({ stationIds: depots.map((d) => d.id) }))
    : actionButton('Use the Parking tool', 'depot', () => ctx.actions.setTool('depot'));
  return callout({
    severity: 'warning', title: 'No depot has charging places',
    text: depots.length
      ? 'Vehicles with a battery need somewhere to charge, otherwise they run flat and stop on the road. Give a depot charging places in its properties.'
      : 'Vehicles with a battery need somewhere to charge, otherwise they run flat and stop on the road. Add a parking and charging station.',
    actions: h('div', { class: 'row', style: { marginTop: '6px' } }, action),
  });
}

function breakdownSection(env) {
  const { initial, edit, syncs, memory, id } = env;
  const minutes = (what, key) => edit(what, key, (v) => ({ [key]: round(v * 60, 2) }));
  const mtbf = numberField({ label: 'Time between breakdowns', unit: 'min', inline: true, controlW: INLINE_W, min: 0, max: 100000, value: initial.mtbf / 60, hint: '0 = never breaks down.', onChange: minutes('breakdown interval', 'mtbf') });
  const mttr = numberField({ label: 'Repair time', unit: 'min', inline: true, controlW: INLINE_W, min: 0, max: 100000, value: initial.mttr / 60, onChange: minutes('repair time', 'mttr') });
  const summary = hintLine('');
  const sec = rememberedSection(memory, `${id}:breakdowns`, false, 'Breakdowns', '', mtbf.el, mttr.el, summary);
  syncs.push((fleet) => {
    mtbf.set(round(fleet.mtbf / 60, 4));
    mttr.set(round(fleet.mttr / 60, 4));
    const text = vehicleBreakdownSummary(fleet.mtbf, fleet.mttr);
    sec.setAside(text.aside);
    summary.textContent = text.hint;
    summary.style.color = text.warn ? 'var(--warn-text)' : '';
  });
  return sec;
}

function parkingSection(env) {
  const { initial, edit, syncs, memory, id, ctx } = env;
  const home = selectField({
    label: 'Home depot', inline: true, controlW: '180px', options: homeOptions(ctx.store.getState().layout), value: initial.home ?? '',
    hint: 'Where the fleet starts and parks.', onChange: edit('home depot', 'home', (v) => ({ home: v || null })),
  });
  const idle = segmentedField({
    label: 'When idle', value: initial.idle,
    options: [{ value: 'park', label: 'Park in depot' }, { value: 'stay', label: 'Stay on road' }],
    onChange: edit('idle behaviour', 'idle', (v) => ({ idle: v })),
  });
  const idleNote = hintLine('');
  const sec = rememberedSection(memory, `${id}:parking`, false, 'Parking', '', home.el, idle.el, idleNote);
  let optionsKey = '';
  syncs.push((fleet, state) => {
    const options = homeOptions(state.layout);
    const key = JSON.stringify(options);
    if (key !== optionsKey && document.activeElement !== home.input) { optionsKey = key; home.setOptions(options, fleet.home ?? ''); }
    home.set(fleet.home ?? '');
    const depot = fleet.home ? state.layout.stations.find((s) => s.id === fleet.home) : null;
    setHint(home, depot ? `${plural(depot.params.slots, 'parking place')}, ${depot.params.chargers} with a charger.` : 'Vehicles start and park in any depot that has a free place.');
    idle.set(fleet.idle);
    idleNote.textContent = idleHint(fleet, options.length - 1);
    sec.setAside(depot ? depot.name : fleet.idle === 'stay' ? 'stay on road' : 'any depot');
  });
  return sec;
}

/** The card header: collapse button with colour and name, duplicate and delete, and below it the vehicle count with the live status. */
function cardHeader(env, onToggle) {
  const { ctx, id, initial, syncs } = env;
  const dot = h('span', { class: 'swatch', style: { width: '14px', height: '14px', borderRadius: 'var(--radius-sm)' } });
  const name = h('span', { class: 'truncate', style: { minWidth: 0 } });
  const toggle = h('button', { class: 'section__header', type: 'button', 'aria-expanded': 'true', style: { flex: '1 1 auto', minWidth: 0 }, onclick: onToggle },
    icon('chevron-right', { size: 14, class: 'section__chevron' }), dot, name);
  const duplicate = h('button', { class: 'btn btn--icon btn--sm btn--ghost', type: 'button', 'aria-label': 'Duplicate fleet', title: 'Duplicate fleet', onclick: () => duplicateCard(ctx, id) }, icon('copy', { size: 16 }));
  const remove = h('button', { class: 'btn btn--icon btn--sm btn--danger-ghost', type: 'button', 'aria-label': 'Delete fleet', title: 'Delete fleet', onclick: () => deleteCard(ctx, id) }, icon('trash', { size: 16 }));
  const count = stepperField({
    label: 'Vehicles', value: initial.count, min: 0, max: 500, inline: false,
    onChange: env.edit('vehicle count', 'count', (n) => ({ count: n })),
  });
  count.el.querySelector('.field__label').classList.add('sr-only');
  count.input.style.width = '44px';
  const summary = h('span', { class: 'text-dim truncate', style: { minWidth: 0, fontSize: 'var(--fs-sm)' } });
  const status = createStatusRow();
  const quick = h('div', { class: 'row row--wrap', style: { padding: '0 12px 12px 12px', '--gap': '12px' } }, count.el, summary, status.el);
  const el = h('div', null, h('div', { class: 'row', style: { '--gap': '2px', paddingRight: '8px' } }, toggle, duplicate, remove), quick);

  syncs.push((fleet, state, live) => {
    name.textContent = fleet.name;
    dot.style.background = fleet.color;
    count.set(fleet.count);
    summary.textContent = fleetSummary(fleet);
    summary.hidden = !!live;
    status.set(live);
  });
  return { el, toggle };
}

/** Working / waiting / idle (and, only when there are any, charging / out of service) with a dot each; hidden without a simulation. */
function createStatusRow() {
  const parts = [['working', 'driving', 'working'], ['waiting', 'waiting', 'waiting'], ['idle', 'idle', 'idle'], ['charging', 'charging', 'charging'], ['down', 'broken', 'out of service']].map(([key, tone, word]) => {
    const text = h('span');
    return { key, word, text, el: h('span', { class: 'row', style: { '--gap': '5px' } }, h('span', { class: `dot tone-${tone}` }), text) };
  });
  const el = h('div', { class: 'row row--wrap', role: 'group', 'aria-label': 'Live status', style: { '--gap': '10px', fontSize: 'var(--fs-sm)' }, hidden: true }, parts.map((p) => p.el));
  return {
    el,
    set(counts) {
      el.hidden = !counts;
      if (!counts) return;
      for (const p of parts) {
        const n = counts[p.key];
        p.el.hidden = n === 0 && (p.key === 'charging' || p.key === 'down');
        p.text.textContent = `${n} ${p.word}`;
      }
    },
  };
}

function duplicateCard(ctx, id) {
  let copy = null;
  const name = getFleet(ctx.store.getState().layout, id).name;
  ctx.store.commit(`Duplicate fleet ${quoted(name)}`, (d) => { copy = duplicateFleet(d, id); if (!copy) return false; });
  if (copy) ctx.store.select('fleet', [copy.id]);
}

async function deleteCard(ctx, id) {
  const layout = ctx.store.getState().layout;
  const fleet = getFleet(layout, id);
  const flows = restrictedFlows(layout, id);
  if (flows.length) {
    const nameOf = (stationId) => layout.stations.find((s) => s.id === stationId)?.name ?? '?';
    const names = flows.slice(0, 3).map((f) => `${nameOf(f.from)} → ${nameOf(f.to)}`);
    const more = flows.length > 3 ? ` and ${flows.length - 3} more` : '';
    const ok = await ctx.dialogs.confirm({
      title: `Delete fleet ${quoted(fleet.name)}?`,
      text: `${plural(flows.length, 'flow is', 'flows are')} restricted to this fleet (${names.join(', ')}${more}). After deleting it, any other fleet may serve ${flows.length === 1 ? 'that flow' : 'those flows'}. You can undo this afterwards.`,
      confirmLabel: 'Delete fleet', danger: true,
    });
    if (!ok) return;
  }
  deleteWithUndo(ctx, `Delete fleet ${quoted(fleet.name)}`, (d) => removeFleet(d, id), `Deleted fleet ${quoted(fleet.name)}.`);
}

/** One fleet: { el, update(fleet, state, live), setSelected(bool), reveal(), focusHeader() }. */
function createFleetCard(ctx, initial, memory, open) {
  const env = cardEnv(ctx, initial, memory);
  let expanded = open;
  const body = h('div', { class: 'stack', style: { '--gap': '0', borderTop: '1px solid var(--border)' }, id: `fleet-body-${env.id}` });
  const head = cardHeader(env, () => setExpanded(!expanded));
  head.toggle.setAttribute('aria-controls', body.id);
  body.append(vehicleSection(env).el, batterySection(env).el, breakdownSection(env).el, parkingSection(env).el);
  const el = h('div', { class: 'card', role: 'group', 'aria-label': `Fleet ${initial.name}`, dataset: { fleet: env.id } }, head.el, body);

  function setExpanded(value) {
    expanded = value;
    body.hidden = !value;
    head.toggle.setAttribute('aria-expanded', String(value));
  }
  setExpanded(open);

  // Using a card selects its fleet on the plan, so the planner sees which vehicles belong to it.
  el.addEventListener('focusin', () => {
    const selection = ctx.store.getState().ui.selection;
    if (selection.kind !== 'fleet' || selection.ids.length !== 1 || selection.ids[0] !== env.id) ctx.store.select('fleet', [env.id]);
  });

  return {
    el,
    update(fleet, state, live) {
      el.setAttribute('aria-label', `Fleet ${fleet.name}`);
      for (const sync of env.syncs) sync(fleet, state, live);
    },
    setSelected(on) { el.classList.toggle('card--selected', on); },
    /** Bring a fleet that was selected elsewhere into view, unless the planner is working inside this card right now. */
    reveal() {
      if (el.contains(document.activeElement)) return;
      setExpanded(true);
      el.scrollIntoView({ block: 'nearest' });
    },
    focusHeader() { head.toggle.focus(); },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------------------

const SPLIT_ITEMS = FLEET_PRESET_ORDER.map((key) => ({
  value: key,
  label: presetName(key),
  icon: key === 'forklift' ? 'forklift' : 'truck',
  detail: `${formatNumber(FLEET_PRESETS[key].speed, 1)} m/s · ${FLEET_PRESETS[key].capacity} ${FLEET_PRESETS[key].capacity === 1 ? 'load' : 'loads'}`,
}));

/**
 * Create the Fleet panel.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): store, runner, toast, dialogs.confirm, actions.{focus, setTool}
 * @returns {{ el: HTMLElement, update(state: object): void, destroy(): void }}
 */
export function createFleetPanel(ctx) {
  const { store } = ctx;
  const memory = new Map();
  const cards = new Map();
  let lastSelection = '';

  const summary = h('span', { class: 'text-dim', style: { fontSize: 'var(--fs-sm)' } });
  const split = createSplitMenu({
    label: 'Add fleet', primaryTitle: 'Add an AGV fleet. Use the arrow for forklifts, tuggers and custom vehicles.', items: SPLIT_ITEMS,
    onPrimary: () => addFromPreset('agv'), onPick: addFromPreset,
  });
  const top = h('div', { class: 'row', style: { padding: '12px', alignItems: 'flex-start' } },
    h('div', { class: 'stack', style: { '--gap': '2px', minWidth: 0 } }, h('span', { class: 'eyebrow' }, 'Vehicle fleets'), summary), h('span', { class: 'spacer' }), split.el);
  const list = h('div', { class: 'stack', style: { padding: '0 12px 12px', '--gap': '12px' } });
  const empty = emptyState({
    iconName: 'truck', title: 'Add your first vehicle fleet',
    text: 'Vehicles carry the loads between your stations along the roads. Pick a type to start; you can tune every value afterwards.',
    actions: FLEET_PRESET_ORDER.map((key) => actionButton(presetName(key), key === 'forklift' ? 'forklift' : 'truck', () => addFromPreset(key), key === 'agv' ? 'btn btn--primary btn--sm' : 'btn btn--sm')),
  });
  empty.querySelector('.empty__actions').style.flexWrap = 'wrap';
  empty.querySelector('.empty__actions').style.justifyContent = 'center';
  const el = h('div', { 'data-panel': 'fleet' }, top, list, empty);

  function addFromPreset(preset) {
    let created = null;
    store.commit(`Add ${presetName(preset)} fleet`, (d) => { created = addFleet(d, preset); });
    if (!created) return;
    store.select('fleet', [created.id]);
    update(store.getState());
    cards.get(created.id)?.focusHeader();
  }

  /** Create cards for new fleets, drop cards of removed ones and put the rest in layout order. */
  function syncCards(fleets) {
    const ids = new Set(fleets.map((f) => f.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.el.remove(); cards.delete(id); }
    fleets.forEach((fleet, i) => {
      if (!cards.has(fleet.id)) cards.set(fleet.id, createFleetCard(ctx, fleet, memory, fleets.length <= 2));
      const card = cards.get(fleet.id);
      if (list.children[i] !== card.el) list.insertBefore(card.el, list.children[i] || null);
    });
  }

  function update(state) {
    const fleets = state.layout.fleets;
    syncCards(fleets);
    const sim = ctx.runner?.sim;
    const counts = sim ? fleetCounts(sim.vehicles) : null;
    for (const fleet of fleets) cards.get(fleet.id).update(fleet, state, counts ? counts.get(fleet.id) || emptyCounts() : null);
    const vehicles = fleets.reduce((sum, f) => sum + f.count, 0);
    summary.textContent = fleets.length ? `${plural(fleets.length, 'fleet')} · ${plural(vehicles, 'vehicle')}` : '';
    empty.hidden = fleets.length > 0;
    list.hidden = fleets.length === 0;
    showSelection(state.ui.selection);
  }

  function showSelection(selection) {
    const ids = selection.kind === 'fleet' ? selection.ids : [];
    for (const [id, card] of cards) card.setSelected(ids.includes(id));
    const signature = ids.join(',');
    if (signature !== lastSelection) {
      lastSelection = signature;
      if (ids.length) cards.get(ids[0])?.reveal();
    }
  }

  // A field that was being typed in may hold text the model rejected or clamped: show the real value once the planner leaves it.
  let resync = null;
  el.addEventListener('focusout', () => {
    clearTimeout(resync);
    resync = setTimeout(() => update(store.getState()), 0);
  });

  update(store.getState());
  return { el, update, destroy() { clearTimeout(resync); split.destroy(); el.remove(); } };
}
