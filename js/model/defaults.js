// Data contract defaults for LogiPlan layouts. This file is the single source of truth for
// field names, units and default values. See docs/ARCHITECTURE.md §4 for the full schema.
//
// Units: metres, seconds, grid cells. Time distributions are { kind, mean (s), spread (0..1) }.

/**
 * The BASE schema: what createLayout and emptyLayout stamp, and what every layout without a warehouse-module key keeps for ever. It does
 * not move when the format grows. A layout's `schema` is the lowest version that can express its content (schemaNeeded in schema.js),
 * and SCHEMA_MAX there is the highest version this build can read without warning (docs/WAREHOUSE-DESIGN.md 5.2).
 */
export const SCHEMA_VERSION = 1;

/** Static metadata for the five station types (palette order = STATION_TYPE_ORDER). */
export const STATION_TYPES = {
  source: {
    label: 'Goods in (source)',
    short: 'Source',
    color: '#2f7df6',
    size: { w: 3, h: 2 },
    description: 'Creates loads (pallets, parts) on a schedule: supplier trucks, raw-material dock, upstream plant.',
  },
  process: {
    label: 'Workstation (machine)',
    short: 'Workstation',
    color: '#f5b82e',
    size: { w: 3, h: 3 },
    description: 'Consumes input loads, works for a cycle time, then produces output loads. Can break down.',
  },
  storage: {
    label: 'Storage / buffer',
    short: 'Storage',
    color: '#f08a24',
    size: { w: 4, h: 3 },
    description: 'Holds loads between steps (warehouse, supermarket, line-side buffer).',
  },
  sink: {
    label: 'Goods out (sink)',
    short: 'Sink',
    color: '#3dbb6d',
    size: { w: 3, h: 2 },
    description: 'Takes finished loads out of the system: shipping dock, customer, next plant.',
  },
  depot: {
    label: 'Parking & charging',
    short: 'Depot',
    color: '#8a63d2',
    size: { w: 3, h: 2 },
    description: 'Idle vehicles park here (off the road) and charge their batteries.',
  },
};
export const STATION_TYPE_ORDER = ['source', 'process', 'storage', 'sink', 'depot'];

/** Time-distribution helper. */
export const dist = (kind, mean, spread = 0) => ({ kind, mean, spread });
export const DIST_KINDS = ['const', 'normal', 'uniform', 'exp'];

/** Default `params` object for a station type (fresh copy every call). */
export function defaultStationParams(type) {
  switch (type) {
    case 'source':
      return { interArrival: dist('normal', 120, 0.1), batch: 1, outCap: 6, startDelay: 0 };
    case 'process':
      return { cycle: dist('normal', 90, 0.1), machines: 1, outPerCycle: 1, inCap: 4, outCap: 4, mtbf: 0, mttr: 0 };
    case 'storage':
      return { capacity: 40, dwell: 0 };
    case 'sink':
      return {};
    case 'depot':
      return { slots: 4, chargers: 0 };
    default:
      throw new Error(`Unknown station type: ${type}`);
  }
}

export function defaultStation(type, overrides = {}) {
  const meta = STATION_TYPES[type];
  const { params, ...rest } = overrides;
  return {
    id: '',
    type,
    name: meta.short,
    x: 0,
    y: 0,
    w: meta.size.w,
    h: meta.size.h,
    ...rest,
    params: { ...defaultStationParams(type), ...(params || {}) },
  };
}

/** Flow = logical material flow between two stations (not a drawn road). */
export function defaultFlow(overrides = {}) {
  return {
    id: '',
    from: '',
    to: '',
    weight: 1, // relative share of `from`'s output sent along this flow
    perCycle: 1, // loads the destination workstation consumes from this flow per cycle
    batchMin: 1, // do not dispatch a vehicle for fewer loads (unless maxWait elapsed)
    batchMax: 0, // 0 = as many as the vehicle can carry
    maxWait: 0, // seconds; after this a partial batch (>= 1 load) is dispatched anyway
    priority: 1, // 1 normal, 2 high, 3 urgent
    fleetId: null, // null = any fleet may serve this flow
    ...overrides,
  };
}

export const BATTERY_DEFAULTS = { enabled: false, runtimeMin: 480, chargeTimeMin: 90, lowPct: 25, resumePct: 90 };

