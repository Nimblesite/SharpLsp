// Implements [WEB-DESIGN-MEDIA], [WEB-DESIGN-MEDIA-CAMERA] and
// [WEB-DESIGN-MEDIA-CHAPTERS]. A walkthrough is a list of scenes. A scene is either a clip, `{ clip, act, speed, retries }`,
// shot in real time and played back at `speed`, or an `{ offCamera }` step
// between clips. shootWalkthrough shoots the list on a demo's set, each clip
// with its track; publishWalkthrough frames every clip through the camera, lays
// its step captions over it, cuts the clips together, lays a narrated film's
// voice, score and captions over the cut, and writes the site's MP4, WebM and
// poster.
import fs from 'node:fs';
import path from 'node:path';
import { cueLog, record } from './camera.mjs';
import { startOf, writeChapters } from './chapters.mjs';
import { captionFrames } from './captions.mjs';
import { dimensions, duration, emptyDir, ffmpeg, poster } from './encode.mjs';
import { runCommand } from './editor.mjs';
import { caption, ringClick } from './overlay.mjs';
import { narrated, publishEncodes } from './publish.mjs';
import { onSet } from './set.mjs';
import { readTrack } from './track.mjs';
import { clickSharpLspIcon, demoRow, openFile, rowButton, sleep, waitForDemoRow } from './workbench.mjs';
import { writeCamera } from './zoom.mjs';

/** Every film is cut 1920 pixels wide, at 30 frames a second. */
const WIDTH = 1920;
const FPS = 30;

/**
 * Workspace settings: snapshots every 10 seconds, the interval the guide
 * recommends, so a reference walk never overlaps an auto-capture; and an editor
 * that lets a fix be typed key by key, exactly as written.
 */
const WORKSPACE = {
  'sharplsp.profiler.autoSnapshotInterval': 10,
  'editor.autoClosingBrackets': 'never',
  'editor.autoClosingQuotes': 'never',
  'editor.autoSurround': 'never',
  'editor.autoIndent': 'none',
  'editor.formatOnType': false,
  'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' },
  'editor.suggestOnTriggerCharacters': false,
  'editor.parameterHints.enabled': false,
  'editor.inlineSuggest.enabled': false,
  'editor.hover.enabled': false,
};

/**
 * A scene that captions step `step` and clicks `action` on the live demo's row,
 * then waits for the status bar to show `status`. Other processes come and go in
 * the list, so a click that started nothing fails the take.
 */
export const startOnRow = (step, text, action, status) => async ({ page, set }) => {
  await caption(page, step, text);
  await demoRow(page).hover();
  await sleep(2500);
  await ringClick(page, set.cues, await rowButton(page, action), action);
  await page.locator('.statusbar', { hasText: status }).waitFor({ timeout: 15_000 });
  await sleep(1000);
};

/** Off camera: a fresh process, so an act starts from a small heap. */
export async function restart({ page, app }) {
  app.stop();
  await app.start();
  await waitForDemoRow(page);
}

/** Off camera: notifications silenced, the SharpLsp view open, `file` loaded, beside a fresh process. */
export const prepare = (file) => async (shot) => {
  await runCommand(shot.page, 'Notifications: Toggle Do Not Disturb Mode');
  await clickSharpLspIcon(shot.page);
  await openFile(shot.page, file);
  await sleep(15_000);
  await restart(shot);
};

/** Off camera: close every editor, open `file`, and restart the demo for the next act. */
export const switchTo = (file) => async (shot) => {
  await runCommand(shot.page, 'View: Close All Editors');
  await openFile(shot.page, file);
  await restart(shot);
};

/** Shoot a scene again when a refreshing dashboard closes its palette, or a type is not listed yet. */
async function retried(attempts, shootScene) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await shootScene();
    } catch (error) {
      if (attempt >= attempts) throw error;
      process.stdout.write(`retrying a take: ${error.message.split('\n')[0]}\n`);
      await sleep(3500);
    }
  }
}

