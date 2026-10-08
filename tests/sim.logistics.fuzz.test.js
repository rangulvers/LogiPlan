// Logistics: randomised plants x random flows with every invariant checked on every tick, determinism of the event
// log, odd/degenerate layouts that must never throw, and a performance budget. Uses the stub traffic (no collisions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createWorld, eventDigest } from './helpers/logistics-invariants.js';
import { createRng } from '../js/util/rng.js';
import { dist, emptyLayout, defaultStation, defaultFlow, defaultFleet } from '../js/model/defaults.js';

const FROM_TYPES = ['source', 'process', 'storage'];
const TO_TYPES = ['process', 'storage', 'sink'];

/** A random but valid plant: a few (partly one-way) roads, stations next to them, random flows and fleets. */
function randomPlant(seed) {
  const rng = createRng(seed);
  const cols = 28;
  const rows = 18;
  const grid = Array.from({ length: rows }, () => Array(cols).fill('.'));
  const some = (items, n) => {
    const left = [...items];
    const out = [];
    while (out.length < n && left.length) out.push(left.splice(rng.int(left.length), 1)[0]);
    return out.sort((a, b) => a - b);
  };
  const hRows = some([2, 6, 10, 14], 2 + rng.int(2));
  for (const r of hRows) {
    const ch = rng.next() < 0.25 ? (rng.next() < 0.5 ? '>' : '<') : '+';
    for (let x = 1; x < cols - 1; x++) grid[r][x] = ch;
  }
  for (const c of some([1, 8, 14, 20, cols - 2], 2 + rng.int(2))) {
    const ch = rng.next() < 0.25 ? (rng.next() < 0.5 ? 'v' : '^') : '+';
    for (let y = hRows[0]; y <= hRows[hRows.length - 1]; y++) grid[y][c] = grid[y][c] === '.' ? ch : '+';
  }
  const isRoad = (x, y) => '+<>^v'.includes(grid[y]?.[x] ?? '.');
  const letters = 'ABCDEFGHIJKLMNOP';
  const stations = {};
  const kinds = ['source', 'sink', 'process', 'process', 'process', 'storage', 'storage', 'depot', 'source', 'sink'];
  for (let tries = 0, n = 0; tries < 60 && n < 10; tries++) {
    const w = 2 + rng.int(2);
    const h = 2;
    const x = rng.int(cols - w);
    const y = rng.int(rows - h);
    let free = true;
    let touchesRoad = false;
    for (let j = -1; j <= h; j++) for (let i = -1; i <= w; i++) {
      const inside = i >= 0 && i < w && j >= 0 && j < h;
      if (inside && grid[y + j][x + i] !== '.') free = false;
      if (!inside && (i === -1 || i === w) !== (j === -1 || j === h) && isRoad(x + i, y + j)) touchesRoad = true;
    }
    if (!free || !touchesRoad) continue;
    const letter = letters[n];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) grid[y + j][x + i] = letter;
    const type = kinds[n];
    const params = {};
    if (type === 'source') {
      Object.assign(params, {
        interArrival: dist(rng.pick(['exp', 'normal', 'uniform']), 15 + rng.int(40), 0.3), batch: 1 + rng.int(2), outCap: 2 + rng.int(5), startDelay: rng.int(20),
      });
    }
    if (type === 'process') {
      Object.assign(params, {
        cycle: dist(rng.pick(['exp', 'normal', 'const']), 8 + rng.int(30), 0.2), machines: 1 + rng.int(3), outPerCycle: 1 + (rng.next() < 0.2 ? 1 : 0),
        inCap: 2 + rng.int(5), outCap: 2 + rng.int(4), mtbf: rng.next() < 0.3 ? 300 : 0, mttr: rng.next() < 0.3 ? 30 : 0,
      });
    }
    if (type === 'storage') Object.assign(params, { capacity: 4 + rng.int(25), dwell: rng.next() < 0.4 ? rng.int(30) : 0 });
    if (type === 'depot') Object.assign(params, { slots: 2 + rng.int(4), chargers: rng.int(3) });
    stations[letter] = { type, params };
    n++;
  }
  const ids = Object.keys(stations);
  const flows = [];
  for (const from of ids.filter((id) => FROM_TYPES.includes(stations[id].type))) {
    const targets = ids.filter((id) => id !== from && TO_TYPES.includes(stations[id].type));
    for (const to of some(targets.map((_, i) => i), 1 + rng.int(2)).map((i) => targets[i])) {
      flows.push([from, to, {
        weight: 1 + rng.int(3), perCycle: 1 + (rng.next() < 0.25 ? 1 : 0), batchMin: 1 + (rng.next() < 0.3 ? rng.int(3) : 0),
        batchMax: rng.next() < 0.2 ? 2 : 0, maxWait: rng.next() < 0.4 ? 40 : 0, priority: 1 + rng.int(3),
      }]);
    }
  }
  const depot = ids.find((id) => stations[id].type === 'depot');
  const fleets = [];
  for (let i = 0, n = 1 + rng.int(3); i < n; i++) {
    const battery = rng.next() < 0.35 ? { enabled: true, runtimeMin: 6 + rng.int(10), chargeTimeMin: 1 + rng.int(3), lowPct: 30, resumePct: 80 } : {};
    fleets.push({
      preset: rng.pick(['agv', 'forklift', 'tugger']), count: 1 + rng.int(4), battery, home: depot || null,
      idle: rng.next() < 0.5 ? 'park' : 'stay', mtbf: rng.next() < 0.4 ? 300 : 0, mttr: rng.next() < 0.4 ? 40 : 0,
    });
  }
  const layout = layoutFromAscii(grid.map((row) => row.join('')), {
    stations, flows, fleets,
    settings: {
      seed, dispatch: rng.pick(['nearest', 'oldest', 'balanced']), routing: rng.pick(['shortest', 'congestion']),
      demandFactor: 0.5 + rng.next() * 1.5, processFactor: 0.7 + rng.next() * 0.8,
    },
  });
  return layout;
}

