// Checks panel (docs/ARCHITECTURE.md 6.5): the plan's problems in a planner's language, grouped by severity, each with the
// advice to fix it and a "Show" button that takes the planner to the place on the plan.
//
//   const panel = createChecksPanel(ctx);   // panel.el, panel.update(state), panel.destroy()
//   panel.count                              // errors + warnings, for the tab badge
//   panel.onCount = (n) => badge.set(n);     // optional; called with the current count when assigned, and whenever it changes
//
// The issues come from ctx.issues(), which the shell caches per layout identity, so update() is cheap: the list is only
// redrawn when the issues (or the dismissed notes) changed, and keyboard focus survives a redraw. Notes (info level) can be
// dismissed; that is remembered in memory only, for the life of the page.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { callout, emptyState } from './fields.js';
import { applyFix, fixForIssue } from '../guidance.js';
import { createConnectControl } from './nextsteps.js';

const GROUPS = Object.freeze([
  { severity: 'error', title: 'Errors', explain: 'The simulation cannot work properly until these are fixed.' },
  { severity: 'warning', title: 'Warnings', explain: 'The plant can run, but the results may be misleading.' },
  { severity: 'info', title: 'Notes', explain: 'Good to know. You can dismiss a note.' },
]);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A kind of problem that comes up more often than this folds its repeats behind one button (seven flows without vehicles are one cause). */
const FOLD_AFTER = 3;

/**
 * Split issues into the three severities. Dismissed notes are left out and counted in `hidden`.
 * @param {Array<{id: string, severity: string}>} issues
 * @param {Set<string>} [dismissed] ids of dismissed notes
 */
export function groupIssues(issues, dismissed = new Set()) {
  const groups = { error: [], warning: [], info: [], hidden: 0 };
  for (const issue of issues) {
    if (issue.severity === 'info' && dismissed.has(issue.id)) groups.hidden += 1;
    else (groups[issue.severity] || groups.info).push(issue);
  }
  return groups;
}

/** The ctx.actions.focus argument for an issue's refs, or null when the issue points at nothing on the plan. */
export function focusTarget(refs) {
  const target = {};
  if (refs?.stationId) target.stationIds = [refs.stationId];
  if (refs?.flowId) target.flowIds = [refs.flowId];
  if (refs?.fleetId) target.fleetIds = [refs.fleetId];
  if (refs?.cells?.length) target.cells = refs.cells;
  return Object.keys(target).length ? target : null;
}

/**
 * Create the Checks panel.
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): issues(), actions.focus
 * @returns {{ el: HTMLElement, update(state: object): void, destroy(): void, count: number, onCount: ((n: number) => void) | null }}
 */
