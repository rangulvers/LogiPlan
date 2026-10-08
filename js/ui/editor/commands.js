// Keyboard commands on the current selection: delete, nudge with the arrow keys, duplicate, select all. Each takes the
// editor host (see editor.js), changes the layout through `ed.commit` (one undo step, human-readable label) and returns
// true when it handled the key, so the caller can keep the browser from acting on it too.

import { removeStation, removeObstacle, removeLabel, removeFlow, eraseRoadCell } from '../../model/layout.js';
import { parseKey } from '../../util/grid.js';
import { checkMove, applyMove, applyDuplicate, duplicateOffset, isMovable, itemsText } from './moves.js';

const REMOVERS = {
  station: removeStation,
  obstacle: removeObstacle,
  label: removeLabel,
  flow: removeFlow,
  cell: (draft, key) => eraseRoadCell(draft, ...parseKey(key)),
};

/** Delete the selected stations, walls, labels, flows or road cells. Fleets are managed in the fleet panel, not here. */
export function deleteSelection(ed) {
  const sel = ed.ui().selection;
  const remove = REMOVERS[sel.kind];
  if (!remove || sel.ids.length === 0) return false;
  const layout = ed.layout();
  const label = `Delete ${itemsText(layout, sel)}`;
  const flowsLost = sel.kind === 'station' ? layout.flows.filter((f) => sel.ids.includes(f.from) || sel.ids.includes(f.to)).length : 0;
  const ok = ed.commit(label, (draft) => { for (const id of sel.ids) remove(draft, id); });
  if (ok && flowsLost > 0) {
    const flows = flowsLost === 1 ? '1 flow' : `${flowsLost} flows`;
    ed.toast(`Deleted ${itemsText(layout, sel)} and ${flows}.`, { action: { label: 'Undo', onClick: () => ed.store.undo() } });
  }
  return true;
}

/** Move the selection by (dx, dy) cells. Holding an arrow key repeats the nudge as one undo step. */
export function nudgeSelection(ed, dx, dy) {
  const sel = ed.ui().selection;
  if (!isMovable(sel)) return false;
  const check = checkMove(ed.layout(), sel, dx, dy);
  if (!check.ok) {
    ed.status(`Cannot move: ${check.reason}.`);
    return true;
  }
  ed.commit(`Nudge ${itemsText(ed.layout(), sel)}`, (draft) => applyMove(draft, sel, dx, dy), { coalesce: `nudge:${sel.kind}:${sel.ids.join(',')}` });
  return true;
}

/** Copy the selection next to itself and select the copies. Always handled: Ctrl+D must never reach the browser's bookmark dialog. */
export function duplicateSelection(ed) {
  const sel = ed.ui().selection;
  if (!isMovable(sel)) {
    ed.status('Select a station, wall or label first, then press Ctrl+D to copy it.');
    return true;
  }
  const layout = ed.layout();
  const offset = duplicateOffset(layout, sel);
  if (!offset && !(sel.kind === 'station' && sel.ids.length === 1)) {
    ed.toast('There is no free space next to the selection for a copy.', { kind: 'warn' });
    return true;
  }
  let copies = null;
  const ok = ed.commit(`Duplicate ${itemsText(layout, sel)}`, (draft) => {
    copies = applyDuplicate(draft, sel, offset);
    return copies !== null;
  });
  if (ok) ed.setSelection(copies);
  else ed.toast('There is no free space for a copy.', { kind: 'warn' });
  return true;
}

/** Select every station. */
export function selectAllStations(ed) {
  const ids = ed.layout().stations.map((s) => s.id);
  if (ids.length) ed.setSelection({ kind: 'station', ids });
  else ed.status('There are no stations to select.');
  return true;
}
