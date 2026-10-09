// The version of the running app in the REAL app (index.html + js/main.js) in real Chromium: the chip at the bottom right, the About dialog behind it,
// the list of changes, the copy button, the hint "Update available", and what is NOT allowed to happen (no request from a development build, no reload by
// itself, no interruption of a running simulation, no markup from a fetched file).
//
//   chip       a development build (the repository as it is): the chip is a real <button> in the status line with the text "v0.6.0 dev", an aria-label and a
//              tooltip, and a development build never asks for version.json
//   dialog     opened by mouse and by keyboard (Enter, Space): the facts, Tab stays inside, Escape and Close close it, the keyboard goes back to the chip; a double
//              click on the chip and an Enter held down do not close what they opened
//   changes    the list is CHANGELOG.md of the repository: every entry in order, the newest release (and the unreleased changes) open, the others closed, a
//              closed one opens with the keyboard; the dates are the written ones
//   copy       "Copy version info" puts the line on the clipboard and says so under the line (a polite live region, no toast over the dialog); when the browser
//              refuses, the line is selected and the note says so
//   hostile    a CHANGELOG.md full of markup is shown as text and runs nothing; a missing or unreachable list says so and "Try again" works
//   live       the SITE as scripts/build-site.mjs assembles it (GITHUB_SHA set), served under a host that is not localhost: the chip says "v0.6.0 a45ce49", the tooltip the
//              build and its day, the dialog the commit link, the build time in the viewer's zone and in UTC, "Live site"; the copy fallback of an insecure page
//   update     a version.json with a newer commit: the chip gets its Update mark and the dialog its Reload button while a simulation runs, nothing reloads and
//              nothing pops up; "Reload now" reloads and the plant is still there; a reload that could not save the plant is refused; junk, 404, the same commit and
//              an older version leave no trace
//   menu       the narrow layout and every window lower than 521 px (status line hidden: a phone held sideways, 200 % zoom) reach the dialog from the More menu,
//              and from the Help window
//   report     the footer of the HTML report names the version; the project file and the share link do not contain it
//   layout     light and dark, 1440 and 390 px: the chip is inside the window, big enough, readable (contrast), has a focus ring; nothing scrolls sideways;
//              screenshots in e2e-output/about-*.png (open them and look)
//
// Run: node tests/e2e/about.mjs [section]
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../scripts/serve.mjs';
import { assembleSite } from '../../scripts/build-site.mjs';
import { ROOT, OUT } from './browser.mjs';
import { parseChangelog, formatDay } from '../../js/version.js';
import { openByDefault } from '../../js/ui/about.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const wants = (name) => !only || only === name;

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };
const SHA = 'a45ce493dfd9ca7440743e6931042fca39642504';
const NEWER = 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6';
const BUILT_AT_EPOCH = '1791558480'; // 2026-10-09T15:08:00Z, as 17:08 in Berlin
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const entries = parseChangelog(changelog);

// ---- the servers: the repository as it is (development build) and the assembled site (live build) ---------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };

