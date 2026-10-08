// Panning the view by dragging: the pan tool, and the temporary pan of Space+drag and the middle mouse button.
// (The editor shows the grab cursors.)

/** @param {object} ed the editor host (see editor.js) */
export function createPanTool(ed) {
  let last = null;

  return {
    busy: () => last !== null,
    down(p) {
      last = { x: p.x, y: p.y };
      return true;
    },
    move(p) {
      ed.camera.pan(p.x - last.x, p.y - last.y);
      last = { x: p.x, y: p.y };
      ed.redraw();
    },
    up() {
      last = null;
    },
    cancel() {
      last = null;
    },
  };
}
