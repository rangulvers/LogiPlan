import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapAngle, lerpAngle, fitText, quadPoint, quadAngle, quadSpeed, flowCurve, distToCurve, HANDLE_NAMES, handlePoint, hitHandle,
  pointInRect, rectOverlapsBox, niceScale,
} from '../js/ui/render/geometry.js';
import { buildScene, getScene, OCC_ROAD, OCC_STATION, OCC_OBSTACLE } from '../js/ui/render/scene.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { E, S } from '../js/util/grid.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('geometry: wrapAngle maps into (-PI, PI] and tolerates junk', () => {
  near(wrapAngle(3 * Math.PI), Math.PI);
  near(wrapAngle(-3 * Math.PI), Math.PI);
  near(wrapAngle(0.5 + 2 * Math.PI * 7), 0.5);
  near(wrapAngle(-0.25), -0.25);
  assert.equal(wrapAngle(NaN), 0);
  assert.equal(wrapAngle(Infinity), 0);
});

test('geometry: lerpAngle takes the shortest arc, also across the +-PI seam', () => {
  near(lerpAngle(0, Math.PI / 2, 0.5), Math.PI / 4);
  // from 170 deg to -170 deg is a 20 deg turn through 180, not a 340 deg turn through 0
  const a = (170 * Math.PI) / 180;
  const b = (-170 * Math.PI) / 180;
  near(wrapAngle(lerpAngle(a, b, 0.5)), Math.PI);
  near(wrapAngle(lerpAngle(a, b, 1)), b);
  near(lerpAngle(a, b, 0), a);
  near(lerpAngle(0.3, 0.3, 0.7), 0.3);
});

test('geometry: fitText keeps what fits, ellipsises what does not, and never exceeds the width', () => {
  const measure = (s) => s.length * 10;
  assert.equal(fitText(measure, 'Press', 100), 'Press');
  assert.equal(fitText(measure, 'Final assembly line 3', 100), 'Final ass…');
  assert.equal(fitText(measure, 'abcdefgh', 80), 'abcdefgh');
  assert.equal(fitText(measure, 'abcdefghi', 80), 'abcdefg…');
  assert.equal(fitText(measure, 'abc', 5), '', 'not even the ellipsis fits');
  assert.equal(fitText(measure, '', 100), '');
  assert.equal(fitText(measure, 'abc', 0), '');
  assert.equal(fitText(measure, 'abc', NaN), '');
  for (let w = 10; w <= 200; w += 7) {
    const out = fitText(measure, 'Supermarket buffer north', w);
    assert.ok(measure(out) <= w, `width ${w}: "${out}"`);
  }
});

test('geometry: flowCurve starts and ends at the brick borders and is visible between them', () => {
  const a = { x: 0, y: 0, w: 6, h: 4 };
  const b = { x: 20, y: 0, w: 6, h: 4 };
  const c = flowCurve(a, b);
  assert.ok(c);
  const start = quadPoint(c, c.t0);
  const end = quadPoint(c, c.t1);
  assert.ok(start[0] >= a.x + a.w - 0.5 && start[0] <= a.x + a.w + 0.6, `start x ${start[0]}`);
  assert.ok(end[0] <= b.x + 0.1 && end[0] >= b.x - 0.6, `end x ${end[0]}`);
  assert.ok(c.t0 > 0 && c.t1 < 1 && c.t1 > c.t0);
  assert.ok(c.length > 12 && c.length < 20);
  near(quadAngle(c, c.t1), 0, 0.35); // heading east, bent a little
});

test('geometry: A->B and B->A bow to opposite sides so the two arrows never overlap', () => {
  const a = { x: 0, y: 0, w: 6, h: 4 };
  const b = { x: 20, y: 0, w: 6, h: 4 };
  const ab = flowCurve(a, b);
  const ba = flowCurve(b, a);
  const mid = (c) => quadPoint(c, (c.t0 + c.t1) / 2);
  const m1 = mid(ab);
  const m2 = mid(ba);
  assert.ok(Math.abs(m1[1] - m2[1]) > 1, `arrows are ${Math.abs(m1[1] - m2[1]).toFixed(2)} m apart`);
  assert.ok((m1[1] - 2) * (m2[1] - 2) < 0, 'on different sides of the centre line');
  // right-hand traffic: travelling east, the arrow bows towards +y (down on screen)
  assert.ok(m1[1] > 2);
  // a point on one arrow is clearly not near the other
  assert.ok(distToCurve(ba, m1[0], m1[1]) > 1);
});

