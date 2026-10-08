// Experiments tab (docs/ARCHITECTURE.md 6.6): try variants of the plant and see which one works best.
//
//   const tab = createCompare(ctx);   // tab.el, tab.update(state), tab.setVisible(bool), tab.destroy()
//   getLastResults()                  // { compare, sweep } of the latest finished runs, for the report (js/ui/report.js)
//
// Two modes. COMPARE VARIANTS runs the scenarios the planner ticks (at least two) and puts the measures side by side: best and
// worst per row, change against the first variant, lowest-highest over the repetitions, a one-sentence headline, a bar chart and
// "Copy as table". PARAMETER SWEEP changes one setting of the CURRENT plant step by step, plots a measure over the values (with
// the min-max band over the repetitions), marks the best point, says where more of it stops paying off, and applies a chosen
// value to the plant (one undoable step, "Apply <setting> = <value>").
//
// Runs. Everything is asynchronous: js/sim/experiments.js cuts a run into ~30 ms slices, so the page stays usable. This file
// drives one runReplications() per variant (or per sweep value) itself instead of calling compareScenarios() / sweep(), which
// gives per-variant status, an error that names the variant, a progress bar that fills smoothly, and sweep points that appear
// on the chart as soon as they are done. Cancel aborts through an AbortController. A cancelled sweep keeps the points it has;
// a cancelled comparison keeps the previous result.
//
// Results live in memory for the life of the page (module level, so a re-created tab shows them again). A result remembers the
// layout objects it was computed from; once a layout differs from them in a way the simulation notices (layoutChangeKind
// 'runtime' or 'structural'; renaming, notes, labels and obstacles do not count) a banner says so and offers "Run again".
// After "Apply" the sweep is re-based on the new layout, because the swept setting is overwritten by every value anyway.
//
// Everything above the "browser" banner is pure (no DOM) and unit-tested in tests/ui.report.test.js; report.js reuses it.
//
// Readings of the spec (also listed in the engineer's report):
//  * Replications per run, run length and warm-up are ONE set of fields shared by both modes. They start from the plant's
//    settings (Simulate tab) and follow them until the planner edits them here.
//  * Labels: variants are called "A - Name" by their position in the project (a scenario named just "B" stays "B").
//  * Differences below 1 % are not highlighted as best / worst: with a few random-seed repetitions they are noise.
//  * The smallest value that reaches 95 % of the best result is the "enough" point; for measures where lower is better it is
//    the smallest value within 1 / 0.95 of the best. Measures without a better direction get no recommendation.
//  * Options: createCompare(ctx, { experiments: { runReplications, listSweepParameters } }) replaces the simulation side (tests).

import { h, render } from '../util/dom.js';
import { formatDuration, formatNumber, round } from '../util/format.js';
import { layoutChangeKind } from '../model/layout.js';
import { validateLayout } from '../model/validate.js';
import { METRICS, listSweepParameters as realListSweepParameters, runReplications as realRunReplications } from '../sim/experiments.js';
import { bestWorst, createBarChart, createLineChart } from './charts.js';
import { icon } from './icons.js';
import { callout, numberField, segmentedField, selectField, stepperField } from './panels/fields.js';

// =================================================================================================
// Pure model
// =================================================================================================

/** Limits of the inputs. */
export const LIMITS = Object.freeze({ replications: [1, 10], hours: [0.1, 168], warmupMin: [0, 10080], sweepPoints: 25 });
/** Relative differences below this are noise, not a better or worse variant. */
export const NOISE = 0.01;
/** A sweep value is "enough" once it reaches this share of the best result. */
export const ENOUGH = 0.95;

const DASH = '–';
const MINUS = '−';
const COUNT_UNITS = ['vehicles', 'machines', 'loads'];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const orNull = (v) => (finite(v) ? v : null);
const signOf = (d) => (d > 0 ? '+' : MINUS);

/** The measure with this id, or undefined. */
export const metricById = (id) => METRICS.find((m) => m.id === id);

/**
 * How a variant is shown: its letter (by position in the project), its name and the combined label.
 * "Baseline" at position 0 is "A - Baseline"; a name that already starts with its letter is kept; a scenario that is just
 * a letter stays that letter.
 * @param {string} name scenario name
 * @param {number} index position in the project
 * @returns {{ letter: string, name: string, label: string }}
 */
export function variantParts(name, index) {
  const clean = String(name ?? '').trim();
  if (/^[A-Z]$/.test(clean)) return { letter: clean, name: '', label: clean };
  const letter = index < 26 ? String.fromCharCode(65 + index) : `S${index + 1}`;
  const prefixed = new RegExp(`^${letter}\\s*[-–—:.]\\s*(.*)$`).exec(clean);
  const rest = prefixed ? prefixed[1] : clean;
  return { letter, name: rest, label: rest ? `${letter} - ${rest}` : letter };
}

/**
 * Unit and decimals to show a measure in. Seconds become minutes (from 2 min) or hours (from 2 h) so that lead times read
 * "30.7 min", not "1840 s".
 * @param {{ unit: string, digits: number }} metric
 * @param {number} magnitude the largest absolute value that will be shown with this scale
 * @returns {{ factor: number, unit: string, digits: number }}
 */
export function scaleFor(metric, magnitude) {
  if (metric.unit !== 's') return { factor: 1, unit: metric.unit, digits: metric.digits };
  const m = finite(magnitude) ? Math.abs(magnitude) : 0;
  if (m >= 2 * 3600) return { factor: 1 / 3600, unit: 'h', digits: 1 };
  if (m >= 120) return { factor: 1 / 60, unit: 'min', digits: 1 };
  return { factor: 1, unit: 's', digits: metric.digits };
}

/** A number with exactly `digits` decimals and thousands separators ("44.0"), so a column of values lines up. */
export const formatFixed = (value, digits) => round(value, digits).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A value in its scale as text ("30.7"), an en dash when unknown. */
export const formatScaled = (value, scale) => (finite(value) ? formatFixed(value * scale.factor, scale.digits) : DASH);

/**
 * A sweep value with its unit: "6 vehicles", "1.5×", "2.3 min", "1.5 m/s". `short` leaves out the unit of plain counts.
 * @param {number} value
 * @param {string} [unit]
 * @param {{ short?: boolean }} [opts]
 */
export function formatParamValue(value, unit = '', { short = false } = {}) {
  if (!finite(value)) return DASH;
  if (unit === 's') return formatDuration(value);
  const n = formatNumber(value, 3);
  if (unit === '×') return `${n}×`;
  if (!unit || (short && COUNT_UNITS.includes(unit))) return n;
  return `${n} ${value === 1 && COUNT_UNITS.includes(unit) ? unit.slice(0, -1) : unit}`;
}

/** The values of a sweep as one line, the unit said once: "2, 3, 4 vehicles", "0.5×, 1×, 1.5×", "1.5 min, 3 min". */
export function describeValues(values, unit = '') {
  if (unit === 's') return values.map((v) => formatDuration(v)).join(', ');
  const list = values.map((v) => `${formatNumber(v, 3)}${unit === '×' ? '×' : ''}`).join(', ');
  return unit && unit !== '×' ? `${list} ${unit}` : list;
}

const percentText = (rel) => `${formatNumber(Math.abs(rel) * 100, Math.abs(rel) < 0.1 ? 1 : 0)} %`;

/**
 * Change of a value against a reference, in words for a table cell, with whether the change is desirable.
 * Percentages of a share are compared in points, a zero reference gives the plain difference, everything else is relative.
 * @returns {{ text: string, tone: 'good'|'bad'|'neutral' } | null} null when either value is unknown
 */
export function deltaVs(metric, base, value) {
  if (!finite(base) || !finite(value)) return null;
  const diff = value - base;
  let text;
  if (metric.unit === '%') text = Math.abs(diff) < 0.05 ? '±0 pt' : `${signOf(diff)}${formatNumber(Math.abs(diff), 1)} pt`;
  else if (Math.abs(base) < 1e-9) text = diff === 0 ? '±0' : `${signOf(diff)}${formatNumber(Math.abs(diff), metric.digits)}`;
  else text = Math.abs(diff / base) < 0.005 ? '±0 %' : `${signOf(diff)}${percentText(diff / base)}`;
  if (text.startsWith('±') || !metric.better) return { text, tone: 'neutral' };
  return { text, tone: (diff > 0) === (metric.better === 'higher') ? 'good' : 'bad' };
}

