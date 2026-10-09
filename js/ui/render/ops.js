// Trucks and dock doors on the plan (docs/WAREHOUSE-DESIGN.md 7.2 "Canvas", 7.7). Drawn on the brick of a Goods in or Goods out that has `ops.trucks`;
// every other brick, and every plant without trucks, is not touched by anything in this file. bricks.js calls it exactly twice:
//
//   planOps(ctx, fr, g, type, st, rt)         while the face is laid out: the band of door slots along the LOWER EDGE of the face (never on road cells: the
//                                             band lies inside the brick), returns the plan or null. The plan carries `face`, the top face without
//                                             the band, which planContent then lays its name tile, state dot and bars out in, and `block`, the
//                                             rectangle the studs must stay away from.
//   paintOps(ctx, fr, g, pal, st, rt, plan)   while the face is painted: the slots, the gate-queue chip, the staged pallets of a Goods out and, with the
//                                             Docks overlay on (or the brick picked), the dock share bars
//
//   Door slots   a row of N small slots, N = ops.trucks.doors. Free = a dashed outline; occupied = a truck (box and cab) in the colour of its state with
//                the glyph of the state on it: a clock while checking in or out, an arrow while pallets are unloaded (into the brick) or loaded (out of
//                it), a pause bar pair while the truck waits for vehicles or for pallets. Colour never carries the state alone. From a cell of 14 px
//                (SLOT_MIN_CELL_PX); below that only the count of doors (the flat swatch of a brick below 5 px has no content at all).
//   Gate chip    "Gate 5 trucks, 38 min": the trucks waiting at the gate and the longest wait; neutral below 15 min, amber from 15 min (GATE_AMBER_SECONDS),
//                red from 45 min (GATE_RED_SECONDS, with a "!" mark); shortened to fit ("Gate 5, 38 min", "5, 38 min", "5").
//   Staged       Goods out, from a cell of 24 px: a row of small pallet squares above the slots, filled for a staged pallet, an outline for free staging
//                space (doors x staging, at most MAX_STAGED).
//   Dock shares  from a cell of 24 px, with the Docks overlay: a thin bar next to the notch of every dock cell of the brick, as long as the visits of that
//                dock compared with the busiest dock of the station (report.stations[id].docks, the EXISTING dock book figures): one long bar and two
//                empty ones is the symptom, three even bars the proof that the dock choice works.
//
// What it reads of the simulation (an absent field means nothing is shown, nothing throws): rt.trucks.gate[] (trucks with `at`), rt.trucks.docked[] (trucks
// with `state` 'checkin' | 'work' | 'checkout' and `door`, the 0-based slot the desk gave them; for a Goods out `loaded` and `plan`), rt.trucks.staged (an
// array of pallets or a count), rt.inboundTotal and rt.state ('blocked' = pallets wait for staging space), sim.time and sim.kpis() (cached for 250 ms, only
// while dock shares are shown). The shape is that of sim/logistics/trucks.js (TruckDesk, Truck).
// Performance: per frame and brick a few number reads; the plans and the readings are reused (no allocation once warm), strings are cached per value.

import { trucksOf } from '../../model/ops.js';
import { formatDuration } from '../../util/format.js';
import { STATUS_COLORS, STATUS_INK } from '../theme.js';
import { TAU, fillPill, fontOf, measure, roundRectPath } from './draw.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The longest wait at the gate (s) from which the chip turns amber, and red (7.2: "amber from 15 min, red from 45 min"). */
export const GATE_AMBER_SECONDS = 15 * 60;
export const GATE_RED_SECONDS = 45 * 60;
/** Door slots from this cell size (px); below it only the number of doors. */
export const SLOT_MIN_CELL_PX = 14;
/** Staged pallets and dock share bars from this cell size (px). */
export const STAGED_MIN_CELL_PX = 24;
export const SHARE_MIN_CELL_PX = 24;
/** Most staging squares drawn. */
export const MAX_STAGED = 24;
/** A slot is not drawn narrower than this (px): the doors are then counted instead. */
const SLOT_MIN_W = 6;
/** Lifetime (ms) of the report the share bars read. */
const REPORT_MS = 250;
const RED = '#c92a2a';
const RED_INK = '#ffffff';

