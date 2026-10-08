// Change impact (browser UI + pure view models): "what did my edit do?" The runner keeps a BASELINE (the numbers of the simulation
// before the first edit, see js/ui/runner.js) and a warm restart makes the updated plant steady within a second; this file puts the two
// side by side.
//
//   const card = createImpactCard(ctx);   // card.el goes to the top of the Results tab; card.update(report?), card.destroy()
//   const hint = createImpactHint(ctx);   // one line under the simulation bar; hint.el, hint.update(state), hint.destroy()
//
// The card shows six figures as "before -> after" with a change chip. The chip is green or red only when the change is real:
// it is neutral for everything inside the noise of a simulation run (less than 3 % or less than a floor per figure, e.g. 1 load per
// hour for the throughput) and for figures where neither direction is better (fleet utilization), and its text carries the sign and
// a hidden "better" / "worse" for readers who cannot see colour. While the new measurement window is short the card says so
// ("Indicative: only 6 of 20 minutes measured so far") and shows a thin progress bar; after 20 minutes it says "Measured over 20 min".
// Buttons: "Keep as baseline" (the current numbers become the reference of the next edit), "Compare properly..." (the Experiments
// tab runs replications) and "Dismiss". Consecutive edits keep the ORIGINAL baseline, so the card lists every edit since then.
//
// Pure view models (impactModel, classifyDelta, windowStatus, ...) have no DOM and are unit-tested in tests/ui.impact.test.js.
// The card is built once and then only patched in place (golden rule of js/ui/panels/fields.js); every number goes through
// js/util/format.js; every part tolerates null (no baseline, no report, a figure that cannot be computed).

import { h } from '../../util/dom.js';
import { formatDuration, formatNumber } from '../../util/format.js';
import { METRICS, summarizeReport } from '../../sim/experiments.js';
import { icon } from '../icons.js';
import { uid } from './fields.js';

/** A comparison counts as solid once the new measurement window is this long (s). */
export const COMPARE_FULL_SECONDS = 1200;
/** A relative change below this is inside the noise of one simulation run. */
export const NOISE_RELATIVE = 0.03;
/** Labels named in a title before "and n more". */
export const MAX_NAMED_LABELS = 3;

/** Shown when none of the six figures changed beyond noise. */
export const NO_CHANGE_NOTE = 'No figure changed clearly. If you expected an effect, check that the new parts are connected to the rest of the plant (Checks tab) and that vehicles can reach them.';

const MINUS = '−';
const DASH = '–';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** One decimal below 100 (before and after are compared, so 20 -> 20.4 must not read 20 -> 20), none above. */
const amount = (v) => formatNumber(v, Math.abs(v) < 100 ? 1 : 0);

/**
 * The six figures of the card, in order. `metric` is the id in js/sim/experiments.js METRICS (which also says which direction is
 * better); `floor` the smallest absolute change that can be more than noise, in the unit of the figure; `kind` how the change is worded
 * ('relative': "+36 %", 'points': "+3 pts"); `fmt` formats one value, `unit` follows the "before -> after" pair.
 */
export const IMPACT_FIGURES = Object.freeze([
  { id: 'throughput', metric: 'throughput', label: 'Throughput', unit: '/h', kind: 'relative', floor: 1, fmt: amount,
    help: 'Finished loads leaving the plant per hour.' },
  { id: 'leadTime', metric: 'leadMean', label: 'Lead time (mean)', unit: '', kind: 'relative', floor: 5, fmt: (v) => formatDuration(v),
    help: 'Average time a load needs from entering the plant to leaving it.' },
  { id: 'wip', metric: 'wip', label: 'Work in progress', unit: 'loads', kind: 'relative', floor: 0.5, fmt: amount,
    help: 'Loads in the plant on average: waiting, being carried or being worked on.' },
  { id: 'fleet', metric: 'fleetUtilization', label: 'Fleet utilization', unit: '%', kind: 'points', floor: 1, fmt: (v) => formatNumber(v, 0),
    help: 'Share of time the vehicles are working. Neither more nor less is better by itself, so the change is not coloured.' },
  { id: 'traffic', metric: 'waitShare', label: 'Time waiting in traffic', unit: '%', kind: 'points', floor: 0.5, fmt: (v) => formatNumber(v, v < 10 ? 1 : 0),
    help: 'Share of the driving time that vehicles stand still because another vehicle, a junction or a broken-down vehicle is in the way.' },
  { id: 'deadlocks', metric: 'deadlocks', label: 'Deadlocks', unit: '', kind: 'relative', floor: 0.5, fmt: (v) => formatNumber(v, 0),
    help: 'Times vehicles blocked each other in a circle.' },
]);

const BETTER = new Map(METRICS.map((m) => [m.id, m.better]));

// ---------------------------------------------------------------------------------------------------------------------
// Pure view models
// ---------------------------------------------------------------------------------------------------------------------

