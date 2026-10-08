# LogiPlan UI kit

The design system the app shell, panels, dialogs and dashboard are built from: CSS tokens, component styles, an icon
set and dependency-free charts. Everything is plain CSS and ES modules, no build step, no network.

| File | What it is |
|---|---|
| `css/tokens.css` | Design tokens as CSS custom properties: colours (light, dark, print), spacing, radii, type, z-index, motion |
| `css/components.css` | Component styles (`.btn`, `.input`, `.card`, `.table`, `.modal`, `.chart-*` ...) and print rules |
| `js/ui/icons.js` | 69 inline SVG icons: `icon(name, { size, class })`, `iconSvg(...)`, `ICON_NAMES` |
| `js/ui/charts.js` | `createLineChart`, `createBarChart`, `createStackedBar`, `createSparkline`, `createGauge` + pure chart maths |
| `tests/e2e/uikit-demo.html` | Kitchen sink with every component and chart. **Copy markup from here.** |
| `tests/e2e/uikit-visual.mjs` | Screenshots (light, dark, 390 px) and automated checks: `node tests/e2e/uikit-visual.mjs` |

The kit contains **styling and drawing only**. Behaviour (opening a menu, trapping focus in a dialog, arrow keys in
tabs, stepping a stepper) belongs to the panel or dialog code; the markup below carries the right ARIA attributes.

---

## 1. Setup

```html
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/layout.css">   <!-- app shell layout, loaded after the kit -->
```

Relative paths only (the site is served from `/<repo>/` on GitHub Pages). `components.css` contains a small base
(box-sizing, body font and colours, focus ring, thin scrollbars, `[hidden]`), so a page that loads the two kit files
already looks right.

```js
import { icon } from './ui/icons.js';
import { createLineChart } from './ui/charts.js';
```

### Themes

* Default: follows the OS (`prefers-color-scheme`).
* Force a theme with `data-theme="light"` or `data-theme="dark"` on `<html>`; remove the attribute to follow the OS again.
* Print always uses the light palette.
* `store.ui.theme` (`'auto' | 'light' | 'dark'`) maps to that attribute:

```js
const root = document.documentElement;
if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
```

Charts notice the change (attribute, OS scheme, print) and redraw by themselves. The canvas renderer reads
`js/ui/theme.js`, which mirrors the neutral tokens; keep both in step when changing a colour.

---

## 2. Tokens (`css/tokens.css`)