/** Indices of the best and worst value; nothing when the measure has no direction or the spread is below the noise level. */
export function markBestWorst(values, better) {
  const none = { best: [], worst: [] };
  if (better !== 'higher' && better !== 'lower') return none;
  const marks = bestWorst(values, better);
  if (!marks.best.length) return none;
  const known = values.filter(finite);
  const hi = Math.max(...known);
  const lo = Math.min(...known);
  return hi - lo < NOISE * Math.max(Math.abs(hi), Math.abs(lo)) ? none : marks;
}

/** "lowest–highest" over the repetitions in a scale; '' for a single run. */
function rangeText(stat, scale) {
  if (!stat || !(stat.n > 1) || !finite(stat.min) || !finite(stat.max)) return '';
  const lo = formatScaled(stat.min, scale);
  const hi = formatScaled(stat.max, scale);
  return lo === hi ? '' : `${lo}–${hi}`;
}

/** Largest absolute mean / max of the stats, for choosing a scale. */
const magnitudeOf = (stats) => Math.max(0, ...stats.flatMap((s) => [s?.mean, s?.max]).filter(finite).map(Math.abs));

/**
 * The comparison as rows of ready-to-print cells.
 * @param {object} result a compare result (see getLastResults)
 * @returns {{ variants: Array<{ letter: string, name: string, label: string }>, rows: Array<{ metric: object, scale: object,
 *   cells: Array<{ mean: number|null, text: string, range: string, best: boolean, worst: boolean, delta: object|null }> }>,
 *   missing: object[], repetitions: number }}
 *   `missing` are the measures no variant could report (no battery, no data)
 */
export function buildComparison(result) {
  const variants = result.variants.map((v) => ({ letter: v.letter, name: v.name, label: v.label }));
  const rows = [];
  const missing = [];
  for (const metric of METRICS) {
    const stats = result.variants.map((v) => v.summary?.[metric.id] ?? null);
    const means = stats.map((s) => orNull(s?.mean));
    if (means.every((m) => m === null)) { missing.push(metric); continue; }
    const scale = scaleFor(metric, magnitudeOf(stats));
    const marks = markBestWorst(means, metric.better);
    rows.push({
      metric,
      scale,
      cells: stats.map((stat, i) => ({
        mean: means[i],
        text: formatScaled(means[i], scale),
        range: rangeText(stat, scale),
        best: marks.best.includes(i),
        worst: marks.worst.includes(i),
        delta: i === 0 ? null : deltaVs(metric, means[0], means[i]),
      })),
    });
  }
  return { variants, rows, missing, repetitions: result.settings.replications };
}

/** The throughput of each variant, per hour. */
const throughputs = (variants) => variants.map((v) => orNull(v.summary?.throughput?.mean));

/** ", with 9 % shorter mean lead time" for the best variant against the first; '' when it is about the same or unknown. */
function leadTimeClause(first, best) {
  const a = orNull(first.summary?.leadMean?.mean);
  const b = orNull(best.summary?.leadMean?.mean);
  if (a === null || b === null || a <= 0 || Math.abs(b - a) / a < 0.05) return '';
  return b < a ? `, with a ${percentText((b - a) / a)} shorter mean lead time` : `, but with a ${percentText((b - a) / a)} longer mean lead time`;
}

/**
 * One sentence that says what the comparison found, about throughput: "C - One-way aisles delivers 14 % more per hour than
 * A - Baseline, with a 9 % shorter mean lead time."
 * @param {Array<{ label: string, summary: object }>} variants in table order; the first is the reference
 * @returns {string} '' for fewer than two variants
 */
export function headline(variants) {
  if (variants.length < 2) return '';
  const tp = throughputs(variants);
  const known = tp.filter(finite);
  if (known.length < 2 || Math.max(...known) <= 0) {
    return 'Nothing was delivered in the measured time, so the variants cannot be told apart. Check the plant on the Checks tab or run longer.';
  }
  const hi = Math.max(...known);
  const lo = Math.min(...known);
  if (hi - lo < NOISE * hi) return `All variants deliver about the same per hour (within ${Math.round(NOISE * 100)} %).`;
  const first = variants[0];
  if (tp[0] !== null && tp[0] >= hi * (1 - NOISE)) { // the reference is as good as the best: nothing to gain
    return `No variant beats ${first.label}, which delivers ${formatNumber(tp[0], 1)} loads per hour. ${variants[tp.indexOf(lo)].label} is ${percentText((lo - hi) / hi)} behind.`;
  }
  const best = tp.indexOf(hi);
  const lead = leadTimeClause(first, variants[best]);
  if (!(tp[0] > 0)) return `${variants[best].label} delivers ${formatNumber(hi, 1)} loads per hour; ${first.label} delivers none${lead}.`;
  return `${variants[best].label} delivers ${percentText((hi - tp[0]) / tp[0])} more per hour than ${first.label}${lead}.`;
}

/**
 * Tab-separated text of a comparison for pasting into a spreadsheet: a header row, then one row per measure
 * (measure, unit, one column per variant). Numbers use a decimal point and no thousands separators; unknown values are empty.
 * @param {ReturnType<typeof buildComparison>} model
 */
export function comparisonTsv(model) {
  const lines = [['Measure', 'Unit', ...model.variants.map((v) => v.label)]];
  for (const row of model.rows) {
    lines.push([row.metric.label, row.scale.unit, ...row.cells.map((c) => (c.mean === null ? '' : String(round(c.mean * row.scale.factor, row.scale.digits))))]);
  }
  return lines.map((cells) => cells.join('\t')).join('\n');
}

/**
 * The values a sweep tests: min, min + step, ... up to max, plus `include` (the current value) when it lies inside the range.
 * @returns {{ values: number[], error: string|null }}
 */
export function rangeValues(min, max, step, include = null) {
  const fail = (error) => ({ values: [], error });
  if (![min, max, step].every(finite)) return fail('Enter a number in all three fields.');
  if (step <= 0) return fail('The step must be greater than zero.');
  if (max < min) return fail('The highest value must not be below the lowest.');
  const count = Math.floor((max - min) / step + 1e-9) + 1;
  if (count > LIMITS.sweepPoints) return fail(`That is ${count} values. Use a larger step: at most ${LIMITS.sweepPoints} values can be tested at once.`);
  const values = Array.from({ length: count }, (_, i) => round(min + i * step, 6));
  if (finite(include) && include >= min && include <= max && !values.some((v) => Math.abs(v - include) < 1e-9)) {
    values.push(include);
    values.sort((a, b) => a - b);
  }
  return { values, error: null };
}

/**
 * Where a sweep stops paying off. `points` are { value, mean } in any order; points without a mean are ignored.
 * @param {Array<{ value: number, mean: number|null }>} points
 * @param {{ label: string, better: 'higher'|'lower'|null }} metric
 * @param {string} unit unit of the swept value
 * @returns {{ text: string, best: number|null, reach: number|null }} the value with the best mean and the smallest value that is within
 *   ENOUGH of it (both null when there is no recommendation)
 */
export function recommendSweep(points, metric, unit) {
  const valid = points.filter((p) => finite(p.mean)).sort((a, b) => a.value - b.value);
  const say = (text, best = null, reach = null) => ({ text, best, reach });
  if (!metric.better) return say(`${metric.label} has no better or worse direction; the curve shows how it responds.`);
  if (valid.length < 2) return say('Not enough results yet to recommend a value.');
  const means = valid.map((p) => p.mean);
  const bestMean = metric.better === 'higher' ? Math.max(...means) : Math.min(...means);
  const worstMean = metric.better === 'higher' ? Math.min(...means) : Math.max(...means);
  if (Math.abs(bestMean - worstMean) < NOISE * Math.max(Math.abs(bestMean), Math.abs(worstMean))) {
    return say(`${metric.label} hardly changes across these values.`);
  }
  const enough = (m) => (metric.better === 'higher' ? m >= ENOUGH * bestMean : bestMean <= 0 ? m <= 0 : m <= bestMean / ENOUGH);
  const best = valid.find((p) => p.mean === bestMean);
  const reach = valid.find((p) => enough(p.mean));
  const at = (p) => formatParamValue(p.value, unit);
  if (reach.value < best.value) {
    return say(`${metric.label} stops improving beyond ${at(reach)}: from there it is within ${Math.round((1 - ENOUGH) * 100)} % of the best result.`, best.value, reach.value);
  }
  if (best === valid[valid.length - 1]) return say(`${metric.label} is still improving at ${at(best)}, the highest value tested. Try a wider range.`, best.value, reach.value);
  if (best === valid[0]) return say(`${metric.label} is best at ${at(best)}, the lowest value tested. Try a wider range.`, best.value, reach.value);
  return say(`${metric.label} is best at ${at(best)}.`, best.value, reach.value);
}