/** The state of one door slot. */
export const DOOR = Object.freeze({ FREE: 0, CHECKIN: 1, WORK: 2, WAIT: 3, CHECKOUT: 4, CLOSED: 5 });
/** Glyph per door state: 'clock' | 'arrow' | 'pause' (| 'lock', M2). */
const GLYPH = [null, 'clock', 'arrow', 'pause', 'clock', 'lock'];
/** Words for the popover and the labels. */
export const DOOR_WORDS = Object.freeze(['free', 'checking in', 'working', 'waiting', 'checking out', 'closed']);

// ---------------------------------------------------------------------------------------------------------
// Reading the runtime (pure)
// ---------------------------------------------------------------------------------------------------------

/** A reading of the doors of one station: reused every frame. */
export function createReading() {
  return { doors: 0, states: new Uint8Array(32), trucks: new Array(32).fill(null), busy: 0, gate: 0, wait: 0, staged: 0, stagedCap: 0 };
}

/**
 * The state of a docked truck as a door state. The pause glyph means "the door is held but nothing moves": at a Goods in the pallets wait for staging space
 * (the station is blocked), at a Goods out the truck waits for pallets (nothing staged and no vehicle on its way with some). A closed door (M2) has no truck.
 */
export function doorStateOf(truck, rt, outbound) {
  const s = truck && truck.state;
  if (s === 'checkin') return DOOR.CHECKIN;
  if (s === 'checkout') return DOOR.CHECKOUT;
  if (truck && truck.waiting === true) return DOOR.WAIT;
  if (outbound) {
    const desk = rt && rt.trucks;
    const staged = desk && Array.isArray(desk.staged) ? desk.staged.length : 0;
    const coming = rt && finite(rt.inboundTotal) ? rt.inboundTotal : 0;
    return staged === 0 && coming === 0 && !(finite(truck && truck.loaded) && truck.plan > 0 && truck.loaded >= truck.plan) ? DOOR.WAIT : DOOR.WORK;
  }
  return rt && rt.state === 'blocked' ? DOOR.WAIT : DOOR.WORK;
}

/**
 * Fill `out` (createReading) from the runtime station `rt` of a station with `trucks.doors` doors. `rt` may be null, or have no `trucks` (a plant
 * that has not run, a simulation built before the trucks were switched on): then every door is free and nothing waits. A docked truck sits in the door
 * the desk gave it (`truck.door`, 0-based, the lowest free one when it docked); a truck without one takes the lowest free slot.
 * @returns {object} `out`
 */
export function readDoors(rt, trucks, now, outbound, out) {
  const doors = clamp(Math.round(trucks.doors) || 0, 0, 32);
  out.doors = doors;
  out.states.fill(DOOR.FREE, 0, doors);
  for (let i = 0; i < doors; i++) out.trucks[i] = null;
  out.busy = 0;
  out.gate = 0;
  out.wait = 0;
  out.staged = 0;
  out.stagedCap = outbound ? Math.min(MAX_STAGED, Math.max(0, Math.round(trucks.doors * trucks.staging) || 0)) : 0;
  const tk = rt && typeof rt === 'object' ? rt.trucks : null;
  if (!tk || typeof tk !== 'object') return out;
  if (Array.isArray(tk.gate)) {
    out.gate = tk.gate.length;
    let oldest = Infinity;
    for (let i = 0; i < tk.gate.length; i++) {
      const at = tk.gate[i] && tk.gate[i].at;
      if (finite(at) && at < oldest) oldest = at;
    }
    out.wait = out.gate > 0 && finite(now) && oldest !== Infinity ? Math.max(0, now - oldest) : 0;
  }
  if (Array.isArray(tk.docked) && doors > 0) {
    const used = out.states;
    for (let pass = 0; pass < 2; pass++) { // first the trucks that name a door, then the others (and the ones whose door was taken) take the lowest free slots
      for (let i = 0; i < tk.docked.length; i++) {
        const truck = tk.docked[i];
        const named = truck && Number.isInteger(truck.door) && truck.door >= 0 && truck.door < doors;
        let slot;
        if (pass === 0) {
          if (!named || used[truck.door] !== DOOR.FREE) continue;
          slot = truck.door;
        } else {
          if (named && out.trucks[truck.door] === truck) continue; // placed in the first pass
          slot = 0;
          while (slot < doors && used[slot] !== DOOR.FREE) slot++;
          if (slot >= doors) continue; // more trucks than doors: not possible in a valid run
        }
        used[slot] = doorStateOf(truck, rt, outbound);
        out.trucks[slot] = truck;
        out.busy++;
      }
    }
  }
  if (outbound) out.staged = Array.isArray(tk.staged) ? tk.staged.length : finite(tk.staged) ? Math.max(0, tk.staged) : 0;
  return out;
}

