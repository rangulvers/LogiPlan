// Dialogs (docs/ARCHITECTURE.md 6.5 and 6.8): the modal primitives of the app and the four big dialogs built on them.
//
//   const dialogs = createDialogs(ctx);            // ctx.dialogs = dialogs, see docs/ARCHITECTURE.md 6.8
//   dialogs.show({ title, body, actions, size })   -> { close(), el, buttons, isOpen() }
//   dialogs.confirm({ title, text, confirmLabel, danger })      -> Promise<boolean>
//   dialogs.prompt({ title, label, value, placeholder, ... })   -> Promise<string | null>
//   dialogs.openWelcome({ auto })  welcome screen: examples with previews, empty plant, continue; `auto: true` honours "Don't show again"
//   dialogs.openHelp({ tab })      quick start, tools and shortcuts, how vehicles find work ('vehicles'), how the simulation works, tips
//   dialogs.openShare()            share link with copy button, or the project file when the link would be too long
//   dialogs.openImportExport()     download the project file; open one from a file, drag and drop, pasted text or a share link
//   dialogs.openAbout()            the version of this copy, its build, a copy-for-bug-reports button and what is new (js/ui/about.js)
//
// Every dialog is a role="dialog" with aria-modal, traps Tab inside, closes with Escape (only the topmost one reacts), with the
// close button and with a click on the backdrop, locks page scrolling while it is open and puts focus back where it came from.
// Pure helpers (what the welcome screen shows, pasted-text detection, file names) are exported and unit-tested in
// tests/ui.panels2.test.js; the dialogs themselves are exercised by tests/e2e/panels2.mjs.

import { h, downloadFile } from '../util/dom.js';
import { icon } from './icons.js';
import { Camera } from './camera.js';
import { Renderer } from './renderer.js';
import { resolveThemeMode } from './theme.js';
import { TOOL_KEYS } from './editor/tools.js';
import { EXAMPLES } from '../model/examples.js';
import { createLayout } from '../model/layout.js';
import { GRID_LIMITS } from '../model/defaults.js';
import { exportProject, importProject, shareUrl, decodeShare } from '../model/serialize.js';
import { formatNumber } from '../util/format.js';
import { numberField, textField, segmentedField, callout, uid } from './panels/fields.js';
import { createVehiclesHelp } from './panels/jobs-view.js';
import { createTrucksHelp } from './panels/trucks-help.js';
import { createStatsHelp } from './panels/stats-help.js';
import { openAbout } from './about.js';

const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const quoted = (name) => `“${name}”`;
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Is the device touch-only (no mouse or pen hover)? Then hints must not talk about keys such as Space. */
export const isTouchOnly = () => Boolean(globalThis.matchMedia && globalThis.matchMedia('(hover: none)').matches);

/**
 * After a dialog replaced the plant, the plan gets the keyboard (Space plays, the tool keys work) instead of the button that
 * opened the dialog: Space on "Examples" would open the gallery again, although the toast just said Space runs the example.
 */
const focusPlan = (ctx) => { if (ctx.canvas && ctx.canvas.isConnected) ctx.canvas.focus({ preventScroll: true }); };

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

/** localStorage key of the "Don't show again" choice of the welcome screen. */
export const WELCOME_KEY = 'logiplan:welcome-hidden';
/** A share link longer than this many characters is likely to be cut off by chat and e-mail apps. */
export const SHARE_LINK_WARN = 8000;

