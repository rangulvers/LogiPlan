// Renderer: draws the plant onto a <canvas> (docs/ARCHITECTURE.md §6.2 and §7).
//
//   new Renderer(canvas, { camera, theme })   theme = 'auto' | 'light' | 'dark' | a getTheme() palette
//   renderer.layout = Layout | null           set / replace; the static layer is rebuilt when the object changes
//   renderer.sim = Simulation | null          live station states, vehicles, heatmap, deadlocks
//   renderer.view = { selection, hover, tool, overlays, ghost, paintPreview, flowPreview, marquee, resizeHandles }
//   renderer.resize()                         call when the canvas box changes (handles devicePixelRatio)
//   renderer.render(alpha)                    draw a frame; alpha 0..1 interpolates vehicle poses between ticks
//   renderer.hitTest(px, py)                  what is under a screen point
//   renderer.toDataURL({ scale, background, theme, padding })   PNG of the whole plant
//   renderer.invalidate() / destroy()         force a static-layer rebuild / stop the settle timer
//   renderer.stats = { frames, staticBuilds }  diagnostics (tests, perf HUD)
//
// Layers, bottom to top: background, cached static layer (baseplate, studs, grid, obstacles, roads),
// heatmap, dock notches, flows, station bricks, flow markers, labels, vehicles, deadlock rings, hover /
// selection / ghost / previews, heat legend and scale bar. See render/*.js for the pieces.
//
// Conventions chosen where the spec leaves room (also listed in the final report):
//   * view.flowPreview.toPoint and view.marquee are in WORLD METRES; add `space: 'screen'` to the marquee
//     (or to flowPreview) to pass CSS pixels instead. ghost.rect and paintPreview.cells are in grid cells.
//   * toDataURL({ scale }): scale 1 = 20 px per metre; the result is capped to 8192 px per side and 16 M pixels
//     (the canvas limit of iOS Safari).
//   * sim.traffic.activeDeadlocks may be an iterable of node ids, of { node } or of { nodes: [] } objects.
//   * Free labels are centred on (x, y); `size` is their text height in grid cells (as in js/model/layout.js).
//   * hitTest priority: vehicles > resize handles > labels > flow markers (the direction badge of a flow between
//     touching stations, drawn on top of the bricks) > stations > flows > obstacles > cells. Hidden layers
//     (labels / flows overlay off) are not hit.

import { getTheme, resolveThemeMode } from './theme.js';
import { getScene } from './render/scene.js';
import { StaticLayer, SETTLE_MS } from './render/layer.js';
import { drawStatic } from './render/static.js';
import { drawStations } from './render/bricks.js';
import { drawLabels, labelFontPx } from './render/labels.js';
import { drawFlows, drawFlowMarkers, drawFlowPreview, markerRadius } from './render/flows.js';
import { drawVehicles, vehiclePose, vehicleSize, idFontOf } from './render/vehicles.js';
import {
  createHeatState, refreshHeat, drawHeat, drawHeatLegend, drawDocks, drawDeadlocks, drawScaleBar,
} from './render/overlays.js';
import { drawHover, drawSelection, drawGhost, drawPaintPreview, drawMarquee, itemRectPx, handleRect } from './render/interaction.js';
import { distToCurve, hitHandle, pointInRect } from './render/geometry.js';
import { plantBounds, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM } from './camera.js';

const EXPORT_PX_PER_METRE = 20;
const EXPORT_MAX_SIDE = 8192;
const EXPORT_MAX_PIXELS = 16e6;
const EXPORT_MIN_MARGIN_PX = 12;
const FLOW_HIT_PX = 6;
const HANDLE_HIT_PX = 7;
const MARKER_HIT_SLACK_PX = 3;
/** Heat strips are widened by this many device pixels on every side, so strips of different levels that abut leave no seam. */
const HEAT_BLEED_DEVICE_PX = 0.25;
const EMPTY = Object.freeze([]);
const EMPTY_VIEW = Object.freeze({});
const DEFAULT_OVERLAYS = Object.freeze({});

