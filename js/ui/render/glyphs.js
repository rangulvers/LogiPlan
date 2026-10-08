// Tiny vector glyphs drawn with canvas paths: station icons, status marks, bolt, clock, pallet.
// All of them draw in CSS-pixel space around a centre (cx, cy); `size` is the edge of the square they fit in.
// Icons use only fills / simple strokes in the given colour, so they stay crisp at 12 px and at 60 px.

import { TAU, roundRectPath } from './draw.js';

/** Run `fn` with the origin moved to (cx, cy) and a 24-unit design box scaled to `size` px. */
function inBox(ctx, cx, cy, size, fn) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 24, size / 24);
  fn(ctx);
  ctx.restore();
}

const GEAR_TEETH = 8;
/** One gear tooth as [angle offset (rad), radius] pairs: root, flank, flank, root. */
const GEAR_PROFILE = [[-0.24, 7.6], [-0.15, 11], [0.15, 11], [0.24, 7.6]];

const ICONS = {
  /** Delivery truck: goods arriving. */
  source(ctx) {
    ctx.beginPath();
    roundRectPath(ctx, -11.5, -7.5, 14, 11.5, 1.8);
    ctx.moveTo(4.5, -3.5);
    ctx.lineTo(8, -3.5);
    ctx.lineTo(11.5, 0.5);
    ctx.lineTo(11.5, 4);
    ctx.lineTo(4.5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-6, 6.5, 2.6, 0, TAU);
    ctx.arc(7.5, 6.5, 2.6, 0, TAU);
    ctx.fill();
  },
  /** Cog: a machine working. */
  process(ctx) {
    ctx.beginPath();
    for (let i = 0; i < GEAR_TEETH; i++) {
      const a = (i * TAU) / GEAR_TEETH;
      for (let j = 0; j < GEAR_PROFILE.length; j++) {
        const d = GEAR_PROFILE[j][0];
        const r = GEAR_PROFILE[j][1];
        const x = Math.cos(a + d) * r;
        const y = Math.sin(a + d) * r;
        if (i === 0 && j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.moveTo(3.6, 0);
    ctx.arc(0, 0, 3.6, 0, TAU, true);
    ctx.fill('evenodd');
  },
  /** Three stacked crates: a buffer. */
  storage(ctx) {
    ctx.beginPath();
    roundRectPath(ctx, -11, 0.5, 10, 9, 1.4);
    roundRectPath(ctx, 1, 0.5, 10, 9, 1.4);
    roundRectPath(ctx, -5, -9.5, 10, 9, 1.4);
    ctx.fill();
  },
  /** Parcel with an arrow leaving it: goods out. */
  sink(ctx) {
    ctx.beginPath();
    roundRectPath(ctx, -11.5, -6.5, 12, 13, 1.8);
    ctx.fill();
    ctx.beginPath();
    ctx.rect(3, -1.6, 6, 3.2);
    ctx.moveTo(7.5, -6);
    ctx.lineTo(12.5, 0);
    ctx.lineTo(7.5, 6);
    ctx.closePath();
    ctx.fill();
  },
  /** Parking sign. */
  depot(ctx) {
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    roundRectPath(ctx, -10, -10, 20, 20, 4.5);
    ctx.stroke();
    ctx.lineWidth = 2.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-3, 6);
    ctx.lineTo(-3, -6);
    ctx.lineTo(1, -6);
    ctx.arc(1, -2.4, 3.6, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-3, 1.2);
    ctx.stroke();
  },
};

/** Draw the icon of a station type, filled / stroked with `color`. Unknown types draw nothing. */
export function drawStationIcon(ctx, type, cx, cy, size, color) {
  const paint = ICONS[type];
  if (!paint) return;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  inBox(ctx, cx, cy, size, paint);
}

/** Lightning bolt (charging). */
export function drawBolt(ctx, cx, cy, size, fill, stroke) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 24, size / 24);
  ctx.beginPath();
  ctx.moveTo(2.5, -11);
  ctx.lineTo(-6.5, 1.5);
  ctx.lineTo(-0.8, 1.5);
  ctx.lineTo(-3, 11);
  ctx.lineTo(7, -2.5);
  ctx.lineTo(1.2, -2.5);
  ctx.closePath();
  if (stroke) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

/** Round clock face (a vehicle waiting in traffic). */
export function drawClock(ctx, cx, cy, r, fill, rim, hand) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1.2, r * 0.28);
  ctx.strokeStyle = rim;
  ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.2);
  ctx.lineCap = 'round';
  ctx.strokeStyle = hand;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.55);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx + r * 0.42, cy + r * 0.2);
  ctx.stroke();
}

/** Small cardboard box (a load / yard backlog). */
export function drawBox(ctx, cx, cy, size, fill, edge) {
  const h = size / 2;
  ctx.beginPath();
  roundRectPath(ctx, cx - h, cy - h, size, size, size * 0.14);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.1);
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - h, cy - size * 0.12);
  ctx.lineTo(cx + h, cy - size * 0.12);
  ctx.stroke();
}

/** Non-colour status marks drawn inside the state dot, so state is readable without colour. */
const STATUS_MARK = {
  busy: 'play', ok: 'check', normal: 'check',
  starved: 'dash', idle: 'dash',
  blocked: 'pause', waiting: 'pause', full: 'pause',
  down: 'cross', error: 'cross',
};

/** Draw the mark for `state` (play, check, pause, cross, dash) inside a dot of radius r, in `color`. */
export function drawStatusMark(ctx, state, cx, cy, r, color) {
  const mark = STATUS_MARK[state] || 'dash';
  const s = r * 0.5;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, r * 0.26);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (mark === 'play') {
    ctx.moveTo(cx - s * 0.7, cy - s);
    ctx.lineTo(cx + s * 1.05, cy);
    ctx.lineTo(cx - s * 0.7, cy + s);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (mark === 'pause') {
    ctx.moveTo(cx - s * 0.6, cy - s * 0.9);
    ctx.lineTo(cx - s * 0.6, cy + s * 0.9);
    ctx.moveTo(cx + s * 0.6, cy - s * 0.9);
    ctx.lineTo(cx + s * 0.6, cy + s * 0.9);
  } else if (mark === 'cross') {
    ctx.moveTo(cx - s * 0.85, cy - s * 0.85);
    ctx.lineTo(cx + s * 0.85, cy + s * 0.85);
    ctx.moveTo(cx + s * 0.85, cy - s * 0.85);
    ctx.lineTo(cx - s * 0.85, cy + s * 0.85);
  } else if (mark === 'check') {
    ctx.moveTo(cx - s * 0.95, cy + s * 0.05);
    ctx.lineTo(cx - s * 0.25, cy + s * 0.75);
    ctx.lineTo(cx + s * 1, cy - s * 0.75);
  } else {
    ctx.moveTo(cx - s * 0.85, cy);
    ctx.lineTo(cx + s * 0.85, cy);
  }
  ctx.stroke();
}
