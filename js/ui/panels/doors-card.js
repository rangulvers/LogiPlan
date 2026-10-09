// The Doors card of the Results tab (docs/WAREHOUSE-DESIGN.md 7.2 "Dashboard"): one card per Goods in or Goods out that has trucks, hidden when the plant has none.
//
//   const doors = createDoorsSection(ctx);     // doors.el (a collapsible section), doors.update(report, state), doors.destroy()
//   doorModels(report, layout)                 pure: what the cards show
//
// A card shows the doors, the trucks served, the gate wait (mean and 90th percentile), the door time, the door utilisation, the gate queue now and at its worst, a
// sparkline of the gate queue and, for a Goods out, the trucks that left short. The figures come from `report.ops.trucks[stationId]` (docs 6.8):
//   { name, role: 'in'|'out', doors, trucks: { arrived, docked, departed, short, noShow, turnedAway }, gateWait: { mean, p90, max }, doorTime: { mean, p90 },
//     turnaround: { mean, p90 }, doorUtilization (0..1), gateQueue: { mean, max, now }, doorsBusyNow, fillRate (0..1, Goods out), gateQueueSeries }
// and every field may be absent: a report without `ops` (the simulation does not produce truck figures, or nothing has run yet) shows the configuration and dashes, and says
// so; nothing throws. `gateQueueSeries` is read as a list of numbers, of [time, value] pairs, of { t, v } objects, or { t: [...], v | values: [...] }.
//
// Door time is the time a truck holds a door (check-in, the unloading by vehicles, check-out), which includes the wait for a free forklift: more forklifts shorten it.
// The lead time of loads from a Goods in with trucks includes the wait of their truck at the gate (R17), which the card says.
// The card is built once per station and then only patched in place, like the rest of the dashboard.

import { h } from '../../util/dom.js';
import { formatDuration, formatNumber } from '../../util/format.js';
import { createSparkline } from '../charts.js';
import { icon } from '../icons.js';
import { trucksOf } from '../../model/ops.js';
import { GATE_AMBER_SECONDS, GATE_RED_SECONDS } from '../render/ops.js';
import { addStyles } from '../ops-styles.js';
import { doorCheckFor, doorFormula } from './ops-trucks.js';

const DASH = '–';
/** Door utilisation from which the bar turns orange (the same 85 % the insight `doors-bottleneck` and "Use N doors" use). */
export const DOOR_BUSY_SHARE = 0.85;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rec = (v) => (isObj(v) ? v : {});
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dur = (v) => { const n = fin(v); return n === null || n < 0 ? DASH : formatDuration(n); };
const whole = (v) => { const n = fin(v); return n === null ? DASH : formatNumber(n, 0); };
const pct = (v) => { const n = fin(v); return n === null ? DASH : `${formatNumber(Math.min(1, Math.max(0, n)) * 100, 0)} %`; };
const plural = (n, one, many) => `${formatNumber(n, 0)} ${n === 1 ? one : many}`;

