// Text that lives on the plant itself: free labels (layout.labels) and the "50 %" badges of speed zones.
// Drawn every frame in CSS-pixel space after the flows and bricks, so a flow arrow never cuts through a label
// and what is drawn on top is also what hit testing returns first. Both are switched by overlays.labels.
//
// Label `size` is a text height in grid cells (js/model/layout.js): a label of size 1 is one cell tall, so
// text scales with the cell size like everything else on the plan. The anchor (x, y) is the label centre, in cells.

import { fontOf, haloText, fillPill, measure } from './draw.js';

/** Font size as a fraction of the label's text height (the line box includes some leading). */
const LABEL_FONT_RATIO = 0.8;
const MIN_LABEL_PX = 7;
/** A label this large is bigger than any screen: capped so a huge `size` cannot make the rasteriser crawl. */
const MAX_LABEL_PX = 400;
/** Rough average glyph width as a fraction of the font size, for culling labels before measuring them. */
const AVG_GLYPH_EM = 0.62;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Font size in CSS px of a scene label (see scene.js: `size` is finite and positive) at `zoom` px per metre
 * on a baseplate with `cs` metre cells.
 */
export function labelFontPx(label, zoom, cs) {
  return Math.min(MAX_LABEL_PX, LABEL_FONT_RATIO * label.size * cs * zoom);
}

/** Draw the free labels and the speed-zone badges. Expects the CSS-pixel transform. */
export function drawLabels(ctx, fr) {
  if (fr.overlays.labels === false) return;
  const { scene, zoom, cs } = fr;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of scene.labels) {
    const px = labelFontPx(l, zoom, cs);
    if (px < MIN_LABEL_PX || !l.text) continue;
    const x = fr.ox + l.x * cs * zoom;
    const y = fr.oy + l.y * cs * zoom;
    const halfW = l.text.length * px * AVG_GLYPH_EM * 0.5;
    if (x + halfW < 0 || x - halfW > fr.w || y + px < 0 || y - px > fr.h) continue;
    ctx.font = fontOf(fr.theme, 600, px);
    haloText(ctx, l.text, x, y, fr.theme.label, fr.theme.labelHalo, Math.max(2.5, px * 0.28));
  }
  drawZoneBadges(ctx, fr);
}

/** "50 %" badges on speed zones (one per connected zone), when cells are big enough to carry one. */
function drawZoneBadges(ctx, fr) {
  const cellPx = fr.cs * fr.zoom;
  if (cellPx < 16) return;
  const px = clamp(cellPx * 0.22, 8, 13);
  const h = px + 5;
  const theme = fr.theme;
  ctx.font = fontOf(theme, 700, px);
  for (const z of fr.scene.zones) {
    const x = fr.ox + (z.cx + 0.5) * cellPx;
    const y = fr.oy + (z.cy + 0.5) * cellPx;
    if (x < -40 || x > fr.w + 40 || y < -20 || y > fr.h + 20) continue;
    const text = `${Math.round(z.limit * 100)} %`;
    const w = measure(ctx, text) + 8;
    fillPill(ctx, x - w / 2, y - h / 2, w, h, theme.zoneBadge);
    ctx.fillStyle = theme.zoneBadgeInk;
    ctx.fillText(text, x, y + 0.5);
  }
}
