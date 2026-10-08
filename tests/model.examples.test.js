import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import * as L from '../js/model/layout.js';
import { FLEET_PRESETS } from '../js/model/defaults.js';
import { DX, DY, opposite, parseKey } from '../js/util/grid.js';

const built = EXAMPLES.map((example) => ({ example, layout: example.build() }));
const byId = (id) => built.find((b) => b.example.id === id).layout;
const stationNamed = (layout, name) => layout.stations.find((s) => s.name === name);

/** Road cells with their undirected neighbour count, and the number of undirected connections. */
function roadGraph(layout) {
  const cells = Object.keys(layout.roads).map(parseKey);
  const degree = new Map();
  let edges = 0;
  for (const [cx, cy] of cells) {
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const linked = L.hasLink(layout, cx, cy, d) || L.hasLink(layout, cx + DX[d], cy + DY[d], opposite(d));
      if (linked) n++;
    }
    degree.set(`${cx},${cy}`, n);
    edges += n;
  }
  return { cells, degree, edges: edges / 2 };
}

/** Number of connected pieces of the (undirected) road network. */
function pieces(layout) {
  const seen = new Set();
  let count = 0;
  for (const start of Object.keys(layout.roads)) {
    if (seen.has(start)) continue;
    count++;
    const queue = [start];
    seen.add(start);
    for (let i = 0; i < queue.length; i++) {
      const [cx, cy] = parseKey(queue[i]);
      for (let d = 0; d < 4; d++) {
        const key = `${cx + DX[d]},${cy + DY[d]}`;
        const linked = L.hasLink(layout, cx, cy, d) || L.hasLink(layout, cx + DX[d], cy + DY[d], opposite(d));
        if (linked && !seen.has(key)) { seen.add(key); queue.push(key); }
      }
    }
  }
  return count;
}

test('catalogue: three or more examples with names, descriptions and tips', () => {
  assert.ok(EXAMPLES.length >= 3);
  assert.deepEqual(EXAMPLES.slice(0, 3).map((e) => e.name), ['Starter: dock → assembly → shipping', 'Two production lines + warehouse', 'Congestion lab']);
  assert.equal(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length);
  for (const e of EXAMPLES) {
    assert.match(e.id, /^[a-z0-9-]+$/);
    assert.equal(typeof e.build, 'function');
    assert.ok(e.description.length > 60, `${e.id} description`);
    assert.ok(Array.isArray(e.tips) && e.tips.length >= 3, `${e.id} tips`);
    assert.ok(e.tips.every((t) => typeof t === 'string' && t.length > 30));
    assert.ok(e.tips.some((t) => t.startsWith('Try:')), `${e.id} suggests something to try`);
  }
});

test('build() returns a fresh, identical layout every time', () => {
  for (const { example, layout } of built) {
    const again = example.build();
    assert.deepEqual(again, layout, example.id);
    assert.notEqual(again, layout);
    again.stations[0].name = 'changed';
    again.roads['0,0'] = { out: 0 };
    assert.notEqual(example.build().stations[0].name, 'changed');
  }
});

test('every example is a valid, normalized, JSON-stable layout', () => {
  for (const { example, layout } of built) {
    assert.deepEqual(L.checkInvariants(layout), [], example.id);
    assert.deepEqual(JSON.parse(JSON.stringify(layout)), layout, `${example.id} survives a JSON roundtrip`);
    assert.deepEqual(L.normalizeLayout(layout), layout, `${example.id} is a fixed point of normalizeLayout`);
    assert.deepEqual(L.normalizeLayout(L.normalizeLayout(layout)), L.normalizeLayout(layout));
  }
});

test('every example passes validateLayout without errors, warnings or infos', () => {
  for (const { example, layout } of built) {
    const issues = validateLayout(layout);
    assert.deepEqual(issues.map((i) => `${i.severity}: ${i.id}`), [], example.id);
  }
});