/** A fresh, empty view state (what `renderer.view` starts as). */
export function createView() {
  return {
    selection: { kind: null, ids: [] },
    hover: null,
    tool: 'select',
    overlays: { grid: true, studs: true, flows: true, docks: false, heat: 'off', ids: false, labels: true },
    ghost: null,
    paintPreview: null,
    flowPreview: null,
    marquee: null,
    resizeHandles: false,
  };
}

function defaultCreateCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('Renderer needs a canvas implementation: pass { createCanvas } outside the browser');
}

/** A live MediaQueryList for `query`, or a never-matching stand-in where matchMedia is missing. */
function mediaQuery(query) {
  try {
    if (typeof globalThis.matchMedia === 'function') return globalThis.matchMedia(query);
  } catch {
    // matchMedia can throw in sandboxed frames
  }
  return { matches: false };
}

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/** Per-frame state shared by all draw modules. One instance is reused every frame. */
function createFrame() {
  const fr = {
    theme: null, layout: null, scene: null, sim: null, view: EMPTY_VIEW, overlays: DEFAULT_OVERLAYS,
    zoom: DEFAULT_ZOOM, dpr: 1, cs: 2, tx: 0, ty: 0, ox: 0, oy: 0, w: 0, h: 0,
    vis: { x0: 0, y0: 0, x1: 0, y1: 0 }, alpha: 1, now: 0,
    selKind: null, selIds: EMPTY, hoverKind: null, hoverId: null, hoverVehicle: null, selFleet: null,
    showIds: false, idFont: '', reducedMotion: false, hand: 1,
    pose: new Float64Array(3), size: { length: 1.2, width: 0.66 }, poseBuf: new Float64Array(0), brick: {},
    curvePx: { ax: 0, ay: 0, qx: 0, qy: 0, bx: 0, by: 0 }, tmpA: [0, 0], tmpB: [0, 0],
    stationCache: { src: null, len: -1, map: null }, flowCache: { src: null, len: -1, map: null },
    rtOf: null, deliveredOf: null,
  };
  fr.rtOf = (id) => runtimeStation(fr, id);
  fr.deliveredOf = (id) => deliveredFlow(fr, id);
  return fr;
}

function indexById(cache, list) {
  if (cache.src !== list || cache.len !== list.length) {
    cache.map = new Map(list.map((item) => [item && item.id, item]));
    cache.src = list;
    cache.len = list.length;
  }
  return cache.map;
}

/** Runtime station (StationRT) for a layout station id, or null. */
function runtimeStation(fr, id) {
  const sim = fr.sim;
  if (!sim) return null;
  const lg = sim.logistics;
  if (lg && lg.stationById && typeof lg.stationById.get === 'function') return lg.stationById.get(id) || null;
  const list = sim.stations || (lg && lg.stations);
  return Array.isArray(list) ? indexById(fr.stationCache, list).get(id) || null : null;
}

/** Loads delivered along flow `id` so far, NaN when the simulation does not expose it. */
function deliveredFlow(fr, id) {
  const lg = fr.sim && fr.sim.logistics;
  if (!lg || !Array.isArray(lg.flows)) return NaN;
  const f = indexById(fr.flowCache, lg.flows).get(id);
  return f && Number.isFinite(f.delivered) ? f.delivered : NaN;
}