Use tokens, never hex values, in component CSS: `color: var(--text-dim)`.

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--bg` `--surface` `--surface-2` `--surface-3` | page, panel/card/input, subtle fill (table header, input addon), hover/pressed fill |
| Lines | `--border` `--border-strong` `--border-hover` | hairline between regions, control outline, control outline on hover |
| Overlays | `--hover` `--pressed` (translucent), `--track` (switch/slider/progress track), `--scrim` | `--hover`/`--pressed` work on any background |
| Text | `--text` `--text-dim` `--text-faint` | primary, secondary, hints/placeholders/axis labels. All three are AA (4.5:1) on `--surface`, `--bg`, `--surface-2`, `--surface-3` |
| Accent | `--accent` `--accent-solid` `--accent-hover` `--accent-active` `--accent-soft` `--accent-line` `--accent-glow` `--accent-text` `--on-accent` | `--accent` = brand blue for selection, focus and graphics. **Text on an accent fill must use `--accent-solid` + `--on-accent`** (AA). Accent-coloured text uses `--accent-text` |
| Semantic | `--good` `--warn` `--bad` `--info`, each with `-soft` (tinted background) and `-text` (AA text on the soft and plain surface); `--bad-solid` + `--bad-hover` for destructive fills | icons and fills use the plain token, words use `-text` |
| Inverse | `--inverse-bg` `--inverse-text` `--inverse-accent` `--inverse-good` `--inverse-warn` `--inverse-bad` | tooltips and toasts (dark on light theme, light on dark theme) |
| Stations | `--st-source` `--st-process` `--st-storage` `--st-sink` `--st-depot`; `-ink` (text/icon colour with AA contrast on the brick), `-soft` (tinted background) | brick colours of docs/ARCHITECTURE.md section 7 |
| States | `--state-busy` `starved` `blocked` `down` `idle` (stations) and `driving` `waiting` `loading` `unloading` `parked` `charging` `broken` (vehicles) | same colours everywhere (mirrors `STATUS_COLORS` in `theme.js`). **Always pair with a label or icon** |
| Charts | `--series-1` ... `--series-8`, `--series-other`, `--chart-grid`, `--chart-axis` | categorical order is fixed, never cycled; series 9+ fold into `--series-other` |
| Elevation | `--shadow-1` (card) `--shadow-2` (menu, popover, toolbar panel) `--shadow-3` (modal) | |
| Spacing | `--sp-1` 4 px, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 20, `--sp-6` 24, `--sp-7` 32, `--sp-8` 48 | 4 px base |
| Radii | `--radius-xs` 3, `-sm` 4, `-md` 6 (controls), `-lg` 8 (cards), `-xl` 12 (dialogs), `-pill` | |
| Type | `--font-sans` `--font-mono`; `--fs-xs` 11, `-sm` 12, `-md` 13 (base), `-lg` 15, `-xl` 18, `-2xl` 22, `-3xl` 28 (KPI); `--fw-regular` `--fw-medium` `--fw-semibold`; `--lh` 1.45, `--lh-tight` 1.25 | `.tnum` gives tabular figures for columns of numbers |
| Controls | `--control-h` 32 px, `--control-h-sm` 26 px (40/34 on coarse pointers), `--focus-ring`, `--focus-offset`, `--focus-glow` | |
| Layers | `--z-raised` 1, `--z-sticky` 10, `--z-float` 20 (controls over the canvas), `--z-drawer` 40, `--z-dropdown` 60, `--z-modal` 80, `--z-toast` 90, `--z-tooltip` 100 | |
| Motion | `--t-fast` 100 ms, `--t-base` 160 ms, `--t-slow` 260 ms, `--ease` | all `0ms` under `prefers-reduced-motion` |

Reading a token from JS: `getComputedStyle(el).getPropertyValue('--accent').trim()`.

### Conventions

* BEM-ish names: `block`, `block__element`, `block--modifier`. State classes are `.is-*` (`.is-active`, `.is-invalid`,
  `.is-selected`, `.is-best`, `.is-worst`, `.is-focused`, `.is-disabled`). Toggled controls prefer ARIA
  (`aria-pressed`, `aria-selected`, `aria-expanded`, `aria-checked`, `aria-invalid`); the CSS handles both.
* **Tones**: `.tone-busy`, `.tone-driving`, `.tone-source`, `.tone-good` ... set `--c`, the colour used by `.dot`, `.swatch`,
  `.progress__bar` and `.chart-legend__key`. Available: the 12 states, `good warn bad info accent`, the 5 station types.
* Icons are `<svg class="icon">`; put them directly inside buttons, chips, menu items (flex gap does the spacing).
* Colour is never the only signal: statuses carry a word, icon or glyph (`.is-best` adds a check, `.is-worst` an exclamation mark).

---

## 3. Components (`css/components.css`)

Every example is real markup from `tests/e2e/uikit-demo.html`; `<icon:name>` stands for `icon('name', { size })` output.

### 3.1 Utilities

| Class | Purpose |
|---|---|
| `.sr-only` | visually hidden, still read by screen readers |
| `.truncate` | single line with ellipsis (needs a width limit) |
| `.text-dim` / `.text-faint` | secondary / hint text colour |
| `.tnum` | tabular figures (clocks, KPI columns) |
| `.eyebrow` | small uppercase group label |
| `.stack` | vertical flex, gap `var(--gap, 8px)` |
| `.row` / `.row--wrap` | horizontal flex, centred, gap `var(--gap, 8px)` / allow wrapping |
| `.spacer` | `flex: 1`, pushes siblings apart |
| `.icon` | inline SVG sizing (added by `icon()`) |
| `.no-print` | hidden when printing |

```html
<div class="row" style="--gap: 12px"><span class="eyebrow">Fleet</span><span class="spacer"></span><button class="btn btn--sm">Add</button></div>
```

### 3.2 Buttons

| Class | Purpose |
|---|---|
| `.btn` | the default (secondary) button: surface fill, outline |
| `.btn--primary` | main action, one per view or dialog |
| `.btn--ghost` | no outline, for toolbars and low-emphasis actions |
| `.btn--danger` | solid destructive action (confirm dialogs) |
| `.btn--danger-ghost` | low-emphasis destructive action (delete in a list row) |
| `.btn--sm` | 26 px height |
| `.btn--icon` | square, icon only (always add `aria-label`; combine with `.btn--sm`) |
| `.btn--block` | full width |
| `[aria-pressed="true"]` / `.is-active` | pressed / toggled look, works on every variant |

```html
<button class="btn btn--primary" type="button"><icon:play> Run simulation</button>
<button class="btn" type="button">Secondary</button>
<button class="btn btn--ghost" type="button">Ghost</button>
<button class="btn btn--danger" type="button"><icon:trash> Delete fleet</button>
<button class="btn btn--icon btn--sm btn--danger-ghost" type="button" aria-label="Delete"><icon:trash></button>
<button class="btn" type="button" aria-pressed="true"><icon:grid> Grid on</button>
<button class="btn btn--icon" type="button" aria-label="Undo" data-tip="Undo (Ctrl+Z)"><icon:undo></button>
```

`disabled` (or `aria-disabled="true"`) dims the button and blocks pointer events.

### 3.3 Toolbars

| Class | Purpose |
|---|---|
| `.toolbar` | row of buttons, 2 px apart; buttons inside become ghost buttons automatically |
| `.toolbar--vertical` | column (the tool palette) |
| `.toolbar--panel` | floating panel look: surface, border, shadow (controls over the canvas) |
| `.toolbar__group` | sub-group; inherits the direction of its toolbar |
| `.toolbar__sep` | hairline divider between groups |

```html
<div class="toolbar toolbar--panel toolbar--vertical" role="toolbar" aria-label="Tools">
  <div class="toolbar__group">
    <button class="btn btn--icon" type="button" aria-label="Select" aria-pressed="true" data-tip="Select (V)" data-tip-pos="right"><icon:select></button>
    <button class="btn btn--icon" type="button" aria-label="Pan" data-tip="Pan (H)" data-tip-pos="right"><icon:pan></button>
  </div>
  <div class="toolbar__sep"></div>
  <div class="toolbar__group"> ... road tools ... </div>
