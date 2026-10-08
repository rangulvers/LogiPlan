#!/usr/bin/env node
// The single entry point of the browser tests: `npm run test:e2e`.
//
// Runs every check script of tests/e2e as its own process (each starts its own static server and headless Chromium, so one
// script cannot disturb another), prints one line per script and a summary, and exits non-zero when any script failed.
//
//   node tests/e2e/run.mjs                 run every test script (two at a time)
//   node tests/e2e/run.mjs app editor      run only these (names without .mjs)
//   node tests/e2e/run.mjs --jobs 1        run one script at a time (quieter on a busy machine)
//   node tests/e2e/run.mjs --list          list the scripts and what each one checks
//   node tests/e2e/run.mjs --review        also run the independent review scripts (they exit non-zero for every open finding)
//
// The output of each script goes to e2e-output/<name>.log; the last lines of a failed one are printed here. Screenshots land in
// e2e-output/*.png. Environment: E2E_JOBS (default 2), E2E_TIMEOUT_MS (per script, default 15 minutes).
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../e2e-output');

/** The test scripts, cheapest first so a broken basic module fails the run early. `review` scripts are opt-in. */
const SCRIPTS = Object.freeze([
  { name: 'fields', what: 'form-field builders (js/ui/panels/fields.js)' },
  { name: 'uikit-visual', what: 'UI kit: components, icons, charts, contrast, themes' },
  { name: 'render-visual', what: 'plant renderer: drawing, hit tests, PNG export' },
  { name: 'editor', what: 'canvas editor: tools, gestures, keyboard, touch' },
  { name: 'panels1', what: 'Properties, Simulate and Checks panels' },
  { name: 'panels2', what: 'Fleet and Flows panels, dialogs' },
  { name: 'dashboard', what: 'Results dashboard' },
  { name: 'compare', what: 'Experiments tab and report export' },
  { name: 'app', what: 'app shell: top bar, palette, tabs, drawer, shortcuts, persistence' },
  { name: 'integration', what: 'whole-session journeys through the real app, performance, random use' },
  { name: 'uikit-review', what: 'independent review of the UI kit', review: true },
  { name: 'render-review', what: 'independent review of the renderer', review: true },
]);

function parseArgs(argv) {
  const opts = { names: [], jobs: Number(process.env.E2E_JOBS) || 2, list: false, review: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--review') opts.review = true;
    else if (arg === '--jobs') opts.jobs = Number(argv[++i]);
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else opts.names.push(arg.replace(/\.mjs$/, ''));
  }
  if (!(opts.jobs >= 1)) throw new Error('--jobs needs a number of at least 1');
  return opts;
}

/** Run one script; resolves { name, code, ms, tail } and never rejects. */
function runScript(script, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = createWriteStream(path.join(OUT, `${script.name}.log`));
    const child = spawn(process.execPath, [path.join(HERE, `${script.name}.mjs`)], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(HERE, '../..') });
    const lines = [];
    const keep = (chunk) => {
      log.write(chunk);
      for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(line);
      if (lines.length > 400) lines.splice(0, lines.length - 400);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      log.end();
      const failed = timedOut ? 'timed out' : code !== 0 ? `exit code ${code ?? signal}` : '';
      resolve({ name: script.name, failed, ms: Date.now() - started, lines });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      log.end();
      resolve({ name: script.name, failed: `could not start: ${err.message}`, ms: Date.now() - started, lines });
    });
  });
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const s of SCRIPTS) console.log(`${s.name.padEnd(14)}${s.review ? '(review) ' : ''}${s.what}`);
    return 0;
  }
  const unknown = opts.names.filter((n) => !SCRIPTS.some((s) => s.name === n));
  if (unknown.length) throw new Error(`Unknown script ${unknown.join(', ')}. Known: ${SCRIPTS.map((s) => s.name).join(', ')}`);
  const chosen = SCRIPTS.filter((s) => (opts.names.length ? opts.names.includes(s.name) : opts.review || !s.review));
  mkdirSync(OUT, { recursive: true });
  const timeoutMs = Number(process.env.E2E_TIMEOUT_MS) || 15 * 60 * 1000;

  console.log(`Running ${chosen.length} browser test scripts (${opts.jobs} at a time)...`);
  const results = [];
  const queue = [...chosen];
  const worker = async () => {
    for (let script = queue.shift(); script; script = queue.shift()) {
      const result = await runScript(script, timeoutMs);
      results.push(result);
      const summary = result.lines.filter((l) => /passed|checks|all browser checks|all checks|OK|no defects/i.test(l)).at(-1) || '';
      console.log(`${result.failed ? 'FAIL' : 'ok  '} ${script.name.padEnd(14)} ${seconds(result.ms).padStart(8)}  ${result.failed || summary.trim().slice(0, 100)}`);
      if (result.failed) for (const line of result.lines.slice(-14)) console.log(`       | ${line.slice(0, 200)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.jobs, chosen.length) }, worker));

  const failed = results.filter((r) => r.failed);
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  console.log(`\n${results.length - failed.length} of ${results.length} scripts passed (${seconds(total)} of script time).`);
  if (failed.length) console.log(`Failed: ${failed.map((r) => r.name).join(', ')}. Full output: e2e-output/<name>.log`);
  return failed.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 2; });