test('every station of every example has a dock, every flow is routable both ways', () => {
  for (const { example, layout } of built) {
    for (const s of layout.stations) assert.ok(L.docksOf(layout, s.id).length >= 1, `${example.id}: ${s.name} has no dock`);
    const bad = validateLayout(layout).filter((i) => i.code.startsWith('flow-') || i.code.startsWith('station-'));
    assert.deepEqual(bad, [], example.id);
    assert.ok(layout.flows.length >= 2 && layout.fleets.length >= 1);
    assert.ok(layout.stations.some((s) => s.type === 'source') && layout.stations.some((s) => s.type === 'sink'));
  }
});

test('plant sizes: grids 40x24 to 56x36, 2 m cells, one connected road network with a loop', () => {
  for (const { example, layout } of built) {
    const { cols, rows, cellSize } = layout.grid;
    assert.ok(cols >= 40 && cols <= 56 && rows >= 24 && rows <= 36, `${example.id}: ${cols}x${rows}`);
    assert.equal(cellSize, 2);
    assert.equal(pieces(layout), 1, `${example.id}: one connected road network`);
    const { cells, edges } = roadGraph(layout);
    assert.ok(edges >= cells.length, `${example.id}: the roads contain a loop (connections >= cells)`);
    assert.ok(L.roadLengthMeters(layout) > 100);
  }
});

test('depots hold the whole fleet that lives there', () => {
  for (const { example, layout } of built) {
    for (const fleet of layout.fleets) {
      const home = L.getStation(layout, fleet.home);
      assert.ok(home && home.type === 'depot', `${example.id}: ${fleet.name} has a home depot`);
      const homed = layout.fleets.filter((f) => f.home === home.id).reduce((sum, f) => sum + f.count, 0);
      assert.ok(home.params.slots >= homed, `${example.id}: ${home.name} has ${home.params.slots} slots for ${homed} vehicles`);
    }
  }
});

test('starter, two lines and lab keep the busy docks on side spurs, except where the lab says otherwise', () => {
  for (const id of ['starter', 'two-lines']) {
    const layout = byId(id);
    const { degree } = roadGraph(layout);
    for (const s of layout.stations) {
      for (const [cx, cy] of L.docksOf(layout, s.id)) assert.equal(degree.get(`${cx},${cy}`), 1, `${id}: dock of ${s.name} is the end of a side road`);
    }
  }
  const lab = byId('congestion-lab');
  const { degree } = roadGraph(lab);
  const packingDocks = L.docksOf(lab, stationNamed(lab, 'Packing').id);
  assert.ok(packingDocks.length >= 2 && packingDocks.every(([cx, cy]) => degree.get(`${cx},${cy}`) === 2), 'Packing docks sit on the through aisle');
  for (const name of ['Inbound A', 'Inbound B', 'Dispatch', 'AGV parking']) {
    for (const [cx, cy] of L.docksOf(lab, stationNamed(lab, name).id)) assert.equal(degree.get(`${cx},${cy}`), 1, name);
  }
});

test('Starter: goods receiving -> assembly -> dispatch with two AGVs and a parking bay', () => {
  const l = byId('starter');
  assert.deepEqual(l.stations.map((s) => s.type).sort(), ['depot', 'process', 'sink', 'source']);
  assert.deepEqual(l.flows.map((f) => [L.getStation(l, f.from).type, L.getStation(l, f.to).type]), [['source', 'process'], ['process', 'sink']]);
  assert.equal(l.fleets.length, 1);
  assert.deepEqual([l.fleets[0].preset, l.fleets[0].count, l.fleets[0].speed], ['agv', 2, FLEET_PRESETS.agv.speed]);
  const source = l.stations.find((s) => s.type === 'source');
  const assembly = l.stations.find((s) => s.type === 'process');
  assert.ok(source.params.interArrival.mean >= 90, 'pallet arrivals every few minutes');
  assert.ok(assembly.params.cycle.mean >= 45 && assembly.params.cycle.mean <= 120);
  assert.ok(assembly.params.cycle.mean < source.params.interArrival.mean, 'the assembly can keep up with the arrivals');
});