/** Fill the per-frame state `fr` from the renderer fields and the camera (all in CSS pixels / metres). */
function setupFrame(fr, r, alpha, now) {
  const cam = r.camera;
  const view = r.view || EMPTY_VIEW;
  // the camera clamps itself; this only keeps a hand-set absurd zoom from producing infinite coordinates
  const zoom = Math.min(MAX_ZOOM * 25, Math.max(MIN_ZOOM / 100, finiteOr(cam.zoom, DEFAULT_ZOOM)));
  const camX = finiteOr(cam.x, 0);
  const camY = finiteOr(cam.y, 0);
  const s = zoom * r.dpr;
  fr.theme = r.theme;
  fr.layout = r.layout;
  fr.scene = getScene(r.layout);
  fr.sim = r.sim || null;
  fr.view = view;
  fr.overlays = view.overlays || DEFAULT_OVERLAYS;
  fr.zoom = zoom;
  fr.dpr = r.dpr;
  fr.cs = fr.scene ? fr.scene.cs : 2;
  fr.w = r.cssW;
  fr.h = r.cssH;
  fr.tx = Math.round((r.cssW / 2) * r.dpr - camX * s);
  fr.ty = Math.round((r.cssH / 2) * r.dpr - camY * s);
  fr.ox = fr.tx / r.dpr;
  fr.oy = fr.ty / r.dpr;
  fr.vis.x0 = (-fr.ox) / zoom;
  fr.vis.y0 = (-fr.oy) / zoom;
  fr.vis.x1 = (r.cssW - fr.ox) / zoom;
  fr.vis.y1 = (r.cssH - fr.oy) / zoom;
  fr.alpha = alpha;
  fr.now = now;
  fr.reducedMotion = r._motion.matches === true;
  fr.hand = handSide(fr);
  applyInteraction(fr, view, true);
  fr.showIds = fr.overlays.ids === true;
  fr.idFont = idFontOf(fr.theme);
  return fr;
}

/** +1 for right-hand traffic, -1 for left-hand (which side of a two-way road vehicles use). */
function handSide(fr) {
  const settings = (fr.sim && fr.sim.settings) || (fr.layout && fr.layout.settings);
  return settings && settings.handedness === 'left' ? -1 : 1;
}

/** Copy selection / hover from the view into frame fields (or clear them for export). */
function applyInteraction(fr, view, interactive) {
  const sel = interactive ? view.selection : null;
  const hover = interactive ? view.hover : null;
  fr.selKind = (sel && sel.kind) || null;
  fr.selIds = sel && Array.isArray(sel.ids) ? sel.ids : EMPTY;
  fr.hoverKind = (hover && hover.kind) || null;
  fr.hoverId = hover && hover.id !== undefined ? hover.id : null;
  fr.hoverVehicle = fr.hoverKind === 'vehicle' ? fr.hoverId : null;
  fr.selFleet = fr.selKind === 'fleet' && fr.selIds.length ? fr.selIds[0] : null;
}