/**
 * The sweep result for one measure as rows of ready-to-print cells.
 * @param {object} result a sweep result (see getLastResults)
 * @param {string} metricId id from METRICS
 * @returns {{ metric: object, scale: object, rows: Array<{ value: number, valueText: string, mean: number|null, text: string, range: string,
 *   current: boolean, best: boolean, delta: object|null }>, recommendation: ReturnType<typeof recommendSweep> }}
 */
export function buildSweep(result, metricId) {
  const metric = metricById(metricId) || METRICS[0];
  const stats = result.points.map((p) => p.summary?.[metric.id] ?? null);
  const means = stats.map((s) => orNull(s?.mean));
  const scale = scaleFor(metric, magnitudeOf(stats));
  const recommendation = recommendSweep(result.points.map((p, i) => ({ value: p.value, mean: means[i] })), metric, result.param.unit);
  const isCurrent = (value) => finite(result.current) && Math.abs(value - result.current) < 1e-9;
  const reference = result.points.findIndex((p) => isCurrent(p.value));
  const base = means[reference >= 0 ? reference : 0] ?? null;
  const marks = markBestWorst(means, metric.better);
  const bestAt = marks.best.length ? recommendation.best : null;
  const rows = result.points.map((p, i) => ({
    value: p.value,
    valueText: formatParamValue(p.value, result.param.unit),
    mean: means[i],
    text: formatScaled(means[i], scale),
    range: rangeText(stats[i], scale),
    current: isCurrent(p.value),
    best: bestAt !== null && p.value === bestAt,
    delta: i === (reference >= 0 ? reference : 0) ? null : deltaVs(metric, base, means[i]),
  }));
  return { metric, scale, rows, recommendation };
}

/** Tab-separated text of a sweep table (value, measure mean, lowest, highest). */
export function sweepTsv(result, model) {
  const unit = result.param.unit ? ` (${result.param.unit})` : '';
  const lines = [[`${result.param.label}${unit}`, `${model.metric.label} (${model.scale.unit})`.replace(' ()', ''), 'Lowest', 'Highest']];
  result.points.forEach((p, i) => {
    const stat = p.summary?.[model.metric.id];
    const cell = (v) => (finite(v) ? String(round(v * model.scale.factor, model.scale.digits)) : '');
    lines.push([String(p.value), cell(model.rows[i].mean), cell(stat?.min), cell(stat?.max)]);
  });
  return lines.map((cells) => cells.join('\t')).join('\n');
}

// ---- results in memory -------------------------------------------------------------------------

/**
 * The latest finished runs of this page: `compare` = { kind: 'compare', at, settings: { duration, warmup, replications },
 * variants: [{ id, name, letter, label, summary, layout }] } and `sweep` = { kind: 'sweep', at, scenarioId, scenarioName, layout,
 * param: { key, label, unit, apply, get }, current, values, points: [{ value, summary }], settings, partial }. `summary` is the
 * { [metricId]: { mean, sd, min, max, n } } of js/sim/experiments.js. Either member is null until such a run has finished.
 * Treat the objects as read-only.
 */
const lastResults = { compare: null, sweep: null };

/** The latest finished comparison and sweep (members are null before the first run). */
export function getLastResults() {
  return { compare: lastResults.compare, sweep: lastResults.sweep };
}

/** Does this layout differ from the one a result was computed on in a way the simulation notices? */
const matters = (before, after) => before !== after && ['runtime', 'structural'].includes(layoutChangeKind(before, after));

/**
 * Whether a result still describes the plant.
 * @param {object|null} result a compare or sweep result
 * @param {{ project: { scenarios: Array<{ id: string, name: string, layout: object }>, activeId: string }, layout: object }} state store state
 * @returns {null | { reason: 'changed'|'removed'|'other', text: string }} null while the result is current
 */
export function resultStaleness(result, state) {
  if (!result) return null;
  const scenarios = state.project.scenarios;
  if (result.kind === 'compare') {
    const gone = result.variants.find((v) => !scenarios.some((s) => s.id === v.id));
    if (gone) return { reason: 'removed', text: `${gone.label} no longer exists, so this comparison is out of date.` };
    const changed = result.variants.find((v) => matters(v.layout, scenarios.find((s) => s.id === v.id).layout));
    return changed ? { reason: 'changed', text: `${changed.label} was changed after this comparison ran, so the results may no longer apply.` } : null;
  }
  if (result.scenarioId !== state.project.activeId) {
    return { reason: 'other', text: `This sweep was run on variant ${result.scenarioName}. The variant open now is a different one.` };
  }
  return matters(result.layout, state.layout) ? { reason: 'changed', text: 'The plant was changed after this sweep ran, so the results may no longer apply.' } : null;
}

// =================================================================================================
// Browser: styles
// =================================================================================================

const STYLE_ID = 'compare-styles';

// Tokens only. The kit has no classes for the variant list, the status rows or the comparison cell, so they are scoped here.
const CSS = `
.cmp { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-3); min-width: 0; }
.cmp[hidden] { display: none; }
.cmp__lead { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); }
.cmp__block { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.cmp__line { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); }
.cmp__line.is-warn { color: var(--warn-text); }
.cmp-variants { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.cmp-variants > li { display: flex; align-items: center; gap: var(--sp-2); min-height: 36px; padding: 4px var(--sp-3); border-top: 1px solid var(--border); }
.cmp-variants > li:first-child { border-top: 0; }
.cmp-variants .check { flex: 1 1 auto; min-width: 0; }
.cmp-variants .check span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmp-letter { display: inline-grid; place-items: center; flex: none; min-width: 20px; height: 20px; padding: 0 4px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent-text); font-size: var(--fs-xs); font-weight: var(--fw-semibold); }
.cmp-run { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
.cmp-progress { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.cmp-progress[hidden] { display: none; }
.cmp-progress__head { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
.cmp-progress__title { font-weight: var(--fw-semibold); }
.cmp-progress__eta { margin-left: auto; color: var(--text-dim); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.cmp-status { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; font-size: var(--fs-sm); }
.cmp-status > li { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.cmp-status__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmp-status__state { margin-left: auto; padding-left: var(--sp-2); color: var(--text-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
.cmp-status > li.is-failed .cmp-status__state { color: var(--bad-text); }
.cmp-result .card__body { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.cmp-meta { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); }
.cmp-headline { display: flex; align-items: flex-start; gap: var(--sp-2); margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-semibold); line-height: var(--lh-tight); }
.cmp-headline .icon { flex: none; margin-top: 2px; color: var(--accent-text); }
.cmp-table th, .cmp-table td { vertical-align: top; }
.cmp-table td { white-space: nowrap; }
.cmp-table thead th { vertical-align: bottom; white-space: normal; }
.cmp-table tbody th { white-space: normal; position: sticky; left: 0; top: auto; z-index: var(--z-raised); min-width: 112px; max-width: 160px; background: var(--surface); font-weight: var(--fw-medium); }
.cmp-table thead th:first-child { left: 0; z-index: calc(var(--z-raised) + 1); }
.cmp-metric { display: block; }
.cmp-unit { display: block; color: var(--text-dim); font-size: var(--fs-xs); font-weight: var(--fw-regular); }
.cmp-head { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 2px; max-width: 120px; }
.cmp-head__name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmp-head__base { color: var(--text-dim); font-size: var(--fs-xs); font-weight: var(--fw-regular); }
.cmp-table th, .cmp-table td { padding: 6px 8px; }
.cmp-table td.is-best::before, .cmp-table td.is-worst::before { display: none; }
.cmp-cell { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 1px; vertical-align: top; }
.cmp-cell__main { display: inline-flex; align-items: center; gap: 4px; }
.is-best .cmp-cell__main::before, .is-worst .cmp-cell__main::before { content: ''; width: 10px; height: 10px; background: currentColor; -webkit-mask: var(--glyph) center / contain no-repeat; mask: var(--glyph) center / contain no-repeat; }
.cmp-cell__range { color: var(--text-dim); font-size: var(--fs-xs); font-weight: var(--fw-regular); white-space: nowrap; }
td.is-best .cmp-cell__range, td.is-worst .cmp-cell__range { color: inherit; }
.cmp-note { margin: 0; color: var(--text-dim); font-size: var(--fs-xs); }
.cmp-chart { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.cmp-sweep-values { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.cmp-apply { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; }
@media (prefers-reduced-motion: no-preference) { .cmp-progress .progress__bar { transition: flex-basis var(--t-base) var(--ease); } }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  document.head.append(h('style', { id: STYLE_ID }, CSS));
}

// =================================================================================================
// Browser: small helpers
// =================================================================================================

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const hide = (el, hidden) => { el.hidden = hidden; };
const clock = (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "about 12 s left" for the remaining seconds, '' while it is too early to say. */
export function formatEta(seconds) {
  if (!finite(seconds)) return '';
  if (seconds < 5) return 'a few seconds left';
  if (seconds < 90) return `about ${Math.round(seconds / 5) * 5} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

