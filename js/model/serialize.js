// Saving, loading and sharing projects. A project is the store's shape { name, scenarios: [{ id, name, layout }], activeId }.
//
//  exportProject  -> JSON text   { app: 'logiplan', schema, name, active: index, scenarios: [{ id, name, layout }] }; `schema` is the
//                                highest schema among the layouts (schema.js: 1 for a plant that uses nothing of the warehouse module)
//  importProject  <- JSON text   a project export, or a bare layout (becomes a one-scenario project); every layout goes
//                                through normalizeLayout; JSON with a `schema` above SCHEMA_MAX is accepted with project.warnings[]
//  encodeShare / decodeShare     the same JSON as one URL-safe string: 'z.' + base64url(deflate-raw) when
//                                CompressionStream exists, else 'p.' + base64url (plain). shareUrl wraps it as `#p=…`.
//
// Input is never trusted: no eval, `__proto__`/`constructor`/`prototype` keys are stripped while parsing, sizes are
// capped (also when decompressing), and every layout is rebuilt field by field by normalizeLayout.
// Readings of the spec: importProject returns { name, scenarios, activeId } and adds `warnings` (string[]) only when
// there is something to warn about (a newer format, skipped scenarios, scenarios beyond MAX_SCENARIOS); unnamed
// scenarios are called "A", "B", … ; `active` is an index into the file's own scenario list.

import { SCHEMA_VERSION } from './defaults.js';
import { SCHEMA_MAX, schemaNeeded } from './schema.js';
import { normalizeLayout, cleanText, cleanId } from './layout.js';
import { nextId } from '../util/ids.js';

const APP = 'logiplan';
const NAME_MAX = 80;
const MAX_SCENARIOS = 100;
const MAX_TEXT_CHARS = 25e6;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const LAYOUT_KEYS = ['grid', 'roads', 'stations', 'flows', 'fleets', 'obstacles'];
const DAMAGED_LINK = 'This share link is damaged or from a newer version.';
const UPDATE_BROWSER = 'This share link is compressed, but this browser cannot open it. Please update your browser.';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Scenario name for index i: A, B, … Z, then S27, S28, … */
const scenarioLetter = (i) => (i < 26 ? String.fromCharCode(65 + i) : `S${i + 1}`);

// ---------------------------------------------------------------------------------------------------------
// JSON files
// ---------------------------------------------------------------------------------------------------------

/**
 * The schema a project file is stamped with: the highest among its layouts, never below the base. Each layout counts with the larger of
 * its stamp and what its content needs (schemaNeeded), so a layout edited after it was stamped still makes an older tab warn.
 */
function projectSchema(scenarios) {
  let schema = SCHEMA_VERSION;
  for (const s of scenarios) {
    const layout = s && s.layout;
    if (layout && Number.isFinite(layout.schema)) schema = Math.max(schema, layout.schema);
    schema = Math.max(schema, schemaNeeded(layout));
  }
  return schema;
}

/**
 * JSON text of a project (see the file header for the format).
 * @param {{name: string, scenarios: Array<{id: string, name: string, layout: object}>, activeId?: string}} project
 * @returns {string}
 */
export function exportProject(project) {
  const scenarios = project && Array.isArray(project.scenarios) ? project.scenarios : [];
  if (!scenarios.length) throw new Error('There is nothing to export: the project has no scenarios.');
  const found = scenarios.findIndex((s) => s.id === project.activeId);
  const active = found >= 0 ? found : (Number.isInteger(project.active) ? project.active : 0);
  return JSON.stringify({
    app: APP,
    schema: projectSchema(scenarios),
    name: project.name,
    active: Math.min(Math.max(active, 0), scenarios.length - 1),
    scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, layout: s.layout })),
  });
}

/** JSON.parse reviver that drops keys which could be abused for prototype pollution. */
const safeReviver = (key, value) => (key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value);

function parseJson(text) {
  if (typeof text !== 'string') throw new Error('Expected the text of a LogiPlan project or layout file.');
  if (text.length > MAX_TEXT_CHARS) throw new Error('This file is far too large to be a LogiPlan project.');
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, safeReviver);
  } catch {
    throw new Error('This file is not valid JSON, so it is not a LogiPlan project or layout.');
  }
}

/** The raw scenario entries of parsed JSON: a project's list as it is (their positions matter for `active`) or a bare layout as one entry. */
function rawScenarios(data) {
  if (!isObj(data)) throw new Error('This file does not look like a LogiPlan project or layout.');
  if (Array.isArray(data.scenarios)) return data.scenarios;
  if (LAYOUT_KEYS.some((key) => Object.hasOwn(data, key))) return [{ layout: data }];
  throw new Error('This file does not look like a LogiPlan project or layout.');
}

/** Position (in the kept list) of the scenario the file says was active; 0 plus a warning if that one was not kept. */
function activeScenarioIndex(data, keptFrom, entryCount, warnings) {
  if (!Number.isInteger(data.active) || data.active < 0 || data.active >= entryCount) return 0;
  const kept = keptFrom.indexOf(data.active);
  if (kept < 0) warnings.push('The scenario that was open when this file was saved could not be opened, so the first scenario is shown instead.');
  return Math.max(kept, 0);
}

