import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportProject, importProject, encodeShare, decodeShare, shareUrl } from '../js/model/serialize.js';
import * as L from '../js/model/layout.js';

const DAMAGED = 'This share link is damaged or from a newer version.';

function plant(name = 'Test plant') {
  const l = L.createLayout({ name, cols: 20, rows: 12, cellSize: 2 });
  L.paintRoadPath(l, [[1, 4], [18, 4]]);
  const src = L.addStation(l, { type: 'source', x: 2, y: 2, w: 3, h: 2, name: 'Goods receiving' });
  const sink = L.addStation(l, { type: 'sink', x: 14, y: 2, w: 3, h: 2 });
  L.addFlow(l, src.id, sink.id);
  L.addFleet(l, 'forklift', { count: 3 });
  L.addLabel(l, { x: 5.5, y: 8.25, text: 'Größe – 日本語 – 🏭' });
  return l;
}

function project() {
  return {
    name: 'My plant',
    scenarios: [{ id: 'a', name: 'Baseline', layout: plant('Baseline layout') }, { id: 'b', name: 'More forklifts', layout: plant('Variant') }],
    activeId: 'b',
  };
}

/** Build a 'z.' share string from arbitrary bytes, independent of encodeShare. */
async function rawShare(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return `z.${Buffer.from(await new Response(stream).arrayBuffer()).toString('base64url')}`;
}

/** Run `fn` while the browser has no CompressionStream (links come out in the plain 'p.' form). */
async function withoutCompression(fn) {
  const original = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    return await fn();
  } finally {
    globalThis.CompressionStream = original;
  }
}

/** A road mesh big enough that its JSON exceeds 300 KB. */
function bigProject() {
  const l = L.createLayout({ name: 'Big', cols: 160, rows: 160 });
  for (let y = 0; y < 160; y += 2) L.paintRoadPath(l, Array.from({ length: 160 }, (_, x) => [x, y]));
  for (let x = 0; x < 160; x += 3) L.paintRoadPath(l, Array.from({ length: 160 }, (_, y) => [x, y]));
  return { name: 'Big', scenarios: [{ id: 'a', name: 'A', layout: l }], activeId: 'a' };
}

// ---------------------------------------------------------------------------------------------------------
// exportProject / importProject
// ---------------------------------------------------------------------------------------------------------

test('exportProject writes { app, schema, name, active, scenarios } and the active scenario by index', () => {
  const p = project();
  const data = JSON.parse(exportProject(p));
  assert.deepEqual(Object.keys(data), ['app', 'schema', 'name', 'active', 'scenarios']);
  assert.deepEqual([data.app, data.schema, data.name, data.active], ['logiplan', 1, 'My plant', 1]);
  assert.deepEqual(data.scenarios.map((s) => [s.id, s.name]), [['a', 'Baseline'], ['b', 'More forklifts']]);
  assert.deepEqual(data.scenarios[0].layout, p.scenarios[0].layout);
  assert.equal(JSON.parse(exportProject({ ...p, activeId: undefined, active: 0 })).active, 0);
  assert.equal(JSON.parse(exportProject({ ...p, activeId: 'zzz', active: 99 })).active, 1, 'clamped to the last scenario');
  assert.throws(() => exportProject({ name: 'x', scenarios: [] }), /nothing to export/);
  assert.throws(() => exportProject(null), /nothing to export/);
});

test('importProject(exportProject(p)) gives back the same project, without warnings', () => {
  const p = project();
  const back = importProject(exportProject(p));
  assert.deepEqual(back, p);
  assert.ok(!('warnings' in back));
});

test('importProject accepts a bare layout JSON as a one-scenario project', () => {
  const layout = plant('Bare plant');
  const p = importProject(JSON.stringify(layout));
  assert.deepEqual([p.name, p.scenarios.length, p.scenarios[0].name, p.activeId], ['Bare plant', 1, 'A', p.scenarios[0].id]);
  assert.deepEqual(p.scenarios[0].layout, layout);
});

