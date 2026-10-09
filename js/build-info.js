// What this copy of LogiPlan IS: its version and the build it came from (docs/ARCHITECTURE.md 6.11). The app imports BUILD to show the
// version chip and the About dialog, and to write the version into the HTML report.
//
// In the repository this file holds the DEVELOPMENT values: the version of package.json, no commit, no build time, channel 'dev'.
// `node scripts/bump-version.mjs` keeps `version` in step with package.json; `npm run version:check` fails when they differ.
// `node scripts/build-site.mjs` writes the real values (the version, GITHUB_SHA, the build time, channel 'live') into the copy of this
// file in the site directory only: this file is never changed by a build. One property per line, so that the scripts can read it.
export const BUILD = Object.freeze({
  version: '0.6.0',
  commit: 'dev',
  shortCommit: 'dev',
  builtAt: null,
  channel: 'dev',
  repository: 'https://github.com/rangulvers/LogiPlan',
});
