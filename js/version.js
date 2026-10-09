// Version helpers (docs/ARCHITECTURE.md 6.11): what a version number, a build date and a changelog look like, and whether the copy of LogiPlan that
// is running is out of date. Pure functions on plain values, no DOM, no clock, no network: they run in Node (tests/version.*.test.js) and in the
// browser (js/ui/about.js, js/update-check.js, js/ui/report.js).
//
//   parseVersion(text)               -> { major, minor, patch, pre: string[] } | null        "0.6.0", "v1.2.3-beta.1" (a leading v and +build are allowed)
//   compareVersions(a, b)            -> -1 | 0 | 1       semantic versioning; text that is no version sorts before every version (a total order)
//   isNewer(candidate, current)      -> boolean          false when the candidate is no version
//   formatBuildDate(iso, { timeZone }) -> { day, local, utc, zone, iso } | null   "9 Oct 2026", "9 Oct 2026, 17:08 CEST", "2026-10-09 15:08 UTC"
//   parseChangelog(text)             -> [{ version, date, unreleased, sections: [{ title, items: [text] }] }]   never throws
//   updateVerdict(build, fetched)    -> { available, reason, remote }     is the version.json that was fetched a newer deploy than this build?
//   versionLabel / chipTooltip / bugReportLine / whereItRuns / commitUrl   the texts of the chip, the dialog and the bug report line
//
// Everything that comes from outside (a fetched version.json, the text of CHANGELOG.md) is treated as hostile: types are checked, lengths are
// capped, only own properties are read, and nothing from it is ever used as markup (the callers use textContent).

/** The longest version text, commit or date text that is looked at; longer is junk. */
export const MAX_TEXT = 64;
/** The most entries, sections per entry, items per section and characters per item parseChangelog keeps. */
export const CHANGELOG_LIMITS = Object.freeze({ chars: 400_000, entries: 300, sections: 30, items: 200, item: 700, title: 60 });

