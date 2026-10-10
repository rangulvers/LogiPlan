#!/usr/bin/env node
// Cut a new version of LogiPlan, or check that the places that name the version agree (docs/ARCHITECTURE.md 6.11, README "Versioning").
//
//   node scripts/bump-version.mjs patch|minor|major|x.y.z [--date YYYY-MM-DD] [--dry-run]
//       package.json "version", js/build-info.js `version` and CHANGELOG.md are updated together: what stands under "## [Unreleased]" moves under the new
//       heading "## [x.y.z] - date" (an empty one gets a stub that the changelog test refuses until it is written; text that is no "- " bullet is kept, with a
//       warning, never thrown away), and a fresh empty [Unreleased] stays on top. Nothing is written unless all three files can be updated.
//   node scripts/bump-version.mjs --check
//       exits 1 when package.json, js/build-info.js and the newest released entry of CHANGELOG.md name different versions, when that entry has no valid date,
//       or when js/build-info.js is not the development default. `npm run version:check` runs it.
//   --root DIR   work on another copy of these files (the tests use it)
//
// The commit and the build time are NOT kept in the repository: scripts/build-site.mjs writes them into the site it assembles (GITHUB_SHA, the clock).
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, compareVersions, latestRelease, parseChangelog, parseDay, parseVersion } from '../js/version.js';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What an unwritten release looks like in CHANGELOG.md; tests/version.changelog.test.js fails while it is there. */
export const STUB_LINE = '- TODO: say in plain words what planners can now do.';

const isHeading = (line) => /^##\s/.test(line);
/** Text a person wrote under [Unreleased]: anything that is not blank and not a bare "### Section" heading. */
const hasText = (line) => line.trim() !== '' && !/^###\s/.test(line);