</div>
<div class="toolbar toolbar--panel" role="toolbar" aria-label="Simulation">
  <button class="btn btn--icon" type="button" aria-label="Reset"><icon:reset></button>
  <button class="btn btn--icon btn--primary" type="button" aria-label="Play"><icon:play></button>
  <button class="btn btn--icon" type="button" aria-label="Step"><icon:step></button>
</div>
```

### 3.4 Form controls

| Class | Purpose |
|---|---|
| `.input` | text, number, `<select>` (arrow added automatically) and `<textarea>` |
| `.input--sm` | 26 px high input |
| `.input-group` (+ `--sm`) | bordered wrapper for an input with an addon; `.is-invalid`, `.is-disabled` |
| `.input-unit` | addon inside `.input-group`: unit suffix (or prefix when first child) |
| `.check` | checkbox or radio with label |
| `.switch`, `.switch__input`, `.switch__track` | on/off switch |
| `.segmented` (+ `--sm`, `--block`), `.segmented__item` | segmented control (buttons with `aria-pressed`, or labels wrapping radios) |
| `.range` | range slider with filled track and value bubble (needs two lines of JS, see below) |
| `.field`, `.field__head`, `.field__label`, `.field__value`, `.field__hint`, `.field__error` | label + control + hint / error row |
| `.field--inline` | label left, control right (`--control-w`, default 112 px); dense property panels |
| `.field-grid` | grid of fields, `--cols` columns (default 2) |
| `.stepper`, `.stepper__btn`, `.stepper__input` | `[-] value [+]` |

```html
<div class="field">
  <label class="field__label" for="cycle">Cycle time</label>
  <div class="input-group"><input class="input" id="cycle" type="number" value="90"><span class="input-unit">s</span></div>
  <p class="field__hint">Mean time one machine needs per part.</p>
</div>

<!-- error: add .is-invalid to the field and aria-invalid to the input; the hint is replaced by the error -->
<div class="field is-invalid">
  <label class="field__label" for="cap">Input slots</label>
  <div class="input-group"><input class="input" id="cap" type="number" value="0" aria-invalid="true"><span class="input-unit">loads</span></div>
  <p class="field__error" role="alert">Must be at least 1.</p>
</div>

<select class="input"><option>Nearest job first</option></select>
<textarea class="input" placeholder="Notes"></textarea>

<label class="check"><input type="checkbox" checked><span>Show docks</span></label>
<label class="check"><input type="radio" name="idle" checked><span>Park in depot</span></label>

<label class="switch"><input class="switch__input" type="checkbox" checked><span class="switch__track"></span><span>Battery model</span></label>

<div class="segmented" role="group" aria-label="Heatmap">
  <button class="segmented__item" type="button" aria-pressed="true">Off</button>
  <button class="segmented__item" type="button" aria-pressed="false">Traffic</button>
</div>
<div class="segmented" role="radiogroup" aria-label="Handedness">
  <label class="segmented__item"><input type="radio" name="hand" checked><span>Right-hand</span></label>
  <label class="segmented__item"><input type="radio" name="hand"><span>Left-hand</span></label>
</div>

<div class="field field--inline">
  <label class="field__label" for="n">Vehicles</label>
  <div class="stepper">
    <button class="stepper__btn" type="button" aria-label="Fewer"><icon:minus></button>
    <input class="stepper__input" id="n" type="number" value="4">
    <button class="stepper__btn" type="button" aria-label="More"><icon:plus></button>
  </div>
</div>
```

`checkbox.indeterminate = true` shows the dash state. Native number spinners are hidden (use the stepper).

**Range slider.** The fill and the bubble are driven by `--p` (0..1) and `data-value` on the `.range` wrapper; update them
whenever the input changes (the same snippet works for any panel):

```html
<div class="field">
  <div class="field__head"><label class="field__label" for="demand">Demand</label><span class="field__value" id="demand-out">1.2x</span></div>
  <div class="range"><input id="demand" type="range" min="0.2" max="3" step="0.05" value="1.2"></div>
