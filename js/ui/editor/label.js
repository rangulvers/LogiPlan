// Free text labels on the plant: the label tool (click to add) and the inline text box used for it and for editing a
// label by double-click. The box is a small popover with the kit's text field, floating over the canvas.

import { h } from '../../util/dom.js';
import { textField } from '../panels/fields.js';
import { addLabel } from '../../model/layout.js';

const LABEL_MAX = 200;

/**
 * Open a one-line text box at screen position (x, y) (viewport pixels). Enter confirms; Esc cancels; leaving the box
 * confirms when it holds text and cancels when it is empty.
 * @param {Document} doc
 * @param {{ x: number, y: number, value?: string, onSubmit: (text: string) => void, onCancel?: () => void }} opts
 * @returns {{ close: () => void }} close() removes the box without confirming
 */
export function openTextBox(doc, { x, y, value = '', onSubmit, onCancel }) {
  const field = textField({ value, placeholder: 'Label text', maxLength: LABEL_MAX, hint: 'Enter to confirm, Esc to cancel' });
  field.input.setAttribute('aria-label', 'Label text');
  const el = h('div', { class: 'popover', role: 'group', 'aria-label': 'Edit label', style: { position: 'fixed', left: `${x}px`, top: `${y}px`, zIndex: 'var(--z-float)', width: '240px' } }, field.el);
  let open = true;

  const close = () => {
    if (!open) return;
    open = false;
    el.remove();
  };
  const finish = (confirm) => {
    if (!open) return;
    const text = field.get().trim();
    close();
    if (confirm && text) onSubmit(text);
    else onCancel?.();
  };

  field.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  field.input.addEventListener('blur', () => finish(true));
  doc.body.append(el);
  const view = doc.defaultView;
  const box = el.getBoundingClientRect();
  if (view && box.right > view.innerWidth - 8) el.style.left = `${Math.max(8, view.innerWidth - box.width - 8)}px`;
  if (view && box.bottom > view.innerHeight - 8) el.style.top = `${Math.max(8, y - box.height - 8)}px`;
  field.input.focus();
  field.input.select();
  return { close };
}

/** The label tool: a click opens the text box at the pointer; confirming adds the label there (snapped to half cells). */
export function createLabelTool(ed) {
  return {
    busy: () => false,
    down() {
      return true;
    },
    move() {},
    up(p) {
      const grid = ed.layout().grid;
      const at = { x: Math.min(grid.cols, Math.max(0, Math.round(p.ux * 2) / 2)), y: Math.min(grid.rows, Math.max(0, Math.round(p.uy * 2) / 2)) };
      ed.editText({
        clientX: p.clientX,
        clientY: p.clientY,
        onSubmit: (text) => {
          let id = null;
          const ok = ed.commit('Add label', (draft) => {
            const label = addLabel(draft, { ...at, text });
            id = label ? label.id : null;
            return id !== null;
          });
          if (ok) ed.setSelection({ kind: 'label', ids: [id] });
        },
      });
    },
    cancel() {},
    hover(p) {
      ed.view.hover = { kind: 'cell', cell: p.cell };
      ed.hoverStatus(p);
    },
  };
}