/**
 * The state of the doors in words, for the inspector (the text twin of the picture on the plan, for a screen reader and for a plan too small to show slots):
 * "2 working, 1 checking in, 1 free. 3 trucks at the gate, the longest has waited 38 min." A Goods out adds "5 pallets staged".
 * @param {ReturnType<typeof createReading>} rd a reading filled by readDoors
 * @param {boolean} outbound
 */
export function describeDoors(rd, outbound) {
  const counts = new Array(DOOR_WORDS.length).fill(0);
  for (let i = 0; i < rd.doors; i++) counts[rd.states[i]]++;
  const order = [DOOR.WORK, DOOR.WAIT, DOOR.CHECKIN, DOOR.CHECKOUT, DOOR.FREE];
  const parts = [];
  for (const state of order) {
    if (counts[state] === 0) continue;
    parts.push(`${counts[state]} ${state === DOOR.WAIT ? (outbound ? 'waiting for pallets' : 'held, waiting for vehicles') : DOOR_WORDS[state]}`);
  }
  let text = `${parts.join(', ')}.`;
  text += rd.gate > 0 ? ` ${rd.gate} ${rd.gate === 1 ? 'truck' : 'trucks'} at the gate, the longest has waited ${formatDuration(rd.wait)}.` : ' No truck at the gate.';
  if (outbound && rd.stagedCap > 0) text += ` ${rd.staged} ${rd.staged === 1 ? 'pallet' : 'pallets'} staged.`;
  return text;
}

/** 'neutral' | 'amber' | 'red' for the longest wait at the gate (s). */
export function gateTone(waitSeconds) {
  if (waitSeconds >= GATE_RED_SECONDS) return 'red';
  return waitSeconds >= GATE_AMBER_SECONDS ? 'amber' : 'neutral';
}

/**
 * The texts of the gate chip from the longest to the shortest: "Gate 5 trucks, 38 min", "Gate 5, 38 min", "5, 38 min", "5".
 * @returns {string[]}
 */
export function gateTexts(count, waitSeconds) {
  const wait = formatDuration(waitSeconds);
  return [`Gate ${count} ${count === 1 ? 'truck' : 'trucks'}, ${wait}`, `Gate ${count}, ${wait}`, `${count}, ${wait}`, String(count)];
}

/** Bar lengths 0..1 of the dock share bars: the visits of each dock compared with the busiest dock; all 0 when nothing was served. */
export function shareFractions(visits) {
  let max = 0;
  for (const v of visits) if (finite(v) && v > max) max = v;
  return visits.map((v) => (max > 0 && finite(v) ? clamp(v / max, 0, 1) : 0));
}

/**
 * How the slots and the chip share the width of the band. The slots come first: the chip takes the longest of its texts that still leaves every slot
 * a comfortable width (0.56 x the band height, at least 10 px), else the shortest text, else (slots would be narrower than SLOT_MIN_W) the doors are counted instead
 * of drawn. `chipWidths` are the widths of the texts of the chip from the longest to the shortest ([] without a chip).
 * @returns {{ variant: number, slotW: number, gap: number }} `variant`: the chip text to use (-1: no chip), `slotW` 0 = count the doors
 */