test('fuzz: 20 simulated minutes on random plants keep every invariant on every tick', () => {
  let delivered = 0;
  let completed = 0;
  let parked = 0;
  for (let seed = 1; seed <= 14; seed++) {
    const layout = randomPlant(seed);
    const w = createWorld(layout, { dt: 0.25, check: true });
    w.run(1200);
    delivered += w.lg.ordersDelivered;
    completed += w.lg.completed;
    parked += w.lg.vehicles.filter((v) => v.timeIn.parked > 0 || v.timeIn.charging > 0).length;
    assert.ok(Number.isFinite(w.lg.liveLoads));
  }
  assert.ok(delivered > 100, `the fuzz plants should move real work (delivered ${delivered})`);
  assert.ok(completed > 20, `and finish some of it (completed ${completed})`);
  assert.ok(parked > 0, 'at least one plant exercises depots');
});

test('fuzz: live what-if changes and deadlock relocations keep every invariant on every tick', () => {
  let relocations = 0;
  let replanned = 0;
  for (let seed = 30; seed <= 41; seed++) {
    const w = createWorld(randomPlant(seed), { dt: 0.25, check: true });
    const chaos = createRng(seed * 7919);
    for (let round = 0; round < 8; round++) {
      w.run(100);
      w.lg.setRuntime({
        demandFactor: chaos.range(0, 2.5), processFactor: chaos.range(0.5, 2), speedFactor: chaos.range(0.5, 2),
        dispatch: chaos.pick(['nearest', 'oldest', 'balanced']), routing: chaos.pick(['shortest', 'congestion']),
      });
      const driving = w.lg.vehicles.filter((v) => v.tv.driving && !v.tv.disabled && v.tv.onRoad);
      if (driving.length === 0) continue;
      const victim = chaos.pick(driving);
      const spot = w.traffic.findFreeNode(w.graph.nodes[chaos.int(w.graph.nodes.length)]);
      if (spot < 0 || !w.traffic.relocate(victim.tv, spot)) continue;
      relocations++;
      if (chaos.next() < 0.7) w.lg.handleDeadlock({ victim: victim.tv, resolved: true, vehicles: [victim.tv], nodes: [spot] });
      w.step();
      if (victim.tv.driving) replanned++;
    }
  }
  assert.ok(relocations >= 30, `${relocations} relocations`);
  assert.ok(replanned >= relocations / 3, `${replanned} of them were re-planned at once`);
});

