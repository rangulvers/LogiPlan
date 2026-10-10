// The landing page /how/ (docs/HOW-PAGE-DESIGN.md): its facts, its honesty and its rules, checked without a browser (the browser checks are tests/e2e/how.mjs).
//
//   facts      how/facts.json is what scripts/how-facts.mjs derives from the repository now, and every data-fact / data-fact-href / data-fact-content of the page
//              says exactly that (a stale number fails here; fix it with `node scripts/how-facts.mjs` and the new text)
//   honesty    no digit, percent or money figure is typed into the prose: numbers live in data-fact spans (or are structural: section, step and level numbers)
//   rules      one h1, landmarks, headings in order, unique ids, every in-page link lands, images have alt + width + height + lazy loading, nothing is fetched from
//              another site, every relative file exists, no script but our own, a noscript note, the demo mount keeps its parts
//   weight     HTML + page.css + tokens.css, gzipped, stay inside the 150 KB budget of the critical path; the images stay inside 2.5 MB
//   styles     page.css answers dark, reduced motion, high contrast, forced colours and print
//   site       the site that scripts/build-site.mjs assembles contains how/
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFacts, renderFacts, FACTS_FILE } from '../scripts/how-facts.mjs';
import { assembleSite } from '../scripts/build-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const html = read('how/index.html');
const css = read('how/css/page.css');
const facts = computeFacts();

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] === undefined ? '' : decode(m[2])]));
const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map((m) => ({ raw: m[0], a: attrs(`x ${m[1]}`) }));
const body = html.slice(html.indexOf('<body'));

test('how/facts.json is what the repository says now', () => {
  assert.equal(readFileSync(path.join(root, FACTS_FILE), 'utf8'), renderFacts(facts), 'run: node scripts/how-facts.mjs');
});

test('every data-fact of the page says what the repository says', () => {
  const found = [...html.matchAll(/<(\w+)\b([^>]*\bdata-fact="([^"]+)"[^>]*)>([^<]*)<\/\1>/g)];
  assert.ok(found.length >= 30, 'the page uses its facts');
  for (const [, , , key, text] of found) {
    assert.ok(facts[key], `unknown fact "${key}"`);
    const want = facts[key].value;
    const got = decode(text).trim();
    const thousands = /data-format="thousands"/.test(found.find((f) => f[3] === key && f[4] === text)[2]);
    assert.equal(thousands ? got.replace(/,/g, '') : got, want, `data-fact="${key}" prints "${got}" but the repository says "${want}" (node scripts/how-facts.mjs, then update the page)`);
  }
  for (const [, key] of html.matchAll(/data-fact-href="([^"]+)"/g).map((m) => [m[0], m[1]])) {
    assert.ok(facts[key], `unknown fact "${key}"`);
    const tag = tags('a').find((t) => t.a['data-fact-href'] === key);
    assert.equal(tag.a.href, facts[key].value, `the link of ${key}`);
  }
  for (const tag of tags('meta').filter((t) => t.a['data-fact-content'])) {
    assert.equal(tag.a.content, facts[tag.a['data-fact-content']].value, `meta ${tag.a.property || tag.a.name}`);
  }
});

test('every example of the ladder is on the page, in order, once', () => {
  const ladder = html.slice(html.indexOf('class="ladder"'), html.indexOf('</section>', html.lastIndexOf('class="lvl"')));
  const names = [...ladder.matchAll(/data-fact="(ex\.[\w-]+\.name)"/g)].map((m) => m[1]);
  const wanted = Object.keys(facts).filter((k) => /^ex\.[\w-]+\.name$/.test(k));
  assert.equal(names.length, Number(facts['examples.count'].value));
  assert.deepEqual([...names].sort(), [...wanted].sort());
  const levels = names.map((k) => Number(facts[k.replace('.name', '.level')].value));
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'the ladder runs from level 1 up');
});

test('no number is typed into the prose: numbers are facts', () => {
  let text = body
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<(\w+)\b[^>]*\bdata-fact="[^"]*"[^>]*>[^<]*<\/\1>/g, ' ')
    .replace(/<(\w+)\b[^>]*\bclass="[^"]*\b(?:eyebrow__n|step__n|lvl__n)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<span class="mono">Fig\. \d+<\/span>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = decode(text);
  const digits = [...text.matchAll(/\S*\d\S*/g)].map((m) => m[0]);
  assert.deepEqual(digits, [], `digits in the prose (make them facts in scripts/how-facts.mjs): ${digits.join(' ')}`);
  assert.doesNotMatch(text, /%|\$|€|£|\bROI\b|\bcustomers?\b|\bawards?\b|\btestimonials?\b/i, 'no percentages, money, ROI, customers or awards');
});