export function chooseBand(width, doors, bandH, chipWidths) {
  const gap = clamp(bandH * 0.18, 2, 5);
  const natural = bandH * 1.7;
  const comfy = Math.max(SLOT_MIN_W + 4, bandH * 0.56);
  const slotWidthFor = (room) => Math.min(natural, (room - (doors - 1) * gap) / Math.max(1, doors));
  if (chipWidths.length === 0) {
    const slotW = slotWidthFor(width);
    return { variant: -1, slotW: slotW >= SLOT_MIN_W ? slotW : 0, gap };
  }
  for (let v = 0; v < chipWidths.length; v++) {
    const slotW = slotWidthFor(width - chipWidths[v] - gap * 2);
    if (slotW >= comfy) return { variant: v, slotW, gap };
  }
  const last = chipWidths.length - 1;
  const slotW = slotWidthFor(width - chipWidths[last] - gap * 2);
  if (slotW >= SLOT_MIN_W) return { variant: last, slotW, gap };
  const fits = chipWidths.findIndex((w) => w <= width);
  return { variant: fits, slotW: 0, gap };
}

// ---------------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------------

const plans = new WeakMap();
const reading = createReading();

function planOf(st) {
  let p = plans.get(st);
  if (!p) {
    p = {
      face: {}, block: { x: 0, y: 0, w: 0, h: 0 }, mode: 'slots', n: 0, bandX: 0, bandY: 0, bandW: 0, bandH: 0, outbound: false, trucks: null, stagedH: 0,
      texts: null, textKey: '', widths: [0, 0, 0, 0], chipText: '', chipW: 0, chipPadX: 0, chipMark: 0, chipFont: 10,
    };
    plans.set(st, p);
  }
  return p;
}

/**
 * The band of door slots of a brick, or null (no trucks, a placement ghost, a face too small for a band). Called by planContent; see the header.
 * @param {object} g brick geometry (bricks.js brickGeometry)
 * @param {object|null} st layout station, null for a ghost
 */
export function planOps(ctx, fr, g, type, st, rt) {
  if (!st || (type !== 'source' && type !== 'sink')) return null;
  const trucks = trucksOf(st);
  if (!trucks) return null;
  const pad = clamp(g.cell * 0.1, 3, 9); // the padding planContent uses
  const outbound = type === 'sink';
  const room = g.h - 2 * Math.min(pad, 3);
  const bandH = Math.min(clamp(g.cell * 0.4, 11, 30), room - 18);
  if (!(bandH >= 9)) return null;
  const stagedH = outbound && trucks.staging > 0 && g.cell >= STAGED_MIN_CELL_PX && room >= bandH + 18 + 12 ? Math.min(clamp(g.cell * 0.2, 6, 11), room - bandH - 18) : 0;
  const reserve = bandH + (stagedH > 0 ? stagedH + 3 : 0) + Math.min(pad, 3) + 2;
  const p = planOf(st);
  p.mode = g.cell >= SLOT_MIN_CELL_PX ? 'slots' : 'count';
  p.n = Math.round(trucks.doors) || 0;
  p.outbound = outbound;
  p.trucks = trucks;
  p.bandX = g.x + pad;
  p.bandW = g.w - 2 * pad;
  p.bandH = bandH;
  p.stagedH = stagedH;
  p.bandY = g.y + g.h - Math.min(pad, 3) - bandH - 1;
  Object.assign(p.face, g);
  p.face.h = g.h - reserve;
  p.block.x = g.x + pad;
  p.block.y = p.bandY - (stagedH > 0 ? stagedH + 3 : 0);
  p.block.w = p.bandW;
  p.block.h = g.y + g.h - p.block.y;
  return p;
}

// ---------------------------------------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------------------------------------

/** Colour of a door state (STATUS_COLORS: there is no palette of its own). */
function doorColor(state) {
  switch (state) {
    case DOOR.WORK: return STATUS_COLORS.busy;
    case DOOR.WAIT: return STATUS_COLORS.blocked;
    case DOOR.CLOSED: return STATUS_COLORS.down;
    default: return STATUS_COLORS.idle;
  }
}