</div>
```
```js
function syncRange(wrap, format = (v) => `${v}`) {
  const input = wrap.querySelector('input');
  wrap.style.setProperty('--p', (input.value - input.min) / (input.max - input.min));
  wrap.dataset.value = format(input.value);        // bubble text; omit to hide the bubble
}
input.addEventListener('input', () => syncRange(wrap));
syncRange(wrap);                                    // initial state, and after every programmatic value change
```

### 3.5 Cards, KPIs, sections

| Class | Purpose |
|---|---|
| `.card`, `.card__header`, `.card__title`, `.card__subtitle`, `.card__actions`, `.card__body`, `.card__footer` | container with optional header / footer |
| `.card--flat` / `.card--interactive` / `.card--selected` | no shadow / clickable hover / selected outline |
| `.kpi`, `.kpi__label`, `.kpi__value`, `.kpi__unit`, `.kpi__foot`, `.kpi__spark` | headline number tile (inside a `.card`); `.kpi__spark` hosts a sparkline |
| `.delta`, `.delta--good`, `.delta--bad` | change vs a reference; good/bad says whether the change is desirable, not its sign |
| `.section`, `.section__header`, `.section__chevron`, `.section__aside`, `.section__body` | collapsible group (native `<details>` or a button with `aria-expanded`) |

```html
<div class="card">
  <div class="kpi">
    <div class="kpi__label">Throughput</div>
    <div class="kpi__value tnum">112<span class="kpi__unit">/h</span></div>
    <div class="kpi__foot"><span class="delta delta--good">+8.4 %</span><div class="kpi__spark"><!-- createSparkline().el --></div></div>
  </div>
</div>

<div class="card">
  <div class="card__header"><h3 class="card__title">Battery</h3><div class="card__actions"><button class="btn btn--icon btn--sm btn--ghost" aria-label="Reset"><icon:reset></button></div></div>
  <div class="card__body">...</div>
</div>

<details class="section" open>
  <summary class="section__header"><icon:chevron-right class="section__chevron">Battery<span class="section__aside">on</span></summary>
  <div class="section__body">...</div>
</details>
<button class="section__header" type="button" aria-expanded="false"><icon:chevron-right class="section__chevron">Advanced</button>
```

(`icon('chevron-right', { size: 14, class: 'section__chevron' })`: the chevron rotates 90 degrees when open.)

### 3.6 Tabs

| Class | Purpose |
|---|---|
| `.tabs` | tab strip (`role="tablist"`); scrolls sideways when it does not fit, with soft edge shadows. Place it on a `--surface` background |
| `.tab` | one tab (`role="tab"`, `aria-selected`) |
| `.badge` inside a tab | count badge: `.badge--bad`, `--warn`, `--accent`, `--good` |

```html
<div class="tabs" role="tablist" aria-label="Panels">
  <button class="tab" type="button" role="tab" aria-selected="true">Results</button>
  <button class="tab" type="button" role="tab" aria-selected="false">Checks<span class="badge badge--bad">3</span></button>
</div>
```

### 3.7 Tables

| Class | Purpose |
|---|---|
| `.table-wrap` | bordered scroll container; set `--table-max-h` (e.g. `260px`) for a scrolling body with a sticky header |
| `.table` | compact table, sticky `<th>`, row hover |
| `.num` (on `th`/`td`) | right-aligned tabular numbers |
| `td.is-best` / `td.is-worst` | best / worst cell of a comparison: tint, bold, check / exclamation glyph |
| `tr.is-selected` | selected row |

```html
<div class="table-wrap" style="--table-max-h: 260px">
  <table class="table">
    <thead><tr><th>Variant</th><th class="num">Throughput /h</th><th class="num">Lead time</th></tr></thead>
    <tbody>
      <tr><td><span class="dot tone-good"></span> C · One-way aisles</td><td class="num is-best">118</td><td class="num is-best">12.9 min</td></tr>
      <tr><td>A · Baseline</td><td class="num is-worst">92</td><td class="num">18.4 min</td></tr>
    </tbody>
  </table>
</div>
```

### 3.8 Chips, badges, dots, swatches

| Class | Purpose |
|---|---|
| `.chip` (+ `--outline`, `--error`, `--warn`, `--info`, `--good`) | label / severity pill; may start with an icon |
| `.chip--source`, `--process`, `--storage`, `--sink`, `--depot` | station-type pill (tinted; add `<span class="swatch tone-*">`) |
| `.badge` (+ `--accent`, `--good`, `--warn`, `--bad`) | count or short status |
| `.dot` (+ `--lg`) | status dot, colour from a `.tone-*` class |
| `.swatch` | 12 px colour square, colour from a `.tone-*` class |
| `.tone-*` | sets `--c` (see Conventions) |

```html
<span class="chip chip--error"><icon:error> 2 errors</span>
<span class="chip chip--source"><span class="swatch tone-source"></span>Source</span>
<span class="badge badge--bad">7</span>
<span class="dot tone-blocked"></span> Blocked
```

### 3.9 Progress, key-value lists, callouts

| Class | Purpose |
|---|---|
| `.progress` (+ `--lg`, `--good`, `--warn`, `--bad`) | bar; children `.progress__bar` take `--w` (percent) |
| `.progress--stacked` | several `.progress__bar` side by side with a 2 px gap; colour each with a `.tone-*` class |
| `.kv` | two-column key / value list (`<dl>`), values right-aligned |
| `.callout` (+ `--error`, `--warn`, `--info`, `--good`), `__icon`, `__body`, `__title`, `__text` | inline message with severity (Checks and Insights lists) |

```html
<div class="progress progress--warn" role="progressbar" aria-valuenow="86" aria-valuemin="0" aria-valuemax="100"><div class="progress__bar" style="--w: 86%"></div></div>

