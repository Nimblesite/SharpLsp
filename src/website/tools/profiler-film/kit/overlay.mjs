// Implements [WEB-DESIGN-MEDIA]. What a walkthrough adds on top of the real editor:
// a numbered step caption, a speed badge on fast-forwarded stretches, a pointer
// that glides to what the film acts on, and a ring where each click lands. They are drawn into the workbench page, so the screencast
// records them with the footage; nothing in the editor itself is staged.
// The workbench enforces Trusted Types, so the overlay is built from nodes, CSSOM
// styles and the Web Animations API: no HTML strings, no style sheets.
import { PARK, sleep } from './workbench.mjs';

const BAR = {
  position: 'fixed', left: '72px', bottom: '40px', zIndex: '100000',
  display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 22px 12px 12px', borderRadius: '14px',
  background: 'rgba(11, 18, 32, .92)', border: '1px solid #2a3c58', boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
  font: "600 21px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif", color: '#e6edf3', pointerEvents: 'none',
};
const STEP = {
  display: 'grid', placeItems: 'center', width: '34px', height: '34px', borderRadius: '10px',
  background: '#2ecc8f', color: '#0b1220', fontWeight: '800',
};
const SPEED = { padding: '4px 10px', borderRadius: '999px', background: '#e2a24a', color: '#0b1220', fontSize: '16px', fontWeight: '800' };
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
    ({ style, arrow, x, y, ms }) => {
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
      const to = `translate(${x - 3}px, ${y - 2}px)`;
      const from = pointer.dataset.at ?? to;
      pointer.dataset.at = to;
      pointer.animate([{ transform: from }, { transform: to }], { duration: from === to ? 1 : ms, easing: 'cubic-bezier(.3, 0, .2, 1)', fill: 'forwards' });
    },
    { style: POINTER, arrow: ARROW, x, y, ms: GLIDE_MS },
  );
  await sleep(GLIDE_MS + 100);
}

/** Show step `step`'s caption, with a speed badge when the stretch is fast-forwarded. */
export async function caption(page, step, text, speed = '') {
  await page.evaluate(
    ({ styles, parts }) => {
      document.getElementById('film-caption')?.remove();
      const node = (style, content) => {
        const element = document.createElement('span');
        Object.assign(element.style, style);
        element.textContent = content;
        return element;
      };
      const bar = document.createElement('div');
      bar.id = 'film-caption';
      Object.assign(bar.style, styles.bar);
      bar.append(node(styles.step, parts.step), node({}, parts.text));
      if (parts.speed) bar.append(node(styles.speed, `${parts.speed} speed`));
      document.body.append(bar);
    },
    { styles: { bar: BAR, step: STEP, speed: SPEED }, parts: { step: String(step), text, speed } },
  );
}

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
