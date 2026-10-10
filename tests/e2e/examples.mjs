// The examples ladder in the REAL app (index.html + js/main.js) in real Chromium (docs/EXAMPLES-DESIGN.md 7 and 8.7): the gallery of the welcome dialog, the
// Examples page of the Help dialog and the toast action that leads to it, and a smoke run of every example.
//
//   gallery   five level headings in order, one card per example sorted by level and rank (hello-pallet first), a level badge with text, the learn line, at most three
//             chips, the facts line; the twin plants card spans two columns on a wide dialog and one on a phone; the description of a new example fits its three lines and
//             the tooltip holds the full text; Tab and Enter work on the cards; contrast of badge, learn line and chips in light and dark; nothing scrolls sideways
//             at 1440 x 900 and 390 x 844 (screenshots in e2e-output/examples-*.png: open them and look)
//   tips      opening an example shows a toast with the action "Things to try"; it opens Help > Examples scrolled to that example (its heading has the focus); the page
//             lists every example with the tips of the registry and "Open this example" loads one and closes the Help; the page works with the keyboard
//   smoke     every example opens from its card, runs at 600x or 1200x past its warm-up, the clock advances, the Results tab shows figures, no console error or warning
//
// Run: node tests/e2e/examples.mjs [gallery|tips|smoke]
import assert from 'node:assert/strict';
import { withBrowser } from './browser.mjs';
import { EXAMPLES } from '../../js/model/examples.js';
import { EXAMPLE_LEVELS, sortExamples, levelBadgeText, cardChips } from '../../js/ui/examples-gallery.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const wants = (name) => !only || only === name;
const ordered = sortExamples(EXAMPLES);

