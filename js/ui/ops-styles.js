// Scoped styles of the warehouse module's panels (trucks and doors section, timetable dialog, Doors card, plant clock). Each component file keeps its
// CSS next to the markup it styles and registers it here once, under its own id (the pattern dashboard.js uses for its own rules): no stylesheet to link
// in index.html, tokens only (so both themes and the print styles follow), nothing here touches the classes of the kit.

/** Add `css` to the document head once per `id`. Browser only; a no-op where there is no document (the pure helpers of the panels load in Node). */
export function addStyles(id, css) {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}
