// "Connect two stations" on the canvas: the pure rules behind the flow handle, the click-click connect mode and the
// toast that follows placing a station (docs/ARCHITECTURE.md 6.9). No DOM, no canvas, no store: everything takes a layout
// snapshot and returns plain data, so it is unit-tested in Node (tests/ui.editor.connect.test.js).
//
// Vocabulary
//   anchor    the station the planner starts from: { fromId } ("where do its loads go?") or { toId } ("what feeds it?").
//   target    the station at the other end of the flow that would be created.
//   role      'from' when the anchor sends loads (targets receive), 'to' when the anchor receives (targets send).
//   side      'n' | 'e' | 's' | 'w': the edge of a station rectangle.
//
// The rules are the model's (docs/ARCHITECTURE.md 4.3): a flow starts at a source, workstation or storage, ends at a
// workstation, storage or sink, never joins a station to itself and exists at most once per ordered pair. A pair that is
// already connected is reported as 'exists' (the editor then selects that flow instead of adding a second one).

import { getStation, stationAt } from '../../model/layout.js';
import { FLOW_FROM, FLOW_TO, plannerName, flowProblem } from './tools.js';

/** What the flow handle says on hover (status line and tooltip). */
export const HANDLE_HINT = 'Drag to another station to send loads there';
/** Toast after a flow was created by the handle, the connect mode or the toast action. */
export const FLOW_CREATED = 'Flow created. Vehicles will serve it automatically.';
/** Said when a connect action starts in a plant that has no possible partner yet (role: 'from' | 'to'). */
export const noPartnerText = (role) => (role === 'to'
  ? 'Nothing can feed it yet. Add a Goods in, Workstation or Storage first.'
  : 'There is nothing to send loads to yet. Add a Workstation, Storage or Goods out first.');

/** Can this station send loads along a flow? */
export const canSend = (station) => !!station && FLOW_FROM.includes(station.type);
/** Can this station receive loads along a flow? */
export const canReceive = (station) => !!station && FLOW_TO.includes(station.type);

/** { role, anchorId } of an anchor object, or null when it is neither { fromId } nor { toId }. */
export function anchorOf(anchor) {
  if (anchor && typeof anchor.fromId === 'string') return { role: 'from', anchorId: anchor.fromId };
  if (anchor && typeof anchor.toId === 'string') return { role: 'to', anchorId: anchor.toId };
  return null;
}

const centreOf = (s) => [s.x + s.w / 2, s.y + s.h / 2];

/**
 * Can `candidateId` be the other end of a new flow from `anchor`?
 *   { status: 'valid' }                        a new flow can be added
 *   { status: 'exists', flowId, reason }       the two are connected already (the existing flow is selected instead)
 *   { status: 'self', reason }                 the anchor itself
 *   { status: 'invalid', reason }              the types do not fit (or the station does not exist)
 * `reason` is a sentence for a toast or the status line.
 */
export function classifyTarget(layout, anchor, candidateId) {
  const a = anchorOf(anchor);
  const candidate = getStation(layout, candidateId);
  const anchorStation = a && getStation(layout, a.anchorId);
  if (!a || !anchorStation || !candidate) return { status: 'invalid', reason: 'That is not a station.' };
  if (candidate.id === anchorStation.id) return { status: 'self', reason: 'A station cannot send loads to itself.' };
  const from = a.role === 'from' ? anchorStation : candidate;
  const to = a.role === 'from' ? candidate : anchorStation;
  const problem = flowProblem(from, to);
  if (problem) return { status: 'invalid', reason: problem };
  const existing = layout.flows.find((f) => f.from === from.id && f.to === to.id);
  if (existing) return { status: 'exists', flowId: existing.id, reason: `${from.name} already sends loads to ${to.name}.` };
  return { status: 'valid', reason: null };
}

/**
 * Every station that could be the other end of a new flow from `anchor`.
 * `valid` and `exists` are station ids; `valid` is sorted nearest first (centre to centre), then by id.
 * @returns {{ role: 'from'|'to', anchorId: string, valid: string[], exists: string[] }}
 */
