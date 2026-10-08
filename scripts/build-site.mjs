#!/usr/bin/env node
// Assemble the deployable static site into ./_site (what GitHub Pages serves).
// The app needs no bundling: we copy index.html, css/, js/ and assets/, add .nojekyll and a version stamp.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, process.argv[2] || '_site');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const required = ['index.html', 'css', 'js'];
const optional = ['assets', 'favicon.svg', 'favicon.ico', 'manifest.webmanifest'];
for (const name of required) {
  if (!existsSync(path.join(root, name))) { console.error(`✗ missing required ${name}`); process.exit(1); }
  cpSync(path.join(root, name), path.join(out, name), { recursive: true });
}
for (const name of optional) {
  if (existsSync(path.join(root, name))) cpSync(path.join(root, name), path.join(out, name), { recursive: true });
}
writeFileSync(path.join(out, '.nojekyll'), '');

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const stamp = { name: pkg.name, version: pkg.version, commit: process.env.GITHUB_SHA || 'local', builtFrom: process.env.GITHUB_REF_NAME || 'local' };
writeFileSync(path.join(out, 'version.json'), JSON.stringify(stamp, null, 2) + '\n');
console.log(`✓ site assembled in ${path.relative(root, out)}/`, stamp);