async function shootScenes(shot, scenes) {
  for (const scene of scenes) {
    if (scene.offCamera) await scene.offCamera(shot);
    else await retried(scene.retries ?? 1, () => record(shot.set, scene.clip, () => scene.act(shot)));
  }
}

/**
 * Stage `demo`, open it in an isolated VS Code with workspace `settings` (the
 * profiler films' by default), and shoot `scenes` into `<out>/clips`, stills
 * into `<out>/stills`.
 */
export async function shootWalkthrough({ demo, out, scenes, settings = WORKSPACE }) {
  const clips = path.join(out, 'clips');
  fs.mkdirSync(clips, { recursive: true });
  await onSet({ demo, out, settings }, ({ page, cdp, app, workspace }) => {
    const set = { page, cdp, cues: cueLog(clips), frames: path.join(out, 'frames'), clips };
    return shootScenes({ page, set, app, workspace, stills: path.join(out, 'stills') }, scenes);
  });
}

/** Each shot scene with its clip, its track and its length on screen, in seconds, at its speed. */
const shotsOf = (out, scenes) =>
  scenes
    .filter((scene) => scene.clip)
    .map((scene) => {
      const file = path.join(out, 'clips', `${scene.clip}.mp4`);
      const track = readTrack(path.join(out, 'clips', `${scene.clip}.track.json`));
      return { ...scene, file, track, length: duration(file) / (scene.speed ?? 1) };
    });

/** Shot `index`'s camera: the crop script, in `dir`, that frames its clip from its track. */
function cameraFor(shot, index, dir) {
  const [width, height] = dimensions(shot.file);
  const camera = { file: path.join(dir, `${shot.clip}.cmd`), name: `camera${index}`, width, height };
  const frames = Math.round(duration(shot.file) * FPS);
  const shots = writeCamera(shot.track, { ...camera, frames, fps: FPS, scale: width / shot.track.size[0], speed: shot.speed ?? 1 });
  process.stdout.write(`${shot.clip}: ${shots.length - 1} camera moves\n`);
  return camera;
}

const captionKey = ({ step, text, speed }) => JSON.stringify([step, text, speed]);

/** Each shot's captions, timed in its clip: its first from the cut; a clip that logs none keeps the caption before it. */
const timedCaptions = (shots) =>
  shots.reduce((list, shot) => {
    const own = shot.track.captions.map((caption, index) => ({ ...caption, from: index === 0 ? 0 : caption.t }));
    return [...list, own.length > 0 ? own : (list.at(-1) ?? []).slice(-1).map((caption) => ({ ...caption, from: 0 }))];
  }, []);

/** Each shot's caption overlays, `{ file, from, to }`, every distinct caption rendered once into `dir`. */
async function captionOverlays(shots, dir) {
  const timed = timedCaptions(shots);
  const distinct = [...new Map(timed.flat().map((caption) => [captionKey(caption), caption])).values()];
  const files = await captionFrames(distinct, shots[0].track.size, WIDTH, dir);
  const fileOf = new Map(distinct.map((caption, index) => [captionKey(caption), files[index]]));
  return timed.map((captions) =>
    captions.map((caption, index) => ({ file: fileOf.get(captionKey(caption)), from: caption.from, to: captions[index + 1]?.from ?? Infinity })),
  );
}

/** Each shot with its `camera` and its caption `overlays`, written into `<out>/camera`. */
async function direct(out, shots) {
  const dir = emptyDir(path.join(out, 'camera'));
  const overlays = await captionOverlays(shots, dir);
  return shots.map((shot, index) => ({ ...shot, camera: cameraFor(shot, index, dir), overlays: overlays[index] }));
}

const quoted = (value) => `'${value}'`;
const during = ({ from, to }) => (Number.isFinite(to) ? `gte(t,${from})*lt(t,${to})` : `gte(t,${from})`);