/** Copy text to the clipboard; falls back to a hidden textarea where the async clipboard API is unavailable (plain http, old browsers). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { 'aria-hidden': 'true', tabindex: '-1', style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
    area.value = text;
    document.body.append(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
    return copied;
  }
}

/** Planner-friendly text of an error thrown by the simulation side. */
const errorText = (err) => (err && err.message ? err.message : String(err));

/** The problems of a layout (cached per layout object; the layouts are immutable by contract). */
const problemCache = new WeakMap();
function problemsOf(layout) {
  if (!problemCache.has(layout)) {
    const errors = validateLayout(layout).filter((i) => i.severity === 'error');
    problemCache.set(layout, errors.length);
  }
  return problemCache.get(layout);
}

// =================================================================================================
// Browser: setup pieces
// =================================================================================================

/** Run length, warm-up and repetitions, shared by both modes. They follow the plant's settings until the planner edits them. */
function createRunSettings(onChange) {
  const touched = { hours: false, warmup: false };
  const edit = (key) => () => { touched[key] = true; onChange(); };
  const hours = numberField({ label: 'Run length', unit: 'h', min: LIMITS.hours[0], max: LIMITS.hours[1], value: 8, onChange: edit('hours') });
  const warmup = numberField({ label: 'Warm-up', unit: 'min', min: LIMITS.warmupMin[0], max: LIMITS.warmupMin[1], value: 10, onChange: edit('warmup') });
  const runs = stepperField({
    label: 'Repetitions', hint: 'Every setting is simulated this many times with different random seeds, so you see the spread and not just luck.',
    min: LIMITS.replications[0], max: LIMITS.replications[1], value: 3, controlW: '128px', onChange,
  });
  const note = h('p', { class: 'cmp__line' });
  const el = h('div', { class: 'cmp__block', 'data-cmp': 'settings' }, h('span', { class: 'eyebrow' }, 'Run settings'), h('div', { class: 'field-grid' }, hours.el, warmup.el), runs.el, note);

  const get = () => ({ duration: Math.round(hours.get() * 3600), warmup: Math.round(warmup.get() * 60), replications: runs.get() });
  /** Message when the settings cannot be run, else null. */
  const problem = () => {
    const s = get();
    return s.warmup >= s.duration ? 'The warm-up must be shorter than the run, otherwise nothing is measured.' : null;
  };
  const describe = () => {
    const s = get();
    note.classList.toggle('is-warn', Boolean(problem()));
    note.textContent = problem() || `Results are measured over the last ${formatDuration(s.duration - s.warmup)} of each run.`;
  };
  return {
    el,
    get,
    problem,
    describe,
    /** Follow the plant's settings (seconds) for the fields the planner has not edited. */
    sync(settings) {
      if (!touched.hours) hours.set(round(settings.duration / 3600, 4));
      if (!touched.warmup) warmup.set(round(settings.warmup / 60, 4));
      describe();
    },
    setDisabled(disabled) { for (const c of [hours, warmup, runs]) c.setDisabled(disabled); },
  };
}

/** The list of variants to compare (checkboxes), with the hint on how to create more. */
function createVariantPicker(onChange) {
  const off = new Set(); // unticked scenario ids: a new scenario is ticked by default
  const rows = new Map(); // id -> { li, box, name, chip }
  const list = h('ul', { class: 'cmp-variants', 'data-cmp': 'variants', 'aria-label': 'Variants to compare' });
  const hint = h('div', { 'data-cmp': 'variants-hint' });
  const el = h('div', { class: 'cmp__block' }, h('span', { class: 'eyebrow' }, 'Variants'), list, hint);

  function makeRow(id) {
    const box = h('input', { type: 'checkbox', onchange: () => { if (box.checked) off.delete(id); else off.add(id); onChange(); } });
    const name = h('span');
    const chip = h('span', { class: 'chip chip--error', hidden: true });
    const letter = h('span', { class: 'cmp-letter', 'aria-hidden': 'true' });
    const li = h('li', { 'data-scenario': id }, h('label', { class: 'check' }, box, letter, name), chip);
    return { li, box, name, chip, letter };
  }

  /** A callout while there is nothing to compare yet, a quiet line once there is. */
  let hintKind = null;
  function showHint(count) {
    const kind = count < 2 ? 'few' : 'enough';
    if (kind === hintKind) return;
    hintKind = kind;
    const how = 'Click the + next to the plant tabs in the top bar to copy the current plant into a new variant. Change something in the copy (one more vehicle, a one-way aisle), then come back here.';
    hint.replaceChildren(count < 2
      ? callout({ severity: 'info', title: 'Create a variant to compare', text: how })
      : h('p', { class: 'cmp__line' }, 'Need another variant? Click the + next to the plant tabs in the top bar: it copies the current plant.'));
  }

  return {
    el,
    /** Patch the rows in place (a focused checkbox stays focused). `problems(layout)` = number of errors in that variant. */
    sync(scenarios, activeId, problems) {
      const ids = new Set(scenarios.map((s) => s.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.li.remove(); rows.delete(id); off.delete(id); }
      scenarios.forEach((s, i) => {
        if (!rows.has(s.id)) rows.set(s.id, makeRow(s.id));
        const row = rows.get(s.id);
        const parts = variantParts(s.name, i);
        row.box.checked = !off.has(s.id);
        row.letter.textContent = parts.letter;
        row.name.textContent = (parts.name || parts.letter) + (s.id === activeId ? ' (open now)' : '');
        const errors = problems(s.layout);
        row.chip.hidden = errors === 0;
        row.chip.textContent = plural(errors, 'problem', 'problems');
        row.chip.title = 'This variant has errors on its Checks tab; its results may be misleading.';
        if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] || null);
      });
      showHint(scenarios.length);
    },
    /** The ticked scenarios with their labels, in project order. */
    chosen(scenarios) {
      return scenarios.map((s, i) => ({ ...s, ...variantParts(s.name, i) })).filter((s) => !off.has(s.id));
    },
    setDisabled(disabled) { for (const row of rows.values()) row.box.disabled = disabled; },
  };
}

