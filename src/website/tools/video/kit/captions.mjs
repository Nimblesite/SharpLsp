// Implements [WEB-DESIGN-MEDIA-CAMERA]. The numbered step caption, and the speed
// badge on a fast-forwarded stretch, drawn over the cut after the camera, so
// they hold still and stay whole however close the camera goes. Each caption is
// rendered once by Chromium as a transparent frame, in the type and at the
// place the workbench overlay used, and the cut lays it over its clip.
import path from 'node:path';
import { chromium } from '@playwright/test';

const BAR = {
  position: 'fixed', left: '72px', bottom: '40px',
  display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 22px 12px 12px', borderRadius: '14px',
  background: 'rgba(11, 18, 32, .92)', border: '1px solid #2a3c58', boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
  font: "600 21px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif", color: '#e6edf3',
};
const STEP = {
  display: 'grid', placeItems: 'center', width: '34px', height: '34px', borderRadius: '10px',
  background: '#2ecc8f', color: '#0b1220', fontWeight: '800',
};
const SPEED = { padding: '4px 10px', borderRadius: '999px', background: '#e2a24a', color: '#0b1220', fontSize: '16px', fontWeight: '800' };

/** In the page: the caption bar alone on a transparent page. */
function drawInPage({ styles, parts }) {
  const node = (style, content) => {
    const element = document.createElement('span');
    Object.assign(element.style, style);
    element.textContent = content;
    return element;
  };
  const bar = document.createElement('div');
  Object.assign(bar.style, styles.bar);
  bar.append(node(styles.step, parts.step), node({}, parts.text));
  if (parts.speed) bar.append(node(styles.speed, `${parts.speed} speed`));
  document.body.replaceChildren(bar);
}

/**
 * Each of `captions` (`{ step, text, speed }`) as `<dir>/caption-<n>.png`: a
 * transparent frame `width` pixels wide, shaped like the workbench (`size`, in
 * its pixels), with the bar where the workbench overlay drew it. Resolves to
 * the files, in order.
 */
export async function captionFrames(captions, size, width, dir) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: width / size[0] });
    const files = captions.map((_, index) => path.join(dir, `caption-${index}.png`));
    for (const [index, { step, text, speed }] of captions.entries()) {
      await page.evaluate(drawInPage, { styles: { bar: BAR, step: STEP, speed: SPEED }, parts: { step: String(step), text, speed } });
      await page.screenshot({ path: files[index], omitBackground: true });
    }
    return files;
  } finally {
    await browser.close();
  }
}