<div class="progress progress--lg progress--stacked" role="img" aria-label="Driving 46 %, waiting 12 %, idle 42 %">
  <div class="progress__bar tone-driving" style="--w: 46%"></div>
  <div class="progress__bar tone-waiting" style="--w: 12%"></div>
  <div class="progress__bar tone-idle" style="--w: 42%"></div>
</div>

<dl class="kv"><dt>Throughput</dt><dd>112 /h</dd><dt>WIP</dt><dd>18.4 loads</dd></dl>

<div class="callout callout--warn">
  <icon:warning class="callout__icon">
  <div class="callout__body"><div class="callout__title">Fleet is saturated</div><div class="callout__text">AGVs work 91 % of the time. Add a vehicle.</div></div>
</div>
```

### 3.10 Tooltips, keycaps, dividers

| Class / attribute | Purpose |
|---|---|
| `[data-tip="text"]` | CSS-only tooltip on hover (after 350 ms) and keyboard focus; `data-tip-pos="bottom \| right \| left"` (default top). Put the shortcut in the text: `"Road (R)"` |
| `.kbd`, `.kbd-group` | keycap, group of keycaps |
| `.divider` (+ `--vertical`) | hairline rule |

The tooltip is a pseudo-element, so it is clipped by an ancestor with `overflow: hidden/auto`: place the attribute on
elements that are not inside a scroll container, or use a JS popover there. It does not replace `aria-label` on icon-only buttons.

```html
<span class="kbd-group"><kbd class="kbd">Ctrl</kbd><kbd class="kbd">Z</kbd></span>
```

### 3.11 Overlays

| Class | Purpose |
|---|---|
| `.modal-backdrop` | fixed full-screen scrim, centres its `.modal`; bottom sheet below 600 px |
| `.modal` (+ `--sm` 400 px, `--lg` 880 px), `__header`, `__title`, `__close`, `__body`, `__footer` | dialog; also works as `<dialog class="modal">` (use `showModal()`, the `::backdrop` is styled) |
| `.toast-region` | fixed bottom-centre stack for toasts |
| `.toast` (+ `--success`, `--warn`, `--error`), `__icon`, `__msg`, `__action`, `__close` | transient message |
| `.menu`, `__label`, `__item` (+ `--danger`), `__icon`, `__kbd`, `__sep` | menu list; `.is-focused` for the active item, `aria-checked` for check items |
| `.dropdown`, `.dropdown__menu` (+ `--end`, `--up`) | positions a menu or popover under (or above) its trigger |
| `.popover` | generic floating panel |

```html
<div class="modal-backdrop">
  <div class="modal modal--sm" role="dialog" aria-modal="true" aria-labelledby="t">
    <div class="modal__header"><h3 class="modal__title" id="t">Delete scenario?</h3><button class="btn btn--icon btn--sm btn--ghost modal__close" aria-label="Close"><icon:close></button></div>
    <div class="modal__body"><p>This cannot be undone.</p></div>
    <div class="modal__footer"><button class="btn">Cancel</button><button class="btn btn--danger">Delete</button></div>
  </div>
</div>

<div class="toast-region">
  <div class="toast toast--success" role="status"><icon:check class="toast__icon"><span class="toast__msg">Example loaded.</span><button class="toast__action" type="button">Undo</button></div>
</div>

<div class="dropdown">
  <button class="btn" aria-haspopup="menu" aria-expanded="true"><icon:export> Export <icon:chevron-down></button>
  <div class="menu dropdown__menu" role="menu">
    <div class="menu__label">Export</div>
    <button class="menu__item" role="menuitem"><icon:export class="menu__icon"> Project as JSON<span class="menu__kbd">Ctrl+S</span></button>
    <div class="menu__sep"></div>
    <button class="menu__item menu__item--danger" role="menuitem"><icon:trash class="menu__icon"> Discard changes</button>
  </div>
</div>
```

Focus management, Escape, click-outside and `aria-live` for toasts are the caller's job.

### 3.12 Empty states and loading

| Class | Purpose |
|---|---|
| `.empty`, `__icon`, `__title`, `__text`, `__actions` | "nothing here yet" block. `__icon` is a **wrapper** around the svg |
| `.skeleton` (+ `--text`, `--circle`, `--chart`) | shimmering placeholder (static under reduced motion) |

```html
<div class="empty">
  <span class="empty__icon"><icon:chart size=20></span>
  <div class="empty__title">No results yet</div>
  <div class="empty__text">Press play to simulate the plant. KPIs appear after the warm-up.</div>
  <div class="empty__actions"><button class="btn btn--primary btn--sm">Run</button></div>