const own = (obj, key) => obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NUM = '0|[1-9]\\d{0,8}';
const IDENT = '[0-9A-Za-z-]+';
const SEMVER = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+${IDENT}(?:\\.${IDENT})*)?$`);

// ---------------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------------

/** "0.6.0" -> { major: 0, minor: 6, patch: 0, pre: [] }; "1.0.0-beta.2" -> pre ['beta', '2']; anything else -> null. */
export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) return null;
  const m = SEMVER.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

const isNumeric = (id) => /^\d+$/.test(id);

function comparePreIdentifier(a, b) {
  const na = isNumeric(a);
  const nb = isNumeric(b);
  if (na && nb) {
    const x = a.replace(/^0+(?=\d)/, '');
    const y = b.replace(/^0+(?=\d)/, '');
    return x.length !== y.length ? Math.sign(x.length - y.length) : x < y ? -1 : x > y ? 1 : 0;
  }
  if (na !== nb) return na ? -1 : 1; // a number sorts before text
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semantic-version order: -1 when a is older than b, 1 when newer, 0 when equal. A pre-release ("1.0.0-beta") is older than its release.
 * Text that is not a version sorts before every version (and equal to other junk), so the result is a total order that is safe in sort().
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa === pb ? 0 : pa ? 1 : -1;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const c = comparePreIdentifier(pa.pre[i], pb.pre[i]);
    if (c) return c;
  }
  return Math.sign(pa.pre.length - pb.pre.length);
}

/** Is `candidate` a version and newer than `current`? (A candidate that is no version is never newer.) */
export const isNewer = (candidate, current) => parseVersion(candidate) !== null && compareVersions(candidate, current) > 0;

/** "x.y.z" of the next patch, minor or major version after `version`; null when `version` is no plain release. */
export function bumpVersion(version, kind) {
  const p = parseVersion(version);
  if (!p) return null;
  if (kind === 'major') return `${p.major + 1}.0.0`;
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`;
  if (kind === 'patch') return `${p.major}.${p.minor}.${p.pre.length ? p.patch : p.patch + 1}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// The identity of a build
// ---------------------------------------------------------------------------------------------------------

/** A git commit id: 7 to 64 hexadecimal characters (a full SHA-1 is 40, a SHA-256 one 64). */
export const isCommitId = (value) => typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);

/** The 7-character form of a commit id; 'dev' and 'local' stay as they are; anything else becomes ''. */
export function shortCommit(commit) {
  if (isCommitId(commit)) return commit.slice(0, 7).toLowerCase();
  return commit === 'dev' || commit === 'local' ? commit : '';
}

const CHANNELS = Object.freeze(['dev', 'live', 'local']);

/**
 * The build identity with every field made safe: { version, commit, shortCommit, builtAt, channel, repository }.
 * Used on js/build-info.js, whatever it holds. Unknown or missing fields fall back to the development values.
 */
export function normalizeBuild(raw) {
  const b = isPlainObject(raw) ? raw : {};
  const version = own(b, 'version') && parseVersion(b.version) ? b.version.trim().replace(/^v/, '') : '0.0.0';
  const commit = own(b, 'commit') && (isCommitId(b.commit) || b.commit === 'local') ? b.commit.toLowerCase() : 'dev';
  // the channel follows the commit: no commit is a development build, 'local' a hand-made one, a real commit a deployed one unless it says otherwise
  const given = own(b, 'channel') && CHANNELS.includes(b.channel) ? b.channel : null;
  const channel = commit === 'dev' ? 'dev' : commit === 'local' ? 'local' : given === 'dev' || given === 'local' ? given : 'live';
  const builtAt = own(b, 'builtAt') && formatBuildDate(b.builtAt) ? b.builtAt : null;
  const repository = own(b, 'repository') ? normalizeRepositoryUrl(b.repository) : null;
  return { version, commit, shortCommit: shortCommit(commit), builtAt, channel, repository };
}

/** Is this build a deployed one (built by the pipeline from a real commit)? Only such a build compares itself with the version.json of the site. */
export function isReleaseBuild(build) {
  const b = normalizeBuild(build);
  return b.channel === 'live' && isCommitId(b.commit);
}

/** "https://github.com/owner/repo" from "git+https://github.com/owner/repo.git", "https://github.com/owner/repo/" ...; null for anything else. */
export function normalizeRepositoryUrl(value) {
  const text = typeof value === 'string' ? value : isPlainObject(value) && typeof value.url === 'string' ? value.url : '';
  if (!text || text.length > 200) return null;
  const m = /^(?:git\+)?https:\/\/([a-z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(text.trim());
  if (!m || m[2] === '.' || m[2] === '..' || m[3] === '.' || m[3] === '..') return null;
  return `https://${m[1].toLowerCase()}/${m[2]}/${m[3]}`;
}

/** The page of one commit on GitHub; null when the repository is unknown, not on GitHub, or the commit is not a commit id. */
export function commitUrl(repository, commit) {
  const repo = normalizeRepositoryUrl(repository);
  if (!repo || !isCommitId(commit) || !repo.startsWith('https://github.com/')) return null;
  return `${repo}/commit/${commit.toLowerCase()}`;
}

/** The text of the chip: "v0.6.0", "v0.6.0 dev" (development), "v0.6.0 local" (a build made by hand). */
export function versionLabel(build) {
  const b = normalizeBuild(build);
  return `v${b.version}${b.channel === 'live' ? '' : ` ${b.channel}`}`;
}

/** "0.6.0 (a45ce49)", "0.6.0 (development build)": the short form for the report footer. */
export function buildSummary(build) {
  const b = normalizeBuild(build);
  const tail = b.channel === 'live' ? b.shortCommit : b.channel === 'dev' ? 'development build' : 'local build';
  return `v${b.version} (${tail})`;
}