/** Contrast ratio (WCAG) of the text colour of `selector`'s first match against the first opaque background above it. */
const CONTRAST = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  let bg = { r: 255, g: 255, b: 255, a: 1 };
  const chain = [];
  for (let n = el; n; n = n.parentElement) chain.push(getComputedStyle(n).backgroundColor);
  for (const c of chain.reverse()) { const p = parse(c); if (p.a > 0) bg = over(p, bg); }
  const fg = over(parse(getComputedStyle(el).color), bg);
  const a = lum(fg) + 0.05; const b = lum(bg) + 0.05;
  return Math.max(a, b) / Math.min(a, b);
}`;

async function openGallery(page, url) {
  await page.goto(url('/index.html'));
  await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready');
  await page.waitForTimeout(300);
  if (!(await page.locator('[role=dialog]').count())) await page.getByRole('button', { name: 'Examples' }).first().click();
  await page.locator('[role=dialog] [data-example]').first().waitFor();
  await page.waitForFunction((n) => document.querySelectorAll('[role=dialog] [data-example] img').length === n, EXAMPLES.length, { timeout: 30000 });
}

// ---------------------------------------------------------------------------------------------------------------------------------
if (wants('gallery')) {
  console.log('-- gallery');
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    for (const theme of ['light', 'dark']) {
      await withBrowser(async ({ page, url, errors, shot }) => {
        await page.emulateMedia({ colorScheme: theme });
        await openGallery(page, url);
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        const d = page.locator('[role=dialog]');
        const tag = `${name} ${theme}`;

        eq(await d.locator('.example-level__title').allInnerTexts(), EXAMPLE_LEVELS.map((l) => `${l.level}. ${l.title}`), `${tag}: the five headings in order`);
        eq(await d.locator('h4.example-level__title').count(), 5, `${tag}: the headings are real headings`);
        eq(await d.locator('[data-example]').evaluateAll((els) => els.map((e) => e.dataset.example)), ordered.map((e) => e.id), `${tag}: one card per example, by level and rank`);
        eq(await d.locator('[data-example]').first().getAttribute('data-example'), 'hello-pallet', `${tag}: the simplest example comes first`);
        // each card sits under the heading of its own level
        eq(await d.locator('.example-level').evaluateAll((secs) => secs.map((s) => [s.dataset.level, [...s.querySelectorAll('[data-example]')].map((c) => c.dataset.example)])),
          EXAMPLE_LEVELS.map((l) => [String(l.level), ordered.filter((e) => e.level === l.level).map((e) => e.id)]), `${tag}: cards grouped by level`);
        eq(await d.locator('.example-level').evaluateAll((secs) => secs.every((s) => document.getElementById(s.getAttribute('aria-labelledby')))), true, `${tag}: every section is labelled by its heading`);

        for (const example of EXAMPLES) {
          const card = d.locator(`[data-example="${example.id}"]`);
          eq(await card.locator('[data-role=level-badge]').innerText(), levelBadgeText(example.level).toUpperCase(), `${tag} ${example.id}: level badge text`);
          eq(await card.locator('[data-role=learn]').innerText(), example.learn, `${tag} ${example.id}: learn line`);
          eq(await card.locator('[data-role=chips] .chip').allInnerTexts(), cardChips(example), `${tag} ${example.id}: at most three chips`);
          ok(/\d+ stations? · \d+ flows?/.test(await card.innerText()), `${tag} ${example.id}: facts line`);
          eq(await card.locator('[data-role=description]').getAttribute('title'), example.description, `${tag} ${example.id}: the tooltip holds the full description`);
          eq(await card.locator('.example-dots').getAttribute('aria-hidden'), 'true', `${tag} ${example.id}: the dots are decoration`);
        }

        // the twin plants card: two columns when there is room, one on a phone
        const grid = await d.locator('[data-level="5"] .example-grid').boundingBox();
        const twin = await d.locator('[data-example="twin-plants"]').boundingBox();
        const normal = await d.locator('[data-example="hello-pallet"]').boundingBox();
        if (name === 'desktop') ok(twin.width > normal.width * 1.9, `${tag}: the twin plants card spans two columns (${twin.width} against ${normal.width})`);
        else ok(Math.abs(twin.width - grid.width) < 2 && Math.abs(normal.width - grid.width) < 2, `${tag}: one column on a phone (${twin.width} of ${grid.width})`);
        eq(await d.locator('.example-card--wide').evaluateAll((els) => els.map((e) => e.dataset.example)), ['twin-plants'], `${tag}: only the twin plants card is wide`);

        // the description of a new example fits its three lines at the card width (the old five clip at the third line by design)
        if (name === 'desktop') {
          for (const example of EXAMPLES.slice(5)) {
            const clipped = await d.locator(`[data-example="${example.id}"] [data-role=description]`).evaluate((el) => el.scrollHeight - el.clientHeight);
            ok(clipped <= 1, `${tag} ${example.id}: the description fits three lines (clipped by ${clipped} px)`);
          }
        }

        // contrast of the new texts
        for (const selector of ['[data-example="hello-pallet"] [data-role=level-badge] span:last-child', '[data-example="hello-pallet"] [data-role=learn]', '[data-example="hello-pallet"] [data-role=chips] .chip',
          '[data-level="1"] .example-level__caption', '[data-example="charging-corner"] [data-role=description]']) {
          const ratio = await page.evaluate(`(${CONTRAST})(${JSON.stringify(selector)})`);
          ok(ratio >= 4.5, `${tag}: ${selector} contrast ${ratio?.toFixed(2)}`);
        }

        // nothing scrolls sideways, in the dialog or in the window
        eq(await page.evaluate(() => { const b = document.querySelector('.modal__body'); return [b.scrollWidth - b.clientWidth, document.documentElement.scrollWidth - innerWidth]; }), [0, 0], `${tag}: nothing scrolls sideways`);

        // keyboard: the first card has the focus, Tab goes to the next one (a button), Enter opens the example
        eq(await page.evaluate(() => document.activeElement?.dataset?.example), 'hello-pallet', `${tag}: the first card has the focus`);
        await page.keyboard.press('Tab');
        eq(await page.evaluate(() => document.activeElement?.dataset?.example), ordered[1].id, `${tag}: Tab moves to the next card`);
        ok(await page.evaluate(() => document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent.includes(document.activeElement.querySelector('strong').textContent)), `${tag}: a card is a button named by its text`);

        await shot(`examples-gallery-${name}-${theme}-top`);
        await d.locator('[data-example="twin-plants"]').scrollIntoViewIfNeeded();
        await shot(`examples-gallery-${name}-${theme}-twin`);
        eq(errors, [], `${tag}: no console errors`);
      }, { viewport });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
if (wants('tips')) {
  console.log('-- tips');
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    await withBrowser(async ({ page, url, errors, shot }) => {
      await openGallery(page, url);
      const d = page.locator('[role=dialog]');
      // keyboard: Enter on the focused card opens the example
      await page.keyboard.press('Enter');
      await d.waitFor({ state: 'detached' });
      const toast = page.locator('.toast', { hasText: 'Opened the example' });
      await toast.waitFor();
      const action = toast.locator('.toast__action');
      eq(await action.innerText(), 'Things to try', `${name}: the toast offers the tips`);
      const box = await action.boundingBox();
      ok(box.x >= 0 && box.x + box.width <= viewport.width && box.height >= 20, `${name}: the action is inside the window and big enough ${JSON.stringify(box)}`);
      await shot(`examples-toast-${name}`);
      await action.click();
      const help = page.locator('[role=dialog]');
      await help.waitFor();
      eq(await help.getByRole('tab', { selected: true }).innerText(), 'Examples', `${name}: the Help opens on the Examples page`);
      eq(await page.evaluate(() => document.activeElement?.textContent), 'Hello, pallet: one forklift, one road', `${name}: the heading of the example has the focus`);
      eq(await help.locator('#help-example-hello-pallet ol > li').allInnerTexts(), EXAMPLES.find((e) => e.id === 'hello-pallet').tips, `${name}: its tips`);
      eq(await help.locator('.example-help').count(), EXAMPLES.length, `${name}: every example is on the page`);
      ok((await help.locator('.modal__body').innerText()).includes('Set the speed in the bar above the plan to 600×'), `${name}: the page says how to read the figures`);
      eq(await page.evaluate(() => { const b = document.querySelector('.modal__body'); return b.scrollWidth - b.clientWidth; }), 0, `${name}: nothing scrolls sideways`);
      await page.waitForTimeout(450); // the dialog has finished fading in
      await shot(`examples-help-${name}`);
      // another example from the page: the button opens it and closes the Help
      const open = help.locator('#help-example-charging-corner').getByRole('button', { name: /Open this example/ });
      await open.scrollIntoViewIfNeeded();
      await open.focus();
      await page.keyboard.press('Enter');
      const confirm = page.locator('[role=dialog]').getByRole('button', { name: 'Open example' });
      if (await confirm.count()) await confirm.click();
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
      eq(await page.evaluate(() => window.__logiplan.store.getState().project.name), EXAMPLES.find((e) => e.id === 'charging-corner').build().name, `${name}: the example of the page is open`);
      // the tab list works with the arrow keys
      await page.evaluate(() => window.__logiplan.ctx.dialogs.openHelp());
      await page.getByRole('tab', { name: 'Examples' }).click();
      await page.keyboard.press('ArrowRight');
      eq(await page.locator('[role=dialog]').getByRole('tab', { selected: true }).innerText(), 'Quick start', `${name}: the arrow keys wrap around from the last tab (Examples)`);
      await page.keyboard.press('Escape');
      eq(errors, [], `${name}: no console errors`);
    }, { viewport });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
if (wants('smoke')) {
  console.log('-- smoke');
  await withBrowser(async ({ page, url, errors }) => {
    await openGallery(page, url);
    for (const example of ordered) {
      if (!(await page.locator('[role=dialog]').count())) await page.getByRole('button', { name: 'Examples' }).first().click();
      await page.locator(`[role=dialog] [data-example="${example.id}"]`).click();
      const confirm = page.locator('[role=dialog]').getByRole('button', { name: 'Open example' });
      if (await confirm.count()) await confirm.click();
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
      const layout = example.build();
      eq(await page.evaluate(() => window.__logiplan.store.getState().project.name), layout.name, `${example.id}: opened from its card`);
      // run past the warm-up and 20 simulated minutes at 1200x
      const target = layout.settings.warmup + 1200;
      await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(1200); await r.play(); });
      await page.waitForFunction((s) => window.__logiplan.runner.time >= s, target, { timeout: 120000 });
      await page.evaluate(() => window.__logiplan.runner.pause());
      ok(await page.evaluate(() => window.__logiplan.runner.time) >= target, `${example.id}: the clock advanced past the warm-up`);
      await page.locator('[data-tab=results]').click();
      await page.locator('#panel-results').waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      const text = await page.locator('#panel-results').innerText();
      ok(!/Not counted yet|No data yet/.test(text), `${example.id}: the Results tab shows figures once the warm-up is over`);
      eq(errors.splice(0), [], `${example.id}: no console error or warning`);
    }
  });
}

console.log(`examples: ${checks} checks passed${only ? ` (section ${only})` : ''}`);
