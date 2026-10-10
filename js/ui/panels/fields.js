// Shared form-field builders for the side panels and dialogs (browser only).
// Built on the UI-kit classes in docs/UI-KIT.md. Every builder returns a control object:
//   { el, input?, set(value), get(), setDisabled(bool) }
// so a panel can build its form ONCE and then call control.set(newValue) on every store update.
// Golden rule baked in here: set() never overwrites a field the user is currently typing in.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';

let uidCounter = 0;
/** Unique DOM id for label/for wiring. */
export const uid = (prefix = 'fld') => `${prefix}-${++uidCounter}`;

const isFocused = (el) => typeof document !== 'undefined' && document.activeElement === el;

function fieldShell({ id, label, hint, inline, controlW, valueText }) {
  const hintEl = hint ? h('p', { class: 'field__hint' }, hint) : null;
  const errorEl = h('p', { class: 'field__error', role: 'alert', hidden: true });
  const valueEl = valueText != null ? h('span', { class: 'field__value' }, valueText) : null;
  const labelEl = label ? h('label', { class: 'field__label', for: id }, label) : null;
  const head = valueEl ? h('div', { class: 'field__head' }, labelEl, valueEl) : labelEl;
  const el = h('div', { class: inline ? 'field field--inline' : 'field', style: controlW ? { '--control-w': controlW } : null }, head);
  return { el, hintEl, errorEl, valueEl };
}

function showError(shell, input, message) {
  const invalid = !!message;
  shell.el.classList.toggle('is-invalid', invalid);
  input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  shell.errorEl.textContent = message || '';
  shell.errorEl.hidden = !invalid;
  if (shell.hintEl) shell.hintEl.hidden = invalid;
  const group = input.closest('.input-group');
  if (group) group.classList.toggle('is-invalid', invalid);
}

/** Format a number for an input without float noise ("0.30000000000000004" -> "0.3"). */
export function fmt(v, maxDigits = 6) {
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 10 ** maxDigits) / 10 ** maxDigits);
}

/**
 * Number input with optional unit. `onChange(value)` fires on every VALID edit (live, so sliders/steppers
 * feel immediate; the caller should commit with a `coalesce` key). Invalid text shows an inline error and
 * is reverted on blur. opts: { label, hint, unit, value, min, max, step, int, inline, controlW, onChange, placeholder }.
 */
export function numberField(opts) {
  const { label, hint, unit, min = -Infinity, max = Infinity, step = 'any', int = false, inline = false, onChange, placeholder } = opts;
  const id = uid();
  const shell = fieldShell({ id, label, hint, inline, controlW: opts.controlW });
  let last = Number.isFinite(opts.value) ? opts.value : 0;
  const input = h('input', { class: 'input tnum', id, type: 'number', min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null, step, inputmode: int ? 'numeric' : 'decimal', placeholder, value: fmt(last) });
  const control = unit ? h('div', { class: 'input-group' }, input, h('span', { class: 'input-unit' }, unit)) : input;
  shell.el.append(control);
  if (shell.hintEl) shell.el.append(shell.hintEl);
  shell.el.append(shell.errorEl);

  const validate = (raw) => {
    if (raw === '' || raw == null) return { error: 'Enter a number.' };
    const v = Number(raw);
    if (!Number.isFinite(v)) return { error: 'Enter a number.' };
    if (int && !Number.isInteger(v)) return { error: 'Must be a whole number.' };
    if (v < min || v > max) {
      const range = Number.isFinite(min) && Number.isFinite(max) ? `between ${fmt(min)} and ${fmt(max)}` : Number.isFinite(min) ? `at least ${fmt(min)}` : `at most ${fmt(max)}`;
      return { error: `Must be ${range}.` };
    }
    return { value: v };
  };

  input.addEventListener('input', () => {
    const r = validate(input.value);
    showError(shell, input, r.error);
    if (r.value !== undefined) { last = r.value; onChange?.(r.value); }
  });
  input.addEventListener('change', () => {
    const r = validate(input.value);
    if (r.error) { input.value = fmt(last); showError(shell, input, null); }
  });

  return {
    el: shell.el,
    input,
    set(v) {
      if (!Number.isFinite(v)) return;
      last = v;
      if (!isFocused(input)) { input.value = fmt(v); showError(shell, input, null); }
    },
    get: () => last,
    setDisabled(d) { input.disabled = !!d; },
  };
}