/** A glyph centred on (cx, cy) with "radius" r: 'clock' | 'arrow' (dir: -1 points up = into the brick, +1 down = out of it) | 'pause' | 'lock'. */
function drawGlyph(ctx, kind, cx, cy, r, ink, dir) {
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = Math.max(1, r * 0.3);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (kind === 'clock') {
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.moveTo(cx, cy - r * 0.55);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + r * 0.45, cy + r * 0.2);
    ctx.stroke();
  } else if (kind === 'arrow') {
    const a = r * 0.95; // dir is where the arrow points: -1 up (into the brick), +1 down (out of it)
    ctx.moveTo(cx, cy - dir * a);
    ctx.lineTo(cx, cy + dir * a);
    ctx.moveTo(cx - a * 0.6, cy + dir * a * 0.35);
    ctx.lineTo(cx, cy + dir * a);
    ctx.lineTo(cx + a * 0.6, cy + dir * a * 0.35);
    ctx.stroke();
  } else if (kind === 'pause') {
    ctx.moveTo(cx - r * 0.42, cy - r * 0.78);
    ctx.lineTo(cx - r * 0.42, cy + r * 0.78);
    ctx.moveTo(cx + r * 0.42, cy - r * 0.78);
    ctx.lineTo(cx + r * 0.42, cy + r * 0.78);
    ctx.stroke();
  } else if (kind === 'lock') {
    ctx.arc(cx, cy - r * 0.35, r * 0.45, Math.PI, 0);
    ctx.stroke();
    ctx.fillRect(cx - r * 0.7, cy - r * 0.15, r * 1.4, r * 1.0);
  }
}

/** One door slot at (x, y), w x h px. */
function drawSlot(ctx, pal, x, y, w, h, state, inbound) {
  if (state === DOOR.FREE) {
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, Math.min(3, h / 4));
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = pal.ink;
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * 0.55;
    ctx.setLineDash(DASH);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.globalAlpha = alpha;
    return;
  }
  const colour = doorColor(state);
  const cab = w >= 14 ? w * 0.28 : 0;
  const boxW = w - cab;
  ctx.fillStyle = colour;
  ctx.beginPath();
  roundRectPath(ctx, x, y, boxW, h, Math.min(3, h / 4));
  ctx.fill();
  if (cab > 0) {
    ctx.beginPath();
    roundRectPath(ctx, x + boxW + 1, y + h * 0.3, cab - 1, h * 0.7, Math.min(2.5, h / 5));
    ctx.fill();
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = pal.edge;
  ctx.beginPath();
  roundRectPath(ctx, x + 0.5, y + 0.5, boxW - 1, h - 1, Math.min(3, h / 4));
  ctx.stroke();
  const r = Math.min(boxW, h) * 0.3;
  if (r >= 2.4) drawGlyph(ctx, GLYPH[state], x + boxW / 2, y + h / 2, r, STATUS_INK, inbound ? -1 : 1);
}
const NO_DASH = [];
const DASH = [2, 2];

/** Cached strings: the chip texts of one station, rebuilt only when the count or the minute changes. */
function textsOf(p, count, wait) {
  const key = `${count}|${Math.floor(wait / 60)}|${wait < 90 ? Math.floor(wait / 10) : 0}`;
  if (p.textKey !== key) {
    p.textKey = key;
    p.texts = gateTexts(count, wait);
  }
  return p.texts;
}

/** Measure the texts of the gate chip (p.widths, longest first; p.texts); false when nothing waits at the gate. */
function measureChip(ctx, fr, p, rd) {
  if (!(rd.gate > 0)) return false;
  const fpx = clamp(p.bandH * 0.62, 9, 13);
  ctx.font = fontOf(fr.theme, 700, fpx);
  p.chipFont = fpx;
  p.chipPadX = clamp(p.bandH * 0.25, 3, 6);
  p.chipMark = p.bandH >= 12 ? p.bandH * 0.66 : 0; // room for the glyph of the chip
  const texts = textsOf(p, rd.gate, rd.wait);
  for (let i = 0; i < texts.length; i++) p.widths[i] = measure(ctx, texts[i]) + 2 * p.chipPadX + p.chipMark;
  return true;
}

