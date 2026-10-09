// Report and exports (docs/ARCHITECTURE.md 6.6): the plant as a document a planner can hand to somebody else.
//
//   exportReportHtml(ctx, { includeComparison, now }) -> string   a complete, self-contained HTML document (no script, no external
//                                                                 request, inline CSS for A4 paper, the layout picture as a data URL)
//   downloadReport(ctx, opts)   save that document as a file         printReport(ctx, opts)   open it in a window and print / save as PDF
//   exportLayoutPng(ctx, { scale = 2 })   the whole plant as a PNG   exportLayoutJson(ctx)   the project (all variants) as a JSON file
//
// ctx is the shared context of docs/ARCHITECTURE.md 6.8; this file reads store, runner (sim, kpis(), insights()), renderer
// (toDataURL), issues() and toast. exportReportHtml itself touches no DOM, so it runs in Node with a stand-in ctx (the unit tests do).
//
// Safety. Every piece of text goes through the `html` template tag below, which escapes what it interpolates unless the value
// was itself built by `html` (or marked with `raw`). Plant, station, flow, fleet and variant names come from the user (and from
// imported files), so nothing is ever concatenated into markup by hand. The layout picture is only embedded when it is a PNG data URL.
//
// Readings of the spec (also listed in the engineer's report):
//  * The layout picture shows the plant without vehicles (a snapshot of moving vehicles is noise in a document); when the heatmap
//    overlay is switched on, the live simulation stays attached so the heatmap is in the picture. Report: light theme, 1x; PNG: the
//    theme on screen, 2x.
//  * KPIs come from the running simulation of this session (runner.kpis()). A warm-up that is still running, or less than five minutes
//    of measured time (insights.js MIN_DATA_SECONDS), is called out as "not representative"; under an hour as "indicative".
//  * Comparison and sweep results are those of compare.js getLastResults(), with a note when the plant changed since they were computed.
//  * Print / PDF opens a window synchronously (before anything slow, so popup blockers accept it) and prints once the images are
//    decoded. When the window is blocked the report is downloaded instead and the planner is told how to print it.

import { escapeHtml, formatDistance, formatDuration, formatNumber, formatPercent, round } from '../util/format.js';
import { downloadFile } from '../util/dom.js';
import { DISPATCH_STRATEGIES, ROUTING_MODES, STATION_TYPES, STATION_TYPE_ORDER } from '../model/defaults.js';
import { getFleet, getStation, roadCellCount, roadLengthMeters } from '../model/layout.js';
import { exportProject } from '../model/serialize.js';
import { MIN_DATA_SECONDS } from '../sim/insights.js';
import { summarizeReport } from '../sim/experiments.js';
import { niceTicks } from './charts.js';
import { buildComparison, buildSweep, formatParamValue, getLastResults, headline, resultStaleness, sweepSeries } from './compare.js';
import { clockRow, doorCheckRow, doorResultRows, withTrucks } from './report-ops.js';
import { BUILD } from '../build-info.js';
import { buildSummary } from '../version.js';

// =================================================================================================
// Safe markup
// =================================================================================================

class Safe {
  constructor(text) { this.text = text; }

  toString() { return this.text; }
}

/** Mark already-safe markup (built from constants) so `html` does not escape it. */
export const raw = (text) => new Safe(String(text));

const show = (v) => {
  if (v instanceof Safe) return v.text;
  if (Array.isArray(v)) return v.map(show).join('');
  return v === null || v === undefined || v === false ? '' : escapeHtml(v);
};

/**
 * Template tag that escapes every interpolated value (text, numbers, attribute values) and passes through the results of
 * other `html` calls and `raw`. Arrays are joined; null, undefined and false vanish.
 * @example html`<td title="${name}">${name}</td>` with name = '<b>"x"' gives &lt;b&gt;&quot;x&quot; in both places
 */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += show(v) + strings[i + 1]; });
  return new Safe(out);
}

// =================================================================================================
// Readable parameters (pure)
// =================================================================================================

const NONE = '–';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const count = (n, one, many) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const SPREAD = (d) => `${Math.round((d.spread || 0) * 100)} %`;

/** Planner name of a station type ("Goods in", "Workstation", "Storage / buffer", "Goods out", "Parking & charging"). */
export const stationTypeName = (type) => (STATION_TYPES[type] ? STATION_TYPES[type].label.split(' (')[0] : String(type));

/** A time distribution in words: "90 s on average, ±10 % (bell curve)". */
export function describeDist(d) {
  if (!d || !finite(d.mean)) return NONE;
  const mean = formatDuration(d.mean);
  switch (d.kind) {
    case 'const': return `${mean} (constant)`;
    case 'exp': return `${mean} on average (random, exponential)`;
    case 'uniform': return `${formatDuration(d.mean * (1 - (d.spread || 0)))} to ${formatDuration(d.mean * (1 + (d.spread || 0)))} (evenly spread)`;
    default: return `${mean} on average, ±${SPREAD(d)} (bell curve)`;
  }
}

/** "every 4 h on average, repaired in 20 min" or "none". */
export function describeBreakdowns(mtbf, mttr) {
  return mtbf > 0 ? `every ${formatDuration(mtbf)} on average, repaired in ${formatDuration(mttr)}` : 'none';
}

/**
 * The assumptions of a station as [label, value] pairs in readable units.
 * @param {object} station a layout station
 */
