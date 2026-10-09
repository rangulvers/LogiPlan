// Helpers of tests/version.review.test.js: the adversarial review of the version display (js/version.js, js/build-info.js, js/update-check.js,
// js/ui/about.js, scripts/build-site.mjs, scripts/bump-version.mjs, CHANGELOG.md), angle ROBUSTNESS, SECURITY and BUILD PIPELINE.
//
//   * hostile inputs: a version.json / CHANGELOG.md full of markup, prototype keys, junk types, control characters, huge strings; seeded random
//     generators for both (mulberry32, so a failure can be replayed with the seed in its message)
//   * a FAKE DOM (installFakeDom): just enough of document / Node / window / navigator / location for js/util/dom.js `h()`, js/ui/icons.js, js/ui/about.js
//     to run in Node. It records every innerHTML write, so a test can prove that nothing fetched was ever parsed as markup
//   * build pipeline plumbing: spawn a script with a clean environment, a temporary copy of the repository, hash a directory tree
//   * stripComments: the code of a source file without its comments, for "grep the source" checks
//
// Nothing here is imported by production code.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Known defects are `todo` tests (they fail, the suite stays green); VER_REVIEW_STRICT=1 makes them ordinary tests. */
export const STRICT = process.env.VER_REVIEW_STRICT === '1';
/** The real-browser section is opt-in (it needs Playwright and takes about a minute): VER_REVIEW_BROWSER=1. */
export const BROWSER = process.env.VER_REVIEW_BROWSER === '1';

export const SHA_A = 'a45ce493dfd9ca7440743e6931042fca39642504';
export const SHA_B = 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6';
export const REPO_URL = 'https://github.com/rangulvers/LogiPlan';
/** The identity of a deployed build, and of a development copy, as js/build-info.js holds them. */
export const LIVE = Object.freeze({ version: '0.6.0', commit: SHA_A, shortCommit: 'a45ce49', builtAt: '2026-10-09T15:08:00Z', channel: 'live', repository: REPO_URL });
export const DEV = Object.freeze({ version: '0.6.0', commit: 'dev', shortCommit: 'dev', builtAt: null, channel: 'dev', repository: REPO_URL });

export const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

// ---------------------------------------------------------------------------------------------------------
// Random numbers and generators
// ---------------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator, `rng()` in [0, 1). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (rng, list) => list[Math.floor(rng() * list.length)];
export const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** Strings that must NEVER end up as markup, an attribute or an address when they come from a fetched file. */
export const HOSTILE_STRINGS = Object.freeze([
  '<img src=x onerror=window.__pwned=1>', '<script>window.__pwned=2</script>', '</div><iframe src="javascript:window.__pwned=3"></iframe>', '"><svg onload=window.__pwned=4>',
  '[click](javascript:window.__pwned=5)', '<a href="javascript:window.__pwned=6">z</a>', '![i](data:text/html,<script>1</script>)', '&lt;b&gt;&amp;', '‮<b>rtl</b>', '\u0000\u0007\u001b[31m',
]);

/** A CHANGELOG.md in which every place that can hold text holds a hostile string (CRLF line ends and a BOM, as an editor on Windows writes them). */
export function hostileChangelog({ eol = '\r\n', bom = true } = {}) {
  const lines = ['# Changelog', '', '## [Unreleased]'];
  HOSTILE_STRINGS.forEach((s, i) => { lines.push(`### ${s}`, `- item ${i} ${s} **${s}** *${s}* \`${s}\``, `  continued ${s}`); });
  lines.push('', '## [1.0.0] - 2026-01-01', '### Added', ...HOSTILE_STRINGS.map((s) => `- ${s}`), '', '## [<img src=x onerror=window.__pwned=7>]', '- nope', '', '## [1.0.0-<script>] - 2026-01-01', '- nope too', '');
  return (bom ? '﻿' : '') + lines.join(eol);
}