const heatMode = (fr) => (fr.overlays.heat === 'traffic' || fr.overlays.heat === 'waiting' ? fr.overlays.heat : null);

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ camera: object, theme?: 'auto'|'light'|'dark'|object, createCanvas?: Function, now?: Function,
   *   dpr?: number, reducedMotion?: boolean }} opts
   *   `createCanvas(w, h)` and `now()` exist for tests; `dpr` pins the pixel ratio instead of reading the window;
   *   `reducedMotion` overrides the `prefers-reduced-motion` media query (pulsing deadlock rings stand still)
   */
  constructor(canvas, { camera, theme = 'auto', createCanvas = defaultCreateCanvas, now = defaultNow, dpr, reducedMotion } = {}) {
    this.canvas = canvas;
    this.camera = camera;
    this.layout = null;
    this.sim = null;
    this.view = createView();
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.stats = { frames: 0, staticBuilds: 0 };
    this._fixedDpr = dpr;
    this._motion = reducedMotion === undefined ? mediaQuery('(prefers-reduced-motion: reduce)') : { matches: reducedMotion === true };
    this._createCanvas = createCanvas;
    this._now = now;
    this._layer = new StaticLayer(createCanvas);
    this._heat = createHeatState();
    this._fr = createFrame();
    this._alpha = 1;
    this._timer = null;
    this._destroyed = false;
    this.theme = theme;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.resize();
  }

  /** Current palette. Assign 'auto' | 'light' | 'dark' or a palette object from getTheme(). */
  get theme() {
    return this._theme;
  }

  set theme(value) {
    this._theme = value && typeof value === 'object' ? value : getTheme(resolveThemeMode(value));
  }

  /** Re-read the canvas box and devicePixelRatio; resizes the backing store and tells the camera the viewport. */
  resize() {
    const canvas = this.canvas;
    const dpr = this._readDpr();
    const w = Math.max(0, finiteOr(canvas.clientWidth, finiteOr(canvas.width / dpr, 0)));
    const h = Math.max(0, finiteOr(canvas.clientHeight, finiteOr(canvas.height / dpr, 0)));
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    this.dpr = dpr;
    this.cssW = w;
    this.cssH = h;
    this.camera.setViewport(w, h);
  }

  _readDpr() {
    const raw = this._fixedDpr !== undefined ? this._fixedDpr : globalThis.devicePixelRatio;
    return Math.min(4, Math.max(1, finiteOr(raw, 1)));
  }

  /** Draw one frame. Never throws for missing or odd input. */
  render(alpha = 1) {
    const a = alpha > 0 ? (alpha < 1 ? alpha : 1) : 0;
    this._alpha = a;
    if (this._readDpr() !== this.dpr) this.resize();
    const ctx = this.ctx;
    if (!ctx || !(this.cssW > 0) || !(this.cssH > 0)) return;
    this.stats.frames++;
    const fr = setupFrame(this._fr, this, a, this._now());
    const { dpr } = fr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = fr.theme.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!fr.scene) return;
    this._drawStaticLayer(ctx, fr);
    drawLayers(ctx, fr, this._heat, false);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawInteraction(ctx, fr, this.view || EMPTY_VIEW);
    if (heatMode(fr) && fr.sim) drawHeatLegend(ctx, fr, this._heat);
    drawScaleBar(ctx, fr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  _drawStaticLayer(ctx, fr) {
    const layer = this._layer;
    const builds = layer.builds;
    const visible = layer.prepare(fr);
    this.stats.staticBuilds += layer.builds - builds;
    if (visible) layer.blit(ctx, fr);
    if (layer.pending) this._scheduleSettle();
  }

  /** Re-render once a wheel zoom has come to rest, even if the host does not request another frame. */
  _scheduleSettle() {
    if (this._timer !== null || this._destroyed) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._destroyed) this.render(this._alpha);
    }, SETTLE_MS + 20);
    if (typeof this._timer === 'object' && this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  /**
   * What is under screen point (px, py) in CSS pixels. Priority: vehicles, resize handles, labels,
   * stations, flows (within 6 px), obstacles, then the plain cell. `cell` is always present.
   * @returns {{ kind: string, id?: string, cell: number[], handle?: string }}
   */
  hitTest(px, py) {
    const fr = setupFrame(this._fr, this, this._alpha, this._now());
    if (!Number.isFinite(px) || !Number.isFinite(py)) { px = 0; py = 0; }
    // the same pixel-snapped origin the bricks are drawn with, so `cell` always agrees with `kind` / `id`
    const wx = (px - fr.ox) / fr.zoom;
    const wy = (py - fr.oy) / fr.zoom;
    const cell = [Math.floor(wx / fr.cs) + 0, Math.floor(wy / fr.cs) + 0];
    const result = (kind, id, extra) => ({ kind, id, cell, ...extra });
    const scene = fr.scene;
    if (!scene) return { kind: 'cell', cell };
    const vehicle = hitVehicle(fr, px, py);
    if (vehicle) return result('vehicle', vehicle.id);
    const ctx = this.ctx;
    const hr = ctx ? handleRect(ctx, fr) : null;
    if (hr) {
      const name = hitHandle(hr.x, hr.y, hr.w, hr.h, px, py, HANDLE_HIT_PX);
      if (name) return result(fr.selKind, fr.selIds[0], { handle: name });
    }
    const label = ctx ? hitLabel(ctx, fr, px, py) : null;
    if (label) return result('label', label.id, selectedHandle(fr, 'label', label.id));
    const marker = hitMarker(fr, px, py);
    if (marker) return result('flow', marker.flow.id);
    for (let i = scene.stations.length - 1; i >= 0; i--) {
      const e = scene.stations[i];
      if (pointInRect(wx, wy, e)) return result('station', e.st.id, selectedHandle(fr, 'station', e.st.id));
    }
    if (fr.overlays.flows !== false) {
      for (let i = scene.flows.length - 1; i >= 0; i--) {
        if (!scene.flows[i].marker && distToCurve(scene.flows[i].curve, wx, wy) * fr.zoom <= FLOW_HIT_PX) return result('flow', scene.flows[i].flow.id);
      }
    }
    const obstacles = scene.obstacles;
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      if (pointInRect(wx / fr.cs, wy / fr.cs, o)) return result('obstacle', o.id, selectedHandle(fr, 'obstacle', o.id));
    }
    return { kind: 'cell', cell };
  }

  /**
   * Render the whole plant (ignoring the on-screen camera and all editing aids) to a PNG data URL, with
   * live stations, vehicles, heatmap and deadlock rings when a simulation is attached.
   * @param {{ scale?: number, background?: string|null, theme?: 'auto'|'light'|'dark', padding?: number }} [opts]
   *   scale: 1 = 20 px/m (capped at 8192 px per side); background: CSS colour, null / 'transparent' for none,
   *   default = the theme background; theme: palette for the export (default: the current one); padding in metres.
   * @returns {string} 'data:image/png;base64,...' ('' when the canvas implementation cannot encode PNG)
   */
  toDataURL({ scale = 1, background, theme, padding = 1 } = {}) {
    const scene = getScene(this.layout);
    const bounds = scene ? { w: scene.width, h: scene.height } : plantBounds(null);
    const wanted = EXPORT_PX_PER_METRE * Math.max(0.05, finiteOr(scale, 1));
    // margin around the baseplate: the requested padding, at least enough for the plate's shadow
    const pad = Math.max(0, finiteOr(padding, 1), EXPORT_MIN_MARGIN_PX / wanted);
    const worldW = bounds.w + 2 * pad;
    const worldH = bounds.h + 2 * pad;
    const ppm = Math.min(wanted, EXPORT_MAX_SIDE / worldW, EXPORT_MAX_SIDE / worldH, Math.sqrt(EXPORT_MAX_PIXELS / (worldW * worldH)));
    const out = this._createCanvas(Math.max(1, Math.ceil(worldW * ppm)), Math.max(1, Math.ceil(worldH * ppm)));
    const ctx = out.getContext('2d');
    if (scene && ctx) this._drawExport(ctx, out, scene, ppm, pad, background, theme);
    return typeof out.toDataURL === 'function' ? out.toDataURL('image/png') : '';
  }

  _drawExport(ctx, out, scene, ppm, pad, background, themeMode) {
    const theme = themeMode ? getTheme(resolveThemeMode(themeMode)) : this.theme;
    const fr = createFrame();
    const view = this.view || EMPTY_VIEW;
    Object.assign(fr, {
      theme, layout: this.layout, scene, sim: this.sim || null, view, overlays: view.overlays || DEFAULT_OVERLAYS,
      zoom: ppm, dpr: 1, cs: scene.cs, tx: pad * ppm, ty: pad * ppm, ox: pad * ppm, oy: pad * ppm,
      w: out.width, h: out.height, alpha: 1, now: 0,
    });
    Object.assign(fr.vis, { x0: -pad, y0: -pad, x1: scene.width + pad, y1: scene.height + pad });
    fr.hand = handSide(fr);
    applyInteraction(fr, view, false);
    fr.showIds = fr.overlays.ids === true;
    fr.idFont = idFontOf(theme);
    if (background !== null && background !== 'transparent') {
      ctx.fillStyle = background || theme.bg;
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.setTransform(ppm, 0, 0, ppm, fr.tx, fr.ty);
    const ov = fr.overlays;
    drawStatic(ctx, scene, theme, { k: ppm, zoom: ppm, win: fr.vis, studs: ov.studs !== false, grid: ov.grid !== false });
    const heat = createHeatState();
    drawLayers(ctx, fr, heat, true);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (heatMode(fr) && fr.sim) drawHeatLegend(ctx, fr, heat);
  }

  /** Force the static layer to be re-rendered on the next frame (e.g. after fonts finished loading). */
  invalidate() {
    this._layer.invalidate();
  }

  /** Stop timers; the renderer must not be used afterwards. */
  destroy() {
    this._destroyed = true;
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }
}