/** Where this copy runs: 'Live site', 'Local development' or 'Built site on this computer'. `host` is location.hostname (optional). */
export function whereItRuns(build, host = '') {
  const b = normalizeBuild(build);
  if (b.channel === 'dev') return 'Local development';
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|.*\.local)$/i.test(String(host || ''));
  return b.channel === 'live' && !local ? 'Live site' : 'Built site on this computer';
}

// ---------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------

const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const MONTHS_LONG = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

/** A date a build or a changelog can plausibly have: 2000 to 2199. */
const plausible = (date) => date.getUTCFullYear() >= 2000 && date.getUTCFullYear() < 2200;

/**
 * A moment in time as the viewer reads it.
 * @param {string} iso an ISO 8601 date and time WITH a zone ("2026-10-09T15:08:00Z"); anything else gives null
 * @param {{ timeZone?: string }} [opts] the zone to show "local" in (default: the viewer's own; a bad name falls back to it)
 * @returns {{ iso: string, day: string, local: string, zone: string, utc: string } | null}
 *   day "9 Oct 2026", local "9 Oct 2026, 17:08 CEST", utc "2026-10-09 15:08 UTC"
 */
export function formatBuildDate(iso, { timeZone } = {}) {
  const parts0 = typeof iso === 'string' && iso.length <= MAX_TEXT ? ISO_INSTANT.exec(iso) : null;
  // JavaScript reads "2026-02-30" as the 2nd of March: only a real calendar day, hour, minute and second pass
  if (!parts0 || !parseDay(parts0[1]) || Number(parts0[2]) > 23 || Number(parts0[3]) > 59 || Number(parts0[4] || 0) > 59) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || !plausible(date)) return null;
  const utc = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  let parts = null;
  for (const zone of [timeZone, undefined]) {
    try {
      parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
      }).formatToParts(date).map((p) => [p.type, p.value]));
      break;
    } catch {
      parts = null; // a zone name the browser does not know: show the viewer's own
    }
  }
  if (!parts) return { iso, day: utc.slice(0, 10), local: utc, zone: 'UTC', utc };
  const day = `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}`;
  const zone = parts.timeZoneName || '';
  return { iso, day, local: `${day}, ${parts.hour}:${parts.minute}${zone ? ` ${zone}` : ''}`, zone, utc };
}

/** A calendar day "2026-10-09" as the Date of that day at 00:00 UTC; null for anything that is not a real day. */
export function parseDay(text) {
  const m = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim()) : null;
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const real = date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]);
  return real && plausible(date) ? date : null;
}

/** "9 October 2026" for "2026-10-09"; '' when the text is no real day. No time zone is involved: a changelog day is a calendar day. */
export function formatDay(text) {
  const date = parseDay(text);
  return date ? `${date.getUTCDate()} ${MONTHS_LONG[date.getUTCMonth()]} ${date.getUTCFullYear()}` : '';
}

// ---------------------------------------------------------------------------------------------------------
// The changelog (CHANGELOG.md, "Keep a Changelog" style)
// ---------------------------------------------------------------------------------------------------------

const ENTRY_HEADING = /^##\s+\[?(Unreleased|v?[0-9][^\]\s]*)\]?(?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?(?:\s.*)?$/i;

/**
 * Read CHANGELOG.md. Each "## [0.6.0] - 2026-10-09" starts an entry, each "### Added" a section of it, each "- text" an item (a following line
 * that is indented continues the item). Everything else is ignored: a heading that is no version, text between entries, junk. Sections without
 * items are left out. Never throws; text that is not a string gives [].
 * @returns {Array<{ version: string, date: string|null, unreleased: boolean, sections: Array<{ title: string, items: string[] }> }>} in file order
 */