const CHANGELOG_PIECES = [
  () => '## [Unreleased]', () => '## [Unreleased] - 2026-01-01', (r) => `## [${int(r, 0, 3)}.${int(r, 0, 12)}.${int(r, 0, 9)}] - 2026-${pick(r, ['01', '02', '10', '13', '00'])}-${pick(r, ['01', '09', '28', '30', '31', '32', '00'])}`,
  (r) => `## ${pick(r, ['v1.2.3', '[1.2.3]', '1.2', 'banana', '[v2.0.0-rc.1+build.5]', '[0.0.0]', '[999999999.0.0]', '[9999999999.0.0]', '1.2.3 notes', '[1.2.3]', '[1.2.3] - 2026-02-30'])}`,
  () => '## [1.0.0]', () => '##', () => '## ', () => '###', () => '### ', (r) => `### ${pick(r, ['Added', 'Improved', 'Fixed', 'Changed', 'x'.repeat(100), '<b>', '  spaced  ', 'äöü'])}`,
  (r) => `- ${pick(r, ['a plain item', '**bold** and *it* and `code`', '<script>1</script>', '[l](javascript:1)', '*', '**', '`', 'x'.repeat(900), ''])}`, (r) => `${pick(r, ['*', '+', '-'])} item`,
  () => '  continuation line', () => '    deeper continuation', () => '\tTab continuation', () => '', () => '', () => '   ', () => '---', () => '# Changelog', () => '<!-- comment -->', () => '> quote', () => '1. numbered',
  (r) => ' '.repeat(int(r, 1, 300)) + 'x', (r) => `- a${' '.repeat(int(r, 1, 300))}b`, (r) => ' '.repeat(int(r, 1, 50)) + '- nbsp', () => '__proto__', () => '- constructor', () => '- toString',
];

/** A random CHANGELOG.md made of structural pieces (headings of every shape, bullets, continuations, junk). */
export function randomChangelog(rng, { lines = int(rng, 0, 60), eol = pick(rng, ['\n', '\r\n']) } = {}) {
  const out = [];
  for (let i = 0; i < lines; i++) out.push(pick(rng, CHANGELOG_PIECES)(rng));
  return out.join(eol) + (rng() < 0.5 ? eol : '');
}

const JUNK_VALUES = [null, undefined, true, false, 0, -1, 1e999, NaN, '', ' ', 'x', [], [1], {}, { a: 1 }, 'v', '0', '1e999', '0.6.0-<script>', '\u0000', '__proto__', 'a'.repeat(5000)];

/** A random value of the shape of a version.json: a mix of valid fields, wrong types, strings with markup and control characters. */
export function randomRemote(rng) {
  const commits = [SHA_A, SHA_B, SHA_B.toUpperCase(), SHA_B.slice(0, 7), SHA_B.slice(0, 6), `${SHA_B}0`, 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80912', ' ' + SHA_B, `${SHA_B}\n`, 'dev', 'local', '<img>'];
  const versions = ['0.6.0', '0.6.1', '0.5.9', '0.7.0', 'v0.7.0', '1.0.0-rc.1', '0.7.0+build.5', ' 0.7.0 ', '0.07.0', '1e999', '0.6.0-<script>', '9'.repeat(20), '0.7', '0.7.0\n'];
  const out = {};
  for (const key of ['name', 'version', 'commit', 'shortCommit', 'builtAt', 'channel', 'builtFrom']) {
    if (rng() < 0.15) continue;
    out[key] = rng() < 0.2 ? pick(rng, JUNK_VALUES)
      : key === 'commit' ? pick(rng, commits) : key === 'version' ? pick(rng, versions)
        : key === 'builtAt' ? pick(rng, ['2026-10-10T08:00:00Z', '2026-02-30T08:00:00Z', 'soon', '2199-12-31T23:59:59Z', '1999-01-01T00:00:00Z', '2026-10-10T08:00:00+02:00'])
          : pick(rng, ['live', 'dev', 'main', '<b>', 'x'.repeat(100)]);
  }
  if (rng() < 0.1) out.__extra = JSON.parse('{"__proto__": {"commit": "polluted"}}');
  return rng() < 0.05 ? pick(rng, JUNK_VALUES) : out;
}

// ---------------------------------------------------------------------------------------------------------
// Source files
// ---------------------------------------------------------------------------------------------------------

/** The code of `src` without block comments and `//` comments (a `//` counts only at the start of a line or after whitespace, so "https://" stays). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

/**
 * `stripComments` plus the TEXT of string and template literals (the `${...}` expressions of a template stay): what is left is the code that can touch a
 * global. Line by line, so a stray quote (a regular expression that contains a backtick) can hide at most the rest of its own line.
 */
export function codeOnly(src) {
  return stripComments(src).split('\n').map((line) => line
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => `\`${[...m.matchAll(/\$\{([^}]*)\}/g)].map((x) => `\${${x[1]}}`).join('')}\``)).join('\n');
}

