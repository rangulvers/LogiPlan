#!/usr/bin/env node
// Static sanity check for the no-build app: every relative import in index.html and js/**
// must resolve to an existing file, and every named import must be exported by its target.
// Catches typos and API drift between independently written modules before the browser does.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'js'));

const exportsOf = new Map();
function getExports(file) {
  if (exportsOf.has(file)) return exportsOf.get(file);
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  let star = false;
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      const asName = t.split(/\s+as\s+/).pop().trim();
      names.add(asName);
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  for (const m of src.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (existsSync(target)) for (const n of getExports(target)) names.add(n);
    star = true;
  }
  const res = { names, star };
  exportsOf.set(file, res);
  return res;
}

let errors = 0;
const fail = (msg) => { console.error('✗ ' + msg); errors++; };

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  for (const m of src.matchAll(/import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) { if (!spec.startsWith('node:')) fail(`${rel}: bare/external import "${spec}" is not allowed (no build step)`); continue; }
    const target = path.resolve(path.dirname(file), spec);
    if (!existsSync(target)) { fail(`${rel}: cannot resolve "${spec}"`); continue; }
    const clause = m[1];
    if (!clause) continue;
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      const { names } = getExports(target);
      for (const part of named[1].split(',')) {
        const imp = part.trim().split(/\s+as\s+/)[0].trim();
        if (imp && !names.has(imp)) fail(`${rel}: "${imp}" is not exported by ${spec}`);
      }
    }
  }
}

const html = path.join(root, 'index.html');
if (existsSync(html)) {
  const src = readFileSync(html, 'utf8');
  for (const m of src.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const ref = m[1];
    if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
    if (ref.startsWith('/')) fail(`index.html: absolute path "${ref}" breaks GitHub Pages project sites; use a relative path`);
    else if (!existsSync(path.resolve(root, ref.split('?')[0]))) fail(`index.html: missing file "${ref}"`);
  }
}

if (errors) { console.error(`\n${errors} problem(s) found.`); process.exit(1); }
console.log(`✓ ${files.length} modules checked, all relative imports and named imports resolve.`);
