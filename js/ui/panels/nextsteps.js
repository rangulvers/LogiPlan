// The coaching surfaces (docs/ARCHITECTURE.md 6.9), all driven by js/ui/guidance.js:
//
//   createNextStepsCard(ctx, { filter, max = 3, compact = false, title, follow, allSet })  -> { el, update(state), destroy() }
//       a calm card of what to do next: per step an icon, a bold title, one line and the main action; a step that connects two
//       stations carries an inline choice of the other end (closest first, the suggestion preselected). "n more" opens the rest,
//       "Not now" dismisses a note. With nothing left the card says "All set" and offers Run.
//   createChecklistCard(ctx)       -> the Getting started list: six steps with live done-state, a progress bar, clickable rows,
//                                     dismissible (remembered), gone when everything is done
//   createGuideChip(ctx)           -> the chip over the plan ("2 steps to finish") that opens the same list in a popover
//   createGuidanceHeader(ctx, ..)  -> checklist + card in one block, the thing the Properties / Flows / Fleet tabs mount at their top
//   createConnectControl(ctx, fix) -> the inline "[where to] [Connect]" control, also used by the Checks tab
//
// Every piece is built ONCE and updated in place (the golden rule of fields.js): text is only written when it changed, a select
// that has focus is left alone, and when the step that holds the keyboard focus is gone (it was done) the focus moves on to the
// next action instead of being lost. Dismissals and the session progress live in guidanceFor(ctx), shared by all pieces.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { getStation } from '../../model/layout.js';
import { guidanceFor, applyFix, validDestinations, validOrigins, stationLabel } from '../guidance.js';
import { uid } from './fields.js';

const FIX_ICONS = { 'connect-flow': 'flow', 'add-fleet': 'plus', focus: 'target', run: 'play', 'set-tab': 'chevron-right' };
/** Icon of a fix button: a tool fix shows its tool (the tool names are icon names). */
const fixIcon = (fix) => (fix.type === 'set-tool' ? fix.tool : FIX_ICONS[fix.type] || 'chevron-right');

const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first control a keyboard user can reach inside `root`, or null. */
function firstControl(root) {
  return [...root.querySelectorAll('button, select')].find((c) => !c.disabled && !c.hidden && !c.closest('[hidden]')) || null;
}

/** Does the keyboard focus sit in `root` because of the keyboard (not a mouse click)? */
function keyboardFocusIn(root) {
  const active = document.activeElement;
  return Boolean(active) && root.contains(active) && active.matches(':focus-visible');
}

/** Steps that mention the selected thing first (the rest keeps its order). */
export function rankBySelection(steps, selection) {
  const key = { station: 'stationIds', flow: 'flowIds', fleet: 'fleetIds' }[selection?.kind];
  if (!key || !selection.ids?.length) return steps;
  const mine = (s) => (s.refs?.[key] || []).some((id) => selection.ids.includes(id));
  return [...steps.filter(mine), ...steps.filter((s) => !mine(s))];
}

/** Filters for the tabs that show only their own steps. */
export const forFlows = (step) => step.scopes.includes('flows');
export const forFleet = (step) => step.scopes.includes('fleet');

/**
 * `hide` rule of the Properties tab: while one station is selected its form asks "Where do loads go?" / "Where do loads come from?"
 * itself, with the same choice and the same Connect button one block further down, so the card leaves those steps out: two pickers
 * for one question are one too many. Every other step stays.
 */
export function hiddenInProperties(step, state) {
  const selection = state.ui?.selection;
  if (selection?.kind !== 'station' || selection.ids.length !== 1) return false;
  return step.id === `connect-out:${selection.ids[0]}` || step.id === `connect-in:${selection.ids[0]}`;
}

// ---------------------------------------------------------------------------------------------------------
// Inline "choose where, then Connect"
// ---------------------------------------------------------------------------------------------------------

/**
 * A choice of the other end of a flow and the Connect button. `fix` is a connect-flow fix: `pick` says which end the planner chooses
 * ('to': the destination of fromId, 'from': the origin of toId), the id on that side is the suggestion. update(layout, fix) refreshes
 * the options in place; the planner's own choice is kept for as long as it stays valid.
 * @returns {{ el: HTMLElement, update(layout: object, fix?: object): void, select: HTMLSelectElement, button: HTMLButtonElement }}
 */