/** The gate queue series as a list of numbers (see the header), at most `limit` points (the newest). */
export function seriesValues(raw, limit = 240) {
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (isObj(raw)) list = Array.isArray(raw.v) ? raw.v : Array.isArray(raw.values) ? raw.values : null;
  if (!list) return [];
  const out = [];
  for (const item of list) {
    const v = Array.isArray(item) ? item[1] : isObj(item) ? (item.v ?? item.value) : item;
    const n = fin(v);
    if (n !== null) out.push(n);
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** 'neutral' | 'warn' | 'bad' for a wait at the gate (s), by the thresholds of the gate chip on the plan. */
export function waitTone(seconds) {
  const n = fin(seconds);
  if (n === null) return 'neutral';
  return n >= GATE_RED_SECONDS ? 'bad' : n >= GATE_AMBER_SECONDS ? 'warn' : 'neutral';
}

/**
 * The line under "Trucks served": how many trucks arrived, but only when that is more than were served (the others are still at the gate or a door). A truck that
 * was already at a door when the warm-up ended is served in the window without having arrived in it, and "7 served, 6 arrived" reads like a mistake.
 * Trucks that were turned away at a full gate or did not come at all are said, because they are the trucks that are neither served nor waiting.
 */
function servedNote(t, arrived, departed) {
  const parts = [];
  if (arrived !== null && (departed === null || arrived >= departed)) parts.push(`${whole(arrived)} arrived`);
  const away = fin(t.turnedAway);
  const missed = fin(t.noShow);
  if (away !== null && away > 0) parts.push(`${whole(away)} turned away`);
  if (missed !== null && missed > 0) parts.push(`${whole(missed)} did not come`);
  return parts.join(', ');
}

/**
 * What the card of one station shows.
 * @param {object} station layout station with trucks
 * @param {object} trucks its `ops.trucks` block
 * @param {object|null} entry `report.ops.trucks[station.id]` or null
 * @param {object} layout
 * @param {object|null} report
 */
export function doorModel(station, trucks, entry, layout, report = null) {
  const e = rec(entry);
  const outbound = station.type === 'sink';
  const t = rec(e.trucks);
  const queue = rec(e.gateQueue);
  const wait = rec(e.gateWait);
  const doorTime = rec(e.doorTime);
  const has = Boolean(entry);
  const departed = fin(t.departed);
  const arrived = fin(t.arrived);
  const util = fin(e.doorUtilization);
  const metrics = [
    { key: 'served', label: 'Trucks served', value: whole(departed), sub: servedNote(t, arrived, departed), tone: 'neutral', hint: 'Trucks that finished at a door and left, since the warm-up ended.' },
    { key: 'gateWait', label: 'Gate wait', value: fin(wait.mean) !== null && wait.mean < 1 ? '0 s' : dur(wait.mean), sub: fin(wait.p90) !== null && wait.p90 >= 1 ? `9 in 10 under ${dur(wait.p90)}` : '', tone: waitTone(wait.mean), hint: 'How long a truck waited at the gate for a free door.' },
    { key: 'doorTime', label: 'Door time', value: dur(doorTime.mean), sub: fin(doorTime.p90) !== null ? `9 in 10 under ${dur(doorTime.p90)}` : '', tone: 'neutral', hint: 'How long a truck held a door: check-in, the work of the vehicles, check-out. It includes waiting for a free forklift, so more forklifts shorten it.' },
    { key: 'queue', label: 'Gate queue now', value: whole(queue.now), sub: fin(queue.max) !== null ? `most ${whole(queue.max)}` : '', tone: 'neutral', hint: 'Trucks waiting at the gate now, and the most at any moment.' },
  ];
  if (outbound) {
    const short = fin(t.short);
    const left = departed !== null ? departed : null;
    metrics.push({
      key: 'short', label: 'Left short', value: short !== null && left !== null ? `${whole(short)} of ${whole(left)}` : DASH,
      sub: fin(e.fillRate) !== null ? `${pct(e.fillRate)} of the pallets` : '', tone: short !== null && left > 0 && short / left >= 0.1 ? 'warn' : 'neutral',
      hint: 'Trucks that left without a full load, because their pallets did not arrive in time. The share of planned pallets that were loaded is below.',
    });
  }
  const check = doorCheckFor(layout, station, report);
  const formula = check && !check.empty ? doorFormula(check) : '';
  const doors = fin(e.doors) !== null ? e.doors : trucks.doors;
  const busyNow = fin(e.doorsBusyNow);
  return {
    id: station.id,
    name: typeof e.name === 'string' && e.name ? e.name : station.name,
    outbound,
    role: outbound ? 'Goods out' : 'Goods in',
    doors,
    busyNow,
    has,
    metrics,
    util,
    utilText: pct(util),
    busy: util !== null && util >= DOOR_BUSY_SHARE,
    series: seriesValues(e.gateQueueSeries),
    formula,
    note: has ? '' : 'The simulation reports no truck figures for this station yet. They appear while it runs.',
    aria: `Doors of ${station.name}: ${plural(doors, 'door', 'doors')}${util !== null ? `, busy ${pct(util)} of the time` : ''}${departed !== null ? `, ${plural(departed, 'truck', 'trucks')} served` : ''}`,
  };
}

/** One model per Goods in or Goods out that has trucks, in plant order. [] for a plant without trucks (the section is then hidden). */
export function doorModels(report, layout) {
  const ops = report && report.ops && isObj(report.ops.trucks) ? report.ops.trucks : null;
  const out = [];
  for (const station of Array.isArray(layout && layout.stations) ? layout.stations : []) {
    const trucks = trucksOf(station);
    if (trucks) out.push(doorModel(station, trucks, ops && isObj(ops[station.id]) ? ops[station.id] : null, layout, report));
  }
  return out;
}

const CSS = `
.doors-list{display:flex;flex-direction:column;gap:var(--sp-2);margin:0;padding:0;list-style:none}
.doorcard{display:flex;flex-direction:column;gap:var(--sp-2);padding:var(--sp-3)}
.doorcard__head{display:flex;align-items:center;gap:var(--sp-2);min-width:0}
.doorcard__head .dash-link{font-weight:var(--fw-semibold);font-size:var(--fs-md)}
.doorcard__metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:var(--sp-2) var(--sp-3);margin:0}
.doorcard__metrics>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.doorcard__metrics dt{color:var(--text-dim);font-size:var(--fs-xs);line-height:1.3}
.doorcard__metrics dd{display:flex;flex-direction:column;margin:0;font-size:var(--fs-md);font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums}
.doorcard__metrics dd small{font-size:var(--fs-xs);font-weight:var(--fw-regular);color:var(--text-dim)}
.doorcard__metrics .is-warn dd{color:var(--warn-text)}
.doorcard__metrics .is-bad dd{color:var(--bad-text)}
.doorcard__util{display:grid;grid-template-columns:auto minmax(48px,1fr) auto;align-items:center;gap:var(--sp-2);font-size:var(--fs-sm)}
.doorcard__util .progress{min-width:64px}
.doorcard__spark{display:flex;flex-direction:column;gap:2px}
.doorcard__spark .field__label{margin:0}
.doorcard__note{margin:0;font-size:var(--fs-xs);color:var(--text-dim);line-height:1.4}
`;

/** Patch text/attributes only when they changed. */
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
const setHidden = (el, v) => { if (el.hidden !== v) el.hidden = v; };

function createCard(ctx, m) {
  const link = h('button', {
    class: 'dash-link', type: 'button', title: 'Show this station on the plan and open its settings',
    onclick: () => { ctx.actions?.focus?.({ stationIds: [m.id] }); ctx.actions?.setRightTab?.('properties'); },
  });
  const chip = h('span', { class: 'chip chip--outline' });
  const busy = h('span', { class: 'text-dim tnum', role: 'status' });
  const metrics = h('dl', { class: 'doorcard__metrics' });
  const cells = new Map();
  for (const def of m.metrics) {
    const dd = h('dd');
    const sub = h('small');
    dd.append(h('span'), sub);
    const dt = h('dt', null, def.label);
    const el = h('div', { 'data-metric': def.key }, dt, dd);
    cells.set(def.key, { el, dt, value: dd.firstChild, sub });
    metrics.append(el);
  }
  const bar = h('div', { class: 'progress__bar tone-busy' });
  const track = h('div', { class: 'progress', role: 'img' }, bar);
  const utilValue = h('span', { class: 'tnum' });
  const util = h('div', { class: 'doorcard__util' }, h('span', { class: 'text-dim' }, 'Doors busy'), track, utilValue);
  const sparkHost = h('div');
  const spark = createSparkline({ values: [], color: '--series-2', unit: 'trucks', height: 32 });
  sparkHost.append(spark.el);
  const sparkBox = h('div', { class: 'doorcard__spark', hidden: true }, h('span', { class: 'field__label' }, 'Gate queue over time'), sparkHost);
  const formula = h('p', { class: 'doorcard__note tnum' });
  const note = h('p', { class: 'doorcard__note', hidden: true });
  const lead = h('p', { class: 'doorcard__note' }, m.outbound ? '' : 'The lead time of loads from this Goods in includes the wait of their truck at the gate.');
  const el = h('li', { class: 'card doorcard', 'data-door-station': m.id, role: 'group' },
    h('div', { class: 'doorcard__head' }, icon('truck', { size: 16 }), link, h('span', { class: 'spacer' }), chip),
    metrics, util, sparkBox, formula, note, m.outbound ? null : lead);
  return { el, link, chip, busy, cells, bar, track, utilValue, util, sparkBox, spark, sparkSig: '', formula, note };
}

function patchCard(card, m) {
  setText(card.link, m.name);
  card.el.setAttribute('aria-label', m.aria);
  setText(card.chip, `${m.role}, ${plural(m.doors, 'door', 'doors')}`);
  for (const def of m.metrics) {
    const c = card.cells.get(def.key);
    if (!c) continue;
    setText(c.value, def.value);
    setText(c.sub, def.sub);
    setHidden(c.sub, !def.sub);
    c.el.className = def.tone === 'warn' ? 'is-warn' : def.tone === 'bad' ? 'is-bad' : '';
    c.el.title = def.hint;
  }
  const has = m.util !== null;
  setHidden(card.util, !has);
  if (has) {
    card.bar.style.setProperty('--w', `${Math.round(Math.min(1, Math.max(0, m.util)) * 100)}%`);
    card.bar.className = `progress__bar ${m.busy ? 'tone-blocked' : 'tone-busy'}`;
    card.track.setAttribute('aria-label', `Doors busy ${m.utilText} of the time${m.busy ? ', nearly always in use' : ''}`);
    setText(card.utilValue, m.busyNow !== null ? `${m.utilText} · ${whole(m.busyNow)} now` : m.utilText);
  }
  const sig = `${m.series.length}:${m.series[m.series.length - 1]}:${m.series[0]}`;
  const queued = m.series.length >= 2 && m.series.some((v) => v > 0); // a flat line at zero says nothing the figures above do not
  setHidden(card.sparkBox, !queued);
  if (queued && sig !== card.sparkSig) {
    card.sparkSig = sig;
    card.spark.update({ values: m.series });
  }
  setText(card.formula, m.formula);
  setHidden(card.formula, !m.formula);
  setText(card.note, m.note);
  setHidden(card.note, !m.note);
}

/**
 * The section of the Results tab. `update(report, state)` is called with the report of the runner and the store state (the layout says which stations have trucks).
 * @returns {{ el: HTMLElement, update(report: object|null, state: object): void, destroy(): void }}
 */
export function createDoorsSection(ctx) {
  addStyles('ops-doors-card-styles', CSS);
  // A plant without trucks carries nothing of this in the DOM: the section is built the first time a station has trucks.
  const host = h('div', { class: 'doors-host', 'data-role': 'doors-host', hidden: true });
  let built = null;
  const cards = new Map();
  let signature = '';
  let last = [];

  function build() {
    const aside = h('span', { class: 'section__aside' });
    const list = h('ul', { class: 'doors-list' });
    const body = h('div', { class: 'dash-sec__body' }, list);
    const el = h('details', { class: 'dash-sec', open: true, 'data-section': 'doors' },
      h('summary', { class: 'section__header' }, icon('chevron-right', { size: 14, class: 'section__chevron' }), h('span', { class: 'dash-sec__title' }, 'Doors'), aside), body);
    el.addEventListener('toggle', () => paint()); // a section that was collapsed while the data moved on catches up when it is opened
    host.append(el);
    return { el, aside, list };
  }

  const paint = () => { if (built && built.el.open) for (const m of last) patchCard(cards.get(m.id), m); };

  return {
    el: host,
    update(report, state) {
      const models = doorModels(report, state && state.layout);
      last = models;
      setHidden(host, models.length === 0);
      if (models.length === 0) return;
      if (!built) built = build();
      setText(built.aside, String(models.length));
      const ids = models.map((m) => m.id).join(',');
      if (ids !== signature) {
        signature = ids;
        for (const [id, card] of cards) if (!models.some((m) => m.id === id)) { card.spark.destroy(); card.el.remove(); cards.delete(id); }
        for (const m of models) if (!cards.has(m.id)) cards.set(m.id, createCard(ctx, m));
        built.list.replaceChildren(...models.map((m) => cards.get(m.id).el));
      }
      paint();
    },
    destroy() {
      for (const card of cards.values()) card.spark.destroy();
      cards.clear();
      host.remove();
    },
  };
}
