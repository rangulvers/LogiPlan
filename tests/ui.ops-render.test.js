// Trucks and dock doors on the plan (js/ui/render/ops.js, hooked into js/ui/render/bricks.js; docs/WAREHOUSE-DESIGN.md 7.2 "Canvas", 7.7).
// The pure parts (readings, tones, texts, the layout of the band) are tested directly; the drawing runs against a recording stand-in for the canvas
// context. The rules proved here: a brick without trucks is planned exactly as before (no band, no extra block), a brick with trucks keeps its header row
// and live overlays clear of the band at every size and zoom, nothing throws for an absent or odd runtime, and one frame costs a few microseconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planContent } from '../js/ui/render/bricks.js';
import {
  DOOR, GATE_AMBER_SECONDS, GATE_RED_SECONDS, SLOT_MIN_CELL_PX, chooseBand, createReading, describeDoors, doorStateOf, gateTexts, gateTone, paintOps, planOps, readDoors, shareFractions,
} from '../js/ui/render/ops.js';
import { getTheme } from '../js/ui/theme.js';
import { defaultTrucks } from '../js/model/ops.js';

/** A canvas context that does nothing and records the calls (`calls`), the texts and the number of fills. */
function fakeContext() {
  const calls = [];
  const target = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, texts: [], calls, fills: 0, strokes: 0 };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === 'measureText') return (text) => ({ width: String(text).length * 6.5 });
      return (...args) => {
        calls.push([key, ...args]);
        if (key === 'fillText') t.texts.push(String(args[0]));
        if (key === 'fill') t.fills++;
        if (key === 'stroke') t.strokes++;
      };
    },
    set(t, key, value) { t[key] = value; return true; },
  });
}

/** Brick geometry of a station of `cols` x `rows` cells at `zoom` px per metre (cell size 2 m): the same numbers bricks.js brickGeometry makes. */
function geometry(cols, rows, zoom) {
  const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const cell = 2 * zoom;
  const gap = clampTo(cell * 0.05, 0.5, 4);
  const bodyH = rows * cell - 2 * gap;
  const depth = Math.min(clampTo(cell * 0.1, 2, 8), bodyH * 0.25);
  return { x: 100, y: 100, w: cols * cell - 2 * gap, bodyH, depth, h: bodyH - depth, cell, cols, rows, originX: 100 - gap, originY: 100 - gap, r: 4 };
}

const frame = (zoom, extra = {}) => ({
  theme: getTheme('light'), overlays: {}, cs: 2, zoom, ox: 0, oy: 0, now: 1000, simDx: 0, simDy: 0, selKind: null, selIds: [], hoverKind: null, hoverId: null, sim: null, ...extra,
});
const station = (type, trucks, id = 's1') => ({ id, name: type === 'sink' ? 'Dispatch' : 'Goods receiving', type, x: 5, y: 5, w: 3, h: 2, params: {}, ...(trucks ? { ops: { trucks } } : {}) });
const palette = getTheme('light').station.source;

test('a brick without trucks is planned as before: no band, no extra block', () => {
  const g = geometry(3, 2, 20);
  const plain = planContent(fakeContext(), frame(20), g, 'source', { id: 's', name: 'Goods in' }, null);
  assert.equal(plain.ops, undefined);
  assert.equal(planOps(fakeContext(), frame(20), g, 'source', null, null), null, 'a placement ghost has no station');
  assert.equal(planOps(fakeContext(), frame(20), g, 'source', station('source', null), null), null);
  assert.equal(planOps(fakeContext(), frame(20), g, 'process', { ...station('process', null), ops: { trucks: defaultTrucks() } }, null), null, 'only Goods in and Goods out have doors');
  const reserved = planContent(fakeContext(), frame(20), g, 'source', station('source', defaultTrucks()), null);
  assert.ok(reserved.ops, 'with trucks there is a band');
  assert.equal(reserved.blocks.length, plain.blocks.length + 1, 'and exactly one more block for the studs to stay away from');
});