// ---- determinism --------------------------------------------------------------------------------------------------------------

test('determinism: the same layout and seed replay to an identical event log; another seed does not', () => {
  const run = (seed) => {
    const w = createWorld(randomPlant(5), { dt: 0.25, seed });
    w.run(1200);
    return { digest: eventDigest(w.events), n: w.events.length, completed: w.lg.completed, live: w.lg.liveLoads };
  };
  const a = run(11);
  const b = run(11);
  assert.deepEqual(a, b);
  assert.ok(a.n > 200, `${a.n} events make the comparison meaningful`);
  assert.notEqual(run(12).digest, a.digest);
});

test('determinism: structural edits do not reshuffle unrelated randomness (one stream per station and vehicle)', () => {
  const arrivals = (layout) => {
    const w = createWorld(layout, { dt: 0.5, seed: 4 });
    w.run(1500);
    return w.named('loadCreated').filter((p) => p.stationId === 'A').map((p) => p.load.createdAt);
  };
  const base = () => layoutFromAscii(['A.......D', '+'.repeat(9)], {
    stations: { A: { type: 'source', params: { interArrival: dist('exp', 25), startDelay: 0 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 0 }],
  });
  const reference = arrivals(base());
  assert.ok(reference.length > 40);

  const withVehicles = base();
  withVehicles.fleets[0].count = 3;
  withVehicles.fleets[0].mtbf = 100;
  withVehicles.fleets[0].mttr = 10;
  assert.deepEqual(arrivals(withVehicles), reference, 'adding (failing) vehicles leaves the source stream alone');

  const withStation = layoutFromAscii(['A.......D.Z', '+'.repeat(11)], {
    stations: { A: { type: 'source', params: { interArrival: dist('exp', 25), startDelay: 0 } }, D: 'sink', Z: { type: 'process', params: { cycle: dist('exp', 5), mtbf: 30, mttr: 5 } } },
    flows: [['A', 'D']], fleets: [{ count: 0 }],
  });
  assert.deepEqual(arrivals(withStation), reference, 'adding an unrelated station leaves it alone too');
});

// ---- degenerate input --------------------------------------------------------------------------------------------------------------

test('degenerate layouts never throw: empty, no roads, no flows, no fleets, missing keys', () => {
  const cases = {
    'completely empty': emptyLayout(),
    'stations without roads': layoutFromAscii(['A.B'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 2 }] }),
    'roads only': layoutFromAscii(['+++++'], { fleets: [{ count: 2 }] }),
    'flows but no fleet': layoutFromAscii(['A..B', '++++'], { stations: { A: { type: 'source', params: { interArrival: dist('const', 3) } }, B: 'sink' }, flows: [['A', 'B']], fleets: [] }),
    'fleet but no flows': layoutFromAscii(['A..B', '++++'], { stations: { A: 'source', B: 'sink' }, fleets: [{ count: 2 }] }),
    'depot only': layoutFromAscii(['P..', '+++'], {
      stations: { P: { type: 'depot', params: { slots: 3, chargers: 3 } } },
      fleets: [{ count: 2, home: 'P' }, { count: 1, home: 'nowhere', battery: { enabled: true } }],
    }),
    'vehicles with junk specs': layoutFromAscii(['A..B', '++++'], {
      stations: { A: { type: 'source', params: { interArrival: dist('const', 3) } }, B: 'sink' }, flows: [['A', 'B']],
      fleets: [{
        count: 2, capacity: 0, loadTime: -3, unloadTime: NaN, mtbf: NaN, mttr: 5, idle: 'sideways', home: 42,
        battery: { enabled: true, runtimeMin: 0, chargeTimeMin: -1, lowPct: 500, resumePct: -4 },
      }],
    }),
  };
  const missing = layoutFromAscii(['A..B', '++++'], { stations: { A: { type: 'source', params: { interArrival: dist('const', 3) } }, B: 'sink' }, flows: [['A', 'B']] });
  delete missing.settings;
  delete missing.fleets;
  cases['missing settings and fleets'] = missing;
  for (const [name, layout] of Object.entries(cases)) {
    const w = createWorld(layout, { dt: 0.5, check: true, seed: 1 });
    w.run(200);
    w.lg.setRuntime({ demandFactor: 3, speedFactor: 2, dispatch: 'balanced', routing: 'congestion' });
    w.run(200);
    assert.ok(Number.isFinite(w.lg.liveLoads) && w.lg.liveLoads >= 0, name);
    for (const v of w.lg.vehicles) assert.ok(Number.isFinite(v.battery) && Number.isFinite(v.x), `${name}: ${v.id}`);
  }
});

