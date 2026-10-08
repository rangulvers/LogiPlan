// Rubber-band selection and multi-select bookkeeping for the select tool. Pure, no DOM (unit-tested in Node).
//
// Reading of the spec: an item is selected when the marquee overlaps it ANYWHERE ("partly inside" counts, touching
// an edge does not). A label has no size in the model, so its anchor point must lie inside the marquee.
// The store's selection holds ids of one kind only, so a marquee that covers several kinds selects the first kind
// of this list that it hits: stations, then obstacles, then labels.

/** Kinds in the order a marquee prefers them. */
export const MARQUEE_KINDS = Object.freeze(['station', 'obstacle', 'label']);

/** {x, y, w, h} (w, h >= 0) spanned by two points. */
export function rectFromPoints(ax, ay, bx, by) {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const containsPoint = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * Ids of the stations, obstacles and labels the marquee (a rectangle in fractional cells) touches.
 * @returns {{ station: string[], obstacle: string[], label: string[] }}
 */
export function marqueeHits(layout, rect) {
  return {
    station: layout.stations.filter((s) => overlaps(rect, s)).map((s) => s.id),
    obstacle: layout.obstacles.filter((o) => overlaps(rect, o)).map((o) => o.id),
    label: layout.labels.filter((l) => containsPoint(rect, l.x, l.y)).map((l) => l.id),
  };
}

/** The selection a set of marquee hits stands for: the preferred kind that has hits, else an empty selection. */
export function pickMarquee(hits) {
  const kind = MARQUEE_KINDS.find((k) => hits[k].length > 0);
  return kind ? { kind, ids: hits[kind] } : { kind: null, ids: [] };
}

/** `next` added to `current` when both are of the same kind (Shift+marquee), otherwise `next` alone. */
export function addToSelection(current, next) {
  if (!next.kind || current.kind !== next.kind) return next.kind ? next : current;
  return { kind: next.kind, ids: [...current.ids, ...next.ids.filter((id) => !current.ids.includes(id))] };
}

/** Shift+click: `id` removed from the selection if it is in it, added otherwise (a different kind replaces it). */
export function toggleInSelection(current, kind, id) {
  if (current.kind !== kind) return { kind, ids: [id] };
  const ids = current.ids.includes(id) ? current.ids.filter((i) => i !== id) : [...current.ids, id];
  return ids.length ? { kind, ids } : { kind: null, ids: [] };
}

/** Is `id` part of the selection of this kind? */
export const isSelected = (selection, kind, id) => selection.kind === kind && selection.ids.includes(id);