/** Dropdown. options: [{ value, label, disabled? }]; values may be strings or numbers (compared as strings). */
export function selectField(opts) {
  const { label, hint, options, inline = false, onChange } = opts;
  const id = uid();
  const shell = fieldShell({ id, label, hint, inline, controlW: opts.controlW });
  const select = h('select', { class: 'input', id });
  const typeOf = new Map();
  const fill = (list) => {
    select.replaceChildren(...list.map((o) => { typeOf.set(String(o.value), typeof o.value); return h('option', { value: String(o.value), disabled: o.disabled }, o.label); }));
  };
  fill(options);
  select.addEventListener('change', () => onChange?.(typeOf.get(select.value) === 'number' ? Number(select.value) : select.value));
  shell.el.append(select);
  if (shell.hintEl) shell.el.append(shell.hintEl);
  const control = {
    el: shell.el,
    input: select,
    set(v) { if (!isFocused(select)) select.value = String(v ?? ''); },
    get: () => (typeOf.get(select.value) === 'number' ? Number(select.value) : select.value),
    setOptions(list, value) { fill(list); if (value !== undefined) select.value = String(value); },
    setDisabled(d) { select.disabled = !!d; },
  };
  if (opts.value !== undefined) control.set(opts.value);
  return control;
}

/** Single- or multi-line text. onChange fires on input (live). */
export function textField(opts) {
  const { label, hint, placeholder, multiline = false, maxLength, inline = false, onChange } = opts;
  const id = uid();
  const shell = fieldShell({ id, label, hint, inline, controlW: opts.controlW });
  const input = multiline
    ? h('textarea', { class: 'input', id, rows: opts.rows || 3, placeholder, maxlength: maxLength })
    : h('input', { class: 'input', id, type: 'text', placeholder, maxlength: maxLength, autocomplete: 'off', spellcheck: 'false' });
  input.value = opts.value ?? '';
  input.addEventListener('input', () => onChange?.(input.value));
  shell.el.append(input);
  if (shell.hintEl) shell.el.append(shell.hintEl);
  return {
    el: shell.el,
    input,
    set(v) { if (!isFocused(input)) input.value = v ?? ''; },
    get: () => input.value,
    setDisabled(d) { input.disabled = !!d; },
  };
}

/** Keep the kit's range fill + bubble in sync (see docs/UI-KIT.md 3.4). */
export function syncRange(wrap, format = String) {
  const input = wrap.querySelector('input');
  const span = Number(input.max) - Number(input.min);
  wrap.style.setProperty('--p', span > 0 ? (Number(input.value) - Number(input.min)) / span : 0);
  wrap.dataset.value = format(Number(input.value));
}

/**
 * Slider with live value readout and optional reset-to-default. opts: { label, hint, min, max, step, value,
 * format(v) -> string, resetValue, onChange(v) }.
 */