test('degenerate layouts: tiny cycles, huge counts and zero-length intervals stay bounded', () => {
  const layout = layoutFromAscii(['A.B.C'], {
    stations: {
      A: { type: 'source', params: { interArrival: dist('const', 0.0001), startDelay: 0, outCap: 3 } },
      B: { type: 'process', params: { cycle: dist('const', 0), machines: 400, inCap: 5, outCap: 5 } }, C: 'sink',
    },
    flows: [['A', 'B'], ['B', 'C']], fleets: [],
  });
  const w = createWorld(layout, { dt: 0.5 });
  w.run(5);
  assert.equal(w.lg.stationById.get('B').machines.length, 256, 'machine count is capped');
  assert.ok(w.lg.liveLoads < 5000);
});

// ---- performance ------------------------------------------------------------------------------------------------------------------------

/** 50 stations in five production chains on a ladder of two-way roads, 40 vehicles in three fleets. */
function bigPlant() {
  const cols = 62;
  const rows = 40;
  const grid = Array.from({ length: rows }, () => Array(cols).fill('.'));
  const roadRows = [2, 8, 14, 20, 26, 32];
  for (const r of roadRows) for (let x = 1; x < cols - 1; x++) grid[r][x] = '+';
  for (let y = 2; y <= 32; y++) { grid[y][1] = '+'; grid[y][cols - 2] = '+'; }
  const layout = layoutFromAscii(grid.map((row) => row.join('')), { fleets: [] });
  const slots = [];
  for (let gap = 0; gap < 5; gap++) for (const dy of [1, 4]) for (let x = 3; x + 3 <= cols - 3; x += 4) slots.push([x, roadRows[gap] + dy]);
  const chain = ['source', 'process', 'process', 'storage', 'process', 'process', 'process', 'storage', 'process', 'sink'];
  const params = {
    source: { interArrival: dist('exp', 45), outCap: 4 },
    process: { cycle: dist('normal', 40, 0.2), machines: 2, inCap: 4, outCap: 4, mtbf: 900, mttr: 60 },
    storage: { capacity: 30, dwell: 5 },
    sink: {},
  };
  for (let i = 0; i < 50; i++) {
    const [x, y] = slots[i * 2];
    layout.stations.push(defaultStation(chain[i % 10], { id: `s${i}`, name: `S${i}`, x, y, w: 3, h: 2, params: params[chain[i % 10]] }));
    if (i % 10 > 0) layout.flows.push(defaultFlow({ id: `f${i}`, from: `s${i - 1}`, to: `s${i}` }));
  }
  layout.fleets.push(
    defaultFleet('agv', { id: 'v1', count: 20 }), defaultFleet('forklift', { id: 'v2', count: 12 }), defaultFleet('tugger', { id: 'v3', count: 8 }),
  );
  return layout;
}

test('performance: 50 stations and 40 vehicles simulate one hour in under 3 seconds', () => {
  const layout = bigPlant();
  const w = createWorld(layout, { dt: 0.1 });
  assert.equal(w.lg.stations.length, 50);
  assert.equal(w.lg.vehicles.length, 40);
  assert.equal(w.lg.flows.length, 45);
  const t0 = performance.now();
  w.run(3600);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `3600 simulated seconds took ${ms.toFixed(0)} ms`);
  assert.ok(w.lg.ordersDelivered > 500, `real work was done (${w.lg.ordersDelivered} orders)`);
  assert.ok(w.lg.completed > 30);
  assert.ok(w.lg.vehicles.some((v) => v.trips > 10));
});
