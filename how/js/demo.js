// The live demo of the /how page: the planner's own engine and renderer running a real example plant in the visitor's browser.
//
//   import { mountDemo } from './demo.js';
//   const demo = await mountDemo(document.querySelector('[data-mount="demo"]'));   // -> controller (the styles load first)
//
// Nothing of the planner is copied; everything is imported:
//   js/sim/engine.js        Simulation: the discrete simulation, the file the planner runs
//   js/model/examples.js    EXAMPLES: the planner's example plants
//   js/ui/renderer.js       Renderer: the planner's canvas renderer (baseplate, bricks, roads, vehicles), used without the planner's DOM
//   js/ui/camera.js, render/scene.js, theme.js, util/format.js
// and how/js/demo-logic.js (pacing, figures, the one edit the demo makes) and how/css/demo.css (its look).
//
// The mount is the page's (how/index.html, section "live": div.demo[data-mount="demo"] holding the still picture, marked [data-demo-fallback]); everything
// else is built here, inside the mount, as div.lp-demo (stage with the canvas, controls, figures, notice, status), and the still is hidden when the first
// frame is drawn (and shown again if the demo stops). The mount's data-state says what the demo is doing: idle -> loading -> paused | playing | shift,
// or error / unavailable (set by demo-boot.js). Attributes of the mount: data-demo (the plant it starts with, an id of DEMOS), data-compare="on"
// (start with the change applied and the example beside it in the figures).
//
// Behaviour: starts rolling when it is near the screen (not at all under prefers-reduced-motion: a still frame and a Play button), stops when it
// scrolls away or the tab is hidden, drops simulated seconds - never frames - on a slow machine and says so, never announces on every frame.

import { Simulation } from '../../js/sim/engine.js';
import { EXAMPLES } from '../../js/model/examples.js';
import { Renderer, createView } from '../../js/ui/renderer.js';
import { Camera } from '../../js/ui/camera.js';
import { getTheme } from '../../js/ui/theme.js';
import { getScene } from '../../js/ui/render/scene.js';
import { formatClock, formatDuration } from '../../js/util/format.js';
import { DEMOS, SPEEDS, SHIFT_SECONDS, FIGURES, DemoCore, demoById, contentRect, describeFigures, simBudget } from './demo-logic.js';

const PRIME_SLICE_MS = 6;
const SHIFT_SLICE_MS = 10;
const FIGURES_EVERY_MS = 250;
const TEXT_EVERY_MS = 5000;
const STYLE_WAIT_MS = 3000;
const PLAY_ICON = 'M3 1.5v13l11-6.5z';
const PAUSE_ICON = 'M3 1.5h3.5v13H3zM9.5 1.5H13v13H9.5z';
const RESTART_ICON = 'M8 2.2a5.8 5.8 0 1 0 5.6 7.3h-1.7A4.2 4.2 0 1 1 8 3.8c1.2 0 2.2.5 3 1.2L9 7h5V2l-1.7 1.7A5.8 5.8 0 0 0 8 2.2z';
const SHIFT_ICON = 'M2 2.5l6 5.5-6 5.5zM8.5 2.5l6 5.5-6 5.5z';
const SVG_NS = 'http://www.w3.org/2000/svg';
const THEME = getTheme('dark'); // the demo sits in the page's dark band in both colour schemes

let uid = 0;

/** A User Timing mark (visible in the browser's performance panel and read by the checks of the page). */
function mark(name) {
  try {
    performance.mark(name);
  } catch {
    // no User Timing: nothing to mark
  }
}

/** Create an element with attributes and children (strings become text nodes). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function icon(path) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

const mediaMatches = (query) => {
  try {
    return typeof matchMedia === 'function' && matchMedia(query).matches;
  } catch {
    return false;
  }
};

/** Put demo.css on the page and wait for it (but never longer than STYLE_WAIT_MS: the demo works unstyled too). */
function loadStyles() {
  const href = new URL('../css/demo.css', import.meta.url).href;
  if (document.querySelector('link[data-demo-css]')) return Promise.resolve();
  return new Promise((resolve) => {
    const link = el('link', { rel: 'stylesheet', href, 'data-demo-css': '' });
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, STYLE_WAIT_MS);
    document.head.append(link);
  });
}

