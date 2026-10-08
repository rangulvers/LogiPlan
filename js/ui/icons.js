// Inline SVG icon set for the LogiPlan UI. Hand-drawn on a 24x24 grid: 1.75 stroke, round caps and joins,
// stroke = currentColor (so an icon takes the colour of its button or text). Designed to stay legible at 16-20 px;
// the few icons whose detail merges into a blob below 18 px have a simplified variant for those sizes (COMPACT).
//
//   import { icon } from './icons.js';
//   button.append(icon('play', { size: 16 }));       // SVGElement (browser)
//   html += iconSvg('warning', { size: 14 });        // markup string (report export, Node-safe)
//
// Only the registry and iconSvg() are DOM-free; icon() needs `document`.

import { escapeHtml } from '../util/format.js';

// Gear outlines are generated geometry (even teeth): 6 chunky teeth for a machine, 8 fine ones for settings.
const GEAR_MACHINE = 'M9.61 5.42L10.05 2.81L13.95 2.81L14.39 5.42L16.5 6.64L18.99 5.71L20.94 9.1L18.89 10.78L18.89 13.22L20.94 14.9L18.99 18.29L16.5 17.36L14.39 18.58L13.95 21.19L10.05 21.19L9.61 18.58L7.5 17.36L5.01 18.29L3.06 14.9L5.11 13.22L5.11 10.78L3.06 9.1L5.01 5.71L7.5 6.64z';
const GEAR_COG = 'M10.2 4.51L10.66 2.49L13.34 2.49L13.8 4.51L16.02 5.43L17.78 4.33L19.67 6.22L18.57 7.98L19.49 10.2L21.51 10.66L21.51 13.34L19.49 13.8L18.57 16.02L19.67 17.78L17.78 19.67L16.02 18.57L13.8 19.49L13.34 21.51L10.66 21.51L10.2 19.49L7.98 18.57L6.22 19.67L4.33 17.78L5.43 16.02L4.51 13.8L2.49 13.34L2.49 10.66L4.51 10.2L5.43 7.98L4.33 6.22L6.22 4.33L7.98 5.43z';