test('importProject normalizes every layout (junk is repaired, nothing throws)', () => {
  const text = JSON.stringify({
    app: 'logiplan', schema: 1, name: 5, active: 7,
    scenarios: [
      { id: 'x y', name: '', layout: { stations: [{ type: 'source', x: 5, y: 5 }], flows: [{ from: 's1', to: 'ghost' }], roads: { '1,1': { out: 99 } } } },
      { id: 'a', name: 'Two', layout: { grid: { cols: 'x' } } },
      { id: 'a', name: '  ', layout: {} },
      { layout: 'not a layout' },
      42,
    ],
  });
  const p = importProject(text);
  assert.equal(p.scenarios.length, 3);
  assert.deepEqual(p.scenarios.map((s) => s.name), ['A', 'Two', 'C']);
  assert.equal(new Set(p.scenarios.map((s) => s.id)).size, 3, 'ids unique and valid');
  assert.ok(p.scenarios.every((s) => /^[A-Za-z0-9_-]+$/.test(s.id)));
  assert.equal(p.name, '5');
  assert.equal(p.activeId, p.scenarios[0].id, 'out-of-range active falls back to the first scenario');
  assert.deepEqual(p.scenarios[0].layout.flows, []);
  assert.deepEqual(p.scenarios[0].layout.roads['1,1'], { out: 0 });
  assert.ok(p.scenarios.every((s) => L.checkInvariants(s.layout).length === 0));
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings[0], /Scenario 4.*skipped/);
  assert.match(p.warnings[1], /Scenario 5.*skipped/, 'an entry that is not even an object is reported too');
});

test('importProject keeps many scenarios, tolerates a byte-order mark, and says so when a huge file is cut off', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `S${i}`, layout: L.createLayout() }));
  const p = importProject(`\ufeff${JSON.stringify({ app: 'logiplan', active: 24, scenarios: make(25) })}`);
  assert.equal(p.scenarios.length, 25, 'more than the 20 the UI is designed for are not silently dropped');
  assert.equal(p.activeId, 's24');
  assert.equal(p.warnings, undefined);

  const huge = importProject(JSON.stringify({ app: 'logiplan', active: 3, scenarios: make(130) }));
  assert.equal(huge.scenarios.length, 100);
  assert.equal(huge.activeId, 's3');
  assert.deepEqual(huge.warnings, ['This file holds 130 scenarios; only the first 100 were opened.']);

  const lost = importProject(JSON.stringify({ app: 'logiplan', active: 120, scenarios: make(130) }));
  assert.equal(lost.activeId, 's0', 'the active scenario was cut off: the first one opens');
  assert.equal(lost.warnings.length, 2);
  assert.match(lost.warnings[1], /could not be opened.*first scenario/);
});

test('importProject resolves `active` against the file\'s own list, also when other entries are skipped', () => {
  const layout = L.createLayout();
  const doc = (active, scenarios) => JSON.stringify({ app: 'logiplan', active, scenarios });
  const entries = [{ id: 'a', name: 'A', layout }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', layout }];
  const p = importProject(doc(2, entries));
  assert.deepEqual(p.scenarios.map((s) => s.id), ['a', 'c']);
  assert.equal(p.activeId, 'c', 'the file says scenario #3 was active');
  assert.equal(p.warnings.length, 1);
  assert.equal(importProject(doc(1, [7, entries[0], entries[2]])).activeId, 'a', 'junk entries in front do not shift the index');
  const skipped = importProject(doc(1, entries));
  assert.equal(skipped.activeId, 'a', 'the active scenario had no layout: the first one opens');
  assert.equal(skipped.warnings.length, 2);
  assert.match(skipped.warnings[1], /could not be opened.*first scenario/);
  assert.equal(importProject(doc(-1, entries)).activeId, 'a');
  assert.equal(importProject(doc('1', entries)).activeId, 'a');
});

test('importProject: JSON from a newer schema is accepted with a warning', () => {
  const future = { app: 'logiplan', schema: 4, name: 'From the future', scenarios: [{ id: 'a', name: 'A', layout: { ...plant(), schema: 9, hologram: { on: true } } }] };
  const p = importProject(JSON.stringify(future));
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /newer version of LogiPlan \(format 9; this version reads format 2\)/);
  assert.equal(p.scenarios[0].layout.schema, 1);
  assert.ok(!('hologram' in p.scenarios[0].layout));
  assert.deepEqual(L.checkInvariants(p.scenarios[0].layout), []);
  const bare = importProject(JSON.stringify({ ...plant(), schema: 3 }));
  assert.equal(bare.warnings.length, 1);
  assert.equal(importProject(JSON.stringify({ ...plant(), schema: 0 })).warnings, undefined, 'older or missing schemas need no warning');
});

