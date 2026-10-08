// StaticLayer: the cached offscreen bitmap of the static plant drawing (see static.js).
//
// The bitmap covers the visible world rectangle plus a margin (clipped to the baseplate), at the zoom it was
// rendered for. Frames blit it with the current camera transform. It is rebuilt only when
//   * the layout object, theme, devicePixelRatio, canvas size or one of the toggles (grid / studs / labels) changes,
//   * the zoom moved by more than 1.25x (the bucket), or the zoom has been steady for SETTLE_MS (re-render sharp),
//   * the visible area leaves the cached window (panning far enough).
// While a wheel zoom is in progress the stale bitmap is simply scaled.

import { drawStatic, PLATE_MARGIN_M } from './static.js';

/** Zoom ratio beyond which the bitmap is re-rendered immediately. */
const ZOOM_BUCKET = 1.25;
/** A zoom that has not changed for this long gets a sharp re-render. */
export const SETTLE_MS = 140;
const MAX_PIXELS = 24e6;
const MAX_SIDE = 8192;
const MARGINS = [0.35, 0.15, 0];

export class StaticLayer {
  /** @param {(w: number, h: number) => HTMLCanvasElement} createCanvas */
  constructor(createCanvas) {
    this.createCanvas = createCanvas;
    this.canvas = null;
    this.valid = false;
    this.builds = 0;
    this.zoom = 0; // zoom the bitmap was rendered for
    this.k = 1; // bitmap px per metre
    this.win = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this.seenZoom = 0;
    this.zoomChangedAt = 0;
    /** True after prepare() when the bitmap is a scaled stand-in and a settle re-render is due. */
    this.pending = false;
    // what the bitmap was rendered for
    this.layout = null;
    this.theme = null;
    this.dpr = 0;
    this.width = 0;
    this.height = 0;
    this.flags = 0;
    this.visible = { x0: 0, y0: 0, x1: 0, y1: 0 }; // scratch: visible area clipped to the baseplate
  }

  /** Forget the bitmap (the next prepare() rebuilds). */
  invalidate() {
    this.valid = false;
  }

  /**
   * Make the bitmap usable for this frame, rebuilding it when needed. Allocation-free unless it rebuilds.
   * @param {object} fr frame (scene, theme, layout, zoom, dpr, w, h, vis, overlays, now)
   * @returns {boolean} false when nothing of the baseplate is visible
   */
  prepare(fr) {
    const scene = fr.scene;
    const vis = this.visible;
    this.pending = false;
    if (!clipInto(vis, fr.vis, -PLATE_MARGIN_M, -PLATE_MARGIN_M, scene.width + PLATE_MARGIN_M, scene.height + PLATE_MARGIN_M)) return false;
    if (fr.zoom !== this.seenZoom) {
      this.seenZoom = fr.zoom;
      this.zoomChangedAt = fr.now;
    }
    const ov = fr.overlays;
    const flags = (ov.studs !== false ? 1 : 0) | (ov.grid !== false ? 2 : 0) | (ov.labels !== false ? 4 : 0);
    const same = this.valid && this.layout === fr.layout && this.theme === fr.theme && this.dpr === fr.dpr
      && this.width === fr.w && this.height === fr.h && this.flags === flags;
    if (!same) return this.rebuild(fr, vis, flags);
    const ratio = fr.zoom / this.zoom;
    if (ratio > ZOOM_BUCKET || ratio < 1 / ZOOM_BUCKET || !contains(this.win, vis, 0.5 / this.k)) return this.rebuild(fr, vis, flags);
    if (fr.zoom !== this.zoom) {
      if (fr.now - this.zoomChangedAt >= SETTLE_MS) return this.rebuild(fr, vis, flags);
      this.pending = true;
    }
    return true;
  }

  /** Render the window around `vis` (visible area clipped to the baseplate) into the bitmap. */
  rebuild(fr, vis, flags) {
    const { zoom, dpr } = fr;
    const scene = fr.scene;
    const m = PLATE_MARGIN_M;
    let k = zoom * dpr;
    const win = { x0: 0, y0: 0, x1: 0, y1: 0 };
    for (const f of MARGINS) {
      clipInto(win, { x0: vis.x0 - (f * fr.w) / zoom, y0: vis.y0 - (f * fr.h) / zoom, x1: vis.x1 + (f * fr.w) / zoom, y1: vis.y1 + (f * fr.h) / zoom }, -m, -m, scene.width + m, scene.height + m);
      if (fits(win, k)) break;
    }
    // last resort (huge viewports): lower the bitmap resolution until it fits
    while (!fits(win, k)) k *= 0.8;
    win.x0 = Math.floor(win.x0 * k) / k;
    win.y0 = Math.floor(win.y0 * k) / k;
    win.x1 = Math.ceil(win.x1 * k) / k;
    win.y1 = Math.ceil(win.y1 * k) / k;
    const bw = Math.max(1, Math.round((win.x1 - win.x0) * k));
    const bh = Math.max(1, Math.round((win.y1 - win.y0) * k));
    if (!this.canvas) this.canvas = this.createCanvas(bw, bh);
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(k, 0, 0, k, -win.x0 * k, -win.y0 * k);
    drawStatic(ctx, scene, fr.theme, { k, zoom, win, studs: (flags & 1) !== 0, grid: (flags & 2) !== 0, labels: (flags & 4) !== 0 });
    this.win = win;
    this.k = k;
    this.zoom = zoom;
    this.layout = fr.layout;
    this.theme = fr.theme;
    this.dpr = fr.dpr;
    this.width = fr.w;
    this.height = fr.h;
    this.flags = flags;
    this.valid = true;
    this.builds++;
    return true;
  }

  /** Blit the bitmap with the frame's camera transform (identity context transform expected). */
  blit(ctx, fr) {
    if (!this.valid) return;
    const s = fr.zoom * fr.dpr;
    const { win } = this;
    ctx.drawImage(this.canvas, 0, 0, this.canvas.width, this.canvas.height, fr.tx + win.x0 * s, fr.ty + win.y0 * s, (win.x1 - win.x0) * s, (win.y1 - win.y0) * s);
  }
}

/** Intersect rectangle `r` with the box (x0, y0, x1, y1) into `out`; false when they do not overlap. */
function clipInto(out, r, x0, y0, x1, y1) {
  out.x0 = Math.max(r.x0, x0);
  out.y0 = Math.max(r.y0, y0);
  out.x1 = Math.min(r.x1, x1);
  out.y1 = Math.min(r.y1, y1);
  return out.x1 > out.x0 && out.y1 > out.y0;
}

const contains = (outer, inner, eps) => inner.x0 >= outer.x0 - eps && inner.y0 >= outer.y0 - eps && inner.x1 <= outer.x1 + eps && inner.y1 <= outer.y1 + eps;

function fits(win, k) {
  const w = (win.x1 - win.x0) * k;
  const h = (win.y1 - win.y0) * k;
  return w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS;
}
