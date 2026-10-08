// Behavioural + visual check of the Results dashboard (js/ui/dashboard.js) in real Chromium.
// Run: node tests/e2e/dashboard.mjs [section]
//   sections: real inplace hidden null states many interact runner perf contrast shots
// Screenshots: e2e-output/dashboard-*.png (open them and look). The dashboard is fed with REAL reports from the real
// simulation engine (js/sim/engine.js + js/model/examples.js) wherever the content matters; synthetic reports are used
// for sizes the examples do not reach (12 fleets, 30 stations, long names) and for hostile input (null everywhere).
// Only the shell is faked (tests/e2e/dashboard-harness.html): a runner stand-in with the real runner's caching, plus the
// real createRunner in the `runner` section.
import assert from 'node:assert/strict';
import { withBrowser } from './browser.mjs';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const HARNESS = '/tests/e2e/dashboard-harness.html';
const DASH = '–';

await withBrowser(async ({ page, url, errors, shot }) => {
  // ---- helpers -----------------------------------------------------------------------------------------------
  const open = async (query, viewport) => {
    if (viewport) await page.setViewportSize(viewport);
    await page.goto(url(`${HARNESS}?${query}`));
    await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(150);
  };
  const H = (fn, arg) => page.evaluate(fn, arg);
  const calls = () => H(() => structuredClone(window.harness.calls));
  const heat = () => H(() => window.harness.store.getState().ui.overlays.heat);
  const count = (sel) => page.locator(sel).count();
  const text = (sel) => page.locator(sel).first().innerText();
  const kpi = (id) => page.locator(`[data-kpi="${id}"]`);
  const kpiValue = (id) => kpi(id).locator('.kpi__value').innerText().then((t) => t.replace(/\s+/g, ' ').trim());
  const chip = () => text('.dash__status .chip');
  const visibleRows = () => H(() => [...document.querySelectorAll('[data-station]')].filter((r) => !r.hidden).map((r) => r.dataset.station));
  const names = () => H(() => [...document.querySelectorAll('[data-station]')].filter((r) => !r.hidden).map((r) => r.querySelector('.dash-link').textContent));
  const usedOf = () => H(() => [...document.querySelectorAll('[data-station]')].filter((r) => !r.hidden).map((r) => parseFloat(r.children[2].textContent)));
  const noOverflow = (msg) => H(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    dash: document.querySelector('.dash').scrollWidth - document.querySelector('.dash').clientWidth,
    wraps: [...document.querySelectorAll('.dash .table-wrap')].map((w) => w.scrollWidth - w.clientWidth),
  })).then((o) => { ok(o.page <= 0 && o.dash <= 0 && o.wraps.every((d) => d <= 1), `${msg}: horizontal overflow ${JSON.stringify(o)}`); });
  /** Count DOM mutations (childList, attributes, text) in the dashboard while `fn` runs. */
  const mutations = async (fn) => {
    await H(() => {
      window.__mut = 0;
      window.__obs = new MutationObserver((list) => { window.__mut += list.length; });
      window.__obs.observe(document.querySelector('.dash'), { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await fn();
    return H(() => { window.__obs.takeRecords().forEach(() => { window.__mut++; }); window.__obs.disconnect(); return window.__mut; });
  };
  const shotPane = async (name, query, viewport, { full = true } = {}) => {
    await open(`${query}${full ? '&tall=1' : ''}`, viewport);
    return shot(`dashboard-${name}`, { fullPage: full });
  };
  const run = async (name, fn) => {
    if (only && only !== name) return;
    console.log(`-- ${name}`);
    await fn();
  };

  // ============================================================================================ real simulation
  await run('real', async () => {
    await open('mode=real&example=two-lines&advance=3600&theme=light', { width: 1440, height: 900 });
    const layout = await H(() => { const l = window.harness.store.getState().layout; return { fleets: l.fleets.length, flows: l.flows.length }; });
    eq(await count('.dash-kpi'), 6, 'six headline cards');
    for (const id of ['throughput', 'leadTime', 'wip', 'fleet', 'traffic', 'deadlocks']) ok((await kpiValue(id)) !== DASH, `KPI ${id} has a value`);
    const report = await H(() => window.harness.report());
    const first = parseFloat(await kpiValue('throughput'));
    ok(Math.abs(first - report.throughput.perHour) < 0.6, `throughput card ${first} vs report ${report.throughput.perHour}`);
    const util = Object.values(report.fleets).reduce((a, f) => a + f.utilization * f.count, 0) / Object.values(report.fleets).reduce((a, f) => a + f.count, 0);
    ok(Math.abs(parseFloat(await kpiValue('fleet')) - util * 100) < 0.6, 'fleet utilization card is the vehicle-weighted mean');
    eq(await count('details.dash-sec'), 6, 'six sections');
    eq(await count('details.dash-sec[open]'), 6, 'all open by default');
    eq(await count('.dash-fleet'), layout.fleets, 'one card per fleet');
    eq(await count('[data-flow]'), layout.flows, 'one row per flow');
    const stationNames = Object.values(report.stations).filter((s) => ['process', 'storage'].includes(s.type)).map((s) => s.name).sort();
    eq((await H(() => [...document.querySelectorAll('[data-station] .dash-link')].map((l) => l.textContent))).sort(), stationNames, 'the table lists workstations and buffers only');
    const used = await usedOf();
    eq(used, [...used].sort((a, b) => b - a), 'rows sorted by utilization');
    ok((await count('.dash-spot')) >= 1, 'hot spots listed');
    const zero = await H(() => Object.entries(window.harness.report().stations).filter(([, st]) => st.type === 'process').map(([id, st]) => [st.down < 0.002, document.querySelector(`[data-station="${id}"] .tone-down`).hidden]));
    ok(zero.length > 0 && zero.every(([none, hidden]) => none === hidden), 'a state without any time has no sliver in the mini bar');
    ok((await page.locator('.dash-spot__val').first().getAttribute('title')).endsWith('of waiting, all vehicles added up'), 'hot spot carries the exact seconds');
    ok(await page.locator('.dash-chart canvas').first().isVisible(), 'charts are drawn');
    eq(await chip(), 'Paused', 'paused chip');
    await H(() => window.harness.setPlaying(true));
    eq(await chip(), 'Running', 'running chip');
    ok(/chip--good/.test(await page.locator('.dash__status .chip').getAttribute('class')), 'running chip is green');
    const clock = await text('.dash__status .dash__meta');
    ok(/^(0:59:5\d|1:00:00)$/.test(clock), `simulated clock after one hour: ${clock}`);
    const insights = await H(() => window.harness.runner.insights().length);
    eq(await count('.dash-insight'), Math.min(insights, 6), 'insights listed (max 6)');
    eq(await text('.dash-sec[data-section="insights"] .section__aside'), `${insights} ${insights === 1 ? 'insight' : 'insights'}`, 'insight count');
    // The congestion lab has real congestion: critical traffic insight, hot spots, a saturated fleet.
    await open('mode=real&example=congestion-lab&advance=3600');
    ok((await text('.dash-insight')).length > 20, 'congestion insight text');
    ok(/critical|callout--error/.test(await page.locator('.dash-insight').first().getAttribute('class')), 'most severe insight first');
    eq(await text('[data-kpi="traffic"] .dash-status'), 'Congested', 'traffic status word');
    eq(await count('.dash-spot'), 10, 'ten hot spots');
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ in-place updates
  await run('inplace', async () => {
    await open('mode=real&example=two-lines&advance=1800', { width: 1440, height: 900 });
    const tag = () => H(() => { window.__idCounter ||= 0; let n = 0; for (const el of document.querySelectorAll('.dash *')) { if (!el.__id) el.__id = ++window.__idCounter; n++; } return n; });
    const before = await tag();
    const snap = () => H(() => ({
      canvases: [...document.querySelectorAll('.dash canvas')].map((c) => c.__id),
      keyed: [...document.querySelectorAll('[data-kpi],[data-fleet],[data-station],[data-flow],[data-section]')].map((e) => e.__id),
      clock: document.querySelector('.dash__status .dash__meta').textContent,
      measured: document.querySelector('.dash__status').lastElementChild.textContent,
      cards: [...document.querySelectorAll('.kpi__value')].map((e) => e.textContent),
    }));
    const a = await snap();
    await H(() => window.harness.advance(600));
    const b = await snap();
    eq(b.canvases, a.canvases, 'charts and sparklines are not re-created');
    eq(b.keyed, a.keyed, 'cards, rows and sections keep their element identity');
    ok(b.clock !== a.clock && b.measured !== a.measured, 'clock and measured window moved');
    ok(!b.keyed.includes(undefined) && !b.canvases.includes(undefined), 'no new keyed elements appeared');
    const after = await H(() => document.querySelectorAll('.dash *').length);
    ok(Math.abs(after - before) <= 40, `element count stays about the same (${before} -> ${after})`);
    // Same report again: not a single DOM write.
    const idle = await mutations(() => H(() => { window.harness.tick(); window.harness.tick(); window.dispatchEvent(new Event('resize')); }));
    eq(idle, 0, 'an unchanged report writes nothing to the DOM');
    // A new report whose numbers are the same still writes (almost) nothing: text is only set when it differs.
    const paused = await mutations(() => H(() => { window.harness.runner.touch(); window.harness.tick(); }));
    ok(paused <= 6, `re-reading an identical report writes at most a few attributes (${paused})`);
    // A collapsed section is not painted; it catches up when it is opened.
    await page.locator('[data-section="stations"] > summary').click();
    const closed = await mutations(() => H(() => window.harness.advance(300)));
    await H(() => window.harness.advance(300));
    const hiddenRows = await H(() => document.querySelector('[data-section="stations"]').open);
    eq(hiddenRows, false, 'section collapsed');
    const stale = await page.locator('[data-station]').first().locator('td').nth(2).innerText();
    await page.locator('[data-section="stations"] > summary').click();
    await page.waitForTimeout(100);
    const fresh = await page.locator('[data-station]').first().locator('td').nth(2).innerText();
    ok(closed > 0 && fresh.length > 0, `collapsed section catches up when reopened ("${stale}" -> "${fresh}")`);
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ hidden panel
  await run('hidden', async () => {
    await open('mode=real&advance=1800', { width: 1440, height: 900 });
    // Explicit flag from the shell.
    await H(() => window.harness.dash.setVisible(false));
    const m1 = await mutations(() => H(() => { window.harness.advance(300); window.harness.advance(300); }));
    eq(m1, 0, 'setVisible(false): no DOM work');
    const before = await text('.dash__status .dash__meta');
    await H(() => window.harness.dash.setVisible(true));
    ok((await text('.dash__status .dash__meta')) !== before, 'setVisible(true) refreshes at once');
    // Without the flag: a panel that has no layout box is skipped.
    await open('mode=real&advance=1800');
    await H(() => { document.getElementById('pane').style.display = 'none'; });
    const m2 = await mutations(() => H(() => window.harness.advance(300)));
    eq(m2, 0, 'display:none panel: no DOM work');
    await H(() => { document.getElementById('pane').style.display = ''; window.harness.tick(); });
    ok((await text('.dash__status .dash__meta')) !== '0:29:59', 'visible again: caught up');
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ null safety
  await run('null', async () => {
    await open('mode=null', { width: 1440, height: 900 });
    for (const id of ['throughput', 'leadTime', 'wip', 'fleet', 'traffic', 'deadlocks']) eq(await kpiValue(id), DASH, `null report: ${id} shows an en dash`);
    eq(await count('.dash-insight'), 0, 'junk insights are not rendered');
    ok((await count('.dash-fleet')) === 2 && (await count('[data-station]')) === 2, 'junk fleets and stations still get rows');
    ok(!(await page.locator('.dash').innerText()).match(/NaN|undefined|null|Infinity/), 'no NaN / undefined / null in the text');
    await H(() => window.harness.mode('bare'));
    ok(!(await page.locator('.dash').innerText()).match(/NaN|undefined|null|Infinity/), 'empty report object renders');
    await H(() => window.harness.mode('none'));
    ok(await page.locator('.empty').isVisible(), 'no report: empty state');
    eq(await text('.empty__title'), 'Press play to see results', 'empty state title');
    ok(await H(() => document.querySelector('.dash > .stack').hidden), 'content hidden in the empty state');
    await page.getByRole('button', { name: 'Run simulation' }).click();
    ok((await calls()).some((c) => c[0] === 'play'), 'empty state button starts the simulation');
    await shot('dashboard-empty-light');
    // Fuzz: replace random leaves of a real report with null / undefined / NaN / strings / objects. Nothing may throw.
    await open('mode=real&advance=1800');
    const outcome = await H(() => {
      const report = JSON.parse(JSON.stringify(window.harness.report()));
      let seed = 42;
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      const junk = [null, undefined, NaN, Infinity, -5, 'x', {}, [], true];
      const paths = [];
      const walk = (o, p) => { for (const k of Object.keys(o)) { const q = [...p, k]; if (o[k] && typeof o[k] === 'object') walk(o[k], q); else paths.push(q); } };
      walk(report, []);
      let failures = 0;
      let first = null;
      for (let i = 0; i < 300; i++) {
        const copy = structuredClone(report);
        for (let n = 0; n < 1 + Math.floor(rnd() * 12); n++) {
          const p = paths[Math.floor(rnd() * paths.length)];
          let o = copy;
          for (const k of p.slice(0, -1)) o = o?.[k];
          if (o && typeof o === 'object') o[p[p.length - 1]] = junk[Math.floor(rnd() * junk.length)];
        }
        if (rnd() < 0.2) { const keys = Object.keys(copy); copy[keys[Math.floor(rnd() * keys.length)]] = junk[Math.floor(rnd() * junk.length)]; }
        try { window.harness.setSynthetic(copy, window.harness.runner.insights()); } catch (e) { failures++; first ||= `${e.message} @ ${e.stack.split('\n')[1]}`; }
      }
      return { failures, first };
    });
    eq(outcome, { failures: 0, first: null }, '300 fuzzed reports render without throwing');
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ first minutes
  await run('states', async () => {
    await open('mode=real&advance=60&theme=light', { width: 1440, height: 900 });
    eq(await chip(), 'Warming up 10 %', 'warm-up percent (60 s of 600 s)');
    for (const id of ['throughput', 'leadTime', 'wip', 'fleet', 'traffic', 'deadlocks']) eq(await kpiValue(id), DASH, `warming up: ${id} is an en dash`);
    ok(await page.locator('.dash__notice').isVisible(), 'warm-up notice');
    ok(/Warming up/.test(await text('.dash__notice .callout__title')), 'notice title');
    eq(await page.locator('.dash__notice [role="progressbar"]').getAttribute('aria-valuenow'), '10', 'progress bar value');
    eq(await count('.dash-insight'), 0, 'no insights while warming up');
    await shot('dashboard-warming-light');
    await H(() => window.harness.advance(240));
    eq(await chip(), 'Warming up 50 %', 'half way');
    await H(() => window.harness.mode('real', { seconds: 720 }));
    eq(await chip(), 'Paused', 'warm-up over');
    ok(await page.locator('.dash__notice').isVisible(), 'short-data notice');
    eq(await text('.dash__notice .callout__title'), 'Not enough data yet', 'notice title');
    ok(/preliminary/.test(await text('.dash__notice .callout__text')), 'notice says the figures are preliminary');
    ok((await kpiValue('leadTime')) !== undefined && (await count('.dash-kpi.is-muted')) === 6, 'figures are shown but muted');
    ok(/Insights appear once/.test(await text('.dash-sec[data-section="insights"] .dash-note')), 'insights wait for data');
    await shot('dashboard-short-light');
    await H(() => window.harness.advance(900));
    ok(await page.locator('.dash__notice').isHidden(), 'notice gone once the data is sufficient');
    eq(await count('.dash-kpi.is-muted'), 0, 'figures no longer muted');
    ok((await count('.dash-insight')) >= 1, 'insights appear');
    await H(() => window.harness.mode('real', { seconds: 100 }));
    eq(await chip(), 'Warming up 17 %', 'a reset (new simulation) goes back to warming up without rebuilding anything');
    eq(await count('.dash-kpi'), 6, 'cards are kept');
    await H(() => window.harness.mode('none'));
    eq(await chip(), 'Not started', 'no simulation: not started');
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ 12 fleets, 30 stations
  await run('many', async () => {
    for (const [theme, vp] of [['light', { width: 390, height: 800 }], ['dark', { width: 360, height: 740 }], ['light', { width: 1440, height: 900 }]]) {
      await open(`mode=synth&fleets=12&stations=30&flows=14&long=1&theme=${theme}&${vp.width < 900 ? 'narrow=1' : 'w=420'}`, vp);
      eq(await count('.dash-fleet'), 12, '12 fleet cards');
      eq(await count('[data-station]'), 28, '28 workstation and buffer rows');
      eq((await visibleRows()).length, 10, 'collapsed to the ten busiest');
      eq(await count('[data-flow]'), 14, '14 flow rows');
      await noOverflow(`${vp.width}px, long names`);
      await page.getByRole('button', { name: /Show all 28 stations/ }).click();
      eq((await visibleRows()).length, 28, 'show all');
      await noOverflow(`${vp.width}px, all stations`);
      await page.getByRole('button', { name: 'Show fewer' }).click();
      eq((await visibleRows()).length, 10, 'show fewer');
      const long = await H(() => [...document.querySelectorAll('.dash-fleet .card__title')].every((t) => t.scrollWidth >= t.clientWidth && t.getBoundingClientRect().right <= document.querySelector('.dash').getBoundingClientRect().right));
      ok(long, 'long fleet names are truncated inside their card');
      ok(await H(() => [...document.querySelectorAll('.dash-fleet__side')].every((s) => s.getBoundingClientRect().height < 50)), 'working share does not wrap');
    }
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ interaction
  await run('interact', async () => {
    await open('mode=synth&fleets=3&stations=8&flows=6&theme=light', { width: 1440, height: 900 });
    // insights: the card and its button both focus the plan
    eq(await count('.dash-insight'), 6, 'six insights collapsed');
    await page.getByRole('button', { name: 'Show all 9 insights' }).click();
    eq(await count('.dash-insight'), 9, 'all nine');
    eq(await page.getByRole('button', { name: 'Show fewer' }).count(), 1, 'toggle button text');
    await page.getByRole('button', { name: 'Show fewer' }).click();
    eq(await count('.dash-insight'), 6, 'back to six');
    await page.locator('.dash-insight').first().locator('.callout__title').click();
    eq((await calls()).at(-1), ['focus', { stationIds: ['s1'] }], 'clicking an insight focuses its station');
    await page.locator('.dash-insight').nth(1).getByRole('button', { name: 'Show on plan' }).click();
    eq((await calls()).at(-1), ['focus', { cells: [[8, 4], [11, 9]] }], 'the button focuses the cells; the card click does not fire twice');
    eq((await calls()).filter((c) => c[0] === 'focus').length, 2, 'one focus call per click');
    await page.getByRole('button', { name: 'Show all 9 insights' }).click();
    const noRefs = page.locator('[data-insight="battery:v1"]');
    ok((await noRefs.getAttribute('data-clickable')) === null && (await noRefs.getByRole('button', { name: 'Show on plan' }).count()) === 0, 'no refs: no click target');
    await page.getByRole('button', { name: 'Show fewer' }).click();
    // the refs of an insight change while the simulation runs: the click uses the latest ones, and an insight that loses them stops being clickable
    await H(() => { const ins = window.harness.synthInsights(9); ins[1].refs = { cells: [[1, 1]] }; window.harness.setSynthetic(window.harness.synthReport({ fleets: 3, stations: 8, flows: 6 }), ins); });
    await page.locator('.dash-insight').nth(1).locator('.callout__title').click();
    eq((await calls()).at(-1), ['focus', { cells: [[1, 1]] }], 'the card follows refs that changed');
    await H(() => { const ins = window.harness.synthInsights(9); ins[1].refs = {}; window.harness.setSynthetic(window.harness.synthReport({ fleets: 3, stations: 8, flows: 6 }), ins); });
    const n = (await calls()).length;
    await page.locator('.dash-insight').nth(1).locator('.callout__title').click();
    eq((await calls()).length, n, 'no refs: clicking does nothing');
    ok(await page.locator('.dash-insight').nth(1).getByRole('button', { name: 'Show on plan' }).isHidden(), 'no refs: no "Show on plan" button');
    await H(() => window.harness.setSynthetic(window.harness.synthReport({ fleets: 3, stations: 8, flows: 6 }), window.harness.synthInsights(9)));
    // details survive an update
    const second = page.locator('.dash-insight').nth(2);
    await second.getByRole('button', { name: 'Details' }).click();
    ok(await second.locator('.callout__text').last().isVisible(), 'details open');
    eq(await second.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded'), 'true', 'aria-expanded');
    await H(() => { window.harness.setSynthetic(window.harness.synthReport({ fleets: 3, stations: 8, flows: 6, seed: 99 }), window.harness.synthInsights(9)); });
    ok(await page.locator('.dash-insight').nth(2).locator('.callout__text').last().isVisible(), 'open details survive a refresh');
    // keyboard: Tab to a button, Enter / Space activate
    await page.locator('.dash-insight').first().getByRole('button', { name: 'Show on plan' }).focus();
    await page.keyboard.press('Enter');
    eq((await calls()).at(-1), ['focus', { stationIds: ['s1'] }], 'Enter on "Show on plan"');
    const details = page.locator('.dash-insight').first().getByRole('button', { name: 'Details' });
    await details.focus();
    await page.keyboard.press('Space');
    eq(await details.getAttribute('aria-expanded'), 'true', 'Space toggles details');
    ok(await details.evaluate((b) => document.activeElement === b), 'focus stays on the button after the toggle');

    // stations: bottleneck, selection, click
    await H(() => window.harness.setSynthetic(window.harness.synthReport({ fleets: 3, stations: 8, flows: 6 }), window.harness.synthInsights(9)));
    ok(await page.locator('[data-station="s1"] .dash-flag').isVisible(), 'bottleneck flag on s1 (from the insights)');
    ok(await page.locator('[data-station="s1"] td.is-worst').count() === 1, 'bottleneck cell highlighted');
    eq(await page.locator('[data-station="s2"] .dash-flag').isHidden(), true, 'other rows are not flagged');
    await page.locator('[data-station="s3"] td').nth(2).click();
    eq((await calls()).at(-1), ['focus', { stationIds: ['s3'] }], 'row click focuses the station');
    ok(await page.locator('[data-station="s3"]').evaluate((r) => r.classList.contains('is-selected')), 'row shows the selection');
    await page.locator('[data-station="s2"] .dash-link').focus();
    await page.keyboard.press('Enter');
    eq((await calls()).at(-1), ['focus', { stationIds: ['s2'] }], 'keyboard: Enter on the name focuses the station');
    eq((await calls()).filter((c) => c[0] === 'focus' && c[1].stationIds?.[0] === 's2').length, 1, 'name button and row do not both fire');
    eq(await page.locator('[data-station].is-selected').count(), 1, 'one selected row');

    // hot spots and heatmap
    await page.locator('.dash-spot').first().click();
    eq((await calls()).at(-1), ['focus', { cells: [[8, 4]] }], 'hot spot focuses its cell');
    const toggle = page.getByRole('button', { name: 'Show heatmap' });
    eq(await heat(), 'off', 'heatmap starts off');
    await toggle.click();
    eq(await heat(), 'waiting', 'toggle turns the waiting heatmap on');
    eq(await toggle.getAttribute('aria-pressed'), 'true', 'toggle is pressed');
    await page.getByRole('button', { name: 'Traffic', exact: true }).click();
    eq(await heat(), 'traffic', 'mode switch');
    eq(await page.getByRole('button', { name: 'Traffic', exact: true }).getAttribute('aria-pressed'), 'true', 'mode shows pressed');
    await toggle.click();
    eq(await heat(), 'off', 'toggle off');
    eq(await toggle.getAttribute('aria-pressed'), 'false', 'toggle released');
    eq(await page.getByRole('button', { name: 'Traffic', exact: true }).getAttribute('aria-pressed'), 'false', 'no mode pressed while off');
    await toggle.click();
    eq(await heat(), 'traffic', 'toggle remembers the last mode');
    await H(() => window.harness.store.setUi({ overlays: { heat: 'off' } }));
    eq(await toggle.getAttribute('aria-pressed'), 'false', 'external store change is mirrored');

    // metric tooltips
    const help = page.locator('.dash-help').first();
    await help.focus();
    const tip = page.locator('.dash-tip');
    ok(await tip.isVisible() && /Finished loads/.test(await tip.innerText()), 'focus shows the metric explanation');
    ok(await H(() => { const t = document.querySelector('.dash-tip').getBoundingClientRect(); const d = document.querySelector('.dash').getBoundingClientRect(); return t.left >= d.left && t.right <= d.right; }), 'tooltip stays inside the panel');
    await shot('dashboard-tooltip-light');
    await page.keyboard.press('Escape');
    ok(await tip.isHidden(), 'Escape closes it');
    await page.locator('.dash-help').nth(4).hover();
    ok(await tip.isVisible() && /another vehicle/.test(await tip.innerText()), 'hover shows it too');
    await page.mouse.move(5, 5);
    ok(await tip.isHidden(), 'leaving closes it');
    eq(await page.locator('.dash-help').first().getAttribute('aria-label'), 'About Throughput', 'help button is labelled');

    // sorted table that does not run away from the pointer
    await H(() => window.harness.setSynthetic(window.harness.synthReport({ stations: 18, seed: 5 }), []));
    await page.waitForTimeout(2700);
    await H(() => window.harness.setSynthetic(window.harness.synthReport({ stations: 18, seed: 5 }), []));
    const sorted = await names();
    const used = await usedOf();
    eq(used, [...used].sort((a, b) => b - a), 'sorted by utilization');
    await page.locator('[data-station]').nth(3).hover();
    await page.waitForTimeout(2700);
    await H(() => window.harness.setSynthetic(window.harness.synthReport({ stations: 18, seed: 6 }), []));
    eq(await names(), sorted, 'rows keep their place while the pointer is over the table');
    await page.mouse.move(5, 5);
    await page.waitForTimeout(2700);
    await H(() => window.harness.setSynthetic(window.harness.synthReport({ stations: 18, seed: 6 }), []));
    const used2 = await usedOf();
    eq(used2, [...used2].sort((a, b) => b - a), 'sorted again after the pointer left');
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ real runner
  await run('runner', async () => {
    await open('mode=runner&speed=1200&theme=light', { width: 1440, height: 900 });
    await page.waitForFunction(() => /Warming|Running/.test(document.querySelector('.dash__status .chip')?.textContent || ''), null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('[data-kpi="throughput"] .kpi__value')?.textContent.trim() !== '–', null, { timeout: 30000 });
    ok(['Running', 'Paused'].includes(await chip()) || /Warming/.test(await chip()), 'the real runner drives the chip');
    await page.waitForFunction(() => window.harness.realRunner.time > 1800, null, { timeout: 30000 });
    const stateNow = await chip();
    ok(/Running/.test(stateNow), `playing: ${stateNow}`);
    await H(() => window.harness.realRunner.pause());
    await page.waitForTimeout(500);
    eq(await chip(), 'Paused', 'pause shows in the chip');
    const t = await H(() => window.harness.realRunner.time);
    const clock = await text('.dash__status .dash__meta');
    ok(/^\d+:\d\d:\d\d$/.test(clock), `clock text ${clock}`);
    ok((await count('.dash-fleet')) >= 1 && (await count('[data-station]')) >= 1, 'results from the real runner and engine');
    const idle = await mutations(() => page.waitForTimeout(800));
    eq(idle, 0, `a paused simulation causes no DOM writes (sim at ${Math.round(t)} s)`);
    await H(() => window.harness.realRunner.reset());
    await page.waitForTimeout(600);
    ok(/Warming|Not started/.test(await chip()), 'reset starts over');
    await shot('dashboard-runner-light');
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ cost
  await run('perf', async () => {
    await open('mode=synth&fleets=12&stations=30&flows=14&long=1', { width: 1440, height: 900 });
    const result = await H(() => {
      const state = window.harness.store.getState();
      const dash = window.harness.dash;
      dash.setVisible(true); // as the shell does: no layout read to find out whether the panel is on screen
      let t = performance.now();
      for (let i = 0; i < 500; i++) dash.update(state);
      const same = (performance.now() - t) / 500;
      const reports = Array.from({ length: 60 }, (_, i) => window.harness.synthReport({ fleets: 12, stations: 30, flows: 14, long: true, seed: i + 1, duration: 3600 + i * 60 }));
      const insights = window.harness.synthInsights(9);
      t = performance.now();
      for (const r of reports) window.harness.setSynthetic(r, insights);
      const fresh = (performance.now() - t) / reports.length;
      t = performance.now();
      for (const r of reports) { window.harness.setSynthetic(r, insights); document.body.offsetHeight; }
      const withLayout = (performance.now() - t) / reports.length;
      return { same, fresh, withLayout };
    });
    console.log(`   update, same report: ${result.same.toFixed(3)} ms; new report (12 fleets, 30 stations): ${result.fresh.toFixed(2)} ms, ${result.withLayout.toFixed(2)} ms including the layout it causes`);
    ok(result.same < 0.1, `unchanged report is almost free (${result.same} ms)`);
    ok(result.fresh < 5, `a new report is written in place within a fraction of a frame (${result.fresh} ms)`);
    ok(result.withLayout < 20, `including layout it still fits a frame (${result.withLayout} ms)`);
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ contrast
  await run('contrast', async () => {
    /** WCAG contrast of every visible text in the dashboard against the colour it is painted on (alpha composited). */
    const audit = () => H(() => {
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
      const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
      const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const backdrop = (el) => {
        const stack = [];
        for (let e = el; e; e = e.parentElement) { const bg = parse(getComputedStyle(e).backgroundColor); if (bg.a > 0) stack.push(bg); if (bg.a === 1) break; }
        return stack.reverse().reduce((acc, bg) => over(bg, acc), { r: 255, g: 255, b: 255, a: 1 });
      };
      const bad = [];
      const walker = document.createTreeWalker(document.querySelector('.dash'), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!n.data.trim() || el.closest('.sr-only, [hidden], canvas')) continue;
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        const cs = getComputedStyle(el);
        const bg = backdrop(el);
        const fg = over(parse(cs.color), bg);
        const l1 = lum(fg); const l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) bad.push(`${ratio.toFixed(2)} "${n.data.trim().slice(0, 40)}" in .${el.className}`);
      }
      return bad;
    });
    for (const theme of ['light', 'dark']) {
      for (const [query, label] of [['mode=real&example=congestion-lab&advance=3600', 'congestion lab'], ['mode=synth&fleets=4&stations=12&flows=6', 'synthetic'], ['mode=real&advance=700', 'short data'], ['mode=real&advance=100', 'warming up'], ['mode=none', 'empty']]) {
        await open(`${query}&theme=${theme}&tall=1`, { width: 1440, height: 900 });
        eq(await audit(), [], `${theme} / ${label}: every text is AA`);
      }
    }
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  // ============================================================================================ screenshots
  await run('shots', async () => {
    const sets = [
      ['desktop-light', 'mode=real&example=two-lines&advance=3600&theme=light', { width: 1440, height: 900 }],
      ['desktop-dark', 'mode=real&example=two-lines&advance=3600&theme=dark', { width: 1440, height: 900 }],
      ['congestion-light', 'mode=real&example=congestion-lab&advance=3600&theme=light&playing=1', { width: 1440, height: 900 }],
      ['narrow-light', 'mode=real&example=two-lines&advance=3600&theme=light&narrow=1', { width: 390, height: 800 }],
      ['narrow-dark', 'mode=real&example=congestion-lab&advance=3600&theme=dark&narrow=1', { width: 390, height: 800 }],
      ['many-narrow-light', 'mode=synth&fleets=12&stations=30&flows=14&long=1&theme=light&narrow=1', { width: 390, height: 800 }],
      ['many-desktop-dark', 'mode=synth&fleets=12&stations=30&flows=14&long=1&theme=dark', { width: 1440, height: 900 }],
      ['null-light', 'mode=null&theme=light', { width: 1440, height: 900 }],
      ['bg-light', 'mode=real&example=two-lines&advance=3600&theme=light&bg=bg&w=360', { width: 1440, height: 900 }],
    ];
    for (const [name, query, vp] of sets) {
      await open(`${query}&tall=1`, vp);
      const file = await shot(`dashboard-${name}-full`, { fullPage: true });
      if (name === 'desktop-light' || name === 'desktop-dark') await open(query, vp), await shot(`dashboard-${name}`);
      console.log(`   ${file}`);
    }
    ok(errors.length === 0, `no console errors: ${errors.join('\n')}`);
  });

  eq(errors, [], 'no console errors or warnings in the whole run');
  console.log(`dashboard: ${checks} checks passed`);
});