/** Shot `index`'s chain: cropped by its camera, scaled to the film's width, captioned, played at its speed and held for its `hold`. */
function chain(shot, index, firstOverlay) {
  const { file, name, width, height } = shot.camera;
  const scaled = `scale=${WIDTH}:${Math.round((WIDTH * height) / width / 2) * 2}:flags=lanczos,setsar=1`;
  const label = (step) => (step < 0 ? `framed${index}` : `captioned${index}_${step}`);
  const framed = `[${index}:v]format=yuv444p,sendcmd=f=${quoted(file)},crop@${name}=w=${width}:h=${height}:x=0:y=0:exact=1,${scaled}[${label(-1)}]`;
  const captioned = shot.overlays.map((overlay, step) => `[${label(step - 1)}][${firstOverlay + step}:v]overlay=enable=${quoted(during(overlay))}[${label(step)}]`);
  const hold = (shot.hold ?? 0).toFixed(3);
  const played = `[${label(shot.overlays.length - 1)}]setpts=PTS/${shot.speed ?? 1},fps=${FPS},format=yuv420p,tpad=stop_mode=clone:stop_duration=${hold}[v${index}]`;
  return [framed, ...captioned, played].join(';');
}

/** Cut the shots together, each through its camera and under its captions, held on its last frame for its `hold`, into a lossless master. */
function cut(shots, master) {
  const inputs = [...shots.map((shot) => shot.file), ...shots.flatMap((shot) => shot.overlays.map((overlay) => overlay.file))];
  const firsts = shots.map((_, index) => shots.length + shots.slice(0, index).reduce((total, shot) => total + shot.overlays.length, 0));
  const chains = shots.map((shot, index) => chain(shot, index, firsts[index]));
  const joined = `${shots.map((_, i) => `[v${i}]`).join('')}concat=n=${shots.length}:v=1:a=0[cut]`;
  const lossless = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p'];
  ffmpeg([...inputs.flatMap((file) => ['-i', file]), '-filter_complex', `${chains.join(';')};${joined}`, '-map', '[cut]', ...lossless, master], path.basename(master));
}

/** The cut of `shots` as a lossless master, `<out>/<name>-master.mp4`. */
function master(name, out, shots) {
  const file = path.join(out, `${name}-master.mp4`);
  cut(shots, file);
  return file;
}

/** The narrated film: speech, score and captions laid over the cut, which holds each shot until its line is spoken. */
async function spoken(name, out, shots, script) {
  const held = [];
  const length = await narrated(name, script, shots, (film) => {
    held.push(...film.shots);
    return master(name, out, film.shots);
  });
  return { shots: held, duration: length };
}

/** A film without narration: the cut alone, its shots unheld. */
function silent(name, out, shots) {
  publishEncodes(name, master(name, out, shots));
  return { shots, duration: shots.reduce((total, shot) => total + shot.length, 0) };
}

/** The second of the cut at which `scene`'s clip reaches `at` seconds of its own footage. */
function cutTime(shots, { scene, at }) {
  const index = shots.findIndex((shot) => shot.clip === scene);
  if (index < 0) throw new Error(`the poster's scene "${scene}" is not a clip of this film`);
  return startOf(shots, index) + at / (shots[index].speed ?? 1);
}

/**
 * Publish the MP4, the WebM and the poster, a frame of the cut as it plays;
 * with a `narration` script, also its voice, score and captions; and the
 * chapters its scenes mark ([WEB-DESIGN-MEDIA-CHAPTERS]). Resolves to the
 * film's length in seconds.
 */
export async function publishWalkthrough({ name, out, scenes, posterAt, narration }) {
  const shots = await direct(out, shotsOf(out, scenes));
  const film = narration ? await spoken(name, out, shots, narration) : silent(name, out, shots);
  poster(path.join(out, `${name}-master.mp4`), cutTime(film.shots, posterAt), name);
  writeChapters(name, film.shots);
  return film.duration;
}