test('Two lines + warehouse: forklifts and AGVs, a warehouse, a BOM assembly, a depot with chargers', () => {
  const l = byId('two-lines');
  const types = l.stations.map((s) => s.type);
  for (const [type, n] of [['source', 1], ['storage', 1], ['process', 3], ['sink', 1], ['depot', 2]]) assert.equal(types.filter((t) => t === type).length, n, type);
  for (const name of ['Goods receiving', 'Central warehouse', 'Press line', 'Machining', 'Final assembly', 'Dispatch']) assert.ok(stationNamed(l, name), name);

  const assembly = stationNamed(l, 'Final assembly');
  const inflows = L.flowsTo(l, assembly.id);
  assert.deepEqual(inflows.map((f) => [L.getStation(l, f.from).name, f.perCycle]).sort(), [['Machining', 1], ['Press line', 2]]);
  assert.ok(inflows.every((f) => f.perCycle <= assembly.params.inCap));

  const forklift = l.fleets.find((f) => f.preset === 'forklift');
  const agv = l.fleets.find((f) => f.preset === 'agv');
  assert.deepEqual([forklift.speed, agv.speed], [3, 1.5]);
  assert.ok(agv.battery.enabled && agv.count >= 4);
  const charging = L.getStation(l, agv.home);
  assert.ok(charging.params.chargers >= 1 && charging.params.slots >= agv.count);
  assert.ok(l.flows.every((f) => f.fleetId !== null), 'each flow is assigned to forklifts or AGVs');
  assert.ok(new Set(l.flows.map((f) => f.fleetId)).size === 2);
  assert.ok(l.flows.some((f) => f.batchMin > 1 && f.maxWait > 0), 'a batched flow with a time limit');
  assert.ok(stationNamed(l, 'Press line').params.mtbf > 0, 'the press breaks down now and then');
  for (const s of l.stations.filter((x) => x.type === 'process')) assert.ok(s.params.cycle.mean >= 45 && s.params.cycle.mean <= 120, s.name);
});

test('Congestion lab: one-way loop, a crossing, docks on the aisle and more vehicles than comfortable', () => {
  const l = byId('congestion-lab');
  const oneWayLinks = Object.keys(l.roads).map(parseKey).flatMap(([cx, cy]) => [0, 1, 2, 3]
    .filter((d) => L.hasLink(l, cx, cy, d) && !L.hasLink(l, cx + DX[d], cy + DY[d], opposite(d))));
  assert.ok(oneWayLinks.length >= 60, `${oneWayLinks.length} one-way links`);
  const crossings = Object.keys(l.roads).map(parseKey).filter(([cx, cy]) => {
    const exits = [0, 1, 2, 3].filter((d) => L.hasLink(l, cx, cy, d)).length;
    const entries = [0, 1, 2, 3].filter((d) => L.hasLink(l, cx + DX[d], cy + DY[d], opposite(d))).length;
    return exits === 3 && entries === 3;
  });
  assert.ok(crossings.length >= 1, 'a cross aisle crosses the loop');
  assert.ok(l.fleets[0].count >= 6, 'more vehicles than the layout handles comfortably');
  assert.ok(L.getStation(l, l.fleets[0].home).params.slots >= l.fleets[0].count);
  const packing = stationNamed(l, 'Packing');
  const cyclesPerHour = (3600 / packing.params.cycle.mean) * packing.params.machines;
  for (const source of l.stations.filter((s) => s.type === 'source')) {
    assert.ok(3600 / source.params.interArrival.mean < cyclesPerHour, `${source.name}: one load per cycle, so the workstation itself is not the bottleneck`);
  }
  assert.ok(l.labels.length >= 2, 'the lab explains itself on the baseplate');
});