/** Groups the flat sweep parameters for the select: vehicles, workstations, storage, goods in, whole plant. */
function parameterGroups(params, layout) {
  const typeOf = (key) => layout.stations.find((s) => s.id === key.split('.')[1])?.type;
  const groupOf = (p) => {
    if (p.key.startsWith('fleet.')) return 'Vehicles';
    if (!p.key.startsWith('station.')) return 'Whole plant';
    return { process: 'Workstations', storage: 'Storage', source: 'Goods in' }[typeOf(p.key)] || 'Other';
  };
  const groups = new Map();
  for (const p of params) {
    const name = groupOf(p);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(p);
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}

/** Put the options of a select into optgroups (fields.js builds a flat list). */
function groupSelect(select, groups) {
  const byValue = new Map([...select.options].map((o) => [o.value, o]));
  select.replaceChildren(...groups.map((g) => h('optgroup', { label: g.label }, g.items.map((p) => byValue.get(p.key)))));
}

/** Which setting to sweep, over which values, and which measure to plot. */
function createSweepSetup({ exp, onChange }) {
  let params = [];
  let param = null;
  let layoutSeen = null;
  let signature = '';
  let listStale = false;
  let edited = false;
  const range = { min: 0, max: 0, step: 1 };

  const select = selectField({ label: 'Setting to change', options: [{ value: '', label: 'No settings available' }], onChange: (key) => choose(key) });
  const current = h('p', { class: 'cmp__line', 'data-cmp': 'sweep-current' });
  const markEdited = (key) => (v) => { range[key] = v; edited = true; reset.hidden = false; refresh(); onChange(); };
  const min = numberField({ label: 'From', value: 0, onChange: markEdited('min') });
  const max = numberField({ label: 'To', value: 0, onChange: markEdited('max') });
  const step = numberField({ label: 'Step', value: 1, min: 0, onChange: markEdited('step') });
  const preview = h('p', { class: 'cmp__line', 'data-cmp': 'sweep-values' });
  const reset = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', hidden: true, onclick: () => { prefill(); onChange(); } }, icon('reset', { size: 14 }), 'Use suggested values');
  const metric = selectField({
    label: 'Measure to plot', value: 'throughput', onChange: () => onChange(),
    options: METRICS.map((m) => ({ value: m.id, label: m.unit ? `${m.label} (${m.unit})` : m.label })),
  });
  const el = h('div', { class: 'cmp__block', 'data-cmp': 'sweep-setup' }, h('span', { class: 'eyebrow' }, 'Setting'), select.el, current,
    h('div', { class: 'field-grid', style: { '--cols': 3 } }, min.el, max.el, step.el), h('div', { class: 'cmp-sweep-values' }, preview, reset), metric.el);

  /** The values to test: the suggestions until the planner edits the range, then the grid of the three fields. */
  function plan() {
    if (!param) return { param: null, values: [], error: 'This plant has nothing to sweep yet. Add vehicles or workstations first.' };
    const { values, error } = edited ? rangeValues(range.min, range.max, range.step, param.get(layoutSeen)) : { values: [...param.values], error: null };
    return { param, values, error: error || (values.length < 2 ? 'Choose at least two values to compare.' : null) };
  }

  function refresh() {
    const { values, error } = plan();
    preview.classList.toggle('is-warn', Boolean(error));
    preview.textContent = error || `Will test ${plural(values.length, 'value', 'values')}: ${describeValues(values, param.unit)}`;
    current.textContent = param ? `Currently ${formatParamValue(param.get(layoutSeen), param.unit)}.` : '';
  }

  /** Fill the range fields with the parameter's suggestions. */
  function prefill() {
    edited = false;
    reset.hidden = true;
    if (!param) { refresh(); return; }
    const values = param.values;
    Object.assign(range, { min: values[0], max: values[values.length - 1], step: param.step });
    min.set(range.min);
    max.set(range.max);
    step.set(range.step);
    refresh();
  }

  function choose(key) {
    param = params.find((p) => p.key === key) || null;
    prefill();
    onChange();
  }

  return {
    el,
    plan,
    metricId: () => metric.get(),
    /**
     * Re-read the parameters when the layout changed; keeps the choice (and the planner's range) while it still exists.
     * A changed list of settings is not shown while the select has focus (that would close its menu); the next call does.
     */
    sync(layout) {
      if (layout === layoutSeen && !listStale) return;
      layoutSeen = layout;
      params = exp.listSweepParameters(layout);
      const sig = params.map((p) => `${p.key}|${p.label}`).join(';');
      listStale = sig !== signature && select.input === document.activeElement;
      if (sig !== signature && !listStale) {
        signature = sig;
        select.setOptions(params.length ? params.map((p) => ({ value: p.key, label: p.label })) : [{ value: '', label: 'No settings available' }]);
        if (params.length) groupSelect(select.input, parameterGroups(params, layout));
        const keep = param && params.some((p) => p.key === param.key) ? param.key : params[0]?.key;
        select.set(keep ?? '');
        param = params.find((p) => p.key === keep) || null;
        prefill();
      } else {
        param = params.find((p) => p.key === param?.key) || param;
        if (!edited) prefill(); else refresh();
      }
    },
    setDisabled(disabled) { for (const c of [select, min, max, step, metric]) c.setDisabled(disabled); },
  };
}

// =================================================================================================
// Browser: progress
// =================================================================================================

const STATE_TONE = { waiting: 'tone-idle', running: 'tone-accent', done: 'tone-good', failed: 'tone-bad', cancelled: 'tone-idle' };

/** The progress block: overall bar, estimated time left, one status row per variant / value and a Cancel button. */
function createProgress(onCancel) {
  const title = h('span', { class: 'cmp-progress__title' });
  const eta = h('span', { class: 'cmp-progress__eta', 'data-cmp': 'eta' });
  const bar = h('div', { class: 'progress__bar', style: { '--w': '0%' } });
  const track = h('div', { class: 'progress progress--lg', role: 'progressbar', 'aria-label': 'Progress of the experiment', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, bar);
  const list = h('ul', { class: 'cmp-status', 'data-cmp': 'status' });
  const cancel = h('button', { class: 'btn', type: 'button', 'data-cmp': 'cancel', onclick: onCancel }, icon('close', { size: 14 }), 'Cancel');
  const el = h('div', { class: 'cmp-progress', 'data-cmp': 'progress', hidden: true },
    h('div', { class: 'cmp-progress__head' }, title, eta), track, list, h('div', { class: 'row' }, cancel));
  let items = [];

  function setItem(i, state, detail = '') {
    const item = items[i];
    item.li.className = state === 'failed' ? 'is-failed' : '';
    item.dot.className = `dot ${STATE_TONE[state]}`;
    item.state.textContent = detail || { waiting: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }[state];
    item.li.dataset.state = state;
  }

  return {
    el,
    cancel,
    begin(heading, names) {
      title.textContent = heading;
      items = names.map((name) => {
        const dot = h('span', { class: 'dot' });
        const state = h('span', { class: 'cmp-status__state' });
        return { dot, state, li: h('li', null, dot, h('span', { class: 'cmp-status__name' }, name), state) };
      });
      list.replaceChildren(...items.map((it) => it.li));
      items.forEach((_, i) => setItem(i, 'waiting'));
      cancel.disabled = false;
      this.setFraction(0, '');
      hide(el, false);
    },
    setItem,
    setFraction(fraction, etaText) {
      const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
      bar.style.setProperty('--w', `${pct}%`);
      track.setAttribute('aria-valuenow', String(pct));
      eta.textContent = etaText ? `${pct} % · ${etaText}` : `${pct} %`;
    },
    hide() { hide(el, true); },
  };
}

// =================================================================================================
// Browser: result views
// =================================================================================================

/** Banner above a stale result with "Run again". */
function staleBanner(staleness, onRerun, disabled) {
  const again = h('button', { class: 'btn btn--sm', type: 'button', 'data-cmp': 'rerun', disabled, onclick: onRerun }, icon('reset', { size: 14 }), 'Run again');
  const banner = callout({ severity: 'warn', title: 'These results are out of date', text: staleness.text, actions: h('div', { class: 'row' }, again) });
  banner.dataset.cmp = 'stale';
  return banner;
}

const deltaEl = (delta) => (delta ? h('span', { class: `delta${delta.tone === 'neutral' ? '' : ` delta--${delta.tone}`}` }, delta.text) : null);

/** A cell of the comparison table: value, change against the first variant, lowest-highest. */
function comparisonCell(cell) {
  const cls = ['num', cell.best ? 'is-best' : '', cell.worst ? 'is-worst' : ''].filter(Boolean).join(' ');
  return h('td', { class: cls, title: cell.best ? 'Best in this row' : cell.worst ? 'Worst in this row' : null },
    h('span', { class: 'cmp-cell' }, h('span', { class: 'cmp-cell__main' }, cell.text), deltaEl(cell.delta), cell.range ? h('span', { class: 'cmp-cell__range' }, cell.range) : null));
}

function comparisonTable(model) {
  const head = h('tr', null, h('th', { scope: 'col' }, 'Measure'), model.variants.map((v, i) => h('th', { scope: 'col', class: 'num', title: v.label },
    h('span', { class: 'cmp-head' }, h('span', { class: 'cmp-letter' }, v.letter), v.name ? h('span', { class: 'cmp-head__name' }, v.name) : null,
      i === 0 ? h('span', { class: 'cmp-head__base' }, 'reference') : null))));
  const body = model.rows.map((row) => h('tr', { 'data-metric': row.metric.id },
    h('th', { scope: 'row' }, h('span', { class: 'cmp-metric' }, row.metric.label), row.scale.unit ? h('span', { class: 'cmp-unit' }, row.scale.unit) : null),
    row.cells.map(comparisonCell)));
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Comparison table, scrolls sideways' },
    h('table', { class: 'table cmp-table', 'data-cmp': 'table' }, h('thead', null, head), h('tbody', null, body)));
}

/** "Copy as table" for a tab-separated text, with a toast saying what happened. */
async function copyWithToast(ctx, text) {
  const ok = await copyText(text);
  ctx.toast(ok ? 'Table copied. Paste it into a spreadsheet or a document.' : 'Copying is blocked in this browser. Select the table and copy it by hand.', { kind: ok ? 'success' : 'warn' });
}

/** The comparison result card: headline, table, legend note, bar chart of one measure, copy and report buttons. */
function createCompareResult(ctx) {
  let chart = null;
  let model = null;
  let result = null;
  let metricId = 'throughput';
  const holder = h('div', { 'data-cmp': 'bar-chart' });
  const picker = selectField({ label: 'Show in the chart', options: [{ value: metricId, label: 'Throughput' }], onChange: (id) => { metricId = id; drawChart(); } });
  const chartBlock = h('div', { class: 'cmp-chart' }, picker.el, holder);
  const body = h('div', { class: 'card__body' });
  const copy = h('button', { class: 'btn btn--sm', type: 'button', 'data-cmp': 'copy', onclick: () => { if (model) copyWithToast(ctx, comparisonTsv(model)); } }, icon('copy', { size: 14 }), 'Copy as table');
  const report = ctx.actions?.exportReport
    ? h('button', { class: 'btn btn--sm', type: 'button', 'data-cmp': 'report', onclick: () => ctx.actions.exportReport() }, icon('export', { size: 14 }), 'Create report')
    : null;
  const el = h('section', { class: 'card cmp-result', 'data-cmp': 'compare-result', 'aria-label': 'Comparison result', hidden: true },
    h('div', { class: 'card__header' }, h('h3', { class: 'card__title' }, 'Comparison'), h('div', { class: 'card__actions' }, copy, report)), body);

  function drawChart() {
    const row = model.rows.find((r) => r.metric.id === metricId);
    const options = {
      categories: model.variants.map((v) => v.label),
      series: [{ name: row.metric.label, values: row.cells.map((c) => (c.mean === null ? null : c.mean * row.scale.factor)) }],
      unit: row.scale.unit, digits: row.scale.digits, highlight: row.metric.better ? 'both' : null, better: row.metric.better || 'higher',
      valueLabel: row.scale.unit ? `${row.metric.label} (${row.scale.unit})` : row.metric.label, ariaLabel: `${row.metric.label} by variant`,
    };
    if (chart) chart.update(options);
    else { chart = createBarChart(options); holder.append(chart.el); }
  }

  const meta = () => {
    const s = result.settings;
    return `Run at ${clock(result.at)} · ${plural(result.variants.length, 'variant', 'variants')} · ${plural(s.replications, 'run', 'runs')} of ${formatDuration(s.duration)} each, first ${formatDuration(s.warmup)} ignored`;
  };

  const legend = () => [
    model.repetitions > 1 ? 'The small figure under a value is the lowest to highest result over the repetitions. ' : '',
    `Green marks the best and red the worst in a row; differences below ${Math.round(NOISE * 100)} % are not marked. The change shown is against the first variant.`,
    model.missing.length ? ` Not available for these plants: ${model.missing.map((m) => m.label).join(', ')}.` : '',
  ].join('');

  return {
    el,
    destroy() { chart?.destroy(); },
    /** Show a result (null hides the card); `staleness` adds the out-of-date banner. */
    show(next, staleness, { onRerun, rerunBlocked }) {
      result = next;
      hide(el, !next);
      if (!next) return;
      model = buildComparison(next);
      if (!model.rows.some((r) => r.metric.id === metricId)) metricId = model.rows[0]?.metric.id;
      picker.setOptions(model.rows.map((r) => ({ value: r.metric.id, label: r.metric.label })), metricId);
      const text = headline(next.variants);
      render(body,
        staleness ? staleBanner(staleness, onRerun, rerunBlocked) : null,
        text ? h('p', { class: 'cmp-headline', 'data-cmp': 'headline' }, icon('target', { size: 18 }), text) : null,
        h('p', { class: 'cmp-meta' }, meta()),
        comparisonTable(model),
        h('p', { class: 'cmp-note' }, legend()),
        model.rows.length ? chartBlock : null,
      );
      if (model.rows.length) drawChart();
    },
  };
}

/** One row of the sweep table with its "Apply this value" button. */
function sweepRow(row, param, onApply) {
  const apply = h('button', {
    class: 'btn btn--sm', type: 'button', 'data-cmp': 'apply', 'data-value': row.value, disabled: row.current,
    title: row.current ? 'The plant already uses this value' : 'Apply this value to the plant (Undo takes it back)',
    'aria-label': `Apply this value: ${param.label} = ${row.valueText}`, onclick: () => onApply(row.value),
  }, row.current ? 'In use' : 'Apply this value');
  return h('tr', { 'data-value': row.value, class: row.current ? 'is-selected' : null },
    h('td', null, h('span', { class: 'cmp-apply' }, row.valueText, row.current ? h('span', { class: 'chip chip--info' }, 'now') : null)),
    h('td', { class: `num${row.best ? ' is-best' : ''}`, title: row.best ? 'Best result' : null },
      h('span', { class: 'cmp-cell' }, h('span', { class: 'cmp-cell__main' }, row.text), deltaEl(row.delta), row.range ? h('span', { class: 'cmp-cell__range' }, row.range) : null)),
    h('td', { class: 'num' }, apply));
}

/**
 * The numbers of the sweep chart in the scale of the measure: x values, mean, lowest / highest (null for a single run) and the
 * index of the best point (-1 when there is none). Shared by the chart on screen and the picture in the report.
 * @param {object} result a sweep result
 * @param {ReturnType<typeof buildSweep>} model
 */
export function sweepSeries(result, model) {
  const { metric, scale, rows } = model;
  const scaled = (v) => (finite(v) ? v * scale.factor : null);
  const stats = result.points.map((p) => p.summary?.[metric.id]);
  const bands = result.settings.replications > 1;
  return {
    x: rows.map((r) => r.value),
    y: rows.map((r) => scaled(r.mean)),
    lo: bands ? stats.map((s) => scaled(s?.min)) : null,
    hi: bands ? stats.map((s) => scaled(s?.max)) : null,
    bestIndex: rows.findIndex((r) => r.best),
  };
}

/** Options of the sweep line chart: the measure's mean with its min-max band, the best point, the value in use. */
function sweepChartOptions(result, model) {
  const { metric, scale } = model;
  const { x, y, lo, hi, bestIndex } = sweepSeries(result, model);
  const series = [{ name: metric.label, y, lo: lo || undefined, hi: hi || undefined }];
  if (bestIndex >= 0) series.push({ name: 'Best value', color: 'good', y: y.map((v, i) => (i === bestIndex ? v : null)) });
  const unit = result.param.unit && !COUNT_UNITS.includes(result.param.unit) ? ` (${result.param.unit})` : '';
  return {
    x, series, markers: true, height: 240,
    xLabel: `${result.param.label}${unit}`, yLabel: scale.unit ? `${metric.label} (${scale.unit})` : metric.label,
    xFormat: (v) => formatParamValue(v, result.param.unit, { short: true }), yFormat: (v) => formatNumber(v, scale.digits), yUnit: scale.unit,
    refLines: finite(result.current) ? [{ axis: 'x', value: result.current, label: 'now' }] : [], ariaLabel: `${metric.label} over ${result.param.label}`,
  };
}

/** The sweep result card: recommendation, chart (click a point to apply it), table with apply buttons. */
function createSweepResult(ctx, { onApply }) {
  let chart = null;
  let shown = null;
  const body = h('div', { class: 'card__body' });
  const chartNote = h('p', { class: 'cmp-note' });
  const chartWrap = h('div', { class: 'cmp-chart', 'data-cmp': 'line-chart' });
  const copy = h('button', { class: 'btn btn--sm', type: 'button', 'data-cmp': 'copy-sweep', onclick: () => { if (shown) copyWithToast(ctx, sweepTsv(shown.result, shown.model)); } }, icon('copy', { size: 14 }), 'Copy as table');
  const el = h('section', { class: 'card cmp-result', 'data-cmp': 'sweep-result', 'aria-label': 'Sweep result', hidden: true },
    h('div', { class: 'card__header' }, h('h3', { class: 'card__title' }, 'Sweep'), h('div', { class: 'card__actions' }, copy)), body);

  function drawChart(result, model) {
    const options = sweepChartOptions(result, model);
    if (chart) chart.update(options);
    else {
      chart = createLineChart({ ...options, onPointClick: ({ x }) => onApply(x) });
      chartWrap.prepend(chart.el);
    }
  }

  const table = (result, model) => h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Sweep table, scrolls sideways' },
    h('table', { class: 'table cmp-table', 'data-cmp': 'sweep-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Value'),
        h('th', { scope: 'col', class: 'num' }, model.scale.unit ? `${model.metric.label} (${model.scale.unit})` : model.metric.label),
        h('th', { scope: 'col', class: 'num' }, h('span', { class: 'sr-only' }, 'Action')))),
      h('tbody', null, model.rows.map((row) => sweepRow(row, result.param, onApply)))));

  return {
    el,
    destroy() { chart?.destroy(); },
    show(result, metricId, staleness, { onRerun, rerunBlocked }) {
      hide(el, !result);
      if (!result) return;
      const model = buildSweep(result, metricId);
      shown = { result, model };
      const s = result.settings;
      drawChart(result, model);
      chartNote.textContent = `Click a point to apply that value to the plant. ${s.replications > 1 ? 'The shaded band is the lowest to highest result over the repetitions. ' : ''}The dashed line marks the value in use now.`;
      chartWrap.append(chartNote);
      render(body,
        staleness ? staleBanner(staleness, onRerun, rerunBlocked) : null,
        h('p', { class: 'cmp-headline', 'data-cmp': 'recommendation' }, icon('target', { size: 18 }), model.recommendation.text),
        h('p', { class: 'cmp-meta' }, `${result.param.label} · run at ${clock(result.at)} · ${plural(s.replications, 'run', 'runs')} of ${formatDuration(s.duration)} per value`),
        result.partial && result.points.length < result.values.length
          ? callout({ severity: 'info', title: 'Stopped early', text: `Only ${plural(result.points.length, 'value', 'values')} of ${result.values.length} were tested.` })
          : null,
        chartWrap,
        table(result, model),
      );
      chart.update({});
    },
  };
}

