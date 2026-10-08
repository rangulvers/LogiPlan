// Behavioural check of js/ui/panels/fields.js in real Chromium.  Run: node tests/e2e/fields.mjs
import assert from 'node:assert/strict';
import { withBrowser } from './browser.mjs';

await withBrowser(async ({ page, url, errors, shot }) => {
  await page.goto(url('/tests/e2e/fields-harness.html'));
  await page.waitForFunction(() => window.ready);
  const log = () => page.evaluate(() => window.__log.splice(0));

  // number: valid typing fires onChange live; invalid shows an error and is reverted on blur
  const num = page.locator('input[type=number]').first();
  await num.fill('25');
  assert.deepEqual(await log(), [['num', 25]]);
  await num.fill('500');
  assert.deepEqual(await log(), [], 'out-of-range must not commit');
  assert.ok(await page.locator('.field.is-invalid .field__error').first().isVisible());
  await num.blur();
  assert.equal(await num.inputValue(), '25', 'reverted to last valid value on blur');
  assert.equal(await page.locator('.field.is-invalid').count(), 0);

  // set() must not clobber a focused field, but updates it after blur
  await num.focus(); await num.fill('7');
  await page.evaluate(() => window.f.num.set(42));
  assert.equal(await num.inputValue(), '7');
  await num.blur();
  await page.evaluate(() => window.f.num.set(42));
  assert.equal(await num.inputValue(), '42');
  await log();

  // integer field rejects fractions
  const int = page.locator('input[type=number]').nth(1);
  await int.fill('2.5'); assert.deepEqual(await log(), []);
  await int.fill('3'); assert.deepEqual(await log(), [['int', 3]]);

  // select keeps number typing
  await page.locator('select').first().selectOption('2');
  assert.deepEqual(await log(), [['sel', 2]]);

  // range: fill var, bubble and reset button
  const wrap = page.locator('.range').first();
  assert.equal(await wrap.getAttribute('data-value'), '1.50x');
  await page.evaluate(() => { const i = document.querySelector('.range input'); i.value = '1'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.deepEqual(await log(), [['rng', 1]]);
  assert.ok(await page.locator('button:has-text("Reset")').first().isHidden(), 'reset hidden at default');
  await page.evaluate(() => { const i = document.querySelector('.range input'); i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await log();
  await page.locator('button:has-text("Reset")').first().click();
  assert.deepEqual(await log(), [['rng', 1]]);
  assert.equal(await page.locator('.range input').inputValue(), '1');

  // switch, segmented, stepper
  await page.locator('.switch').first().click(); assert.deepEqual(await log(), [['sw', true]]);
  await page.locator('.segmented__item:has-text("Left")').click(); assert.deepEqual(await log(), [['seg', 'left']]);
  assert.equal(await page.locator('.segmented__item:has-text("Left")').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.segmented__item:has-text("Right")').getAttribute('aria-pressed'), 'false');
  await page.locator('button[aria-label^="Increase"]').click(); assert.deepEqual(await log(), [['step', 4]]);
  for (let i = 0; i < 30; i++) await page.locator('button[aria-label^="Increase"]').click();
  assert.equal(await page.evaluate(() => window.f.step.get()), 20, 'stepper clamps at max');
  await log();

  // distribution editor: switching to exponential hides spread, emits a complete object
  await page.locator('select').nth(1).selectOption('exp');
  const [[, d]] = await log();
  assert.equal(d.kind, 'exp'); assert.equal(d.spread, 0); assert.equal(d.mean, 90);
  assert.ok(await page.locator('.field-grid .field').nth(1).isHidden());
  await page.locator('select').nth(1).selectOption('uniform');
  assert.ok(await page.locator('.field-grid .field').nth(1).isVisible());

  await shot('fields');
  assert.deepEqual(errors, []);
  console.log('fields.js: all browser checks passed');
});