/** Build the frame inside the mount: stage with the canvas, controls, figures, notice and status. */
function frameOf(root) {
  const app = el('div', { class: 'lp-demo', hidden: true });
  const canvas = el('canvas', { class: 'lp-demo__canvas', role: 'img', 'aria-label': 'Plant being simulated' });
  const stage = el('div', { class: 'lp-demo__stage' }, canvas);
  const controls = el('div', { class: 'lp-demo__controls' });
  const numbers = el('div', { class: 'lp-demo__numbers' });
  const notice = el('p', { class: 'lp-demo__notice' });
  const status = el('p', { class: 'lp-demo__text', role: 'status' });
  app.append(stage, controls, numbers, notice, status);
  root.append(app);
  return { app, stage, canvas, still: root.querySelector('[data-demo-fallback]'), controls, numbers, notice, status };
}

/**
 * Build the demo in `root`. Resolves with the controller; rejects when the browser cannot run it (the boot script then keeps the still).
 * @param {HTMLElement} root the mount
 * @param {{ demo?: string, compare?: boolean }} [options]
 */
export async function mountDemo(root, options = {}) {
  mark('lp-demo:modules-ready');
  await loadStyles();
  mark('lp-demo:styles-ready');
  const id = ++uid;
  const reducedMotion = mediaMatches('(prefers-reduced-motion: reduce)');
  const core = new DemoCore({ Simulation, examples: EXAMPLES });
  const frame = frameOf(root);
  const noticeText = 'The live version is getting ready.';

  const state = {
    demoId: options.demo || root.getAttribute('data-demo') || DEMOS[0].id,
    compare: options.compare ?? root.getAttribute('data-compare') === 'on',
    view: 1, // which plant the picture shows when two run (0: the example, 1: with the change)
    wantPlay: !reducedMotion, // what the visitor wants (a pause by hand clears it; reduced motion never starts by itself)
    inView: false,
    hidden: document.hidden,
    drawMs: 0,
    dirty: true,
    raf: 0,
    lastT: null,
    lastFiguresAt: -Infinity,
    lastTextAt: -Infinity,
    lastShiftDrawAt: -Infinity,
    destroyed: false,
    reveal: 0, // 0, or the step of showing a freshly primed plant (onPrimed)
    shiftResult: '',
    live: '',
  };

  // ---- the picture ----
  const camera = new Camera();
  const renderer = new Renderer(frame.canvas, { camera, theme: THEME, reducedMotion });
  const view = createView();
  view.overlays = { ...view.overlays, grid: false, studs: true, flows: true, docks: false, jobs: true, heat: 'off', ids: false, labels: true, routes: false };
  renderer.view = view;

  const veil = el('div', { class: 'lp-demo__veil', role: 'presentation' }, 'Setting up the plant');
  const progress = el('div', { class: 'lp-demo__progress', hidden: true }, el('i'));
  const titleTag = el('span', { class: 'lp-demo__tag' });
  const clockTag = el('span', { class: 'lp-demo__tag', 'aria-hidden': 'true' });
  const slowTag = el('span', { class: 'lp-demo__tag lp-demo__tag--warn', hidden: true });
  const viewSeg = el('div', { class: 'lp-demo__seg', role: 'radiogroup', 'aria-label': 'Plant shown in the picture', hidden: true });
  const segName = `seg-${id}`;
  const segInputs = [0, 1].map((i) => el('input', { type: 'radio', name: segName, value: i }));
  segInputs.forEach((input, i) => viewSeg.append(el('label', {}, input, el('span', { text: i === 0 ? 'The example' : 'With the change' }))));
  frame.stage.append(
    el('div', { class: 'lp-demo__hud lp-demo__hud--tl' }, titleTag),
    el('div', { class: 'lp-demo__hud lp-demo__hud--tr' }, viewSeg),
    el('div', { class: 'lp-demo__hud lp-demo__hud--bl' }, clockTag, slowTag),
    progress,
    veil,
  );

  // ---- controls ----
  const plantInputs = DEMOS.map((d) => el('input', { type: 'radio', name: `plant-${id}`, value: d.id }));
  const plantChips = el('div', { class: 'lp-demo__chips' });
  DEMOS.forEach((d, i) => plantChips.append(el('label', { class: 'lp-demo__chip' }, plantInputs[i], el('span', { text: d.title }))));
  const speedInputs = SPEEDS.map((s) => el('input', { type: 'radio', name: `speed-${id}`, value: s }));
  const speedChips = el('div', { class: 'lp-demo__chips' });
  SPEEDS.forEach((s, i) => speedChips.append(el('label', { class: 'lp-demo__chip' }, speedInputs[i], el('span', {}, `${s}×`, el('span', { class: 'lp-demo__sr', text: ' speed' })))));
  const playBtn = el('button', { type: 'button', class: 'btn btn--primary btn--sm btn--play' });
  const restartBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, icon(RESTART_ICON), 'Restart');
  const shiftBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--sm' });
  const compareInput = el('input', { type: 'checkbox', role: 'switch' });
  const compareText = el('span', {});
  const compareLabel = el('label', { class: 'lp-demo__switch' }, compareInput, el('span', { class: 'lp-demo__track', 'aria-hidden': 'true' }), compareText);
  const scenarioEl = el('p', { class: 'lp-demo__scenario', hidden: true });
  frame.controls.replaceChildren(el('div', { class: 'lp-demo__bar', role: 'group', 'aria-label': 'Live simulation controls' },
    el('div', { class: 'lp-demo__group' }, playBtn, restartBtn, shiftBtn),
    el('fieldset', {}, el('legend', { text: 'Speed' }), speedChips),
    el('fieldset', {}, el('legend', { text: 'Plant' }), plantChips),
    el('div', { class: 'lp-demo__group' }, compareLabel),
    scenarioEl));

  // ---- the figures ----
  const figsEl = el('dl', { class: 'lp-demo__figs' });
  const shiftEl = el('p', { class: 'lp-demo__shift', hidden: true });
  const textP = el('p', {});
  const countsUl = el('ul', { class: 'lp-demo__counts' });
  const more = el('details', { class: 'lp-demo__more' }, el('summary', { text: 'The figures in words, and what each one counts' }), textP, countsUl);
  frame.numbers.replaceChildren(el('h3', { class: 'lp-demo__sr', text: 'Figures from the running simulation' }), figsEl, shiftEl, more);
  let figEls = [];
  let figPanes = 0;

  // ---- helpers ----
  const demo = () => demoById(state.demoId);
  const shifting = () => core.shift !== null && !core.shift.done;

  function setState(name) {
    if (root.getAttribute('data-state') !== name) root.setAttribute('data-state', name);
  }

  let announceTimer = 0;
  /** Say something to screen readers through the status line: only on what the visitor did, never per frame. The line is emptied first so that the same words twice are heard twice. */
  function announce(text) {
    state.live = text;
    frame.status.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { frame.status.textContent = state.live; }, 60);
  }

  function paneName(i) {
    return state.compare ? (i === 0 ? 'The example' : demo().change.label) : demo().title;
  }

  function shownPane() {
    return core.panes[state.compare ? state.view : 0];
  }

  // ---- drawing ----
  function fit() {
    const pane = shownPane();
    if (!pane) return;
    renderer.resize();
    const scene = getScene(pane.layout);
    if (scene) camera.fitRect(contentRect(scene), renderer.cssW, renderer.cssH, 8);
    state.dirty = true;
  }

  function draw(alpha = 1) {
    const pane = shownPane();
    if (!pane) return;
    const t0 = performance.now();
    if (renderer.layout !== pane.layout) renderer.layout = pane.layout;
    if (renderer.sim !== pane.sim) renderer.sim = pane.sim;
    renderer.render(alpha);
    const spent = performance.now() - t0;
    state.drawMs = state.drawMs === 0 ? spent : state.drawMs * 0.8 + spent * 0.2;
  }

  // ---- figures and text ----
  function figureRows(figures) {
    const first = figures[0];
    if (figEls.length !== first.items.length || figPanes !== figures.length) {
      figsEl.replaceChildren();
      figPanes = figures.length;
      figEls = first.items.map(() => {
        const label = el('dt');
        const cells = figures.map((_, i) => {
          const value = document.createTextNode('');
          const note = el('small');
          const tag = figures.length > 1 ? el('em', { text: i === 0 ? 'Example' : 'With the change' }) : null;
          const wrap = el('span', { class: `lp-demo__val${figures.length > 1 && i === 1 ? ' lp-demo__val--new' : ''}` }, tag, value, note);
          return { value, note, wrap };
        });
        figsEl.append(el('div', { class: 'lp-demo__fig' }, label, el('dd', {}, ...cells.map((c) => c.wrap))));
        return { label, cells };
      });
    }
    figures.forEach((fig, p) => fig.items.forEach((item, k) => {
      const row = figEls[k];
      if (row.label.textContent !== item.label) row.label.textContent = item.label;
      const cell = row.cells[p];
      if (cell.value.nodeValue !== item.value) cell.value.nodeValue = item.value;
      if (cell.note.textContent !== item.note) cell.note.textContent = item.note;
    }));
    figsEl.setAttribute('data-warming', String(figures[0].warmingUp));
  }

  function updateFigures(force = false) {
    const now = performance.now();
    if (!force && now - state.lastFiguresAt < FIGURES_EVERY_MS) return;
    state.lastFiguresAt = now;
    const figures = core.figures(force);
    figureRows(figures);
    clockTag.textContent = `${formatClock(core.time)} · ${core.speed}×`;
    if (core.playing && core.pacer.limited && core.pacer.effective > 0) {
      slowTag.hidden = false;
      slowTag.textContent = `This machine: about ${Math.max(1, Math.round(core.pacer.effective))}×`;
    } else {
      slowTag.hidden = true;
    }
    if (force || now - state.lastTextAt >= TEXT_EVERY_MS) {
      state.lastTextAt = now;
      textP.textContent = figures.map((fig, i) => describeFigures(paneName(i), fig)).join(' ');
      frame.canvas.setAttribute('aria-label', `${paneName(state.compare ? state.view : 0)}: the ${demo().title} plant running in the simulation, simulated time ${formatClock(core.time)}. The figures below say how it is doing.`);
    }
  }

  function updateControls() {
    const d = demo();
    plantInputs.forEach((input) => { input.checked = input.value === d.id; });
    speedInputs.forEach((input) => { input.checked = Number(input.value) === core.speed; });
    const playing = core.playing;
    const busy = shifting();
    playBtn.replaceChildren(icon(playing ? PAUSE_ICON : PLAY_ICON), playing ? 'Pause' : 'Play');
    playBtn.setAttribute('aria-label', playing ? 'Pause the simulation' : 'Play the simulation');
    playBtn.disabled = !core.primed || busy;
    shiftBtn.replaceChildren(icon(SHIFT_ICON), busy ? 'Stop the shift' : 'Run a whole shift');
    shiftBtn.setAttribute('aria-label', busy ? 'Stop the shift now' : 'Run a whole shift of eight simulated hours as fast as this machine can');
    compareInput.checked = state.compare;
    compareText.textContent = `Change one thing: ${d.change.label.charAt(0).toLowerCase()}${d.change.label.slice(1)}`;
    scenarioEl.textContent = d.scenarioText ? `Both plants get ${d.scenarioText} (the planner's "Demand ×" setting).` : '';
    scenarioEl.hidden = !d.scenarioText || !state.compare;
    viewSeg.hidden = !state.compare;
    segInputs.forEach((input, i) => { input.checked = i === state.view; });
    titleTag.textContent = state.compare ? `${d.title}: ${paneName(state.view)}` : d.title;
    const warm = Math.round(core.panes[0].sim.settings.warmup / 60);
    frame.notice.textContent = core.primed
      ? `The plant starts empty, so the first ${warm} simulated minutes are warm-up and are not counted; this run had passed them, and two minutes more, before you saw it. Figures count from minute ${warm}.${state.compare ? ' Both plants use the same random seed.' : ''}${reducedMotion && !playing ? ' Motion is off because your system asks for less of it: press Play to start.' : ''}`
      : noticeText;
    shiftEl.hidden = !state.shiftResult;
    shiftEl.textContent = state.shiftResult;
    progress.hidden = !busy;
    setState(!core.primed ? 'loading' : busy ? 'shift' : playing ? 'playing' : 'paused');
  }

  // ---- the run ----
  function shouldRun() {
    return state.wantPlay && state.inView && !state.hidden && core.primed && !shifting() && !state.destroyed;
  }

  function syncPlaying() {
    const run = shouldRun();
    if (run && !core.playing) core.play();
    else if (!run && core.playing) core.pause();
    updateControls();
    schedule();
  }

  function schedule() {
    if (state.raf || state.destroyed || !state.inView || state.hidden) return;
    if (!core.playing && !state.dirty && core.primed && !shifting() && state.reveal === 0) return;
    state.raf = requestAnimationFrame(onFrame);
  }

  function onFrame(t) {
    state.raf = 0;
    if (state.destroyed) return;
    const realDt = state.lastT === null ? 0 : Math.max(0, (t - state.lastT) / 1000);
    state.lastT = core.playing || shifting() || !core.primed ? t : null;
    try {
      if (!core.primed) {
        if (core.prime(PRIME_SLICE_MS)) onPrimed();
      } else if (state.reveal > 0) {
        reveal();
      } else if (shifting()) {
        stepShift();
      } else if (core.playing) {
        const { alpha } = core.frame(realDt, state.drawMs);
        draw(alpha);
        updateFigures();
        state.dirty = false;
      } else if (state.dirty) {
        draw(1);
        updateFigures(true);
        state.dirty = false;
      }
    } catch (error) {
      fail(error);
      return;
    }
    schedule();
  }

  function stepShift() {
    const result = core.shiftFrame(Math.max(SHIFT_SLICE_MS, simBudget(state.drawMs)));
    progress.firstChild.style.width = `${Math.round(result.progress * 100)}%`;
    const now = performance.now();
    if (!reducedMotion || result.done || now - state.lastShiftDrawAt > 400) {
      state.lastShiftDrawAt = now;
      draw(1);
      updateFigures(result.done);
    }
    if (result.done) finishShift(result.computeMs);
  }

  function finishShift(computeMs) {
    const hours = Math.round(core.shift.target / 360) / 10;
    state.shiftResult = `${hours} simulated hours took ${formatDuration(computeMs / 1000)} of computing on this machine${state.compare ? ' (both plants together)' : ''}.`;
    state.wantPlay = false;
    updateFigures(true);
    updateControls();
    announce(`${state.shiftResult} ${textP.textContent}`);
    state.dirty = true;
  }

  /** The plant is rolled forward: show it. Three frames, so the one big piece of work (the planner's renderer building the baseplate bitmap) is a task of its own. */
  function onPrimed() {
    mark('lp-demo:primed');
    veil.hidden = true;
    state.reveal = 1;
  }

  function reveal() {
    const step = state.reveal++;
    if (step === 1) {
      fit();
    } else if (step === 2) {
      draw(1);
      mark('lp-demo:first-frame');
    } else {
      state.reveal = 0;
      if (frame.still) frame.still.hidden = true;
      updateFigures(true);
      state.dirty = false;
      syncPlaying();
    }
  }

  /** Build the runs of the chosen plant (cold: nothing run yet) and prime them frame by frame, or start a whole shift. */
  function loadPlant({ shift = false } = {}) {
    core.pause();
    core.load(demo(), { compare: state.compare });
    core.setSpeed(demo().speed);
    state.view = state.compare ? 1 : 0;
    state.reveal = 0;
    state.shiftResult = '';
    countsUl.replaceChildren(...demo().show.map((key) => el('li', {}, el('strong', { text: FIGURES[key].label(demo(), core.reports(true)[0]) }), `: ${FIGURES[key].hint}`)));
    renderer.sim = null;
    renderer.layout = core.panes[0].layout;
    veil.hidden = false;
    state.lastT = null;
    state.dirty = true;
    state.lastFiguresAt = -Infinity;
    state.lastTextAt = -Infinity;
    figEls = [];
    slowTag.hidden = true;
    if (shift) {
      core.beginShift(SHIFT_SECONDS);
      veil.hidden = true;
      progress.firstChild.style.width = '0%';
      if (frame.still) frame.still.hidden = true;
      fit();
    }
    updateControls();
    schedule();
  }

  /** A sentence under the still picture (the page styles [data-demo-note]). */
  function noteBelowStill(text) {
    let note = root.querySelector('[data-demo-note]');
    if (!note) {
      note = el('p', { 'data-demo-note': '', role: 'note' });
      root.append(note);
    }
    note.textContent = text;
  }

  function fail(error) {
    state.destroyed = true;
    if (state.raf) cancelAnimationFrame(state.raf);
    core.pause();
    frame.app.hidden = true;
    if (frame.still) frame.still.hidden = false;
    veil.hidden = true;
    noteBelowStill(`The live simulation stopped (${error && error.message ? error.message : error}), so this is a still picture of it.`);
    setState('error');
    if (typeof console !== 'undefined') console.error(error);
  }

  // ---- events ----
  playBtn.addEventListener('click', () => {
    state.wantPlay = !core.playing;
    syncPlaying();
    if (core.playing) announce(`Playing ${demo().title} at ${core.speed} times speed.`);
    else {
      updateFigures(true);
      announce(`Paused at ${formatClock(core.time)}. ${textP.textContent}`);
    }
  });
  restartBtn.addEventListener('click', () => {
    loadPlant();
    announce('Restarted the plant.');
  });
  shiftBtn.addEventListener('click', () => {
    if (shifting()) {
      const at = core.time;
      core.cancelShift();
      state.wantPlay = false;
      state.shiftResult = `Stopped at ${formatClock(at)}.`;
      updateFigures(true);
      updateControls();
      announce(`${state.shiftResult} ${textP.textContent}`);
      state.dirty = true;
      schedule();
    } else {
      loadPlant({ shift: true });
      announce(`Running a whole shift of ${SHIFT_SECONDS / 3600} simulated hours as fast as this machine can.`);
    }
  });
  plantChips.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    state.demoId = event.target.value;
    loadPlant();
    announce(`Plant: ${demo().title}.`);
  });
  speedChips.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    core.setSpeed(Number(event.target.value));
    updateFigures(true);
    updateControls();
    announce(`Speed: ${core.speed} times.`);
  });
  compareInput.addEventListener('change', () => {
    state.compare = compareInput.checked;
    loadPlant();
    announce(state.compare ? `${demo().change.label}: both plants run side by side in the figures, restarted.` : 'One plant, restarted.');
  });
  viewSeg.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    state.view = Number(event.target.value);
    fit();
    updateControls();
    announce(`The picture shows ${paneName(state.view).toLowerCase()}.`);
  });

  const onVisibility = () => {
    state.hidden = document.hidden;
    state.lastT = null;
    syncPlaying();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) state.inView = entry.isIntersecting;
    state.lastT = null;
    syncPlaying();
    if (state.inView) {
      state.dirty = true;
      schedule();
    }
  }, { rootMargin: '120px 0px', threshold: 0 });
  io.observe(root);

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { fit(); schedule(); }) : null;
  if (ro) ro.observe(frame.stage);

  // ---- go ----
  // The frame is built and laid out at once, off screen if the visitor is still far away, so nothing below it moves later; the page's still picture lies over
  // the stage (demo.css, data-state="loading") until the first frame is drawn.
  frame.app.hidden = false;
  try {
    loadPlant();
  } catch (error) {
    state.destroyed = true;
    io.disconnect();
    if (ro) ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    renderer.destroy();
    frame.app.remove();
    throw error;
  }
  mark('lp-demo:mounted');

  const controller = {
    core,
    state,
    get playing() { return core.playing; },
    play() { state.wantPlay = true; syncPlaying(); },
    pause() { state.wantPlay = false; syncPlaying(); },
    setPlant(plantId) { state.demoId = plantId; loadPlant(); },
    setCompare(on) { state.compare = Boolean(on); loadPlant(); },
    runShift() { loadPlant({ shift: true }); },
    destroy() {
      state.destroyed = true;
      if (state.raf) cancelAnimationFrame(state.raf);
      io.disconnect();
      if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.destroy();
      frame.app.hidden = true;
      if (frame.still) frame.still.hidden = false;
      setState('idle');
    },
  };
  root.lpDemo = controller;
  return controller;
}
