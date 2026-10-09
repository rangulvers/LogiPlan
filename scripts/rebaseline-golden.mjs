#!/usr/bin/env node
// Re-record the golden fixtures (tests/fixtures/golden/*): the KPI reports of the three example plants, the legacy layouts and their
// share links. See tests/helpers/golden.js for what is recorded and docs/WAREHOUSE-DESIGN.md 10.1 for the rule.
//
//   node scripts/rebaseline-golden.mjs            record the fixtures from the tree this script lives in, and list what changed
//   node scripts/rebaseline-golden.mjs --check    record nothing; list what WOULD change and exit 1 if anything would
//
// THIS WRITES THE REFERENCE THAT THE SAFETY NET COMPARES AGAINST. If a golden test fails, the simulation has changed behaviour for
// plants that do not use any new feature. That is a bug until proven otherwise; do not run this script to make the red go away.
// A pull request that runs it must say, in its description, WHY the legacy results changed and who agreed. The only planned
// re-baseline was the one after the dock work (the fixtures present at the end of milestone M0 are that one).
import { captureGolden, loadTree, readGolden, writeGolden, GOLDEN_DIR } from '../tests/helpers/golden.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

const LOUD = [
  '',
  '################################################################################',
  '#  GOLDEN FIXTURES: a pull request that re-records them MUST SAY WHY.          #',
  '#  A changed KPI text of a legacy example is a behaviour change, not a chore.  #',
  '################################################################################',
  '',
].join('\n');

const checkOnly = process.argv.includes('--check');
console.log(LOUD);
const tree = await loadTree();
const files = await captureGolden(tree);

/** A recorded share link is up to date when it decodes to the layout that is recorded now (its compressed text may vary between zlib versions). */
async function shareIsCurrent(file) {
  try {
    const id = file.slice('share.'.length, -'.txt'.length);
    const project = await tree.serialize.decodeShare(readGolden(file));
    return JSON.stringify(project.scenarios[0].layout) === files[`layout.${id}.json`];
  } catch {
    return false;
  }
}

const changed = [];
for (const [file, text] of Object.entries(files)) {
  const known = existsSync(path.join(GOLDEN_DIR, file));
  const same = known && (file.startsWith('share.') ? await shareIsCurrent(file) : readGolden(file) === text);
  if (!same) changed.push(file);
  console.log(`${same ? '  unchanged' : known ? '* CHANGED  ' : '* NEW      '} ${file} (${text.length} characters)`);
  if (!checkOnly && !same) writeGolden(file, text);
}
if (checkOnly) {
  console.log(changed.length ? `\n${changed.length} fixture(s) would change. Nothing was written.` : '\nAll fixtures are up to date. Nothing was written.');
  process.exit(changed.length ? 1 : 0);
}
console.log(changed.length ? `\nWrote ${changed.length} fixture(s) to ${path.relative(process.cwd(), GOLDEN_DIR) || GOLDEN_DIR}.` : '\nNothing changed.');
if (changed.length) {
  console.log(LOUD);
  console.log('Review the diff of tests/fixtures/golden/ and explain every changed file in the pull request description.');
}