export function stationParams(station) {
  const p = station.params || {};
  switch (station.type) {
    case 'source':
      return withTrucks(station, [['Time between arrivals', describeDist(p.interArrival)], ['Loads per arrival', formatNumber(p.batch)],
        ['Output buffer', `${count(p.outCap, 'load', 'loads')} per outgoing flow`], ['First arrival', p.startDelay > 0 ? `after ${formatDuration(p.startDelay)}` : 'at the start']]);
    case 'sink':
      return withTrucks(station, []);
    case 'process':
      return [['Cycle time', describeDist(p.cycle)], ['Parallel machines', formatNumber(p.machines)], ['Loads produced per cycle', formatNumber(p.outPerCycle)],
        ['Input slots', `${formatNumber(p.inCap)} per incoming flow`], ['Output slots', `${formatNumber(p.outCap)} per outgoing flow`], ['Breakdowns', describeBreakdowns(p.mtbf, p.mttr)]];
    case 'storage':
      return [['Capacity', count(p.capacity, 'load', 'loads')], ['Minimum stay', p.dwell > 0 ? formatDuration(p.dwell) : 'none']];
    case 'depot':
      return [['Parking places', formatNumber(p.slots)], ['of them with a charger', formatNumber(p.chargers)]];
    default:
      return [];
  }
}

const PRIORITY = { 1: 'Normal', 2: 'High', 3: 'Urgent' };

/** "1 to 4 loads", "1 to vehicle capacity". */
function describeBatch(flow) {
  const high = flow.batchMax > 0 ? `${formatNumber(flow.batchMax)}` : 'vehicle capacity';
  return `${formatNumber(flow.batchMin)} to ${high}${flow.batchMax > 0 ? ' loads' : ''}`;
}

/**
 * The cells of one row of the flows table: from, to, share of the origin's output, loads per cycle, batch, longest wait, priority, vehicles.
 * @param {object} flow
 * @param {object} layout
 */
export function flowCells(flow, layout) {
  const name = (id) => getStation(layout, id)?.name || 'Unknown station';
  const siblings = layout.flows.filter((f) => f.from === flow.from);
  const total = siblings.reduce((sum, f) => sum + f.weight, 0);
  const fleet = flow.fleetId ? getFleet(layout, flow.fleetId) : null;
  return [name(flow.from), name(flow.to), siblings.length > 1 && total > 0 ? formatPercent(flow.weight / total) : 'all',
    formatNumber(flow.perCycle), describeBatch(flow), flow.maxWait > 0 ? formatDuration(flow.maxWait) : NONE,
    PRIORITY[flow.priority] || String(flow.priority), flow.fleetId ? (fleet ? fleet.name : 'Unknown fleet') : 'Any fleet'];
}

/**
 * The assumptions of a vehicle fleet as [label, value] pairs in readable units.
 * @param {object} fleet
 * @param {object} layout
 */
export function fleetParams(fleet, layout) {
  const b = fleet.battery || {};
  const home = fleet.home ? getStation(layout, fleet.home) : null;
  return [
    ['Top speed', `${formatNumber(fleet.speed, 2)} m/s (${formatNumber(fleet.speed * 3.6, 1)} km/h)`],
    ['Acceleration / braking', `${formatNumber(fleet.accel, 2)} / ${formatNumber(fleet.decel, 2)} m/s²`],
    ['Length', `${formatNumber(fleet.length, 2)} m`],
    ['Capacity', count(fleet.capacity, 'load', 'loads')],
    ['Loading / unloading', `${formatDuration(fleet.loadTime)} / ${formatDuration(fleet.unloadTime)}`],
    ['Battery', b.enabled
      ? `${formatDuration(b.runtimeMin * 60)} runtime, ${formatDuration(b.chargeTimeMin * 60)} to charge; goes charging below ${formatNumber(b.lowPct)} %, back to work at ${formatNumber(b.resumePct)} %`
      : 'not modelled'],
    ['Breakdowns', describeBreakdowns(fleet.mtbf, fleet.mttr)],
    ['Home depot', home ? home.name : 'none'],
    ['When idle', fleet.idle === 'stay' ? 'waits where the last job ended' : 'parks in a depot'],
  ];
}

const DEADLOCK = { resolve: 'Resolved automatically (a blocked vehicle is moved)', ignore: 'Let the jam stand' };

/**
 * The simulation settings as [label, value] pairs.
 * @param {object} settings layout.settings
 */
export function settingsRows(settings) {
  const factor = (v) => `${formatNumber(v, 2)}×`;
  return [
    ['Run length of an experiment', formatDuration(settings.duration)], ['Warm-up (not measured)', formatDuration(settings.warmup)],
    ['Random seed', formatNumber(settings.seed)],
    ['Dispatching', DISPATCH_STRATEGIES[settings.dispatch]?.label || settings.dispatch], ['Routing', ROUTING_MODES[settings.routing]?.label || settings.routing],
    ['Traffic', settings.handedness === 'left' ? 'Left-hand' : 'Right-hand'], ['Deadlocks', DEADLOCK[settings.deadlock] || settings.deadlock],
    ['Demand', factor(settings.demandFactor)], ['Vehicle speed', factor(settings.speedFactor)], ['Process times', factor(settings.processFactor)],
    ['Simulation time step', `${formatNumber(settings.dt, 3)} s`],
  ];
}

