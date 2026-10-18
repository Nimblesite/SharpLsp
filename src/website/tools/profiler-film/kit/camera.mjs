// Implements [WEB-DESIGN-MEDIA]. What a film records: real-time screencast clips,
// the click cues a composited film's cursor follows, and clean stills.
import fs from 'node:fs';
import path from 'node:path';
import { startScreencast } from './screencast.mjs';
import { PARK, sleep } from './workbench.mjs';

/** Click-cue log: where and when the (invisible) mouse acted, relative to a clip's start. */
export function cueLog(clips) {
  let start = Date.now();
  const cues = [];
  return {
    restart: () => {
      start = Date.now();
      cues.length = 0;
    },
    async click(page, locator, label) {
      const box = await locator.boundingBox();
      if (box) cues.push({ t: (Date.now() - start) / 1000, x: box.x + box.width / 2, y: box.y + box.height / 2, label });
      await locator.click({ force: true });
      await page.waitForTimeout(350);
      await page.mouse.move(PARK.x, PARK.y);
    },
    save: (name) => fs.writeFileSync(path.join(clips, `${name}.cues.json`), JSON.stringify(cues, null, 2)),
  };
}

/**
 * Record `act` as a real-time clip `<clips>/<name>.mp4`, its frames under `<frames>/<name>`.
 * A failed act still ends the screencast, so the take can be shot again.
 */
export async function record({ cdp, cues, frames, clips }, name, act) {
  cues.restart();
  const stop = await startScreencast(cdp, path.join(frames, name));
  const clip = path.join(clips, `${name}.mp4`);
  try {
    await act();
  } catch (error) {
    await stop(clip).catch(() => undefined);
    throw error;
  }
  await stop(clip);
  cues.save(name);
}

/** Show or hide the step caption, if a walkthrough has drawn one. */
const showCaption = (page, shown) =>
  page.evaluate((visibility) => document.getElementById('film-caption')?.style.setProperty('visibility', visibility), shown ? 'visible' : 'hidden');

/**
 * A clean frame `<dir>/<name>.png`: no hover, and the step caption hidden only
 * for the instant of the shot (Do Not Disturb keeps toasts off screen).
 */
export async function still(page, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  await page.mouse.move(PARK.x, PARK.y);
  await sleep(700);
  await showCaption(page, false);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  await showCaption(page, true);
}

/** A walkthrough's still, into the film's own stills folder; published as `<name>.webp`. */
export const snap = (shot, name) => still(shot.page, shot.stills, name);