/** A static server for the folder `dir` (what GitHub Pages does with the site). */
function siteServer(dir) {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
    const file = path.resolve(dir, `.${rel}`);
    try {
      if (!file.startsWith(dir + path.sep)) throw new Error('outside');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const tmp = mkdtempSync(path.join(tmpdir(), 'logiplan-about-'));
const siteDir = path.join(tmp, 'site');
assembleSite({ out: siteDir, env: { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: 'rangulvers/LogiPlan', SOURCE_DATE_EPOCH: BUILT_AT_EPOCH } });

const devServer = createServer();
const liveServer = siteServer(siteDir);
const devPort = await listen(devServer);
const livePort = await listen(liveServer);
const DEV = `http://127.0.0.1:${devPort}`;
const LIVE = `http://logiplan.test:${livePort}`; // not localhost, and not a secure context: "Live site", and no navigator.clipboard

const browser = await chromium.launch({ args: ['--no-sandbox', '--host-resolver-rules=MAP logiplan.test 127.0.0.1'] });
const errors = [];
const requests = [];
let expectFailures = false; // a section that provokes failed requests says so

try {
  /** A new visitor: own context (storage), a page that records errors and requests. */
  async function visit(origin, { viewport = DESKTOP, colorScheme = 'light', scale = 1, permissions = [] } = {}) {
    const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: scale, timezoneId: 'Europe/Berlin', locale: 'en-GB', permissions });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('console', (m) => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      if (expectFailures && /Failed to load resource/.test(m.text())) return;
      errors.push(`[console.${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => { if (!expectFailures) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`); });
    page.on('request', (r) => requests.push(r.url()));
    return { context, page, origin };
  }

  /** Open the app and dismiss the welcome dialog of a first visit. */
  async function openApp(origin, opts = {}) {
    const s = await visit(origin, opts);
    await s.page.goto(`${origin}/index.html`);
    await s.page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await s.page.locator('[role=dialog]').waitFor();
    await s.page.keyboard.press('Escape');
    await s.page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await s.page.evaluate(() => { window.__marker = 'same page'; });
    return s;
  }

  const noErrors = (what) => { eq(errors.splice(0), [], `${what}: console errors, warnings or failed requests`); };
  /** Wait until the dialog has finished sliding in (animations that end), so that it is measured and photographed where it stays. */
  const settle = (page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  const snap = async (page, name, opts = {}) => {
    await settle(page);
    return page.screenshot({ path: path.join(OUT, `about-${name}.png`), ...opts });
  };
  const versionRequests = () => requests.filter((u) => /\/version\.json/.test(u));
  const chipOf = (page) => page.locator('.statusbar .versionchip');
  /** What the eye reads on the chip, in one line. */
  const chipText = async (chip) => (await chip.innerText()).replace(/\s+/g, ' ').trim();
  const dialogOf = (page) => page.locator('[role=dialog][aria-label], [role=dialog]').first();

  /** The facts of the open dialog as { Version: '0.6.0', ... }. */
  const facts = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[role=dialog] dl.kv dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])));
  /** Is the keyboard inside the open dialog? */
  const focusInside = (page) => page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('[role=dialog]')));
  const activeIsChip = (page) => page.evaluate(() => document.activeElement && document.activeElement.classList.contains('versionchip'));

  // ================================================================================================================================================
  if (wants('chip')) {
    const { context, page } = await openApp(DEV);
    const chip = chipOf(page);
    eq(await chip.count(), 1, 'one chip');
    eq(await chip.evaluate((el) => el.tagName), 'BUTTON', 'a real button');
    eq(await chip.getAttribute('type'), 'button');
    eq(await chipText(chip), `v${VERSION} dev`, 'the text of a development build');
    eq(await chip.getAttribute('aria-label'), `v${VERSION} dev. Development build. Show version information and what is new`, 'the spoken name starts with the visible text');
    eq(await chip.getAttribute('data-tip'), 'Development build, not deployed – click for what is new', 'the tooltip');
    eq(await chip.getAttribute('aria-haspopup'), 'dialog');
    eq(await chip.evaluate((el) => el.parentElement.className.split(' ').includes('statusbar')), true, 'it sits in the status line');
    eq(await page.locator('.versionchip__dot').isVisible(), false, 'no update mark');
    // hovering shows the tooltip of the kit
    await chip.hover();
    await page.waitForTimeout(500);
    const tip = await chip.evaluate((el) => { const s = getComputedStyle(el, '::after'); return { content: s.content, opacity: s.opacity }; });
    ok(tip.content.includes('Development build') && Number(tip.opacity) > 0.9, `the tooltip is shown on hover (${JSON.stringify(tip)})`);
    await snap(page, 'tooltip-desktop-light', { clip: { x: DESKTOP.width - 420, y: DESKTOP.height - 110, width: 420, height: 110 } });
    // a development build has nothing to compare with: no request for version.json, however long we wait
    await page.waitForTimeout(2500);
    eq(versionRequests(), [], 'a development build never asks for version.json');
    noErrors('chip');
    await context.close();
  }

  // ================================================================================================================================================
  if (wants('dialog')) {
    const { context, page } = await openApp(DEV);
    const chip = chipOf(page);
    const dialog = page.locator('[role=dialog]');

    // by mouse
    await chip.click();
    await dialog.waitFor();
    eq(await dialog.getAttribute('aria-modal'), 'true');
    eq(await page.locator('[role=dialog] .modal__title').innerText(), 'About LogiPlan');
    eq(await dialog.getAttribute('aria-labelledby'), await page.locator('[role=dialog] .modal__title').getAttribute('id'), 'the dialog is named by its title');
    eq(await page.evaluate(() => document.activeElement.textContent.trim()), 'Close', 'the keyboard starts on Close');
    const f = await facts(page);
    eq(f.Version, VERSION);
    eq(f.Build, 'Development build (not deployed)');
    eq(f.Built, 'Not built: it runs from the source files');
    ok(/^Local development \(127\.0\.0\.1:\d+\)$/.test(f['Where it runs']), `where it runs: ${f['Where it runs']}`);
    const line = await page.locator('[data-role=about-line]').innerText();
    ok(/^LogiPlan v[\d.]+ \(development build\), Chrome \d+, window 1440 x 900 on a 1440 x 900 screen$/.test(line), `the bug report line: ${line}`);
    const links = await page.locator('[role=dialog] .about__links a').evaluateAll((as) => as.map((a) => [a.textContent, a.href, a.target, a.rel]));
    eq(links, [
      ['Licence (MIT)', 'https://github.com/rangulvers/LogiPlan/blob/main/LICENSE', '_blank', 'noopener noreferrer'],
      ['Source code on GitHub', 'https://github.com/rangulvers/LogiPlan', '_blank', 'noopener noreferrer'],
      ['Report a problem', 'https://github.com/rangulvers/LogiPlan/issues', '_blank', 'noopener noreferrer'],
    ], 'the licence and the repository');
    await snap(page, 'dialog-dev-desktop-light');

    // Tab stays inside the dialog, in both directions
    const seen = new Set();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      ok(await focusInside(page), `Tab ${i + 1} stays in the dialog`);
      seen.add(await page.evaluate(() => document.activeElement.textContent.trim().slice(0, 30)));
    }
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Shift+Tab');
      ok(await focusInside(page), `Shift+Tab ${i + 1} stays in the dialog`);
    }
    ok(seen.has('Copy version info') && seen.has('Close'), `the keyboard reaches the copy button and Close (${[...seen].join(' | ')})`);

    // Escape closes and the keyboard goes back to the chip
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    ok(await activeIsChip(page), 'after Escape the focus is on the chip');

    // by keyboard: Enter, then Space; Close button
    await page.keyboard.press('Shift');
    await chip.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    ok(await focusInside(page), 'Enter opens the dialog and takes the keyboard in');
    await page.locator('[role=dialog] .modal__footer button', { hasText: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    ok(await activeIsChip(page), 'after Close the focus is on the chip');
    await page.keyboard.press('Space');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    ok(await activeIsChip(page), 'Space opens it too, and Escape gives the keyboard back');

    // the app behind does not react while it is open: Space must not start the simulation
    await chip.click();
    await dialog.waitFor();
    await page.keyboard.press('Space');
    eq(await page.evaluate(() => window.__logiplan.runner.playing), false, 'Space in the dialog does not play the simulation');
    await page.keyboard.press('Escape');
    // a click on the backdrop closes it, a click inside does not; the second click of a double click on the chip lands on the backdrop and does NOT close what the
    // first one opened (the dialog ignores the backdrop for its first 400 ms), and a held Enter does not press the Close button that has the focus
    await chip.dblclick();
    await dialog.waitFor();
    await page.waitForTimeout(150);
    eq(await dialog.count(), 1, 'a double click on the chip leaves the dialog open');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await chip.focus();
    await page.keyboard.down('Enter'); // opens it ...
    await dialog.waitFor();
    for (let i = 0; i < 4; i++) await page.keyboard.down('Enter'); // ... and the key stays down: auto-repeat events (repeat = true) arrive
    await page.keyboard.up('Enter');
    await page.waitForTimeout(100);
    eq(await dialog.count(), 1, 'the repeats of the Enter that opened the dialog do not press Close');
    await page.keyboard.press('Enter'); // a fresh press does
    await dialog.waitFor({ state: 'detached' });
    await chip.click();
    await dialog.waitFor();
    await page.waitForTimeout(450);
    await page.locator('[role=dialog] .about__name').click();
    eq(await dialog.count(), 1, 'a click inside keeps it open');
    await page.mouse.click(5, 5);
    await dialog.waitFor({ state: 'detached' });
    eq(await page.evaluate(() => window.__marker), 'same page');
    noErrors('dialog');
    await context.close();
  }

  // ================================================================================================================================================
  if (wants('changes')) {
    const { context, page } = await openApp(DEV);
    await chipOf(page).click();
    await page.locator('[role=dialog] .about__entry').first().waitFor();
    const shown = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] .about__entry')].map((entry) => {
      const toggle = entry.querySelector('.about__toggle');
      const body = entry.querySelector('.about__body');
      return {
        name: toggle.querySelector('.about__version').textContent,
        date: toggle.querySelector('.about__date')?.textContent || '',
        expanded: toggle.getAttribute('aria-expanded'),
        hidden: body.hidden,
        controls: toggle.getAttribute('aria-controls') === body.id,
        sections: [...body.querySelectorAll('h5')].map((h) => h.textContent),
        headed: toggle.parentElement.localName === 'h4',
        items: body.querySelectorAll('li').length,
      };
    }));
    eq(shown.length, entries.length, 'one entry per version of CHANGELOG.md');
    const open = openByDefault(entries);
    entries.forEach((e, i) => {
      const s = shown[i];
      eq(s.name, e.unreleased ? 'Latest changes' : `Version ${e.version}`, `entry ${i}: name`);
      if (!e.unreleased) eq(s.date, formatDay(e.date), `entry ${i}: the date as written in the file`);
      eq(s.sections, e.sections.map((x) => x.title), `entry ${i}: the sections`);
      eq(s.items, e.sections.reduce((n, x) => n + x.items.length, 0), `entry ${i}: every item is there`);
      eq(s.expanded, String(open.has(i)), `entry ${i}: expanded only when it is the unreleased changes or the newest release`);
      eq(s.hidden, !open.has(i), `entry ${i}: a closed entry is hidden`);
      ok(s.controls, `entry ${i}: the button names the body it opens`);
      ok(s.headed, `entry ${i}: the version button sits in a heading (a screen reader's list of headings names the versions)`);
    });
    const newestRelease = entries.findIndex((e) => !e.unreleased);
    ok(open.has(newestRelease) && [...open].every((i) => i <= newestRelease), 'the newest release is open and nothing older is');
    ok(shown.some((s) => s.expanded === 'false'), 'older versions are collapsed');
    // the marks next to the versions: the running version is "Your version"
    eq(await page.locator('[role=dialog] .about__entry .chip').allInnerTexts(), ['Your version'], 'one mark: the version that is running');
    // a closed entry opens with the keyboard and closes again
    const closed = shown.findIndex((s) => s.expanded === 'false');
    const toggle = page.locator('[role=dialog] .about__toggle').nth(closed);
    await toggle.focus();
    await page.keyboard.press('Enter');
    eq(await toggle.getAttribute('aria-expanded'), 'true');
    await page.locator('[role=dialog] .about__body').nth(closed).waitFor({ state: 'visible' });
    await page.keyboard.press('Space');
    eq(await toggle.getAttribute('aria-expanded'), 'false');
    eq(await page.locator('[role=dialog] .about__body').nth(closed).isVisible(), false);
    // the text is the written text: bold and italic become elements, nothing else does
    const firstItem = await page.locator('[role=dialog] .about__body:not([hidden]) li').first().innerHTML();
    ok(/<strong>.+<\/strong>/.test(firstItem), `bold is bold: ${firstItem.slice(0, 80)}`);
    ok(!/\*\*/.test(await page.locator('[role=dialog] .about__news').innerText()), 'no stray ** in the list');
    noErrors('changes');
    await context.close();
  }

  // ================================================================================================================================================
  if (wants('copy')) {
    const { context, page } = await openApp(DEV, { permissions: ['clipboard-read', 'clipboard-write'] });
    await chipOf(page).click();
    await page.locator('[role=dialog]').waitFor();
    const line = await page.locator('[data-role=about-line]').innerText();
    await page.locator('[role=dialog] button', { hasText: 'Copy version info' }).click();
    await page.locator('[data-role=about-copied]', { hasText: 'Copied.' }).waitFor();
    eq(await page.evaluate(() => navigator.clipboard.readText()), line, 'the clipboard holds exactly the line that is shown');
    eq(await page.locator('[data-role=about-copied]').innerText(), 'Copied. Paste it into your bug report.');
    eq(await page.locator('[data-role=about-copied]').getAttribute('role'), 'status', 'a polite live region: announced, but no toast that would cover the Close button');
    eq(await page.locator('.toast').count(), 0, 'no toast');
    await snap(page, 'copy-done');

    // the browser refuses: the clipboard API rejects and the old copy command says no
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      document.execCommand = () => false;
    });
    await page.locator('[role=dialog] button', { hasText: 'Copy version info' }).click();
    await page.locator('[data-role=about-copied]', { hasText: 'Copying is blocked' }).waitFor();
    eq(await page.evaluate(() => window.getSelection().toString().trim()), line, 'the line is selected, ready for Ctrl+C');
    ok(!/copied\./i.test(await page.locator('[data-role=about-copied]').innerText()), 'no false "copied"');
    eq(await page.locator('.toast').count(), 0, 'and still no toast');
    noErrors('copy');
    await context.close();
  }

  // ================================================================================================================================================
  if (wants('hostile')) {
    const hostile = `# Changelog\n\n## [9.9.9] - 2026-10-09\n\n### <img src=x onerror="window.__pwned=1">Added\n- <img src=x onerror="window.__pwned=2"> and <script>window.__pwned=3</script> and [link](javascript:window.__pwned=4)\n- **bold** and *italic* and \`code\` and <b>not bold</b>\n${'- filler\n'.repeat(5000)}\n## [9.9.8] - 2026-10-08\n### Fixed\n- fine\n`;
    const { context, page } = await visit(DEV);
    await context.route('**/CHANGELOG.md', (route) => route.fulfill({ status: 200, contentType: 'text/markdown', body: hostile }));
    await page.goto(`${DEV}/index.html`);
    await page.locator('[role=dialog]').waitFor();
    await page.keyboard.press('Escape');
    await chipOf(page).click();
    await page.locator('[role=dialog] .about__entry').first().waitFor();
    eq(await page.evaluate(() => window.__pwned), undefined, 'nothing from the file ran');
    eq(await page.locator('[role=dialog] img[src="x"], [role=dialog] script, [role=dialog] .about__news a, [role=dialog] .about__news b').count(), 0, 'no element came from the file');
    const text = await page.locator('[role=dialog] .about__news').innerText();
    ok(text.includes('<img src=x onerror="window.__pwned=2">') && text.includes('<script>window.__pwned=3</script>'), 'the markup is shown as text');
    ok(text.includes('[link](javascript:window.__pwned=4)'), 'a link is just text');
    ok(text.includes('<b>not bold</b>'), 'html bold is text, markdown bold is bold');
    eq(await page.locator('[role=dialog] .about__news strong').first().innerText(), 'bold');
    eq(await page.locator('[role=dialog] .about__body').first().locator('li').count(), 200, 'at most 200 items of one section are shown (5000 were sent)');
    eq(await page.locator('[role=dialog] .about__entry').count(), 2);
    noErrors('hostile');
    await context.close();
  }

  if (wants('hostile')) {
    expectFailures = true;
    const { context, page } = await openApp(DEV);
    // not found: the dialog says so and offers another try
    await context.route('**/CHANGELOG.md', (route) => route.fulfill({ status: 404, body: 'nope' }));
    await chipOf(page).click();
    const warn = page.locator('[role=dialog] .callout--warn');
    await warn.waitFor();
    ok(/was not found/.test(await warn.innerText()) && /GitHub/.test(await warn.innerText()), `not found: ${await warn.innerText()}`);
    eq(await page.locator('[role=dialog] .about__entry').count(), 0);
    await snap(page, 'changes-missing');
    // offline, then back
    await context.unroute('**/CHANGELOG.md');
    await context.route('**/CHANGELOG.md', (route) => route.abort());
    await page.locator('[role=dialog] button', { hasText: 'Try again' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('[role=dialog] .callout--warn', { hasText: 'offline' }).waitFor();
    ok(await focusInside(page), 'after Try again (still offline) the keyboard is on the new Try again button, not on the page behind the dialog');
    eq(await page.evaluate(() => document.activeElement.textContent.trim()), 'Try again');
    await context.unroute('**/CHANGELOG.md');
    await page.keyboard.press('Enter');
    await page.locator('[role=dialog] .about__entry').first().waitFor();
    eq(await page.locator('[role=dialog] .about__entry').count(), entries.length, 'Try again worked');
    ok(await focusInside(page) && await page.evaluate(() => document.activeElement.classList.contains('about__toggle')), 'and the keyboard went to the first version of the list');
    // junk is not a changelog
    await page.keyboard.press('Escape');
    await context.route('**/CHANGELOG.md', (route) => route.fulfill({ status: 200, body: '<html>a login page</html>' }));
    await page.evaluate(() => import('./js/ui/about.js').then((m) => m.loadChangelog({ force: true, fetchFn: () => fetch('CHANGELOG.md') }).catch(() => null)));
    await chipOf(page).click();
    await page.locator('[role=dialog] .callout--warn', { hasText: 'could not be read' }).waitFor();
    expectFailures = false;
    noErrors('changes unavailable');
    await context.close();
  }

  // ================================================================================================================================================
  if (wants('live')) {
    const { context, page } = await openApp(LIVE);
    const chip = chipOf(page);
    eq(await chipText(chip), `v${VERSION} a45ce49`, 'a deployed build: the number and the id of the build (it changes with every deploy, the number only with a release)');
    eq(await chip.getAttribute('data-tip'), 'Build a45ce49, 9 Oct 2026 – click for what is new', 'the tooltip: the build and its day in the viewer\'s zone');
    eq(await chip.getAttribute('aria-label'), `v${VERSION} a45ce49. Show version information and what is new`, 'the spoken name starts with the visible text');
    // the generated build-info.js and the site's version.json say the same
    const [info, served] = await page.evaluate(async () => [{ ...(await import('./js/build-info.js')).BUILD }, await (await fetch('version.json')).json()]);
    eq(info, { version: VERSION, commit: SHA, shortCommit: 'a45ce49', builtAt: '2026-10-09T15:08:00Z', channel: 'live', repository: 'https://github.com/rangulvers/LogiPlan' });
    eq(served, { name: 'logiplan', version: VERSION, commit: SHA, shortCommit: 'a45ce49', builtAt: '2026-10-09T15:08:00Z', channel: 'live', builtFrom: 'main' });
    await page.waitForTimeout(2600);
    eq(versionRequests().filter((u) => u.startsWith(LIVE) && /version\.json\?t=\d+/.test(u)).length, 1, 'one check after start, with a changing query');
    eq(await chip.evaluate((el) => el.classList.contains('is-update')), false, 'the site serves the build that runs: no update');

    await chip.click();
    await page.locator('[role=dialog] .about__entry').first().waitFor();
    const f = await facts(page);
    eq(f.Version, VERSION);
    eq(f.Build, 'a45ce49');
    eq(f.Built, '9 Oct 2026, 17:08 CEST (2026-10-09 15:08 UTC)', 'the build time in the viewer\'s zone and in UTC');
    eq(f['Where it runs'], `Live site (logiplan.test:${livePort})`);
    eq(await page.locator('[role=dialog] dl.kv a').getAttribute('href'), `https://github.com/rangulvers/LogiPlan/commit/${SHA}`, 'the build is a link to its commit');
    eq(await page.locator('[role=dialog] [data-role=about-line]').innerText(), await page.evaluate((v) => `LogiPlan v${v} (a45ce49, built 2026-10-09 15:08 UTC), Chrome ${/Chrome\/(\d+)/.exec(navigator.userAgent)[1]}, window ${innerWidth} x ${innerHeight} on a ${screen.width} x ${screen.height} screen`, VERSION));
    eq(await page.locator('[role=dialog] .about__updatebox, [role=dialog] .callout--info').count(), 0, 'no update box');
    await snap(page, 'dialog-live-desktop-light');

    // an insecure page has no navigator.clipboard: the old copy command is used and gets the line
    eq(await page.evaluate(() => typeof navigator.clipboard), 'undefined');
    await page.evaluate(() => {
      window.__copied = null;
      document.addEventListener('copy', () => { const a = document.activeElement; window.__copied = a && 'value' in a ? a.value.slice(a.selectionStart, a.selectionEnd) : null; });
    });
    await page.locator('[role=dialog] button', { hasText: 'Copy version info' }).click();
    await page.locator('[data-role=about-copied]', { hasText: 'Copied.' }).waitFor();
    eq(await page.evaluate(() => window.__copied), await page.locator('[data-role=about-line]').innerText(), 'the fallback copied the line');
    ok(await page.evaluate(() => document.activeElement.closest('[role=dialog]') !== null), 'the temporary text field is gone and the keyboard is back in the dialog');
    eq(await page.locator('[role=dialog] textarea').count(), 0, 'no leftover field');
    noErrors('live');
    await context.close();
  }

  // ================================================================================================================================================
  if (wants('update')) {
    const newerBody = (over = {}) => JSON.stringify({ name: 'logiplan', version: '0.7.0', commit: NEWER, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z', channel: 'live', builtFrom: 'main', ...over });

    // --- the update appears while a simulation runs, and nothing else happens
    {
      const { context, page } = await visit(LIVE, { permissions: [] });
      await context.route('**/version.json*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: newerBody() }));
      await page.goto(`${LIVE}/index.html`);
      await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
      await page.locator('[role=dialog]').waitFor();
      await page.keyboard.press('Escape');
      await page.evaluate(async () => {
        window.__marker = 'same page';
        await window.__logiplan.ctx.actions.loadExample('starter');
        window.__logiplan.runner.play();
      });
      await page.waitForFunction(() => window.__logiplan.runner.playing && window.__logiplan.runner.time > 0);
      const toastsBefore = await page.locator('.toast').count();
      const timeBefore = await page.evaluate(() => window.__logiplan.runner.time);
      const chip = chipOf(page);
      await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      eq(await chipText(chip), `v${VERSION} a45ce49 Update`, 'the chip: the version, the build and the word Update');
      eq(await page.locator('.versionchip__dot').isVisible(), true, 'and a dot');
      eq(await chip.getAttribute('data-tip'), 'Update available (v0.7.0) – click for details and to reload. Your build: a45ce49, 9 Oct 2026');
      eq(await chip.getAttribute('aria-label'), `v${VERSION} a45ce49 Update. An update is available. Show version information and what is new`);
      eq(await page.evaluate(() => document.documentElement.hasAttribute('data-update')), true, 'the root is marked (the More button of a window without a status line shows a dot)');
      ok(await page.evaluate(() => window.__logiplan.runner.playing), 'the simulation still runs');
      ok(await page.evaluate((t) => window.__logiplan.runner.time > t, timeBefore), 'and it kept going');
      eq(await page.locator('[role=dialog]').count(), 0, 'no dialog came up');
      eq(await page.locator('.toast').count(), toastsBefore, 'no toast either');
      eq(await page.evaluate(() => window.__marker), 'same page', 'the page was not reloaded');
      await snap(page, 'update-chip-desktop-light', { clip: { x: 0, y: DESKTOP.height - 36, width: DESKTOP.width, height: 36 } });

      await chip.click();
      await page.locator('[role=dialog] .callout--info').waitFor();
      const box = await page.locator('[role=dialog] .callout--info').innerText();
      ok(/A newer version is available/.test(box) && /Version 0\.7\.0 \(build b3c4d5e\) is on the site; this page is version 0\.6\.0/.test(box) && /Ctrl\+Shift\+R/.test(box), box);
      ok(/running simulation, its results and the undo history start again/.test(box), `the box says what a reload does not keep: ${box}`);
      await page.locator('[role=dialog] .about__entry').first().waitFor(); // the list loads after the dialog opens
      eq(await page.locator('[role=dialog] .about__entry .chip').allInnerTexts(), ['Your version'], 'the list of changes marks the version that runs');
      await snap(page, 'dialog-update-desktop-light');

      // Reload now: the page reloads and the plant is still there
      const stations = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.length);
      ok(stations > 0);
      await Promise.all([page.waitForNavigation(), page.locator('[role=dialog] button', { hasText: 'Reload now' }).click()]);
      await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
      eq(await page.evaluate(() => window.__marker), undefined, 'the page was reloaded');
      eq(await page.evaluate(() => window.__logiplan.store.getState().layout.stations.length), stations, 'the plant is still there after the reload');
      noErrors('update');
      await context.close();
    }

    // --- a reload that could not save the plant is refused
    {
      const { context, page } = await visit(LIVE);
      await context.route('**/version.json*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: newerBody() }));
      await page.goto(`${LIVE}/index.html`);
      await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
      await page.locator('[role=dialog]').waitFor();
      await page.keyboard.press('Escape');
      await page.evaluate(() => { window.__marker = 'same page'; window.__logiplan.store.renameProject('Edited'); window.__logiplan.store.persist = () => false; });
      await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      await chipOf(page).click();
      await page.locator('[role=dialog] button', { hasText: 'Reload now' }).click();
      await page.locator('.toast', { hasText: 'could not be saved in this browser' }).waitFor();
      await page.waitForTimeout(500);
      eq(await page.evaluate(() => window.__marker), 'same page', 'no reload while the plant cannot be saved');
      await context.close();
    }

    // --- the update appears while the dialog is open, and goes away again
    {
      const { context, page } = await visit(LIVE);
      let answer = newerBody({ commit: SHA, version: VERSION });
      await context.route('**/version.json*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: answer }));
      await page.goto(`${LIVE}/index.html`);
      await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
      await page.locator('[role=dialog]').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(2200);
      await chipOf(page).click();
      await page.locator('[role=dialog] .about__entry').first().waitFor();
      eq(await page.locator('[role=dialog] .callout--info').count(), 0);
      answer = newerBody();
      await page.evaluate(async () => {
        const { createUpdateWatcher } = await import('./js/update-check.js');
        window.__w = createUpdateWatcher({ startDelayMs: 0 });
      });
      eq(await page.evaluate(async () => (await window.__w.check({ force: true })).available), true, 'a second watcher in the same page sees the newer build');
      noErrors('update while open');
      await context.close();
    }

    // --- everything that is not a newer build is silent, in the real browser with real requests
    {
      expectFailures = true;
      const { context, page } = await openApp(LIVE);
      await page.evaluate(async () => {
        const { createUpdateWatcher } = await import('./js/update-check.js');
        window.__check = async () => { const w = createUpdateWatcher({ startDelayMs: 0 }); const s = await w.check({ force: true }); return { available: s.available, checkedAt: s.checkedAt !== null }; };
      });
      const cases = {
        'the same build': (r) => r.fulfill({ status: 200, body: newerBody({ commit: SHA, version: VERSION }) }),
        'an older version': (r) => r.fulfill({ status: 200, body: newerBody({ version: '0.5.0' }) }),
        'not found': (r) => r.fulfill({ status: 404, body: 'Not found' }),
        'a server error': (r) => r.fulfill({ status: 500, body: 'oops' }),
        'no connection': (r) => r.abort(),
        'a login page': (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>please sign in</html>' }),
        'an empty answer': (r) => r.fulfill({ status: 200, body: '' }),
        'json of the wrong kind': (r) => r.fulfill({ status: 200, body: '[1,2,3]' }),
        'a commit that is no commit': (r) => r.fulfill({ status: 200, body: newerBody({ commit: '<img src=x onerror=alert(1)>' }) }),
        'a version that is no version': (r) => r.fulfill({ status: 200, body: newerBody({ version: 'latest' }) }),
        'numbers instead of text': (r) => r.fulfill({ status: 200, body: JSON.stringify({ commit: 1234567, version: 7 }) }),
        'a huge answer': (r) => r.fulfill({ status: 200, body: JSON.stringify({ commit: NEWER, version: '0.7.0', pad: 'x'.repeat(200000) }) }),
        'prototype keys': (r) => r.fulfill({ status: 200, body: `{"__proto__":{"commit":"${NEWER}","version":"9.9.9"},"constructor":{"prototype":{"commit":"${NEWER}"}}}` }),
      };
      for (const [name, handler] of Object.entries(cases)) {
        await context.unroute('**/version.json*').catch(() => {});
        await context.route('**/version.json*', handler);
        const result = await page.evaluate(() => window.__check());
        eq(result.available, false, `${name}: silent`);
      }
      await context.unroute('**/version.json*');
      await context.route('**/version.json*', (r) => r.fulfill({ status: 200, body: newerBody() }));
      eq((await page.evaluate(() => window.__check())).available, true, 'and a real update is still found');
      eq(await page.evaluate(() => window.__marker), 'same page');
      eq(await page.locator('.toast').count(), 0, 'not one of them made a toast');
      expectFailures = false;
      noErrors('silent failures');
      await context.close();
    }

    // --- the whole app with junk instead of version.json: no chip state, no message, no error
    {
      expectFailures = true;
      const { context, page } = await visit(LIVE);
      await context.route('**/version.json*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"commit": "oops' }));
      await page.goto(`${LIVE}/index.html`);
      await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
      await page.locator('[role=dialog]').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(2800);
      eq(await chipOf(page).evaluate((el) => el.classList.contains('is-update')), false);
      eq(await page.locator('.toast').count(), 0);
      expectFailures = false;
      noErrors('junk version.json');
      await context.close();
    }
  }

  // ================================================================================================================================================
  if (wants('menu')) {
    const { context, page } = await openApp(DEV, { viewport: NARROW });
    await page.locator('[aria-label="More actions"]').click();
    await page.locator('.menu__item', { hasText: 'About and what is new' }).click();
    await page.locator('[role=dialog] .about__entry').first().waitFor();
    eq((await page.locator('[role=dialog] .modal__title').innerText()), 'About LogiPlan');
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body), 'the keyboard has a place to be after the dialog closes');
    noErrors('menu');
    await context.close();

    // a phone held sideways (and any window lower than 521 px: 200 % zoom on a Full HD monitor, a laptop at 125 %) hides the status line and the chip in it:
    // the More menu is there at every width then, and Help leads to the dialog too
    const sideways = await openApp(DEV, { viewport: { width: 915, height: 412 } });
    eq(await chipOf(sideways.page).isVisible(), false, 'the status line is hidden on a phone held sideways');
    eq(await sideways.page.locator('[aria-label="More actions"]').isVisible(), true, 'and the More menu takes over');
    await sideways.page.locator('[aria-label="More actions"]').click();
    await sideways.page.locator('.menu__item', { hasText: 'About and what is new' }).click();
    await sideways.page.locator('[role=dialog] .about__entry').first().waitFor();
    eq(await sideways.page.locator('[role=dialog] .modal__title').innerText(), 'About LogiPlan', 'About and what is new is in the More menu');
    await sideways.page.keyboard.press('Escape');
    await sideways.page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await sideways.page.keyboard.press('?');
    await sideways.page.locator('[role=dialog] .modal__title', { hasText: 'Help' }).waitFor();
    await sideways.page.locator('[role=dialog] [data-role=help-about]').click();
    await sideways.page.locator('[role=dialog] .about__entry').first().waitFor();
    eq(await sideways.page.locator('[role=dialog]').count(), 1, 'Help closed, About opened');
    eq(await sideways.page.locator('[role=dialog] .modal__title').innerText(), 'About LogiPlan');
    await settle(sideways.page);
    const fit = await sideways.page.evaluate(() => { const r = document.querySelector('[role=dialog]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    ok(fit, 'the dialog fits a window that is 412 px high');
    await snap(sideways.page, 'dialog-sideways-phone');
    await sideways.page.keyboard.press('Escape');
    await sideways.page.locator('[role=dialog]').waitFor({ state: 'detached' });
    ok(await sideways.page.evaluate(() => document.activeElement && document.activeElement.closest('.topbar') !== null), 'the keyboard is back on the button in the top bar that it came from (More here)');
    noErrors('sideways');
    await sideways.context.close();
  }

  // ================================================================================================================================================
  if (wants('report')) {
    const { context, page } = await openApp(LIVE);
    await page.evaluate(() => window.__logiplan.ctx.actions.loadExample('starter'));
    const out = await page.evaluate(async () => {
      const { exportReportHtml } = await import('./js/ui/report.js');
      const { exportProject, shareUrl } = await import('./js/model/serialize.js');
      const project = window.__logiplan.store.getState().project;
      return { footer: /<footer>(.*?)<\/footer>/s.exec(exportReportHtml(window.__logiplan.ctx)).slice(1)[0], file: exportProject(project), link: await shareUrl(location.href.split('#')[0], project) };
    });
    ok(out.footer.includes('<span>Generated with LogiPlan v' + VERSION + ' (a45ce49)</span>'), out.footer);
    ok(!out.file.includes('a45ce49') && !out.file.includes(NEWER) && !/"version"|"commit"|"build"/.test(out.file), 'the project file does not carry the version');
    ok(!out.link.includes('a45ce49'), 'nor does the share link');
    noErrors('report');
    await context.close();
  }

  // ================================================================================================================================================
  if (wants('layout')) {
    const contrast = (page, selector) => page.evaluate((sel) => {
      const lum = ([r, g, b]) => { const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const rgba = (s) => (s.match(/[\d.]+/g) || []).map(Number);
      const el = document.querySelector(sel);
      const fg = rgba(getComputedStyle(el).color);
      let node = el;
      let bg = [0, 0, 0, 0];
      while (node && bg[3] === 0) { bg = rgba(getComputedStyle(node).backgroundColor); if (bg.length === 3) bg.push(1); if (bg.length < 4) bg = [0, 0, 0, 0]; node = node.parentElement; }
      const a = lum(fg);
      const b = lum(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }, selector);

    for (const [name, viewport, colorScheme] of [['desktop-light', DESKTOP, 'light'], ['desktop-dark', DESKTOP, 'dark'], ['narrow-light', NARROW, 'light'], ['narrow-dark', NARROW, 'dark']]) {
      for (const [kind, origin] of [['dev', DEV], ['live', LIVE]]) {
        if (kind === 'live' && !name.startsWith('desktop-light') && !name.startsWith('narrow')) continue;
        const { context, page } = await openApp(origin, { viewport, colorScheme });
        const chip = chipOf(page);
        const box = await chip.boundingBox();
        ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${kind} ${name}: the chip is inside the window ${JSON.stringify(box)}`);
        ok(box.height >= 24 && box.width >= 40, `${kind} ${name}: big enough to hit (${box.width} x ${box.height}; on a touch screen 40 high, see compat in about-review)`);
        ok(box.y > viewport.height - 70, `${kind} ${name}: at the bottom, in the status line`);
        const ratio = await contrast(page, '.versionchip');
        ok(ratio >= 4.5, `${kind} ${name}: readable, contrast ${ratio.toFixed(2)}`);
        eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${kind} ${name}: nothing scrolls sideways`);
        const parts = await page.evaluate(() => [...document.querySelector('.statusbar').children].map((c) => { const r = c.getBoundingClientRect(); return [c.className.split(' ')[0], Math.round(r.left), Math.round(r.right)]; }));
        for (let i = 1; i < parts.length; i++) ok(parts[i][1] >= parts[i - 1][2] - 1, `${kind} ${name}: the status line parts do not overlap ${JSON.stringify(parts)}`);
        await page.keyboard.press('Shift');
        await chip.focus();
        const ring = await chip.evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
        ok(ring.style !== 'none' && ring.width >= 2, `${kind} ${name}: a visible focus ring ${JSON.stringify(ring)}`);
        await snap(page, `chip-${kind}-${name}`);
        await chip.click();
        await page.locator('[role=dialog] .about__entry').first().waitFor();
        await settle(page); // the dialog slides in; measure it where it stays
        const modal = await page.evaluate(() => {
          const m = document.querySelector('[role=dialog]');
          const body = m.querySelector('.modal__body');
          const close = m.querySelector('.modal__footer button').getBoundingClientRect();
          const r = m.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, overflowX: body.scrollWidth > body.clientWidth + 1, closeBottom: close.bottom, closeVisible: close.top >= 0 && close.bottom <= innerHeight };
        });
        ok(modal.left >= 0 && modal.right <= viewport.width && modal.top >= 0 && modal.bottom <= viewport.height, `${kind} ${name}: the dialog fits the window ${JSON.stringify(modal)}`);
        eq(modal.overflowX, false, `${kind} ${name}: the dialog does not scroll sideways`);
        ok(modal.closeVisible, `${kind} ${name}: Close is on screen`);
        const dialogRatio = await contrast(page, '[role=dialog] .about__tagline');
        ok(dialogRatio >= 4.5, `${kind} ${name}: the dialog text is readable (${dialogRatio.toFixed(2)})`);
        await snap(page, `dialog-${kind}-${name}`);
        await context.close();
      }
    }

    // the update state in both themes and narrow
    for (const [name, viewport, colorScheme] of [['desktop-dark', DESKTOP, 'dark'], ['narrow-light', NARROW, 'light'], ['narrow-dark', NARROW, 'dark']]) {
      const { context, page } = await visit(LIVE, { viewport, colorScheme });
      await context.route('**/version.json*', (route) => route.fulfill({ status: 200, body: JSON.stringify({ name: 'logiplan', version: '0.7.0', commit: NEWER, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z', channel: 'live', builtFrom: 'main' }) }));
      await page.goto(`${LIVE}/index.html`);
      await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
      await page.locator('[role=dialog]').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('.versionchip')?.classList.contains('is-update'));
      const box = await chipOf(page).boundingBox();
      ok(box.x >= 0 && box.x + box.width <= viewport.width, `update ${name}: the chip with its mark is inside the window ${JSON.stringify(box)}`);
      const ratio = await contrast(page, '.versionchip__hint');
      ok(ratio >= 4.5, `update ${name}: the word Update is readable (${ratio.toFixed(2)})`);
      eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `update ${name}: nothing scrolls sideways`);
      await snap(page, `update-chip-${name}`);
      await chipOf(page).click();
      await page.locator('[role=dialog] .callout--info').waitFor();
      const reload = await page.locator('[role=dialog] button', { hasText: 'Reload now' }).boundingBox();
      ok(reload.x >= 0 && reload.x + reload.width <= viewport.width, `update ${name}: the Reload button is inside the window`);
      await snap(page, `dialog-update-${name}`);
      await context.close();
    }
    noErrors('layout');
  }

  console.log(`about: ${checks} checks passed${only ? ` (section ${only})` : ''}`);
} finally {
  await browser.close();
  await new Promise((r) => devServer.close(r));
  await new Promise((r) => liveServer.close(r));
  rmSync(tmp, { recursive: true, force: true });
}