// =================================================================================================
// Browser: the tab
// =================================================================================================

/**
 * Create the Experiments tab.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): store, toast, optionally actions.exportReport
 * @param {{ experiments?: { runReplications?: Function, listSweepParameters?: Function } }} [options] replacements for the
 *   simulation side (tests); by default js/sim/experiments.js
 * @returns {{ el: HTMLElement, update(state: object): void, setVisible(visible: boolean): void, destroy(): void }}
 */
export function createCompare(ctx, options = {}) {
  injectStyles();
  const { store } = ctx;
  const exp = { runReplications: realRunReplications, listSweepParameters: realListSweepParameters, ...options.experiments };
  let state = store.getState();
  let mode = 'compare';
  let visible = true;
  let destroyed = false;
  let job = null; // { controller } while an experiment runs
  let seen = { project: null, layout: null };
  const rendered = { compare: null, sweep: null }; // inputs of the last render of each result card

  const modeSwitch = segmentedField({
    label: 'Experiment type', value: mode, block: true, onChange: (m) => { mode = m; showMode(); },
    options: [
      { value: 'compare', label: 'Compare variants', title: 'Run several variants of the plant and put the results side by side' },
      { value: 'sweep', label: 'Parameter sweep', title: 'Change one setting step by step and see how the results respond' },
    ],
  });
  modeSwitch.el.querySelector('.field__label')?.classList.add('sr-only');
  const settings = createRunSettings(() => refreshRun());
  const picker = createVariantPicker(() => refreshRun());
  const sweepSetup = createSweepSetup({ exp, onChange: () => { refreshRun(); refreshResults(); } });
  const progress = createProgress(() => cancel());
  const runLabel = h('span', null, 'Run comparison');
  const runButton = h('button', { class: 'btn btn--primary', type: 'button', 'data-cmp': 'run', onclick: () => run() }, icon('flask', { size: 16 }), runLabel);
  const runNote = h('p', { class: 'cmp__line', 'data-cmp': 'run-note' });
  const errorSlot = h('div', { 'data-cmp': 'error' });
  const live = h('p', { class: 'sr-only', role: 'status' });
  const compareResult = createCompareResult(ctx);
  const sweepResult = createSweepResult(ctx, { onApply: (value) => applyValue(value) });
  const emptyNote = h('p', { class: 'cmp__line', 'data-cmp': 'empty' });
  const compareSetup = h('div', { class: 'cmp__block', 'data-mode': 'compare' }, picker.el);
  const sweepBlock = h('div', { class: 'cmp__block', 'data-mode': 'sweep' }, sweepSetup.el);

  const el = h('div', { class: 'cmp', 'data-panel': 'experiments' },
    h('div', { class: 'cmp__block' },
      h('p', { class: 'cmp__lead' }, 'Try ideas on copies of the plant before you change the real thing. Experiments run in the background: keep working, or cancel any time.'),
      modeSwitch.el),
    compareSetup, sweepBlock, settings.el,
    h('div', { class: 'cmp__block' }, h('div', { class: 'cmp-run' }, runButton), runNote),
    progress.el, errorSlot, compareResult.el, sweepResult.el, emptyNote, live);

  // ---- what the tab shows ---------------------------------------------------------------------------------

  const staleOf = (result) => resultStaleness(result, state);

  /** Why a run cannot start (a sentence), or null. */
  function blocker() {
    if (job) return 'An experiment is already running.';
    const problem = settings.problem();
    if (problem) return problem;
    if (mode === 'compare') return picker.chosen(state.project.scenarios).length < 2 ? 'Tick at least two variants to compare.' : null;
    return sweepSetup.plan().error;
  }

  /** "9 simulation runs of 2 h each", plus a warning for variants that have errors on their Checks tab. */
  function runSummary() {
    const s = settings.get();
    const chosen = picker.chosen(state.project.scenarios);
    const count = mode === 'compare' ? chosen.length : sweepSetup.plan().values.length;
    const broken = mode === 'compare' ? chosen.filter((v) => problemsOf(v.layout) > 0).map((v) => v.label) : (problemsOf(state.layout) > 0 ? ['The open plant'] : []);
    const warning = broken.length ? ` ${broken.join(', ')} ${broken.length === 1 ? 'has' : 'have'} errors on the Checks tab: the results may be misleading.` : '';
    return `${plural(count * s.replications, 'simulation run', 'simulation runs')} of ${formatDuration(s.duration)} each.${warning}`;
  }

  function refreshRun() {
    settings.describe();
    const why = blocker();
    runButton.disabled = Boolean(why);
    runNote.classList.toggle('is-warn', Boolean(why) && !job);
    runNote.textContent = job ? '' : why || runSummary();
  }

  function renderOnce(slot, parts, render) {
    const prev = rendered[slot];
    if (prev && prev.every((p, i) => p === parts[i])) return;
    rendered[slot] = parts;
    render();
  }

  function refreshResults() {
    const blocked = Boolean(blocker());
    const compare = mode === 'compare' ? lastResults.compare : null;
    const sweep = mode === 'sweep' ? lastResults.sweep : null;
    const compareStale = staleOf(compare);
    const sweepStale = staleOf(sweep);
    const rerun = () => run();
    renderOnce('compare', [compare, compareStale?.text, blocked], () => compareResult.show(compare, compareStale, { onRerun: rerun, rerunBlocked: blocked }));
    renderOnce('sweep', [sweep, sweep?.current, sweepStale?.text, blocked, sweepSetup.metricId()], () => sweepResult.show(sweep, sweepSetup.metricId(), sweepStale, { onRerun: rerun, rerunBlocked: blocked }));
    hide(emptyNote, Boolean(compare || sweep || job));
    emptyNote.textContent = mode === 'compare' ? 'No comparison yet. Choose the variants and press Run comparison.' : 'No sweep yet. Choose a setting and press Run sweep.';
  }

  function showMode() {
    hide(compareSetup, mode !== 'compare');
    hide(sweepBlock, mode !== 'sweep');
    runLabel.textContent = mode === 'compare' ? 'Run comparison' : 'Run sweep';
    refreshRun();
    refreshResults();
  }

  function showError(title, text) {
    errorSlot.replaceChildren(title ? callout({ severity: 'error', title, text }) : '');
  }

  function setBusy(busy) {
    for (const part of [picker, settings, sweepSetup]) part.setDisabled(busy);
    el.dataset.state = busy ? 'running' : 'idle';
  }

  // ---- running ---------------------------------------------------------------------------------------------

  /** Progress callback for item `i` of `n`: bar, estimated time left and the "run r of R" detail, repainted at most every 100 ms. */
  function tracker(n, reps) {
    const startedAt = performance.now();
    let lastPaint = 0;
    return (i, p) => {
      const now = performance.now();
      if (now - lastPaint < 100 && p.fraction < 1) return;
      lastPaint = now;
      const overall = (i + p.fraction) / n;
      const left = overall > 0.03 ? ((now - startedAt) / 1000) * (1 - overall) / overall : NaN;
      progress.setFraction(overall, formatEta(left));
      progress.setItem(i, 'running', reps > 1 ? `Run ${Math.min(reps, Math.floor(p.fraction * reps) + 1)} of ${reps}` : `${Math.round(p.fraction * 100)} %`);
    };
  }

  /** Simulate one layout `s.replications` times; marks row `i` of the progress list and names `what` in an error. */
  async function simulate(layout, what, i, track, s, signal) {
    progress.setItem(i, 'running');
    try {
      const r = await exp.runReplications(layout, { duration: s.duration, warmup: s.warmup, replications: s.replications, signal, onProgress: (p) => track(i, p) });
      progress.setItem(i, 'done');
      return r;
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      progress.setItem(i, aborted ? 'cancelled' : 'failed');
      throw aborted ? err : new Error(`${what} could not be simulated: ${errorText(err)}`);
    }
  }

  async function runComparison(signal) {
    const chosen = picker.chosen(state.project.scenarios);
    const s = settings.get();
    progress.begin('Comparing variants', chosen.map((v) => v.label));
    const track = tracker(chosen.length, s.replications);
    const variants = [];
    for (let i = 0; i < chosen.length; i++) {
      const v = chosen[i];
      const r = await simulate(v.layout, v.label, i, track, s, signal);
      variants.push({ id: v.id, name: v.name, letter: v.letter, label: v.label, summary: r.summary, layout: v.layout });
    }
    lastResults.compare = { kind: 'compare', at: Date.now(), settings: s, variants };
  }

  async function runSweep(signal) {
    const { param, values } = sweepSetup.plan();
    const layout = state.layout;
    const scenario = state.project.scenarios.find((sc) => sc.id === state.project.activeId);
    const s = settings.get();
    const previous = lastResults.sweep;
    const result = { kind: 'sweep', at: Date.now(), scenarioId: scenario.id, scenarioName: scenario.name, layout, param, current: param.get(layout), values, points: [], settings: s, partial: true };
    progress.begin(`Sweep of ${param.label}`, values.map((v) => formatParamValue(v, param.unit)));
    const track = tracker(values.length, s.replications);
    try {
      for (let i = 0; i < values.length; i++) {
        const r = await simulate(param.apply(layout, values[i]), `${param.label} = ${formatParamValue(values[i], param.unit)}`, i, track, s, signal);
        result.points.push({ value: values[i], summary: r.summary });
        lastResults.sweep = { ...result, points: [...result.points] };
        refreshResults();
      }
    } catch (err) {
      lastResults.sweep = result.points.length >= 2 ? { ...result, points: [...result.points] } : previous;
      throw err;
    }
    lastResults.sweep = { ...result, partial: false };
  }

  /** Tell a screen reader (and, when the tab is not on screen, everybody) how the run ended. */
  function announce(message, kind) {
    live.textContent = message;
    if (!visible) ctx.toast(message, { kind });
  }

  async function run() {
    if (job || blocker()) return;
    showError(null);
    job = { controller: new AbortController() };
    setBusy(true);
    refreshRun();
    refreshResults();
    progress.cancel.focus();
    const label = mode === 'compare' ? 'Comparison' : 'Sweep';
    try {
      await (mode === 'compare' ? runComparison : runSweep)(job.controller.signal);
      progress.hide();
      announce(`${label} finished.`, 'success');
    } catch (err) {
      progress.cancel.disabled = true;
      if (err?.name === 'AbortError') announce(`${label} cancelled.`, 'info');
      else showError('The experiment could not run', errorText(err));
    } finally {
      job = null;
      setBusy(false);
      refreshRun();
      refreshResults();
      if (!destroyed && (document.activeElement === progress.cancel || document.activeElement === document.body)) runButton.focus();
    }
  }

  function cancel() {
    if (job) job.controller.abort();
  }

  // ---- applying a sweep value ------------------------------------------------------------------------------

  /** Apply one value of the latest sweep to the open plant: one undoable commit "Apply <setting> = <value>". */
  function applyValue(value) {
    const result = lastResults.sweep;
    if (!result || job) return;
    const label = `Apply ${result.param.label} = ${formatParamValue(value, result.param.unit, { short: true })}`;
    const wasCurrent = !staleOf(result);
    const done = store.commit(label, (draft) => {
      // param.apply returns a changed copy; the store wants the draft edited in place
      const next = result.param.apply(draft, value);
      for (const key of Object.keys(next)) draft[key] = next[key];
    });
    if (!done) {
      ctx.toast(`The plant already uses ${formatParamValue(value, result.param.unit)}.`, { kind: 'info' });
      return;
    }
    if (wasCurrent) {
      // the swept setting is overwritten by every value, so the sweep is still valid for the new plant
      result.layout = store.getState().layout;
      result.current = value;
      refreshResults();
    }
    ctx.toast(`${result.param.label} is now ${formatParamValue(value, result.param.unit)}.`, { kind: 'success', action: { label: 'Undo', onClick: () => store.undo() } });
  }

  // ---- store updates ---------------------------------------------------------------------------------------

  function refreshAll() {
    picker.sync(state.project.scenarios, state.project.activeId, problemsOf);
    sweepSetup.sync(state.layout);
    settings.sync(state.layout.settings);
    refreshRun();
    refreshResults();
  }

  function update(next) {
    state = next;
    if (!visible || destroyed) return;
    if (seen.project === state.project && seen.layout === state.layout) return;
    seen = { project: state.project, layout: state.layout };
    refreshAll();
  }

  seen = { project: state.project, layout: state.layout };
  refreshAll();
  showMode();
  setBusy(false);

  return {
    el,
    update,
    setVisible(next) {
      visible = Boolean(next);
      if (visible) {
        seen = { project: null, layout: null };
        update(store.getState());
      }
    },
    destroy() {
      destroyed = true;
      cancel();
      compareResult.destroy();
      sweepResult.destroy();
      el.remove();
    },
  };
}