export function parseChangelog(text) {
  if (typeof text !== 'string') return [];
  const L = CHANGELOG_LIMITS;
  const entries = [];
  try {
    let entry = null;
    let section = null;
    let item = null; // the item an indented line continues
    for (const raw of text.slice(0, L.chars).split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (/^##\s/.test(line)) {
        entry = null;
        section = null;
        item = null;
        const m = ENTRY_HEADING.exec(line);
        if (!m || entries.length >= L.entries) continue;
        const unreleased = /^unreleased$/i.test(m[1]);
        const version = unreleased ? 'Unreleased' : m[1].replace(/^v/, '');
        if (!unreleased && !parseVersion(version)) continue;
        entry = { version, date: m[2] && parseDay(m[2]) ? m[2] : null, unreleased, sections: [] };
        entries.push(entry);
      } else if (/^###\s/.test(line)) {
        item = null;
        section = null;
        if (!entry) continue;
        const title = line.replace(/^###\s+/, '').trim().slice(0, L.title);
        if (!title) continue;
        section = { title, items: [] };
        if (entry.sections.length < L.sections) entry.sections.push(section); // beyond the cap the section is read into the void
      } else if (/^\s{0,3}[-*+]\s+\S/.test(line)) {
        if (!entry) continue;
        if (!section) {
          section = { title: 'Changes', items: [] };
          if (entry.sections.length < L.sections) entry.sections.push(section);
        }
        item = null;
        if (section.items.length >= L.items) continue;
        section.items.push(line.replace(/^\s*[-*+]\s+/, '').slice(0, L.item));
        item = section.items.length - 1;
      } else if (/^\s+\S/.test(line) && section && item !== null) {
        const joined = `${section.items[item]} ${line.trim()}`;
        section.items[item] = joined.slice(0, L.item);
      } else if (!line.trim()) {
        item = null;
      }
    }
  } catch {
    // an unexpected failure keeps what was read so far
  }
  for (const e of entries) e.sections = e.sections.filter((s) => s.items.length > 0);
  return entries;
}

/** The newest entry that has been released (the first one in the file that is not "Unreleased"), or null. */
export const latestRelease = (entries) => (Array.isArray(entries) ? entries.find((e) => e && !e.unreleased) || null : null);

/**
 * A line of changelog text as pieces: **bold**, *italic* and `code` are kept, everything else is plain text. The caller builds elements and sets
 * textContent, so no markup from the file is ever interpreted.
 * @returns {Array<{ type: 'text'|'strong'|'em'|'code', text: string }>}
 */
export function parseInline(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  let last = 0;
  for (const m of text.matchAll(/\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`/g)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { type: 'strong', text: m[1] } : m[2] !== undefined ? { type: 'em', text: m[2] } : { type: 'code', text: m[3] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Is a newer version live? (a pure function of this build and the version.json that was fetched)
// ---------------------------------------------------------------------------------------------------------

/**
 * What a fetched version.json says, or null when it cannot be trusted. Only the version (a real version number) and the commit (hex) decide
 * anything; the build time is kept when it is a real ISO date. Nothing else is read.
 * @returns {{ version: string, commit: string, shortCommit: string, builtAt: string|null } | null}
 */
export function readRemoteBuild(fetched) {
  try {
    if (!isPlainObject(fetched)) return null;
    if (!own(fetched, 'commit') || !isCommitId(fetched.commit)) return null;
    if (!own(fetched, 'version') || !parseVersion(fetched.version)) return null;
    const builtAt = own(fetched, 'builtAt') && formatBuildDate(fetched.builtAt) ? fetched.builtAt : null;
    return { version: fetched.version.trim().replace(/^v/, ''), commit: fetched.commit.toLowerCase(), shortCommit: shortCommit(fetched.commit), builtAt };
  } catch {
    return null;
  }
}

/** The same commit? A short id counts as the same as the long id it starts. */
export function sameCommit(a, b) {
  if (!isCommitId(a) || !isCommitId(b)) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Is the site serving a newer build than the one that is running? True only for a deployed build (commit of the pipeline, channel 'live')
 * and a version.json that has a different commit and a version that is not older. A development build, a hand-made one, junk, a missing
 * field, a commit that is the same and a version that went backwards all give `available: false` (the caller stays silent).
 * @returns {{ available: boolean, reason: string, remote: object|null }} reason: 'newer' | 'same' | 'older' | 'unreadable' | 'not-deployed'
 */
export function updateVerdict(build, fetched) {
  const none = (reason) => ({ available: false, reason, remote: null });
  try {
    const mine = normalizeBuild(build);
    if (!isReleaseBuild(mine)) return none('not-deployed');
    const remote = readRemoteBuild(fetched);
    if (!remote) return none('unreadable');
    if (sameCommit(mine.commit, remote.commit)) return none('same');
    if (compareVersions(remote.version, mine.version) < 0) return none('older');
    return { available: true, reason: 'newer', remote };
  } catch {
    return none('unreadable');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------------------------------------

/** The tooltip of the chip: "Build a45ce49, 9 Oct 2026 – click for what is new". `update` is the verdict's remote when a newer build is live. */
export function chipTooltip(build, { update = null, timeZone } = {}) {
  const b = normalizeBuild(build);
  const when = b.builtAt ? formatBuildDate(b.builtAt, { timeZone }) : null;
  const day = when ? `, ${when.day}` : '';
  const text = b.channel === 'dev' ? 'Development build, not deployed – click for what is new'
    : b.channel === 'local' ? `Local build${day} – click for what is new`
      : `Build ${b.shortCommit}${day} – click for what is new`;
  return update ? `Update available${update.version ? ` (v${update.version})` : ''} – click to see what is new and to reload. ${text}` : text;
}

/** The spoken name of the chip (aria-label). */
export function chipAriaLabel(build, { update = null } = {}) {
  const b = normalizeBuild(build);
  const kind = b.channel === 'dev' ? ', development build' : b.channel === 'local' ? ', local build' : '';
  return `LogiPlan version ${b.version}${kind}${update ? '. An update is available' : ''}. Show version information and what is new`;
}

/** "Chrome 126", "Firefox 127", "Safari 17", "Edge 126", or 'an unknown browser', from a user-agent string. */
export function browserName(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 400) : '';
  for (const [name, re] of [['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/], ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/], ['Chrome', /\b(?:Chrome|HeadlessChrome|CriOS)\/(\d+)/], ['Safari', /\bVersion\/(\d+)[^]*\bSafari\//]]) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return 'an unknown browser';
}

/**
 * The one line for a bug report: "LogiPlan v0.6.0 (a45ce49, built 2026-10-09 15:08 UTC), Chrome 126, window 1440 x 900 on a 1920 x 1080 screen".
 * @param {object} build
 * @param {{ userAgent?: string, window?: { width: number, height: number }, screen?: { width: number, height: number } }} [env]
 */
export function bugReportLine(build, { userAgent = '', window: win = null, screen = null } = {}) {
  const b = normalizeBuild(build);
  const when = b.builtAt ? formatBuildDate(b.builtAt) : null;
  const built = when ? `built ${when.utc}` : null;
  const what = b.channel === 'dev' ? ['development build'] : b.channel === 'local' ? ['local build', built] : [b.shortCommit, built];
  const size = (s) => (s && Number.isFinite(s.width) && Number.isFinite(s.height) ? `${Math.round(s.width)} x ${Math.round(s.height)}` : '');
  const sizes = size(win) && size(screen) ? `window ${size(win)} on a ${size(screen)} screen` : size(win) ? `window ${size(win)}` : size(screen) ? `screen ${size(screen)}` : '';
  const browser = typeof userAgent === 'string' && userAgent.trim() ? browserName(userAgent) : '';
  return [`LogiPlan v${b.version} (${what.filter(Boolean).join(', ')})`, browser, sizes].filter(Boolean).join(', ');
}
