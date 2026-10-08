// The noise bands of the change-impact card (js/ui/panels/impact.js) against REAL paired runs of the engine: the old plant and the same
// plant with one small change, the same seed, the same measured window - exactly what the runner hands the card (baseline.control and
// baseline.after, js/ui/runner.js). The bands were set from 450 such pairs (the three examples x 10 seeds x windows of 10, 15 and 20 minutes
// x five small perturbations): not one of them was coloured. This file repeats a smaller set so that the bands cannot drift unnoticed, and
// checks that large effects are still seen. (The pipeline through the runner with its fake clock is tested in
// tests/ui.runner.warm.review.test.js: WARM-1, WARM-2 and WARM-GUARD-H1.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import * as L from '../js/model/layout.js';
import { Simulation } from '../js/sim/engine.js';
import { impactModel, impactHintText, NO_CHANGE_NOTE, STALLED_NOTE } from '../js/ui/panels/impact.js';

const WINDOW = 600; // the runner's pre-roll measures 10 minutes after the warm-up

const example = (id, seed) => {
  const layout = EXAMPLES.find((e) => e.id === id).build();
  layout.settings.seed = seed;
  return layout;
};

/** The report of a layout after its warm-up plus `window` measured seconds. */
function measure(layout, window = WINDOW) {
  const sim = new Simulation(layout);
  sim.advance(layout.settings.warmup + window);
  return sim.kpis();
}

/** The card's model for `layout` before and after `edit`. */
function compare(layout, edit, window = WINDOW) {
  const changed = L.cloneLayout(layout);
  edit(changed);
  const control = measure(layout, window);
  const after = measure(changed, window);
  const baseline = { report: control, simTime: 1000, labels: ['Edit'], edits: 1, layout, control: { window, report: control }, after: { window, report: after } };
  return impactModel(baseline, after);
}

const coloured = (model) => model.rows.filter((r) => r.change.tone !== 'neutral').map((r) => `${r.label} ${r.pair} (${r.change.text})`);

test('a change that cannot matter reads exactly ±0 in every figure (renaming a station)', () => {
  for (const id of ['starter', 'two-lines', 'congestion-lab']) {
    const model = compare(example(id, 3), (l) => { l.stations[0].name = 'Renamed station'; });
    for (const row of model.rows) {
      assert.equal(row.change.text, '±0', `${id}: ${row.label} ${row.pair}`);
      assert.equal(row.change.tone, 'neutral');
    }
    assert.equal(model.note, NO_CHANGE_NOTE);
    assert.match(impactHintText(model), /^No clear change in the key figures/);
  }
});

test('small perturbations (1-3 % faster vehicles, 0.3 s more loading) are not rated better or worse', () => {
  const perturbations = [
    ['vehicles 3 % faster', (l) => { for (const f of l.fleets) f.speed *= 1.03; }],
    ['0.3 s more loading time', (l) => { for (const f of l.fleets) f.loadTime += 0.3; }],
    ['5 % more acceleration', (l) => { for (const f of l.fleets) f.accel *= 1.05; }],
  ];
  const verdicts = [];
  for (const id of ['starter', 'two-lines', 'congestion-lab']) {
    for (const seed of [1, 4]) {
      const layout = example(id, seed);
      for (const [name, edit] of perturbations) {
        for (const row of coloured(compare(layout, edit))) verdicts.push(`${id} seed ${seed}, ${name}: ${row}`);
      }
    }
  }
  assert.deepEqual(verdicts, []);
});

test('a large effect is seen: a workstation twice as slow makes lead time and work in progress worse', () => {
  const model = compare(example('starter', 1), (l) => { l.stations.find((st) => st.type === 'process').params.cycle.mean = 240; });
  const row = Object.fromEntries(model.rows.map((r) => [r.id, r.change]));
  assert.equal(row.leadTime.tone, 'bad');
  assert.equal(row.wip.tone, 'bad');
  assert.equal(row.fleet.tone, 'neutral', 'utilization is never coloured');
  assert.equal(model.note, '');
  assert.match(impactHintText(model), /\(indicative\)$/);
});

test('a plant cut to one vehicle per fleet finishes nothing in the compared time: worse, and said so', () => {
  const model = compare(example('two-lines', 1), (l) => { for (const f of l.fleets) f.count = 1; });
  const row = Object.fromEntries(model.rows.map((r) => [r.id, r.change]));
  assert.equal(row.throughput.tone, 'bad');
  assert.equal(row.wip.tone, 'bad');
  assert.equal(model.note, STALLED_NOTE);
});

test('a plant that stands still after the change (no roads) says so and nothing is called better', () => {
  const model = compare(example('starter', 1), (l) => { for (const key of Object.keys(l.roads)) { const [x, y] = key.split(',').map(Number); L.eraseRoadCell(l, x, y); } });
  assert.equal(model.note, STALLED_NOTE);
  assert.equal(model.rows.find((r) => r.id === 'throughput').after, 0);
  assert.deepEqual(coloured(model).filter((_, i) => model.rows.filter((r) => r.change.tone !== 'neutral')[i].change.tone === 'good'), []);
  assert.equal(model.rows.find((r) => r.id === 'traffic').change.tone, 'neutral', 'nothing drives any more: the waiting share of 0 is no improvement');
});

test('the old plant and the new plant are simulated for the same measured window', () => {
  const layout = example('starter', 2);
  const model = compare(layout, (l) => { l.fleets[0].count += 1; });
  assert.ok(Math.abs(model.status.seconds - WINDOW) < 1e-6, `the window is ${model.status.seconds} s`);
  assert.match(model.windows, /^Both plants were simulated for the same 10 min after warm-up, with the same random seed\.$/);
});