/**
 * Read a project export, or a bare layout JSON. Layouts are normalized.
 * @param {string} text
 * @returns {{name: string, scenarios: Array<{id: string, name: string, layout: object}>, activeId: string, warnings?: string[]}}
 * @throws {Error} with a friendly message when the text is not a LogiPlan file
 */
export function importProject(text) {
  const data = parseJson(text);
  const entries = rawScenarios(data);
  const warnings = [];
  const scenarios = [];
  const keptFrom = []; // position in the file of each kept scenario
  const usedIds = new Set();
  let newest = Number.isFinite(data.schema) ? data.schema : 0;
  entries.slice(0, MAX_SCENARIOS).forEach((src, i) => {
    if (!isObj(src) || !isObj(src.layout)) {
      warnings.push(`Scenario ${i + 1} contains no layout and was skipped.`);
      return;
    }
    if (Number.isFinite(src.layout.schema)) newest = Math.max(newest, src.layout.schema);
    let id = cleanId(src.id);
    if (!id || usedIds.has(id)) id = nextId('sc', usedIds);
    usedIds.add(id);
    scenarios.push({ id, name: cleanText(src.name, NAME_MAX, scenarioLetter(scenarios.length)), layout: normalizeLayout(src.layout) });
    keptFrom.push(i);
  });
  if (entries.length > MAX_SCENARIOS) warnings.push(`This file holds ${entries.length} scenarios; only the first ${MAX_SCENARIOS} were opened.`);
  if (!scenarios.length) throw new Error('This file contains no layout to open.');
  if (newest > SCHEMA_MAX) {
    warnings.unshift(`This file was saved by a newer version of LogiPlan (format ${newest}; this version reads format ${SCHEMA_MAX}). It was opened anyway, but newer details may be missing.`);
  }
  const activeIndex = activeScenarioIndex(data, keptFrom, entries.length, warnings);
  const project = {
    name: cleanText(data.name, NAME_MAX, scenarios[0].layout.name),
    scenarios,
    activeId: scenarios[activeIndex].id,
  };
  if (warnings.length) project.warnings = warnings;
  return project;
}

// ---------------------------------------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map([...B64].map((ch, i) => [ch, i]));

function toBase64Url(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    parts.push(B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '') + (i + 2 < bytes.length ? B64[n & 63] : ''));
  }
  return parts.join('');
}

/** Decode base64url (standard base64 characters and padding are tolerated, as chat apps may rewrite them). */
function fromBase64Url(text) {
  const clean = text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (/[^A-Za-z0-9_-]/.test(clean) || clean.length % 4 === 1) throw new Error('not base64url');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64_INDEX.get(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return bytes;
}

/** Push `bytes` through a (De)CompressionStream and collect the output; rejects on bad data or beyond `maxBytes`. */
async function pump(bytes, stream, maxBytes = Infinity) {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = writer.write(bytes).then(() => writer.close()).catch(() => {}); // failures surface on the read side
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error('output too large');
      chunks.push(value);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    throw err;
  }
  await writing;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The whole project as one URL-safe string: 'z.…' (deflate-raw + base64url) or, where CompressionStream is
 * missing or fails, 'p.…' (plain base64url).
 * @returns {Promise<string>}
 */
export async function encodeShare(project) {
  const bytes = new TextEncoder().encode(exportProject(project));
  if (typeof CompressionStream === 'function') {
    try {
      return `z.${toBase64Url(await pump(bytes, new CompressionStream('deflate-raw')))}`;
    } catch {
      // fall back to the uncompressed form below
    }
  }
  return `p.${toBase64Url(bytes)}`;
}

/**
 * Accept the bare payload, `p=<payload>`, `#p=<payload>` or a full URL containing it. Whitespace (mail clients wrap long
 * links) and punctuation around the link (a trailing full stop, brackets, quotes) are ignored.
 */
function sharePayload(str) {
  let s = String(str).trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  s = s.replace(/\s+/g, '').replace(/^["'<([]+/, '').replace(/[.,;:!?)\]}>"']+$/, '');
  return s.startsWith('p=') ? s.slice(2) : s;
}

/** A deflate-raw decompressor, or the "please update your browser" error where the browser has none. */
function createInflater() {
  try {
    return new DecompressionStream('deflate-raw');
  } catch {
    throw new Error(UPDATE_BROWSER);
  }
}

/**
 * Inverse of encodeShare.
 * @returns {Promise<object>} the project (see importProject)
 * @throws {Error} "This share link is damaged or from a newer version." for anything that is not a valid link;
 *   a different message for a compressed link in a browser that cannot decompress it
 */
export async function decodeShare(str) {
  const payload = sharePayload(str);
  const kind = payload.slice(0, 2);
  if (kind !== 'z.' && kind !== 'p.') throw new Error(DAMAGED_LINK);
  const inflater = kind === 'z.' ? createInflater() : null;
  try {
    let bytes = fromBase64Url(payload.slice(2));
    if (inflater) bytes = await pump(bytes, inflater, MAX_INFLATED_BYTES);
    return importProject(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(DAMAGED_LINK);
  }
}

/** `${base}#p=${encodeShare(project)}` (any hash already on `base` is dropped). */
export async function shareUrl(base, project) {
  return `${String(base).split('#')[0]}#p=${await encodeShare(project)}`;
}