test('importProject rejects things that are not LogiPlan files with a friendly Error', () => {
  const junk = ['', 'not json at all', '[]', '"text"', '42', 'null', 'true', '{}', '{"hello":"world"}', '{"app":"logiplan"}',
    '{"scenarios":[]}', '{"scenarios":[{"layout":5}]}', '{"scenarios":"x"}', '{"grid":'];
  for (const text of junk) {
    assert.throws(() => importProject(text), (e) => e instanceof Error && /LogiPlan|JSON|layout/.test(e.message) && e.message.length > 20, JSON.stringify(text));
  }
  for (const notText of [undefined, null, 5, {}]) assert.throws(() => importProject(notText), /Expected the text/);
  assert.throws(() => importProject(' '.repeat(26e6)), /too large/);
});

test('importProject never pollutes prototypes and never executes anything', () => {
  const text = '{"__proto__":{"polluted":"top"},"app":"logiplan","name":"P","constructor":{"prototype":{"polluted":"ctor"}},'
    + '"scenarios":[{"id":"a","name":"A","__proto__":{"polluted":"scenario"},"layout":{"__proto__":{"polluted":"layout"},'
    + '"name":"alert(1); process.exit(1)","settings":{"__proto__":{"seed":5},"constructor":"x"},"roads":{"__proto__":{"out":1},"2,2":{"__proto__":{"out":15},"out":0}},'
    + '"stations":[{"type":"source","x":8,"y":8,"__proto__":{"y":9},"params":{"__proto__":{"batch":50}}}]}}]}';
  const p = importProject(text);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const layout = p.scenarios[0].layout;
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  assert.equal(Object.getPrototypeOf(layout.roads), Object.prototype);
  assert.ok(!Object.hasOwn(layout.roads, '__proto__'));
  assert.deepEqual([layout.settings.seed, layout.stations[0].y, layout.stations[0].params.batch, layout.roads['2,2'].out], [1, 8, 1, 0]);
  assert.equal(layout.name, 'alert(1); process.exit(1)', 'text stays text');
  assert.deepEqual(L.checkInvariants(layout), []);
});

// ---------------------------------------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------------------------------------

test('encodeShare / decodeShare roundtrip, URL-safe, compressed', async () => {
  const p = project();
  const s = await encodeShare(p);
  assert.match(s, /^z\.[A-Za-z0-9_-]+$/);
  assert.ok(s.length < exportProject(p).length, 'smaller than the JSON');
  assert.deepEqual(await decodeShare(s), p);
  assert.equal(await encodeShare(p), s, 'deterministic');
  assert.deepEqual((await decodeShare(s)).scenarios[0].layout.labels[0].text, 'Größe – 日本語 – 🏭', 'unicode survives');
});