/**
 * Everything between the static layer and the editing aids: heatmap, dock notches, flows, bricks, vehicles,
 * deadlock rings. Works for the screen frame and for the export frame alike (both describe their
 * transform through zoom, dpr, tx, ty).
 */
function drawLayers(ctx, fr, heat, forceHeat) {
  const { dpr, zoom } = fr;
  const mode = heatMode(fr);
  if (mode && fr.sim) {
    refreshHeat(heat, fr, mode, forceHeat);
    ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, fr.tx, fr.ty);
    drawHeat(ctx, heat, HEAT_BLEED_DEVICE_PX / (zoom * dpr));
  } else heat.count = 0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawDocks(ctx, fr);
  if (fr.overlays.flows !== false) drawFlows(ctx, fr);
  drawStations(ctx, fr);
  drawFlowMarkers(ctx, fr);
  drawLabels(ctx, fr);
  if (!fr.sim) return;
  drawVehicles(ctx, fr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawDeadlocks(ctx, fr);
}

/** Hover, selection, ghost, previews and marquee, in that order. Expects the CSS-pixel transform. */
function drawInteraction(ctx, fr, view) {
  drawHover(ctx, fr);
  drawSelection(ctx, fr);
  drawGhost(ctx, fr, view.ghost);
  drawPaintPreview(ctx, fr, view.paintPreview);
  const fp = view.flowPreview;
  const from = fp && fr.scene.stationById.get(fp.fromId);
  if (from && Array.isArray(fp.toPoint)) {
    const [tx, ty] = fp.space === 'screen' ? [(fp.toPoint[0] - fr.ox) / fr.zoom, (fp.toPoint[1] - fr.oy) / fr.zoom] : fp.toPoint;
    drawFlowPreview(ctx, fr, from, tx, ty);
  }
  drawMarquee(ctx, fr, view.marquee);
}

