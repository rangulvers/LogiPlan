// The identity of a build: scripts/build-site.mjs (writes js/build-info.js and version.json into the SITE, never into the repository) and
// scripts/bump-version.mjs (cuts a version, checks that package.json, js/build-info.js and CHANGELOG.md agree). The site is built into a temp directory
// with a fake GITHUB_SHA; the bump script works on a temp copy of the three files (--root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUILD } from '../js/build-info.js';
import { normalizeRepositoryUrl, updateVerdict, parseChangelog, latestRelease } from '../js/version.js';
import { buildIdentity, renderBuildInfo, renderVersionJson, assertSafeOutput } from '../scripts/build-site.mjs';
import { bumpChangelog, checkFiles, run as bump, STUB_LINE } from '../scripts/bump-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const pkg = JSON.parse(read('package.json'));
const SHA = 'a45ce493dfd9ca7440743e6931042fca39642504';
const tmp = mkdtempSync(path.join(tmpdir(), 'logiplan-version-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

/** Every file under `dir`, relative, sorted. */
function files(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name), base) : [path.relative(base, path.join(dir, d.name))])).sort();
}

/** Run scripts/build-site.mjs as the pipeline does: its own process, a clean environment plus `env`. */
function buildSite(out, env = {}) {
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME };
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-site.mjs'), out], { env: { ...clean, ...env }, encoding: 'utf8', cwd: ROOT });
}

/** The BUILD of a generated js/build-info.js, really imported (a package.json next to it makes node read the .js as a module). */
async function importBuild(siteDir) {
  writeFileSync(path.join(siteDir, 'package.json'), '{"type":"module"}\n');
  return (await import(pathToFileURL(path.join(siteDir, 'js/build-info.js')).href)).BUILD;
}

// ---- the repository's own build-info.js --------------------------------------------------------------------------------

test('js/build-info.js in the repository is the development default, in step with package.json', () => {
  assert.equal(BUILD.version, pkg.version, 'run: node scripts/bump-version.mjs --check');
  assert.equal(BUILD.commit, 'dev');
  assert.equal(BUILD.shortCommit, 'dev');
  assert.equal(BUILD.builtAt, null);
  assert.equal(BUILD.channel, 'dev');
  assert.equal(BUILD.repository, normalizeRepositoryUrl(pkg.repository), 'the repository field of package.json names the same repository');
  assert.ok(BUILD.repository, 'package.json has a repository');
  assert.ok(Object.isFrozen(BUILD));
  assert.deepEqual(Object.keys(BUILD), ['version', 'commit', 'shortCommit', 'builtAt', 'channel', 'repository']);
});

test('package.json, js/build-info.js and CHANGELOG.md agree (the check that npm run version:check makes)', () => {
  const verdict = checkFiles({ pkgText: read('package.json'), buildInfoText: read('js/build-info.js'), changelogText: read('CHANGELOG.md') });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.version, pkg.version);
});

// ---- the identity and its two files ------------------------------------------------------------------------------------

test('buildIdentity: GITHUB_SHA makes a live build, none makes a local one; the build time can be fixed', () => {
  const live = buildIdentity({ pkg, env: { GITHUB_SHA: SHA.toUpperCase(), GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: 'someone/LogiPlan', SOURCE_DATE_EPOCH: '1791558480' } });
  assert.deepEqual(live, {
    name: 'logiplan', version: pkg.version, commit: SHA, shortCommit: 'a45ce49', builtAt: '2026-10-09T15:08:00Z', channel: 'live', repository: 'https://github.com/someone/LogiPlan', builtFrom: 'main',
  });
  const local = buildIdentity({ pkg, env: {}, now: new Date('2026-10-09T15:08:09.876Z') });
  assert.deepEqual([local.commit, local.shortCommit, local.channel, local.builtFrom, local.builtAt, local.repository], ['local', 'local', 'local', 'local', '2026-10-09T15:08:09Z', normalizeRepositoryUrl(pkg.repository)]);
  assert.equal(buildIdentity({ pkg, env: { GITHUB_SHA: SHA, GITHUB_SERVER_URL: 'https://git.example.org', GITHUB_REPOSITORY: 'a/b' } }).repository, 'https://git.example.org/a/b');
  assert.throws(() => buildIdentity({ pkg: { name: 'x', version: 'banana' }, env: {} }), /no valid "version"/);
  assert.throws(() => buildIdentity({ pkg: null, env: {} }), /no valid "version"/);
});