test('shareUrl builds #p=… and decodeShare accepts the payload in all its dressings', async () => {
  const p = project();
  const url = await shareUrl('https://example.github.io/LogiPlan/index.html#old=1', p);
  assert.match(url, /^https:\/\/example\.github\.io\/LogiPlan\/index\.html#p=z\.[A-Za-z0-9_-]+$/);
  const payload = url.split('#p=')[1];
  for (const form of [payload, `p=${payload}`, `#p=${payload}`, url, `  ${payload}\n`]) assert.deepEqual(await decodeShare(form), p);
});

test('decodeShare shrugs off what chat and mail clients do to a pasted link (line breaks, spaces, punctuation around it)', async () => {
  const p = project();
  const url = await shareUrl('https://example.github.io/LogiPlan/', p);
  const half = Math.floor(url.length / 2);
  const dressed = [`(${url})`, `${url}.`, `"${url}",`, `<${url}>`, `${url}).`, `${url.slice(0, half)}\n${url.slice(half)}`, `${url.slice(0, half)} \r\n ${url.slice(half)}`, `\t${url}!\n`];
  for (const form of dressed) assert.deepEqual(await decodeShare(form), p, JSON.stringify(form.slice(-24)));
  await assert.rejects(decodeShare(`${url.slice(0, half)}!!${url.slice(half)}`), (e) => e.message === DAMAGED, 'noise inside the payload is still damage');
});

test('shares of layouts above 300 KB roundtrip exactly', async () => {
  const p = bigProject();
  const json = exportProject(p);
  assert.ok(json.length > 300_000, `json is ${json.length} characters`);
  const s = await encodeShare(p);
  assert.ok(s.length < json.length / 3, `compressed to ${s.length}`);
  assert.deepEqual(await decodeShare(s), p);
});

test('without CompressionStream the link is plain base64url with prefix p. and still decodes', async () => {
  const p = project();
  const original = globalThis.CompressionStream;
  let plain;
  try {
    globalThis.CompressionStream = undefined;
    plain = await encodeShare(p);
  } finally {
    globalThis.CompressionStream = original;
  }
  assert.match(plain, /^p\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShare(plain), p);
  assert.ok(plain.length > (await encodeShare(p)).length, 'the plain form is longer');

  const compressed = await encodeShare(p);
  const originalInflate = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    await assert.rejects(decodeShare(compressed), /cannot open it.*update your browser/i);
  } finally {
    globalThis.DecompressionStream = originalInflate;
  }
});

test('a browser whose DecompressionStream does not know deflate-raw is told to update, not that the link is damaged', async () => {
  const compressed = await encodeShare(project());
  const original = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = class {
      constructor(format) { throw new TypeError(`Unsupported compression format: '${format}'`); }
    };
    await assert.rejects(decodeShare(compressed), /cannot open it.*update your browser/i);
    assert.deepEqual((await decodeShare(await withoutCompression(() => encodeShare(project())))).name, 'My plant', 'plain links do not need it');
  } finally {
    globalThis.DecompressionStream = original;
  }
});

test('damaged or foreign links throw the same clear Error', async () => {
  const good = await encodeShare(project());
  const middle = Math.floor(good.length / 2);
  const flip = (i) => good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
  const bad = [
    good.slice(0, 40), good.slice(0, middle), flip(middle), flip(10), `${good.slice(0, middle)}!!${good.slice(middle)}`, good.replace('z.', 'q.'), 'z.', 'p.', '', 'nonsense', 'z.A', 'p.AAAAA',
    `p.${Buffer.from('{"hello":1}').toString('base64url')}`, // valid base64 and JSON, but not a project
    `p.${Buffer.from('{"scenarios":[').toString('base64url')}`, // cut-off JSON
    await rawShare(new TextEncoder().encode('plain words, not a project')),
    await rawShare(new Uint8Array([0xff, 0xfe, 0xfd])), // not UTF-8
    null, undefined, 12,
  ];
  for (const input of bad) {
    await assert.rejects(decodeShare(input), (e) => e instanceof Error && e.message === DAMAGED, String(input).slice(0, 30));
  }
});

test('a decompression bomb is refused instead of filling memory', async () => {
  const bomb = await rawShare(new Uint8Array(70 * 1024 * 1024));
  assert.ok(bomb.length < 200_000);
  await assert.rejects(decodeShare(bomb), (e) => e.message === DAMAGED);
});

test('a link from a newer version opens with a warning', async () => {
  const future = JSON.stringify({ app: 'logiplan', schema: 12, name: 'Future', scenarios: [{ id: 'a', name: 'A', layout: { ...plant(), schema: 12 } }] });
  const p = await decodeShare(await rawShare(new TextEncoder().encode(future)));
  assert.equal(p.name, 'Future');
  assert.match(p.warnings[0], /newer version/);
});

test('names with control characters or lone surrogates come out clean', () => {
  const layout = { ...plant(), name: 'Plant\u0000\u0007 one\ud800' };
  const p = importProject(JSON.stringify({ app: 'logiplan', name: 'Pro\nject\udc00', scenarios: [{ name: 'Sc\tenario', layout }] }));
  assert.equal(p.name, 'Pro ject\ufffd');
  assert.equal(p.scenarios[0].name, 'Sc enario');
  assert.equal(p.scenarios[0].layout.name, 'Plant   one\ufffd');
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(p.name)), p.name, 'valid UTF-8, so shares are exact');
});