</div>
```

### 3.13 Chart chrome

Used by `charts.js`; you only touch these directly to lay charts out.

| Class | Purpose |
|---|---|
| `.chart-block` | a chart plus its legend (what the chart factories return as `el`) |
| `.chart`, `.chart__canvas`, `.chart__empty`, `.chart--clickable` | canvas wrapper, empty-state text, pointer cursor |
| `.chart-tooltip` + `__title`, `__row`, `__key`, `__name`, `__value`, `__note` | hover tooltip |
| `.chart-legend`, `__item`, `__key`, `__key--line`, `__note` | legend (buttons with `aria-pressed` when toggling series) |
| `.sparkline`, `.gauge`, `.gauge__readout`, `.gauge__value`, `.gauge__caption`, `.gauge__status` | sparkline and gauge parts |

`.chart-legend` also works standalone for any colour key (`<ul class="chart-legend"><li class="chart-legend__item"><span class="chart-legend__key tone-driving"></span>Driving</li>...`).

### 3.14 Accessibility and print

* Every control shows a 2 px accent focus ring on `:focus-visible` (inputs: border + glow). Never remove it.
* Text colours meet WCAG AA in both themes (checked by `uikit-visual.mjs`: every visible text in the demo plus the token pairs).
* `prefers-reduced-motion` sets all `--t-*` to 0 and stops animations; coarse pointers get 40 px controls.
* `@media print`: light palette whatever the screen theme, hides `.no-print`, `.toolbar`, `.tabs`, `.btn`, toasts, modals and menus, drops shadows, keeps bars and tints (`print-color-adjust: exact`), lets tables grow.

---

## 4. Icons (`js/ui/icons.js`)

```js
import { icon, iconSvg, ICON_NAMES } from './ui/icons.js';

