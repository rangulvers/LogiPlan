#!/usr/bin/env node
// Assemble the deployable static site into ./_site (what GitHub Pages serves).
// The app needs no bundling: we copy index.html, css/, js/, assets/ and CHANGELOG.md, add .nojekyll and the identity of this build.
//
//   node scripts/build-site.mjs [outdir]      outdir is relative to the repository (default _site) or absolute; it is emptied first
//
// The identity of a build (docs/ARCHITECTURE.md 6.11) is written twice, both times into the OUTPUT only, never into the repository:
//   js/build-info.js  what the running app IS: { version, commit, shortCommit, builtAt, channel, repository }, imported by the app (version chip, About
//                     dialog, report footer). The file of the repository holds the development values (commit 'dev'); this one the real ones.
//   version.json      what the site serves NOW: the same fields plus the old ones (name, builtFrom); a running page fetches it to learn that a newer build
//                     is live (js/update-check.js). `commit` stays what it always was: GITHUB_SHA, or 'local' without it.
// Environment: GITHUB_SHA (the commit; without it the build is a 'local' one), GITHUB_REF_NAME, GITHUB_REPOSITORY and GITHUB_SERVER_URL (set by Actions),
// SOURCE_DATE_EPOCH (whole seconds; fixes the build time, for reproducible builds and tests; anything else, or a year outside 2000-2199, is ignored).
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCommitId, normalizeRepositoryUrl, parseVersion, shortCommit } from '../js/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The identity of the build that is made from `pkg` (the parsed package.json) in `env`.
 * @returns {{ version: string, commit: string, shortCommit: string, builtAt: string, channel: 'live'|'local', repository: string|null, builtFrom: string, name: string }}
 */
export function buildIdentity({ pkg, env = process.env, now = new Date() }) {
  if (!pkg || !parseVersion(pkg.version)) throw new Error(`package.json has no valid "version" (found ${JSON.stringify(pkg && pkg.version)}). Use x.y.z.`);
  const sha = typeof env.GITHUB_SHA === 'string' && isCommitId(env.GITHUB_SHA.trim()) ? env.GITHUB_SHA.trim().toLowerCase() : null;
  // like an invalid GITHUB_SHA, an invalid SOURCE_DATE_EPOCH is ignored (the clock is used): ' ' would mean 1970, '1e20' would crash, '0x10' would be 16 seconds
  const given = typeof env.SOURCE_DATE_EPOCH === 'string' ? env.SOURCE_DATE_EPOCH.trim() : '';
  const fixed = /^\d{1,11}$/.test(given) ? new Date(Number(given) * 1000) : null;
  const when = fixed && fixed.getUTCFullYear() >= 2000 && fixed.getUTCFullYear() < 2200 ? fixed : now;
  const server = typeof env.GITHUB_SERVER_URL === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(env.GITHUB_SERVER_URL) ? env.GITHUB_SERVER_URL : 'https://github.com';
  const fromEnv = typeof env.GITHUB_REPOSITORY === 'string' && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY) ? normalizeRepositoryUrl(`${server}/${env.GITHUB_REPOSITORY}`) : null;
  const ref = typeof env.GITHUB_REF_NAME === 'string' && env.GITHUB_REF_NAME.trim() ? env.GITHUB_REF_NAME.trim().replace(/[^\x20-\x7e]/g, '').slice(0, 120) : 'local';
  return {
    name: pkg.name,
    version: pkg.version.trim(),
    commit: sha || 'local',
    shortCommit: sha ? shortCommit(sha) : 'local',
    builtAt: when.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    channel: sha ? 'live' : 'local',
    repository: fromEnv || normalizeRepositoryUrl(pkg.repository),
    builtFrom: ref,
  };
}

/** The text of js/build-info.js for this identity. Every value goes through JSON.stringify, so nothing from the environment can become code. */
export function renderBuildInfo(id) {
  const q = (v) => JSON.stringify(v);
  return `// Written by scripts/build-site.mjs: the identity of THIS build (the file in the repository holds the development values).
export const BUILD = Object.freeze({
  version: ${q(id.version)},
  commit: ${q(id.commit)},
  shortCommit: ${q(id.shortCommit)},
  builtAt: ${q(id.builtAt)},
  channel: ${q(id.channel)},
  repository: ${q(id.repository)},
});
`;
}

/** The contents of version.json: the identity plus the fields it always had. */
export function renderVersionJson(id) {
  const { name, version, commit, shortCommit: short, builtAt, channel, builtFrom } = id;
  return `${JSON.stringify({ name, version, commit, shortCommit: short, builtAt, channel, builtFrom }, null, 2)}\n`;
}

const isDown = (rel) => rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);

/**
 * Is it safe to empty `out`? Never the repository itself, a folder that holds it, or the root of the file system; and inside the repository only the folders
 * that git ignores (_site, _site-ci ...): `node scripts/build-site.mjs docs` would delete the design documents, `.git` the history.
 */
export function assertSafeOutput(out, repoRoot = root) {
  const up = path.relative(out, repoRoot); // from the output to the repository
  if (out === path.parse(out).root || up === '' || isDown(up)) {
    throw new Error(`Refusing to empty ${out}: it is, or contains, the repository.`);
  }
  const down = path.relative(repoRoot, out); // from the repository to the output
  if (isDown(down) && !/^_site[\w.-]*$/.test(down.split(path.sep)[0])) {
    throw new Error(`Refusing to empty ${out}: it is a folder of the repository. Use a folder outside it, or one named _site (git ignores those).`);
  }
}

/** Make the site in `out`. Returns the identity that was written. */
export function assembleSite({ out, env = process.env, now = new Date() }) {
  assertSafeOutput(out);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const id = buildIdentity({ pkg, env, now });

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const required = ['index.html', 'css', 'js'];
  const optional = ['assets', 'favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'CHANGELOG.md'];
  for (const name of required) {
    if (!existsSync(path.join(root, name))) throw new Error(`missing required ${name}`);
    cpSync(path.join(root, name), path.join(out, name), { recursive: true });
  }
  for (const name of optional) {
    if (existsSync(path.join(root, name))) cpSync(path.join(root, name), path.join(out, name), { recursive: true });
  }
  writeFileSync(path.join(out, '.nojekyll'), '');
  writeFileSync(path.join(out, 'js', 'build-info.js'), renderBuildInfo(id));
  writeFileSync(path.join(out, 'version.json'), renderVersionJson(id));
  return id;
}

/** Was this file started by node (not imported)? Compares the real paths: a checkout reached through a symlink has two spellings. */
function startedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  try {
    const out = path.resolve(root, process.argv[2] || '_site');
    const id = assembleSite({ out });
    const shown = path.relative(root, out);
    console.log(`✓ site assembled in ${shown.startsWith('..') ? out : shown}/`, id);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