test('the band, the header row and the live overlays never overlap and stay inside the face, for every size and zoom', () => {
  const overlap = (p, q) => p.x < q.x + q.w - 0.01 && q.x < p.x + p.w - 0.01 && p.y < q.y + q.h - 0.01 && q.y < p.y + p.h - 0.01;
  let planned = 0;
  for (const type of ['source', 'sink']) {
    for (const [cols, rows] of [[3, 2], [4, 3], [6, 4], [2, 1]]) {
      for (const zoom of [6, 8, 10, 12, 16, 20, 30, 45, 60]) {
        for (const staging of [0, 4]) {
          const g = geometry(cols, rows, zoom);
          const trucks = { ...defaultTrucks(), doors: 4, staging };
          const rt = { state: 'blocked', yard: 12, fill: 0.5, fillLabel: '3/8', consumed: 4, trucks: { gate: [], docked: [], staged: [] } };
          const plan = planContent(fakeContext(), frame(zoom), g, type, station(type, trucks), rt);
          if (!plan || !plan.ops) continue;
          planned++;
          const ops = plan.ops;
          assert.ok(ops.bandY >= g.y && ops.bandY + ops.bandH <= g.y + g.h + 0.01, `${type} ${cols}x${rows} @${zoom}: the band is inside the face`);
          assert.ok(ops.bandX >= g.x && ops.bandX + ops.bandW <= g.x + g.w + 0.01, `${type} ${cols}x${rows} @${zoom}: the band is inside the face (width)`);
          const others = [];
          if (plan.badge) others.push(['badge', { x: plan.badge.x, y: plan.badge.y, w: plan.badge.w, h: plan.badge.h }]);
          if (plan.tile.h > 0) others.push(['tile', { x: plan.tileX, y: plan.tileY, w: plan.tile.w, h: plan.tile.h }]);
          if (plan.dot) others.push(['dot', { x: plan.dot.x - plan.dot.d / 2, y: plan.dot.y - plan.dot.d / 2, w: plan.dot.d, h: plan.dot.d }]);
          if (plan.live) others.push(['live', { x: g.x + plan.pad, y: plan.liveY, w: plan.innerW, h: plan.live.h }]);
          const band = { x: ops.bandX, y: ops.bandY - (ops.stagedH > 0 ? ops.stagedH + 3 : 0), w: ops.bandW, h: ops.bandH + (ops.stagedH > 0 ? ops.stagedH + 3 : 0) };
          for (const [name, box] of others) assert.ok(!overlap(box, band), `${type} ${cols}x${rows} @${zoom} staging ${staging}: the ${name} does not touch the doors`);
        }
      }
    }
  }
  assert.ok(planned > 40, `the grid planned ${planned} bricks with a band`);
});