button.append(icon('play', { size: 16 }));                 // SVGElement, 24x24 viewBox, stroke currentColor, 1.75 stroke
button.prepend(icon('warning', { class: 'chip__icon' }));   // extra CSS class
html += iconSvg('check', { size: 14 });                     // markup string (report export); Node-safe
```

* `icon(name, { size = 18, class })`: detached `<svg class="icon icon--name" aria-hidden="true">`; colour follows the text colour of the parent.
  Use 14-16 px in chips and menus, 18 px in buttons, 20-24 px in toolbars and empty states.
* Unknown names render a dashed placeholder square (`icon--missing`) instead of throwing.
* Icons are decorative: the button needs `aria-label` or visible text.

| Group | Names |
|---|---|
| Tools | `select` `pan` `road` `oneway` `speedzone` `erase` `obstacle` `label` `flow` |
| Stations | `source` (arrow into a dock) `process` (gear) `storage` (shelving) `sink` (box, arrow out) `depot` (P with a bolt) |
| History, simulation | `undo` `redo` `play` `pause` `step` `reset` |
| View | `fit` `zoomin` `zoomout` `grid` `heat` `flows` `layers` `eye` `eye-off` |
| Files, sharing | `share` `export` `import` `download` `upload` `folder` `save` `link` `copy` `trash` `edit` |
| Feedback | `help` `info` `warning` `error` `check` |
| Generic | `plus` `minus` `close` `menu` `more` `search` `chevron-up` `chevron-down` `chevron-left` `chevron-right` `settings` `sliders` `sun` `moon` |
| Domain | `truck` `forklift` `bolt` `battery` `clock` `chart` `compare` `flask` `target` `route` |

Station type to icon: `STATION_TYPES` keys are the icon names (`icon(station.type)`).

---

## 5. Charts (`js/ui/charts.js`)

Canvas charts with DOM wrappers: hi-dpi, responsive (`ResizeObserver`), theme-aware (CSS tokens are read at draw
time; the chart redraws when the theme changes), accessible (focusable canvas, arrow keys, `aria-live` readout).
Each factory returns `{ el, update(patch), destroy() }`.

```js
const chart = createLineChart({ x: times, series: [{ name: 'Throughput', y: values }], xAxis: 'time', yLabel: 'units/h' });
card.querySelector('.card__body').append(chart.el);   // el is a .chart-block: canvas + legend; size comes from the container width
chart.update({ series: [{ name: 'Throughput', y: newValues }] });   // shallow-merges into the options, then redraws
chart.destroy();                                                     // removes listeners and the element
```

* `update(patch)` merges top-level options; pass whole arrays (`series`, `rows`, `values`), they are replaced. It is cheap: call it at 4 Hz from the dashboard instead of re-creating the chart. A tooltip that is open while the data changes is refreshed in place (the hover position is kept).
* Charts fill the width of their parent; height is an option (`height`, px) or automatic (bars, stacked bars).
* Call `destroy()` when a panel is torn down (it also detaches from the shared theme watcher).
* Gaps: `null` / `NaN` / `undefined` in data are gaps, never errors. Empty data shows the `empty` text.
* Colours: `color` accepts a token (`'--series-3'`, `'--st-process'`), a semantic name (`'accent' 'good' 'warn' 'bad' 'info' 'muted'`) or any CSS colour.
  Default: categorical slot by series index (fixed order, never recoloured when another series is hidden).
  Light-mode slots 3, 4 and 5 (aqua, yellow, magenta) are below 3:1 on white, so charts always ship a legend and tooltip.

### 5.1 `createLineChart(options)`

Multi-series lines on one shared x axis, min-max bands, reference lines, legend toggles, snapping crosshair with tooltip.

| Option | Type | Meaning |
|---|---|---|
| `x` | `number[]` | shared x values, ascending (default `0..n-1`) |
| `series` | `[{ name, y, lo?, hi?, color?, area? }]` | `y` per x (null = gap); `lo`/`hi` draw a translucent band (min-max over replications); `area` adds a soft fill |
| `xAxis` | `'linear' \| 'time'` | `'time'` reads x as seconds and ticks on minutes / hours (`2 h`, `30 min`) |
| `xLabel`, `yLabel` | string | axis titles (x below the plot, y above it: put the unit here) |
| `xUnit`, `yUnit` | string | unit appended to tooltip values |
| `xFormat(v)`, `yFormat(v)` | function | tick label and tooltip formatters |
| `yMin`, `yMax` | number | fixed y bounds (default: nice ticks around the data) |
| `includeZero` | boolean | keep 0 on the y axis (default true) |
| `refLines` | `[{ axis: 'x' \| 'y', value, label? }]` | dashed reference lines (target, current setting, warm-up end) |
| `markers` | `boolean \| 'auto'` | dots on every point (`'auto'`: up to 24 points) |
| `legend` | `boolean \| 'auto'` | `'auto'`: shown from two series on; entries toggle their series |
| `height` | number | px, default 220 |
| `empty` | string | text when there is no data |
| `onPointClick(hit)` | function | `hit = { seriesIndex, index, x, y, series }`: click, or Enter/Space on the keyboard-focused point |
| `ariaLabel` | string | accessible name |

```js
createLineChart({
  x: fleetSizes,                                           // [1..10]
  series: [{ name: 'Throughput', y: mean, lo: min, hi: max }],
  xLabel: 'Number of AGVs', yLabel: 'Throughput (units/h), mean and min-max of 5 runs',
  markers: true, xFormat: (v) => `${v} AGVs`,
  refLines: [{ axis: 'x', value: current, label: 'current' }],
  onPointClick: ({ x }) => applySweepValue(x),             // "click a point to apply that value"
});
createLineChart({ x: t, xAxis: 'time', series: [{ name: 'Throughput', y: tp, area: true }, { name: 'WIP', y: wip }],
  refLines: [{ axis: 'y', value: target, label: 'Target' }] });
```
Keyboard: focus the chart, Left/Right (Home/End) move the crosshair, Enter selects, Escape clears.

### 5.2 `createBarChart(options)`

Horizontal (default) or vertical bars, single or grouped; bars are at most 18 px thick, 4 px rounded at the data end.

| Option | Type | Meaning |
|---|---|---|
| `categories` | `string[]` | one label per group (truncated with an ellipsis when long; full text in the tooltip) |
| `series` | `[{ name?, values, color?, colors? }]` | grouped when several; `colors[i]` overrides the colour of bar `i` (per-bar colours) |
| `orientation` | `'horizontal' \| 'vertical'` | |
| `unit`, `digits`, `valueFormat(v)` | | value text on bars and in tooltips |
| `valueLabel` | string | title of the value axis (put the unit here for grouped columns) |
| `min`, `max` | number | fixed value-axis bounds (default: 0 to a nice maximum) |
| `labels` | `boolean \| 'auto'` | value labels at the bar ends; `'auto'` = everywhere except grouped columns (where labels would collide). A label that would touch another bar is left out |
| `highlight` | `'best' \| 'worst' \| 'both' \| null` | marks the best / worst bar of each series: green / red fill plus a "best" / "worst" tag |
| `better` | `'higher' \| 'lower'` | direction used by `highlight` |
| `height` | number | px (default: fits the rows when horizontal, 220 when vertical) |
| `onBarClick(hit)` | function | `{ categoryIndex, seriesIndex, category, series, value }` |

```js
createBarChart({ categories: names, series: [{ name: 'Throughput', values: tp }], unit: '/h', highlight: 'both', better: 'higher' });
createBarChart({ orientation: 'vertical', categories: ['A', 'B'], valueLabel: 'Lead time (minutes)',
  series: [{ name: 'Mean', values: mean }, { name: 'p95', values: p95 }] });