function drawChip(ctx, fr, p, rd, x, y) {
  const tone = gateTone(rd.wait);
  const fill = tone === 'red' ? RED : tone === 'amber' ? STATUS_COLORS.starved : fr.theme.tile;
  const ink = tone === 'red' ? RED_INK : tone === 'amber' ? STATUS_INK : fr.theme.tileInk;
  fillPill(ctx, x - 1, y - 1, p.chipW + 2, p.bandH + 2, '#ffffff');
  fillPill(ctx, x, y, p.chipW, p.bandH, fill);
  ctx.font = fontOf(fr.theme, 700, p.chipFont);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = ink;
  if (p.chipMark > 0) {
    const cx = x + p.chipPadX * 0.5 + p.chipMark * 0.5;
    const cy = y + p.bandH / 2;
    if (tone === 'red') { // "!" in a ring: the colour-independent mark of a long wait
      ctx.beginPath();
      ctx.arc(cx, cy, p.chipMark * 0.36, 0, TAU);
      ctx.lineWidth = Math.max(1.2, p.bandH * 0.1);
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.fillRect(cx - 0.9, cy - p.chipMark * 0.2, 1.8, p.chipMark * 0.22);
      ctx.fillRect(cx - 0.9, cy + p.chipMark * 0.07, 1.8, 1.8);
    } else {
      drawGlyph(ctx, 'clock', cx, cy, p.chipMark * 0.34, ink, 0);
    }
  }
  ctx.fillStyle = ink;
  ctx.fillText(p.chipText, x + p.chipPadX + p.chipMark - (p.chipMark > 0 ? p.chipPadX * 0.3 : 0), y + p.bandH / 2 + 0.5);
}

/** The row of staged pallets above the slots (Goods out). */
function drawStaged(ctx, pal, p, rd, x, y) {
  const n = rd.stagedCap;
  if (!(n > 0) || !(p.stagedH > 0)) return;
  const s = p.stagedH;
  const gap = 2;
  const w = n * s + (n - 1) * gap;
  let sx = x + Math.max(0, (p.bandW - w) / 2);
  if (w > p.bandW) sx = x;
  const filled = Math.min(n, rd.staged);
  const fit = Math.max(1, Math.min(n, Math.floor((p.bandW + gap) / (s + gap))));
  ctx.lineWidth = 1;
  for (let i = 0; i < fit; i++) {
    const px = sx + i * (s + gap);
    ctx.beginPath();
    roundRectPath(ctx, px, y, s, s, 1.5);
    if (i < filled) {
      ctx.fillStyle = pal.bar;
      ctx.fill();
      ctx.strokeStyle = pal.edge;
    } else {
      ctx.strokeStyle = pal.inkDim;
    }
    ctx.stroke();
  }
}

/**
 * Paint the doors of a brick (called by paintContent). `plan` is what planOps returned for this frame.
 */
export function paintOps(ctx, fr, g, pal, st, rt, plan) {
  const p = plan;
  const outbound = p.outbound;
  const sim = fr.sim;
  const rd = readDoors(rt, p.trucks, sim && finite(sim.time) ? sim.time : 0, outbound, reading);
  const hasChip = measureChip(ctx, fr, p, rd);
  const bandRight = p.bandX + p.bandW;
  const choice = p.mode === 'slots' && rd.doors > 0
    ? chooseBand(p.bandW, rd.doors, p.bandH, hasChip ? p.widths : NO_WIDTHS)
    : { variant: hasChip ? p.widths.findIndex((w) => w <= p.bandW) : -1, slotW: 0, gap: 0 };
  let chipX = 0;
  if (choice.variant >= 0) {
    p.chipText = p.texts[choice.variant];
    p.chipW = p.widths[choice.variant];
    chipX = bandRight - p.chipW;
  }
  if (choice.slotW > 0) {
    const total = rd.doors * choice.slotW + (rd.doors - 1) * choice.gap;
    const left = choice.variant >= 0 ? p.bandX : p.bandX + (p.bandW - total) / 2;
    for (let i = 0; i < rd.doors; i++) drawSlot(ctx, pal, left + i * (choice.slotW + choice.gap), p.bandY, choice.slotW, p.bandH, rd.states[i], !outbound);
  } else {
    // too small for slots: the number of doors as a pill (the chip, when there is one, keeps the right end)
    ctx.font = fontOf(fr.theme, 700, clamp(p.bandH * 0.62, 9, 13));
    const label = `${rd.doors} ${rd.doors === 1 ? 'door' : 'doors'}`;
    const labelW = measure(ctx, label) + 10;
    const room = choice.variant >= 0 ? chipX - p.bandX - 4 : p.bandW;
    if (labelW <= room) {
      const lx = choice.variant >= 0 ? p.bandX : p.bandX + (p.bandW - labelW) / 2;
      fillPill(ctx, lx, p.bandY, labelW, p.bandH, pal.track);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = pal.ink;
      ctx.fillText(label, lx + labelW / 2, p.bandY + p.bandH / 2 + 0.5);
    }
  }
  if (choice.variant >= 0) drawChip(ctx, fr, p, rd, chipX, p.bandY);
  if (outbound) drawStaged(ctx, pal, p, rd, p.bandX, p.bandY - p.stagedH - 3);
  paintDockShares(ctx, fr, st, p);
}
const NO_WIDTHS = Object.freeze([]);