export function createConnectControl(ctx, initialFix, { primary = true, label = 'Connect' } = {}) {
  let fix = initialFix;
  let chosen = null; // the station the planner picked; null while the suggestion is used
  let shown = null; // signature of the options on screen
  const select = h('select', { class: 'input input--sm guide-connect__select', id: uid('guide-pick') });
  const button = h('button', { class: `btn btn--sm${primary ? ' btn--primary' : ''}`, type: 'button' }, icon('flow', { size: 14 }), h('span', null, label));
  const el = h('div', { class: 'guide-connect' }, select, button);
  const picksTo = () => fix.pick !== 'from';
  let latest = null;

  function describe(layout) {
    const other = getStation(layout, select.value);
    const fixed = getStation(layout, picksTo() ? fix.fromId : fix.toId);
    setAttr(select, 'aria-label', picksTo() ? `Where should ${fixed?.name ?? 'this station'} send its loads?` : `Which station sends loads to ${fixed?.name ?? 'this station'}?`);
    const [a, b] = picksTo() ? [fixed, other] : [other, fixed];
    setAttr(button, 'aria-label', a && b ? `Connect ${a.name} to ${b.name}` : label);
  }

  select.addEventListener('change', () => { chosen = select.value; if (latest) describe(latest); });
  button.addEventListener('click', () => {
    if (!select.value) return;
    applyFix(ctx, picksTo() ? { ...fix, toId: select.value } : { ...fix, fromId: select.value });
  });

  function update(layout, nextFix = fix) {
    latest = layout;
    fix = nextFix;
    const list = picksTo() ? validDestinations(layout, fix.fromId) : validOrigins(layout, fix.toId);
    const suggestion = picksTo() ? fix.toId : fix.fromId;
    const signature = list.map((s) => `${s.id}|${stationLabel(s)}`).join(';');
    const typing = typeof document !== 'undefined' && document.activeElement === select;
    if (!typing) {
      if (signature !== shown) {
        shown = signature;
        select.replaceChildren(...list.map((s) => h('option', { value: s.id }, stationLabel(s))));
      }
      if (chosen && !list.some((s) => s.id === chosen)) chosen = null;
      const wanted = chosen || (list.some((s) => s.id === suggestion) ? suggestion : list[0]?.id || '');
      if (select.value !== wanted) select.value = wanted;
    }
    button.disabled = !list.length;
    describe(layout);
  }
  return { el, update, select, button };
}

// ---------------------------------------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------------------------------------

