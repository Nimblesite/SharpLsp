// Implements [WEB-DESIGN-MEDIA]. What a walkthrough adds on top of the real editor:
// a pointer that glides to what the film acts on, and a ring where each click
// lands. They are drawn into the workbench page, so the screencast records them
// with the footage; nothing in the editor itself is staged. A step caption is
// logged on the clip's track instead, and drawn over the cut after the camera
// ([WEB-DESIGN-MEDIA-CAMERA]), so it stays whole however close the camera goes.
// The workbench enforces Trusted Types, so the overlay is built from nodes, CSSOM
// styles and the Web Animations API: no HTML strings, no style sheets.
import { TIP, logCaption } from './track.mjs';
import { PARK, sleep } from './workbench.mjs';

const RING = {
  position: 'fixed', zIndex: '100001', width: '34px', height: '34px', margin: '-17px 0 0 -17px',
  border: '3px solid #2ecc8f', borderRadius: '50%', pointerEvents: 'none',
};

/** The pointer: an arrow whose tip sits on the spot, outlined to read on any theme. */
const POINTER = { position: 'fixed', left: '0', top: '0', zIndex: '100002', width: '28px', height: '28px', pointerEvents: 'none', filter: 'drop-shadow(0 2px 3px rgba(0, 0, 0, .5))' };
const ARROW = 'M3 2 L3 21 L8.2 16.2 L11.6 24 L15 22.6 L11.7 15 L18.6 15 Z';
const GLIDE_MS = 650;

/** Glide the pointer to `{ x, y }` (page pixels); the first call drops it there. */
export async function pointAt(page, { x, y }) {
  await page.evaluate(
    ({ style, arrow, tip, x, y, ms }) => {
      let pointer = document.getElementById('film-pointer');
      if (!pointer) {
        const svg = 'http://www.w3.org/2000/svg';
        pointer = document.createElementNS(svg, 'svg');
        pointer.id = 'film-pointer';
        pointer.setAttribute('viewBox', '0 0 28 28');
        Object.assign(pointer.style, style);
        const path = document.createElementNS(svg, 'path');
        for (const [name, value] of [['d', arrow], ['fill', '#ffffff'], ['stroke', '#0b1220'], ['stroke-width', '1.6'], ['stroke-linejoin', 'round']]) path.setAttribute(name, value);
        pointer.append(path);
        document.body.append(pointer);
      }
      const to = `translate(${x - tip.x}px, ${y - tip.y}px)`;
      const from = pointer.dataset.at ?? to;
      pointer.dataset.at = to;
      pointer.animate([{ transform: from }, { transform: to }], { duration: from === to ? 1 : ms, easing: 'cubic-bezier(.3, 0, .2, 1)', fill: 'forwards' });
    },
    { style: POINTER, arrow: ARROW, tip: TIP, x, y, ms: GLIDE_MS },
  );
  await sleep(GLIDE_MS + 100);
}

/** Caption step `step` from this moment of the clip, with a speed badge when the stretch is fast-forwarded. */
export const caption = (page, step, text, speed = '') => logCaption(page, { step, text, speed });

/** Click `locator` with a ring where the click lands, then park the mouse. */
export async function ringClick(page, cues, locator, label) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`nothing to click for ${label}`);
  await pointAt(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.evaluate(({ style, x, y }) => {
    const ring = document.createElement('div');
    Object.assign(ring.style, style, { left: `${x}px`, top: `${y}px` });
    document.body.append(ring);
    ring.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: 700, easing: 'ease-out', fill: 'forwards' })
      .finished.then(() => ring.remove());
  }, { style: RING, x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await sleep(250);
  await cues.click(page, locator, label);
  await page.mouse.move(PARK.x, PARK.y);
}
