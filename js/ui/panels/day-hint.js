// The line under the simulation bar of a DAY PLANT after an edit (docs/WAREHOUSE-DESIGN.md 6.2.7: "The impact card is replaced for day plants by a one-line hint,
// 'Time of day matters. Compare whole days', with an action that opens Experiments"). A day plant restarts cold after every edit (day-plant.js), so the card "Effect of
// your change", which compares short windows of a plant that runs the same all day, is not shown; this line takes its place and says why the figures jumped
// back to the start of the clock and what to do about it. The action opens the Experiments tab, whose run settings then follow whole days (compare.js).
// (The design's second half, two variants made from the plant before and after the edit, is milestone M2, acceptance A2.10.)
//
//   const hint = createDayHint(ctx);   // hint.el, hint.update(state), hint.destroy()
//
// It appears when the runner rebuilds a day plant because of an edit, until the planner closes it, opens Experiments, or the plant stops being a day plant.

import { h } from '../../util/dom.js';
import { icon } from '../icons.js';
import { isDayPlant } from '../day-plant.js';

/** The sentence of the hint (also the toast of the second and later edits says it). */
export const DAY_HINT_TEXT = 'Time of day matters. Compare whole days.';

/** Pure: should the hint be shown? `armed` = the runner restarted a day plant after an edit and nobody has dealt with it. */
export function dayHintVisible({ armed, layout, rightTab }) {
  return Boolean(armed) && isDayPlant(layout) && rightTab !== 'experiments';
}

export function createDayHint(ctx) {
  const open = () => ctx.actions?.setRightTab?.('experiments');
  const main = h('button', {
    class: 'impact-hint__main', type: 'button', title: 'Open Experiments: runs of whole days compare two plants fairly, a run from midnight measures the quiet night',
    onclick: open,
  }, icon('clock', { size: 14 }), h('span', { class: 'impact-hint__tag' }, 'Day plant'), h('span', { class: 'impact-hint__text' }, DAY_HINT_TEXT));
  const close = h('button', {
    class: 'impact-hint__close', type: 'button', 'aria-label': 'Hide this hint', title: 'Hide this hint',
    onclick: () => { armed = false; update(); },
  }, icon('close', { size: 12 }));
  const el = h('div', { class: 'impact-hint', 'data-panel': 'day-hint', hidden: true }, main, close);
  let armed = false;
  let destroyed = false;

  function update(state) {
    if (destroyed) return;
    const s = state || ctx.store?.getState?.();
    if (!s) return;
    if (!isDayPlant(s.layout)) armed = false;
    if (s.ui && s.ui.rightTab === 'experiments') armed = false; // the planner went there: done
    el.hidden = !dayHintVisible({ armed, layout: s.layout, rightTab: s.ui && s.ui.rightTab });
  }

  const off = ctx.runner && typeof ctx.runner.on === 'function'
    ? ctx.runner.on('rebuild', ({ reason, sim }) => { if (sim && reason === 'structural') { armed = true; update(); } })
    : () => {};
  update();
  return { el, update, destroy() { destroyed = true; off(); el.remove(); } };
}
