// Change impact (browser UI + pure view models): "what did my edit do?" The runner keeps a BASELINE (the old plant, see js/ui/runner.js)
// and a warm restart makes the updated plant steady within a second; this file puts the two side by side.
//
//   const card = createImpactCard(ctx);   // card.el goes to the top of the Results tab; card.update(report?), card.destroy()
//   const hint = createImpactHint(ctx);   // one line under the simulation bar; hint.el, hint.update(state), hint.destroy()
//
// The comparison is FAIR: the runner simulates the OLD plant afresh next to the new one, for the same measured window and with the same
// random seed (baseline.control and baseline.after), so a change that cannot matter (renaming a station) reads exactly +-0 and one that
// does is not drowned in the run-to-run noise of setting a short window against an hour-long one. Measured on the three examples with 450
// paired runs of 10, 15 and 20 minutes (a station renamed, vehicles 1-3 % faster, 5 % more acceleration, 0.3 s more loading time): the
// renamed station changed nothing at all, lead time and work in progress moved by at most 6 %, the share of waiting in traffic by at most
// 3.5 points and the loads finished by at most one (two on the congestion lab); the same plant with another seed moved up to 26 %, 13
// points and 2 loads. The bands below sit just above the paired noise: a figure is coloured only when it moved by more than its band, and
// the throughput and the lead time also need loads to count (a handful of loads cannot show a percentage).
//
// The card shows six figures as "before -> after" with a change chip. The chip is neutral for everything inside the noise band and for
// figures where neither direction is better (fleet utilization), and its text carries the sign and a hidden "better" / "worse" for readers
// who cannot see colour. A plant that stands still after the change (no load finished) says so and is never called better. Buttons:
// "Keep as baseline" (the plant as it is now becomes the reference of the next edit), "Compare properly..." (adds the old plant as a variant
// and opens the Experiments tab, which runs both plants several times) and "Dismiss". Consecutive edits keep the ORIGINAL baseline, so the
// card lists every edit since then.
//
// Pure view models (impactModel, classifyDelta, windowStatus, ...) have no DOM and are unit-tested in tests/ui.impact.test.js.
// The card is built once and then only patched in place (golden rule of js/ui/panels/fields.js); every number goes through
// js/util/format.js; every part tolerates null (no baseline, no report, a figure that cannot be computed).

import { h } from '../../util/dom.js';
import { formatDuration, formatNumber } from '../../util/format.js';
import { METRICS, summarizeReport } from '../../sim/experiments.js';
import { icon } from '../icons.js';
import { isMeasured } from '../runner.js';
import { isDayPlant } from '../day-plant.js';
import { uid } from './fields.js';

/** A comparison counts as solid once the compared window is this long (s). */
export const COMPARE_FULL_SECONDS = 1200;
/** Default noise band (share of the "before" value) for a figure that has none of its own: just above the paired run-to-run noise. */
export const NOISE_RELATIVE = 0.08;
/** Labels named in a title before "and n more". */
export const MAX_NAMED_LABELS = 3;

/** Shown when none of the six figures changed beyond noise. */
export const NO_CHANGE_NOTE = 'No figure changed clearly in this short comparison. If you expected an effect, check that the new parts are connected to the rest of the plant (Checks tab) and that vehicles can reach them. Compare properly… repeats both plants with several runs.';
/** Shown when the updated plant finished no load although the old one did. */
export const STALLED_NOTE = 'No load was finished in the updated plant during this time. Check that every station can be reached and that the vehicles have roads to drive on (Checks tab).';

const MINUS = '−';
const DASH = '–';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** One decimal below 100 (before and after are compared, so 20 -> 20.4 must not read 20 -> 20), none above. */
const amount = (v) => formatNumber(v, Math.abs(v) < 100 ? 1 : 0);

/**
 * The six figures of the card, in order. `metric` is the id in js/sim/experiments.js METRICS (which also says which direction is
 * better); `kind` how the change is worded ('relative': "+36 %", 'points': "+3 pts"); `fmt` formats one value, `unit` follows the
 * "before -> after" pair. A change is noise when it is smaller than `floor` (in the unit of the figure) or than `relative` of the
 * "before" value (NOISE_RELATIVE when absent); `minCount` is the number of loads that must stand behind the figure on each side
 * (throughput: the loads the change amounts to, lead time: loads measured before and after).
 */
