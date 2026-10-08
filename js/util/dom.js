// Tiny DOM helper (browser only). No framework: panels render with h() and update in place.

/**
 * Create an element.  h('div', { class: 'a b', style: { color: 'red' }, onclick: fn, dataset: { x: 1 } }, 'text', child, [more])
 * - `class`/`className`: string
 * - `style`: string or object (camelCase or custom property "--x")
 * - `on<event>`: listener
 * - `dataset`: object
 * - boolean attributes: true sets "", false/null/undefined removes
 * - everything else becomes an attribute (or a property for value/checked/disabled/selected)
 */
export function h(tag, attrs, ...children) {
  const el = tag.startsWith('svg:')
    ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4))
    : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.setAttribute('class', v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replace the children of `el`. */
export function render(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** addEventListener that returns an unsubscribe function. */
export function on(target, type, handler, opts) {
  target.addEventListener(type, handler, opts);
  return () => target.removeEventListener(type, handler, opts);
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Coalesce calls into at most one per animation frame. */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

/** Trigger a browser download of text/binary content. */
export function downloadFile(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