test('buildIdentity: hostile environment values never reach the generated code', async () => {
  const evil = '"; process.exit(7); //';
  const id = buildIdentity({ pkg, env: { GITHUB_SHA: evil, GITHUB_REF_NAME: `main${evil}\n\u0007`, GITHUB_REPOSITORY: evil, GITHUB_SERVER_URL: evil, SOURCE_DATE_EPOCH: 'soon' } });
  assert.equal(id.commit, 'local', 'an invalid GITHUB_SHA is no commit');
  assert.equal(id.channel, 'local');
  assert.equal(id.repository, normalizeRepositoryUrl(pkg.repository), 'an invalid repository falls back to package.json');
  assert.ok(!/[\u0000-\u001f]/.test(id.builtFrom));
  assert.match(id.builtAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const dir = mkdtempSync(path.join(tmp, 'evil-'));
  mkdirSync(path.join(dir, 'js'));
  writeFileSync(path.join(dir, 'js/build-info.js'), renderBuildInfo({ ...id, version: pkg.version, repository: `https://github.com/a/b${evil}` }));
  const imported = await importBuild(dir);
  assert.equal(imported.repository, `https://github.com/a/b${evil}`, 'a value with quotes is data, not code (JSON.stringify)');
  assert.equal(JSON.parse(renderVersionJson(id)).builtFrom, id.builtFrom);
});

test('the site build writes the identity into the SITE only and copies the changelog', async () => {
  const before = { info: read('js/build-info.js'), pkg: read('package.json') };
  const out = path.join(tmp, 'site');
  const res = buildSite(out, { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: 'rangulvers/LogiPlan', SOURCE_DATE_EPOCH: '1791558480' });
  assert.equal(res.status, 0, res.stderr);

  const version = JSON.parse(readFileSync(path.join(out, 'version.json'), 'utf8'));
  assert.deepEqual(version, {
    name: 'logiplan', version: pkg.version, commit: SHA, shortCommit: 'a45ce49', builtAt: '2026-10-09T15:08:00Z', channel: 'live', builtFrom: 'main',
  }, 'the old fields (name, version, commit, builtFrom) are all still there');

  const build = await importBuild(out);
  assert.deepEqual({ ...build }, { version: pkg.version, commit: SHA, shortCommit: 'a45ce49', builtAt: '2026-10-09T15:08:00Z', channel: 'live', repository: 'https://github.com/rangulvers/LogiPlan' });
  assert.ok(Object.isFrozen(build));

  assert.equal(read('js/build-info.js'), before.info, 'the repository file is untouched by a build');
  assert.equal(read('package.json'), before.pkg);
  assert.equal(readFileSync(path.join(out, 'CHANGELOG.md'), 'utf8'), read('CHANGELOG.md'), 'the changelog is part of the site');
  for (const name of ['index.html', '.nojekyll', 'css/tokens.css', 'js/main.js', 'js/version.js', 'js/update-check.js', 'js/ui/about.js', 'favicon.svg']) assert.ok(existsSync(path.join(out, name)), name);

  const siteFiles = files(out).filter((f) => f !== 'package.json');
  const repoJs = files(path.join(ROOT, 'js')).map((f) => `js/${f}`);
  assert.deepEqual(siteFiles.filter((f) => f.startsWith('js/')), repoJs, 'the site has exactly the files of js/');
  for (const f of repoJs.filter((x) => x !== 'js/build-info.js')) assert.equal(readFileSync(path.join(out, f), 'utf8'), read(f), `${f} is copied unchanged`);
  assert.notEqual(readFileSync(path.join(out, 'js/build-info.js'), 'utf8'), before.info, 'only build-info.js differs');
});

test('what the site writes is what the update check reads: the build and its own version.json are "the same commit"; a newer one is an update', async () => {
  const out = path.join(tmp, 'site-pair');
  assert.equal(buildSite(out, { GITHUB_SHA: SHA }).status, 0);
  const build = await importBuild(out);
  const served = JSON.parse(readFileSync(path.join(out, 'version.json'), 'utf8'));
  assert.equal(updateVerdict(build, served).reason, 'same');
  assert.equal(updateVerdict(build, { ...served, commit: 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6' }).available, true);
  assert.equal(updateVerdict(BUILD, { ...served, commit: 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6' }).reason, 'not-deployed', 'the development build of the repository never asks');
});

test('without GITHUB_SHA the site is a local build, and version.json keeps its old meaning (commit "local")', async () => {
  const out = path.join(tmp, 'site-local');
  assert.equal(buildSite(out).status, 0);
  const version = JSON.parse(readFileSync(path.join(out, 'version.json'), 'utf8'));
  assert.equal(version.commit, 'local');
  assert.equal(version.builtFrom, 'local');
  assert.equal(version.channel, 'local');
  assert.equal(version.version, pkg.version);
  const build = await importBuild(out);
  assert.equal(build.channel, 'local');
  assert.equal(updateVerdict(build, { ...version, commit: SHA }).reason, 'not-deployed', 'a hand-made build does not look for updates either');
});

test('the build refuses to empty the repository or a folder that holds it, and says why', () => {
  const repo = path.join(path.sep, 'work', 'LogiPlan');
  for (const bad of [repo, path.join(path.sep, 'work'), path.sep, path.join(repo, '..'), path.join(repo, '.', '')]) assert.throws(() => assertSafeOutput(bad, repo), /Refusing to empty/, bad);
  for (const good of [path.join(repo, '_site'), path.join(repo, '_site-ci'), path.join(path.sep, 'tmp', 'site'), path.join(path.sep, 'work', 'other')]) assert.doesNotThrow(() => assertSafeOutput(good, repo), good);
});

// ---- scripts/bump-version.mjs ---------------------------------------------------------------------------------------------

/** A copy of the three files in a fresh directory. */
function miniRepo(name, { changelog = read('CHANGELOG.md') } = {}) {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, 'js'), { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  cpSync(path.join(ROOT, 'js/build-info.js'), path.join(dir, 'js/build-info.js'));
  writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}
const quiet = () => { const lines = []; return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) }; };
const status = (dir) => checkFiles({ pkgText: readFileSync(path.join(dir, 'package.json'), 'utf8'), buildInfoText: readFileSync(path.join(dir, 'js/build-info.js'), 'utf8'), changelogText: readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8') });

test('bump minor: package.json, build-info and the changelog move together; [Unreleased] becomes the new version', () => {
  const dir = miniRepo('bump-minor');
  const out = quiet();
  assert.equal(bump(['minor', '--root', dir, '--date', '2026-10-10'], out), 0);
  const next = pkg.version.replace(/\.(\d+)\.\d+$/, (m, minor) => `.${Number(minor) + 1}.0`);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version, next);
  assert.match(readFileSync(path.join(dir, 'js/build-info.js'), 'utf8'), new RegExp(`version: '${next.replace(/\./g, '\\.')}'`));
  const entries = parseChangelog(readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'));
  assert.deepEqual(entries.slice(0, 3).map((e) => [e.version, e.date]), [['Unreleased', null], [next, '2026-10-10'], [pkg.version, latestRelease(parseChangelog(read('CHANGELOG.md'))).date]]);
  assert.equal(entries[0].sections.length, 0, 'a fresh, empty [Unreleased] stays on top');
  assert.deepEqual(entries[1].sections, parseChangelog(read('CHANGELOG.md'))[0].sections, 'what was unreleased is now the new version, word for word');
  assert.deepEqual(status(dir).problems, [], 'the three files agree afterwards');
  assert.ok(out.lines.join('\n').includes('Next:'), 'it says what to do next');
  assert.equal(readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/"version": "[^"]+"/, ''), read('package.json').replace(/"version": "[^"]+"/, ''), 'the rest of package.json is byte for byte the same');
});

test('bump patch, major and an explicit version; a dry run changes nothing', () => {
  for (const [arg, expected] of [['patch', '0.6.1'], ['major', '1.0.0'], ['0.9.0', '0.9.0'], ['2.0.0-rc.1', '2.0.0-rc.1']]) {
    const dir = miniRepo(`bump-${arg}`);
    assert.equal(bump([arg, '--root', dir, '--date', '2026-10-10'], quiet()), 0, arg);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version, expected, arg);
  }
  const dir = miniRepo('bump-dry');
  const out = quiet();
  assert.equal(bump(['minor', '--dry-run', '--root', dir], out), 0);
  assert.ok(/Would make/.test(out.lines[0]));
  assert.equal(readFileSync(path.join(dir, 'package.json'), 'utf8'), read('package.json'));
  assert.equal(readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), read('CHANGELOG.md'));
});

test('bump refuses a version that is not newer, a typo, a bad date and unknown options; nothing is changed', () => {
  const dir = miniRepo('bump-refuse');
  const cases = [[['0.6.0'], 2], [['0.5.0'], 2], [['banana'], 2], [['v1.0.0'], 2], [['1.0'], 2], [[], 2], [['minor', 'extra'], 2], [['minor', '--date', '2026-02-30'], 2], [['minor', '--date'], 2], [['--nope'], 2], [['1.0.0+build'], 2]];
  for (const [args, code] of cases) assert.equal(bump([...args, '--root', dir], quiet()), code, JSON.stringify(args));
  assert.equal(bump(['--check', '--root', path.join(tmp, 'does-not-exist')], quiet()), 2, 'missing files are reported, not thrown');
  assert.equal(readFileSync(path.join(dir, 'package.json'), 'utf8'), read('package.json'));
  assert.equal(readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), read('CHANGELOG.md'));
});

test('--check passes on agreeing files and fails, with the reason, on every kind of drift', () => {
  const ok = miniRepo('check-ok');
  const out = quiet();
  assert.equal(bump(['--check', '--root', ok], out), 0);
  assert.match(out.lines[0], new RegExp(`version ${pkg.version.replace(/\./g, '\\.')}`));

  const drift = (name, edit) => {
    const dir = miniRepo(name);
    edit(dir);
    const o = quiet();
    return { code: bump(['--check', '--root', dir], o), text: o.lines.join('\n') };
  };
  const sub = (dir, file, from, to) => writeFileSync(path.join(dir, file), readFileSync(path.join(dir, file), 'utf8').replace(from, to));
  let r = drift('check-pkg', (d) => sub(d, 'package.json', `"version": "${pkg.version}"`, '"version": "0.6.1"'));
  assert.equal(r.code, 1);
  assert.match(r.text, /js\/build-info\.js says 0\.6\.0 but package\.json says 0\.6\.1/);
  assert.match(r.text, /newest released entry of CHANGELOG\.md is 0\.6\.0/);
  r = drift('check-info', (d) => sub(d, 'js/build-info.js', `version: '${pkg.version}'`, "version: '0.5.0'"));
  assert.equal(r.code, 1);
  assert.match(r.text, /js\/build-info\.js says 0\.5\.0/);
  r = drift('check-log', (d) => sub(d, 'CHANGELOG.md', `## [${pkg.version}]`, '## [0.6.5]'));
  assert.equal(r.code, 1);
  assert.match(r.text, /newest released entry of CHANGELOG\.md is 0\.6\.5/);
  r = drift('check-date', (d) => sub(d, 'CHANGELOG.md', `## [${pkg.version}] - 2026-10-09`, `## [${pkg.version}]`));
  assert.equal(r.code, 1);
  assert.match(r.text, /has no valid date/);
  r = drift('check-live-info', (d) => sub(d, 'js/build-info.js', "commit: 'dev'", `commit: '${SHA}'`));
  assert.equal(r.code, 1);
  assert.match(r.text, /development default/);
  r = drift('check-no-release', (d) => writeFileSync(path.join(d, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- x\n'));
  assert.equal(r.code, 1);
  assert.match(r.text, /no released version/);
  r = drift('check-broken-pkg', (d) => writeFileSync(path.join(d, 'package.json'), '{ not json'));
  assert.equal(r.code, 1);
  assert.match(r.text, /not valid JSON/);
});

test('bumpChangelog: with and without [Unreleased], with and without content', () => {
  const base = '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Fixed\n- A fix that is waiting.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- Old.\n';
  const moved = bumpChangelog(base, '1.1.0', '2026-02-02');
  assert.equal(moved, '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [1.1.0] - 2026-02-02\n\n### Fixed\n- A fix that is waiting.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- Old.\n');
  const empty = bumpChangelog('# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- Old.\n', '1.0.1', '2026-02-02');
  assert.ok(empty.includes(`## [1.0.1] - 2026-02-02\n\n### Added\n${STUB_LINE}\n\n## [1.0.0]`), 'an empty [Unreleased] gets the stub');
  const missing = bumpChangelog('# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- Old.\n', '1.0.1', '2026-02-02');
  assert.ok(missing.startsWith('# Changelog\n\n## [Unreleased]\n\n## [1.0.1] - 2026-02-02\n\n### Added\n- TODO'), 'the heading is added above the first entry');
  const bare = bumpChangelog('# Changelog', '0.1.0', '2026-02-02');
  assert.ok(/## \[Unreleased\][\s\S]*## \[0\.1\.0\] - 2026-02-02/.test(bare));
  const crlf = bumpChangelog('## [Unreleased]\r\n- x item here\r\n', '0.2.0', '2026-02-02');
  assert.ok(!crlf.includes('\r'));
  const parsed = parseChangelog(moved);
  assert.deepEqual(parsed.map((e) => e.version), ['Unreleased', '1.1.0', '1.0.0']);
  assert.ok(parseChangelog(empty)[1].sections[0].items[0].startsWith('TODO'), 'the changelog test would refuse this stub');
});

test('the command line: exit codes and output of node scripts/bump-version.mjs', () => {
  const dir = miniRepo('cli');
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/bump-version.mjs'), ...args, '--root', dir], { encoding: 'utf8', cwd: ROOT });
  const good = cli('--check');
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /agree/);
  assert.equal(cli('banana').status, 2);
  assert.match(cli('banana').stderr, /Usage:/);
  const made = cli('patch', '--date', '2026-10-10');
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /Made version 0\.6\.1 \(was 0\.6\.0\), dated 2026-10-10/);
  assert.equal(cli('--check').status, 0, 'after a bump the three files agree');
});