export const IMPACT_FIGURES = Object.freeze([
  { id: 'throughput', metric: 'throughput', label: 'Throughput', unit: '/h', kind: 'relative', floor: 1, relative: 0.15, minCount: 2, fmt: amount,
    help: 'Finished loads leaving the plant per hour. A change of fewer than two loads in the compared time is not rated.' },
  { id: 'leadTime', metric: 'leadMean', label: 'Lead time (mean)', unit: '', kind: 'relative', floor: 5, relative: 0.08, minCount: 3, fmt: (v) => formatDuration(v),
    help: 'Average time a load needs from entering the plant to leaving it.' },
  { id: 'wip', metric: 'wip', label: 'Work in progress', unit: 'loads', kind: 'relative', floor: 0.5, relative: 0.08, fmt: amount,
    help: 'Loads in the plant on average: waiting, being carried or being worked on.' },
  { id: 'fleet', metric: 'fleetUtilization', label: 'Fleet utilization', unit: '%', kind: 'points', floor: 1, relative: 0.08, fmt: (v) => formatNumber(v, 0),
    help: 'Share of time the vehicles are working. Neither more nor less is better by itself, so the change is not coloured.' },
  { id: 'traffic', metric: 'waitShare', label: 'Time waiting in traffic', unit: '%', kind: 'points', floor: 4, relative: 0.08, fmt: (v) => formatNumber(v, v < 10 ? 1 : 0),
    help: 'Share of the driving time that vehicles stand still because another vehicle, a junction or a broken-down vehicle is in the way.' },
  { id: 'deadlocks', metric: 'deadlocks', label: 'Deadlocks', unit: '', kind: 'relative', floor: 0.5, relative: 0, fmt: (v) => formatNumber(v, 0),
    help: 'Times vehicles blocked each other in a circle.' },
]);

const BETTER = new Map(METRICS.map((m) => [m.id, m.better]));

// ---------------------------------------------------------------------------------------------------------------------
// Pure view models
// ---------------------------------------------------------------------------------------------------------------------

/** Loads finished in a report, or null. */
const loadsOf = (report) => (report && report.throughput && isNum(report.throughput.total) ? report.throughput.total : null);
/** Loads whose lead time a report measured, or null. */
const leadCountOf = (report) => (report && report.leadTime && isNum(report.leadTime.count) ? report.leadTime.count : null);

/** Did any vehicle of the report drive (or try to) at all? Unknown (no shares in the report) counts as yes. */
function droveIn(report) {
  const fleets = report && report.fleets ? Object.values(report.fleets) : [];
  const shares = fleets.filter((f) => f && f.shares);
  if (!shares.length) return true;
  return shares.some((f) => (f.count || 0) > 0 && (f.shares.driving || 0) + (f.shares.waiting || 0) > 0.0005);
}

/**
 * How one figure changed from `before` to `after`.
 * @param {{ metric: string, kind: string, floor: number, relative?: number, minCount?: number, fmt: Function }} figure one of IMPACT_FIGURES
 * @param {number|null} before
 * @param {number|null} after
 * @param {{ seconds?: number, countBefore?: number|null, countAfter?: number|null, loadsBefore?: number|null, loadsAfter?: number|null }|null} [context]
 *   what stands behind the two numbers: the compared window (s) and the loads counted in it. Without it only the band applies.
 * @returns {{ tone: 'good'|'bad'|'neutral', noise: boolean, known: boolean, delta: number|null, relative: number|null, text: string, label: string }}
 *   `label` is the hidden text for readers who do not see the colour: 'better', 'worse', 'no clear change', 'for information' or 'not comparable'
 */
export function classifyDelta(figure, before, after, context = null) {
  if (!isNum(before) || !isNum(after)) return { tone: 'neutral', noise: false, known: false, delta: null, relative: null, text: DASH, label: 'not comparable' };
  const delta = after - before;
  const relative = before !== 0 ? delta / Math.abs(before) : (delta === 0 ? 0 : Infinity * Math.sign(delta));
  const band = figure.relative ?? NOISE_RELATIVE;
  let noise = Math.abs(delta) < figure.floor || Math.abs(relative) < band;
  if (!noise && context) noise = tooFewToTell(figure, delta, context);
  const better = BETTER.get(figure.metric) ?? null;
  let tone = 'neutral';
  if (!noise && better) tone = (better === 'higher') === (delta > 0) ? 'good' : 'bad';
  const label = tone === 'good' ? 'better' : tone === 'bad' ? 'worse' : noise ? 'no clear change' : 'for information';
  return { tone, noise, known: true, delta, relative, text: deltaText(figure, delta, before, relative), label };
}

