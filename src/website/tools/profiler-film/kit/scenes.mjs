// Implements [WEB-DESIGN-MEDIA]. A walkthrough is a list of scenes. A scene is
// either a clip, `{ clip, act, speed, retries }`, shot in real time and played
// back at `speed`, or an `{ offCamera }` step between clips. shootWalkthrough
// shoots the list on a demo's set; publishWalkthrough cuts the clips together,
// lays a narrated film's voice, score and captions over the cut, and writes the
// site's MP4, WebM and poster.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cueLog, record } from './camera.mjs';
import { AAC, H264, OPUS, VP9, audible, duration, ffmpeg, poster, videos } from './encode.mjs';
import { runCommand } from './editor.mjs';
import { caption, ringClick } from './overlay.mjs';
import { onSet } from './set.mjs';
import { soundtrack } from './sound/soundtrack.mjs';
import { writeCaptions } from './sound/voice.mjs';
import { clickSharpLspIcon, demoRow, openFile, rowButton, sleep, waitForDemoRow } from './workbench.mjs';

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

/** Stage `demo`, open it in an isolated VS Code, and shoot `scenes` into `<out>/clips`, stills into `<out>/stills`. */
export async function shootWalkthrough({ demo, out, scenes }) {
  const clips = path.join(out, 'clips');
  fs.mkdirSync(clips, { recursive: true });
  await onSet({ demo, out, settings: WORKSPACE }, ({ page, cdp, app, workspace }) => {
    const set = { cdp, cues: cueLog(clips), frames: path.join(out, 'frames'), clips };
    return shootScenes({ page, set, app, workspace, stills: path.join(out, 'stills') }, scenes);
  });
}

/** Each shot scene with its clip and its length on screen, in seconds, at its speed. */
const shotsOf = (out, scenes) =>
  scenes
    .filter((scene) => scene.clip)
    .map((scene) => {
      const file = path.join(out, 'clips', `${scene.clip}.mp4`);
      return { ...scene, file, length: duration(file) / (scene.speed ?? 1) };
    });

/** Cut the shots together at their speeds, each held on its last frame for its `hold`, into a lossless master. */
function cut(shots, master) {
  const inputs = shots.flatMap((shot) => ['-i', shot.file]);
  const chains = shots.map(
    (shot, i) => `[${i}:v]setpts=PTS/${shot.speed ?? 1},fps=30,scale=1920:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=${(shot.hold ?? 0).toFixed(3)}[v${i}]`,
  );
  const joined = `${shots.map((_, i) => `[v${i}]`).join('')}concat=n=${shots.length}:v=1:a=0[cut]`;
  const lossless = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p'];
  ffmpeg([...inputs, '-filter_complex', `${chains.join(';')};${joined}`, '-map', '[cut]', ...lossless, master], path.basename(master));
}

/** The site's MP4 and WebM of the cut, with `audio` as their soundtrack when there is one. */
function encodeFilm(name, out, shots, audio) {
  const master = path.join(out, `${name}-master.mp4`);
  cut(shots, master);
  for (const [video, sound, extension] of [[H264, AAC, 'mp4'], [VP9, OPUS, 'webm']]) {
    const inputs = audio ? ['-i', master, '-i', audio, '-map', '0:v', '-map', '1:a', ...audible(video), ...sound, '-shortest'] : ['-i', master, ...video];
    ffmpeg([...inputs, path.join(videos, `${name}.${extension}`)], `${name} ${extension}`);
  }
}

/** The narrated film: speech, score and captions laid over the cut, which holds each shot until its line is spoken. */
async function narrated(name, out, shots, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-sound-`));
  try {
    const film = await soundtrack(script, shots, dir);
    encodeFilm(name, out, film.shots, film.audio);
    writeCaptions(script, film.lines, videos, name);
    return film.duration;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Publish the MP4, the WebM and the poster; with a `narration` script, also its
 * voice, score and captions. Resolves to the film's length in seconds.
 */
export async function publishWalkthrough({ name, out, scenes, posterAt, narration }) {
  const shots = shotsOf(out, scenes);
  const length = narration ? await narrated(name, out, shots, narration) : shots.reduce((total, shot) => total + shot.length, 0);
  if (!narration) encodeFilm(name, out, shots);
  poster(path.join(out, 'clips', `${posterAt.scene}.mp4`), posterAt.at, name);
  return length;
}
