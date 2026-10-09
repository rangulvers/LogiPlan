// Fuzz for milestone M1 of the warehouse module (docs/WAREHOUSE-DESIGN.md 5.1 rule 4, acceptance A1.2): 4,000 documents with junk in ops and
// calendar normalize TOTALLY (no throw, the input is never modified, also when it is frozen), IDEMPOTENTLY and VALIDLY, and nothing reaches a
// prototype. A heavy-tier file (about 13 s of CPU on an idle machine): scripts/test-tiers.mjs lists it. The fast checks of the same keys are
// in tests/model.ops-trucks.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import { MAX_SCHEDULE_ROWS } from '../js/model/ops.js';
import { schemaNeeded } from '../js/model/schema.js';
import { exportProject, importProject } from '../js/model/serialize.js';
import { createRng } from '../js/util/rng.js';
import { deepFreeze, junk, junkDocument, junkTrucks } from './helpers/m0-review-gen.js';

const bytes = (v) => JSON.stringify(v);
const project = (layout) => ({ name: 'P', scenarios: [{ id: 'a', name: 'A', layout }], activeId: 'a' });

/** A trucks block with hostile values for every documented key, and own `__proto__` / `constructor` keys where JSON brings them in. */
function hostileTrucks(rng) {
  const t = junkTrucks(rng);
  const own = (key, value) => Object.defineProperty(t, key, { value, enumerable: true, writable: true, configurable: true });
  if (rng.next() < 0.3) own('noShow', junk(rng, 2));
  if (rng.next() < 0.3) own('jitter', junk(rng, 2));
  if (rng.next() < 0.3) own('maxDwell', junk(rng, 2));
  if (rng.next() < 0.3) own('staging', junk(rng, 2));
  if (rng.next() < 0.3) own('checkIn', junk(rng, 2));
  if (rng.next() < 0.2) own('schedule', Array.from({ length: rng.int(900) }, () => (rng.next() < 0.7 ? { at: rng.int(100000) - 5000, pallets: rng.pick([1, 24, 0, 999, null, 'x', 2.5]) } : junk(rng, 2))));
  if (rng.next() < 0.15) own('__proto__', { doors: 99, polluted: true });
  if (rng.next() < 0.1) own('constructor', { prototype: { polluted: true } });
  return t;
}

test('fuzz: 4,000 documents with junk in ops and calendar (and in every other place of the warehouse module) normalize totally, idempotently and validly', () => {
  const rng = createRng(20261009);
  const bases = EXAMPLES.map((e) => e.build());
  let withTrucks = 0;
  let withCalendar = 0;
  let schedule = 0;
  for (let i = 0; i < 4000; i++) {
    const raw = junkDocument(rng, bases[i % 3]);
    for (const s of raw.stations) if (s !== null && typeof s === 'object' && rng.next() < 0.4) s.ops = { trucks: hostileTrucks(rng), ...(rng.next() < 0.2 ? { extra: junk(rng, 2) } : {}) };
    if (rng.next() < 0.3) raw.calendar = { startTod: junk(rng, 2), startDay: junk(rng, 2), ...(rng.next() < 0.3 ? { shifts: junk(rng, 2) } : {}) };
    const text = bytes(raw);
    const frozen = deepFreeze(JSON.parse(text)); // a write into the input throws
    const out = L.normalizeLayout(frozen);
    assert.equal(bytes(frozen), text, `document ${i}: the input was modified`);
    assert.deepEqual(L.checkInvariants(out), [], `document ${i}: invalid`);
    assert.equal(out.schema, schemaNeeded(out), `document ${i}: stamp`);
    const again = bytes(L.normalizeLayout(JSON.parse(bytes(out))));
    assert.equal(again, bytes(out), `document ${i}: not idempotent`);
    for (const s of out.stations) {
      if (!s.ops) continue;
      withTrucks++;
      assert.ok(s.type === 'source' || s.type === 'sink', `document ${i}: ops on a ${s.type}`);
      assert.deepEqual(Object.keys(s.ops), ['trucks']);
      assert.ok(s.ops.trucks.schedule.length <= MAX_SCHEDULE_ROWS);
      if (s.ops.trucks.mode === 'schedule') schedule++;
      for (const row of s.ops.trucks.schedule) assert.ok(row.at >= 0 && row.at < 86400 && (row.pallets === null || (row.pallets >= 1 && row.pallets <= 200)), `document ${i}: a row`);
    }
    if (out.calendar) {
      withCalendar++;
      assert.deepEqual(Object.keys(out.calendar), ['startTod', 'startDay']);
    }
    if (out.stations.some((s) => s.ops && s.ops.trucks.mode === 'schedule')) assert.ok(out.calendar, `document ${i}: a timetable has a clock`);
    if (i % 400 === 0) assert.equal(bytes(importProject(exportProject(project(out))).scenarios[0].layout), bytes(out), `document ${i}: export/import`);
  }
  assert.ok(withTrucks > 2000 && withCalendar > 500 && schedule > 100, `the fuzz exercised trucks (${withTrucks}), clocks (${withCalendar}), timetables (${schedule})`);
  assert.deepEqual(Object.keys(Object.prototype), [], 'Object.prototype was polluted');
  for (const name of ['polluted', 'doors', 'trucks', 'calendar', 'startTod', 'prototype']) assert.equal({}[name], undefined, `Object.prototype.${name}`);
});

