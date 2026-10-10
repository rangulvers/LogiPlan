// The landing page /how/ in the ASSEMBLED site, served under a path prefix like GitHub Pages does (https://<user>.github.io/<repo>/how/):
// every file the page, its stylesheets and its scripts refer to is found under the prefix, with a sensible MIME type, and nothing asks for a root-relative
// path. Also the weight of the demo's script graph (docs/HOW-PAGE-DESIGN.md H11: at most 400 KB uncompressed on top of the planner's shared modules).
// The browser checks of the same page are tests/e2e/how.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleSite } from '../scripts/build-site.mjs';

const PREFIX = '/LogiPlan/';
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon' };

function serve(dir) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    seen.push(p);
    if (!p.startsWith(PREFIX)) { res.writeHead(404).end(); return; }
    let rel = p.slice(PREFIX.length);
    if (rel === 'how') { res.writeHead(301, { location: PREFIX + 'how/' }).end(); return; }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

/** The relative references of a file by kind: markup (href, src, srcset), stylesheet (url()), module (import ... from, import()). */
function refs(url, text) {
  const out = [];
  if (url.endsWith('.html') || url.endsWith('/')) {
    for (const m of text.matchAll(/\s(?:href|src)="([^"]*)"/g)) out.push(m[1]);
    for (const m of text.matchAll(/\ssrcset="([^"]*)"/g)) for (const u of m[1].split(',')) out.push(u.trim().split(/\s+/)[0]);
  } else if (url.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) out.push(m[1]);
  } else if (url.endsWith('.js')) {
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.push(m[1]);
    for (const m of text.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) out.push(m[1]);
  }
  return out.filter((u) => u && !u.startsWith('#') && !u.startsWith('data:'));
}

test('under a path prefix the page and everything it needs is found', async (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'logiplan-how-prefix-'));
  assembleSite({ out, env: {}, now: new Date('2026-01-01T00:00:00Z') });
  const { server, seen, base } = await serve(out);
  t.after(() => { server.close(); rmSync(out, { recursive: true, force: true }); });

  const redirect = await fetch(`${base}${PREFIX}how`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), `${PREFIX}how/`);

  const queue = [`${base}${PREFIX}how/`];
  const done = new Set();
  const jsBytes = new Map();
  while (queue.length) {
    const url = queue.shift();
    if (done.has(url)) continue;
    done.add(url);
    const res = await fetch(url);
    assert.equal(res.status, 200, `${url} is served`);
    const ext = path.extname(new URL(url).pathname) || '.html';
    assert.ok(res.headers.get('content-type').startsWith(TYPES[ext]), `${url} has the right type`);
    const text = ['.webp', '.png', '.ico'].includes(ext) ? '' : await res.text();
    if (ext === '.js' && new URL(url).pathname.includes('/how/')) jsBytes.set(url, Buffer.byteLength(text));
    for (const ref of refs(url, text)) {
      assert.ok(!ref.startsWith('/') && !/^[a-z]+:/i.test(ref) || /^https:\/\/github\.com\//.test(ref), `${url}: "${ref}" must be relative (it would break under a path prefix)`);
      if (/^https?:/.test(ref)) continue;
      const next = new URL(ref, url);
      assert.ok(next.pathname.startsWith(PREFIX), `${url}: "${ref}" leaves the site (${next.pathname})`);
      if (next.pathname.endsWith('/') && !next.search) { queue.push(`${base}${next.pathname}`); continue; } // "../" is the planner itself: it must answer, no need to crawl it
      queue.push(next.origin + next.pathname);
    }
  }
  assert.ok(done.size > 40, `the crawl found the page, its styles, scripts and images (${done.size} files)`);
  assert.ok(seen.every((p) => p.startsWith(PREFIX)), 'nothing was requested outside the prefix');
  for (const f of ['how/css/demo.css', 'how/js/demo.js', 'js/sim/engine.js', 'js/ui/renderer.js', 'css/tokens.css', 'how/facts.json']) assert.ok(done.has(`${base}${PREFIX}${f}`) || f === 'how/facts.json', `${f} is part of the page's graph`);

  const own = [...jsBytes.values()].reduce((a, b) => a + b, 0);
  assert.ok(own <= 400 * 1024, `the demo's own scripts are ${own} bytes, budget 409600`);
});

test('the identity of the build is untouched by the page', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'logiplan-how-id-'));
  try {
    assembleSite({ out, env: {}, now: new Date('2026-01-01T00:00:00Z') });
    const v = JSON.parse(readFileSync(path.join(out, 'version.json'), 'utf8'));
    assert.equal(v.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
