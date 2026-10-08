// Shared Playwright plumbing for E2E / visual checks (run by hand: node tests/e2e/<script>.mjs).
// Playwright is not a repo dependency: it is resolved from node_modules/playwright (a local symlink to the
// globally installed copy in dev containers) or from a normal `npm i -D playwright`.
import { chromium } from 'playwright';
import { createServer } from '../../scripts/serve.mjs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OUT = path.join(ROOT, 'e2e-output');

/**
 * Start the static server + headless Chromium, run `fn({ page, url, errors, shot })`, clean up.
 *  - `url(p)` builds an absolute URL for a repo-relative path ('/index.html', '/tests/e2e/x.html').
 *  - `errors` collects console errors/warnings and uncaught page errors (assert it is empty at the end).
 *  - `shot(name)` saves e2e-output/<name>.png (full page) and returns the path — view it with the Read tool.
 */
export async function withBrowser(fn, { viewport = { width: 1440, height: 900 }, deviceScaleFactor = 1 } = {}) {
  mkdirSync(OUT, { recursive: true });
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  const url = (p = '/index.html') => `http://127.0.0.1:${port}${p}`;
  const shot = async (name, opts = {}) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, ...opts });
    return file;
  };
  try {
    return await fn({ page, context, browser, url, errors, shot });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
