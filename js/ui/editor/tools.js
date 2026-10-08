// Tool table of the canvas editor: which tools exist, their keyboard shortcuts, mouse cursors and the
// planner-language hints shown in the status line. Pure data and string helpers, no DOM (unit-tested in Node).

import { STATION_TYPES, STATION_TYPE_ORDER, OBSTACLE_KINDS } from '../../model/defaults.js';

/** Every tool name, in toolbar order. */
export const TOOL_NAMES = Object.freeze(['select', 'pan', 'road', 'oneway', 'speedzone', 'erase', ...STATION_TYPE_ORDER, 'obstacle', 'label', 'flow']);

/** Shortcut key (lower case, as in KeyboardEvent.key) -> tool. */
export const TOOL_KEYS = Object.freeze({
  v: 'select', h: 'pan', r: 'road', o: 'oneway', z: 'speedzone', e: 'erase',
  1: 'source', 2: 'process', 3: 'storage', 4: 'sink', 5: 'depot',
  w: 'obstacle', t: 'label', f: 'flow',
});

/** Speed factors the Z key cycles through (share of the normal speed). */
export const SPEED_ZONE_FACTORS = Object.freeze([0.5, 0.25, 0.75]);

/** Is `tool` one of the five station-placing tools (named after the station type)? */
export const isStationTool = (tool) => Object.hasOwn(STATION_TYPES, tool);
/** Tools that paint along a dragged path of cells. */
export const isStrokeTool = (tool) => tool === 'road' || tool === 'oneway' || tool === 'speedzone' || tool === 'erase';

const OBSTACLE_NAMES = { wall: 'Wall', rack: 'Rack', column: 'Column' };

/** Planner name of a station type without the technical remark: "Goods in", "Workstation", "Storage / buffer". */
export const plannerName = (type) => (STATION_TYPES[type] ? STATION_TYPES[type].label.replace(/\s*\(.*\)$/, '') : String(type));

/** "Wall" / "Rack" / "Column". */
export const obstacleName = (kind) => OBSTACLE_NAMES[kind] || OBSTACLE_NAMES.wall;

/** The obstacle kind after `kind` in the cycle wall -> rack -> column. */
export const nextObstacleKind = (kind) => OBSTACLE_KINDS[(OBSTACLE_KINDS.indexOf(kind) + 1) % OBSTACLE_KINDS.length];

/** The speed factor after `factor` in SPEED_ZONE_FACTORS (an unknown value restarts the cycle). */
export function nextSpeedFactor(factor) {
  const i = SPEED_ZONE_FACTORS.findIndex((f) => Math.abs(f - factor) < 1e-9);
  return SPEED_ZONE_FACTORS[(i + 1) % SPEED_ZONE_FACTORS.length];
}

/** Mouse cursor of an idle tool (the editor overrides it while hovering handles or dragging). */
export function toolCursor(tool) {
  if (tool === 'select') return 'default';
  if (tool === 'pan') return 'grab';
  if (tool === 'label') return 'text';
  return 'crosshair';
}

/** Cursor for hovering a resize handle. */
export const HANDLE_CURSORS = Object.freeze({
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
});

/** Text for the status line when a tool is active: one short sentence, keys spelled out. */
export function toolHint(tool, options = {}) {
  switch (tool) {
    case 'select': return 'Click to select. Drag to move. Drag empty space to select an area. Space + drag pans.';
    case 'pan': return 'Drag to move the view. Scroll to zoom.';
    case 'road': return 'Drag to draw a two-way road. Shift = straight line. Alt = erase.';
    case 'oneway': return 'Drag in the driving direction to draw a one-way road. Shift = straight line. Alt = erase.';
    case 'speedzone': return `Drag over roads to limit speed to ${Math.round((options.factor ?? 0.5) * 100)} %. Alt = remove the limit. Z again = other limit.`;
    case 'erase': return 'Drag to erase roads, walls and labels. To remove a station, select it and press Delete.';
    case 'obstacle': return `Click to place a ${obstacleName(options.kind).toLowerCase()}, drag to size it. W again = other type. Esc = back to Select.`;
    case 'label': return 'Click where the text should go. Esc = back to Select.';
    case 'flow': return options.pending
      ? 'Now click the station that receives the loads. Esc cancels.'
      : 'Click a Goods in, Workstation or Storage, then the station that receives its loads. Or drag from one to the other.';
    default:
      return isStationTool(tool)
        ? `Click to place ${plannerName(tool)}, drag to size it. Shift+click places one and returns to Select.`
        : '';
  }
}

/** Station types a flow may start at / end at (docs/ARCHITECTURE.md 4.3; the model's addFlow enforces the same). */
export const FLOW_FROM = Object.freeze(['source', 'process', 'storage']);
export const FLOW_TO = Object.freeze(['process', 'storage', 'sink']);

const NAME_BASES = { source: 'Goods in', process: 'Workstation', storage: 'Storage', sink: 'Goods out', depot: 'Parking' };

/** Name for a new station in planner language: "Goods in 1", "Workstation 2" (the first number not used yet). */
export function newStationName(layout, type) {
  const taken = new Set(layout.stations.map((s) => s.name));
  const base = NAME_BASES[type] || plannerName(type);
  let n = 1;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Why a flow from station `from` to station `to` is not allowed, as a sentence for a toast, or null when it is.
 * Existing flows are not reported here (the caller selects the existing flow instead).
 */
export function flowProblem(from, to) {
  if (from && !FLOW_FROM.includes(from.type)) return `${plannerName(from.type)} cannot send loads.`;
  if (to && from && to.id === from.id) return 'A station cannot send loads to itself.';
  if (to && !FLOW_TO.includes(to.type)) return `${plannerName(to.type)} cannot receive loads.`;
  return null;
}
