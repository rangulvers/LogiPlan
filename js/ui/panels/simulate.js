// What-if panel (docs/ARCHITECTURE.md 6.5): big friendly controls to try ideas on the plant - how much material arrives, how
// fast vehicles drive, how slow machines work - plus the strategy, traffic-rule, random-seed and run-length settings.
//
//   const panel = createSimulatePanel(ctx);   // panel.el, panel.update(state), panel.destroy()
//
// Every control writes `layout.settings` through store.commit. The runtime keys (demand, vehicle speed, process time,
// dispatch, routing) take effect in a running simulation at once, because the runner applies them with sim.setRuntime;
// dragging a slider commits with the coalesce key `runtime:<key>`, so the whole drag is ONE undo step. The other settings
// (lane side, deadlock handling, seed, warm-up) rebuild the simulation, which the panel says in plain words.
// The form is built once; update() only refreshes values and never touches a field that has focus.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { DISPATCH_STRATEGIES, ROUTING_MODES } from '../../model/defaults.js';
import { updateSettings } from '../../model/layout.js';
import { round, formatDuration } from '../../util/format.js';
import { numberField, selectField, rangeField, segmentedField, switchField, section } from './fields.js';
import { primeSeconds } from '../runner.js';

/** The three what-if factors: settings key, label, slider range, wording (`short` continues a sentence, `hint` explains the factor). */
export const FACTORS = Object.freeze([
  { key: 'demandFactor', label: 'Demand', short: 'demand', min: 0.2, max: 3,
    hint: 'Every goods-in source delivers this many times as many loads. 1.5× means 50 % more.' },
  { key: 'speedFactor', label: 'Vehicle speed', short: 'vehicle speed', min: 0.2, max: 2,
    hint: 'All vehicles drive this many times as fast. 0.5× is half speed.' },
  { key: 'processFactor', label: 'Process time', short: 'process time', min: 0.5, max: 2,
    hint: 'Machine cycle times are multiplied by this: 1.2× means every workstation is 20 % slower.' },
]);

const FACTOR_STEP = 0.05;
const SEED_MAX = 4294967295;
const SEED_CHOICES = 999999;

/** "1.25×", "1×", "0.2×": a factor without trailing zeros. */
export const formatFactor = (v) => `${Number(Number(v).toFixed(2))}×`;

/** One line about the factors that differ from 1: "All factors at 1×" or "Demand 1.5×, process time 1.2×". */
export function factorSummary(settings) {
  const changed = FACTORS.filter((f) => Math.abs(settings[f.key] - 1) > 1e-9);
  const text = changed.length
    ? changed.map((f, i) => `${i === 0 ? f.label : f.short} ${formatFactor(settings[f.key])}`).join(', ')
    : 'All factors at 1×';
  return { changed: changed.map((f) => f.key), text };
}

/** A friendly new seed (1 to 999999) that differs from `current`; `rand` returns [0, 1). */
export function nextSeed(current, rand = Math.random) {
  const seed = 1 + Math.floor(rand() * SEED_CHOICES);
  return seed === current ? (seed % SEED_CHOICES) + 1 : seed;
}

/** What the warm-up and run length mean together: { warn, text }. Times in seconds. */
export function measuredWindow(warmup, duration) {
  if (warmup >= duration) return { warn: true, text: 'The warm-up must be shorter than the run, otherwise nothing is measured.' };
  return { warn: false, text: `Results are measured over the last ${formatDuration(duration - warmup)} of each run.` };
}