createBarChart({ categories: stationNames, unit: '%', max: 100,
  series: [{ name: 'Utilization', values: util, colors: stations.map((s) => `--st-${s.type}`) }] });
```
The whole category row is the hover target, the hovered bar lightens, keyboard: arrows step through the bars.

### 5.3 `createStackedBar(options)`

Horizontal stacks normalised to 100 % of each row: vehicle-state shares per fleet, station-state shares per station.
Segments get a 2 px surface gap and are labelled in place only when the text fits.

| Option | Type | Meaning |
|---|---|---|
| `rows` | `[{ label, note?, segments: [{ key, value, label?, color? }] }]` | `note` is right-aligned text ("86 % working"); a `key` from `STATE_KEYS` selects its state colour and label |
| `normalize`, `max` | boolean, number | `normalize: false` scales to `max` instead of the row sum (e.g. seconds) |
| `legend` | boolean | default true; built from the segment keys in order of appearance |
| `valueFormat({ value, frac, label })` | function | tooltip value (default: percent) |
| `onSegmentClick(hit)` | function | `{ rowIndex, segmentIndex, key, row, value }` |

```js
import { createStackedBar, segmentsFromShares } from './ui/charts.js';
createStackedBar({ rows: Object.values(report.fleets).map((f) => ({
  label: `${f.name} (${f.count})`, note: `${formatPercent(f.utilization)} working`,
  segments: segmentsFromShares(f.shares, ['driving', 'waiting', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken']),
})) });
```
`STATE_KEYS` / `STATE_LABELS` are exported (stations: `busy starved blocked down idle`; vehicles: `driving waiting loading unloading idle parked charging broken`).

### 5.4 `createSparkline(options)`

`{ values, color?, area = true, width?, height = 28, min?, max?, unit? }`. No axes; an end dot marks the latest value;
the canvas carries an accessible description (latest, lowest, highest). Fills its container unless `width` is set.

```js
kpiCard.querySelector('.kpi__spark').append(createSparkline({ values: report.series.throughput, color: '--series-1', unit: '/h' }).el);
```

### 5.5 `createGauge(options)`

Semi-circle dial with threshold bands: `{ value, min = 0, max = 1, thresholds?, label?, format?, unit?, size = 160 }`.
`thresholds` is `[{ to, color, label? }]` in value units, ascending; the progress arc takes the colour of the band the value
is in, the band `label` appears as a status line with a dot (so the state is never just a colour). `role="meter"` is set.
Default value text is a percent when `max <= 1`.

```js
createGauge({ value: report.fleets.f1.utilization, label: 'Fleet utilization', thresholds: [
  { to: 0.35, color: 'info', label: 'Oversized' }, { to: 0.85, color: 'good', label: 'Healthy' },
  { to: 0.95, color: 'warn', label: 'Saturated' }, { to: 1, color: 'bad', label: 'Overloaded' },
] });
```

### 5.6 Pure helpers (exported, unit-tested)

Importable in Node: `niceTicks(min, max, maxTicks, { integer })`, `timeTicks`, `formatTick`, `formatTimeTick`, `formatValue`,
`autoDigits`, `stepDecimals`, `linearScale`, `bandScale`, `groupLayout`, `stackSegments`, `segmentRects`, `nearestIndex`,
`nearestPoint`, `hitRect`, `clampTooltip`, `truncateText`, `crispLine`, `seriesExtent`, `allIntegers`, `finiteRuns`, `bestWorst`,
`gaugeFraction`, `gaugeBands`, `gaugeBandAt`, `segmentsFromShares`, `STATE_KEYS`, `STATE_LABELS`. Signatures and edge cases are
documented in the source and covered by `tests/ui.charts.test.js`.

---

## 6. Checking changes

```
node --test tests/ui.charts.test.js     # pure chart maths + icon registry (fast, Node only)
node tests/e2e/uikit-visual.mjs         # Playwright: screenshots + automated checks
```

The visual script writes `e2e-output/uikit-{light,dark,mobile-light,mobile-dark}-<section>.png` plus hover, focus and slider
shots. Open them: it asserts what can be measured (no console errors, every icon and chart renders, tooltips, clicks,
keyboard access, WCAG AA contrast of every visible text in both themes and of the token pairs, identical dark theme via
`data-theme` and via the OS scheme, print is light, reduced motion, no horizontal overflow at 390 px) but not taste.

### Known limits

* No table twin for charts: values are available through hover/keyboard tooltips and the `aria-live` readout, not as a `<table>`.
* The range slider needs the `--p` / `data-value` sync snippet; there is no JS helper in the kit.
* `[data-tip]` tooltips are CSS pseudo-elements and are clipped by scrolling ancestors.
* Canvas text uses the proportional figures of the system font (CSS `tabular-nums` does not reach canvas).
* Tab / menu / dialog keyboard behaviour (roving focus, Escape, focus trap) is not part of the kit.