test('readDoors: no runtime, no trucks yet, and a running desk', () => {
  const trucks = { ...defaultTrucks(), doors: 3, staging: 4 };
  const rd = createReading();
  readDoors(null, trucks, 0, false, rd);
  assert.deepEqual([rd.doors, rd.busy, rd.gate, rd.wait, rd.staged], [3, 0, 0, 0, 0]);
  assert.deepEqual([...rd.states.slice(0, 3)], [DOOR.FREE, DOOR.FREE, DOOR.FREE]);
  readDoors({ state: 'normal', trucks: null }, trucks, 0, false, rd);
  assert.equal(rd.busy, 0, 'a simulation without truck desks (not produced yet) shows free doors');
  const rt = {
    state: 'normal',
    trucks: {
      gate: [{ id: 7, at: 100 }, { id: 8, at: 400 }],
      docked: [{ id: 1, state: 'checkin', door: 1 }, { id: 2, state: 'work', door: 0 }, { id: 3, state: 'checkout', door: 2 }],
      staged: [],
    },
  };
  readDoors(rt, trucks, 1000, false, rd);
  assert.deepEqual([...rd.states.slice(0, 3)], [DOOR.WORK, DOOR.CHECKIN, DOOR.CHECKOUT], 'a truck sits in the door the desk gave it');
  assert.equal(rd.trucks[1].id, 1);
  assert.deepEqual([rd.busy, rd.gate, rd.wait], [3, 2, 900], 'the longest wait is that of the oldest truck at the gate');
  rt.trucks.docked = [{ id: 5, state: 'work' }, { id: 6, state: 'work', door: 0 }, { id: 9, state: 'work', door: 0 }]; // no door named: the lowest free one; a clash: the lowest free one
  readDoors(rt, trucks, 1000, false, rd);
  assert.deepEqual([...rd.states.slice(0, 3)], [DOOR.WORK, DOOR.WORK, DOOR.WORK]);
  assert.equal(rd.busy, 3);
  rt.trucks.docked = [{ id: 1, state: 'work', door: 99 }, null, 'x', {}];
  assert.doesNotThrow(() => readDoors(rt, trucks, NaN, false, rd));
  assert.ok(Number.isFinite(rd.wait));
  const out = { state: 'normal', trucks: { gate: [], docked: [], staged: new Array(5).fill({}) } };
  readDoors(out, trucks, 0, true, rd);
  assert.deepEqual([rd.staged, rd.stagedCap], [5, 12], 'staging space is doors x staging pallets');
  readDoors(out, { ...trucks, doors: 32, staging: 50 }, 0, true, rd);
  assert.ok(rd.stagedCap <= 24, 'at most 24 pallet squares are drawn');
});

test('doorStateOf: a pause mark means the door is held and nothing moves', () => {
  const inbound = (state) => ({ state });
  assert.equal(doorStateOf(inbound('checkin'), { state: 'normal' }, false), DOOR.CHECKIN);
  assert.equal(doorStateOf(inbound('checkout'), { state: 'normal' }, false), DOOR.CHECKOUT);
  assert.equal(doorStateOf(inbound('work'), { state: 'normal' }, false), DOOR.WORK, 'unloading');
  assert.equal(doorStateOf(inbound('work'), { state: 'blocked' }, false), DOOR.WAIT, 'the Goods in is blocked: the pallets wait for staging space');
  const wait = { state: 'normal', inboundTotal: 0, trucks: { staged: [] } };
  assert.equal(doorStateOf({ state: 'work', loaded: 0, plan: 24 }, wait, true), DOOR.WAIT, 'a Goods out truck with nothing staged and nothing on its way waits for pallets');
  assert.equal(doorStateOf({ state: 'work', loaded: 0, plan: 24 }, { ...wait, inboundTotal: 3 }, true), DOOR.WORK, 'pallets are on their way: loading');
  assert.equal(doorStateOf({ state: 'work', loaded: 0, plan: 24 }, { ...wait, trucks: { staged: [{}] } }, true), DOOR.WORK);
  assert.equal(doorStateOf(null, null, false), DOOR.WORK, 'junk does not throw');
});

test('the gate chip: amber from 15 minutes, red from 45, and the texts shrink to fit', () => {
  assert.equal(GATE_AMBER_SECONDS, 900);
  assert.equal(GATE_RED_SECONDS, 2700);
  assert.deepEqual([0, 899, 900, 2699, 2700, 99999].map(gateTone), ['neutral', 'neutral', 'amber', 'amber', 'red', 'red']);
  assert.deepEqual(gateTexts(5, 38 * 60), ['Gate 5 trucks, 38 min', 'Gate 5, 38 min', '5, 38 min', '5']);
  assert.equal(gateTexts(1, 45)[0], 'Gate 1 truck, 45 s');
});

test('dock share bars: the visits of each dock against the busiest one', () => {
  assert.deepEqual(shareFractions([465, 0, 0, 0, 0, 0]), [1, 0, 0, 0, 0, 0], 'one long bar and empty ones: the symptom');
  assert.deepEqual(shareFractions([100, 100, 100]), [1, 1, 1], 'three even bars: the dock choice works');
  assert.deepEqual(shareFractions([310, 155]), [1, 0.5]);
  assert.deepEqual(shareFractions([0, 0]), [0, 0]);
  assert.deepEqual(shareFractions([NaN, 4, undefined]), [0, 1, 0]);
});