/** Dice icon (the icon set has none): same 24x24 stroke style as icons.js. */
function diceIcon(size = 14) {
  const dot = (cx, cy) => h('svg:circle', { cx, cy, r: 1.25, fill: 'currentColor', stroke: 'none' });
  return h('svg:svg', {
    class: 'icon icon--dice', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  }, h('svg:rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 3.5 }), dot(8.5, 8.5), dot(15.5, 8.5), dot(12, 12), dot(8.5, 15.5), dot(15.5, 15.5));
}

const hintLine = (text) => h('p', { class: 'field__hint' }, text);

/** The sentence under the "keep results warm" switch: how long the silent run before the swap is for this warm-up. */
function warmHint(warmup) {
  const ahead = primeSeconds(warmup);
  if (ahead < warmup) { // the silent run is capped: a long warm-up is not over when the new simulation appears
    return `After you change the plant, the updated simulation first runs silently for ${formatDuration(ahead)}. Your warm-up of ${formatDuration(warmup)} is longer than that, so Results need another ${formatDuration(warmup - ahead)} of simulated time before they show numbers.`;
  }
  return `After you change the plant, the updated simulation first runs silently for ${formatDuration(ahead)}, so Results show numbers at once instead of starting from an empty plant.`;
}

/** Select with a line under it that explains the chosen option. `options`: [{ value, label, description }]. */
function describedSelect({ label, options, value, onChange }) {
  const note = hintLine('');
  const explain = (v) => { note.textContent = options.find((o) => o.value === v)?.description || ''; };
  const control = selectField({ label, options, value, onChange: (v) => { explain(v); onChange(v); } });
  control.el.append(note);
  explain(value);
  return { el: control.el, set(v) { control.set(v); explain(v); } };
}

const optionsOf = (table) => Object.entries(table).map(([value, o]) => ({ value, label: o.label, description: o.description }));

/** Show a stored value that lies outside the slider's normal range (from an imported plant) instead of clamping it. */
function fitRange(control, base, value) {
  const lo = Math.min(base.min, value);
  const hi = Math.max(base.max, value);
  if (Number(control.input.min) !== lo) control.input.min = String(lo);
  if (Number(control.input.max) !== hi) control.input.max = String(hi);
}

/**
 * Create the What-if panel.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): store, actions.setRightTab
 * @returns {{ el: HTMLElement, update(state: object): void, destroy(): void }}
 */
export function createSimulatePanel(ctx) {
  const { store } = ctx;
  const start = store.getState().layout.settings;
  const setting = (what, patch, coalesce) => store.commit(`Change ${what}`, (d) => updateSettings(d, patch), coalesce ? { coalesce } : undefined);
  const live = (key, what) => (value) => setting(what, { [key]: value }, `runtime:${key}`);

  // ---- factors
  const sliders = FACTORS.map((f) => ({
    f,
    control: rangeField({ label: f.label, hint: f.hint, min: f.min, max: f.max, step: FACTOR_STEP, value: start[f.key], format: formatFactor, resetValue: 1, onChange: live(f.key, f.short) }),
  }));
  const summary = h('span', { class: 'text-dim' });
  const resetAll = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => store.commit('Reset what-if factors', (d) => updateSettings(d, { demandFactor: 1, speedFactor: 1, processFactor: 1 })) },
    icon('reset', { size: 14 }), 'Reset all factors to 1×');

  // ---- strategy
  const dispatch = describedSelect({ label: 'Dispatch strategy', options: optionsOf(DISPATCH_STRATEGIES), value: start.dispatch, onChange: live('dispatch', 'dispatch strategy') });
  const routing = describedSelect({ label: 'Routing', options: optionsOf(ROUTING_MODES), value: start.routing, onChange: live('routing', 'routing') });

  // ---- traffic rules
  const lane = segmentedField({
    label: 'Lane side', value: start.handedness,
    options: [{ value: 'right', label: 'Right-hand traffic' }, { value: 'left', label: 'Left-hand traffic' }],
    onChange: (v) => setting('lane side', { handedness: v }),
  });
  lane.el.append(hintLine('Which side of a two-way road vehicles drive on.'));
  const deadlock = describedSelect({
    label: 'Deadlock handling', value: start.deadlock, onChange: (v) => setting('deadlock handling', { deadlock: v }),
    options: [
      { value: 'resolve', label: 'Resolve automatically', description: 'When vehicles block each other for good, one is moved to a free spot nearby so the plant keeps running. Each event is counted in the results.' },
      { value: 'ignore', label: 'Let the jam stand', description: 'Nothing is done: you see the gridlock exactly as it would happen. Useful for finding layout problems.' },
    ],
  });

  // ---- randomness and run length
  const seed = numberField({ label: 'Random seed', int: true, min: 0, max: SEED_MAX, step: 1, value: start.seed, onChange: (v) => setting('random seed', { seed: v }, 'settings:seed') });
  const newSeed = h('button', { class: 'btn', type: 'button', onclick: () => setting('random seed', { seed: nextSeed(seed.get()) }) }, diceIcon(), 'New seed');
  const duration = numberField({ label: 'Run length', unit: 'h', min: 0.1, max: 720, value: start.duration / 3600, onChange: (v) => setting('run length', { duration: Math.round(v * 3600) }, 'settings:duration') });
  const warmup = numberField({ label: 'Warm-up', unit: 'min', min: 0, max: 10080, value: start.warmup / 60, onChange: (v) => setting('warm-up time', { warmup: Math.round(v * 60) }, 'settings:warmup') });
  const measured = hintLine('');

  // ---- after an edit (a view preference, not part of the plant: it is not undoable and not saved in the project)
  const warm = switchField({
    label: 'Keep results warm after edits', checked: store.getState().ui.warmRestart !== false,
    hint: warmHint(start.warmup),
    onChange: (on) => store.setUi({ warmRestart: on }),
  });

  // ---- statistics of clicked items (view preferences, like the switch above: not undoable, not saved in the project)
  const detail = switchField({
    label: 'Collect statistics for clicked items', checked: store.getState().ui.detail !== false,
    hint: 'Lets a click on a vehicle, a station, a flow or a road show its numbers and, for a vehicle, the routes it usually takes. It makes the simulation a little slower (about 10 %). Turned on while the simulation runs, it counts from that moment.',
    onChange: (on) => store.setUi({ detail: on }),
  });
  const statsDock = selectField({
    label: 'Statistics on click', value: store.getState().ui.statsDock,
    options: [
      { value: 'data', label: 'When the simulation has data' },
      { value: 'always', label: 'Always' },
      { value: 'never', label: 'Never' },
    ],
    onChange: (v) => store.setUi({ statsDock: v }),
  });
  statsDock.el.append(hintLine('When a click on an item opens the Statistics panel over the plan. The key I opens or closes it for the selected item, whatever is chosen here. "When the simulation has data" waits until it has measured 30 seconds.'));

  const el = h('div', { class: 'stack', style: { '--gap': '0' }, 'data-panel': 'simulate' },
    h('div', { class: 'stack', style: { padding: '12px', '--gap': '8px' } },
      h('span', { class: 'eyebrow' }, 'What-if'),
      hintLine('Try ideas without changing the plant. Factors apply to the running simulation at once, and Undo takes them back.'),
      h('div', null, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => ctx.actions.setRightTab('results') }, icon('chart', { size: 14 }), 'How to read the results'))),
    section({ title: 'Factors' }, ...sliders.map((s) => s.control.el), h('div', { class: 'row row--wrap' }, summary, h('span', { class: 'spacer' }), resetAll)).el,
    section({ title: 'Dispatching and routing', aside: 'live' }, dispatch.el, routing.el).el,
    section({ title: 'Traffic rules', aside: 'restarts the run' }, lane.el, deadlock.el).el,
    section({ title: 'Randomness', aside: 'restarts the run' },
      h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, seed.el), newSeed),
      hintLine('The same plant with the same seed always gives the same result. Try other seeds to see how much chance matters.')).el,
    section({ title: 'Experiment length' },
      h('div', { class: 'field-grid' }, duration.el, warmup.el), measured,
      hintLine('Used by experiments and reports. Changing the warm-up restarts the running simulation.')).el,
    section({ title: 'After you edit the plant' }, warm.el).el,
    section({ title: 'Statistics', aside: 'view' }, detail.el, statsDock.el).el);

  function update(state) {
    const s = state.layout.settings;
    for (const { f, control } of sliders) {
      fitRange(control, f, s[f.key]);
      control.set(s[f.key]);
    }
    const factors = factorSummary(s);
    summary.textContent = factors.text;
    resetAll.disabled = factors.changed.length === 0;
    dispatch.set(s.dispatch);
    routing.set(s.routing);
    lane.set(s.handedness);
    deadlock.set(s.deadlock);
    seed.set(s.seed);
    duration.set(round(s.duration / 3600, 4));
    warmup.set(round(s.warmup / 60, 4));
    const result = measuredWindow(s.warmup, s.duration);
    measured.textContent = result.text;
    measured.style.color = result.warn ? 'var(--warn-text)' : '';
    if (document.activeElement !== warm.input) warm.set(state.ui.warmRestart !== false);
    if (document.activeElement !== detail.input) detail.set(state.ui.detail !== false);
    statsDock.set(state.ui.statsDock);
    const hint = warmHint(s.warmup);
    const hintEl = warm.el.querySelector('.field__hint');
    if (hintEl.textContent !== hint) hintEl.textContent = hint;
  }

  update(store.getState());
  return { el, update, destroy() { el.remove(); } };
}