/** Inner SVG markup per icon name (the <svg> wrapper and presentation attributes are added by iconSvg). */
const SHAPES = {
  // ---- tools
  select: '<path d="M5.5 3.8l13 6.4-5.7 1.9-2 5.9z"/><path d="M13.2 13.6l4.6 5"/>',
  pan: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  road: '<path d="M8.5 3.5L4 20.5M15.5 3.5L20 20.5"/><path d="M12 4.5v3M12 10.5v3M12 16.5v3"/>',
  oneway: '<path d="M8.5 3.5L4 20.5M15.5 3.5L20 20.5"/><path d="M12 19V8.5M9 11.5l3-3 3 3"/>',
  speedzone: '<path d="M4.2 16.5a8 8 0 1 1 15.6 0"/><path d="M12 14.7l3.4-4.6"/><circle cx="12" cy="14.7" r="1.3" fill="currentColor"/><path d="M12 8.4v1.2M7.3 11.2l.9.9M16.7 11.2l-.9.9"/>',
  erase: '<g transform="rotate(-45 12 12)"><rect x="3.5" y="8" width="17" height="8" rx="2"/><path d="M10 8v8"/></g><path d="M12.5 20.5h8"/>',
  source: '<path d="M3 12h10.5M10 8.5l3.5 3.5-3.5 3.5"/><path d="M15.5 4.5h5v15h-5"/>',
  process: `<path d="${GEAR_MACHINE}"/><circle cx="12" cy="12" r="2.7"/>`,
  storage: '<path d="M4 3.5v17M20 3.5v17M4 8.5h16M4 14.5h16M4 20.5h16"/><path d="M7 8.5v-3h4v3M13.5 14.5v-3h4v3M8 20.5v-3h4.5v3"/>',
  sink: '<path d="M3.5 7.5h9.5v10H3.5zM3.5 11h9.5"/><path d="M13 12.5h7.5M17.5 9.5l3 3-3 3"/>',
  depot: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M7.6 17V7.2h2.8a2.5 2.5 0 0 1 0 5H7.6"/><path d="M17 7.8l-2.2 4.2H18l-2.2 4.2"/>',
  obstacle: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18M9 5v7M15 12v7"/>',
  label: '<path d="M5 7.5V5h14v2.5M12 5v14M9 19h6"/>',
  flow: '<circle cx="5.5" cy="18.5" r="1.8" fill="currentColor" stroke="none"/><path d="M5.5 16v-3a4 4 0 0 1 4-4h10M16 5.5L19.5 9 16 12.5"/>',

  // ---- history, simulation control
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor"/>',
  pause: '<rect x="7" y="5" width="2" height="14" rx="1" fill="currentColor"/><rect x="15" y="5" width="2" height="14" rx="1" fill="currentColor"/>',
  step: '<path d="M5.5 5l9.5 7-9.5 7z" fill="currentColor"/><path d="M19 5v14"/>',
  reset: '<path d="M5.07 8A8 8 0 1 1 4.1 13.4"/><path d="M4.5 3.8v4.4h4.4"/>',

  // ---- view
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  zoomin: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3l5.2 5.2M10.5 8v5M8 10.5h5"/>',
  zoomout: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3l5.2 5.2M8 10.5h5"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.33h16M4 14.67h16M9.33 4v16M14.67 4v16"/>',
  heat: '<path d="M12 4.25c.9 3.4 5.5 5.2 5.5 10a5.5 5.5 0 0 1-11 0c0-2 .9-3.2 2-4.2.1 1.5.9 2.4 1.9 2.7C10 10.05 10.7 6.85 12 4.25z"/>',
  flows: '<path d="M3.5 12H8c3.5 0 3.5-6 7-6h4.5M8 12c3.5 0 3.5 6 7 6h4.5"/><path d="M17 3.5L19.5 6 17 8.5M17 15.5l2.5 2.5-2.5 2.5"/>',
  layers: '<path d="M12 3.5l9 4.8-9 4.8-9-4.8z"/><path d="M3 12.4l9 4.8 9-4.8M3 16.6l9 4.8 9-4.8"/>',

  // ---- files, sharing
  share: '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="5.8" r="2.6"/><circle cx="18" cy="18.2" r="2.6"/><path d="M8.3 10.8l7.4-3.7M8.3 13.2l7.4 3.7"/>',
  export: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/><path d="M12 18.5v-8.5M8.5 13.5L12 10l3.5 3.5"/>',
  import: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/><path d="M12 10v8.5M8.5 15L12 18.5 15.5 15"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
  upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 20h14"/>',
  folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l2 2.3H19a1.5 1.5 0 0 1 1.5 1.5v9.2A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
  save: '<path d="M5.5 3.5H16l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M8 3.5v5h7v-5M7.5 20.5v-6.5h9v6.5"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7M10 11v5M14 11v5"/>',
  edit: '<path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5z"/><path d="M14.5 6l3.5 3.5"/>',

  // ---- status, feedback
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.2-2.6 3.9"/><path d="M12 17.3h.01" stroke-width="2.2"/>',
  warning: '<path d="M12 3.8l9.2 16H2.8z"/><path d="M12 10v4.4"/><path d="M12 17.3h.01" stroke-width="2.2"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.7h.01" stroke-width="2.2"/>',
  check: '<path d="M4.5 12.5l5 5L19.5 7"/>',

  // ---- generic actions
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3l5.2 5.2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-up': '<path d="M6 15l6-6 6 6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  settings: `<path d="${GEAR_COG}"/><circle cx="12" cy="12" r="3"/>`,
  sliders: '<path d="M4 6h5.5M14.5 6H20M4 12h9M18 12h2M4 18h2M11 18h9"/><circle cx="12" cy="6" r="2.5"/><circle cx="15.5" cy="12" r="2.5"/><circle cx="8.5" cy="18" r="2.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  moon: '<path d="M20 14.2A8.3 8.3 0 0 1 9.8 4a8.3 8.3 0 1 0 10.2 10.2z"/>',

  // ---- logistics domain
  truck: '<path d="M5.5 16.5h-2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v10"/><path d="M9.5 16.5H15"/><path d="M13.5 9.5h4.2a1 1 0 0 1 .8.4l2.6 3.3a1 1 0 0 1 .2.6v2.2a1 1 0 0 1-1 1H19"/><circle cx="7.5" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  forklift: '<path d="M17.5 3.5V18M17.5 17h4.5"/><path d="M3 16v-5.5a1 1 0 0 1 1-1h10.5V16M14.5 12.5h3"/><path d="M6.5 9.5V4.5H12l1.5 5"/><circle cx="6" cy="18" r="2"/><circle cx="13" cy="18" r="2"/>',
  bolt: '<path d="M13 2.8L5.5 13.5h6l-1 7.7 7.5-10.7h-6z"/>',
  battery: '<rect x="2.5" y="7.5" width="17" height="9" rx="2"/><path d="M22 10.5v3M6 10.5v3M9.5 10.5v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
  chart: '<rect x="4.5" y="11" width="4" height="9" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><rect x="15.5" y="8" width="4" height="12" rx="1"/>',
  compare: '<path d="M4 8h14M14.5 4.5L18 8l-3.5 3.5M20 16H6M9.5 12.5L6 16l3.5 3.5"/>',
  flask: '<path d="M9.5 3.5h5M10.5 3.5v6L5 18.3a1.9 1.9 0 0 0 1.6 2.9h10.8a1.9 1.9 0 0 0 1.6-2.9l-5.5-8.8v-6"/><path d="M7.5 14.5h9"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  route: '<circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="4.5" r="2"/><path d="M7.5 18.5h6a3.5 3.5 0 0 0 0-7h-3a3.5 3.5 0 0 1 0-7h6"/>',
};