test('landmarks, headings, ids and in-page links', () => {
  assert.equal(tags('h1').length, 1, 'one h1');
  assert.equal(tags('main').length, 1);
  assert.equal(tags('header').length, 1);
  assert.equal(tags('footer').length, 1);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<a class="skip" href="#main">/);
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  levels.reduce((prev, l) => { assert.ok(l <= prev + 1, `heading level jumps from ${prev} to ${l}`); return l; }, 0);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(id), `#${id} exists`);
  for (const [, id] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(ids.includes(id), `aria-labelledby ${id} exists`);
  for (const nav of tags('nav')) assert.ok(nav.a['aria-label'], 'every nav has a name');
  assert.match(html, /<noscript>/);
});

test('images: alt, size, lazy loading, files', () => {
  for (const { a, raw } of tags('img')) {
    assert.ok('alt' in a, `alt on ${raw}`);
    assert.ok(a.width && a.height, `width and height on ${raw}`);
    if (!/logo\.svg/.test(a.src)) assert.equal(a.loading, 'lazy', `lazy loading on ${raw}`);
    assert.ok(existsSync(path.join(root, 'how', a.src)), `${a.src} exists`);
    if (a.alt !== '') assert.ok(a.alt.length > 25, `a real alt text on ${a.src}`);
  }
  for (const { a } of tags('source')) for (const u of a.srcset.split(',')) assert.ok(existsSync(path.join(root, 'how', u.trim().split(/\s+/)[0])), `${u} exists`);
});

test('nothing is fetched from another site; every relative file exists', () => {
  const urls = [
    ...tags('a').map((t) => t.a.href), ...tags('link').map((t) => t.a.href), ...tags('script').map((t) => t.a.src), ...tags('img').map((t) => t.a.src),
    ...tags('source').flatMap((t) => t.a.srcset.split(',').map((u) => u.trim().split(/\s+/)[0])),
    ...[...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, '')),
  ].filter(Boolean);
  const outgoing = new Set([facts['repo.url'].value, facts['repo.license_url'].value]);
  for (const u of urls) {
    if (/^(https?:)?\/\//.test(u)) assert.ok(outgoing.has(u), `outgoing URL ${u} is not the repository or its licence`);
    else if (!u.startsWith('#') && !u.startsWith('data:')) {
      const file = u.split('#')[0].split('?')[0];
      if (file && file !== '../' && file !== './') assert.ok(existsSync(path.join(root, 'how', file)), `how/${file} exists`);
    }
  }
  for (const t of tags('meta').filter((m) => m.a.content && /^https?:/.test(m.a.content))) assert.ok(t.a['data-fact-content'], 'an absolute meta URL is a fact');
  assert.doesNotMatch(css, /@import|@font-face/, 'no imports, no web fonts');
  assert.deepEqual(tags('script').map((t) => t.a.src), ['js/demo-boot.js'], "one script: the page's own boot module");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
  assert.match(html, /href="\.\.\/\?welcome"/, 'the examples link opens the welcome dialog of the planner');
  assert.match(html, /<a class="btn[^"]*" href="\.\.\/">Open the planner/);
});

test('the demo mount keeps the parts the demo script needs', () => {
  const mount = html.match(/<div class="demo" data-mount="demo"[^>]*>[\s\S]*?<\/div>\s*(?=<ul class="tips">)/);
  assert.ok(mount, 'data-mount="demo"');
  assert.match(mount[0], /data-demo="[\w-]+"/, 'the plant it starts with');
  assert.match(mount[0], /<figure class="demo__still" data-demo-fallback>[\s\S]*<img [^>]*width="\d+" height="\d+"[^>]*alt="[^"]{25,}"/, 'the still picture, hidden by the script once the first frame is drawn');
  assert.match(mount[0], /<noscript>/, 'a note for visitors without JavaScript');
  assert.match(html, /<script type="module" src="js\/demo-boot\.js"><\/script>/);
});

test('weight: the critical path and the images stay inside their budgets', () => {
  const critical = [html, css, read('css/tokens.css')].reduce((n, s) => n + gzipSync(Buffer.from(s)).length, 0);
  assert.ok(critical <= 150 * 1024, `HTML + CSS gzip is ${critical} bytes, budget 153600`);
  const dir = path.join(root, 'how/img');
  const bytes = existsSync(dir) ? readdirSync(dir).reduce((n, f) => n + statSync(path.join(dir, f)).size, 0) : 0;
  assert.ok(bytes <= 2.5 * 1024 * 1024, `how/img is ${bytes} bytes, budget 2.5 MB`);
});

test('page.css answers dark, reduced motion, contrast, forced colours and print', () => {
  for (const q of ['prefers-color-scheme: dark', 'prefers-reduced-motion: reduce', 'prefers-reduced-motion: no-preference', 'prefers-contrast: more', 'forced-colors: active', 'print']) {
    assert.ok(css.includes(q), `@media (${q})`);
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
});

test('the site that is assembled contains the page', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'logiplan-how-'));
  try {
    assembleSite({ out, env: {}, now: new Date('2026-01-01T00:00:00Z') });
    for (const f of ['how/index.html', 'how/css/page.css', 'how/facts.json', 'css/tokens.css', 'assets/logo.svg', 'favicon.svg', 'index.html']) assert.ok(existsSync(path.join(out, f)), f);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
