// Keyboard mapping of the canvas editor: which key events it reacts to and what they mean. Pure functions on plain
// event-like objects (so Node can test them), plus the two DOM guards that decide whether a key press belongs to us.

import { TOOL_KEYS } from './tools.js';

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Is the event target a place where the user types (so editor shortcuts must stay out of the way)? */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  return TYPING_TAGS.has(target.tagName) || target.isContentEditable === true;
}

const OPERATED_CONTROLS = 'button, a[href], summary, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="menuitemradio"], [role="option"]';

/**
 * Is the target a control the planner is operating with the keyboard (a button, a link, a tab, a switch ...)? Delete, Backspace and the arrow keys then
 * belong to that control and never to the selection on the plan: Tab to "Delete row 3" of a timetable and press Delete must not delete the station.
 * (Typing places are `isTypingTarget`; the tool letters and Ctrl shortcuts keep working from a button, as they always did.)
 */
export function isOperatedControl(target) {
  return !!target && typeof target === 'object' && typeof target.closest === 'function' && target.closest(OPERATED_CONTROLS) !== null;
}

/** The keys that act on the SELECTION of the plan without a modifier: they are ignored while a control of the page has the focus (isOperatedControl). */
export const isSelectionEdit = (command) => !!command && (command.cmd === 'delete' || command.cmd === 'nudge');

/** Is a modal dialog open? Shortcuts are ignored behind it. */
export const dialogOpen = (doc) => !!doc && doc.querySelector('[role="dialog"]') !== null;

/**
 * What a key press means to the editor, or null if it is none of our business.
 * Browser shortcuts are left alone: with Ctrl/Cmd only Z, Y, D and A are ours; Alt combinations never are.
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean }} e
 * @returns {null | { cmd: 'undo'|'redo'|'duplicate'|'selectAll'|'delete'|'escape' } | { cmd: 'tool', tool: string } | { cmd: 'nudge', dx: number, dy: number }}
 */
export function keyCommand(e) {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return commandWithModifier(key, e.shiftKey);
  if (key === 'Escape') return { cmd: 'escape' };
  if (key === 'Delete' || key === 'Backspace') return { cmd: 'delete' };
  const arrow = ARROW_STEPS[key];
  if (arrow) {
    const n = e.shiftKey ? 5 : 1;
    return { cmd: 'nudge', dx: arrow[0] * n, dy: arrow[1] * n };
  }
  return Object.hasOwn(TOOL_KEYS, key) ? { cmd: 'tool', tool: TOOL_KEYS[key] } : null;
}

const ARROW_STEPS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function commandWithModifier(key, shift) {
  if (key === 'z') return { cmd: shift ? 'redo' : 'undo' };
  if (key === 'y' && !shift) return { cmd: 'redo' };
  if (key === 'd' && !shift) return { cmd: 'duplicate' };
  if (key === 'a' && !shift) return { cmd: 'selectAll' };
  return null;
}