/** `{ handle: 'move' }` when the item is part of the current selection, so the editor can start a drag. */
function selectedHandle(fr, kind, id) {
  return fr.selKind === kind && fr.selIds.includes(id) ? { handle: 'move' } : undefined;
}

/** Top-most visible vehicle whose (slightly padded) body contains the screen point. */
function hitVehicle(fr, px, py) {
  const list = fr.sim && fr.sim.vehicles;
  if (!list) return null;
  const size = fr.size;
  const pose = fr.pose;
  const maxStep = fr.cs * 1.5;
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i];
    if (!v || v.visible === false || !vehiclePose(v, fr.alpha, maxStep, pose)) continue;
    vehicleSize(v, fr.cs, size);
    const lenPx = Math.max(size.length * fr.zoom, 9);
    const widPx = Math.max((size.width * lenPx) / size.length, 5); // same stretch as the drawn body
    const dx = px - (fr.ox + pose[0] * fr.zoom);
    const dy = py - (fr.oy + pose[1] * fr.zoom);
    const c = Math.cos(pose[2]);
    const s = Math.sin(pose[2]);
    if (Math.abs(dx * c + dy * s) <= lenPx / 2 + 3 && Math.abs(-dx * s + dy * c) <= widPx / 2 + 3) return v;
  }
  return null;
}

/** Top-most visible free label whose text box contains the screen point. */
function hitLabel(ctx, fr, px, py) {
  if (fr.overlays.labels === false) return null;
  const labels = fr.scene.labels;
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i];
    if (!l.text || labelFontPx(l, fr.zoom, fr.cs) < 7) continue;
    const r = itemRectPx(ctx, fr, 'label', l.id);
    if (r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return l;
  }
  return null;
}

/** Top-most flow marker badge (a flow between touching stations) under the screen point, or null. */
function hitMarker(fr, px, py) {
  if (fr.overlays.flows === false) return null;
  const flows = fr.scene.flows;
  const reach = markerRadius(fr) + MARKER_HIT_SLACK_PX;
  for (let i = flows.length - 1; i >= 0; i--) {
    const m = flows[i].marker;
    if (m && Math.hypot(px - (fr.ox + m.x * fr.zoom), py - (fr.oy + m.y * fr.zoom)) <= reach) return flows[i];
  }
  return null;
}
