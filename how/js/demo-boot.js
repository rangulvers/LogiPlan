// The page's one script for its first view (how/index.html loads it as a module): tiny, no imports. It waits until the live demo's section is
// near the screen and only then fetches the demo (demo.js, with the planner's engine and renderer), so reading the page costs none of that.
//
// If the demo cannot start (the page was opened from a file, the browser lacks what the engine needs, a module fails to load) the still picture
// stays and a sentence under it says why. Without JavaScript nothing changes at all: the page shows the still and all its copy.

const mount = document.querySelector('[data-mount="demo"]');
let observer = null;

/** Keep the still and say, in a sentence under it, why there is no live demo. */
function say(state, text) {
  if (!mount) return;
  mount.setAttribute('data-state', state);
  let note = mount.querySelector('[data-demo-note]');
  if (!note) {
    note = document.createElement('p');
    note.setAttribute('data-demo-note', '');
    note.setAttribute('role', 'note');
    mount.append(note);
  }
  note.textContent = text;
}

async function start() {
  if (observer) observer.disconnect();
  observer = null;
  mount.setAttribute('data-state', 'loading');
  try {
    const { mountDemo } = await import('./demo.js');
    await mountDemo(mount);
  } catch (error) {
    console.error(error);
    say('unavailable', 'The live simulation could not start in this browser, so this is a still picture of it. It needs a current browser and the page served over http or https.');
  }
}

if (mount) {
  if (location.protocol === 'file:') {
    say('unavailable', 'The live simulation cannot run when this page is opened as a file: browsers block the modules it is made of. Serve the folder (npm start) or open the hosted page. This is a still picture of it.');
  } else if (typeof IntersectionObserver !== 'function' || typeof HTMLCanvasElement === 'undefined') {
    say('unavailable', 'This browser cannot run the live simulation, so this is a still picture of it.');
  } else {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) start();
    }, { rootMargin: `${Math.max(1500, Math.round(innerHeight * 1.5 + 900))}px 0px` }); // early: the frame is built long before it is seen, so nothing moves under the reader
    observer.observe(mount);
  }
}
