#!/usr/bin/env node
// The facts of the landing page /how/ (docs/HOW-PAGE-DESIGN.md 4): every number or name the page prints that could go stale is derived HERE from the code
// and the documents of the repository, written to how/facts.json, and checked against the HTML by tests/how.page.test.js.
//
//   node scripts/how-facts.mjs           write how/facts.json
//   node scripts/how-facts.mjs --check   exit 1 when how/facts.json is not what the repository says now
//
// The page marks a printed value as <span data-fact="key">value</span> (the text must equal the fact) and a link as <a data-fact-href="key" href="...">.
// A fact has a value (a string; numbers are written in digits) and a source (where it comes from, shown in the claim ledger of the design document).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLES } from '../js/model/examples.js';
import { TRUCK_DEFAULTS } from '../js/model/ops.js';
import { FLEET_PRESET_ORDER, GRID_LIMITS } from '../js/model/defaults.js';
import { EXAMPLE_LEVELS } from '../js/ui/examples-gallery.js';
import { SPEEDS } from '../js/ui/runner.js';
import { normalizeRepositoryUrl } from '../js/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);

/** Every file below `dir` (repository-relative, forward slashes) whose name passes `keep`. */
function walk(dir, keep) {
  const out = [];
  for (const name of readdirSync(rel(dir)).sort()) {
    const p = `${dir}/${name}`;
    if (statSync(rel(p)).isDirectory()) out.push(...walk(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}

const lines = (files) => files.reduce((n, f) => n + readFileSync(rel(f), 'utf8').split('\n').length - 1, 0);

/** @returns {Record<string, { value: string, source: string }>} */
export function computeFacts() {
  const pkg = JSON.parse(readFileSync(rel('package.json'), 'utf8'));
  const repo = normalizeRepositoryUrl(pkg.repository) || '';
  const facts = {};
  const add = (key, value, source) => { facts[key] = { value: String(value), source }; };

  add('version', pkg.version, 'package.json "version"');
  const [owner, name] = repo.replace(/^https:\/\/github\.com\//, '').split('/');
  add('site.url', owner && name ? `https://${owner.toLowerCase()}.github.io/${name}/` : '', 'package.json "repository": the GitHub Pages address named in README.md (Deploy)');
  add('site.og_image', owner && name ? `https://${owner.toLowerCase()}.github.io/${name}/how/img/og.png` : '', 'site.url + how/img/og.png');
  add('license', 'MIT', 'LICENSE (first line)');
  add('repo.url', repo, 'package.json "repository"');
  add('repo.license_url', `${repo}/blob/main/LICENSE`, 'package.json "repository" + LICENSE');

  add('examples.count', EXAMPLES.length, 'js/model/examples.js EXAMPLES.length');
  add('examples.levels', Math.max(...EXAMPLES.map((e) => e.level)), 'js/model/examples.js, highest level');
  for (const l of EXAMPLE_LEVELS) {
    add(`level.${l.level}.title`, l.title, `js/ui/examples-gallery.js EXAMPLE_LEVELS[${l.level}].title`);
    add(`level.${l.level}.caption`, l.caption, `js/ui/examples-gallery.js EXAMPLE_LEVELS[${l.level}].caption`);
  }
  for (const e of EXAMPLES) {
    const layout = e.build();
    const vehicles = (layout.fleets || []).reduce((n, f) => n + (Number(f.count) || 0), 0);
    add(`ex.${e.id}.name`, e.name, `js/model/examples.js ${e.id}.name`);
    add(`ex.${e.id}.level`, e.level, `js/model/examples.js ${e.id}.level`);
    add(`ex.${e.id}.learn`, e.learn, `js/model/examples.js ${e.id}.learn`);
    add(`ex.${e.id}.stations`, (layout.stations || []).length, `${e.id}.build().stations.length`);
    add(`ex.${e.id}.vehicles`, vehicles, `${e.id}.build().fleets, sum of count`);
  }

  add('vehicle.presets', FLEET_PRESET_ORDER.length, 'js/model/defaults.js FLEET_PRESET_ORDER');
  add('speed.min', SPEEDS[0], 'js/ui/runner.js SPEEDS');
  add('speed.max', SPEEDS[SPEEDS.length - 1], 'js/ui/runner.js SPEEDS');
  add('trucks.pallets', TRUCK_DEFAULTS.pallets.mean, 'js/model/ops.js TRUCK_DEFAULTS.pallets.mean');
  add('trucks.checkin_min', TRUCK_DEFAULTS.checkIn / 60, 'js/model/ops.js TRUCK_DEFAULTS.checkIn / 60');
  add('grid.max', GRID_LIMITS.maxCols, 'js/model/defaults.js GRID_LIMITS.maxCols');

  const js = walk('js', (n) => n.endsWith('.js'));
  const area = (dir) => js.filter((f) => f.startsWith(`js/${dir}/`));
  // Counts that grow with every commit are published as round lower bounds ("130+"), so the page stays true, and the test quiet, until a boundary is crossed.
  const floor = (n, step) => Math.floor(n / step) * step;
  add('code.files.floor', floor(js.length, 10), 'js/**/*.js, files, rounded down to 10 (the page says "N+")');
  add('code.lines.floor', floor(lines(js), 1000), 'js/**/*.js, lines, rounded down to 1000 (the page says "N+")');
  add('code.model.floor', floor(area('model').length, 5), 'js/model/**/*.js, files, rounded down to 5');
  add('code.sim.floor', floor(area('sim').length, 5), 'js/sim/**/*.js, files, rounded down to 5');
  add('code.ui.floor', floor(area('ui').length, 10), 'js/ui/**/*.js, files, rounded down to 10');
  add('code.deps', Object.keys(pkg.dependencies || {}).length, 'package.json "dependencies" (runtime)');

  const tests = readdirSync(rel('tests')).filter((n) => n.endsWith('.test.js'));
  add('tests.files.floor', floor(tests.length, 10), 'tests/*.test.js, files, rounded down to 10 (the page says "N+")');
  add('tests.golden', readdirSync(rel('tests/fixtures/golden')).filter((n) => n.endsWith('.json')).length, 'tests/fixtures/golden/*.json, files');
  return facts;
}

export const FACTS_FILE = 'how/facts.json';

export function renderFacts(facts = computeFacts()) {
  return `${JSON.stringify({ _: 'Generated by scripts/how-facts.mjs; do not edit. Checked by tests/how.page.test.js.', facts }, null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = renderFacts();
  if (process.argv.includes('--check')) {
    let now = '';
    try { now = readFileSync(rel(FACTS_FILE), 'utf8'); } catch { /* missing */ }
    if (now !== text) { console.error(`✗ ${FACTS_FILE} is out of date: run  node scripts/how-facts.mjs`); process.exit(1); }
    console.log(`✓ ${FACTS_FILE} is current`);
  } else {
    writeFileSync(rel(FACTS_FILE), text);
    console.log(`✓ wrote ${FACTS_FILE}`);
  }
}