function createStepRow(ctx, g) {
  let step = null;
  let iconName = null;
  let primaryKey = null;
  let connect = null;
  const iconBox = h('span', { class: 'guide-step__icon', 'aria-hidden': 'true' });
  const title = h('strong', { class: 'guide-step__title' });
  const text = h('p', { class: 'guide-step__text' });
  const primary = h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => { if (step) g.apply(step.fix); } });
  const show = h('button', { class: 'btn btn--ghost btn--icon btn--sm guide-step__show', type: 'button', title: 'Show on the plan', onclick: () => { if (step) ctx.actions.focus(step.refs); } }, icon('target', { size: 16 }));
  const alt = h('button', { class: 'btn btn--sm', type: 'button', hidden: true, onclick: () => { if (step?.alt) g.apply(step.alt); } });
  const dismiss = h('button', { class: 'btn btn--ghost btn--sm guide-step__dismiss', type: 'button', onclick: () => { if (step) g.dismiss(step.id); } }, 'Not now');
  const actions = h('div', { class: 'guide-step__actions' }, primary, alt, dismiss);
  const el = h('li', { class: 'guide-step' }, iconBox, h('div', { class: 'guide-step__body' }, h('div', { class: 'guide-step__head' }, title, show), text, actions));

  return {
    el,
    update(next, layout) {
      step = next;
      if (el.dataset.step !== next.id) el.dataset.step = next.id;
      const cls = `guide-step guide-step--${next.severity}`;
      if (el.className !== cls) el.className = cls;
      if (iconName !== next.icon) {
        iconName = next.icon;
        iconBox.replaceChildren(icon(next.icon, { size: 16 }));
      }
      setText(title, next.title);
      setText(text, next.text);
      const joins = next.fix?.type === 'connect-flow';
      if (joins && !connect) {
        connect = createConnectControl(ctx, next.fix);
        actions.prepend(connect.el);
      }
      if (connect) {
        connect.el.hidden = !joins;
        if (joins) connect.update(layout, next.fix);
      }
      primary.hidden = joins || !next.fix;
      if (!primary.hidden) {
        const key = `${fixIcon(next.fix)}|${next.fix.label}`;
        if (key !== primaryKey) {
          primaryKey = key;
          primary.replaceChildren(icon(fixIcon(next.fix), { size: 14 }), next.fix.label || 'Do it');
        }
        setAttr(primary, 'aria-label', `${next.fix.label}: ${next.title}`);
      }
      alt.hidden = !next.alt;
      if (next.alt) {
        setText(alt, next.alt.label || 'Other way');
        setAttr(alt, 'aria-label', `${next.alt.label}: ${next.title}`);
      }
      const places = (next.refs?.stationIds?.length || next.refs?.flowIds?.length) && next.fix?.type !== 'focus';
      show.hidden = !places;
      setAttr(show, 'aria-label', `Show on the plan: ${next.title}`);
      dismiss.hidden = !next.dismissible;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The Next steps card
// ---------------------------------------------------------------------------------------------------------

/**
 * @param {object} ctx the shared ctx (docs/ARCHITECTURE.md 6.8)
 * @param {{ filter?: (step: object) => boolean, hide?: (step: object, state: object) => boolean, max?: number, compact?: boolean, title?: string, follow?: boolean, allSet?: boolean }} [options]
 *   `filter` keeps only some steps (a filtered card hides itself when it has none); `hide` drops steps that something else on
 *   screen already shows (it also gets the state); `max` steps show before "n more"; `compact` drops
 *   the header (the chip popover brings its own); `follow` puts steps about the selected station / flow / fleet first; `allSet`
 *   (default: no filter) shows the "All set" state when nothing is left anywhere.
 * @returns {{ el: HTMLElement, update(state: object): void, destroy(): void }}
 */
export function createNextStepsCard(ctx, options = {}) {
  const { filter = null, hide = null, max = 3, compact = false, title = 'Next steps', follow = false } = options;
  const allSetEnabled = options.allSet ?? !filter;
  const g = guidanceFor(ctx);
  const rows = new Map();
  let expanded = false;
  let last = null;

  const headIcon = h('span', { class: 'guide__icon', 'aria-hidden': 'true' });
  const heading = h('h3', { class: 'guide__title', tabindex: '-1' });
  const count = h('span', { class: 'badge badge--accent', hidden: true });
  const head = compact ? null : h('div', { class: 'guide__head' }, headIcon, heading, count);
  const allSetText = h('p', { class: 'guide-step__text' });
  const runButton = h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => { void ctx.runner?.toggle(); } });
  const allSet = h('div', { class: 'guide-step guide-step--good guide__allset', hidden: true },
    h('span', { class: 'guide-step__icon', 'aria-hidden': 'true' }, icon('check', { size: 16 })),
    h('div', { class: 'guide-step__body' }, allSetText, h('div', { class: 'guide-step__actions' }, runButton)));
  const list = h('ol', { class: 'guide__list', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const more = h('button', { class: 'btn btn--ghost btn--sm guide__more', type: 'button', 'aria-expanded': 'false', onclick: () => { expanded = !expanded; if (last) update(last); } });
  const el = h('section', { class: `card guide${compact ? ' guide--compact' : ''}`, 'aria-label': compact ? `${title} list` : title, hidden: true }, head, allSet, list, h('div', { class: 'guide__foot' }, more));
  let headMode = null;
  let runMode = null;

  function paintHead(done, openCount, warn) {
    if (!head) return;
    const mode = done ? 'done' : 'todo';
    if (mode !== headMode) {
      headMode = mode;
      headIcon.replaceChildren(icon(done ? 'check' : 'flow', { size: 16 }));
      headIcon.classList.toggle('guide__icon--good', done);
      setText(heading, done ? 'All set' : title);
    }
    count.hidden = done || openCount === 0;
    setText(count, String(openCount));
    const tone = `badge ${warn ? 'badge--warn' : 'badge--accent'}`;
    if (count.className !== tone) count.className = tone;
  }

  function paintAllSet(done, progress) {
    allSet.hidden = !done;
    if (!done) return;
    setText(allSetText, progress.ran
      ? 'Nothing left to set up. Change the plant or the Simulate settings and run it again to see what happens.'
      : 'Your plant is ready. Run it to see the vehicles work.');
    const mode = ctx.runner?.playing ? 'pause' : 'run';
    if (mode !== runMode) {
      runMode = mode;
      runButton.replaceChildren(icon(mode === 'pause' ? 'pause' : 'play', { size: 14 }), mode === 'pause' ? 'Pause' : 'Run');
    }
  }

  function reconcile(shown, layout) {
    const wanted = new Set(shown.map((s) => s.id));
    for (const [id, row] of rows) {
      if (wanted.has(id)) continue;
      row.el.remove();
      rows.delete(id);
    }
    shown.forEach((step, i) => {
      if (!rows.has(step.id)) rows.set(step.id, createStepRow(ctx, g));
      const row = rows.get(step.id);
      row.update(step, layout);
      if (list.children[i] !== row.el) list.insertBefore(row.el, list.children[i] || null);
    });
  }

  function update(state) {
    last = state;
    // A keyboard user who finished a step keeps their place. A mouse user is not handed a focused button they never chose: it
    // would also take the Space key (play / pause) away from the shell.
    const hadFocus = keyboardFocusIn(el);
    const { steps, open, progress } = g.read(state);
    const mine = (filter ? steps.filter(filter) : steps).filter((step) => !hide || !hide(step, state));
    const openMine = mine.filter((s) => s.severity !== 'info');
    const notes = mine.filter((s) => s.severity === 'info');
    const done = allSetEnabled && open.length === 0;
    const ordered = [...(follow ? rankBySelection(openMine, state.ui?.selection) : openMine), ...notes];
    const overflow = ordered.length > max;
    if (!overflow) expanded = false;
    const shown = expanded ? ordered : ordered.slice(0, max);
    el.hidden = !done && ordered.length === 0;
    paintHead(done, openMine.length, openMine.some((s) => s.severity === 'warn'));
    paintAllSet(done, progress);
    reconcile(shown, state.layout);
    more.hidden = !overflow;
    setAttr(more, 'aria-expanded', String(expanded));
    setText(more, expanded ? 'Show fewer' : `${plural(ordered.length - max, 'more step')}`);
    list.hidden = shown.length === 0;
    if (hadFocus && !el.contains(document.activeElement)) {
      // What held the focus is gone (the step was done): hand it to the next action.
      (firstControl(allSet.hidden ? list : allSet) || firstControl(el) || heading).focus({ preventScroll: true });
    }
  }

  const off = g.dismissals.subscribe(() => { if (last) update(last); });
  return { el, update, destroy() { off(); el.remove(); } };
}

// ---------------------------------------------------------------------------------------------------------
// Getting started checklist
// ---------------------------------------------------------------------------------------------------------

/**
 * The Getting started list. It hides itself when dismissed (remembered) or when every step is done; each row performs or opens
 * the thing it names. `update(state)` also hides it while something is selected (the Properties tab shows the item then).
 * @returns {{ el: HTMLElement, update(state: object): void, destroy(): void }}
 */
export function createChecklistCard(ctx, { onHidden = null } = {}) {
  const g = guidanceFor(ctx);
  let open = true;
  let last = null;
  let items = [];
  const rows = [];
  const headingId = uid('guide-check');
  const count = h('span', { class: 'guide-check__count tnum' });
  const toggle = h('button', { class: 'btn btn--ghost btn--sm btn--icon guide-check__toggle', type: 'button', 'aria-expanded': 'true', 'aria-controls': `${headingId}-list`, 'aria-label': 'Collapse the getting started list',
    onclick: () => { open = !open; if (last) update(last); } }, icon('chevron-down', { size: 16 }));
  const close = h('button', { class: 'btn btn--ghost btn--sm btn--icon', type: 'button', 'aria-label': 'Hide the getting started list', 'data-tip': 'Hide', 'data-tip-pos': 'left',
    onclick: () => { g.dismiss('checklist'); } }, icon('close', { size: 16 }));
  const bar = h('div', { class: 'progress__bar' });
  const track = h('div', { class: 'progress guide-check__track', role: 'progressbar', 'aria-labelledby': headingId, 'aria-valuemin': '0', 'aria-valuemax': '6' }, bar);
  const list = h('ol', { class: 'guide__list guide-check__list', id: `${headingId}-list` });
  const el = h('section', { class: 'card guide guide-check', 'aria-labelledby': headingId, hidden: true },
    h('div', { class: 'guide__head' }, h('h3', { class: 'guide__title', id: headingId }, 'Getting started'), count, h('span', { class: 'spacer' }), toggle, close),
    h('div', { class: 'guide-check__progress' }, track), list);

  function build(entries) {
    list.replaceChildren(...entries.map((item, i) => {
      const box = h('span', { class: 'guide-check__box', 'aria-hidden': 'true' });
      const label = h('span', { class: 'guide-check__title' }, item.title);
      const hint = h('span', { class: 'guide-check__hint' }, item.hint);
      const state = h('span', { class: 'sr-only' });
      const button = h('button', { class: 'guide-check__row', type: 'button', onclick: () => { g.apply(items[i].fix); } }, box, h('span', { class: 'guide-check__main' }, label, hint), state);
      rows.push({ box, hint, state, button, doneIcon: false });
      return h('li', null, button);
    }));
  }

  function update(state) {
    last = state;
    const hadFocus = keyboardFocusIn(el);
    const { checklist } = g.read(state);
    items = checklist.items;
    const hide = g.dismissals.has('checklist') || checklist.complete || Boolean(state.ui?.selection?.kind);
    el.hidden = hide;
    if (hide) {
      if (hadFocus) onHidden?.(); // the list that held the focus is gone: the owner decides where it goes
      return;
    }
    if (!rows.length) build(items);
    items.forEach((item, i) => {
      const row = rows[i];
      row.button.classList.toggle('is-done', item.done);
      row.button.classList.toggle('is-current', item.current);
      if (item.current) row.button.setAttribute('aria-current', 'step'); else row.button.removeAttribute('aria-current');
      if (row.doneIcon !== item.done) {
        row.doneIcon = item.done;
        row.box.replaceChildren(...(item.done ? [icon('check', { size: 12 })] : []));
      }
      setText(row.state, item.done ? 'Done.' : item.current ? 'Next.' : '');
      row.hint.hidden = !item.current;
    });
    setText(count, `${checklist.done} of ${checklist.total}`);
    bar.style.setProperty('--w', `${Math.round((checklist.done / checklist.total) * 100)}%`);
    track.setAttribute('aria-valuenow', String(checklist.done));
    track.setAttribute('aria-valuetext', `${checklist.done} of ${checklist.total} steps done`);
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Collapse the getting started list' : 'Expand the getting started list');
    toggle.classList.toggle('is-collapsed', !open);
  }

  const off = g.dismissals.subscribe(() => { if (last) update(last); });
  return { el, update, destroy() { off(); el.remove(); } };
}

// ---------------------------------------------------------------------------------------------------------
// Block for the top of a tab
// ---------------------------------------------------------------------------------------------------------

/**
 * The guidance a tab shows at its top: optionally the Getting started list (Properties, while nothing is selected) and the Next steps
 * card (all steps, or only those `filter` keeps). The block hides itself when both are empty.
 * @param {object} ctx
 * @param {{ checklist?: boolean, filter?: (step: object) => boolean, max?: number, follow?: boolean }} [options]
 */
export function createGuidanceHeader(ctx, { checklist = false, ...cardOptions } = {}) {
  const card = createNextStepsCard(ctx, cardOptions);
  const list = checklist ? createChecklistCard(ctx, { onHidden: () => (firstControl(card.el) || card.el.querySelector('.guide__title'))?.focus({ preventScroll: true }) }) : null;
  const el = h('div', { class: 'guide-stack', 'data-guidance': '' }, list?.el, card.el);
  return {
    el,
    update(state) {
      list?.update(state);
      card.update(state);
      el.hidden = card.el.hidden && (!list || list.el.hidden);
    },
    destroy() { list?.destroy(); card.destroy(); el.remove(); },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The chip over the plan
// ---------------------------------------------------------------------------------------------------------

/**
 * The guide chip: bottom-left of the stage, above the scale bar, hidden while nothing is left to do. A press opens a popover with the
 * Next steps card (Esc or a click elsewhere closes it, and Esc gives the focus back to the chip). The chip turns amber while a step is a
 * warning. Append `el` to the stage; call update(state) with the others.
 * @returns {{ el: HTMLElement, update(state: object): void, destroy(): void, open(): void, close(): void, readonly isOpen: boolean }}
 */
export function createGuideChip(ctx) {
  const g = guidanceFor(ctx);
  const popId = uid('guide-pop');
  let isOpen = false;
  let last = null;
  let warnShown = null;
  const reported = new Set();
  const card = createNextStepsCard(ctx, { compact: true, max: 3, follow: false, allSet: false });
  const closeButton = h('button', { class: 'btn btn--ghost btn--sm btn--icon', type: 'button', 'aria-label': 'Close the list of next steps', onclick: () => close(true) }, icon('close', { size: 16 }));
  const popup = h('div', { class: 'guide-pop card', id: popId, role: 'region', 'aria-label': 'Next steps', hidden: true },
    h('div', { class: 'guide__head' }, h('h3', { class: 'guide__title' }, 'Next steps'), h('span', { class: 'spacer' }), closeButton),
    card.el,
    h('p', { class: 'guide-pop__note' }, 'Vehicles are not tied to stations. Flows say where loads go, and every free vehicle serves every flow.'));
  const glyph = h('span', { class: 'guide-chip__glyph', 'aria-hidden': 'true' });
  const label = h('span', { class: 'guide-chip__label' });
  const caret = icon('chevron-up', { size: 14, class: 'guide-chip__caret' });
  const button = h('button', { class: 'btn btn--sm guide-chip__button', type: 'button', 'aria-expanded': 'false', 'aria-controls': popId, 'data-guide-chip-button': '' }, glyph, label, caret);
  // The button comes first in the DOM, so Tab goes from the chip into the popover (which is drawn above it, see .guide-chip).
  const el = h('div', { class: 'guide-chip', hidden: true, 'data-guide-chip': '' }, button, popup);

  function onOutside(e) {
    if (!el.contains(e.target)) close(false);
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    popup.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    if (last) card.update(last);
  }

  function close(restoreFocus = false) {
    if (!isOpen) return;
    isOpen = false;
    const hadFocus = popup.contains(document.activeElement);
    popup.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (restoreFocus || hadFocus) (restoreFocus ? button : ctx.canvas || button).focus({ preventScroll: true });
  }

  button.addEventListener('click', () => (isOpen ? close(false) : open()));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen) return;
    e.preventDefault();
    e.stopPropagation(); // the editor would clear the selection
    close(true);
  });

  function update(state) {
    // The chip is updated by the shell together with its toolbars: whatever goes wrong here must not stop them.
    try {
      refresh(state);
    } catch (err) {
      const key = String(err && err.message);
      if (!reported.has(key)) {
        reported.add(key);
        console.error('[LogiPlan] guide chip', err);
      }
    }
  }

  function refresh(state) {
    last = state;
    const { open: pending } = g.read(state);
    const n = pending.length;
    const warn = pending.some((s) => s.severity === 'warn');
    el.hidden = n === 0;
    if (n === 0 && isOpen) close(false);
    setText(label, `${plural(n, 'step')} to finish`);
    if (warn !== warnShown) {
      warnShown = warn;
      glyph.replaceChildren(icon(warn ? 'warning' : 'flow', { size: 14 }));
      button.classList.toggle('guide-chip__button--warn', warn);
    }
    // The heatmap legend sits where the chip would: stay above it.
    el.classList.toggle('is-lifted', Boolean(state.ui?.overlays?.heat && state.ui.overlays.heat !== 'off'));
    if (isOpen) card.update(state);
  }

  return {
    el, update, open, close,
    get isOpen() { return isOpen; },
    destroy() { document.removeEventListener('pointerdown', onOutside, true); card.destroy(); el.remove(); },
  };
}