test('geometry: flowCurve returns null when there is no visible arrow', () => {
  const a = { x: 0, y: 0, w: 4, h: 4 };
  assert.equal(flowCurve(a, a), null, 'same rectangle');
  assert.equal(flowCurve(a, { x: 4.1, y: 0, w: 4, h: 4 }), null, 'touching bricks leave no room');
  assert.equal(flowCurve(a, { x: 1, y: 1, w: 2, h: 2 }), null, 'one inside the other');
  assert.ok(flowCurve(a, { x: 10, y: 0, w: 4, h: 4 }), 'a gap of 6 m is enough');
  const diagonal = flowCurve({ x: 0, y: 0, w: 4, h: 4 }, { x: 30, y: 30, w: 4, h: 4 });
  assert.ok(diagonal && Number.isFinite(diagonal.length));
});

test('geometry: quadSpeed and distToCurve measure along the curve', () => {
  const c = { ax: 0, ay: 0, qx: 5, qy: 0, bx: 10, by: 0, t0: 0, t1: 1 };
  near(quadSpeed(c, 0.5), 10); // a straight 10 m line with the control point in the middle moves at 10 m per unit of t
  near(quadSpeed(c, 0), 10);
  near(distToCurve(c, 5, 3), 3);
  near(distToCurve(c, 5, 0), 0, 1e-9);
  near(distToCurve(c, -4, 0), 4, 1e-9);
  near(distToCurve(c, 14, 3), 5, 1e-9);
  const half = { ...c, t0: 0.25, t1: 0.75 };
  near(distToCurve(half, 1, 0), 1.5, 1e-9);
});

test('geometry: handles sit on the rectangle outline and the nearest one wins', () => {
  assert.equal(HANDLE_NAMES.length, 8);
  const p = [0, 0];
  assert.deepEqual(handlePoint('nw', 10, 20, 100, 50, p), [10, 20]);
  assert.deepEqual(handlePoint('se', 10, 20, 100, 50, p), [110, 70]);
  assert.deepEqual(handlePoint('n', 10, 20, 100, 50, p), [60, 20]);
  assert.deepEqual(handlePoint('w', 10, 20, 100, 50, p), [10, 45]);
  for (const name of HANDLE_NAMES) {
    handlePoint(name, 10, 20, 100, 50, p);
    assert.equal(hitHandle(10, 20, 100, 50, p[0], p[1], 7), name);
  }
  assert.equal(hitHandle(10, 20, 100, 50, 60, 45, 7), null, 'the middle of the body is no handle');
  assert.equal(hitHandle(10, 20, 100, 50, 14, 24, 7), 'nw');
  // a tiny rectangle: corners and edge handles overlap, the closest one still wins
  assert.equal(hitHandle(0, 0, 6, 6, 5, 5, 7), 'se');
});

test('geometry: point / box helpers', () => {
  const r = { x: 2, y: 3, w: 4, h: 5 };
  assert.ok(pointInRect(2, 3, r));
  assert.ok(pointInRect(5.9, 7.9, r));
  assert.ok(!pointInRect(6, 3, r));
  assert.ok(!pointInRect(1.9, 4, r));
  assert.ok(rectOverlapsBox({ x0: 0, y0: 0, x1: 2, y1: 3 }, r), 'touching counts');
  assert.ok(!rectOverlapsBox({ x0: 0, y0: 0, x1: 1.9, y1: 10 }, r));
});

test('geometry: niceScale picks 1/2/5 x 10^n metres that fit the pixel budget', () => {
  assert.deepEqual(niceScale(20, 130), { metres: 5, px: 100 });
  assert.deepEqual(niceScale(4, 130), { metres: 20, px: 80 });
  assert.deepEqual(niceScale(80, 130), { metres: 1, px: 80 });
  assert.deepEqual(niceScale(100, 130), { metres: 1, px: 100 });
  const tiny = niceScale(1000, 130); // 13 cm fits: sub-metre steps are allowed
  assert.ok(tiny.metres > 0 && tiny.px <= 130);
  for (const z of [4, 7.3, 12, 20, 33, 61, 80]) {
    const s = niceScale(z, 130);
    assert.ok(s.px <= 130 && s.px > 130 / 2.6, `zoom ${z}: ${s.px}`);
  }
  assert.deepEqual(niceScale(0, 130), { metres: 0, px: 0 });
  assert.deepEqual(niceScale(NaN, 130), { metres: 0, px: 0 });
  assert.deepEqual(niceScale(20, -5), { metres: 0, px: 0 });
});

// ---- scene -------------------------------------------------------------------------------------------------

