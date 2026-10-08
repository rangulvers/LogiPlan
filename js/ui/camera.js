// Camera: the world <-> screen mapping of the plant canvas. Pure math, no DOM.
//
// World coordinates are metres (y points down). Screen coordinates are CSS pixels measured from the
// top-left corner of the canvas. `x, y` is the world point shown at the centre of the viewport and `zoom`
// is pixels per metre, always kept inside [MIN_ZOOM, MAX_ZOOM]. Every method tolerates non-finite input
// (it is ignored) and a viewport of 0 x 0, so UI code never has to guard its calls.
//
// MIN_ZOOM is low enough that fit() shows the largest baseplate the model allows (160 cells of 10 m =
// 1600 m, GRID_LIMITS) with the default 32 px padding on a 224 px wide viewport, so "fit view" never cuts
// a plant off on a real screen.

import { clamp } from '../util/format.js';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 80;
export const DEFAULT_ZOOM = 20;
/** Fallback baseplate (cols x rows x metres per cell) used by fit() when no valid layout is given. */
const FALLBACK_GRID = { cols: 48, rows: 32, cellSize: 2 };
/** No baseplate side is taken to be longer than this (metres): keeps absurd grids from poisoning the camera. */
const MAX_PLANT_M = 1e5;

const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * World extent {x, y, w, h} in metres of a layout's baseplate. Falls back to the default grid for
 * anything that is not a usable layout, so callers always get a non-empty, finite rectangle.
 * @param {object|null|undefined} layout
 */
export function plantBounds(layout) {
  const g = layout && layout.grid ? layout.grid : FALLBACK_GRID;
  const cs = positive(g.cellSize, FALLBACK_GRID.cellSize);
  const cols = positive(g.cols, FALLBACK_GRID.cols);
  const rows = positive(g.rows, FALLBACK_GRID.rows);
  return { x: 0, y: 0, w: Math.min(MAX_PLANT_M, cols * cs), h: Math.min(MAX_PLANT_M, rows * cs) };
}

export class Camera {
  /**
   * @param {{ x?: number, y?: number, zoom?: number, width?: number, height?: number }} [state]
   *   x,y = world metres at the viewport centre; zoom = pixels per metre; width,height = viewport in CSS px
   */
  constructor({ x = 0, y = 0, zoom = DEFAULT_ZOOM, width = 0, height = 0 } = {}) {
    this.x = finite(x, 0);
    this.y = finite(y, 0);
    this.zoom = clamp(finite(zoom, DEFAULT_ZOOM), MIN_ZOOM, MAX_ZOOM);
    this.width = Math.max(0, finite(width, 0));
    this.height = Math.max(0, finite(height, 0));
  }

  /** Tell the camera how big the canvas is (CSS px). Negative / non-finite sizes count as 0. */
  setViewport(width, height) {
    this.width = Math.max(0, finite(width, 0));
    this.height = Math.max(0, finite(height, 0));
    return this;
  }

  /** World metres -> screen px. Pass `out` to avoid an allocation in hot loops. */
  worldToScreen(x, y, out = [0, 0]) {
    out[0] = (x - this.x) * this.zoom + this.width / 2;
    out[1] = (y - this.y) * this.zoom + this.height / 2;
    return out;
  }

  /** Screen px -> world metres. */
  screenToWorld(px, py, out = [0, 0]) {
    out[0] = (px - this.width / 2) / this.zoom + this.x;
    out[1] = (py - this.height / 2) / this.zoom + this.y;
    return out;
  }

  /**
   * Screen px -> grid cell [cx, cy] (may be negative or beyond the grid: callers bounds-check). A non-finite
   * coordinate counts as the viewport centre, like in zoomAt.
   */
  screenToCell(px, py, cellSize, out = [0, 0]) {
    const cs = cellSize > 0 ? cellSize : 1;
    this.screenToWorld(finite(px, this.width / 2), finite(py, this.height / 2), out);
    out[0] = Math.floor(out[0] / cs) + 0;
    out[1] = Math.floor(out[1] / cs) + 0;
    return out;
  }

  /** Drag the content by (dxPx, dyPx) screen pixels (the world follows the pointer). */
  pan(dxPx, dyPx) {
    this.x -= finite(dxPx, 0) / this.zoom;
    this.y -= finite(dyPx, 0) / this.zoom;
    return this;
  }

  /**
   * Multiply the zoom by `factor` while the world point under screen position (px, py) stays put.
   * The result is clamped to [MIN_ZOOM, MAX_ZOOM]. Without a position the viewport centre is used.
   * @returns {boolean} true when the zoom actually changed
   */
  zoomAt(factor, px, py) {
    if (!(factor > 0) || !Number.isFinite(factor)) return false;
    const next = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === this.zoom) return false;
    const ox = finite(px, this.width / 2) - this.width / 2;
    const oy = finite(py, this.height / 2) - this.height / 2;
    this.x += ox / this.zoom - ox / next;
    this.y += oy / this.zoom - oy / next;
    this.zoom = next;
    return true;
  }

  /** Set an absolute zoom (px per metre), keeping the point under (px, py) fixed. */
  zoomTo(zoom, px, py) {
    return Number.isFinite(zoom) && zoom > 0 ? this.zoomAt(zoom / this.zoom, px, py) : false;
  }

  /** Put world point (x, y) in the middle of the viewport. */
  centerOn(x, y) {
    this.x = finite(x, this.x);
    this.y = finite(y, this.y);
    return this;
  }

  /**
   * Centre and scale so the whole baseplate of `layout` (grid extent) is visible with `padding` px
   * of margin on every side. Also records the viewport size. A null layout fits the default grid.
   */
  fit(layout, widthPx, heightPx, padding = 32) {
    return this.fitRect(plantBounds(layout), widthPx, heightPx, padding);
  }

  /**
   * Centre and scale so the world rectangle {x, y, w, h} (metres) fills the viewport minus `padding` px.
   * @param {number} [maxZoom] upper zoom limit for this fit (e.g. so a single station is not blown up)
   */
  fitRect(rect, widthPx, heightPx, padding = 32, maxZoom = MAX_ZOOM) {
    this.setViewport(widthPx, heightPx);
    const w = positive(rect && rect.w, 1);
    const h = positive(rect && rect.h, 1);
    const pad = Math.max(0, finite(padding, 0));
    const availW = Math.max(1, this.width - 2 * pad);
    const availH = Math.max(1, this.height - 2 * pad);
    const limit = clamp(finite(maxZoom, MAX_ZOOM), MIN_ZOOM, MAX_ZOOM);
    this.zoom = clamp(Math.min(availW / w, availH / h), MIN_ZOOM, limit);
    this.x = finite(rect && rect.x, 0) + w / 2;
    this.y = finite(rect && rect.y, 0) + h / 2;
    return this;
  }

  /** World rectangle currently visible, as {x0, y0, x1, y1} in metres. */
  visibleRect(out = { x0: 0, y0: 0, x1: 0, y1: 0 }) {
    const hw = this.width / 2 / this.zoom;
    const hh = this.height / 2 / this.zoom;
    out.x0 = this.x - hw;
    out.y0 = this.y - hh;
    out.x1 = this.x + hw;
    out.y1 = this.y + hh;
    return out;
  }

  /** Independent copy (used for undo of view changes and for the export camera). */
  clone() {
    return new Camera(this);
  }
}