/** The plant at a glance as [label, value] pairs. */
export function plantRows(layout) {
  const { cols, rows, cellSize } = layout.grid;
  const width = cols * cellSize;
  const depth = rows * cellSize;
  const kinds = STATION_TYPE_ORDER
    .map((type) => [type, layout.stations.filter((s) => s.type === type).length])
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${n} × ${stationTypeName(type).toLowerCase()}`);
  const vehicles = layout.fleets.reduce((sum, f) => sum + f.count, 0);
  const clock = clockRow(layout);
  return [
    ['Floor area', `${formatNumber(width)} × ${formatNumber(depth)} m (${formatNumber(width * depth)} m²), grid of ${cols} × ${rows} cells of ${formatNumber(cellSize, 2)} m`],
    ['Road network', `${formatDistance(roadLengthMeters(layout))} (${count(roadCellCount(layout), 'cell', 'cells')})`],
    ['Stations', layout.stations.length ? `${layout.stations.length}: ${kinds.join(', ')}` : 'none'],
    ['Material flows', formatNumber(layout.flows.length)],
    ['Vehicles', `${formatNumber(vehicles)} in ${count(layout.fleets.length, 'fleet', 'fleets')}`],
    ['Obstacles', formatNumber(layout.obstacles.length)],
    ...(clock ? [clock] : []),
  ];
}

/** File-name friendly version of a name: "Plant 1 / East" -> "plant-1-east", "Größe Öl" -> "grosse-ol". */
export function slug(name, fallback = 'plant') {
  const s = String(name ?? '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return s || fallback;
}

/** The name the planner gave the plant: the project name of the top bar (the layout's own name is only a fallback). */
const plantName = (state) => state.project.name || state.layout.name;

const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const longDate = (date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const shortTime = (date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "logiplan-report-starter-plant-2026-10-08.html" */
export const reportFileName = (name, date = new Date()) => `logiplan-report-${slug(name)}-${isoDate(date)}.html`;

/**
 * The bytes of a base64 PNG data URL; null for anything else (the report only embeds pictures it can vouch for).
 * @param {string} url
 * @returns {Uint8Array|null}
 */
export function pngBytes(url) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(url ?? ''));
  if (!m) return null;
  const binary = atob(m[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * What the measured window of a KPI report allows one to say.
 * @param {{ window?: { warmingUp?: boolean, duration?: number, start?: number, end?: number } }} report
 * @returns {{ level: 'warming'|'short'|'indicative'|'ok', text: string }}
 */
export function measurementNote(report) {
  const w = report?.window || {};
  if (w.warmingUp) {
    return { level: 'warming', text: 'The simulation is still in its warm-up phase, which is not measured. The figures below are not representative: let it run on and create the report again.' };
  }
  if (!(w.duration >= MIN_DATA_SECONDS)) {
    return { level: 'short', text: `Only ${formatDuration(w.duration || 0)} of operation have been measured. That is too short for reliable figures: let the simulation run for at least an hour.` };
  }
  if (w.duration < 3600) return { level: 'indicative', text: `The figures cover ${formatDuration(w.duration)} of operation. Treat them as indicative; a full shift gives more reliable numbers.` };
  return { level: 'ok', text: `The figures cover ${formatDuration(w.duration)} of operation after the warm-up.` };
}

// =================================================================================================
// Pure SVG charts for the report
// =================================================================================================

const SVG_FONT = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"';
const n1 = (v) => round(v, 1);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Horizontal bars as an SVG picture.
 * @param {Array<{ label: string, value: number|null, mark?: 'best'|'worst'|null }>} items
 * @param {{ unit?: string, digits?: number, title: string }} opts
 */
export function svgBars(items, { unit = '', digits = 0, title }) {
  const width = 600;
  const labelW = 170;
  const left = labelW + 10;
  const room = width - left - 120;
  const rowH = 28;
  const top = Math.max(0, ...items.map((i) => (finite(i.value) ? i.value : 0))) || 1;
  const rows = items.map((item, i) => {
    const y = i * rowH + 4;
    const w = finite(item.value) ? Math.max(2, (item.value / top) * room) : 0;
    const colour = item.mark === 'best' ? '#1f7a45' : item.mark === 'worst' ? '#b3261e' : '#2f6fe0';
    const tag = item.mark === 'best' ? ' ✓ best' : item.mark === 'worst' ? ' ! worst' : '';
    const value = finite(item.value) ? `${formatNumber(item.value, digits)}${unit ? ` ${unit}` : ''}${tag}` : NONE;
    return html`<text x="${labelW}" y="${y + 15}" text-anchor="end" font-size="11.5" fill="#1b2430">${clip(item.label, 28)}</text>
<rect x="${left}" y="${y + 3}" width="${n1(w)}" height="16" rx="3" fill="${colour}"/>
<text x="${n1(left + w + 6)}" y="${y + 15}" font-size="11.5" fill="#1b2430">${value}</text>`;
  });
  return html`<svg class="chart" role="img" aria-label="${title}" viewBox="0 0 ${width} ${items.length * rowH + 8}" width="100%" ${raw(SVG_FONT)}><title>${title}</title>${rows}</svg>`;
}

/**
 * A line chart (value on x, measure on y, optional min-max band, best point and the value in use) as an SVG picture.
 * @param {{ x: number[], y: Array<number|null>, lo: Array<number|null>|null, hi: Array<number|null>|null, bestIndex: number }} series from sweepSeries
 * @param {{ xLabel: string, yLabel: string, xText: (v: number) => string, yText: (v: number) => string, current?: number|null, title: string }} opts
 */
export function svgLine(series, { xLabel, yLabel, xText, yText, current = null, title }) {
  const W = 600;
  const H = 270;
  const box = { l: 58, r: 18, t: 22, b: 52 };
  const known = series.y.filter(finite);
  const top = Math.max(0, ...known, ...(series.hi || []).filter(finite));
  const ticks = niceTicks(0, top || 1, 5);
  const xs = series.x;
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const px = (v) => box.l + 10 + ((v - xMin) / (xMax - xMin || 1)) * (W - box.l - box.r - 20);
  const py = (v) => H - box.b - ((v - ticks.min) / (ticks.max - ticks.min || 1)) * (H - box.t - box.b);
  const points = series.y.map((v, i) => (finite(v) ? [px(xs[i]), py(v)] : null));
  const line = points.filter(Boolean).map((p) => `${n1(p[0])},${n1(p[1])}`).join(' ');
  const band = series.lo && series.hi && series.lo.every(finite) && series.hi.every(finite)
    ? [...xs.map((x, i) => `${n1(px(x))},${n1(py(series.hi[i]))}`), ...xs.map((x, i) => `${n1(px(x))},${n1(py(series.lo[i]))}`).reverse()].join(' ')
    : '';
  const step = Math.ceil(xs.length / 8);
  const grid = ticks.ticks.map((t) => html`<line x1="${box.l}" x2="${W - box.r}" y1="${n1(py(t))}" y2="${n1(py(t))}" stroke="#d8dee6" stroke-width="1"/>
<text x="${box.l - 8}" y="${n1(py(t) + 4)}" text-anchor="end" font-size="11" fill="#566273">${yText(t)}</text>`);
  const labels = xs.map((x, i) => (i % step === 0 ? html`<text x="${n1(px(x))}" y="${H - box.b + 16}" text-anchor="middle" font-size="11" fill="#566273">${xText(x)}</text>` : null));
  const now = finite(current) && current >= xMin && current <= xMax
    ? html`<line x1="${n1(px(current))}" x2="${n1(px(current))}" y1="${box.t}" y2="${H - box.b}" stroke="#566273" stroke-dasharray="4 3"/><text x="${n1(px(current))}" y="${box.t - 6}" text-anchor="middle" font-size="11" fill="#566273">now</text>`
    : null;
  const dots = points.map((p, i) => (p ? html`<circle cx="${n1(p[0])}" cy="${n1(p[1])}" r="${i === series.bestIndex ? 6 : 3.5}" fill="${i === series.bestIndex ? '#1f7a45' : '#2f6fe0'}" stroke="#fff" stroke-width="1.5"/>` : null));
  return html`<svg class="chart" role="img" aria-label="${title}" viewBox="0 0 ${W} ${H}" width="100%" ${raw(SVG_FONT)}><title>${title}</title>${grid}${now}
${band ? html`<polygon points="${band}" fill="#2f6fe0" fill-opacity="0.14"/>` : null}
<polyline points="${line}" fill="none" stroke="#2f6fe0" stroke-width="2"/>${dots}
<text x="${(box.l + W - box.r) / 2}" y="${H - 8}" text-anchor="middle" font-size="11.5" fill="#1b2430">${xLabel}</text>
<text x="${box.l}" y="12" font-size="11.5" fill="#1b2430">${yLabel}</text></svg>`;
}

// =================================================================================================
// Document pieces
// =================================================================================================

const CSS = `
:root { --ink: #1b2430; --dim: #566273; --line: #d8dee6; --soft: #f4f6f9; --accent: #2f6fe0; --good: #1f7a45; --good-bg: #e6f4ec; --bad: #b3261e; --bad-bg: #fdecea; --warn: #8a5a00; --warn-bg: #fff4dc; --info: #1f4f9e; --info-bg: #e8f0fd; color-scheme: light; }
* { box-sizing: border-box; }
html { font: 10.5pt/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--ink); background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { max-width: 190mm; margin: 0 auto; padding: 12mm 6mm 16mm; }
@page { size: A4; margin: 14mm 12mm; }
h1 { margin: 2px 0 4px; font-size: 22pt; line-height: 1.15; }
h2 { margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--ink); font-size: 13pt; break-after: avoid; }
h3 { margin: 16px 0 6px; font-size: 11pt; break-after: avoid; }
p { margin: 6px 0; }
.brand { display: flex; justify-content: space-between; align-items: baseline; color: var(--dim); font-size: 9.5pt; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.brand strong { color: var(--accent); font-size: 11pt; letter-spacing: .02em; }
.sub { margin: 0 0 6px; color: var(--dim); }
.tw { overflow-x: auto; margin: 6px 0 10px; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
th, td { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { background: var(--soft); font-weight: 600; color: var(--dim); }
thead { display: table-header-group; }
tr { break-inside: avoid; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.best { background: var(--good-bg); color: var(--good); font-weight: 600; }
td.worst { background: var(--bad-bg); color: var(--bad); font-weight: 600; }
.delta { display: block; font-size: 8.5pt; font-weight: 600; color: var(--dim); }
.delta.good { color: var(--good); } .delta.bad { color: var(--bad); }
.range { display: block; font-size: 8.5pt; font-weight: 400; color: var(--dim); }
.unit { display: block; color: var(--dim); font-size: 8.5pt; font-weight: 400; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 0 18px; margin: 6px 0; }
.kv dt { padding: 3px 0; color: var(--dim); border-bottom: 1px solid var(--line); }
.kv dd { margin: 0; padding: 3px 0; border-bottom: 1px solid var(--line); }
.params { margin: 0; padding: 0; list-style: none; }
.params li { padding: 1px 0; }
.params span { color: var(--dim); }
.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0; }
.tile { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; break-inside: avoid; }
.tile b { display: block; font-size: 16pt; line-height: 1.2; font-variant-numeric: tabular-nums; }
.tile span { color: var(--dim); font-size: 9pt; }
.note { margin: 8px 0; padding: 8px 10px; border-radius: 6px; background: var(--info-bg); color: var(--info); break-inside: avoid; }
.note.warn { background: var(--warn-bg); color: var(--warn); }
.note.bad { background: var(--bad-bg); color: var(--bad); }
.note.good { background: var(--good-bg); color: var(--good); }
.headline { margin: 8px 0; font-size: 12pt; font-weight: 600; }
.chip { display: inline-block; margin-right: 6px; padding: 0 7px; border-radius: 99px; font-size: 8.5pt; font-weight: 600; background: var(--soft); color: var(--dim); white-space: nowrap; }
.chip.critical, .chip.error { background: var(--bad-bg); color: var(--bad); }
.chip.warning { background: var(--warn-bg); color: var(--warn); }
.chip.info { background: var(--info-bg); color: var(--info); }
.chip.good { background: var(--good-bg); color: var(--good); }
.list { margin: 6px 0; padding: 0; list-style: none; }
.list li { padding: 6px 0; border-bottom: 1px solid var(--line); break-inside: avoid; }
.list .detail, .list .hint { display: block; color: var(--dim); }
figure { margin: 8px 0; break-inside: avoid; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; }
figcaption { margin-top: 4px; color: var(--dim); font-size: 9pt; }
.chart { display: block; max-width: 560px; height: auto; margin: 6px 0; break-inside: avoid; }
.small { color: var(--dim); font-size: 9pt; }
footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid var(--line); color: var(--dim); font-size: 9pt; display: flex; justify-content: space-between; gap: 12px; }
@media print { body { max-width: none; padding: 0; } .tw { overflow: visible; } h2 { margin-top: 18px; } }
@media (max-width: 640px) { .tiles { grid-template-columns: repeat(2, 1fr); } body { padding: 8mm 4mm; } table { min-width: 480px; } }
`;

/** A table. `head` = strings or { text, num }; `rows` = arrays of cells (string, Safe, or { v, num, cls }). */
function table(head, rows, { cls = '' } = {}) {
  const th = (c) => (typeof c === 'object' && !(c instanceof Safe) ? html`<th scope="col"${c.num ? raw(' class="num"') : ''}>${c.text}</th>` : html`<th scope="col">${c}</th>`);
  const td = (c) => {
    if (c && typeof c === 'object' && !(c instanceof Safe) && !Array.isArray(c)) return html`<td class="${[c.num ? 'num' : '', c.cls || ''].filter(Boolean).join(' ')}">${c.v}</td>`;
    return html`<td>${c}</td>`;
  };
  return html`<div class="tw"><table class="${cls}"><thead><tr>${head.map(th)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map(td)}</tr>`)}</tbody></table></div>`;
}

const kv = (pairs) => html`<dl class="kv">${pairs.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
const params = (pairs) => (pairs.length ? html`<ul class="params">${pairs.map(([k, v]) => html`<li><span>${k}:</span> ${v}</li>`)}</ul>` : html`<span class="small">No parameters</span>`);
const note = (text, kind = '') => html`<p class="note ${kind}">${text}</p>`;
const section = (title, ...body) => html`<h2>${title}</h2>${body}`;

/** The layout picture of a context, '' if none. See the file header for what is in it. */
export function layoutPicture(ctx, { scale = 1, theme } = {}) {
  const renderer = ctx.renderer;
  if (!renderer || typeof renderer.toDataURL !== 'function') return '';
  const heat = ctx.store.getState().ui?.overlays?.heat;
  const attached = renderer.sim;
  if (!heat || heat === 'off') renderer.sim = null;
  try {
    return renderer.toDataURL({ scale, theme });
  } finally {
    renderer.sim = attached;
  }
}

/** The picture in the report is at most this many pixels wide or high: a 320 m plant at 20 px/m would add a 16 MB picture to the file. */
const REPORT_PICTURE_MAX_PX = 2400;
const PIXELS_PER_METRE_AT_SCALE_1 = 20; // renderer.toDataURL

function pictureSection(ctx, layout) {
  const longestSide = Math.max(layout.grid.cols, layout.grid.rows) * layout.grid.cellSize * PIXELS_PER_METRE_AT_SCALE_1;
  const url = layoutPicture(ctx, { scale: Math.min(1, REPORT_PICTURE_MAX_PX / longestSide), theme: 'light' });
  if (!pngBytes(url)) return null;
  const { ui } = ctx.store.getState();
  const heat = ui?.overlays?.heat;
  const name = plantName(ctx.store.getState());
  const caption = `Layout of ${name}, ${layout.grid.cols * layout.grid.cellSize} × ${layout.grid.rows * layout.grid.cellSize} m${heat && heat !== 'off' ? ', with the traffic heatmap of the simulation' : ''}.`;
  return html`<figure><img alt="${`Layout of ${name}`}" src="${raw(url)}"><figcaption>${caption}</figcaption></figure>`;
}

// ---- results of the running simulation -------------------------------------------------------

const pct = (v) => (finite(v) ? formatPercent(v) : NONE);
const dur = (v) => (finite(v) ? formatDuration(v) : NONE);

function stationDetail(s) {
  if (s.type === 'process') return `input queue ${formatNumber(s.avgIn, 1)} on average, ${formatNumber(s.maxIn)} at most`;
  if (s.type === 'storage') return `${pct(s.avgFill)} full on average, ${pct(s.maxFill)} at most`;
  if (s.type === 'source') return `backlog up to ${count(s.yardMax, 'load', 'loads')}, ${formatNumber(s.arrivals)} arrived`;
  if (s.type === 'sink') return `${formatNumber(s.consumed)} received`;
  return NONE;
}

function stationResultRows(report) {
  return Object.values(report.stations || {}).map((s) => [
    s.name, stationTypeName(s.type), { v: pct(s.utilization), num: true }, { v: pct(s.starved), num: true }, { v: pct(s.blocked), num: true }, { v: pct(s.down), num: true }, stationDetail(s)]);
}

function fleetResultRows(report) {
  return Object.values(report.fleets || {}).map((f) => {
    const sh = f.shares || {};
    return [f.name, { v: formatNumber(f.count), num: true }, { v: pct(f.utilization), num: true }, { v: pct(sh.driving), num: true }, { v: pct(sh.waiting), num: true },
      { v: pct((sh.loading || 0) + (sh.unloading || 0)), num: true }, { v: pct((sh.idle || 0) + (sh.parked || 0)), num: true }, { v: pct((sh.charging || 0) + (sh.broken || 0)), num: true },
      { v: finite(f.tripsPerVehicleHour) ? formatNumber(f.tripsPerVehicleHour, 1) : NONE, num: true }, { v: pct(f.emptyShare), num: true }];
  });
}

function flowResultRows(report, layout) {
  const name = (id) => getStation(layout, id)?.name || report.stations?.[id]?.name || 'Unknown station';
  return Object.values(report.flows || {}).map((f) => {
    const backlog = f.avgBacklog ?? f.backlog;
    return [`${name(f.from)} → ${name(f.to)}`, { v: formatNumber(f.delivered), num: true }, { v: dur(f.avgPickupWait), num: true }, { v: dur(f.avgTransit), num: true },
      { v: finite(backlog) ? formatNumber(backlog, 1) : NONE, num: true }];
  });
}

/** Headline tiles of a KPI report: [label, value, small text]. */
export function kpiTiles(report) {
  const m = summarizeReport(report);
  const lead = (v) => (finite(v) ? formatDuration(v) : NONE);
  return [
    ['Throughput', finite(m.throughput) ? `${formatNumber(m.throughput, 1)} loads/h` : NONE, `${formatNumber(report.throughput?.total ?? 0)} loads delivered`],
    ['Mean lead time', lead(m.leadMean), 'from goods in to goods out'],
    ['Lead time, 95th percentile', lead(m.leadP95), '19 of 20 loads were faster'],
    ['Work in process', finite(m.wip) ? `${formatNumber(m.wip, 1)} loads` : NONE, `at most ${formatNumber(report.wip?.max ?? 0)} loads`],
    ['Fleet utilization', finite(m.fleetUtilization) ? `${formatNumber(m.fleetUtilization)} %` : NONE, 'share of time vehicles work'],
    ['Vehicle waiting', finite(m.waitShare) ? `${formatNumber(m.waitShare, 1)} %` : NONE, `${formatNumber(report.traffic?.deadlocks ?? 0)} deadlocks`],
  ];
}

function resultsSection(ctx, layout) {
  const sim = ctx.runner?.sim;
  const report = sim && typeof ctx.runner.kpis === 'function' ? ctx.runner.kpis() : null;
  if (!report) {
    return section('Results of the simulation', note('No simulation has run in this session yet, so there are no results to report. Press play on the simulation, let it run for a while and create the report again.', 'warn'));
  }
  const status = measurementNote(report);
  return section('Results of the simulation',
    note(status.text, status.level === 'ok' ? 'good' : status.level === 'indicative' ? '' : 'warn'),
    html`<div class="tiles">${kpiTiles(report).map(([label, value, small]) => html`<div class="tile"><span>${label}</span><b>${value}</b><span>${small}</span></div>`)}</div>`,
    html`<h3>Workstations and stations</h3>`,
    table(['Station', 'Type', { text: 'Busy', num: true }, { text: 'Waiting for input', num: true }, { text: 'Blocked', num: true }, { text: 'Down', num: true }, 'Queue and buffer'], stationResultRows(report)),
    html`<h3>Vehicle fleets</h3>`,
    table(['Fleet', { text: 'Vehicles', num: true }, { text: 'Working', num: true }, { text: 'Driving', num: true }, { text: 'Waiting in traffic', num: true }, { text: 'Loading / unloading', num: true },
      { text: 'Idle / parked', num: true }, { text: 'Charging / broken', num: true }, { text: 'Trips per vehicle and hour', num: true }, { text: 'Empty driving', num: true }], fleetResultRows(report)),
    flowResultRows(report, layout).length ? html`<h3>Material flows</h3>${table(['Flow', { text: 'Delivered', num: true }, { text: 'Load waits for a vehicle', num: true }, { text: 'Transport time', num: true }, { text: 'Loads waiting (average)', num: true }], flowResultRows(report, layout))}` : null,
    doorResultRows(report, layout).length ? html`<h3>Dock doors</h3>${table(['Station', { text: 'Doors', num: true }, { text: 'Trucks served', num: true }, { text: 'Gate wait', num: true }, { text: 'Door time', num: true }, { text: 'Doors busy', num: true }, { text: 'Gate queue (average)', num: true }, { text: 'Left short', num: true }], doorResultRows(report, layout))}<p class="small">Door time includes waiting for a free forklift. The lead time of loads from a Goods in with trucks includes the wait of their truck at the gate.</p>` : null);
}

const SEVERITY_NAME = { critical: 'Critical', warning: 'Warning', info: 'Note', good: 'Good', error: 'Error' };

function insightsSection(ctx) {
  const list = ctx.runner?.sim && typeof ctx.runner.insights === 'function' ? ctx.runner.insights() : null;
  if (!list || !list.length) return null;
  return section('Insights', html`<ul class="list">${list.map((i) => html`<li><span class="chip ${i.severity}">${SEVERITY_NAME[i.severity] || i.severity}</span><b>${i.title}</b>
${i.detail ? html`<span class="detail">${i.detail}</span>` : null}${i.suggestion ? html`<span class="hint">Suggestion: ${i.suggestion}</span>` : null}</li>`)}</ul>`);
}

// ---- comparison and sweep ---------------------------------------------------------------------

const deltaCell = (d) => (d ? html`<span class="delta ${d.tone === 'neutral' ? '' : d.tone}">${d.text}</span>` : null);

function comparisonHtml(result, state) {
  const model = buildComparison(result);
  const stale = resultStaleness(result, state);
  const head = ['Measure', ...model.variants.map((v) => ({ text: v.label, num: true }))];
  const rows = model.rows.map((row) => [
    html`${row.metric.label}${row.scale.unit ? html`<span class="unit">${row.scale.unit}</span>` : null}`,
    ...row.cells.map((c) => ({ num: true, cls: c.best ? 'best' : c.worst ? 'worst' : '', v: html`${c.best ? '✓ ' : c.worst ? '! ' : ''}${c.text}${deltaCell(c.delta)}${c.range ? html`<span class="range">${c.range}</span>` : null}` })),
  ]);
  const first = model.rows.find((r) => r.metric.id === 'throughput') || model.rows[0];
  const text = headline(result.variants);
  const s = result.settings;
  return [
    html`<h3>Comparison of variants</h3>`,
    stale ? note(`${stale.text} The figures below describe the plant as it was when the comparison ran.`, 'warn') : null,
    text ? html`<p class="headline">${text}</p>` : null,
    html`<p class="small">${model.variants.length} variants, ${s.replications} ${s.replications === 1 ? 'run' : 'runs'} of ${formatDuration(s.duration)} each, the first ${formatDuration(s.warmup)} not measured. Run at ${shortTime(new Date(result.at))}.</p>`,
    table(head, rows),
    html`<p class="small">${model.repetitions > 1 ? 'The small figure under a value is the lowest to highest result over the repetitions. ' : ''}✓ marks the best and ! the worst variant of a row; differences below 1 % are not marked. The change is against the first variant.</p>`,
    first ? svgBars(first.cells.map((c, i) => ({ label: model.variants[i].label, value: c.mean === null ? null : c.mean * first.scale.factor, mark: c.best ? 'best' : c.worst ? 'worst' : null })),
      { unit: first.scale.unit, digits: first.scale.digits, title: `${first.metric.label} by variant` }) : null,
  ];
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the marks of the sweep picture mean. */
function sweepLegend(result, series) {
  return [series.bestIndex >= 0 ? 'Large green dot: the best value.' : '', 'Dashed line: the value in use now.', series.lo ? 'Shaded band: lowest to highest result over the repetitions.' : ''].filter(Boolean).join(' ');
}

function sweepHtml(result, state, metricId = 'throughput') {
  const now = result.scenarioId === state.project.activeId ? result.param.get?.(state.layout) : null;
  const model = buildSweep(result, metricId, finite(now) ? now : null);
  const stale = resultStaleness(result, state);
  const series = sweepSeries(result, model);
  const s = result.settings;
  const unit = result.param.unit && !['vehicles', 'machines', 'loads'].includes(result.param.unit) ? ` (${result.param.unit})` : '';
  const rows = model.rows.map((row) => [
    html`${row.valueText}${row.current ? html` <span class="chip">in use</span>` : null}`,
    { num: true, cls: row.best ? 'best' : '', v: html`${row.best ? '✓ ' : ''}${row.text}${deltaCell(row.delta)}${row.range ? html`<span class="range">${row.range}</span>` : null}` },
  ]);
  return [
    html`<h3>Parameter sweep: ${result.param.label}</h3>`,
    stale ? note(`${stale.text} The figures below describe the plant as it was when the sweep ran.`, 'warn') : null,
    html`<p class="headline">${model.recommendation.text}</p>`,
    html`<p class="small">${result.points.length} values, ${s.replications} ${s.replications === 1 ? 'run' : 'runs'} of ${formatDuration(s.duration)} each, the first ${formatDuration(s.warmup)} not measured.${result.partial && result.points.length < result.values.length ? ' The sweep was stopped early.' : ''}</p>`,
    result.points.length >= 2 ? svgLine(series, {
      xLabel: `${result.param.label}${unit}`, yLabel: model.scale.unit ? `${model.metric.label} (${model.scale.unit})` : model.metric.label,
      xText: (v) => formatParamValue(v, result.param.unit, { short: true }), yText: (v) => formatNumber(v, model.scale.digits), current: model.current,
      title: `${model.metric.label} over ${result.param.label}`,
    }) : null,
    html`<p class="small">${sweepLegend(result, series)}</p>`,
    table([capitalize(result.param.label.split(': ').pop()), { text: model.scale.unit ? `${model.metric.label} (${model.scale.unit})` : model.metric.label, num: true }], rows),
  ];
}

function comparisonSection(ctx, results) {
  if (!results) return null;
  const { compare, sweep } = results;
  if (!compare && !sweep) return null;
  const state = ctx.store.getState();
  return section('Experiments', compare ? comparisonHtml(compare, state) : null, sweep ? sweepHtml(sweep, state) : null);
}

// ---- assumptions and checks --------------------------------------------------------------------

function assumptionsSection(layout) {
  const stations = layout.stations.map((s) => [html`<b>${s.name}</b>`, stationTypeName(s.type), `${formatNumber(s.w * layout.grid.cellSize, 1)} × ${formatNumber(s.h * layout.grid.cellSize, 1)} m`, params([...stationParams(s), ...(doorCheckRow(s, layout) ? [doorCheckRow(s, layout)] : [])])]);
  const flows = layout.flows.map((f) => flowCells(f, layout));
  const fleets = layout.fleets.map((f) => [html`<b>${f.name}</b>`, { v: formatNumber(f.count), num: true }, params(fleetParams(f, layout))]);
  return section('Assumptions',
    html`<h3>Stations</h3>`, stations.length ? table(['Name', 'Type', 'Size', 'Parameters'], stations) : html`<p class="small">The plant has no stations.</p>`,
    html`<h3>Material flows</h3>`, flows.length
      ? table(['From', 'To', { text: 'Share of output', num: true }, { text: 'Loads per cycle', num: true }, 'Batch', { text: 'Longest wait', num: true }, 'Priority', 'Vehicles'], flows.map((r) => r.map((c, j) => (j === 2 || j === 3 || j === 5 ? { v: c, num: true } : c))))
      : html`<p class="small">No material flows are defined.</p>`,
    html`<h3>Vehicle fleets</h3>`, fleets.length ? table(['Name', { text: 'Vehicles', num: true }, 'Parameters'], fleets) : html`<p class="small">The plant has no vehicles.</p>`,
    html`<h3>Simulation settings</h3>`, kv(settingsRows(layout.settings)));
}

function checksSection(ctx) {
  const issues = typeof ctx.issues === 'function' ? ctx.issues() : [];
  if (!issues.length) return section('Checks', note('No problems were found in the plant.', 'good'));
  return section('Checks', html`<ul class="list">${issues.map((i) => html`<li><span class="chip ${i.severity}">${SEVERITY_NAME[i.severity] || i.severity}</span>${i.message}${i.hint ? html`<span class="hint">${i.hint}</span>` : null}</li>`)}</ul>`);
}

// =================================================================================================
// The report
// =================================================================================================

/**
 * The report as a complete HTML document.
 * @param {object} ctx shared context (store, runner, renderer, issues)
 * @param {{ includeComparison?: boolean, results?: { compare: object|null, sweep: object|null }, now?: Date, build?: object }} [opts]
 *   `includeComparison` (default true) adds the latest comparison / sweep from the Experiments tab when there is one; `results`
 *   replaces getLastResults() as the source (same shape); `build` is the identity named in the footer (default: js/build-info.js)
 * @returns {string}
 */
export function exportReportHtml(ctx, { includeComparison = true, results = null, now = new Date(), build = BUILD } = {}) {
  const state = ctx.store.getState();
  const layout = state.layout;
  const scenarios = state.project.scenarios;
  const variant = scenarios.length > 1 ? scenarios.find((s) => s.id === state.project.activeId) : null;
  const title = `${plantName(state)} – LogiPlan report`;
  const body = html`<div class="brand"><strong>LogiPlan</strong><span>Plant report · ${longDate(now)}</span></div>
<h1>${plantName(state)}</h1>
${variant ? html`<p class="sub">Variant ${variant.name}</p>` : ''}
${section('Plant', pictureSection(ctx, layout), kv(plantRows(layout)), layout.notes ? html`<h3>Notes</h3><p>${layout.notes}</p>` : null)}
${resultsSection(ctx, layout)}
${insightsSection(ctx)}
${comparisonSection(ctx, includeComparison ? (results || getLastResults()) : null)}
${assumptionsSection(layout)}
${checksSection(ctx)}
<footer><span>Generated with LogiPlan ${buildSummary(build)}</span><span>${longDate(now)}, ${shortTime(now)}</span></footer>`;
  return `<!doctype html>\n${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light">
<title>${title}</title><style>${raw(CSS)}</style></head><body>${body}</body></html>`}`;
}

// =================================================================================================
// Browser: download, print, PNG, JSON
// =================================================================================================

const failure = (ctx, message) => ctx.toast?.(message, { kind: 'error' });

/**
 * Save the report as an .html file.
 * @returns {string|null} the file name, or null when the report could not be created
 */
export function downloadReport(ctx, opts = {}) {
  try {
    const now = opts.now || new Date();
    const name = reportFileName(plantName(ctx.store.getState()), now);
    downloadFile(name, exportReportHtml(ctx, { ...opts, now }), 'text/html');
    ctx.toast?.(`Report saved as ${name}. Open it in a browser and use Print to get a PDF.`, { kind: 'success' });
    return name;
  } catch (err) {
    failure(ctx, `The report could not be created: ${err.message}`);
    return null;
  }
}

/** Resolve once every picture of a document is decoded (the printed page must not miss the layout picture); never rejects. */
function picturesReady(doc) {
  return Promise.all([...doc.images].map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
}

/**
 * Open the report in a new window and print it (the print dialog offers "Save as PDF"). A blocked window falls back to a download.
 * @returns {boolean} true when the window opened
 */
export function printReport(ctx, opts = {}) {
  const win = window.open('', '_blank');
  if (!win) {
    downloadReport(ctx, opts);
    ctx.toast?.('Your browser blocked the print window, so the report was downloaded instead. Open the file and press Ctrl+P.', { kind: 'warn' });
    return false;
  }
  try {
    win.document.open();
    win.document.write(exportReportHtml(ctx, opts));
    win.document.close();
    picturesReady(win.document).then(() => { win.focus(); win.print(); });
    return true;
  } catch (err) {
    win.close();
    failure(ctx, `The report could not be created: ${err.message}`);
    return false;
  }
}

/**
 * Save the whole plant as a PNG (no camera, no editing aids; 2x resolution by default).
 * @returns {boolean} false when the browser could not create the picture
 */
export function exportLayoutPng(ctx, { scale = 2 } = {}) {
  const bytes = pngBytes(layoutPicture(ctx, { scale }));
  if (!bytes) {
    failure(ctx, 'The picture could not be created in this browser.');
    return false;
  }
  downloadFile(`${slug(plantName(ctx.store.getState()))}-layout.png`, new Blob([bytes], { type: 'image/png' }), 'image/png');
  return true;
}

/**
 * Save the project (every variant) as a LogiPlan JSON file that can be opened again.
 * @returns {boolean}
 */
export function exportLayoutJson(ctx) {
  try {
    const project = ctx.store.getState().project;
    downloadFile(`${slug(project.name, 'logiplan-project')}.logiplan.json`, exportProject(project), 'application/json');
    return true;
  } catch (err) {
    failure(ctx, `The project could not be saved: ${err.message}`);
    return false;
  }
}