export function rangeField(opts) {
  const { label, hint, min, max, step, format = (v) => String(v), resetValue, onChange } = opts;
  const id = uid();
  const shell = fieldShell({ id, label, hint, valueText: format(opts.value ?? min) });
  const input = h('input', { id, type: 'range', min, max, step, value: opts.value ?? min });
  const wrap = h('div', { class: 'range' }, input);
  const reset = resetValue !== undefined
    ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Reset ${label || 'value'}`, onclick: () => { control.set(resetValue, true); onChange?.(resetValue); } }, icon('reset', { size: 14 }), 'Reset')
    : null;
  const refresh = () => {
    syncRange(wrap, format);
    shell.valueEl.textContent = format(Number(input.value));
    if (reset) reset.hidden = Math.abs(Number(input.value) - resetValue) < 1e-9;
  };
  input.addEventListener('input', () => { refresh(); onChange?.(Number(input.value)); });
  shell.el.append(wrap);
  if (reset) shell.el.append(h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, reset));
  if (shell.hintEl) shell.el.append(shell.hintEl);
  const control = {
    el: shell.el,
    input,
    set(v, force = false) { if (force || !isFocused(input)) { input.value = v; refresh(); } },
    get: () => Number(input.value),
    setDisabled(d) { input.disabled = !!d; },
  };
  refresh();
  return control;
}

/** On/off switch. opts: { label, hint, checked, onChange(bool) }. */
export function switchField(opts) {
  const { label, hint, onChange } = opts;
  const input = h('input', { class: 'switch__input', type: 'checkbox', checked: !!opts.checked });
  const el = h('div', { class: 'field' },
    h('label', { class: 'switch' }, input, h('span', { class: 'switch__track' }), h('span', null, label)),
    hint ? h('p', { class: 'field__hint' }, hint) : null);
  input.addEventListener('change', () => onChange?.(input.checked));
  return { el, input, set(v) { input.checked = !!v; }, get: () => input.checked, setDisabled(d) { input.disabled = !!d; } };
}

/** Segmented choice. opts: { label, options: [{ value, label, title? }], value, onChange(value), block } */
export function segmentedField(opts) {
  const { label, options, onChange, block = true } = opts;
  const buttons = new Map();
  const group = h('div', { class: `segmented${block ? ' segmented--block' : ''}`, role: 'group', 'aria-label': label || 'Options' },
    options.map((o) => {
      const b = h('button', { class: 'segmented__item', type: 'button', 'aria-pressed': 'false', title: o.title, onclick: () => { control.set(o.value); onChange?.(o.value); } }, o.label);
      buttons.set(o.value, b);
      return b;
    }));
  let current;
  const control = {
    el: h('div', { class: 'field' }, label ? h('span', { class: 'field__label' }, label) : null, group),
    set(v) { current = v; for (const [val, b] of buttons) b.setAttribute('aria-pressed', val === v ? 'true' : 'false'); },
    get: () => current,
    setDisabled(d) { for (const b of buttons.values()) b.disabled = !!d; },
  };
  control.set(opts.value);
  return control;
}

/** [-] n [+] integer stepper. opts: { label, hint, value, min, max, step, inline, onChange(n) } */
export function stepperField(opts) {
  const { label, hint, min = 0, max = 999, step = 1, inline = true, onChange } = opts;
  const id = uid();
  const shell = fieldShell({ id, label, hint, inline, controlW: opts.controlW });
  let last = opts.value ?? min;
  const input = h('input', { class: 'stepper__input tnum', id, type: 'number', min, max, step, value: String(last), inputmode: 'numeric' });
  const apply = (v, notify = true) => {
    const c = Math.min(max, Math.max(min, Math.round(v)));
    last = c;
    input.value = String(c);
    if (notify) onChange?.(c);
  };
  const dec = h('button', { class: 'stepper__btn', type: 'button', 'aria-label': `Decrease ${label || ''}`.trim(), onclick: () => apply(last - step) }, icon('minus', { size: 14 }));
  const inc = h('button', { class: 'stepper__btn', type: 'button', 'aria-label': `Increase ${label || ''}`.trim(), onclick: () => apply(last + step) }, icon('plus', { size: 14 }));
  input.addEventListener('input', () => { const v = Number(input.value); if (input.value !== '' && Number.isFinite(v) && v >= min && v <= max) { last = Math.round(v); onChange?.(last); } });
  input.addEventListener('change', () => { // leaving the field: an out-of-range number ends at the nearest limit AND is stored ("33" doors ends at 32, not at the "3" typed first)
    const before = last;
    const c = Math.min(max, Math.max(min, Math.round(Number(input.value) || last)));
    apply(c, c !== before);
  });
  shell.el.append(h('div', { class: 'stepper' }, dec, input, inc));
  if (shell.hintEl) shell.el.append(shell.hintEl);
  return {
    el: shell.el,
    input,
    set(v) { if (Number.isFinite(v)) { last = v; if (!isFocused(input)) input.value = String(v); } },
    get: () => last,
    setDisabled(d) { input.disabled = dec.disabled = inc.disabled = !!d; },
  };
}

const DIST_LABELS = [
  { value: 'const', label: 'Constant' },
  { value: 'normal', label: 'Normal (bell curve)' },
  { value: 'uniform', label: 'Uniform (min–max)' },
  { value: 'exp', label: 'Exponential (random arrivals)' },
];

/** Human text for a time in seconds, e.g. 150 -> "2.5 min". */
export function humanSeconds(s) {
  if (!Number.isFinite(s)) return '';
  if (s < 90) return `${fmt(s, 1)} s`;
  if (s < 5400) return `${fmt(s / 60, 1)} min`;
  return `${fmt(s / 3600, 2)} h`;
}

/**
 * Time-distribution editor: { kind, mean (s), spread (0..1) }. onChange(dist) with a complete new object.
 * opts: { label, hint, value, onChange }.
 */
export function distField(opts) {
  const { label, hint, onChange } = opts;
  let dist = { kind: 'const', mean: 60, spread: 0, ...(opts.value || {}) };
  const emit = () => onChange?.({ ...dist });
  const kind = selectField({ label: 'Variation', options: DIST_LABELS, value: dist.kind, onChange: (k) => { dist = { ...dist, kind: k, spread: k === 'normal' || k === 'uniform' ? (dist.spread || 0.1) : 0 }; refresh(); emit(); } });
  const mean = numberField({ label: 'Average', unit: 's', min: 0.1, max: 1e6, value: dist.mean, onChange: (v) => { dist = { ...dist, mean: v }; refreshHint(); emit(); } });
  const spread = numberField({ label: 'Spread', unit: '%', min: 0, max: 100, value: Math.round(dist.spread * 100), onChange: (v) => { dist = { ...dist, spread: v / 100 }; emit(); } });
  const hintEl = h('p', { class: 'field__hint' });
  const labelEl = label ? h('span', { class: 'field__label' }, label) : null;
  const el = h('div', { class: 'stack', style: { '--gap': '8px' } }, labelEl, kind.el, h('div', { class: 'field-grid' }, mean.el, spread.el), hintEl);
  function refreshHint() {
    const parts = [hint, `Average ${humanSeconds(dist.mean)}`].filter(Boolean);
    hintEl.textContent = parts.join(' · ');
  }
  function refresh() {
    spread.el.hidden = !(dist.kind === 'normal' || dist.kind === 'uniform');
    refreshHint();
  }
  refresh();
  return {
    el,
    set(v) {
      if (!v) return;
      dist = { kind: v.kind || 'const', mean: v.mean ?? 60, spread: v.spread ?? 0 };
      kind.set(dist.kind); mean.set(dist.mean); spread.set(Math.round(dist.spread * 100));
      refresh();
    },
    get: () => ({ ...dist }),
    setDisabled(d) { kind.setDisabled(d); mean.setDisabled(d); spread.setDisabled(d); },
  };
}

/** Collapsible group. opts: { title, aside, open } ; children appended to .section__body (returned as `body`). */
export function section({ title, aside, open = true }, ...children) {
  const asideEl = h('span', { class: 'section__aside' }, aside || '');
  const body = h('div', { class: 'section__body stack', style: { '--gap': '12px' } }, ...children);
  const el = h('details', { class: 'section', open }, h('summary', { class: 'section__header' }, icon('chevron-right', { size: 14, class: 'section__chevron' }), title, asideEl), body);
  return { el, body, setAside(text) { asideEl.textContent = text || ''; } };
}

/** Two-column key/value list from [[key, value], ...]. */
export function kvList(pairs) {
  return h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

/** Small grid of fields (2 columns by default). */
export const fieldGrid = (fields, cols = 2) => h('div', { class: 'field-grid', style: { '--cols': cols } }, fields.map((f) => f.el || f));

/** Empty-state block for panels with nothing to show. */
export function emptyState({ iconName = 'info', title, text, actions = [] }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty__icon' }, icon(iconName, { size: 28 })),
    h('div', { class: 'empty__title' }, title),
    text ? h('p', { class: 'empty__text' }, text) : null,
    actions.length ? h('div', { class: 'empty__actions' }, actions) : null);
}

/** Severity -> callout modifier + icon name. */
export const SEVERITY = {
  error: { cls: 'callout--error', icon: 'error' },
  critical: { cls: 'callout--error', icon: 'error' },
  warning: { cls: 'callout--warn', icon: 'warning' },
  info: { cls: 'callout--info', icon: 'info' },
  good: { cls: 'callout--good', icon: 'check' },
};

/** Callout block. opts: { severity, title, text, actions, onClick } */
export function callout({ severity = 'info', title, text, actions, onClick }) {
  const s = SEVERITY[severity] || SEVERITY.info;
  return h('div', { class: `callout ${s.cls}`, role: onClick ? 'button' : null, tabindex: onClick ? 0 : null, style: onClick ? { cursor: 'pointer' } : null, onclick: onClick,
    onkeydown: onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } } : null },
    icon(s.icon, { size: 16, class: 'callout__icon' }),
    h('div', { class: 'callout__body' }, title ? h('div', { class: 'callout__title' }, title) : null, text ? h('div', { class: 'callout__text' }, text) : null, actions || null));
}