test('chooseBand: slots first, the longest chip text that leaves them room, else the doors are counted', () => {
  const widths = [150, 90, 50, 14];
  const roomy = chooseBand(400, 3, 20, widths);
  assert.equal(roomy.variant, 0);
  assert.ok(roomy.slotW >= 24);
  const tight = chooseBand(150, 4, 20, widths);
  assert.ok(tight.variant > 0, 'a shorter text');
  assert.ok(tight.slotW >= 6);
  const none = chooseBand(60, 8, 20, widths);
  assert.equal(none.slotW, 0, 'too narrow for 8 slots: counted');
  assert.equal(chooseBand(300, 6, 20, []).variant, -1, 'no chip without a queue');
  assert.ok(chooseBand(300, 6, 20, []).slotW > 0);
});

test('paintOps draws the doors, the gate chip and the count of doors, and never throws', () => {
  const trucks = { ...defaultTrucks(), doors: 4, staging: 4 };
  const rt = { state: 'normal', trucks: { gate: [{ id: 7, at: 100 }], docked: [{ id: 1, state: 'work', door: 0 }], staged: [] } };
  for (const [zoom, wantText] of [[20, /^Gate 1[ ,]/], [6, /door/]]) {
    const g = geometry(6, 4, zoom);
    const fr = frame(zoom, { sim: { time: 1000 } });
    const ctx = fakeContext();
    const runtime = zoom >= SLOT_MIN_CELL_PX / 2 ? rt : { ...rt, trucks: { ...rt.trucks, gate: [] } }; // a queue squeezes the count of doors out of a small brick: it keeps the chip
    const plan = planContent(ctx, fr, g, 'source', station('source', trucks), runtime);
    paintOps(ctx, fr, g, palette, station('source', trucks), runtime, plan.ops);
    assert.ok(ctx.texts.some((t) => wantText.test(t)), `texts at zoom ${zoom}: ${ctx.texts.join(' | ')}`);
  }
  // 12 px cells (zoomed far out, a tall brick): no slots, the count of doors (the chip is there too when it fits)
  const g = geometry(4, 4, 6);
  const plan = planOps(fakeContext(), frame(6), g, 'source', station('source', trucks), null);
  assert.equal(plan.mode, 'count');
  // odd runtimes
  const odd = [null, {}, { trucks: {} }, { trucks: { gate: 'x', docked: 7, staged: NaN } }, { trucks: { gate: [null, {}], docked: [null, { state: 5 }], staged: [] } }, { state: 'blocked', trucks: { gate: [{ at: NaN }], docked: [], staged: -3 } }];
  for (const runtime of odd) {
    for (const type of ['source', 'sink']) {
      const gg = geometry(3, 2, 30);
      const fr = frame(30, { sim: { time: 50 } });
      const c = fakeContext();
      const p = planContent(c, fr, gg, type, station(type, trucks), runtime);
      assert.doesNotThrow(() => paintOps(c, fr, gg, palette, station(type, trucks), runtime, p.ops), JSON.stringify(runtime));
    }
  }
});