/** A handful of loads cannot show a percentage: the throughput needs a change of `minCount` loads, the lead time that many loads on each side. */
function tooFewToTell(figure, delta, context) {
  if (!figure.minCount) return false;
  if (figure.metric === 'throughput') return isNum(context.seconds) && Math.abs(delta) * (context.seconds / 3600) < figure.minCount - 0.01; // 0.01: a window of 599.99 s is a window of 600 s
  if (figure.metric === 'leadMean') return Math.min(context.countBefore ?? Infinity, context.countAfter ?? Infinity) < figure.minCount;
  return false;
}

/** "+36 %", "−2.1 pts", "+2", "±0": the size of a change in words that carry the sign. */
function deltaText(figure, delta, before, relative) {
  if (delta === 0) return '±0';
  const sign = delta > 0 ? '+' : MINUS;
  let shown;
  if (figure.kind === 'points') shown = `${formatNumber(Math.abs(delta), Math.abs(delta) < 10 ? 1 : 0)} pts`;
  else if (before === 0 || !Number.isFinite(relative)) shown = figure.fmt(Math.abs(delta));
  else {
    const percent = Math.abs(relative) * 100;
    shown = percent >= 1000 ? '999+ %' : `${formatNumber(percent, percent < 10 ? 1 : 0)} %`;
  }
  return /^0( |$)/.test(shown) ? '±0' : `${sign}${shown}`; // a change that rounds to nothing is no "−0 pts"
}

/**
 * How reliable the numbers of one report (the compared window of the updated plant) are.
 * @returns {{ key: 'none'|'warming'|'indicative'|'solid', text: string, seconds: number|null }}
 */
export function windowStatus(report) {
  const w = report && report.window;
  if (!w) return { key: 'none', text: '', seconds: null };
  if (w.warmingUp === true) {
    return { key: 'warming', text: 'The updated plant is still warming up, so there are no new figures yet.', seconds: null };
  }
  const seconds = isNum(w.duration) ? Math.max(0, w.duration) : 0;
  if (seconds >= COMPARE_FULL_SECONDS) return { key: 'solid', text: 'One run per plant, so small differences are not coloured.', seconds };
  return { key: 'indicative', text: 'Indicative: one run per plant, so small differences are not coloured.', seconds };
}