/**
 * How one figure changed from `before` to `after`.
 * @param {{ metric: string, kind: string, floor: number, fmt: Function }} figure one of IMPACT_FIGURES
 * @returns {{ tone: 'good'|'bad'|'neutral', noise: boolean, known: boolean, delta: number|null, relative: number|null, text: string, label: string }}
 *   `label` is the hidden text for readers who do not see the colour: 'better', 'worse', 'no clear change', 'for information' or 'not comparable'
 */
export function classifyDelta(figure, before, after) {
  if (!isNum(before) || !isNum(after)) return { tone: 'neutral', noise: false, known: false, delta: null, relative: null, text: DASH, label: 'not comparable' };
  const delta = after - before;
  const relative = before !== 0 ? delta / Math.abs(before) : (delta === 0 ? 0 : Infinity * Math.sign(delta));
  const noise = Math.abs(delta) < figure.floor || Math.abs(relative) < NOISE_RELATIVE;
  const better = BETTER.get(figure.metric) ?? null;
  let tone = 'neutral';
  if (!noise && better) tone = (better === 'higher') === (delta > 0) ? 'good' : 'bad';
  const label = tone === 'good' ? 'better' : tone === 'bad' ? 'worse' : noise ? 'no clear change' : 'for information';
  return { tone, noise, known: true, delta, relative, text: deltaText(figure, delta, before, relative), label };
}

/** "+36 %", "−2.1 pts", "+2", "±0": the size of a change in words that carry the sign. */
function deltaText(figure, delta, before, relative) {
  if (delta === 0) return '±0';
  const sign = delta > 0 ? '+' : MINUS;
  if (figure.kind === 'points') return `${sign}${formatNumber(Math.abs(delta), Math.abs(delta) < 10 ? 1 : 0)} pts`;
  if (before === 0 || !Number.isFinite(relative)) return `${sign}${figure.fmt(Math.abs(delta))}`;
  const percent = Math.abs(relative) * 100;
  return percent >= 1000 ? `${sign}999+ %` : `${sign}${formatNumber(percent, percent < 10 ? 1 : 0)} %`;
}

/**
 * How reliable the numbers after the change are.
 * @returns {{ key: 'none'|'warming'|'indicative'|'solid', text: string, progress: number|null, seconds: number|null }}
 */