/** Has the planner asked not to see the welcome screen at start-up? (false when storage is unavailable) */
export function isWelcomeHidden() {
  try {
    return globalThis.localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember (or forget) the "Don't show again" choice; silently does nothing when storage is unavailable. */
export function setWelcomeHidden(hidden) {
  try {
    if (hidden) globalThis.localStorage.setItem(WELCOME_KEY, '1');
    else globalThis.localStorage.removeItem(WELCOME_KEY);
  } catch {
    // private mode or blocked storage: the choice just does not persist
  }
}

/** localStorage key of the tip the welcome screen showed last. */
export const WELCOME_TIP_KEY = 'logiplan:welcome-tip';

/** The tips the welcome screen rotates through, one per visit: how loads, flows and vehicles belong together, and how to draw straight. */
export const WELCOME_TIPS = Object.freeze([
  { id: 'second-goods-in', title: 'Adding a second Goods in?', text: 'Give it a flow of its own: select it and pick a destination under “Where do loads go?”. The vehicles you already have serve it automatically.' },
  { id: 'vehicles-not-tied', title: 'Vehicles are not tied to stations', text: 'Every free vehicle serves every flow. To dedicate a fleet to one flow, open the Fleet tab and switch on “Only this fleet” under Jobs this fleet serves.' },
  { id: 'dock', title: 'Every station needs a dock', text: 'A dock is a road cell that touches the station. A station that touches no road is never served, so place it right next to one.' },
  { id: 'shift-straight', title: 'Straight roads with Shift', text: 'Hold Shift while you drag a road for one perfectly straight line, and Shift+click to carry on from where the last road ended. The Draw switch over the plan chooses Smart, Straight or Free.' },
]);

/** The tip after the one shown last time (index `last`; any junk starts at the first), wrapping around. */
export const nextTipIndex = (last) => (Number.isInteger(last) && last >= 0 ? last + 1 : 0) % WELCOME_TIPS.length;

/** The tip for the welcome screen of this visit: the next one after the last visit, remembered in localStorage (the first one when storage is unavailable). */
function pickWelcomeTip() {
  let last = null;
  try {
    last = Number.parseInt(globalThis.localStorage.getItem(WELCOME_TIP_KEY), 10);
  } catch {
    last = null;
  }
  const index = nextTipIndex(last);
  try {
    globalThis.localStorage.setItem(WELCOME_TIP_KEY, String(index));
  } catch {
    // not remembered: the next visit shows the first tip again
  }
  return index;
}

/** Sizes offered for a new empty plant (grid cells). */
export const EMPTY_PLANT_SIZES = Object.freeze([
  { id: 'small', label: 'Small', cols: 32, rows: 20 },
  { id: 'medium', label: 'Medium', cols: 48, rows: 32 },
  { id: 'large', label: 'Large', cols: 80, rows: 52 },
]);

/** "96 × 64 m": the real size of a plant of `cols` × `rows` cells of `cellSize` metres. */
export const plantArea = (cols, rows, cellSize) => `${formatNumber(cols * cellSize, 1)} × ${formatNumber(rows * cellSize, 1)} m`;

/** One line about a layout for a card: "8 stations · 6 flows · 10 vehicles". */
export function layoutFacts(layout) {
  const vehicles = layout.fleets.reduce((sum, f) => sum + f.count, 0);
  const parts = [plural(layout.stations.length, 'station'), plural(layout.flows.length, 'flow')];
  if (vehicles) parts.push(plural(vehicles, 'vehicle'));
  return parts.join(' · ');
}

/** Does the store hold something worth continuing with (as opposed to a fresh, untouched empty plant)? */
export function hasWork(state) {
  const l = state.layout;
  return state.dirty || state.project.scenarios.length > 1 || l.stations.length > 0 || l.fleets.length > 0
    || l.obstacles.length > 0 || l.labels.length > 0 || Object.keys(l.roads).length > 0;
}

/** File name for a downloaded project: "two-lines-warehouse.logiplan.json". */
export function projectFileName(name) {
  const slug = String(name ?? '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'logiplan-project'}.logiplan.json`;
}

/** What pasted text probably is: 'empty', 'json' (a project or layout), 'share' (a share link or its payload) or 'unknown'. */
export function classifyProjectText(text) {
  const t = String(text ?? '').trim().replace(/^﻿/, '');
  if (!t) return 'empty';
  if (t[0] === '{' || t[0] === '[') return 'json';
  if (/(^|[#?&\s])p=[zp]\./.test(t) || /^[zp]\.[\w-]/.test(t)) return 'share';
  return 'unknown';
}

/** A share link, as pasted: the link alone (decodeShare also repairs links wrapped over several lines) or inside a sentence. */
async function decodeSharedText(text) {
  try {
    return await decodeShare(text);
  } catch (err) {
    const inSentence = /(?:^|[#?&\s])p=([zp]\.[\w-]+)/.exec(text);
    if (!inSentence) throw err;
    try {
      return await decodeShare(inSentence[1]);
    } catch {
      throw err;
    }
  }
}

/**
 * Read a project from pasted text or the text of a file: JSON of a project or layout, a share link, or just the payload of one.
 * @returns {Promise<object>} the project as importProject returns it
 * @throws {Error} with a message for the planner when the text is none of these
 */
export async function parseProjectText(text) {
  switch (classifyProjectText(text)) {
    case 'json': return importProject(text);
    case 'share': return decodeSharedText(text);
    case 'empty': throw new Error('There is nothing to open yet. Choose a file or paste its text first.');
    default: throw new Error('This does not look like a LogiPlan project file or share link. Project files end in .json.');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Modal primitives
// ---------------------------------------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';

/** Elements inside `root` that Tab can reach, in DOM order. */
function tabbable(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
}

/**
 * The modal primitives: show, confirm and prompt, sharing one stack of open dialogs so that only the top one answers
 * Escape and Tab, and one scroll lock for the whole stack.
 */
function createPrimitives() {
  const stack = [];
  let savedOverflow = null;

  function onKeydown(e) {
    const top = stack[stack.length - 1];
    if (!top) return;
    // the tail of the key press that OPENED the dialog (Enter held a little too long on the control) must not press the button that has the focus now:
    // auto-repeat events of a key that was pressed before the dialog existed are ignored until a fresh press arrives
    if (e.key === 'Enter') {
      if (!e.repeat) top.heldEnter = false;
      else if (top.heldEnter) { e.preventDefault(); e.stopPropagation(); return; }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      top.dismiss();
    } else if (e.key === 'Tab') {
      trapTab(e, top.modal);
    }
  }

  function trapTab(e, modal) {
    const items = tabbable(modal);
    const active = document.activeElement;
    if (!items.length) { e.preventDefault(); modal.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (!modal.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (active === first || active === modal)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  function attach(entry) {
    if (!stack.length) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', onKeydown, true);
    }
    stack.push(entry);
  }

  function detach(entry) {
    stack.splice(stack.indexOf(entry), 1);
    if (stack.length) return;
    document.body.style.overflow = savedOverflow;
    document.removeEventListener('keydown', onKeydown, true);
  }

  /** Where focus starts: the action marked `autofocus`, else the first control of the body, else the primary action, else the dialog. */
  function initialFocus(modal, body, buttons, actions) {
    const marked = actions.findIndex((a) => a.autofocus);
    if (marked >= 0) return buttons[marked];
    const control = tabbable(body)[0];
    if (control) return control;
    const primary = actions.findIndex((a) => a.variant === 'primary' || a.variant === 'danger');
    return primary >= 0 ? buttons[primary] : modal;
  }

  /**
   * Open a dialog.
   * @param {{ title: string, body: Node, actions?: Array<{ label: string, variant?: 'primary'|'danger'|'ghost', icon?: string,
   *   autofocus?: boolean, close?: boolean, disabled?: boolean, onClick?: (handle: object) => (void|boolean|Promise<void|boolean>) }>,
   *   size?: 'sm'|'md'|'lg', leading?: Node, settleMs?: number, onClose?: (reason: 'action'|'dismiss'|'close') => void }} spec
   *   An action closes the dialog after its onClick unless `close: false` or onClick returns false. `leading` sits at the
   *   left of the button row. Escape, the backdrop and the close button dismiss. `settleMs`: for that long after opening, a click on the
   *   backdrop does not dismiss (the second click of a double click on a small control lands there).
   * @returns {{ close: () => void, el: HTMLElement, buttons: HTMLButtonElement[], isOpen: () => boolean }}
   */
  function show({ title, body, actions = [], size = 'md', leading = null, settleMs = 0, onClose = null }) {
    const opener = document.activeElement;
    const armedAt = performance.now() + settleMs;
    const titleId = uid('dialog-title');
    let open = true;
    let reason = 'close';

    const buttons = actions.map((action) => h('button', {
      class: `btn${action.variant ? ` btn--${action.variant}` : ''}`, type: 'button', disabled: action.disabled,
      onclick: () => run(action, buttons[actions.indexOf(action)]),
    }, action.icon ? icon(action.icon, { size: 16 }) : null, action.label));
    const footer = buttons.length || leading ? h('div', { class: 'modal__footer' }, leading, leading ? h('span', { class: 'spacer' }) : null, buttons) : null;
    const modal = h('div', { class: `modal${size === 'sm' ? ' modal--sm' : size === 'lg' ? ' modal--lg' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('div', { class: 'modal__header' },
        h('h2', { class: 'modal__title', id: titleId }, title),
        h('button', { class: 'btn btn--icon btn--sm btn--ghost modal__close', type: 'button', 'aria-label': 'Close', onclick: dismiss }, icon('close', { size: 16 }))),
      h('div', { class: 'modal__body' }, body),
      footer);
    const backdrop = h('div', { class: 'modal-backdrop' }, modal);
    const entry = { modal, dismiss, heldEnter: true };

    // Only a press that starts AND ends on the backdrop closes: selecting text and releasing outside must not.
    let pressedBackdrop = false;
    backdrop.addEventListener('pointerdown', (e) => { pressedBackdrop = e.target === backdrop && performance.now() >= armedAt; });
    backdrop.addEventListener('click', (e) => { if (pressedBackdrop && e.target === backdrop) dismiss(); pressedBackdrop = false; });

    function close() {
      if (!open) return;
      open = false;
      const wasTop = stack[stack.length - 1] === entry;
      detach(entry);
      backdrop.remove();
      // a dialog closed from underneath another one must not pull focus out of the one on top
      if (wasTop && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      if (onClose) onClose(reason);
    }
    function dismiss() {
      reason = 'dismiss';
      close();
    }
    async function run(action, button) {
      button.disabled = true;
      let result;
      try {
        result = action.onClick ? await action.onClick(handle) : undefined;
      } finally {
        if (open) button.disabled = !!action.disabled;
      }
      if (result === false || action.close === false || !open) return;
      reason = 'action';
      close();
    }

    const handle = { close, el: modal, buttons, isOpen: () => open };
    attach(entry);
    document.body.append(backdrop);
    initialFocus(modal, modal.querySelector('.modal__body'), buttons, actions).focus();
    return handle;
  }

  const textBody = (text) => (text instanceof Node ? text : h('p', { style: { margin: 0 } }, text));

  /**
   * Ask a yes/no question. Resolves true only when the confirm button is pressed (Escape, the close button and the backdrop answer no).
   * A dangerous question starts with focus on Cancel.
   */
  function confirm({ title, text, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      let answer = false;
      show({
        title, size: 'sm', body: textBody(text),
        actions: [
          { label: cancelLabel, autofocus: danger },
          { label: confirmLabel, variant: danger ? 'danger' : 'primary', autofocus: !danger, onClick: () => { answer = true; } },
        ],
        onClose: () => resolve(answer),
      });
    });
  }

  /** Ask for one line of text. Resolves with the trimmed text, or null when cancelled. The confirm button waits for some text. */
  function prompt({ title, label, value = '', placeholder, confirmLabel = 'OK', hint }) {
    return new Promise((resolve) => {
      let answer = null;
      const field = textField({ label, value, placeholder, hint, maxLength: 80, onChange: () => sync() });
      const sync = () => { dialog.buttons[1].disabled = field.get().trim() === ''; };
      const submit = () => dialog.buttons[1].click();
      field.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      const dialog = show({
        title, size: 'sm', body: field.el,
        actions: [{ label: 'Cancel' }, { label: confirmLabel, variant: 'primary', onClick: () => { answer = field.get().trim(); } }],
        onClose: () => resolve(answer),
      });
      sync();
      field.input.focus();
      field.input.select();
    });
  }

  return { show, confirm, prompt };
}

// ---------------------------------------------------------------------------------------------------------
// Small building blocks shared by the big dialogs
// ---------------------------------------------------------------------------------------------------------

const heading = (text) => h('h3', { class: 'eyebrow', style: { margin: '0 0 8px' } }, text);
const READING_WIDTH = '78ch';
const paragraph = (...parts) => h('p', { style: { margin: 0, lineHeight: 'var(--lh)', maxWidth: READING_WIDTH } }, ...parts);
const stackOf = (gap, ...children) => h('div', { class: 'stack', style: { '--gap': `${gap}px` } }, ...children);

/** Keyboard-accessible tab strip with its panels. `tabs`: [{ id, label, content: Node }]. Arrow keys move between tabs. */
function createTabs(tabs, initial, ariaLabel) {
  const prefix = uid('tabs');
  const buttons = new Map();
  const panels = new Map();
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': ariaLabel, style: { padding: '0' } });
  const el = h('div', { class: 'stack', style: { '--gap': '16px' } }, list);
  for (const tab of tabs) {
    const button = h('button', {
      class: 'tab', type: 'button', role: 'tab', id: `${prefix}-tab-${tab.id}`, 'aria-controls': `${prefix}-panel-${tab.id}`, 'aria-selected': 'false', tabindex: '-1',
      onclick: () => select(tab.id),
    }, tab.label);
    const panel = h('div', { role: 'tabpanel', id: `${prefix}-panel-${tab.id}`, 'aria-labelledby': button.id, tabindex: '0', hidden: true }, tab.content);
    buttons.set(tab.id, button);
    panels.set(tab.id, panel);
    list.append(button);
    el.append(panel);
  }
  function select(id, focus = false) {
    for (const [key, button] of buttons) {
      const on = key === id;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      panels.get(key).hidden = !on;
    }
    if (focus) buttons.get(id).focus();
  }
  list.addEventListener('keydown', (e) => {
    const ids = tabs.map((t) => t.id);
    const at = ids.findIndex((id) => buttons.get(id) === document.activeElement);
    const move = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (at < 0 || move === undefined) return;
    e.preventDefault();
    select(ids[(move + ids.length) % ids.length], true);
  });
  select(tabs.some((t) => t.id === initial) ? initial : tabs[0].id);
  return { el, select };
}

/** Run `action`, show its progress on `button` and return its result; errors are the caller's business. */
async function whileBusy(button, action) {
  button.disabled = true;
  try {
    return await action();
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------------------------------------

const THUMB_WIDTH_PX = 560;
const thumbnails = new Map(); // `${example id}:${light|dark}` -> data URL, '' when drawing failed (not retried)

/**
 * Preview image of a layout, drawn by a throw-away offscreen Renderer. Cached per example and theme.
 * @returns {string} a PNG data URL, or '' when the browser could not draw it
 */
function thumbnailFor(example, layout, mode) {
  const key = `${example.id}:${mode}`;
  if (thumbnails.has(key)) return thumbnails.get(key);
  let url = '';
  let renderer = null;
  try {
    renderer = new Renderer(document.createElement('canvas'), { camera: new Camera(), theme: mode, dpr: 1 });
    renderer.layout = layout;
    const widthM = layout.grid.cols * layout.grid.cellSize;
    url = renderer.toDataURL({ scale: Math.min(1, THUMB_WIDTH_PX / (widthM * 20)), padding: 0.5 });
  } catch {
    url = '';
  } finally {
    if (renderer) renderer.destroy();
  }
  thumbnails.set(key, url);
  return url;
}

const currentThemeMode = () => resolveThemeMode(document.documentElement.dataset.theme || 'auto');

function exampleCard(example, layout, onPick) {
  const thumb = h('div', { style: { aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: 'var(--text-faint)', borderBottom: '1px solid var(--border)' } }, icon('grid', { size: 28 }));
  const el = h('button', {
    class: 'card card--interactive', type: 'button', onclick: onPick, dataset: { example: example.id },
    style: { display: 'flex', flexDirection: 'column', padding: '0', overflow: 'hidden', textAlign: 'left', font: 'inherit', color: 'inherit' },
  },
  thumb,
  h('div', { class: 'stack', style: { padding: '12px', '--gap': '6px' } },
    h('strong', null, example.name),
    h('span', { class: 'text-dim', title: example.description, style: { fontSize: 'var(--fs-sm)', lineHeight: 'var(--lh)', display: '-webkit-box', WebkitLineClamp: '3', WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, example.description),
    h('span', { class: 'text-faint tnum', style: { fontSize: 'var(--fs-sm)' } }, layoutFacts(layout))));
  return {
    el,
    /** Replace the placeholder icon by the preview image. */
    showPreview(url) {
      if (!url) return;
      thumb.replaceChildren(h('img', { src: url, alt: '', style: { display: 'block', width: '100%', height: '100%', objectFit: 'contain' } }));
      thumb.style.display = 'block';
    },
  };
}

function emptyPlantForm(onCreate) {
  const name = textField({ label: 'Plant name', placeholder: 'Untitled plant', maxLength: 80 });
  const size = segmentedField({
    label: 'Size', value: 'medium', onChange: () => refresh(),
    options: EMPTY_PLANT_SIZES.map((s) => ({ value: s.id, label: s.label, title: `${s.cols} × ${s.rows} cells` })),
  });
  const cell = numberField({ label: 'Metres per cell', unit: 'm', min: GRID_LIMITS.minCell, max: GRID_LIMITS.maxCell, value: 2, onChange: () => refresh() });
  const note = h('p', { class: 'field__hint', 'aria-live': 'polite' });
  const choice = () => EMPTY_PLANT_SIZES.find((s) => s.id === size.get()) || EMPTY_PLANT_SIZES[1];
  function refresh() {
    const s = choice();
    note.textContent = `${s.cols} × ${s.rows} cells = ${plantArea(s.cols, s.rows, cell.get())}. The size can be changed later in the Properties tab.`;
  }
  const button = h('button', {
    class: 'btn btn--primary', type: 'button',
    onclick: () => onCreate({ name: name.get().trim(), cols: choice().cols, rows: choice().rows, cellSize: cell.get() }),
  }, icon('plus', { size: 16 }), 'Create empty plant');
  refresh();
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', alignItems: 'start' } }, name.el, size.el, cell.el);
  note.style.flex = '1 1 240px';
  return stackOf(12, grid, h('div', { class: 'row row--wrap', style: { '--gap': '12px' } }, button, note));
}

const WELCOME_PITCH = 'Plan a factory layout and its in-plant logistics: draw roads and stations on a baseplate, say where loads go and which vehicles carry them, '
  + 'then run the simulation to see where loads wait, vehicles queue and the bottleneck sits. Compare variants on screen before you build anything.';

/** A calm one-tip card with a "Next tip" button (the tips rotate: one per visit, and one per press). */
function tipCard(startIndex) {
  let index = startIndex;
  const title = h('div', { class: 'callout__title' });
  const text = h('div', { class: 'callout__text' });
  const next = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => { index = (index + 1) % WELCOME_TIPS.length; show(); } }, 'Next tip');
  const body = h('div', { class: 'callout__body', style: { flex: '1 1 auto' }, 'aria-live': 'polite', 'aria-atomic': 'true' }, title, text);
  const el = h('div', { class: 'callout callout--info', role: 'group', 'aria-label': 'Tip', dataset: { tip: '' } }, icon('info', { size: 16, class: 'callout__icon' }), body, next);
  function show() {
    const tip = WELCOME_TIPS[index];
    el.dataset.tip = tip.id;
    title.textContent = `Tip: ${tip.title}`;
    text.textContent = tip.text;
  }
  show();
  return el;
}

function openWelcome(ctx, dlg, { auto = false } = {}) {
  if (auto && isWelcomeHidden()) return null;
  const { store } = ctx;
  const state = store.getState();
  let handle = null;
  let replaced = false;

  const cards = EXAMPLES.map((example) => {
    const layout = example.build();
    return { example, layout, card: exampleCard(example, layout, () => pickExample(example)) };
  });
  const sections = [paragraph(WELCOME_PITCH), tipCard(pickWelcomeTip())];
  if (hasWork(state)) {
    sections.push(h('div', { class: 'card card--flat', style: { background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' } },
      h('div', { class: 'card__body row row--wrap' },
        icon('folder', { size: 20 }),
        h('div', { class: 'stack', style: { '--gap': '2px', flex: '1 1 220px', minWidth: 0 } },
          h('strong', null, 'Continue where you left off'),
          h('span', { class: 'text-dim truncate' }, `${state.project.name} · ${layoutFacts(state.layout)}`)),
        h('button', { class: 'btn btn--primary', type: 'button', onclick: () => handle.close() }, 'Continue'))));
  }
  sections.push(
    h('section', { 'aria-label': 'Examples' }, heading('Start from an example'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '12px' } }, cards.map((c) => c.card.el))),
    h('section', { 'aria-label': 'Empty plant' }, heading('Or start with an empty plant'), emptyPlantForm(createEmpty)));

  const hide = h('input', { type: 'checkbox', checked: isWelcomeHidden(), onchange: () => setWelcomeHidden(hide.checked) });
  handle = dlg.show({
    title: 'Welcome to LogiPlan', size: 'lg', body: stackOf(20, ...sections),
    leading: h('label', { class: 'check' }, hide, h('span', null, 'Don’t show this again')),
    actions: [{ label: 'Close' }],
    onClose: () => { if (replaced) focusPlan(ctx); },
  });
  // The tip's button comes first in the dialog, but the first thing to reach for is the way into the plant.
  (handle.el.querySelector('.card .btn--primary') || handle.el.querySelector('[data-example]'))?.focus();
  drawPreviews();

  /** Draw the previews one by one, so the dialog is on screen at once and the pictures appear as they get ready. */
  async function drawPreviews() {
    const mode = currentThemeMode();
    for (const { example, layout, card } of cards) {
      await nextTask();
      if (!handle.isOpen()) return;
      card.showPreview(thumbnailFor(example, layout, mode));
    }
  }

  async function pickExample(example) {
    const result = await ctx.actions.loadExample(example.id);
    if (result === false) return;
    replaced = true;
    handle.close();
  }

  async function createEmpty(spec) {
    if (store.getState().dirty) {
      const ok = await dlg.confirm({
        title: 'Start a new plant?', text: 'The plant you are working on is replaced. Changes you have not exported are lost.', confirmLabel: 'Start new plant', danger: true,
      });
      if (!ok) return;
    }
    store.newProject(createLayout({ name: spec.name || undefined, cols: spec.cols, rows: spec.rows, cellSize: spec.cellSize }), spec.name || undefined);
    ctx.actions.fitView();
    replaced = true;
    handle.close();
    ctx.toast(isTouchOnly() ? 'Empty plant ready. Pick the Road tool below to draw roads, then a station tool to place stations.'
      : 'Empty plant ready. Draw roads with the Road tool (R) and place stations with the keys 1 to 5.', { kind: 'success' });
  }
  return handle;
}

// ---------------------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------------------

const QUICK_START = [
  ['Draw the roads', 'Choose the Road tool (R) and drag across the plan. Vehicles only drive on roads. Use the One-way tool (O) for aisles that run in one direction.'],
  ['Place stations', 'Goods in (1) creates loads, Workstation (2) works on them, Storage (3) holds them, Goods out (4) takes finished loads out of the plant and Parking (5) is where idle vehicles wait and charge. Every station needs a road cell that touches it: that cell is its dock.'],
  ['Say where the loads go', 'Select a station that sends loads and drag the round arrow button beside it onto the station that receives them. Or choose the Flow tool (F), click the sending station and then the receiving one. You can also add flows in the Flows tab. Vehicles are not assigned to stations: every free vehicle serves every flow.'],
  ['Add vehicles', 'Open the Fleet tab and add AGVs, forklifts or a tugger train. Set how many there are, how fast they drive and how many loads they carry.'],
  ['Run it', 'Press Space to play. Vehicles drive, queue and deliver. The Results tab shows throughput, lead time and the bottleneck; the Checks tab lists problems with your plan.'],
  ['Improve and compare', 'Change one thing at a time. Duplicate the scenario tab to keep variants side by side, and use the Experiments tab to compare them or to sweep a value such as the number of vehicles.'],
];

/** Tool rows of the shortcut table: [tool, planner name, what it does]. The key comes from the editor's own key table. */
const TOOL_HELP = [
  ['select', 'Select', 'Click to select, drag to move, drag the edges of a station to resize it, drag over empty ground to select an area.'],
  ['pan', 'Pan', 'Drag to move the view. Holding Space and dragging, or the middle mouse button, does the same with any tool. The wheel zooms.'],
  ['road', 'Road', 'Drag to draw a two-way road. It stays straight on its own (see Drawing roads below); hold Shift for one straight line, Alt to erase.'],
  ['oneway', 'One-way road', 'Drag in the direction vehicles should drive. Draws like the Road tool.'],
  ['speedzone', 'Slow zone', 'Drag over roads to limit the speed in corners, crossings and busy areas. Hold Shift for a straight line. Press Z again for another limit.'],
  ['erase', 'Eraser', 'Drag to erase roads, walls and labels. Hold Shift for a straight line. To remove a station, select it and press Delete.'],
  ['source', 'Goods in', 'Click to place, drag to size. Creates loads on a schedule.'],
  ['process', 'Workstation', 'Click to place, drag to size. Works on loads for a cycle time.'],
  ['storage', 'Storage', 'Click to place, drag to size. Holds loads between steps.'],
  ['sink', 'Goods out', 'Click to place, drag to size. Takes finished loads out of the plant.'],
  ['depot', 'Parking and charging', 'Click to place, drag to size. Idle vehicles park here and charge.'],
  ['obstacle', 'Obstacle', 'Walls, racks and columns that block roads and stations. Press W again for the next type.'],
  ['label', 'Label', 'Click where a text should go.'],
  ['flow', 'Flow', 'Click the sending station, then the receiving one. With Select, drag the round arrow button of a selected station instead.'],
];

/** The draw modes of the stroke tools (editor/strokes.js): [name, what it does]. */
const DRAW_HELP = [
  ['Smart', 'The default. The road follows your pointer but stays straight: a wobble of a cell is ignored, so a drag along an aisle gives a straight aisle. Move two or more cells sideways to turn a corner. Move back along the road to shorten it. Works with a finger too.'],
  ['Straight', 'Hold Shift (or choose Straight in the Draw switch). One straight line from where you started; its direction is fixed as soon as you have dragged a cell and a half and does not change when the pointer swings sideways. Shift+click draws a line from the end of the last road to the clicked cell.'],
  ['Free', 'The road follows every cell the pointer visits, as in a paint program. Use it for diagonals and curves.'],
];

const KEY_TABLE = [
  [['Shift'], 'While drawing a road: one straight line from where you started. Shift+click draws a line from the end of the last road to the clicked cell'],
  [['Ctrl', 'Z'], 'Undo'],
  [['Ctrl', 'Shift', 'Z'], 'Redo (Ctrl+Y works too)'],
  [['Ctrl', 'D'], 'Duplicate the selected stations'],
  [['Ctrl', 'A'], 'Select everything'],
  [['Delete'], 'Delete the selection'],
  [['←', '↑', '→', '↓'], 'Move the selection by one cell (hold Shift for five)'],
  [['Esc'], 'Cancel what you are doing, then clear the selection'],
  [['I'], 'Show or hide the statistics of the selected item (a click on an item opens them too, once the simulation has run a little)'],
  [['[', ']'], 'Select the previous or next item of the same kind and show its statistics'],
  [['Space'], 'Play or pause the simulation (hold it and drag to pan)'],
  [['.'], 'Advance the simulation by one step'],
  [['+', '−'], 'Faster or slower simulation'],
  [['0'], 'Fit the whole plant into view (a double click on empty ground does the same)'],
  [['Ctrl', 'S'], 'Download the project file'],
  [['?'], 'Open this help'],
];

const kbd = (key) => h('kbd', { class: 'kbd' }, key);
/** Table whose last column wraps (the others stay on one line). */
const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
  h('thead', null, h('tr', null, head.map((cell) => h('th', null, cell)))),
  h('tbody', null, rows.map((cells) => h('tr', null, cells.map((cell, i) => h('td', { style: i === cells.length - 1 ? { whiteSpace: 'normal' } : null }, cell)))))));

function quickStartTab() {
  return stackOf(14,
    h('ol', { style: { margin: 0, paddingLeft: '22px', display: 'flex', flexDirection: 'column', gap: '12px', lineHeight: 'var(--lh)', maxWidth: READING_WIDTH } },
      QUICK_START.map(([title, text]) => h('li', null, h('strong', null, `${title}. `), text))),
    callout({ severity: 'info', title: 'Nothing is lost', text: 'Every change can be undone with Ctrl+Z. Your work is saved in this browser automatically. Use Share or Export to give a copy to someone else.' }));
}

function toolsTab() {
  const keyOf = (tool) => Object.keys(TOOL_KEYS).find((k) => TOOL_KEYS[k] === tool);
  return stackOf(20,
    stackOf(8, heading('Tools'),
      table(['Tool', 'Key', 'What it does'], TOOL_HELP.map(([tool, name, text]) => [h('strong', null, name), kbd((keyOf(tool) || '').toUpperCase()), text]))),
    stackOf(8, heading('Drawing roads'),
      table(['Draw mode', 'How the road follows your pointer'], DRAW_HELP.map(([name, text]) => [h('strong', null, name), text])),
      paragraph('The Draw switch over the plan (shown with the Road, One-way, Slow zone and Eraser tools) chooses the mode. A road never goes over a station or wall: it stops in front of it and the rest is shown in red.')),
    stackOf(8, heading('A bigger plan'),
      paragraph('The plan grows with your work. Draw a road, place a station or drag something past the edge of the baseplate: a see-through block shows how much room is added, and when you let go the plan grows by whole blocks of 8 cells (up to 320 × 320 cells). The growth and the edit are one undo step, and nothing on the screen moves.'),
      paragraph('The round + buttons on the four edges add one block, and Properties > Plant settings has the same buttons plus Trim to content. While you drag near the edge of the window, the view scrolls along.')),
    stackOf(8, heading('Other shortcuts'),
      table(['Keys', 'What it does'], KEY_TABLE.map(([keys, text]) => [h('span', { class: 'kbd-group' }, keys.map(kbd)), text]))),
    paragraph('On a touch screen, drag with one finger to use the current tool and with two fingers to pan and pinch to zoom.'));
}

const HOW_IT_WORKS = [
  ['Loads and stations',
    'Goods in stations create loads (pallets, parts) at the interval you set. A load waits in the output buffer of its station until a vehicle collects it; every outgoing flow has its own buffer. '
    + 'When a buffer is full, new arrivals pile up in the yard, which Results shows as a growing backlog. A Workstation starts a cycle as soon as every incoming flow has delivered the loads per cycle it needs '
    + '(an assembly that needs 2 pressed parts and 1 machined part has two incoming flows with 2 and 1). When the cycle is over its output is shared among the outgoing flows by weight; if all output buffers are full the machine is blocked. '
    + 'Storage holds loads up to its capacity and releases them after the minimum dwell time. Goods out takes loads out of the plant: they count as throughput.'],
  ['Docks',
    'Every road cell that touches a station is a dock of that station. To load or unload, a vehicle stops on a dock cell and stays there for the loading or unloading time, blocking that cell meanwhile. '
    + 'A station right on a through road therefore holds up everything behind each stopping vehicle. Give busy stations a short side road (a bay) instead. '
    + 'A station with several docks lets several vehicles work at once: each vehicle drives to the dock where it can start soonest (the drive plus the wait for the vehicles already there or on their way), so a free dock is used before a busy one that is a little closer, but not before one that is only slightly busier: the way there and back counts too. Results lists the docks of a station with their visits and how busy they were.'],
  ['One-way roads',
    'On a one-way road vehicles only drive in the direction of the arrows. Vehicles never turn around in the middle of a road: they reverse only at a dead end. '
    + 'So a vehicle must be able to reach a station and also to get back out again; the Checks tab warns about stations that cannot be reached and about one-way dead ends. Two parallel roads are not connected unless you link them.'],
  ['Junctions',
    'Where roads merge, cross or end, only one vehicle may be inside the junction cell at a time, the first to arrive going first. A vehicle only enters when it can drive on and clear the cell completely, so a queue never blocks a junction. '
    + 'On plain straight or curved roads vehicles simply follow each other with a safety gap and slow down in corners.'],
  ['Who drives where (dispatch)',
    'A flow needs transport when loads are ready at its start and there is room at its destination. Whenever vehicles are free, they are matched with the flows that need transport. Higher priority goes first (Urgent, High, Normal); '
    + 'a flow whose loads have waited a long time moves up a level, so nothing starves. Within the same priority the strategy decides: nearest job first, oldest job first, or a balance of both. '
    + 'A vehicle takes as many loads as it can carry, or the largest batch of the flow if that is smaller, but only leaves once the smallest batch is ready or the longest wait has passed. A flow can be restricted to one fleet. '
    + 'Vehicles without work park in a depot or stay on the road, as set for their fleet.'],
  ['Queues and deadlocks',
    'A vehicle that cannot move because of another vehicle or a junction is waiting. A broken-down vehicle blocks its lane until it is repaired, and the others queue behind it. '
    + 'When vehicles wait for each other in a circle for about 20 seconds, that is a deadlock: by default one vehicle is moved to a free spot and the deadlock is counted; choose "Let the jam stand" under Deadlock handling in the Simulate tab to see the gridlock as it would happen. '
    + 'Deadlocks are a sign to change the layout: add bays, use one-way loops or use fewer vehicles.'],
  ['Batteries and parking',
    'With the battery model on, vehicles use charge while they drive, load, unload or wait on the road (a fifth as much while standing idle on the road, none while parked). '
    + 'When a free vehicle falls below its "go charging" level it drives to a depot with a free charger, charges up to its "back to work" level and rejoins. A vehicle that runs completely flat stops where it is and blocks its lane.'],
  ['What the numbers mean',
    'Throughput is the number of loads that leave through Goods out per hour. Lead time is how long a load needs from its arrival to leaving the plant (mean and 95th percentile). Work in process is the number of loads in the plant right now. '
    + 'Utilization is the share of time a workstation or vehicle is working. The waiting share is the part of the driving time vehicles spend stuck in traffic. Empty driving is the share of the distance driven without a load. '
    + 'The bottleneck is the workstation that is busy almost all the time while loads queue in front of it or the stations behind it wait for material: it sets the limit for the whole plant. Results only count after the warm-up time.'],
  ['After you change the plant',
    'When you change the plant while the simulation has been running, the changed plant is first simulated silently for about 20 minutes and then replaces the old one, so Results show numbers at once instead of starting from an empty plant. '
    + 'The card "Effect of your change" at the top of Results simulates the old plant once more next to the new one, for the same 10 minutes and with the same random seed, and puts the figures side by side. It is a quick indication from one run each, so small differences are not coloured; "Compare properly" adds the old plant as a variant and runs both several times in the Experiments tab. '
    + 'Vehicles that hardly get a job are marked in the Fleet tab ("no jobs", "barely used", "some idle" or "mostly idle"). Switch "Keep results warm after edits" off in the Simulate tab to start from an empty plant after every change; the reset button always does.'],
  ['Repeatable results',
    'The simulation uses a random seed. The same plant with the same seed always gives identical results. Change the seed in the Simulate tab to see how much the results vary, or run several replications in the Experiments tab and look at the average.'],
];

function simulationTab() {
  return stackOf(16, ...HOW_IT_WORKS.map(([title, text]) => stackOf(4, h('h3', { style: { margin: 0, fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' } }, title), paragraph(text))));
}

const TIPS = [
  'Adding a second Goods in? Select it and pick a destination under "Where do loads go?". Every Goods in needs a flow of its own; the vehicles you already have serve it automatically.',
  'Give every busy station its own short side road (a bay), so a vehicle loading there does not block the aisle.',
  'Start with one or two vehicles and add more only while the Results tab shows loads waiting for transport. In narrow aisles more vehicles can even lower the output.',
  'One-way loops calm narrow aisles, but keep every station reachable and make sure vehicles can find their way back.',
  'Switch the heat map to "waiting" to see where queues form, or to "traffic" to see the busiest roads.',
  'While the simulation runs, the Jobs display option draws a line from each vehicle to the station it is heading for (amber to pick up, blue to deliver) and a badge "n waiting" on stations whose loads no vehicle has claimed yet.',
  'Open the Checks tab before you run: it finds stations without a dock, unreachable stations and fleets that cannot charge.',
  'Duplicate the scenario tab before a big change, then compare the variants in the Experiments tab.',
  'Hold Shift while you draw a road for one straight line. Shift+click carries on from the end of the last road.',
  'Use slow zones (Z) for corners, crossings and areas where people walk.',
  'Raise "Demand" in the Simulate tab to see what happens with 20 % more volume.',
  'Speed the clock up to see hours pass in minutes, and step to watch single moves.',
  'A share link contains the whole plant and uploads nothing. For very large plants, send the project file instead.',
];

function tipsTab() {
  return h('ul', { style: { margin: 0, paddingLeft: '22px', display: 'flex', flexDirection: 'column', gap: '10px', lineHeight: 'var(--lh)', maxWidth: READING_WIDTH } }, TIPS.map((tip) => h('li', null, tip)));
}

function openHelp(dlg, { tab } = {}, onAbout = null) {
  const tabs = createTabs([
    { id: 'quick', label: 'Quick start', content: quickStartTab() },
    { id: 'tools', label: 'Tools & shortcuts', content: toolsTab() },
    { id: 'vehicles', label: 'How vehicles find work', content: createVehiclesHelp() },
    { id: 'trucks', label: 'Trucks and dock doors', content: createTrucksHelp() },
    { id: 'statistics', label: 'Statistics of an item', content: createStatsHelp() },
    { id: 'simulation', label: 'How the simulation works', content: simulationTab() },
    { id: 'tips', label: 'Tips', content: tipsTab() },
  ], tab, 'Help topics');
  // The way to the version and "what is new" that never goes away: on a phone held sideways the status line (where the version chip sits) is hidden
  const about = onAbout ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'data-role': 'help-about', onclick: () => { handle.close(); onAbout(); } }, icon('info', { size: 14 }), 'About and what is new') : null;
  const handle = dlg.show({ title: 'Help', size: 'lg', body: tabs.el, leading: about, actions: [{ label: 'Close', variant: 'primary' }] });
  return handle;
}

// ---------------------------------------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------------------------------------

/** Put `text` on the clipboard; falls back to selecting `input` and the old copy command. True when it worked. */
async function copyToClipboard(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    input.select();
    input.setSelectionRange(0, text.length);
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

/** Download the whole project as a file and mark it as saved. */
function downloadProject(ctx) {
  const { project } = ctx.store.getState();
  downloadFile(projectFileName(project.name), exportProject(project), 'application/json');
  ctx.store.markClean();
}

function openShare(ctx, dlg) {
  const { store } = ctx;
  const status = h('div', { 'aria-live': 'polite', class: 'stack', style: { '--gap': '12px' } }, h('span', { class: 'text-dim' }, 'Creating the link…'));
  const body = stackOf(14,
    paragraph('Anyone with this link can open a copy of your project in their browser. Nothing is uploaded: the whole plant is inside the link.'),
    status);
  const handle = dlg.show({
    title: 'Share this plant', body,
    actions: [
      { label: 'Download project file', icon: 'download', close: false, onClick: () => downloadProject(ctx) },
      { label: 'Done', variant: 'primary' },
    ],
  });
  buildLink();

  async function buildLink() {
    let url;
    try {
      url = await shareUrl(location.href.split('#')[0], store.getState().project);
    } catch (err) {
      status.replaceChildren(callout({ severity: 'error', title: 'The link could not be created', text: err.message || 'Please download the project file instead.' }));
      return;
    }
    if (!handle.isOpen()) return;
    const field = textField({ label: 'Link to this project', value: url });
    field.input.readOnly = true;
    field.input.addEventListener('focus', () => field.input.select());
    const copied = h('span', { class: 'text-dim', role: 'status', style: { fontSize: 'var(--fs-sm)' } });
    const copy = h('button', {
      class: 'btn btn--primary', type: 'button',
      onclick: async () => {
        const ok = await copyToClipboard(url, field.input);
        copied.textContent = ok ? 'Link copied.' : 'Press Ctrl+C to copy the selected link.';
        if (ok) store.markClean();
      },
    }, icon('copy', { size: 16 }), 'Copy link');
    const length = h('p', { class: 'field__hint' }, `The link is ${formatNumber(url.length)} characters long.`);
    const tooLong = url.length > SHARE_LINK_WARN
      ? callout({ severity: 'warning', title: 'This link is very long', text: 'Some chat and e-mail apps cut long links, so it may not open for the other person. Download the project file and send that instead.' })
      : null;
    status.replaceChildren(
      h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, field.el), copy),
      copied, length, ...(tooLong ? [tooLong] : []));
    field.input.focus();
    field.input.select();
    field.input.scrollLeft = 0; // select() scrolls to the end of the text; show the start of the link
  }
  return handle;
}

// ---------------------------------------------------------------------------------------------------------
// Import and export
// ---------------------------------------------------------------------------------------------------------

const MAX_FILE_BYTES = 25e6;

function openImportExport(ctx, dlg) {
  const { store } = ctx;
  let opened = false;
  const status = h('div', { 'aria-live': 'polite' });
  const showError = (text) => status.replaceChildren(callout({ severity: 'error', title: 'This could not be opened', text }));

  async function openText(text) {
    status.replaceChildren();
    let project;
    try {
      project = await parseProjectText(text);
    } catch (err) {
      showError(err.message || 'The text could not be read.');
      return;
    }
    if (store.getState().dirty) {
      const ok = await dlg.confirm({
        title: 'Open this project?', text: 'It replaces the project you are working on. Changes you have not exported are lost.', confirmLabel: 'Open project', danger: true,
      });
      if (!ok) return;
    }
    store.loadProject(project);
    ctx.actions.fitView();
    opened = true;
    handle.close();
    ctx.toast(`Opened ${quoted(project.name)} with ${plural(project.scenarios.length, 'scenario')}.`, { kind: 'success' });
    if (project.warnings) ctx.toast(project.warnings.join(' '), { kind: 'warn', ms: 9000 });
  }

  async function openFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { showError('This file is far too large to be a LogiPlan project.'); return; }
    let text;
    try {
      text = await file.text();
    } catch {
      showError('The file could not be read. Please try again.');
      return;
    }
    await openText(text);
  }

  const zone = importZone(openFile);
  const pasted = textField({
    label: 'Or paste the project text or a share link', multiline: true, rows: 4, placeholder: '{ "app": "logiplan", … }  or  https://…#p=…',
  });
  const readPasted = h('button', { class: 'btn', type: 'button', onclick: () => whileBusy(readPasted, () => openText(pasted.get())) }, 'Open pasted text');
  const { project } = store.getState();
  const body = stackOf(20,
    stackOf(8, heading('Save'),
      paragraph(`Download ${quoted(project.name)} with ${plural(project.scenarios.length, 'scenario')} as one file. Open it later, on any computer, in the Open section below.`),
      h('div', null, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => downloadProject(ctx) }, icon('download', { size: 16 }), 'Download project file'))),
    stackOf(8, heading('Open'), zone, pasted.el, h('div', null, readPasted), status));
  const handle = dlg.show({ title: 'Import and export', body, actions: [{ label: 'Close' }], onClose: () => { if (opened) focusPlan(ctx); } });
  return handle;
}

/** Drop zone with a "Choose a file" button; calls `onFile(File)` for a dropped or chosen file. */
function importZone(onFile) {
  const input = h('input', { type: 'file', accept: '.json,.logiplan,application/json', hidden: true, 'aria-label': 'Project file', onchange: () => { onFile(input.files[0]); input.value = ''; } });
  const choose = h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, icon('folder', { size: 16 }), 'Choose a file');
  const zone = h('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '20px 16px', textAlign: 'center', border: '2px dashed var(--control-border)', borderRadius: 'var(--radius-lg)', color: 'var(--text-dim)' },
  }, icon('upload', { size: 24 }), h('strong', { style: { color: 'var(--text)' } }, 'Drop a project file here'), h('span', null, 'or'), choose, input);
  const highlight = (on) => {
    zone.style.borderColor = on ? 'var(--accent)' : 'var(--control-border)';
    zone.style.background = on ? 'var(--accent-soft)' : '';
  };
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); highlight(true); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; highlight(true); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) highlight(false); });
  zone.addEventListener('drop', (e) => { e.preventDefault(); highlight(false); onFile(e.dataTransfer.files[0]); });
  return zone;
}

// ---------------------------------------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------------------------------------

/**
 * Create the dialogs of the app (`ctx.dialogs`).
 * @param {object} ctx the shared context (docs/ARCHITECTURE.md 6.8): store, toast, actions.{loadExample, fitView}
 */
export function createDialogs(ctx) {
  const dlg = createPrimitives();
  return {
    show: dlg.show,
    confirm: dlg.confirm,
    prompt: dlg.prompt,
    openWelcome: (options) => openWelcome(ctx, dlg, options),
    openHelp: (options) => openHelp(dlg, options, () => openAbout(ctx, dlg)),
    openShare: () => openShare(ctx, dlg),
    openImportExport: () => openImportExport(ctx, dlg),
    openAbout: (options) => openAbout(ctx, dlg, options),
  };
}