export function createChecksPanel(ctx) {
  const dismissed = new Set();
  const expanded = new Set(); // `${severity}:${code}` of the folded kinds the planner opened
  let revision = 0; // bumped by every change of what the planner chose to see (dismissed notes, opened folds)
  let shown = null; // [issues, revision] of the last redraw
  let signature = null;
  let count = 0;
  let notified = null;
  let onCount = null;
  let controls = []; // the inline "where to / Connect" pickers of the issues on screen (kept in step with the layout)

  const summary = h('div', { class: 'row row--wrap', style: { padding: '12px 12px 0' } });
  const list = h('div', { class: 'stack', style: { padding: '12px', '--gap': '16px', outline: 'none' }, tabindex: '-1' });
  const el = h('div', { 'data-panel': 'checks' }, summary, list);

  function showButton(issue) {
    const target = focusTarget(issue.refs);
    if (!target) return null;
    return h('button', {
      class: 'btn btn--sm', type: 'button', 'aria-label': `Show on the plan: ${issue.message}`, dataset: { issue: issue.id, role: 'show' },
      onclick: () => ctx.actions.focus(target),
    }, icon('target', { size: 14 }), 'Show');
  }

  function dismissButton(issue) {
    return h('button', {
      class: 'btn btn--sm btn--ghost', type: 'button', 'aria-label': `Dismiss note: ${issue.message}`, dataset: { issue: issue.id, role: 'dismiss' },
      onclick: () => { dismissed.add(issue.id); revision += 1; draw(); },
    }, 'Dismiss');
  }

  /** The one-click fix guidance offers for an issue: a "where to + Connect" picker, an "Add vehicles" button, or nothing. */
  function fixControl(issue) {
    const layout = ctx.store.getState().layout;
    const fix = fixForIssue(layout, issue);
    if (!fix) return null;
    if (fix.type === 'connect-flow') {
      const control = createConnectControl(ctx, fix);
      control.el.dataset.issue = issue.id;
      control.button.dataset.issue = issue.id;
      control.button.dataset.role = 'fix';
      control.update(layout);
      controls.push(control);
      return control.el;
    }
    return h('button', {
      class: 'btn btn--sm btn--primary', type: 'button', 'aria-label': `${fix.label}: ${issue.message}`, dataset: { issue: issue.id, role: 'fix' },
      onclick: () => applyFix(ctx, fix),
    }, fix.label);
  }

  function issueCallout(issue) {
    const hint = issue.code === 'station-no-dock' ? h('span', { class: 'field__hint' }, 'Select the station and drag it next to a road.') : null;
    // a fix that only shows the place ("Show docks", docks-share-lane) is the Show button: one of them is enough
    const showsPlace = fixForIssue(ctx.store.getState().layout, issue)?.type === 'focus';
    const buttons = [fixControl(issue), showsPlace ? null : showButton(issue), hint, issue.severity === 'info' ? dismissButton(issue) : null].filter(Boolean);
    return callout({
      severity: issue.severity, title: issue.message, text: issue.hint,
      actions: buttons.length ? h('div', { class: 'row row--wrap', style: { marginTop: '6px' } }, buttons) : null,
    });
  }

  function foldButton(key, open, hiddenCount, group) {
    const noun = group.severity === 'info' ? 'notes' : group.severity === 'warning' ? 'warnings' : 'errors';
    return h('button', {
      class: 'btn btn--ghost btn--sm', type: 'button', 'aria-expanded': String(open), dataset: { issue: key, role: 'fold' },
      onclick: () => { if (open) expanded.delete(key); else expanded.add(key); revision += 1; draw(); },
    }, open ? 'Show fewer' : `Show ${hiddenCount} more similar ${noun}`);
  }

  /** The callouts of one severity; the repeats of a kind that came up many times sit behind a "Show more" button. */
  function issueNodes(group, issues) {
    const totals = new Map();
    for (const issue of issues) totals.set(issue.code, (totals.get(issue.code) || 0) + 1);
    const seen = new Map();
    const nodes = [];
    for (const issue of issues) {
      const total = totals.get(issue.code);
      const folds = total >= FOLD_AFTER + 2;
      const key = `${group.severity}:${issue.code}`;
      const n = (seen.get(issue.code) || 0) + 1;
      seen.set(issue.code, n);
      if (!folds || expanded.has(key) || n <= FOLD_AFTER) nodes.push(issueCallout(issue));
      if (folds && n === total) nodes.push(foldButton(key, expanded.has(key), total - FOLD_AFTER, group));
    }
    return nodes;
  }

  function groupBlock(group, issues) {
    return h('section', { class: 'stack', style: { '--gap': '8px' }, 'aria-label': group.title },
      h('div', null,
        h('div', { class: 'row' }, h('h3', { style: { margin: 0, fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' } }, group.title), h('span', { class: 'badge' }, String(issues.length))),
        h('p', { class: 'field__hint' }, group.explain)),
      ...issueNodes(group, issues));
  }

  function summaryChips(groups) {
    const chips = [
      groups.error.length ? h('span', { class: 'chip chip--error' }, icon('error', { size: 14 }), plural(groups.error.length, 'error', 'errors')) : null,
      groups.warning.length ? h('span', { class: 'chip chip--warn' }, icon('warning', { size: 14 }), plural(groups.warning.length, 'warning', 'warnings')) : null,
      groups.info.length ? h('span', { class: 'chip chip--info' }, icon('info', { size: 14 }), plural(groups.info.length, 'note', 'notes')) : null,
    ].filter(Boolean);
    if (chips.length && !groups.error.length && !groups.warning.length) chips.unshift(h('span', { class: 'chip chip--good' }, icon('check', { size: 14 }), 'No errors or warnings'));
    return chips; // nothing at all to report: the empty state below says so
  }

  function restoreButton(hidden) {
    return h('div', null, h('button', {
      class: 'btn btn--ghost btn--sm', type: 'button', dataset: { role: 'restore' },
      onclick: () => { dismissed.clear(); revision += 1; draw(); },
    }, `Show ${plural(hidden, 'dismissed note', 'dismissed notes')} again`));
  }

  function emptyBlock() {
    const block = emptyState({ iconName: 'check', title: 'No problems found', text: 'The plan looks consistent. Press play to see how it performs.' });
    const badge = block.querySelector('.empty__icon');
    badge.style.background = 'var(--good-soft)';
    badge.style.color = 'var(--good-text)';
    return block;
  }

  /** Keep keyboard focus on the same button after a redraw; if its issue is gone, park it on the list. */
  function restoreFocus(previous) {
    if (!previous) return;
    const same = [...list.querySelectorAll('button')].find((b) => b.dataset.issue === previous.issue && b.dataset.role === previous.role);
    (same || list).focus({ preventScroll: true });
  }

  function draw() {
    const issues = ctx.issues();
    const groups = groupIssues(issues, dismissed);
    count = groups.error.length + groups.warning.length;
    const next = JSON.stringify([GROUPS.map((g) => groups[g.severity].map((i) => [i.id, i.message, i.hint])), groups.hidden, [...expanded]]);
    if (next !== signature) {
      signature = next;
      const active = list.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
      const empty = !groups.error.length && !groups.warning.length && !groups.info.length;
      summary.replaceChildren(...summaryChips(groups));
      controls = [];
      list.replaceChildren(
        ...(empty ? [emptyBlock()] : []),
        ...GROUPS.filter((g) => groups[g.severity].length).map((g) => groupBlock(g, groups[g.severity])),
        ...(groups.hidden ? [restoreButton(groups.hidden)] : []));
      restoreFocus(active);
    }
    shown = [issues, revision];
    if (count !== notified) {
      notified = count;
      onCount?.(count);
    }
  }

  const panel = {
    el,
    get count() { return count; },
    get onCount() { return onCount; },
    set onCount(fn) {
      onCount = typeof fn === 'function' ? fn : null;
      onCount?.(count); // the shell may assign this after the first draw: deliver the current count right away
    },
    update(state) {
      const layout = state?.layout ?? ctx.store.getState().layout;
      for (const control of controls) control.update(layout);
      if (shown && shown[0] === ctx.issues() && shown[1] === revision) return;
      draw();
    },
    destroy() { el.remove(); },
  };
  draw();
  return panel;
}