export function connectTargets(layout, anchor) {
  const a = anchorOf(anchor);
  const out = { role: a ? a.role : 'from', anchorId: a ? a.anchorId : '', valid: [], exists: [] };
  const origin = a && getStation(layout, a.anchorId);
  if (!origin) return out;
  const [ox, oy] = centreOf(origin);
  const found = [];
  for (const s of layout.stations) {
    const c = classifyTarget(layout, anchor, s.id);
    if (c.status === 'exists') out.exists.push(s.id);
    else if (c.status === 'valid') {
      const [x, y] = centreOf(s);
      found.push({ id: s.id, d: Math.hypot(x - ox, y - oy) });
    }
  }
  found.sort((p, q) => p.d - q.d || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  out.valid = found.map((f) => f.id);
  return out;
}

/** Id of the closest valid target (see connectTargets), or null. */
export function nearestTarget(layout, anchor) {
  return connectTargets(layout, anchor).valid[0] || null;
}

// ---- the flow handle ------------------------------------------------------------------------------------------

/** Unit vector (pointing out of the rectangle) and angle (rad, East = 0, y down) of each side. */
export const SIDES = Object.freeze({
  e: Object.freeze({ dx: 1, dy: 0, angle: 0 }),
  s: Object.freeze({ dx: 0, dy: 1, angle: Math.PI / 2 }),
  w: Object.freeze({ dx: -1, dy: 0, angle: Math.PI }),
  n: Object.freeze({ dx: 0, dy: -1, angle: -Math.PI / 2 }),
});

/**
 * The side of rectangle {x, y, w, h} through which a straight line from its centre to point (px, py) leaves it.
 * A point at the centre (or a degenerate rectangle) gives 'e'.
 */
export function sideFacing(rect, px, py) {
  const dx = px - (rect.x + rect.w / 2);
  const dy = py - (rect.y + rect.h / 2);
  if (!(Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9)) return 'e';
  // the line exits through a vertical edge when |dx| / (w/2) >= |dy| / (h/2)
  if (Math.abs(dx) * rect.h >= Math.abs(dy) * rect.w) return dx >= 0 ? 'e' : 'w';
  return dy >= 0 ? 's' : 'n';
}

/**
 * Which edge of station `stationId` carries the flow handle: the one that faces the nearest valid destination,
 * or the right edge ('e') when there is none (or the station cannot send).
 */
export function handleSide(layout, stationId) {
  const s = getStation(layout, stationId);
  if (!canSend(s)) return 'e';
  const target = getStation(layout, nearestTarget(layout, { fromId: stationId }));
  if (!target) return 'e';
  const [tx, ty] = centreOf(target);
  return sideFacing(s, tx, ty);
}

/**
 * Where the handle sits for a rectangle (any unit) and a side: the middle of that edge, moved `offset` further out.
 * `angle` is the direction the arrow glyph points (out of the station).
 * @returns {{ x: number, y: number, angle: number, edgeX: number, edgeY: number }}
 */
export function handlePlacement(rect, side, offset = 0) {
  const v = SIDES[side] || SIDES.e;
  const edgeX = rect.x + rect.w / 2 + (v.dx * rect.w) / 2;
  const edgeY = rect.y + rect.h / 2 + (v.dy * rect.h) / 2;
  return { x: edgeX + v.dx * offset, y: edgeY + v.dy * offset, angle: v.angle, edgeX, edgeY };
}

/** Does the point (px, py) lie within `radius` of the handle centre? */
export const insideHandle = (placement, px, py, radius) => Math.hypot(px - placement.x, py - placement.y) <= radius;

/** Does the station show a flow handle when it is the only selected thing (select tool)? */
export const hasHandle = (station) => canSend(station);

// ---- dropping on a station ------------------------------------------------------------------------------------

/**
 * What releasing (or clicking) on grid cell [cx, cy] does when connecting from `anchor`:
 *   { outcome: 'connect', fromId, toId, label }    add the flow (`label` is the undo step name)
 *   { outcome: 'exists', flowId, message }         select that flow, tell the planner it is there already
 *   { outcome: 'invalid' | 'self', message }       a station that cannot be the other end
 *   { outcome: 'none', message }                   no station there (empty ground, road, wall)
 * `message` is a sentence for a toast; it says what to do next.
 */
export function dropTarget(layout, anchor, cell) {
  const a = anchorOf(anchor);
  const here = cell ? stationAt(layout, cell[0], cell[1]) : null;
  if (!a || !getStation(layout, a.anchorId)) return { outcome: 'none', message: 'That station is gone.' };
  if (!here) return { outcome: 'none', message: noDropText(a.role) };
  const c = classifyTarget(layout, anchor, here.id);
  if (c.status === 'valid') {
    const fromId = a.role === 'from' ? a.anchorId : here.id;
    const toId = a.role === 'from' ? here.id : a.anchorId;
    return { outcome: 'connect', fromId, toId, label: connectLabel(layout, fromId, toId) };
  }
  if (c.status === 'exists') return { outcome: 'exists', flowId: c.flowId, message: c.reason };
  if (c.status === 'self') return { outcome: 'self', message: noDropText(a.role) };
  return { outcome: 'invalid', message: `${c.reason} ${tryInstead(a.role)}` };
}

/** Undo step name for a new flow: "Connect Goods in 2 → Assembly". */
export function connectLabel(layout, fromId, toId) {
  const from = getStation(layout, fromId);
  const to = getStation(layout, toId);
  return `Connect ${from ? from.name : fromId} → ${to ? to.name : toId}`;
}

/** Gentle hint after a release that did not connect anything. */
function noDropText(role) {
  return role === 'from'
    ? 'Nothing connected. Drop on a Workstation, Storage or Goods out to send loads there.'
    : 'Nothing connected. Choose a Goods in, Workstation or Storage that should feed it.';
}

function tryInstead(role) {
  return role === 'from' ? 'Choose a Workstation, Storage or Goods out.' : 'Choose a Goods in, Workstation or Storage.';
}

// ---- words for the status line and the target labels ------------------------------------------------------------

/** Status line while connecting from `anchor` with nothing under the pointer. */
export function connectingText(layout, anchor) {
  const a = anchorOf(anchor);
  const s = a && getStation(layout, a.anchorId);
  if (!s) return '';
  return a.role === 'from'
    ? `Where should ${s.name} send its loads? Click the receiving station. Esc cancels.`
    : `What feeds ${s.name}? Click the station that sends loads to it. Esc cancels.`;
}

/**
 * Status line while the pointer is over station `overId` during connecting.
 * @param {'Click'|'Drop'} verb
 */
export function overText(layout, anchor, overId, verb = 'Click') {
  const a = anchorOf(anchor);
  const c = classifyTarget(layout, anchor, overId);
  if (!a) return '';
  if (c.status === 'self') return connectingText(layout, anchor);
  if (c.status !== 'valid') return c.reason;
  const anchorSt = getStation(layout, a.anchorId);
  const over = getStation(layout, overId);
  const [from, to] = a.role === 'from' ? [anchorSt, over] : [over, anchorSt];
  return `${verb} to send loads from ${from.name} to ${to.name}`;
}

/** Short label shown on the station under the pointer: 'Drop to connect', 'Already connected', 'Cannot receive loads'. */
export function targetLabel(status, verb = 'Drop', role = 'from') {
  if (status === 'valid') return `${verb} to connect`;
  if (status === 'exists') return 'Already connected';
  return role === 'from' ? 'Cannot receive loads' : 'Cannot send loads';
}

// ---- after placing a station ------------------------------------------------------------------------------------

/**
 * The hint toast after station `stationId` was placed: { text, anchor }, `anchor` being what the 'Connect' action starts
 * (null when there is nothing to connect yet: the text then says what to add). null for stations that take no part in flows.
 */
export function placementPrompt(layout, stationId) {
  const s = getStation(layout, stationId);
  if (!s || s.type === 'depot') return null;
  const name = plannerName(s.type);
  const canGo = canSend(s) && connectTargets(layout, { fromId: s.id }).valid.length > 0;
  const canBeFed = canReceive(s) && connectTargets(layout, { toId: s.id }).valid.length > 0;
  if (s.type === 'source') {
    return canGo
      ? { text: `${name} placed. Next: where do its loads go?`, anchor: { fromId: s.id } }
      : { text: `${name} placed. Add a Workstation, Storage or Goods out, then connect them.`, anchor: null };
  }
  if (s.type === 'sink') {
    return canBeFed
      ? { text: `${name} placed. What feeds it?`, anchor: { toId: s.id } }
      : { text: `${name} placed. Add a Goods in, Workstation or Storage to feed it.`, anchor: null };
  }
  // workstation and storage: they need loads in and loads out; start with what feeds them
  if (canBeFed) return { text: `${name} placed. What feeds it?`, anchor: { toId: s.id } };
  if (canGo) return { text: `${name} placed. Next: where do its loads go?`, anchor: { fromId: s.id } };
  return { text: `${name} placed. Add a Goods in to feed it and a Goods out to receive its loads.`, anchor: null };
}

/** Why a connect action cannot start from `anchor` (a sentence), or null when it can. */
export function startProblem(layout, anchor) {
  const a = anchorOf(anchor);
  const s = a && getStation(layout, a.anchorId);
  if (!s) return 'That station is gone.';
  if (a.role === 'from' && !canSend(s)) return `${plannerName(s.type)} cannot send loads.`;
  if (a.role === 'to' && !canReceive(s)) return `${plannerName(s.type)} cannot receive loads.`;
  const targets = connectTargets(layout, anchor);
  if (targets.valid.length > 0) return null;
  return targets.exists.length > 0
    ? `${s.name} is connected to every station it can reach. Add another station to connect it further.`
    : noPartnerText(a.role);
}
