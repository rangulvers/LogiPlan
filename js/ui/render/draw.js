// Small canvas drawing helpers shared by the render modules. They never allocate once warmed up,
// so they are safe to call from per-frame code.

export const TAU = Math.PI * 2;

/** Add a rounded rectangle sub-path (arcTo based: works in every canvas, unlike ctx.roundRect). */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const fontCache = new Map();

/** CSS font string for a weight and pixel size; strings are cached, so repeated calls do not allocate. */
export function fontOf(theme, weight, px) {
  const key = weight * 4096 + Math.round(px * 4);
  let f = fontCache.get(key);
  if (f === undefined || f.family !== theme.font) {
    f = { family: theme.font, css: `${weight} ${Math.round(px * 4) / 4}px ${theme.font}` };
    fontCache.set(key, f);
  }
  return f.css;
}

/** Text with a contrasting halo so it stays legible over studs, roads and flow lines. */
export function haloText(ctx, text, x, y, fill, halo, haloWidth) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = haloWidth;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** Fill a rounded "pill" (used behind names, chips and badges). */
export function fillPill(ctx, x, y, w, h, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fill();
}

const textWidthCache = new Map();

/**
 * Width of `text` in the font currently set on `ctx`, cached per font+text (bricks re-measure the same
 * names every frame). The cache is bounded.
 */
export function measure(ctx, text) {
  const key = ctx.font + '|' + text;
  let w = textWidthCache.get(key);
  if (w === undefined) {
    w = ctx.measureText(text).width;
    if (textWidthCache.size > 2000) textWidthCache.clear();
    textWidthCache.set(key, w);
  }
  return w;
}