/** The new text of CHANGELOG.md for the release `version` made on `date` ("2026-10-09"). */
export function bumpChangelog(text, version, date) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heading = `## [${version}] - ${date}`;
  const unreleased = lines.findIndex((l) => /^##\s+\[?unreleased\]?\s*$/i.test(l.trim()));
  if (unreleased < 0) {
    const first = lines.findIndex(isHeading);
    const block = ['## [Unreleased]', '', heading, '', '### Added', STUB_LINE, ''];
    if (first < 0) return `${lines.join('\n').replace(/\n*$/, '\n\n')}${block.join('\n')}`;
    lines.splice(first, 0, ...block);
    return lines.join('\n');
  }
  let end = lines.findIndex((l, i) => i > unreleased && isHeading(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(unreleased + 1, end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  // what a person wrote is moved as it is, even when it is no "- " bullet (prose, a numbered list): the app would not show it and run() warns, but it is not
  // thrown away; only an empty body (or bare section headings) gets the stub
  const content = body.some(hasText) ? body : ['### Added', STUB_LINE];
  lines.splice(unreleased, end - unreleased, '## [Unreleased]', '', heading, '', ...content, '');
  return lines.join('\n').replace(/\n*$/, '\n');
}

/** `version: '0.6.0'` of js/build-info.js, or null. */
export const readBuildInfoVersion = (text) => (/^\s*version:\s*'([^']*)'/m.exec(text) || [])[1] ?? null;

/** js/build-info.js with another version; throws when its version line is not in the form the scripts read (`version: '0.6.0',`). */
export function writeBuildInfoVersion(text, version) {
  if (readBuildInfoVersion(text) === null) throw new Error("js/build-info.js: the line `version: '...'` was not found (a formatter may have changed its quotes). Nothing was written.");
  const next = text.replace(/^(\s*version:\s*)'[^']*'/m, `$1'${version}'`);
  if (readBuildInfoVersion(next) !== version) throw new Error('js/build-info.js: could not set the version. Nothing was written.');
  return next;
}

/** package.json with another "version" (the rest of the text is kept as it is). */
export function writePackageVersion(text, version) {
  const next = text.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
  if (JSON.parse(next).version !== version) throw new Error('package.json: could not set the version.');
  return next;
}

/**
 * Do package.json, js/build-info.js and CHANGELOG.md agree?
 * @returns {{ problems: string[], version: string|null }}
 */
export function checkFiles({ pkgText, buildInfoText, changelogText }) {
  const problems = [];
  let pkgVersion = null;
  try {
    pkgVersion = JSON.parse(pkgText).version;
  } catch {
    problems.push('package.json is not valid JSON.');
  }
  if (pkgVersion !== null && !parseVersion(pkgVersion)) problems.push(`package.json: "${pkgVersion}" is not a version (x.y.z).`);
  const infoVersion = readBuildInfoVersion(buildInfoText);
  if (infoVersion === null) problems.push("js/build-info.js: no `version: '...'` line.");
  else if (infoVersion !== pkgVersion) problems.push(`js/build-info.js says ${infoVersion} but package.json says ${pkgVersion}: both must name the same version (node scripts/bump-version.mjs sets them together).`);
  if (!/^\s*commit:\s*'dev'/m.test(buildInfoText) || !/^\s*channel:\s*'dev'/m.test(buildInfoText)) problems.push("js/build-info.js must hold the development default (commit 'dev', channel 'dev'); scripts/build-site.mjs writes the real values into the site only.");
  const newest = latestRelease(parseChangelog(changelogText));
  if (!newest) problems.push('CHANGELOG.md has no released version.');
  else {
    if (newest.version !== pkgVersion) problems.push(`The newest released entry of CHANGELOG.md is ${newest.version}, package.json says ${pkgVersion}.`);
    if (!newest.date) problems.push(`CHANGELOG.md: [${newest.version}] has no valid date (## [x.y.z] - YYYY-MM-DD).`);
  }
  return { problems, version: pkgVersion };
}

function readFiles(root) {
  const read = (rel) => {
    const file = path.join(root, rel);
    if (!existsSync(file)) throw new Error(`${rel} not found in ${root}`);
    return readFileSync(file, 'utf8');
  };
  return { pkgText: read('package.json'), buildInfoText: read('js/build-info.js'), changelogText: read('CHANGELOG.md') };
}

function parseArgs(argv) {
  const opts = { root: HERE, check: false, dryRun: false, date: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--date' || arg === '--root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--date') opts.date = value;
      else opts.root = path.resolve(value);
    }
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (opts.target === null) opts.target = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  return opts;
}

const USAGE = 'Usage: node scripts/bump-version.mjs patch|minor|major|x.y.z [--date YYYY-MM-DD] [--dry-run]\n       node scripts/bump-version.mjs --check';

/** Run with the arguments `argv`; returns the exit code and what to print. */
export function run(argv, { now = new Date(), log = console.log, error = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    error(`✗ ${err.message}\n${USAGE}`);
    return 2;
  }
  let files;
  try {
    files = readFiles(opts.root);
  } catch (err) {
    error(`✗ ${err.message}`);
    return 2;
  }
  if (opts.check) {
    const { problems, version } = checkFiles(files);
    if (problems.length) {
      for (const p of problems) error(`✗ ${p}`);
      return 1;
    }
    log(`✓ version ${version}: package.json, js/build-info.js and CHANGELOG.md agree`);
    return 0;
  }
  if (!opts.target) { error(`✗ Say which version to make.\n${USAGE}`); return 2; }
  const current = JSON.parse(files.pkgText).version;
  const next = ['patch', 'minor', 'major'].includes(opts.target) ? bumpVersion(current, opts.target) : opts.target;
  if (!next || !parseVersion(next) || !/^\S+$/.test(next) || /^v/.test(next) || /\+/.test(next)) { error(`✗ "${opts.target}" is not patch, minor, major or a version like 1.2.3.\n${USAGE}`); return 2; }
  if (compareVersions(next, current) <= 0) { error(`✗ ${next} is not newer than the current version ${current}.`); return 2; }
  const date = opts.date ?? now.toISOString().slice(0, 10);
  if (!parseDay(date)) { error(`✗ "${date}" is not a date (YYYY-MM-DD).`); return 2; }
  // all three texts are made BEFORE anything is written, so a file that cannot be updated leaves the others alone
  let out;
  try {
    out = {
      'package.json': writePackageVersion(files.pkgText, next),
      'js/build-info.js': writeBuildInfoVersion(files.buildInfoText, next),
      'CHANGELOG.md': bumpChangelog(files.changelogText, next, date),
    };
  } catch (err) {
    error(`✗ ${err.message}`);
    return 2;
  }
  if (!opts.dryRun) for (const [rel, text] of Object.entries(out)) writeFileSync(path.join(opts.root, rel), text);
  log(`${opts.dryRun ? 'Would make' : 'Made'} version ${next} (was ${current}), dated ${date}: package.json, js/build-info.js, CHANGELOG.md.`);
  const entry = parseChangelog(out['CHANGELOG.md']).find((e) => e.version === next);
  if (!entry || !entry.sections.length) {
    log(`\n! CHANGELOG.md: [${next}] has no "- " bullets, and the app shows nothing else (a numbered list, prose or a different bullet sign). What was there is kept; turn it into "- " lines.`);
  }
  log([
    '',
    'Next:',
    `  1. Read the [${next}] section of CHANGELOG.md and write it for planners (what they can now do, in plain words); the TODO line must go.`,
    '  2. npm run version:check, and the fast tests (npm run test:fast).',
    `  3. Commit ("Release ${next}"), open the pull request, merge to main. The Pages workflow publishes it; the version.json of the site then names the new commit.`,
    `  4. Optional: git tag v${next} on the merge commit.`,
  ].join('\n'));
  return 0;
}

/** Was this file started by node (not imported)? Compares the real paths: a checkout reached through a symlink has two spellings. */
function startedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) process.exitCode = run(process.argv.slice(2));
