// Implements [WEB-DESIGN-MEDIA]. What a film records: real-time screencast clips,
// each with the track its camera follows ([WEB-DESIGN-MEDIA-CAMERA]), the click
// cues a composited film's cursor follows, and clean stills.
import fs from 'node:fs';
import path from 'node:path';
import { centre } from './overlay.mjs';
import { startScreencast } from './screencast.mjs';
import { saveTrack, startTrack, stopTrack } from './track.mjs';
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
      if (box) cues.push({ t: (Date.now() - start) / 1000, ...centre(box), label });
      await locator.click({ force: true });
      await page.waitForTimeout(350);
      await page.mouse.move(PARK.x, PARK.y);
    },
    save: (name) => fs.writeFileSync(path.join(clips, `${name}.cues.json`), JSON.stringify(cues, null, 2)),
  };
}

/**
 * Record `act` as a real-time clip `<clips>/<name>.mp4`, its frames under
 * `<frames>/<name>`, and the track its camera follows as `<clips>/<name>.track.json`.
 * A failed act still ends the screencast and the track, so the take can be shot again.
 */
export async function record({ page, cdp, cues, frames, clips }, name, act) {
  cues.restart();
  await startTrack(page);
  const stop = await startScreencast(cdp, path.join(frames, name));
  const clip = path.join(clips, `${name}.mp4`);
  try {
    await act();
  } catch (error) {
    await stop(clip).catch(() => undefined);
    await stopTrack(page).catch(() => undefined);
    throw error;
  }
  const { start } = await stop(clip);
  saveTrack(await stopTrack(page), start, path.join(clips, `${name}.track.json`));
  cues.save(name);
}

/** Show or hide the pointer, where a walkthrough has drawn it. */
const showPointer = (page, shown) =>
  page.evaluate((visibility) => document.getElementById('film-pointer')?.style.setProperty('visibility', visibility), shown ? 'visible' : 'hidden');

/**
 * A clean frame `<dir>/<name>.png`: the pointer hidden only for the instant of
 * the shot (Do Not Disturb keeps toasts off screen), and the mouse parked
 * first, so no hover shows, unless `hovering` keeps the one open.
 */
export async function still(page, dir, name, { hovering = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (!hovering) await page.mouse.move(PARK.x, PARK.y);
  await sleep(700);
  await showPointer(page, false);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  await showPointer(page, true);
}

/** A walkthrough's still, into the film's own stills folder; published as `<name>.webp`. */
export const snap = (shot, name, options) => still(shot.page, shot.stills, name, options);