/** Vehicle presets. Speeds in m/s, lengths in m, times in s. */
export const FLEET_PRESETS = {
  agv: {
    label: 'AGV (automated guided vehicle)',
    color: '#2d7ff9',
    speed: 1.5, accel: 0.6, decel: 1.0, length: 1.2, capacity: 1, loadTime: 12, unloadTime: 12,
  },
  forklift: {
    label: 'Forklift (driver)',
    color: '#e8590c',
    speed: 3.0, accel: 1.0, decel: 2.0, length: 2.6, capacity: 1, loadTime: 20, unloadTime: 20,
  },
  tugger: {
    label: 'Tugger train',
    color: '#12a594',
    speed: 2.0, accel: 0.5, decel: 1.0, length: 3.5, capacity: 4, loadTime: 45, unloadTime: 45,
  },
  custom: {
    label: 'Custom vehicle',
    color: '#7048e8',
    speed: 2.0, accel: 0.8, decel: 1.2, length: 1.6, capacity: 1, loadTime: 15, unloadTime: 15,
  },
};
export const FLEET_PRESET_ORDER = ['agv', 'forklift', 'tugger', 'custom'];

export function defaultFleet(preset = 'agv', overrides = {}) {
  const { label, ...p } = FLEET_PRESETS[preset] || FLEET_PRESETS.custom;
  const { battery, ...rest } = overrides;
  return {
    id: '',
    name: label.split(' (')[0],
    preset,
    count: 2,
    ...p,
    battery: { ...BATTERY_DEFAULTS, ...(battery || {}) },
    mtbf: 0, // mean time between vehicle breakdowns in seconds, 0 = never
    mttr: 0, // mean repair time in seconds
    home: null, // depot station id where this fleet starts / returns to park
    idle: 'park', // 'park' (go to a depot with a free slot, if any) | 'stay' (wait where the last job ended)
    ...rest,
  };
}

export const DISPATCH_STRATEGIES = {
  nearest: { label: 'Nearest job first', description: 'Each vehicle takes the closest pickup. Minimises empty driving.' },
  oldest: { label: 'Oldest job first (FIFO)', description: 'The load that has waited longest is served first, however far away.' },
  balanced: { label: 'Balanced', description: 'Trades off distance against waiting time.' },
};
export const ROUTING_MODES = {
  shortest: { label: 'Shortest path', description: 'Always the geometrically fastest route.' },
  congestion: { label: 'Congestion-aware', description: 'Avoids roads that currently hold queues.' },
};

/** Settings keys that may change while a simulation runs (no rebuild needed). */
export const RUNTIME_KEYS = ['demandFactor', 'speedFactor', 'processFactor', 'dispatch', 'routing'];

export function defaultSettings(overrides = {}) {
  return {
    seed: 1,
    duration: 8 * 3600, // length of a headless experiment run (s)
    warmup: 600, // seconds excluded from KPIs
    dispatch: 'nearest', // key of DISPATCH_STRATEGIES
    routing: 'shortest', // key of ROUTING_MODES
    handedness: 'right', // 'right' | 'left' — which side of a two-way road vehicles use
    deadlock: 'resolve', // 'resolve' (relocate a victim to break the jam) | 'ignore' (let the jam stand)
    demandFactor: 1, // runtime: multiplies all source arrival rates
    speedFactor: 1, // runtime: multiplies all vehicle speeds
    processFactor: 1, // runtime: multiplies all machine cycle times (1.2 = 20 % slower)
    dt: 0.1, // simulation time step (s)
    ...overrides,
  };
}

export function defaultGrid(overrides = {}) {
  return { cols: 48, rows: 32, cellSize: 2, ...overrides };
}

/** An empty but complete layout. layout.js builds on this; tests may use it directly. */
export function emptyLayout(overrides = {}) {
  const { grid, settings, ...rest } = overrides;
  return {
    schema: SCHEMA_VERSION,
    name: 'Untitled plant',
    notes: '',
    grid: defaultGrid(grid),
    roads: {}, // "cx,cy" -> { out: bitmask of exit directions (N=1,E=2,S=4,W=8), limit?: 0.1..1 speed factor }
    obstacles: [], // { id, x, y, w, h, kind: 'wall' | 'rack' | 'column' }
    labels: [], // { id, x, y, text, size? }
    stations: [],
    flows: [],
    fleets: [],
    ...rest,
    settings: defaultSettings(settings),
  };
}

export const OBSTACLE_KINDS = ['wall', 'rack', 'column'];
export const GRID_LIMITS = { minCols: 8, maxCols: 320, minRows: 8, maxRows: 320, minCell: 0.5, maxCell: 10 };
/** Cells in one extension block of the baseplate: the unit by which the plan grows (the edge '+' strips, auto-grow, Plant settings). */
export const GRID_BLOCK = 8;
