// A native <input type="time"> reports "changed" after EVERY segment the planner edits: typing 09:30 over 07:00 passes through 09:00 (and, on the way, other
// times), so a form that stores each change rebuilds itself under the planner's fingers (a timetable re-sorts its rows and the focus jumps to another row
// while the next keys are still being typed; the clock restarts the simulation once per segment). A time is a SENTENCE, not a keystroke: it is settled
// when the planner leaves the field, presses Enter, or changes it without having focus in it (a script, a browser autofill).
//
//   whenSettled(input, (how, event) => ..., { focused })    how: 'blur' | 'enter' | 'away'; event: the event that settled it (blur: event.relatedTarget is
//                                                           the control that gets the focus next)
//
// Pure DOM glue on anything with addEventListener (Node's EventTarget will do), so it is tested in Node (tests/ui.ops-panels.test.js). Used by the
// timetable table (ops-trucks.js) and the clock of the plant settings (plant-clock.js).

/**
 * Call `onSettled(how, event)` once per finished edit of a time field (see the header), never for the intermediate values of an edit in progress.
 * Whether the field is "being edited" is known from its own focus and blur events, NOT from document.activeElement: Chromium dispatches the `change` of a
 * segment at the moment the focus moves on to the next segment, when document.activeElement is already the body (measured: after typing the hour of 07:00 over
 * 09, the second `change` arrives with activeElement = body and no blur at all), which made every segment look like a finished edit.
 * @param {EventTarget} input the time input
 * @param {(how: 'blur'|'enter'|'away', event: Event) => void} onSettled
 * @param {{ focused?: () => boolean }} [opts] replaces the focus tracking (tests)
 * @returns {{ readonly pending: boolean, cancel(): void }} `pending`: an edit is waiting to be settled; `cancel()` forgets it
 */
export function whenSettled(input, onSettled, { focused } = {}) {
  let pending = false;
  let inside = false;
  const isInside = focused || (() => inside);
  const settle = (how, event) => {
    if (!pending) return;
    pending = false;
    onSettled(how, event);
  };
  input.addEventListener('focus', () => { inside = true; });
  input.addEventListener('change', (event) => {
    pending = true;
    if (!isInside()) settle('away', event);
  });
  input.addEventListener('blur', (event) => {
    inside = false;
    settle('blur', event);
  });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') settle('enter', event); });
  return { get pending() { return pending; }, cancel() { pending = false; } };
}