export function windowStatus(report) {
  const w = report && report.window;
  if (!w) return { key: 'none', text: '', progress: null, seconds: null };
  if (w.warmingUp === true) {
    return { key: 'warming', text: 'The updated plant is still warming up, so there are no new figures yet.', progress: null, seconds: null };
  }
  const seconds = isNum(w.duration) ? Math.max(0, w.duration) : 0;
  const wanted = COMPARE_FULL_SECONDS / 60;
  if (seconds >= COMPARE_FULL_SECONDS) return { key: 'solid', text: `Measured over ${formatDuration(seconds)}`, progress: 1, seconds };
  const done = seconds < 60 ? formatDuration(seconds) : String(Math.floor(seconds / 60));
  return { key: 'indicative', text: `Indicative: only ${done} of ${wanted} minutes measured so far`, progress: seconds / COMPARE_FULL_SECONDS, seconds };
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

/**
 * Everything the card shows, or null when there is nothing to compare (no baseline, no edit since, no numbers at all).
 * @param {{ report: object, simTime?: number, labels: string[], edits?: number }|null} baseline runner.baseline
 * @param {object|null} report the current KpiReport
 * @param {{ priming?: boolean }} [opts]
 */
export function impactModel(baseline, report, { priming = false } = {}) {
  if (!baseline || !baseline.report || !Array.isArray(baseline.labels) || baseline.labels.length === 0) return null;
  const warming = Boolean(report && report.window && report.window.warmingUp);
  const before = metricsOf(baseline.report);
  const after = warming ? {} : metricsOf(report);
  const rows = IMPACT_FIGURES.map((figure) => {
    const b = before[figure.metric] ?? null;
    const a = after[figure.metric] ?? null;
    const change = classifyDelta(figure, b, a);
    return {
      id: figure.id, label: figure.label, unit: figure.unit, help: figure.help,
      before: b, after: a,
      beforeText: isNum(b) ? figure.fmt(b) : DASH, afterText: isNum(a) ? figure.fmt(a) : DASH,
      pair: pairText(isNum(b) ? figure.fmt(b) : DASH, isNum(a) ? figure.fmt(a) : DASH, figure.unit),
      change,
    };
  });
  const status = windowStatus(report);
  // nothing moved beyond noise: say so, and where to look if an effect was expected (the answer to "my new items are ignored")
  const quiet = status.key !== 'warming' && rows.some((r) => r.change.known) && rows.every((r) => !r.change.known || r.change.noise);
  const beforeSeconds = baseline.report.window && isNum(baseline.report.window.duration) ? baseline.report.window.duration : null;
  return {
    title: 'Effect of your change',
    subtitle: describeLabels(baseline.labels),
    labels: baseline.labels.slice(),
    rows,
    status,
    windows: `Before: ${beforeSeconds === null ? DASH : `${formatDuration(beforeSeconds)} measured`} · After: ${status.seconds === null ? DASH : `${formatDuration(status.seconds)} measured`}`,
    updating: Boolean(priming),
    hasNumbers: rows.some((r) => r.change.known),
    note: quiet ? NO_CHANGE_NOTE : '',
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
  if (!real.length) return `No clear change in the key figures yet${tail}`;
  return `${real.map((r) => `${r.label} ${r.pair}`).join(' · ')}${tail}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------------------------------

const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
const setHidden = (el, value) => { if (el.hidden !== value) el.hidden = value; };

/** After a button that disappears was used, keyboard focus goes back to the Results tab instead of falling to the page. */
function refocus() {
  if (typeof document === 'undefined') return;
  const tab = document.getElementById('tab-results');
  if (tab) tab.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Create the "Effect of your change" card.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): runner (baseline, kpis, priming, keepBaseline, dismissBaseline), toast, actions.setRightTab
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
  const bar = h('div', { class: 'progress__bar' });
  const progress = h('div', { class: 'progress impact__progress', role: 'progressbar', 'aria-label': 'Measured time since the change', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
  const statusText = h('p', { class: 'impact__status' });
  const note = h('p', { class: 'impact__note', hidden: true });
  const windows = h('p', { class: 'impact__windows' });

  const keep = h('button', {
    class: 'btn btn--sm', type: 'button', title: 'Use the current numbers as the reference for your next change',
    onclick: () => {
      const kept = ctx.runner?.keepBaseline?.();
      ctx.toast?.(kept ? 'Kept as baseline. Your next change is compared with these numbers.' : 'The numbers are not reliable yet, so there is nothing to keep as baseline.', { kind: kept ? 'success' : 'info' });
      refocus();
      update();
    },
  }, icon('check', { size: 14 }), 'Keep as baseline');
  const compare = h('button', {
    class: 'btn btn--sm', type: 'button', title: 'Run the old and the new plant several times with different random seeds',
    onclick: () => ctx.actions?.setRightTab?.('experiments'),
  }, icon('compare', { size: 14 }), 'Compare properly…');
  const dismiss = h('button', {
    class: 'btn btn--icon btn--sm btn--ghost impact__dismiss', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss: hide this card; the next change is compared with the numbers just before it',
    onclick: () => { ctx.runner?.dismissBaseline?.(); refocus(); update(); },
  }, icon('close', { size: 16 }));

  const el = h('section', { class: 'card impact', 'aria-labelledby': titleId, 'data-panel': 'impact', hidden: true },
    h('div', { class: 'card__header impact__head' },
      icon('compare', { size: 16, class: 'impact__icon' }),
      h('div', { class: 'impact__titles' }, title, labels),
      updating, dismiss),
    h('div', { class: 'card__body impact__body' },
      h('ul', { class: 'impact__rows', 'aria-label': 'Figures before and after your change' }, [...rows.values()].map((r) => r.el)),
      note,
      h('div', { class: 'impact__foot' }, statusText, progress, windows)),
    h('div', { class: 'card__footer impact__actions' }, keep, compare));

  let shown = { baseline: undefined, report: undefined, priming: undefined };
  let destroyed = false;

  function paint(model) {
    setHidden(el, !model);
    if (!model) return;
    setText(labels, model.subtitle);
    setAttr(el, 'aria-label', `${model.title}: ${model.subtitle}`);
    setHidden(updating, !model.updating);
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
    const showBar = model.status.progress !== null && model.status.key === 'indicative';
    setHidden(progress, !showBar);
    if (showBar) {
      const percent = Math.round(model.status.progress * 100);
      if (bar.style.getPropertyValue('--w') !== `${percent}%`) bar.style.setProperty('--w', `${percent}%`);
      setAttr(progress, 'aria-valuenow', String(percent));
    }
    setText(windows, model.windows);
  }

  /** Bring the card up to date. Cheap: the model is rebuilt only when the baseline, the report or the priming flag changed. */
  function update(report) {
    if (destroyed) return;
    const runner = ctx.runner;
    const current = report === undefined ? (runner?.kpis?.() ?? null) : report;
    const baseline = runner?.baseline ?? null;
    const priming = Boolean(runner?.priming);
    if (shown.baseline === baseline && shown.report === current && shown.priming === priming) return;
    shown = { baseline, report: current, priming };
    paint(impactModel(baseline, current, { priming }));
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
    const baseline = ctx.runner?.baseline ?? null;
    const report = baseline ? (ctx.runner?.kpis?.() ?? null) : null;
    const line = baseline && hiddenFor !== baseline ? impactHintText(impactModel(baseline, report, { priming: ctx.runner?.priming })) : '';
    setHidden(el, !line);
    setText(text, line);
  }

  update();
  return { el, update, destroy() { destroyed = true; el.remove(); } };
}