// ---------------------------------------------------------------------------------------------------------
// Dock share bars
// ---------------------------------------------------------------------------------------------------------

const reports = new WeakMap();

/** The report of the simulation, at most REPORT_MS old (and the same one while the simulation stands still); null when there is none. */
function reportOf(fr) {
  const sim = fr.sim;
  if (!sim || typeof sim.kpis !== 'function') return null;
  let c = reports.get(sim);
  if (!c) {
    c = { at: -Infinity, time: NaN, report: null };
    reports.set(sim, c);
  }
  if (c.report && (c.time === sim.time || fr.now - c.at < REPORT_MS)) return c.report;
  try {
    c.report = sim.kpis();
  } catch {
    c.report = null;
  }
  c.at = fr.now;
  c.time = sim.time;
  return c.report;
}

function paintDockShares(ctx, fr, st, p) {
  const cell = fr.cs * fr.zoom;
  if (cell < SHARE_MIN_CELL_PX || fr.simDx !== 0 || fr.simDy !== 0) return;
  const picked = (fr.selKind === 'station' && fr.selIds.includes(st.id)) || (fr.hoverKind === 'station' && fr.hoverId === st.id);
  if (!fr.overlays.docks && !picked) return;
  const report = reportOf(fr);
  const entry = report && report.stations ? report.stations[st.id] : null;
  const docks = entry && Array.isArray(entry.docks) ? entry.docks : null;
  if (!docks || docks.length === 0) return;
  const shares = shareFractions(docks.map((d) => (d ? d.visits : 0)));
  if (!shares.some((s) => s > 0)) return;
  const depth = clamp(cell * 0.14, 2.5, 7);
  const thick = clamp(cell * 0.09, 2.5, 5);
  const long = cell * 0.9;
  ctx.lineWidth = 1;
  for (let i = 0; i < docks.length; i++) {
    const d = docks[i];
    if (!d || !finite(d.cx) || !finite(d.cy)) continue;
    const x = fr.ox + d.cx * cell;
    const y = fr.oy + d.cy * cell;
    const above = d.cy < st.y;
    const below = d.cy >= st.y + st.h;
    const left = !above && !below && d.cx < st.x;
    const horizontal = above || below; // the strip runs along the edge: x for a dock above or below the brick, y for one at its side
    let bx;
    let by;
    let bw;
    let bh;
    if (horizontal) {
      bw = long;
      bh = thick;
      bx = x + (cell - long) / 2;
      by = above ? y + cell - depth - 1.5 - thick : y + depth + 1.5;
    } else {
      bw = thick;
      bh = long;
      by = y + (cell - long) / 2;
      bx = left ? x + cell - depth - 1.5 - thick : x + depth + 1.5;
    }
    ctx.beginPath(); // the track: how long a bar can get
    roundRectPath(ctx, bx, by, bw, bh, thick / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    if (shares[i] > 0) {
      ctx.beginPath();
      roundRectPath(ctx, bx, by, horizontal ? Math.max(thick, bw * shares[i]) : bw, horizontal ? bh : Math.max(thick, bh * shares[i]), thick / 2);
      ctx.fillStyle = STATUS_COLORS.busy;
      ctx.fill();
    }
  }
}