/** The relative module specifiers a file imports (static `import ... from '...'` and bare `import '...'`). */
export function importsOf(src) {
  return [...stripComments(src).matchAll(/(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** Every .js file under `dir` (absolute paths). */
export function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? jsFiles(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
}

// ---------------------------------------------------------------------------------------------------------
// Temporary directories, scripts, trees
// ---------------------------------------------------------------------------------------------------------

const made = [];
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
/** A fresh temporary directory, removed when the process ends. */
export function tmpDir(prefix = 'ver-review-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Run `node <args>` with a clean environment (PATH and HOME) plus `env`, so that the GITHUB_* variables of a CI run cannot leak in. */
export function runNode(args, { env = {}, cwd = ROOT, timeout = 60_000 } = {}) {
  return spawnSync(process.execPath, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8', cwd, timeout });
}

/** Every file under `dir`, relative and sorted. */
export function tree(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? tree(path.join(dir, d.name), base) : [path.relative(base, path.join(dir, d.name))])).sort();
}

/** One hash of the names and bytes of every file under `dir` (`skip`: relative paths to leave out). */
export function treeHash(dir, skip = []) {
  const h = createHash('sha256');
  for (const rel of tree(dir)) {
    if (skip.includes(rel)) continue;
    h.update(rel).update('\0').update(readFileSync(path.join(dir, rel))).update('\0');
  }
  return h.digest('hex');
}

/**
 * A scratch copy of the parts of the repository the site build reads (index.html, css, js, assets, scripts, package.json, CHANGELOG.md, favicon.svg), so that
 * a script that EMPTIES a directory can be run against something that does not matter. Also makes `.git/HEAD` and `docs/` so that the damage is visible.
 */
export function repoCopy(prefix = 'ver-repo-') {
  const dir = tmpDir(prefix);
  for (const name of ['index.html', 'css', 'js', 'assets', 'scripts', 'package.json', 'CHANGELOG.md', 'favicon.svg']) cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  mkdirSync(path.join(dir, '.git'));
  writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs', 'DESIGN.md'), 'the design documents\n');
  return dir;
}

/** Copy the three files `scripts/bump-version.mjs` works on into a fresh directory. */
export function miniRepo({ changelog = read('CHANGELOG.md'), pkg = read('package.json'), buildInfo = read('js/build-info.js') } = {}) {
  const dir = tmpDir('ver-mini-');
  mkdirSync(path.join(dir, 'js'));
  writeFileSync(path.join(dir, 'package.json'), pkg);
  writeFileSync(path.join(dir, 'js/build-info.js'), buildInfo);
  writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

/** The generated js/build-info.js of a site directory, really imported (a package.json next to it makes node read the .js as a module). */
export async function importSiteBuild(siteDir) {
  if (!existsSync(path.join(siteDir, 'package.json'))) writeFileSync(path.join(siteDir, 'package.json'), '{"type":"module"}\n');
  const url = `${new URL(`file://${path.join(siteDir, 'js/build-info.js')}`).href}?${Date.now()}${Math.random()}`;
  return (await import(url)).BUILD;
}

// ---------------------------------------------------------------------------------------------------------
// The fake DOM
// ---------------------------------------------------------------------------------------------------------

// The classes live at module level on purpose: js/ui/icons.js keeps a cache of parsed icons for the whole process, so the nodes it clones must stay
// instances of the same Node class however often the fake DOM is installed again.
const innerHtmlWrites = [];
const listenersOf = new WeakMap();

function walk(node, fn) {
  fn(node);
  for (const c of node.childNodes || []) walk(c, fn);
}

class FNode {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.documentElement; }
}
class FText extends FNode {
  constructor(data) { super(); this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
  cloneNode() { return new FText(this.data); }
}
class FElement extends FNode {
  constructor(tag, ns = null) {
    super();
    this.nodeType = 1;
    this.tagName = ns ? tag : tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.namespaceURI = ns;
    this.attrs = new Map();
    this.dataset = new Proxy({}, {
      set: (_, name, value) => { this.attrs.set(`data-${String(name).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value)); return true; },
      get: (_, name) => this.attrs.get(`data-${String(name).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
    });
    this.value = '';
    this.style = { setProperty: (k, v) => this.attrs.set(`style:${k}`, String(v)) };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get classList() {
    const el = this;
    const set = () => new Set(el.className.split(/\s+/).filter(Boolean));
    return {
      contains: (c) => set().has(c),
      add: (c) => el.setAttribute('class', [...set().add(c)].join(' ')),
      remove: (c) => { const s = set(); s.delete(c); el.setAttribute('class', [...s].join(' ')); },
      toggle: (c, force) => { const s = set(); const on = force === undefined ? !s.has(c) : Boolean(force); if (on) s.add(c); else s.delete(c); el.setAttribute('class', [...s].join(' ')); return on; },
    };
  }
  append(...kids) { for (const k of kids) this.appendChild(k instanceof FNode ? k : new FText(k)); }
  replaceChildren(...kids) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...kids); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(new FText(v)); }
  get innerText() { return this.textContent; }
  get innerHTML() { throw new Error('innerHTML was READ'); }
  set innerHTML(v) {
    innerHtmlWrites.push({ tag: this.localName, value: String(v) });
    // the only legitimate writer is the icon cache of js/ui/icons.js: a <template> whose content is one of our own <svg> strings
    if (this.localName === 'template') this.content = { firstElementChild: new FElement('svg', 'http://www.w3.org/2000/svg') };
    else throw new Error(`innerHTML written on <${this.localName}>`);
  }
  set outerHTML(v) { throw new Error('outerHTML was written'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML was called'); }
  addEventListener(type, fn) { const m = listenersOf.get(this) || new Map(); m.set(type, [...(m.get(type) || []), fn]); listenersOf.set(this, m); }
  removeEventListener() {}
  /** Run the listeners of `type` and wait for the async ones. Returns whatever the first listener returned. */
  async fire(type, event = {}) { const out = []; for (const fn of (listenersOf.get(this) || new Map()).get(type) || []) out.push(await fn({ type, target: this, ...event })); return out[0]; }
  click() { return this.fire('click'); }
  cloneNode(deep) {
    const c = new FElement(this.localName, this.namespaceURI);
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    if (deep) for (const kid of this.childNodes) c.appendChild(kid.cloneNode(true));
    return c;
  }
  focus() { doc.activeElement = this; }
  select() {}
  matches(sel) {
    return sel.split(',').some((part) => {
      const s = part.trim();
      let m;
      if ((m = /^\.([\w-]+)$/.exec(s))) return this.classList.contains(m[1]);
      if ((m = /^\[([\w-]+)="([^"]*)"\]$/.exec(s))) return this.getAttribute(m[1]) === m[2];
      if ((m = /^\[([\w-]+)\]$/.exec(s))) return this.hasAttribute(m[1]);
      if ((m = /^#([\w-]+)$/.exec(s))) return this.id === m[1];
      return this.localName === s.toLowerCase();
    });
  }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; walk(this, (n) => { if (n !== this && n.nodeType === 1 && n.matches(sel)) out.push(n); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

const doc = {
  nodeType: 9,
  activeElement: null,
  createElement: (tag) => new FElement(tag),
  createElementNS: (ns, tag) => new FElement(tag, ns),
  createTextNode: (text) => new FText(text),
  createRange: () => ({ selectNodeContents(node) { this.node = node; } }),
  getElementById: (id) => { let found = null; walk(doc.documentElement, (n) => { if (!found && n.nodeType === 1 && n.id === id) found = n; }); return found; },
  querySelector: (sel) => doc.documentElement.querySelector(sel),
  querySelectorAll: (sel) => doc.documentElement.querySelectorAll(sel),
  execCommand: () => false,
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
  hidden: false,
};
doc.documentElement = new FElement('html');
doc.head = new FElement('head');
doc.body = new FElement('body');
doc.documentElement.append(doc.head, doc.body);

/**
 * Install the fake DOM on globalThis (document, Node, window, navigator, location, screen) and return the handle to inspect it and to restore the globals.
 * Enough for h() of js/util/dom.js, icon() of js/ui/icons.js, addStyles, createVersionChip, openAbout, renderChangelog and copyText. Every innerHTML write is
 * recorded in `innerHtmlWrites`; reading innerHTML or setting outerHTML / insertAdjacentHTML throws, so a code path that parses markup fails loudly.
 * Each call starts from an empty page.
 * @param {{ host?: string, hostname?: string, clipboard?: object|null, execCommand?: Function, userAgent?: string }} [opts]
 */
export function installFakeDom({ host = 'logiplan.test', hostname = host.replace(/:\d+$/, ''), clipboard = null, execCommand = () => false, userAgent = 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36' } = {}) {
  innerHtmlWrites.length = 0;
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.activeElement = doc.body;
  doc.execCommand = (...args) => execCommand(...args);
  const selection = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(r) { this.ranges.push(r); } };
  const location = { host, hostname, reloads: 0, reload() { this.reloads++; } };
  const globals = {
    document: doc, Node: FNode, window: { innerWidth: 1440, innerHeight: 900, getSelection: () => selection }, screen: { width: 1920, height: 1080 }, location,
    navigator: { userAgent, clipboard },
  };
  const saved = new Map();
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name) || null);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
  }
  return {
    document: doc,
    selection,
    location,
    innerHtmlWrites,
    FElement,
    FText,
    walk,
    /** Every node below `node` (and `node`), as a list. */
    all(node) { const out = []; walk(node, (n) => out.push(n)); return out; },
    elements(node) { const out = []; walk(node, (n) => { if (n.nodeType === 1) out.push(n); }); return out; },
    textNodes(node) { const out = []; walk(node, (n) => { if (n.nodeType === 3) out.push(n.data); }); return out; },
    restore() {
      for (const [name, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name];
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The real browser (opt-in: VER_REVIEW_BROWSER=1)
// ---------------------------------------------------------------------------------------------------------

/**
 * Serve the site as scripts/build-site.mjs assembles it (a fake GITHUB_SHA, so the build is 'live') to headless Chromium on 127.0.0.1 and attack it from the
 * network side: a version.json that never answers, answers 404 / 500 / junk / HTML / a huge body / a connection reset / a hostile version, a CHANGELOG.md full of
 * markup, a slow one, a big one. For each: the app still starts, there is no page error, nothing from the files runs (`window.__pwned` stays unset), the chip
 * shows what it should. Returns { problems, notes }: `problems` are failures; `notes` are the places where a known defect (VER-REV-3, VER-REV-4) shows.
 * @returns {Promise<{ problems: string[], notes: string[], log: object[] }>}
 */
export async function runBrowserChecks() {
  const http = await import('node:http');
  const { chromium } = await import('playwright');
  const { assembleSite } = await import('../../scripts/build-site.mjs');
  const dir = tmpDir('ver-browser-');
  const siteDir = path.join(dir, 'site');
  assembleSite({ out: siteDir, env: { GITHUB_SHA: SHA_A, GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: 'rangulvers/LogiPlan', SOURCE_DATE_EPOCH: '1791558480' } });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
    try {
      const file = path.resolve(siteDir, `.${rel}`);
      if (!file.startsWith(siteDir + path.sep)) throw new Error('outside');
      res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const problems = [];
  const notes = [];
  const log = [];
  const NEWER = SHA_B;

  async function scenario(name, setup, check, { expectFailedRequest = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/Berlin', locale: 'en-GB' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on('console', (m) => {
      if (!['error', 'warning'].includes(m.type())) return;
      if (expectFailedRequest && /Failed to load resource/.test(m.text())) return;
      errors.push(`[console.${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await setup(page);
    const t0 = Date.now();
    try {
      await page.goto(`${origin}/index.html`);
      await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
      const readyMs = Date.now() - t0;
      await page.locator('[role=dialog]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
      const out = await check(page);
      log.push({ name, readyMs, out });
      if (errors.length) problems.push(`${name}: ${errors.join(' | ')}`);
      if (readyMs > 20_000) problems.push(`${name}: the app needed ${readyMs} ms to start`);
      if (out && out.pwned) problems.push(`${name}: something from a fetched file RAN (window.__pwned = ${out.pwned})`);
      return out;
    } catch (err) {
      problems.push(`${name}: ${err.message.split('\n')[0]}`);
      return null;
    } finally {
      await context.close();
    }
  }
  const chip = (page) => page.evaluate(() => ({ text: document.querySelector('.versionchip')?.innerText.trim(), update: document.querySelector('.versionchip')?.classList.contains('is-update') === true, pwned: window.__pwned ?? null }));
  const facts = async (page) => {
    await page.locator('.versionchip').click();
    await page.locator('[role=dialog]').waitFor();
    return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[role=dialog] dl.kv dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])));
  };

  try {
    // 127.0.0.1:PORT is not the live site (VER-REV-4)
    const where = await scenario('live build on 127.0.0.1', async () => {}, async (page) => (await facts(page))['Where it runs']);
    if (where && /^Live site/.test(where)) (STRICT ? problems : notes).push(`VER-REV-4: a deployed build on ${origin} says "${where}"`);

    // a version.json that never answers: the app starts, the chip is plain, the dialog opens
    await scenario('version.json never answers', async (page) => { await page.route('**/version.json*', () => {}); }, async (page) => {
      await page.waitForTimeout(3500);
      const state = await chip(page);
      if (state.update || state.text !== 'v0.6.0') problems.push(`never answers: chip ${JSON.stringify(state)}`);
      const f = await facts(page);
      if (f.Version !== '0.6.0') problems.push(`never answers: dialog ${JSON.stringify(f)}`);
      return state;
    });

    const answers = {
      '404': [(r) => r.fulfill({ status: 404, body: 'nf' }), false, true],
      '500': [(r) => r.fulfill({ status: 500, body: 'oops' }), false, true],
      'connection reset': [(r) => r.abort('connectionreset'), false, true],
      'HTML with a script': [(r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><script>window.__pwned=1</script></html>' }), false],
      'truncated JSON': [(r) => r.fulfill({ status: 200, body: '{' }), false],
      'JSON null': [(r) => r.fulfill({ status: 200, body: 'null' }), false],
      'an array': [(r) => r.fulfill({ status: 200, body: JSON.stringify([{ commit: NEWER, version: '9.9.9' }]) }), false],
      'a 25,000 character body': [(r) => r.fulfill({ status: 200, body: JSON.stringify({ commit: NEWER, version: '9.9.9', pad: 'x'.repeat(25_000) }) }), false],
      'a 10 MB body': [(r) => r.fulfill({ status: 200, body: JSON.stringify({ commit: NEWER, version: '9.9.9', pad: 'x'.repeat(10_000_000) }) }), false],
      'a hostile version': [(r) => r.fulfill({ status: 200, body: JSON.stringify({ commit: NEWER, version: '0.6.0-<img src=x onerror=window.__pwned=1>' }) }), false],
      'a hostile shortCommit and name': [(r) => r.fulfill({ status: 200, body: JSON.stringify({ commit: SHA_A, version: '0.6.0', shortCommit: '<img src=x onerror=window.__pwned=2>', name: '<script>window.__pwned=3</script>' }) }), false],
      'the same commit': [(r) => r.fulfill({ status: 200, body: JSON.stringify({ commit: SHA_A, version: '0.6.0' }) }), false],
      'a lower version': [(r) => r.fulfill({ status: 200, body: JSON.stringify({ commit: NEWER, version: '0.5.0' }) }), false],
      'a newer build': [(r) => r.fulfill({ status: 200, body: JSON.stringify({ name: 'logiplan', version: '0.7.0', commit: NEWER, builtAt: '2026-10-10T08:00:00Z' }) }), true],
    };
    for (const [label, [handler, expectUpdate, failed]] of Object.entries(answers)) {
      await scenario(`version.json: ${label}`, async (page) => { await page.route('**/version.json*', handler); }, async (page) => {
        await page.waitForTimeout(2600); // the first check comes 1.5 s after start
        const state = await chip(page);
        if (state.update !== expectUpdate) problems.push(`version.json ${label}: the chip says update=${state.update}, expected ${expectUpdate}`);
        return state;
      }, { expectFailedRequest: Boolean(failed) });
    }
    // the same version from an older build (VER-REV-3)
    await scenario('version.json: same version, older build', async (page) => {
      await page.route('**/version.json*', (r) => r.fulfill({ status: 200, body: JSON.stringify({ name: 'logiplan', version: '0.6.0', commit: NEWER, builtAt: '2026-09-01T08:00:00Z' }) }));
    }, async (page) => {
      await page.waitForTimeout(2600);
      const state = await chip(page);
      if (state.update) (STRICT ? problems : notes).push('VER-REV-3: the site serves an OLDER build of the same version and the chip says "Update"');
      return state;
    });

    // a hostile CHANGELOG.md: shown as text, nothing runs
    const hostile = hostileChangelog();
    await scenario('hostile CHANGELOG.md', async (page) => { await page.route('**/CHANGELOG.md', (r) => r.fulfill({ status: 200, contentType: 'text/markdown', body: hostile })); }, async (page) => {
      await page.locator('.versionchip').click();
      await page.locator('[role=dialog]').waitFor();
      await page.locator('[data-role=about-news] .about__entry').first().waitFor();
      await page.waitForTimeout(300);
      const seen = await page.evaluate(() => {
        const news = document.querySelector('[data-role=about-news]');
        return {
          pwned: window.__pwned ?? null,
          tags: [...new Set([...news.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()))].sort(),
          attrs: [...new Set([...news.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)))].sort(),
          text: news.innerText,
        };
      });
      const extra = seen.tags.filter((t) => !['button', 'code', 'div', 'em', 'h4', 'li', 'path', 'span', 'strong', 'svg', 'ul'].includes(t));
      if (extra.length) problems.push(`hostile CHANGELOG.md: unexpected elements ${extra.join(', ')}`);
      const bad = seen.attrs.filter((a) => /^on|^href$|^src$|^srcdoc$|^style$/.test(a));
      if (bad.length) problems.push(`hostile CHANGELOG.md: unexpected attributes ${bad.join(', ')}`);
      if (!seen.text.toLowerCase().includes('<script>window.__pwned=2</script>')) problems.push('hostile CHANGELOG.md: the script text is not shown as text');
      return seen;
    });

    // the dialog is closed before a slow CHANGELOG.md arrives: no error
    await scenario('slow CHANGELOG.md, dialog closed before it arrives', async (page) => {
      await page.route('**/CHANGELOG.md', async (r) => { await new Promise((resolve) => setTimeout(resolve, 2500)); r.fulfill({ status: 200, body: hostile }); });
    }, async (page) => {
      await page.locator('.versionchip').click();
      await page.locator('[role=dialog]').waitFor();
      const loading = await page.locator('[data-role=about-news]').innerText();
      if (!/Loading/.test(loading)) problems.push(`slow changelog: expected "Loading", saw ${JSON.stringify(loading)}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(3200);
      return { loading, pwned: await page.evaluate(() => window.__pwned ?? null) };
    });

    // a big changelog that stays inside the caps: the dialog opens in well under two seconds
    const lines = ['# Changelog'];
    for (let i = 0; i < 300; i++) { lines.push(`## [${300 - i}.0.0] - 2026-01-01`, '### Added'); for (let j = 0; j < 100; j++) lines.push(`- item **${j}** of entry ${i} with \`code\` and *text* to fill`); }
    const big = lines.join('\n');
    await scenario('big CHANGELOG.md (1.7 MB, capped at 400,000 characters)', async (page) => { await page.route('**/CHANGELOG.md', (r) => r.fulfill({ status: 200, body: big })); }, async (page) => {
      const t = Date.now();
      await page.locator('.versionchip').click();
      await page.locator('[role=dialog]').waitFor();
      await page.locator('[data-role=about-news] .about__entry').first().waitFor();
      const took = Date.now() - t;
      if (took > 3000) problems.push(`a big changelog needed ${took} ms to open`);
      return { took, pwned: null };
    });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  return { problems, notes, log };
}


/**
 * GitHub Pages sends `cache-control: max-age=600` for every file. Serve two builds of the same version (commits A and B) with those headers, open A, let the
 * site switch to B, wait for the "Update" mark, click "Reload now" and look at the chip again. With the modules of A still fresh in the HTTP cache the page
 * that comes back is A again and the mark is still there. Returns { before, after } (the chip's text and mark).
 */
export async function runReloadCacheScenario() {
  const http = await import('node:http');
  const { chromium } = await import('playwright');
  const { assembleSite } = await import('../../scripts/build-site.mjs');
  const dir = tmpDir('ver-cache-');
  const env = { GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: 'rangulvers/LogiPlan', SOURCE_DATE_EPOCH: '1791558480' };
  assembleSite({ out: path.join(dir, 'a'), env: { ...env, GITHUB_SHA: SHA_A } });
  assembleSite({ out: path.join(dir, 'b'), env: { ...env, GITHUB_SHA: SHA_B, SOURCE_DATE_EPOCH: '1791600000' } });
  let current = 'a';
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
    try {
      const root = path.join(dir, current);
      const file = path.resolve(root, `.${rel}`);
      if (!file.startsWith(root + path.sep)) throw new Error('outside');
      res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'public, max-age=600' }).end(readFileSync(file));
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const state = () => page.evaluate(() => ({ text: document.querySelector('.versionchip')?.innerText.replace(/\s+/g, ' ').trim(), update: document.querySelector('.versionchip')?.classList.contains('is-update') === true }));
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await page.locator('[role=dialog]').waitFor();
    await page.keyboard.press('Escape');
    current = 'b'; // the deploy happens while the page is open (the first check comes 1.5 s after start)
    await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'), null, { timeout: 15_000 });
    const before = await state();
    await page.locator('.versionchip').click();
    await page.locator('[role=dialog]').waitFor();
    await Promise.all([page.waitForNavigation(), page.locator('[role=dialog] button', { hasText: 'Reload now' }).click()]);
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await page.waitForTimeout(3000); // the first check of the new page
    const after = await state();
    const commit = await page.evaluate(async () => (await import('./js/build-info.js')).BUILD.commit);
    return { before, after, runningCommit: commit };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