/**
 * Simplified art for icons drawn below COMPACT_BELOW px. At 16 px one icon unit is two thirds of a pixel, so strokes
 * closer than about 2 units merge: these variants drop the ticks, bolts and cab details of their full-size icons.
 */
const COMPACT = {
  storage: '<path d="M4 3.5v17M20 3.5v17M4 12h16M4 20.5h16"/><path d="M8 12V6.5h5.5V12M11 20.5v-5h5.5v5"/>',
  speedzone: '<path d="M4.2 17a8 8 0 1 1 15.6 0"/><path d="M12 15.5l3.6-5.2"/><circle cx="12" cy="15.5" r="1.8" fill="currentColor" stroke="none"/>',
  oneway: '<path d="M6 3.5L2.5 20.5M18 3.5l3.5 17"/><path d="M12 19.5V6M7.5 10.5L12 6l4.5 4.5"/>',
  depot: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M9 17.5V6.5h3.4a3.2 3.2 0 0 1 0 6.4H9"/>',
  forklift: '<path d="M18 3.5V17.5M18 17.5h4"/><path d="M3 16.5v-6h11.5v6M6.5 10.5v-5h6v5"/><circle cx="6.5" cy="18.8" r="1.9" fill="currentColor" stroke="none"/><circle cx="13" cy="18.8" r="1.9" fill="currentColor" stroke="none"/>',
};
const COMPACT_BELOW = 18;

/** Shown for an unknown name so a typo is visible instead of throwing. */
const MISSING = '<rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="3 3"/>';

/** All available icon names, in declaration order. */
export const ICON_NAMES = Object.freeze(Object.keys(SHAPES));

const normalizeSize = (size) => (Number.isFinite(size) && size > 0 ? size : 18);
const isCompact = (name, px) => px < COMPACT_BELOW && Object.hasOwn(COMPACT, name);

/**
 * Icon as an SVG markup string (for HTML templates and report export).
 * @param {string} name one of ICON_NAMES (unknown names render a dashed placeholder)
 * @param {{ size?: number, class?: string }} [opts] size in px (default 18; below 18 a few icons switch to their simplified variant); extra CSS class
 * @returns {string}
 */
export function iconSvg(name, { size = 18, class: className } = {}) {
  const known = Object.hasOwn(SHAPES, name);
  const px = normalizeSize(size);
  const classes = ['icon', known ? `icon--${name}` : 'icon--missing', className].filter(Boolean).join(' ');
  const shape = !known ? MISSING : isCompact(name, px) ? COMPACT[name] : SHAPES[name];
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${escapeHtml(classes)}" width="${px}" height="${px}" viewBox="0 0 24 24" `
    + 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" '
    + `aria-hidden="true" focusable="false">${shape}</svg>`;
}

const prototypes = new Map();

/** Parsed prototype per icon name and variant (full or compact); cloning it is much cheaper than re-parsing markup. */
function prototype(name, compact) {
  const key = Object.hasOwn(SHAPES, name) ? `${name}${compact ? ':compact' : ''}` : '';
  let proto = prototypes.get(key);
  if (!proto) {
    const template = document.createElement('template');
    template.innerHTML = iconSvg(name, { size: compact ? COMPACT_BELOW - 1 : COMPACT_BELOW });
    proto = template.content.firstElementChild;
    prototypes.set(key, proto);
  }
  return proto;
}

/**
 * Icon as a detached inline <svg> element (24x24 viewBox, currentColor, aria-hidden).
 * @param {string} name one of ICON_NAMES
 * @param {{ size?: number, class?: string }} [opts] size in px (default 18; below 18 a few icons switch to their simplified variant); extra CSS class
 * @returns {SVGElement}
 */
export function icon(name, { size = 18, class: className } = {}) {
  const px = normalizeSize(size);
  const el = prototype(name, isCompact(name, px)).cloneNode(true);
  el.setAttribute('width', String(px));
  el.setAttribute('height', String(px));
  if (className) el.setAttribute('class', `${el.getAttribute('class')} ${className}`);
  return el;
}
