// The ledger of who may touch the detail collector (js/sim/detail.js, docs/ENTITY-INSIGHTS-DESIGN.md 6.1, acceptance S1.1 and S1.15), as a function of a source text, so that the
// ledger test (tests/sim.seams.test.js) and the review that attacks it (tests/stats.engine.review.test.js) apply exactly the same rules.
//
// A file outside DETAIL_OWNERS must not
//   * name the seam (enableDetail, disableDetail, dropDetail, detailError, afterTickSafe),
//   * import js/sim/detail.js (static import, double or single quotes, dynamic import()),
//   * read a property `detail` of anything but a known TEXT: `x.detail`, `this.detail`, `f().detail`, `x['detail']`, `const { detail } = x`, `({ detail }) => ...`.
// Texts called detail exist (an insight's detail, a notice's, a menu item's, the preference `ui.detail`, a DOM event's click count): TEXT_RECEIVERS lists the variables that hold
// them everywhere, TEXT_READS the receivers that are texts only in one file (a short name such as `s` or `i` is a text in the file that says so and a collector anywhere else).
// A new `x.detail` in a file that is not listed is a failure with a message: add it to the list once somebody has looked at what `x` is.

/** The files that may read the collector: its own, the engine that polls it, the runner that turns it on, the dock and its model/view (stats-*.js), the route overlay. */
export const DETAIL_OWNERS = (rel) => rel === 'sim/detail.js' || rel === 'sim/engine.js' || rel === 'ui/runner.js' || /^ui\/panels\/stats-[\w-]+\.js$/.test(rel) || rel === 'ui/render/routes.js';

/** Receivers whose `.detail` is a text, in every file. */
export const TEXT_RECEIVERS = new Set(['insight', 'ins', 'notice', 'item', 'row', 'ui']);
/** file -> receivers whose `.detail` is a text in that file only. */
export const TEXT_READS = {
  'ui/report.js': ['i'], // an insight of the report list
  'ui/panels/inspector.js': ['s'], // the status of a station: { tone, label, detail }
  'ui/panels/fleet.js': ['e'], // a DOM click event: e.detail === 0 is a keyboard activation
};

const SEAM_NAMES = /\b(?:enableDetail|disableDetail|dropDetail|detailError|afterTickSafe)\b/;
export const DETAIL_IMPORT = /from\s*['"][^'"]*\/detail\.js['"]|\bimport\s*\(\s*['"][^'"]*\/detail\.js['"]\s*\)|\bimport\s*['"][^'"]*\/detail\.js['"]/;

/** Source without comments (line comments and block comments); good enough for the files of this repository, which have no `//` inside a string that matters here. */
export const stripComments = (source) => source.split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The ways in which the source `code` of the file `rel` touches the collector although `rel` is not one of its owners. [] for an owner and for a clean file.
 * @returns {string[]} one sentence per stray
 */
export function detailStrays(rel, code) {
  if (DETAIL_OWNERS(rel)) return [];
  const src = stripComments(code);
  const out = [];
  const seam = src.match(SEAM_NAMES);
  if (seam) out.push(`names the collector's seam (${seam[0]})`);
  if (DETAIL_IMPORT.test(src)) out.push('imports js/sim/detail.js');
  const allowed = new Set(TEXT_READS[rel] || []);
  const reads = (m) => {
    const last = m[1].split('.').pop().trim();
    if (TEXT_RECEIVERS.has(last) || allowed.has(last)) return;
    out.push(`reads the property detail of ${m[1].trim()} (${m[0].replace(/\s+/g, '')})`);
  };
  // x.detail, a.b.detail, f().detail, this.detail: whatever the receiver, unless it is a known text
  for (const m of src.matchAll(/((?:[A-Za-z_$][\w$]*|\))(?:\.[A-Za-z_$][\w$]*)*)\.detail\b/g)) reads(m);
  // the same with blanks around the dot, where the receiver is something that holds a simulation (`sim . detail`; a CSS rule such as ".list .detail" is not code)
  for (const m of src.matchAll(/\b((?:sim|simulation|runner|engine|rt|live|this)\w*)\s+\.\s*detail\b|\b((?:sim|simulation|runner|engine|rt|live|this)\w*)\s*\.\s+detail\b/g)) reads([m[0], m[1] || m[2]]);
  for (const m of src.matchAll(/\[\s*['"`]detail['"`]\s*\]/g)) out.push(`reads ${m[0].replace(/\s+/g, '')}`);
  // const { detail } = x;  const { a, detail: d } = x;  ({ detail }) => ...;  function f({ detail }) { }
  const names = '[\\w$\\s,:]*';
  const destructure = new RegExp(`(?:\\b(?:const|let|var)\\s*\\{${names}\\bdetail\\b${names}\\}\\s*=(?!=)|\\(\\s*\\{${names}\\bdetail\\b${names}\\}\\s*\\)\\s*=>|\\bfunction\\s*[\\w$]*\\s*\\(\\s*\\{${names}\\bdetail\\b${names}\\})`, 'g');
  for (const m of src.matchAll(destructure)) out.push(`takes detail out of an object (${m[0].replace(/\s+/g, ' ').slice(0, 40)})`);
  return out;
}
