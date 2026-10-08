#!/usr/bin/env node
// The single entry point of the browser tests: `npm run test:e2e`.
//
// Runs every check script of tests/e2e as its own process (each starts its own static server and headless Chromium, so one
// script cannot disturb another), prints one line per script and a summary, and exits non-zero when any script failed.
//
//   node tests/e2e/run.mjs                 run every test script (two at a time)
//   node tests/e2e/run.mjs app editor      run only these (names without .mjs)
//   node tests/e2e/run.mjs --jobs 1        run one script at a time (quieter on a busy machine)
//   node tests/e2e/run.mjs --retries 0     fail at once: by default a failed script runs once more, and is reported as FLAKY when
//                                          the second run passes (a loaded machine can stall a script that waits on real time)
//   node tests/e2e/run.mjs --list          list the scripts and what each one checks
//   node tests/e2e/run.mjs --review        also run the independent review scripts (they exit non-zero for every open finding)
//
// The output of each script goes to e2e-output/<name>.log; the last lines of a failed one are printed here. Screenshots land in
// e2e-output/*.png. Environment: E2E_JOBS (default 2), E2E_RETRIES (default 1), E2E_TIMEOUT_MS (per script, default 15 minutes).
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../e2e-output');

/**
 * The test scripts, cheapest first so a broken basic module fails the run early. `review` scripts are opt-in. `exclusive` scripts
 * measure frame times or wait on real time: they run alone, after all the others, so that a neighbour cannot slow them down.
 */
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
  { name: 'integration', what: 'whole-session journeys through the real app, performance, random use', exclusive: true },
  { name: 'guidance-logic', what: 'coaching: Next steps, guide chip, Getting started, Checks fixes (the second Goods in journey)' },
  { name: 'guidance-canvas', what: 'canvas guidance: flow handle, connect mode, hint after placing, vehicle jobs and waiting loads' },
  { name: 'guidance-panels', what: 'who serves which flow: station Where do loads go?, Jobs this fleet serves, Served by, Help page and welcome tips' },
  { name: 'edit-feedback', what: 'edit feedback: warm restart after edits, "Effect of your change" card, baseline, fleet status, frame times', exclusive: true },
  { name: 'uikit-review', what: 'independent review of the UI kit', review: true },
  { name: 'render-review', what: 'independent review of the renderer', review: true },
]);

function parseArgs(argv) {
  const opts = { names: [], jobs: Number(process.env.E2E_JOBS) || 2, retries: Number(process.env.E2E_RETRIES ?? 1), list: false, review: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--review') opts.review = true;
    else if (arg === '--jobs') opts.jobs = Number(argv[++i]);
    else if (arg === '--retries') opts.retries = Number(argv[++i]);
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else opts.names.push(arg.replace(/\.mjs$/, ''));
  }
  if (!(opts.jobs >= 1)) throw new Error('--jobs needs a number of at least 1');
  if (!(opts.retries >= 0)) throw new Error('--retries needs a number of at least 0');
  return opts;
}

/** Run one script; resolves { name, failed ('' when it passed), ms, lines (its output) } and never rejects. */
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
    for (const s of SCRIPTS) console.log(`${s.name.padEnd(16)}${s.review ? '(review) ' : s.exclusive ? '(alone)  ' : ''}${s.what}`);
    return 0;
  }
  const unknown = opts.names.filter((n) => !SCRIPTS.some((s) => s.name === n));
  if (unknown.length) throw new Error(`Unknown script ${unknown.join(', ')}. Known: ${SCRIPTS.map((s) => s.name).join(', ')}`);
  const chosen = SCRIPTS.filter((s) => (opts.names.length ? opts.names.includes(s.name) : opts.review || !s.review));
  mkdirSync(OUT, { recursive: true });
  const timeoutMs = Number(process.env.E2E_TIMEOUT_MS) || 15 * 60 * 1000;

  console.log(`Running ${chosen.length} browser test scripts (${opts.jobs} at a time, timing-sensitive ones alone at the end)...`);
  const results = [];
  const queue = chosen.filter((s) => !s.exclusive);
  const alone = chosen.filter((s) => s.exclusive);
  const worker = async () => {
    for (let script = queue.shift(); script; script = queue.shift()) {
      let result = await runScript(script, timeoutMs);
      let flaky = '';
      for (let attempt = 0; result.failed && attempt < opts.retries; attempt++) {
        const first = result;
        result = await runScript(script, timeoutMs);
        result.ms += first.ms;
        if (!result.failed) flaky = first.failed;
      }
      result.flaky = flaky;
      results.push(result);
      const summary = result.lines.filter((l) => /passed|checks|all browser checks|all checks|OK|no defects/i.test(l)).at(-1) || '';
      const status = result.failed ? 'FAIL' : flaky ? 'FLAKY' : 'ok  ';
      console.log(`${status} ${script.name.padEnd(16)} ${seconds(result.ms).padStart(8)}  ${result.failed || (flaky ? `passed on the second run (the first: ${flaky})` : summary.trim().slice(0, 100))}`);
      if (result.failed) for (const line of result.lines.slice(-14)) console.log(`       | ${line.slice(0, 200)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.jobs, queue.length) }, worker));
  queue.push(...alone);
  await worker();

  const failed = results.filter((r) => r.failed);
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  const flaky = results.filter((r) => r.flaky);
  console.log(`\n${results.length - failed.length} of ${results.length} scripts passed (${seconds(total)} of script time).`);
  if (flaky.length) console.log(`Flaky (failed once, passed on retry): ${flaky.map((r) => r.name).join(', ')}.`);
  if (failed.length) console.log(`Failed: ${failed.map((r) => r.name).join(', ')}. Full output: e2e-output/<name>.log`);
  return failed.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 2; });