test('scene: occupancy marks roads, stations and obstacles; out-of-range cells are ignored', () => {
  const layout = layoutFromAscii(['AA#..', '+++++'], { stations: { A: 'source' } });
  layout.roads['99,99'] = { out: 0 };
  layout.roads['-1,0'] = { out: 0 };
  const scene = buildScene(layout);
  const occ = (x, y) => scene.occ[y * scene.cols + x];
  assert.equal(occ(0, 0), OCC_STATION);
  assert.equal(occ(2, 0), OCC_OBSTACLE);
  assert.equal(occ(3, 0), 0);
  assert.equal(occ(4, 1), OCC_ROAD);
  assert.equal(scene.roads.length, 5, 'only the five in-range road cells');
  assert.equal(scene.width, scene.cols * 2);
  assert.equal(scene.stations.length, 1);
  assert.deepEqual([scene.stations[0].x, scene.stations[0].w], [0, 4], 'station rectangle in metres');
  assert.equal(scene.stationById.get('A'), scene.stations[0]);
});

test('scene: two-way links are listed once per pair, one-way links once per direction', () => {
  const layout = layoutFromAscii(['+++>>', '.....']);
  const scene = buildScene(layout);
  const links = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i += 3) out.push(`${list[i]},${list[i + 1]},${list[i + 2]}`);
    return out.sort();
  };
  assert.deepEqual(links(scene.twoWay), ['0,0,1', '1,0,1']);
  assert.deepEqual(links(scene.oneWay), ['2,0,1', '3,0,1']);
  const vertical = buildScene(layoutFromAscii(['+', '+', 'v', 'v']));
  assert.deepEqual(links(vertical.twoWay), [`0,0,${S}`]);
  assert.deepEqual(links(vertical.oneWay), [`0,1,${S}`, `0,2,${S}`]);
  assert.ok(E !== S);
});

test('scene: a link needs a road on both ends and a bit in the mask', () => {
  const layout = layoutFromAscii(['++.+']);
  layout.roads['1,0'].out = 2; // now points east into a gap and no longer back west
  const scene = buildScene(layout);
  assert.deepEqual(scene.twoWay, []);
  assert.deepEqual(scene.oneWay, [0, 0, E], 'only 0,0 -> 1,0 is a real link; the exit into the gap is not');
});

test('scene: speed zones are grouped into connected cells with equal limits, labelled once', () => {
  const layout = layoutFromAscii(['+++++++', '.......']);
  for (const x of [1, 2, 3]) layout.roads[`${x},0`].limit = 0.5;
  layout.roads['5,0'].limit = 0.5;
  layout.roads['6,0'].limit = 0.8;
  const scene = buildScene(layout);
  assert.equal(scene.zones.length, 3);
  const byLimit = (l) => scene.zones.filter((z) => z.limit === l);
  assert.equal(byLimit(0.5).length, 2, 'two separate 50 % zones');
  assert.equal(byLimit(0.8).length, 1);
  const big = byLimit(0.5).find((z) => z.cells === 3);
  assert.deepEqual([big.cx, big.cy], [2, 0], 'label on the middle cell of the zone');
  assert.equal(scene.limit[0], 1, 'plain cells have no limit');
  assert.equal(scene.limit[1], 0.5);
});

test('scene: flows get curves; flows with missing or touching stations are skipped; the scene is cached per layout', () => {
  const layout = layoutFromAscii(['AA....BB', '++++++++'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] });
  layout.flows.push({ id: 'bad', from: 'A', to: 'nope', weight: 1 });
  layout.flows.push({ id: 'self', from: 'A', to: 'A', weight: 1 });
  const scene = getScene(layout);
  assert.equal(scene, getScene(layout), 'cached by object identity');
  assert.notEqual(scene, getScene({ ...layout }), 'a new layout object gets a new scene');
  assert.equal(scene.flows.length, 1);
  assert.equal(scene.flows[0].flow.id, 'f1');
  assert.equal(getScene(null), null);
  assert.equal(getScene(undefined), null);
});

test('scene: tolerates layouts with missing collections and junk values', () => {
  const scene = buildScene({ grid: { cols: 'x', rows: NaN, cellSize: -3 } });
  assert.equal(scene.cols, 48);
  assert.equal(scene.rows, 32);
  assert.equal(scene.cs, 2);
  assert.deepEqual([scene.roads.length, scene.stations.length, scene.flows.length], [0, 0, 0]);
  const odd = buildScene({ grid: { cols: 4, rows: 4, cellSize: 1 }, roads: { '1,1': null, '2,2': { out: 'x', limit: 'fast' }, bad: {} }, stations: [{ id: 's', type: 'sink', x: 3, y: 3, w: 5, h: 5 }] });
  assert.equal(odd.roads.length, 2);
  assert.equal(odd.limit[2 * 4 + 2], 1);
  assert.equal(odd.occ[3 * 4 + 3], OCC_STATION, 'a station overhanging the grid is clipped');
});
