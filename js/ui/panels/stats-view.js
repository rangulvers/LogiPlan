// The view of the Statistics dock (docs/ENTITY-INSIGHTS-DESIGN.md 2.3, 2.4, 4.2 and 9.1; MODEL part of S1): the DOM that stats-model.js's view-model is drawn into.
//
//   const view = createStatsView(host);   // host = { window(), setWindow(kind), state(), select(kind, ids), showOnPlan(rect), focusRoute(id | null, { pinned }), announce(text) }
//   view.el                               the root: a strip of six numbers (`dl.insight__strip`, six `.tile`) and the body (`.insight__body`, the blocks); the dock puts it
//                                         into its content (css/stats.css gives the root `display: contents`) and recreates the view when `model.signature` changes
//   view.update(model, { state, window }) draws the model IN PLACE: nodes are kept and only text, attributes and rows that changed are touched, so a focused trip row or an
//                                         open "how is this counted" survives the 4 Hz refresh. Rows of a list are kept by key.
//   view.escape()                         true when it used the Esc key (it unpinned a route); then the editor does not clear the selection
//   view.destroy()                        lets go of a hovered or pinned route
//
// Accessibility (S1.14, view part). The numbers are a `dl`; the stacked bar and the sparkline are `role="img"` with a generated sentence (the sparkline is a small SVG,
// not a canvas chart of charts.js, because that carries an `aria-live` region and there is NO `aria-live` anywhere in the dock); tables are real tables; every (i) is
// a button whose label is the counting rule and which also opens the rule in place (touch screens have no hover); a trip row is a BUTTON whose `aria-label` is the whole
// sentence ("1: Press line to Final assembly, 16 trips, 7.6 an hour, 54 m, 62 s each, ..."); hover AND focus draw the route on the plan (`host.focusRoute(id)`), Enter or a
// click pins it (`aria-pressed`), Esc unpins; reduced motion needs nothing here (no animation). Colour never carries a state alone: the dock's arrows, dashes and numbers do.
// On a coarse pointer the (i) buttons, the links and the disclosure get a 40 px touch area (padding and a negative margin, so the layout does not move).
//
// Only classes of css/stats.css and the kit are used. Two inline styles stand in for rules the stylesheet (the shell's) does not have: `text-align: left; width: 100%` on a
// trip row (a <button>), and the touch areas above.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { ROUND_FOCUS_ID, rampColor } from './stats-model.js';

const svg = (tag, attrs, ...children) => h(`svg:${tag}`, attrs, ...children);

// ---------------------------------------------------------------------------------------------------------
// Small helpers: change only what changed
// ---------------------------------------------------------------------------------------------------------

const setText = (el, text) => {
  const t = text === null || text === undefined ? '' : String(text);
  if (el.textContent !== t) el.textContent = t;
};
/**
 * A text made of short groups joined by " · " ("Dock 1 → Dock 1 65 % · Dock 2 → Dock 2 18 %"): a group of at most `max` characters stays on one line, so that a row breaks
 * between the groups and never inside one ("Dock 2 →" and "Dock 2 18 %" on two lines); longer groups wrap as text does.
 * The text content is the same string. The spans are kept between updates (only their text changes) unless the number of groups changes.
 */
const setGroups = (el, text, max) => {
  const t = text === null || text === undefined ? '' : String(text);
  const groups = t.includes(' · ') ? t.split(' · ') : null;
  if (groups === null) {
    if (el.__spans) { el.__spans = null; el.textContent = t; } else if (el.textContent !== t) el.textContent = t;
    return;
  }
  if (!el.__spans || el.__spans.length !== groups.length) { // the number of groups changed (rare): build the spans again; otherwise they are kept and only their text changes
    el.__spans = groups.map(() => h('span'));
    const nodes = [];
    el.__spans.forEach((span, k) => { if (k > 0) nodes.push(' · '); nodes.push(span); });
    el.replaceChildren(...nodes);
  }
  groups.forEach((group, k) => {
    const span = el.__spans[k];
    setText(span, group);
    const keep = group.length <= max ? 'white-space:nowrap' : '';
    if ((span.getAttribute('style') || '') !== keep) { if (keep) span.setAttribute('style', keep); else span.removeAttribute('style'); }
  });
};
const setAttr = (el, name, value) => {
  const v = String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
};
const setHidden = (el, hidden) => {
  if (Boolean(el.hidden) !== hidden) el.hidden = hidden;
};
const setFlag = (el, name, on) => {
  if (on) { if (!el.hasAttribute(name)) el.setAttribute(name, ''); } else if (el.hasAttribute(name)) el.removeAttribute(name);
};
const setData = (el, name, value) => {
  if (value === '' || value === null || value === undefined) { if (el.hasAttribute(`data-${name}`)) el.removeAttribute(`data-${name}`); } else setAttr(el, `data-${name}`, value);
};
const setClass = (el, name, on) => {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
};
const setVar = (el, name, value) => {
  if (el.__vars === undefined) el.__vars = {};
  if (el.__vars[name] !== value) { el.__vars[name] = value; el.style.setProperty(name, value); }
};