/** "Add fleet, Connect Goods in 2 → Assembly and 1 more": the edit labels in one line. */
export function describeLabels(labels, max = MAX_NAMED_LABELS) {
  const list = (Array.isArray(labels) ? labels : []).filter((l) => typeof l === 'string' && l);
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

/** The six figures of a report as METRICS values (cached per report object: reports are never mutated). */
const metricCache = new WeakMap();
function metricsOf(report) {
  if (!report || typeof report !== 'object') return {};
  if (!metricCache.has(report)) {
    try {
      metricCache.set(report, summarizeReport(report));
    } catch {
      metricCache.set(report, {});
    }
  }
  return metricCache.get(report);
}

/** "18 → 24.5 /h" for a pair of formatted values. */
const pairText = (before, after, unit) => `${before} → ${after}${unit ? ` ${unit}` : ''}`;

/** A coloured verdict that the data cannot carry becomes a plain figure. */
const neutralised = (change, label) => ({ ...change, tone: 'neutral', label });

/**
 * Everything the card shows, or null when there is nothing to compare (no baseline, no edit since, no numbers at all).
 * The figures are the OLD plant's (baseline.control) against the UPDATED plant's (baseline.after) over the same measured window; without
 * that pair (the warm-up was too long for the quick pre-run, the old plant could not be re-run in time) every figure is an en dash and
 * the status says why.
 * @param {{ report: object, labels: string[], edits?: number, control?: { window: number, report: object }|null, after?: { window: number, report: object }|null }|null} baseline runner.baseline
 * @param {object|null} report the current KpiReport of the running simulation (used to tell "still warming up" from "no comparison")
 * @param {{ priming?: boolean }} [opts]
 */
export function impactModel(baseline, report, { priming = false } = {}) {
  if (!baseline || !baseline.report || !Array.isArray(baseline.labels) || baseline.labels.length === 0) return null;
  const control = baseline.control && baseline.control.report ? baseline.control.report : null;
  const after = baseline.after && baseline.after.report ? baseline.after.report : null;
  const paired = Boolean(control && after);
  const seconds = paired ? Math.min(...[baseline.control.window, baseline.after.window].filter(isNum)) : null;
  const context = paired ? {
    seconds: isNum(seconds) ? seconds : undefined,
    loadsBefore: loadsOf(control), loadsAfter: loadsOf(after), countBefore: leadCountOf(control), countAfter: leadCountOf(after),
  } : null;
  const beforeM = paired ? metricsOf(control) : {};
  const afterM = paired ? metricsOf(after) : {};

  // a plant that stands still after the change: nothing finished, nothing driving
  const stalled = paired && isNum(context.loadsBefore) && context.loadsBefore > 0 && context.loadsAfter === 0;
  const nothingDrove = paired && droveIn(control) && !droveIn(after);

  const rows = IMPACT_FIGURES.map((figure) => {
    const b = beforeM[figure.metric] ?? null;
    const a = afterM[figure.metric] ?? null;
    let change = classifyDelta(figure, b, a, context);
    if (stalled && change.tone === 'good') change = neutralised(change, 'not comparable');
    if (nothingDrove && figure.id === 'traffic') change = neutralised(change, 'nothing drove');
    return {
      id: figure.id, label: figure.label, unit: figure.unit, help: figure.help,
      before: b, after: a,
      beforeText: isNum(b) ? figure.fmt(b) : DASH, afterText: isNum(a) ? figure.fmt(a) : DASH,
      pair: pairText(isNum(b) ? figure.fmt(b) : DASH, isNum(a) ? figure.fmt(a) : DASH, figure.unit),
      change,
    };
  });

  let status;
  if (paired) status = windowStatus(after);
  else if (report && report.window && report.window.warmingUp) status = windowStatus(report);
  else if (report && report.window) {
    status = { key: 'unpaired', seconds: null, text: 'The old plant could not be run again next to the updated one in time, so there is no fair comparison here. Compare properly… runs both plants side by side.' };
  } else status = { key: 'none', text: '', seconds: null };

  // nothing moved beyond noise: say so, and where to look if an effect was expected (the answer to "my new items are ignored")
  const quiet = paired && rows.some((r) => r.change.known) && rows.every((r) => !r.change.known || r.change.noise);
  return {
    title: 'Effect of your change',
    subtitle: describeLabels(baseline.labels),
    labels: baseline.labels.slice(),
    rows,
    status,
    windows: paired && isNum(seconds) ? `Both plants were simulated for the same ${formatDuration(seconds)} after warm-up, with the same random seed.` : '',
    updating: Boolean(priming),
    paired,
    hasNumbers: rows.some((r) => r.change.known),
    note: stalled ? STALLED_NOTE : quiet ? NO_CHANGE_NOTE : '',
    canCompare: Boolean(baseline.layout),
  };
}

/**
 * The one-line hint under the simulation bar: the most telling changes, or the plain truth that nothing is clear yet.
 * @returns {string} '' without a model
 */
export function impactHintText(model) {
  if (!model || !model.hasNumbers) return '';
  const real = model.rows.filter((r) => r.change.known && r.change.tone !== 'neutral')
    .sort((a, b) => Math.abs(b.change.relative) - Math.abs(a.change.relative) || (a.id < b.id ? -1 : 1))
    .slice(0, 2);
  const tail = model.status.key === 'solid' ? '' : ' (indicative)';
  if (!real.length) return `No clear change in the key figures${tail}`;
  return `${real.map((r) => `${r.label} ${r.pair}`).join(' · ')}${tail}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------------------------------

const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
const setHidden = (el, value) => { if (el.hidden !== value) el.hidden = value; };
const setDisabled = (el, value) => { if (el.disabled !== value) el.disabled = value; };

/** After a button that disappears was used, keyboard focus goes back to the Results tab instead of falling to the page. */
function refocus() {
  if (typeof document === 'undefined') return;
  const tab = document.getElementById('tab-results');
  if (tab) tab.focus({ preventScroll: true });
}

/** The variants this page added as "the old plant" of a baseline (one per baseline: a second click does not add a second copy). */
const addedVariants = new WeakMap();

/**
 * "Compare properly...": the plant as it was before the edits becomes a variant ("Before: ...") next to the current one, both are
 * ticked in the Experiments tab, which then runs them several times with different seeds. The planner stays on the current plant: the
 * variant is added and the previous one is made active again at once, so the running simulation is not touched.
 * @returns {boolean} whether the variant is there
 */
export function compareProperly(ctx) {
  const open = () => ctx.actions?.setRightTab?.('experiments');
  const store = ctx.store;
  const baseline = ctx.runner?.baseline ?? null;
  if (!store || !baseline || !baseline.layout) {
    open();
    return false;
  }
  const state = store.getState();
  const known = addedVariants.get(baseline);
  if (known && state.project.scenarios.some((s) => s.id === known)) {
    open();
    return true;
  }
  const name = `Before: ${describeLabels(baseline.labels, 1)}`;
  const current = state.project.activeId;
  const id = store.addScenario(name, baseline.layout);
  if (!id) {
    ctx.toast?.('There is no room for another variant. Delete one of the plant tabs in the top bar, then try again.', { kind: 'warn' });
    return false;
  }
  if (current !== id) store.switchScenario(current);
  addedVariants.set(baseline, id);
  ctx.toast?.(`Added "${name}" as a variant. It is ticked next to your plant: press Run comparison to run both several times.`, { kind: 'success' });
  open();
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Create the "Effect of your change" card.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): runner (baseline, kpis, priming, keepBaseline, dismissBaseline), store, toast, actions.setRightTab
 * @returns {{ el: HTMLElement, update(report?: object|null): void, destroy(): void }}
 */
export function createImpactCard(ctx) {
  const titleId = uid('impact-title');
  const title = h('h3', { class: 'card__title impact__title', id: titleId }, 'Effect of your change');
  const labels = h('div', { class: 'card__subtitle impact__labels' });
  const updating = h('span', { class: 'chip chip--info impact__updating', hidden: true }, icon('clock', { size: 14 }), 'Updating…');
  const rows = new Map(IMPACT_FIGURES.map((figure) => {
    const label = h('span', { class: 'impact__label', title: figure.help }, figure.label);
    const before = h('span', { class: 'impact__before' });
    const after = h('strong', { class: 'impact__after' });
    const unit = h('span', { class: 'impact__unit' }, figure.unit);
    const sr = h('span', { class: 'sr-only' });
    const chipText = h('span');
    const chip = h('span', { class: 'delta impact__delta' }, chipText, sr);
    const vals = h('span', { class: 'impact__vals' }, before, h('span', { class: 'sr-only' }, ' to '), h('span', { class: 'impact__arrow', 'aria-hidden': 'true' }, '→'), after, unit);
    const el = h('li', { class: 'impact__row', dataset: { metric: figure.id } }, label, vals, chip);
    return [figure.id, { figure, el, before, after, unit, chip, chipText, sr }];
  }));
  // the honesty line, the window and the notes are read out when they change (a polite live region: they change once per edit)
  const statusText = h('p', { class: 'impact__status' });
  const note = h('p', { class: 'impact__note', hidden: true });
  const windows = h('p', { class: 'impact__windows' });
  const live = h('div', { class: 'impact__live', 'aria-live': 'polite' }, note, statusText, windows);

  const KEEP_TITLE = 'Use the plant as it is now as the reference for your next change';
  const keep = h('button', {
    class: 'btn btn--sm', type: 'button', title: KEEP_TITLE,
    onclick: () => {
      const kept = ctx.runner?.keepBaseline?.();
      if (kept) ctx.toast?.('Kept as baseline. Your next change is compared with the plant as it is now.', { kind: 'success' });
      refocus();
      update();
    },
  }, icon('check', { size: 14 }), 'Keep as baseline');
  const COMPARE_TITLE = 'Add the old plant as a variant and run both several times with different random seeds';
  const compare = h('button', {
    class: 'btn btn--sm', type: 'button', title: COMPARE_TITLE,
    onclick: () => { compareProperly(ctx); },
  }, icon('compare', { size: 14 }), 'Compare properly…');
  const dismiss = h('button', {
    class: 'btn btn--icon btn--sm btn--ghost impact__dismiss', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss: hide this card; the next change is compared with the plant as it is then',
    onclick: () => { ctx.runner?.dismissBaseline?.(); refocus(); update(); },
  }, icon('close', { size: 16 }));

  // six rows of dashes say nothing: without numbers (still warming up, no fair comparison) the card is just its status
  const rowList = h('ul', { class: 'impact__rows', 'aria-label': 'Figures before and after your change' }, [...rows.values()].map((r) => r.el));
  const el = h('section', { class: 'card impact', 'aria-labelledby': titleId, 'data-panel': 'impact', hidden: true },
    h('div', { class: 'card__header impact__head' },
      icon('compare', { size: 16, class: 'impact__icon' }),
      h('div', { class: 'impact__titles' }, title, labels),
      updating, dismiss),
    h('div', { class: 'card__body impact__body' }, rowList, live),
    h('div', { class: 'card__footer impact__actions' }, keep, compare));

  let shown = { baseline: undefined, report: undefined, priming: undefined };
  let destroyed = false;

  function paint(model, canKeep) {
    setHidden(el, !model);
    if (!model) return;
    setText(labels, model.subtitle);
    setAttr(labels, 'title', model.labels.join(' · '));
    setAttr(el, 'aria-label', `${model.title}: ${model.labels.join(', ')}`);
    setHidden(updating, !model.updating);
    setHidden(rowList, !model.hasNumbers);
    for (const row of model.rows) {
      const r = rows.get(row.id);
      setText(r.before, row.beforeText);
      setText(r.after, row.afterText);
      setHidden(r.unit, !row.unit);
      setAttr(r.chip, 'class', `delta impact__delta${row.change.tone === 'good' ? ' delta--good' : row.change.tone === 'bad' ? ' delta--bad' : ''}`);
      setText(r.chipText, row.change.text);
      setText(r.sr, ` ${row.change.label}`);
      setAttr(r.chip, 'title', row.change.noise ? 'Within the normal variation between two runs of the simulation' : row.change.label);
    }
    setText(note, model.note);
    setHidden(note, !model.note);
    setText(statusText, model.status.text);
    setHidden(statusText, !model.status.text);
    setAttr(statusText, 'data-state', model.status.key);
    setText(windows, model.windows);
    setHidden(windows, !model.windows);
    setDisabled(keep, !canKeep);
    setAttr(keep, 'title', canKeep ? KEEP_TITLE : 'Available when the updated plant is ready and has run for a while');
    setDisabled(compare, model.updating || !model.canCompare);
    setAttr(compare, 'title', model.updating ? 'Available when the updated plant is ready' : COMPARE_TITLE);
  }

  /** Bring the card up to date. Cheap: the model is rebuilt only when the baseline, the report or the priming flag changed. */
  function update(report) {
    if (destroyed) return;
    const runner = ctx.runner;
    const current = report === undefined ? (runner?.kpis?.() ?? null) : report;
    const baseline = isDayPlant(ctx.store?.getState?.().layout) ? null : (runner?.baseline ?? null); // a day plant restarts cold: no old-versus-new window to show
    const priming = Boolean(runner?.priming);
    if (shown.baseline === baseline && shown.report === current && shown.priming === priming) return;
    shown = { baseline, report: current, priming };
    paint(impactModel(baseline, current, { priming }), !priming && isMeasured(current));
  }

  update();
  return { el, update, destroy() { destroyed = true; el.remove(); } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The hint under the simulation bar
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Create the one-line "Before → after" hint that sits under the simulation bar while a comparison is open.
 * @returns {{ el: HTMLElement, update(state?: object): void, destroy(): void }}
 */
export function createImpactHint(ctx) {
  const text = h('span', { class: 'impact-hint__text' });
  const main = h('button', {
    class: 'impact-hint__main', type: 'button', title: 'Open the Results tab for the full comparison',
    onclick: () => ctx.actions?.setRightTab?.('results'),
  }, icon('compare', { size: 14 }), h('span', { class: 'impact-hint__tag' }, 'Before → after'), text);
  const close = h('button', { class: 'impact-hint__close', type: 'button', 'aria-label': 'Hide this hint', title: 'Hide this hint', onclick: () => { hiddenFor = ctx.runner?.baseline ?? null; update(); } }, icon('close', { size: 12 }));
  const el = h('div', { class: 'impact-hint', 'data-panel': 'impact-hint', hidden: true }, main, close);
  let hiddenFor = null; // the baseline object whose hint the planner closed (the next edit makes a new one)
  let destroyed = false;

  function update() {
    if (destroyed) return;
    const baseline = isDayPlant(ctx.store?.getState?.().layout) ? null : (ctx.runner?.baseline ?? null);
    const report = baseline ? (ctx.runner?.kpis?.() ?? null) : null;
    const line = baseline && hiddenFor !== baseline ? impactHintText(impactModel(baseline, report, { priming: ctx.runner?.priming })) : '';
    setHidden(el, !line);
    setText(text, line);
    // on a narrow screen the line wraps or is cut off: the whole text is in the tooltip
    setAttr(main, 'title', line ? `${line}. Open the Results tab for the full comparison.` : 'Open the Results tab for the full comparison');
  }

  update();
  return { el, update, destroy() { destroyed = true; el.remove(); } };
}
