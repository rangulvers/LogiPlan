// The pictures of the /how/ page: the manifest written by scripts/capture-how.mjs matches the files, the budgets hold, the alt texts in the page are the
// ones the capture script declares, and the hand-drawn SVGs are small, well formed, passive and themed through CSS custom properties.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLES } from '../js/model/examples.js';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const img = path.join(root, 'how/img');
const manifest = JSON.parse(readFileSync(path.join(img, 'manifest.json'), 'utf8'));
const html = readFileSync(path.join(root, 'how/index.html'), 'utf8');
const ALT_RE = /<img src="img\/([a-z-]+)\.(?:light|dark)\.webp"[^>]*? alt="([^"]*)"/g;

function dims(file) {
  const b = readFileSync(file);
  if (file.endsWith('.png')) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  const kind = b.toString('ascii', 12, 16);
  if (b.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

test('manifest and files agree: size, dimensions, nothing extra, nothing missing', () => {
  const files = readdirSync(img).filter((f) => f !== 'manifest.json');
  assert.deepEqual(files.sort(), Object.keys(manifest.images).sort());
  for (const f of files) {
    const e = manifest.images[f];
    assert.equal(statSync(path.join(img, f)).size, e.bytes, `${f} bytes`);
    assert.deepEqual(dims(path.join(img, f)), { width: e.width, height: e.height }, `${f} dimensions`);
  }
});

test('budgets: large slots, thumbnails, the whole folder', () => {
  let total = 0;
  for (const [f, e] of Object.entries(manifest.images)) {
    total += e.bytes;
    if (/^ex-/.test(f)) { assert.deepEqual([e.width, e.height], [640, 400]); assert.ok(e.bytes <= 22 * 1024, `${f} ${e.bytes}`); }
    else if (f === 'og.png') { assert.deepEqual([e.width, e.height], [1200, 630]); assert.ok(e.bytes <= 160 * 1024); }
    else { assert.deepEqual([e.width, e.height], [1600, 1000]); assert.ok(e.bytes <= 120 * 1024, `${f} ${e.bytes}`); }
  }
  assert.ok(total <= 2.4 * 1024 * 1024, `images total ${total}`);
  assert.equal(total, manifest.totalBytes);
});

test('every large slot exists in light and dark (the demo still in dark only), thumbnails for all examples', () => {
  for (const slot of ['build', 'flows', 'fleet', 'run', 'results', 'traffic', 'stats', 'docks', 'compare']) for (const t of ['light', 'dark']) assert.ok(manifest.images[`${slot}.${t}.webp`], `${slot}.${t}`);
  assert.ok(manifest.images['demo-still.dark.webp'] && manifest.images['og.png']);
  for (const { id } of EXAMPLES) for (const t of ['light', 'dark']) assert.ok(manifest.images[`ex-${id}.${t}.webp`], `ex-${id}.${t}`);
});

test('the alt text in the page is the one in the manifest, and describes the picture', () => {
  let n = 0;
  for (const [, slot, alt] of html.matchAll(ALT_RE)) {
    if (slot.startsWith('ex-')) { assert.equal(alt, ''); continue; }
    const e = manifest.images[`${slot}.light.webp`] || manifest.images[`${slot}.dark.webp`];
    assert.ok(e, `${slot} is in the manifest`);
    assert.equal(alt.replace(/&amp;/g, '&'), e.alt, `alt of ${slot}`);
    assert.ok(e.altKey === slot && alt.length > 40);
    n++;
  }
  assert.ok(n >= 10);
});

test('hand-drawn SVGs: well formed, small, passive, themed by custom properties, used by the page', () => {
  const dir = path.join(root, 'how/svg');
  const files = readdirSync(dir).filter((f) => f.endsWith('.svg'));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const s = readFileSync(path.join(dir, f), 'utf8');
    assert.ok(statSync(path.join(dir, f)).size <= 8 * 1024, `${f} under 8 KB`);
    assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 1600 1000"/);
    assert.match(s, /<\/svg>\s*$/);
    assert.doesNotMatch(s, /<script|<foreignObject|\son[a-z]+=|javascript:|@import|<image|<iframe/i, `${f} is passive`);
    assert.doesNotMatch(s.replace(/xmlns="[^"]*"/, ''), /https?:\/\//, `${f} has no external reference`);
    assert.doesNotMatch(s, /href="(?!#)/, `${f} references only itself`);
    assert.match(s, /<title id="t">[^<]{40,}<\/title>/, `${f} has a title`);
    assert.match(s, /prefers-color-scheme:\s*dark/, `${f} has a dark variant`);
    assert.match(s, /prefers-reduced-motion:\s*no-preference/, `${f} moves only when motion is welcome`);
    assert.doesNotMatch(s.replace(/<style>[\s\S]*?<\/style>/, ''), /(?:fill|stroke)="#(?!fff"|1c2230")/i, `${f}: colours come from custom properties`);
    assert.doesNotMatch(s.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<title[\s\S]*?<\/title>/, ''), />[^<]*\d[^<]*</, `${f} shows no numbers`);
    assert.ok(existsSync(path.join(dir, f)) && html.includes(`svg/${f}`), `${f} is on the page`);
    assert.ok(new RegExp(`src="svg/${f}"[^>]*alt="[^"]{60,}"`).test(html), `${f} has a real alt text`);
  }
});