/**
 * Keep the children of `parent` in step with `items`, by key: existing nodes are updated and kept (in order), new ones created, the rest removed. A node that is
 * already in the right place is not touched, so a focused row keeps its focus.
 */
function syncList(parent, items, { keyOf, create, update }) {
  const byKey = new Map();
  for (const child of Array.from(parent.children)) byKey.set(child.getAttribute('data-key'), child);
  const nodes = items.map((item) => {
    const key = String(keyOf(item));
    let node = byKey.get(key);
    if (node) byKey.delete(key);
    else { node = create(item); node.setAttribute('data-key', key); }
    update(node, item);
    return node;
  });
  for (const left of byKey.values()) left.remove();
  nodes.forEach((node, i) => {
    const at = parent.children[i];
    if (at !== node) parent.insertBefore(node, at || null);
  });
}

function coarsePointer() {
  try {
    return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** A 40 px touch area on a coarse pointer without moving the layout (padding that a negative margin takes back). */
function touchArea(el, padX, padY) {
  if (!coarsePointer()) return el;
  el.style.setProperty('padding', `${padY}px ${padX}px`);
  el.style.setProperty('margin', `${-padY}px ${-padX}px`);
  return el;
}

const FACT_ICON = { good: 'check', warn: 'warning', bad: 'warning', info: 'info' };

/** The corner points of a trip's shape (cell coordinates) scaled into the 52 x 28 picture of a trip row. */
export function shapePoints(shape, width = 52, height = 28, pad = 4) {
  if (!Array.isArray(shape) || shape.length === 0) return [];
  const xs = shape.map((p) => p[0]);
  const ys = shape.map((p) => p[1]);
  const x0 = Math.min(...xs); const y0 = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - x0);
  const hgt = Math.max(1, Math.max(...ys) - y0);
  const k = Math.min((width - 2 * pad) / w, (height - 2 * pad) / hgt);
  const ox = (width - (Math.max(...xs) - x0) * k) / 2;
  const oy = (height - (Math.max(...ys) - y0) * k) / 2;
  return shape.map((p) => [ox + (p[0] - x0) * k, oy + (p[1] - y0) * k]);
}

const fmtPoint = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

// ---------------------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------------------

export function createStatsView(host) {
  const call = (name, ...args) => (host && typeof host[name] === 'function' ? host[name](...args) : undefined);
  const strip = h('dl', { class: 'insight__strip', 'aria-label': 'Key figures' });
  const body = h('div', { class: 'insight__body' });
  const root = h('div', { class: 'stats-view', dataset: { role: 'stats-view' } }, strip, body);
  let signature = null;
  let model = null;
  let pinned = null; // the route the planner pinned: a focus id, or null
  const tiles = new Map(); // tile id -> { el, name, since, def, num, unit, arrow, text, note, open }
  const blocks = new Map(); // block id -> { el, patch(block) }

  // ---- the strip of six numbers ----

  function buildTile(t) {
    const name = h('span', { class: 'tile__name', style: 'min-width:0;white-space:normal' }); // wraps instead of cutting a label such as "Busy, incl. waiting" on a phone
    const since = h('span', { class: 'tile__since', hidden: true });
    const defButton = touchArea(h('button', { class: 'def', type: 'button', 'aria-expanded': 'false', 'data-tip': '', 'aria-label': 'How is this counted?' }, icon('info', { size: 12 })), 12, 12);
    const num = h('span', { class: 'tile__num' });
    const unit = h('small', { hidden: true });
    const arrow = h('span', { hidden: true });
    const text = h('span', { class: 'tile__reftext' });
    const note = h('dd', { class: 'how', role: 'note', hidden: true }); // a dd, so that the group stays a valid description list
    const el = h('div', { class: 'tile', dataset: { tile: t.id } },
      h('dt', { class: 'tile__label' }, name, since, defButton),
      h('dd', { class: 'tile__value' }, num, unit),
      h('dd', { class: 'tile__ref' }, arrow, ' ', text),
      note);
    const part = { el, name, since, def: defButton, num, unit, arrow, text, note, open: false };
    defButton.addEventListener('click', () => {
      part.open = !part.open;
      setAttr(defButton, 'aria-expanded', part.open);
      setHidden(note, !part.open);
    });
    return part;
  }

  function patchTile(part, t) {
    setText(part.name, t.label);
    setText(part.since, ' · since start');
    setHidden(part.since, !t.since);
    setAttr(part.def, 'data-tip', t.def);
    setAttr(part.def, 'aria-label', `How is this counted? ${t.def}`);
    setText(part.note, t.def);
    setText(part.num, t.value);
    setText(part.unit, t.unit);
    setHidden(part.unit, !t.unit);
    const ref = t.ref || {};
    setText(part.arrow, ref.arrow || '');
    setHidden(part.arrow, !ref.arrow);
    part.arrow.setAttribute('class', ref.arrow ? (ref.good === false ? 'down' : ref.good === true ? 'up' : '') : '');
    if (ref.arrow) { setAttr(part.arrow, 'role', 'img'); setAttr(part.arrow, 'aria-label', ref.arrow === '▲' ? 'above' : 'below'); }
    setText(part.text, ref.text ? ref.text : ' ');
    setData(part.el, 'tone', t.tone);
  }

  // ---- routes: hover, focus and pin ----

  function setPinned(id) {
    pinned = id;
    for (const row of body.querySelectorAll('.trip')) {
      const on = pinned !== null && row.getAttribute('data-focus') === pinned;
      setClass(row, 'is-hot', on);
      setAttr(row, 'aria-pressed', on);
    }
    const roundButton = body.querySelector('[data-role="round-show"]');
    if (roundButton) setAttr(roundButton, 'aria-pressed', pinned === ROUND_FOCUS_ID);
    call('focusRoute', pinned, { pinned: pinned !== null });
  }

  const hoverRoute = (id) => { if (pinned === null) call('focusRoute', id, { pinned: false }); };
  const leaveRoute = () => { if (pinned === null) call('focusRoute', null, { pinned: false }); };

  // ---- the blocks ----

  const blockHeading = () => {
    const title = h('span', { class: 'block__title' });
    const aside = h('span', { class: 'aside' });
    return { el: h('h3', null, title, aside), title, aside };
  };
  const patchHeading = (hd, b) => {
    setText(hd.title, b.title);
    setText(hd.aside, b.aside || '');
  };

  function buildStatus() {
    const text = h('p', { class: 'how', dataset: { role: 'status-text' } });
    return { el: h('div', { class: 'insight__block', dataset: { block: 'status' } }, text), patch: (b) => setText(text, b.text) };
  }

  // -- where its time goes --

  function buildTime() {
    const hd = blockHeading();
    const bar = h('div', { class: 'progress progress--lg progress--stacked', role: 'img', 'aria-label': 'Time split' });
    const legend = h('ul', { class: 'split__legend' });
    const area = svg('path', { class: 'spark__area', fill: 'var(--series-1)', 'fill-opacity': '0.12', stroke: 'none' });
    const line = svg('path', { class: 'spark__line', fill: 'none', stroke: 'var(--series-1)', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' });
    const chart = svg('svg', { class: 'split__chart', viewBox: '0 0 240 30', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Busy share over the last 30 minutes', style: 'display:block;width:100%;height:30px;overflow:visible' }, area, line);
    const capLeft = h('span');
    const capRight = h('span');
    const spark = h('div', { class: 'split__spark' }, chart, h('div', { class: 'split__spark-label' }, capLeft, capRight));
    const heldLabel = h('span', { class: 'held__title' });
    const heldAside = h('span', { class: 'aside' });
    const hbars = h('div', { class: 'hbars' });
    const heldNote = h('p', { class: 'how' });
    const held = h('div', { class: 'where', dataset: { role: 'held' } }, h('div', { class: 'tile__label' }, heldLabel, heldAside), hbars, heldNote);
    const el = h('div', { class: 'insight__block', dataset: { block: 'time' } }, hd.el, h('div', { class: 'split' }, bar, legend, spark), held);
    return {
      el,
      patch(b) {
        patchHeading(hd, b);
        setAttr(bar, 'aria-label', b.split.label);
        syncList(bar, b.split.items, {
          keyOf: (p) => p.key,
          create: () => h('div', { class: 'progress__bar' }),
          update: (n, p) => { n.setAttribute('class', `progress__bar tone-${p.tone}`); setVar(n, '--w', `${(p.share * 100).toFixed(2)}%`); },
        });
        syncList(legend, b.split.items, {
          keyOf: (p) => p.key,
          create: (p) => h('li', null, h('span', { class: `dot tone-${p.tone}` }), h('span', { class: 'legend__label' }), h('span', { class: 'num' })),
          update: (n, p) => { setText(n.children[1], p.label); setText(n.children[2], p.text); n.children[0].setAttribute('class', `dot tone-${p.tone}`); },
        });
        setHidden(spark, b.spark === null);
        if (b.spark) {
          const vs = b.spark.values;
          const lo = Math.min(...vs); const hi = Math.max(...vs);
          const flat = hi - lo < 1; // a series that does not move is a line through the middle, not along the bottom
          const pts = vs.map((v, k) => [(k / Math.max(1, vs.length - 1)) * 240, flat ? 15 : 27 - ((v - lo) / (hi - lo)) * 24]);
          const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${fmtPoint(p)}`).join(' ');
          setAttr(line, 'd', d);
          setAttr(area, 'd', `${d} L240,30 L0,30 Z`);
          setAttr(chart, 'aria-label', b.spark.label);
          setText(capLeft, b.spark.caption);
          setText(capRight, b.spark.now);
        }
        setHidden(held, b.held === null);
        if (b.held) {
          setText(heldLabel, b.held.title);
          setText(heldAside, b.held.aside);
          syncList(hbars, b.held.rows, {
            keyOf: (r) => r.key,
            create: () => h('div', { class: 'hbar' }, h('span', { class: 'truncate' }), h('span', { class: 'hbar__track' }, h('i')), h('span', { class: 'num' })),
            update: (n, r) => {
              setText(n.children[0], r.label);
              setAttr(n.children[0], 'title', r.label);
              const fill = n.children[1].children[0];
              setVar(fill, '--w', `${Math.min(100, r.share * 100).toFixed(0)}%`);
              setVar(fill, '--c', r.kind === 'other' ? 'var(--text-faint)' : 'var(--state-waiting)');
              setText(n.children[2], r.minPerHour.toFixed(r.minPerHour < 10 ? 1 : 0));
            },
          });
          setText(heldNote, b.held.note);
        }
      },
    };
  }

  // -- worth knowing --

  function buildFacts() {
    const hd = blockHeading();
    const list = h('ul', { class: 'facts' });
    const empty = h('p', { class: 'how', dataset: { role: 'facts-empty' } });
    const how = h('div', { dataset: { role: 'how' } });
    const toggle = touchArea(h('button', { class: 'link', type: 'button', 'aria-expanded': 'false', dataset: { role: 'how-toggle' } }, 'How is this counted?'), 6, 12);
    const defs = h('div', { hidden: true, dataset: { role: 'definitions' }, role: 'group', 'aria-label': 'How the numbers are counted' });
    let open = false;
    toggle.addEventListener('click', () => {
      open = !open;
      setAttr(toggle, 'aria-expanded', open);
      setHidden(defs, !open);
    });
    const el = h('div', { class: 'insight__block', dataset: { block: 'facts' } }, hd.el, list, empty, how, h('p', { class: 'how' }, toggle), defs);
    return {
      el,
      patch(b) {
        patchHeading(hd, b);
        syncList(list, b.facts, {
          keyOf: (f) => f.id,
          create: () => {
            const text = h('span', { class: 'fact__text' });
            const ind = h('span', { class: 'trip__share', hidden: true }, ' (indicative)');
            const show = touchArea(h('button', { class: 'link', type: 'button', hidden: true, dataset: { role: 'fact-show' } }, 'Show on plan'), 6, 12);
            const hint = h('div', { class: 'how', hidden: true });
            const li = h('li', { class: 'fact' }, h('span', { class: 'fact__icon' }), h('div', null, text, ind, ' ', show, hint));
            show.addEventListener('click', () => { if (li.__rect) call('showOnPlan', li.__rect); });
            return li;
          },
          update: (li, f) => {
            setData(li, 'tone', f.tone);
            const slot = li.children[0];
            const wanted = FACT_ICON[f.tone] || 'info';
            if (li.__icon !== wanted) { li.__icon = wanted; slot.replaceChildren(icon(wanted, { size: 16 })); }
            const box = li.children[1];
            setText(box.children[0], f.text);
            setHidden(box.children[1], !f.indicative);
            li.__rect = f.rect || null;
            setHidden(box.children[2], !f.rect);
            setText(box.children[3], f.hint || '');
            setHidden(box.children[3], !f.hint);
          },
        });
        setText(empty, b.empty || '');
        setHidden(empty, b.facts.length > 0 || !b.empty);
        syncList(how, b.how.map((text, i) => ({ text, i })), {
          keyOf: (x) => x.i,
          create: () => h('p', { class: 'how' }),
          update: (n, x) => setText(n, x.text),
        });
        syncList(defs, b.definitions.map((d, i) => ({ ...d, i })), {
          keyOf: (d) => d.i,
          create: () => h('p', { class: 'how' }, h('strong', null), ' ', h('span')),
          update: (n, d) => { setText(n.children[0], `${d.label}.`); setText(n.children[1], d.text); },
        });
      },
    };
  }

  // -- trips --

  function buildTripRow() {
    const rank = h('span', { class: 'trip__rank' });
    const pts = svg('polyline', { fill: 'none', 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', stroke: 'var(--c)' });
    const start = svg('circle', { r: '2.6', fill: 'var(--surface)', stroke: 'var(--c)', 'stroke-width': '1.6' });
    const end = svg('circle', { r: '3', fill: 'var(--c)' });
    const shape = svg('svg', { class: 'trip__shape', viewBox: '0 0 52 28', 'aria-hidden': 'true' }, pts, start, end);
    const name = h('div', { class: 'trip__name' });
    const metaText = h('span');
    const wait = h('span', { class: 'trip__wait', hidden: true });
    const usual = h('span', { class: 'trip__share', hidden: true });
    const note = h('span', { class: 'trip__share', hidden: true });
    const ways = h('div', { class: 'trip__meta', hidden: true }, h('span', { class: 'trip__share' }));
    const row = h('button', { class: 'trip', type: 'button', 'aria-pressed': 'false', style: 'width:100%;text-align:left' }, rank, shape, h('div', { style: 'min-width:0' }, name, h('div', { class: 'trip__meta' }, metaText, wait, usual, note), ways));
    row.__parts = { rank, pts, start, end, shape, name, metaText, wait, usual, note, ways };
    row.addEventListener('pointerenter', () => hoverRoute(row.getAttribute('data-focus')));
    row.addEventListener('pointerleave', leaveRoute);
    row.addEventListener('focus', () => hoverRoute(row.getAttribute('data-focus')));
    row.addEventListener('blur', leaveRoute);
    row.addEventListener('click', () => {
      const id = row.getAttribute('data-focus');
      setPinned(pinned === id ? null : id);
    });
    return row;
  }

  function patchTripRow(row, r, max) {
    const p = row.__parts;
    setAttr(row, 'data-focus', r.focusId);
    setAttr(row, 'aria-label', r.label);
    setText(p.rank, r.rank);
    setVar(p.shape, '--c', rampColor(r.shapeShare, max));
    const pts = shapePoints(r.shape);
    setHidden(p.shape, pts.length === 0);
    if (pts.length) {
      setAttr(p.pts, 'points', pts.map(fmtPoint).join(' '));
      setAttr(p.start, 'cx', pts[0][0].toFixed(1)); setAttr(p.start, 'cy', pts[0][1].toFixed(1));
      setAttr(p.end, 'cx', pts[pts.length - 1][0].toFixed(1)); setAttr(p.end, 'cy', pts[pts.length - 1][1].toFixed(1));
    }
    setText(p.name, r.name);
    setText(p.metaText, r.meta);
    setText(p.wait, r.waits);
    setHidden(p.wait, !r.waits);
    setData(p.wait, 'tone', r.waitTone);
    setText(p.usual, r.usual ? ` · ${r.usual}` : '');
    setHidden(p.usual, !r.usual);
    setText(p.note, r.note ? ` · ${r.note}` : '');
    setHidden(p.note, !r.note);
    setGroups(p.ways.children[0], r.ways || '', 28);
    setHidden(p.ways, !r.ways);
    const on = pinned !== null && pinned === r.focusId;
    setClass(row, 'is-hot', on);
    setAttr(row, 'aria-pressed', on);
  }

  function buildTrips() {
    const hd = blockHeading();
    const empty = h('p', { class: 'how' });
    const list = h('ol', { class: 'trips' });
    const roundStrong = h('strong', null, 'Usual round');
    const roundJobs = h('span', { class: 'round__jobs' });
    const roundShare = h('span', { class: 'trip__share' });
    const roundShow = touchArea(h('button', { class: 'link', type: 'button', 'aria-pressed': 'false', dataset: { role: 'round-show' } }, 'Show on plan'), 6, 12);
    let roundBounds = null;
    roundShow.addEventListener('click', () => {
      setPinned(pinned === ROUND_FOCUS_ID ? null : ROUND_FOCUS_ID);
      if (pinned === ROUND_FOCUS_ID && roundBounds) call('showOnPlan', roundBounds);
    });
    const round = h('p', { class: 'round', hidden: true, dataset: { role: 'round' } }, roundStrong, ' ', roundJobs, ' ', roundShare, ' ', roundShow);
    const otherChevron = h('span', { class: 'disclose__icon' }, icon('chevron-right', { size: 14 }));
    const otherAside = h('span', { class: 'aside' });
    const otherButton = touchArea(h('button', { class: 'disclose', type: 'button', 'aria-expanded': 'false', dataset: { role: 'other-toggle' } }, otherChevron, h('span', null, 'Other drives'), otherAside), 6, 12);
    const otherList = h('div', { hidden: true, dataset: { role: 'other-list' } });
    let otherOpen = false;
    otherButton.addEventListener('click', () => {
      otherOpen = !otherOpen;
      setAttr(otherButton, 'aria-expanded', otherOpen);
      setHidden(otherList, !otherOpen);
      otherChevron.replaceChildren(icon(otherOpen ? 'chevron-down' : 'chevron-right', { size: 14 }));
    });
    const rampLabel = h('span');
    const ramp = h('span', { class: 'route-legend__ramp', role: 'img', 'aria-label': 'Colour: time lost waiting per trip, from none (blue) to much (red)' });
    const legend = h('div', { class: 'route-legend' }, h('span', null, 'Width = trips'), ramp, rampLabel);
    const el = h('div', { class: 'insight__block', dataset: { block: 'trips' } }, hd.el, empty, list, round, otherButton, otherList, legend);
    return {
      el,
      patch(b) {
        patchHeading(hd, b);
        setText(empty, b.empty || '');
        setHidden(empty, b.rows.length > 0);
        syncList(list, b.rows, {
          keyOf: (r) => r.key,
          create: () => h('li', null, buildTripRow()),
          update: (li, r) => patchTripRow(li.children[0], r, b.legend.max),
        });
        setHidden(round, !b.round);
        if (b.round) {
          setText(roundJobs, b.round.jobs.join(', then '));
          setText(roundShare, b.round.text);
          setAttr(roundShow, 'aria-label', `Show the usual round on the plan. ${b.round.label}`);
          roundBounds = b.round.bounds || null;
        }
        setText(otherAside, b.other.text);
        syncList(otherList, b.other.items.map((x, i) => ({ ...x, i })), {
          keyOf: (x) => x.i,
          create: () => h('p', { class: 'how' }, h('strong', null), ' ', h('span')),
          update: (n, x) => { setText(n.children[0], `${x.label}:`); setText(n.children[1], x.text); },
        });
        setHidden(legend, b.rows.length === 0);
        setText(rampLabel, b.legend.text);
        setAttr(ramp, 'aria-label', `Colour: time lost waiting per trip, from none (blue) to ${Math.round(b.legend.max * 100)} % and more (red)`);
      },
    };
  }

  // -- docks of a station --

  function buildDocks() {
    const hd = blockHeading();
    const bodyRows = h('tbody');
    const head = h('tr', null, ...['Dock', 'Visits /h', 'In service', 'Queue / visit'].map((t) => h('th', { scope: 'col' }, t)));
    const table = h('table', { class: 'compare' }, h('thead', null, head), bodyRows);
    const skew = h('p', { class: 'how', hidden: true });
    const el = h('div', { class: 'insight__block', dataset: { block: 'docks' } }, hd.el, table, skew);
    return {
      el,
      patch(b) {
        patchHeading(hd, b);
        syncList(bodyRows, b.rows, {
          keyOf: (r) => r.key,
          create: () => h('tr', null,
            h('td', null, h('span'), ' ', h('span', { class: 'text-faint' })),
            h('td', null, h('span', { class: 'bar' }, h('i')), h('span')),
            h('td'),
            h('td')),
          update: (tr, r) => {
            const [c0, c1, c2, c3] = tr.children;
            setText(c0.children[0], r.name);
            setText(c0.children[1], r.cell);
            setVar(c1.children[0].children[0], '--w', `${(r.barShare * 100).toFixed(0)}%`);
            setVar(c1.children[0].children[0], '--c', 'var(--accent)');
            setText(c1.children[1], r.visitsPerHour.toFixed(1));
            setText(c2, `${Math.round(r.inService * 100)} %`);
            setText(c3, r.queuePerVisit === null ? '–' : `${Math.round(r.queuePerVisit)} s`);
          },
        });
        setText(skew, b.skew || '');
        setHidden(skew, !b.skew);
      },
    };
  }

  const BUILDERS = { status: buildStatus, time: buildTime, facts: buildFacts, trips: buildTrips, docks: buildDocks };

  // ---- the whole view ----

  function rebuild(m) {
    pinned = null;
    strip.replaceChildren();
    body.replaceChildren();
    tiles.clear();
    blocks.clear();
    for (const t of m.tiles) {
      const part = buildTile(t);
      tiles.set(t.id, part);
      strip.append(part.el);
    }
    for (const b of m.blocks) {
      const make = BUILDERS[b.type] || buildStatus;
      const built = make();
      blocks.set(b.id, built);
      body.append(built.el);
    }
    signature = m.signature;
  }

  function update(next) {
    if (!next) return;
    if (next.signature !== signature) rebuild(next);
    model = next;
    for (const t of next.tiles) patchTile(tiles.get(t.id), t);
    for (const b of next.blocks) blocks.get(b.id).patch(b);
    setData(root, 'status', next.status);
    setData(root, 'kind', next.kind);
    // a pinned route that is no longer in the list (the window changed, the trips moved on) is let go
    if (pinned !== null) {
      const trips = next.blocks.find((b) => b.type === 'trips');
      const alive = pinned === ROUND_FOCUS_ID ? Boolean(trips && trips.round) : Boolean(trips && trips.rows.some((r) => r.focusId === pinned));
      if (!alive) setPinned(null);
    }
  }

  return {
    el: root,
    update(next /* , { state, window } */) { update(next); },
    escape() {
      if (pinned === null) return false;
      setPinned(null);
      return true;
    },
    /** What the view holds, for tests and for the shell's curiosity: the pinned route and the signature it was built for. */
    inspect: () => ({ pinned, signature, model }),
    destroy() {
      call('focusRoute', null, { pinned: false }); // a hovered or pinned route is let go
      pinned = null;
    },
  };
}