test('the dock share bars appear with the Docks overlay, from the existing report.stations[id].docks, and not without trucks data', () => {
  const trucks = { ...defaultTrucks(), doors: 3 };
  const st = station('source', trucks);
  const docks = [{ cx: 5, cy: 7, visits: 465 }, { cx: 6, cy: 7, visits: 0 }, { cx: 7, cy: 7, visits: 0 }];
  const sim = { time: 100, kpis: () => ({ stations: { s1: { docks } } }) };
  const fills = (overlays, simulation) => {
    const g = geometry(3, 2, 20);
    const fr = frame(20, { overlays, sim: simulation });
    const ctx = fakeContext();
    const plan = planContent(ctx, fr, g, 'source', st, null);
    const before = ctx.fills;
    paintOps(ctx, fr, g, palette, st, null, plan.ops);
    return ctx.fills - before;
  };
  const off = fills({}, sim);
  const on = fills({ docks: true }, { ...sim, kpis: () => ({ stations: { s1: { docks } } }) });
  assert.ok(on > off, `the bars add fills (${off} -> ${on})`);
  assert.equal(fills({ docks: true }, { time: 1, kpis: () => ({ stations: { s1: { docks: docks.map((d) => ({ ...d, visits: 0 })) } } }) }), off, 'no visits yet: no bars');
  assert.equal(fills({ docks: true }, { time: 1, kpis: () => { throw new Error('rebuilding'); } }), off, 'a simulation that cannot report does not break the frame');
  assert.equal(fills({ docks: true }, null), off, 'edit mode: nothing');
});

test('one brick with doors costs a few microseconds a frame (planned and painted)', () => {
  const trucks = { ...defaultTrucks(), doors: 6, staging: 4 };
  const st = station('sink', trucks);
  const g = geometry(6, 3, 30);
  const fr = frame(30, { sim: { time: 5000 } });
  const ctx = fakeContext();
  const rt = { state: 'normal', inboundTotal: 2, trucks: { gate: [{ id: 1, at: 100 }], docked: [{ id: 2, state: 'work', door: 1, loaded: 3, plan: 24 }, { id: 3, state: 'checkin', door: 0 }], staged: [{}, {}, {}] } };
  const frames = 5000;
  for (let i = 0; i < 200; i++) paintOps(ctx, fr, g, palette, st, rt, planOps(ctx, fr, g, 'sink', st, rt));
  const t0 = process.cpuUsage();
  for (let i = 0; i < frames; i++) paintOps(ctx, fr, g, palette, st, rt, planOps(ctx, fr, g, 'sink', st, rt));
  const used = process.cpuUsage(t0);
  const perFrameUs = (used.user + used.system) / frames;
  assert.ok(perFrameUs < 400, `${perFrameUs.toFixed(1)} us of CPU per brick and frame against a fake context`);
});

test('describeDoors: the words of the picture, for the inspector and for a screen reader', () => {
  const trucks = { ...defaultTrucks(), doors: 4, staging: 2 };
  const rd = createReading();
  readDoors(null, trucks, 0, false, rd);
  assert.equal(describeDoors(rd, false), '4 free. No truck at the gate.');
  const rt = {
    state: 'normal',
    trucks: { gate: [{ id: 7, at: 100 }, { id: 8, at: 400 }], docked: [{ id: 1, state: 'checkin', door: 1 }, { id: 2, state: 'work', door: 0 }, { id: 3, state: 'checkout', door: 2 }], staged: [] },
  };
  readDoors(rt, trucks, 1000, false, rd);
  assert.equal(describeDoors(rd, false), '1 working, 1 checking in, 1 checking out, 1 free. 2 trucks at the gate, the longest has waited 15 min.');
  readDoors({ ...rt, state: 'blocked' }, trucks, 1000, false, rd);
  assert.match(describeDoors(rd, false), /^1 held, waiting for vehicles, 1 checking in/);
  const out = { state: 'normal', inboundTotal: 0, trucks: { gate: [{ id: 9, at: 990 }], docked: [{ id: 5, state: 'work', door: 0, loaded: 0, plan: 24 }], staged: [{}, {}, {}] } };
  readDoors(out, trucks, 1000, true, rd);
  assert.equal(describeDoors(rd, true), '1 working, 3 free. 1 truck at the gate, the longest has waited 10 s. 3 pallets staged.');
  readDoors({ ...out, trucks: { ...out.trucks, staged: [] } }, trucks, 1000, true, rd);
  assert.match(describeDoors(rd, true), /^1 waiting for pallets, 3 free\./);
});
