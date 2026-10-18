// Implements [WEB-DESIGN-MEDIA]. The walkthrough films: a list of scenes, each a
// real-time clip with its playback speed, shot in one isolated VS Code on a staged
// demo app, then cut together and published. leak.mjs (C#) and fsharp.mjs (F#)
// share the memory loop below: track, watch the heap grow, open a suspect, ask
// what keeps it alive, type the fix, rebuild, and track the fixed build again.
import fs from 'node:fs';
import path from 'node:path';
import { launchVsCode, runCommand } from './vscode.mjs';
import { caption, ringClick } from './overlay.mjs';
import { H264, VP9, ffmpeg, poster, videos } from './encode.mjs';
import {
  awaitDashboard,
  buildDemo,
  clickSharpLspIcon,
  cueLog,
  demoApp,
  demoRow,
  headerButton,
  openFile,
  record,
  rowButton,
  scrollDashboard,
  sleep,
  stageDemo,
  waitForDemoRow,
} from './studio.mjs';

const GROW_SECONDS = 6;
const VERIFY_SECONDS = 45;

/**
 * Workspace settings: snapshots every 10 seconds, the interval the guide
 * recommends, so a reference walk never overlaps an auto-capture; and an editor
 * that lets the fix be typed key by key, exactly as written.
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

export const dashboard = (page) => page.frameLocator('iframe.webview').first().frameLocator('#active-frame');

/** The status-bar progress of an auto-capture still talking to the target. */
const capturing = (page) => page.locator('.statusbar', { hasText: 'Auto-capturing memory' });

/**
 * Hover the live demo's row so its memory shows, then click `action`. Other
 * processes come and go in the list, so a click that started nothing fails the take.
 */
export async function startOnRow(page, cues, action, status) {
  await demoRow(page).hover();
  await sleep(2500);
  await ringClick(page, cues, await rowButton(page, action), action);
  await page.locator('.statusbar', { hasText: status }).waitFor({ timeout: 15_000 });
  await sleep(1000);
}

const startTracking = (page, cues) => startOnRow(page, cues, 'Track Memory', 'Memory: tracking');

/** Pick `type` from the types the latest snapshot reported; a take without it is shot again. */
async function pickType(page, type) {
  await page.locator('.quick-input-widget input').fill(type.split('.').at(-1));
  await sleep(700);
  if ((await page.locator('.quick-input-list .monaco-list-row', { hasText: type }).count()) === 0) {
    await page.keyboard.press('Escape');
    throw new Error(`${type} is not in the latest snapshot yet`);
  }
  await page.keyboard.press('Enter');
}

/** Go to `line` and type `text` over it, or after its end when the edit appends. */
async function typeAt(page, { line, text, append = false }) {
  await page.keyboard.press('Control+G');
  await page.locator('.quick-input-widget input').fill(`:${line}`);
  await page.keyboard.press('Enter');
  await page.keyboard.press(append ? 'End' : 'Shift+End');
  await page.keyboard.type(text, { delay: 28 });
}

/**
 * Off camera: stop tracking, let any in-flight capture finish before the
 * leaking app exits, and reopen a clean `file`.
 */
async function stopAndReopen({ page, app }, file) {
  await clickSharpLspIcon(page);
  await (await headerButton(page, 'Stop Memory Tracking')).click();
  await capturing(page).waitFor({ state: 'detached', timeout: 60_000 });
  app.stop();
  await openFile(page, file);
  await runCommand(page, 'File: Revert File');
  await runCommand(page, 'View: Close All Editors');
  await openFile(page, file);
  await clickSharpLspIcon(page);
  await page.locator('.monaco-editor .view-lines').first().click();
}

/** Off camera: build the fixed code and start it with the Processes view open. */
async function relaunch({ page, app, workspace }) {
  buildDemo(workspace);
  await app.start();
  await clickSharpLspIcon(page);
  await waitForDemoRow(page);
}

/** Off camera: the editor on `file`, loaded, beside a freshly started demo. */
export async function prepare({ page, app }, file) {
  await runCommand(page, 'Notifications: Toggle Do Not Disturb Mode');
  await clickSharpLspIcon(page);
  await openFile(page, file);
  await sleep(15_000);
  await restart({ page, app });
}

/** Off camera: a fresh process, so a memory act starts from a small heap. */
export async function restart({ page, app }) {
  app.stop();
  await app.start();
  await waitForDemoRow(page);
}

/**
 * The memory loop as scenes, numbered from `first`. `story` names the file the
 * fix goes in, the suspect's type, the fix's edits and each step's caption
 * (`rooted`, over the drawn graph, defaults to the `graph` question), plus any
 * off-camera `afterSuspect` and `afterGraph` steps.
 */
export function memoryLoop(story, first) {
  const step = (offset) => first + offset;
  const graph = story.captions.graph;
  return [
    { clip: 'track', retries: 3, act: ({ page, set }) => caption(page, step(0), story.captions.track).then(() => startTracking(page, set.cues)) },
    { clip: 'grow', speed: 8, act: ({ page }) => growScene(page, step(1), story.captions.grow) },
    { clip: 'suspect', act: (shot) => suspectScene(shot, step(2), story) },
    ...(story.afterSuspect ? [{ offCamera: story.afterSuspect }] : []),
    { clip: 'ask', retries: 5, act: ({ page }) => askScene(page, step(3), graph, story.type) },
    { clip: 'walk', speed: 8, act: ({ page }) => walkScene(page, step(3), graph) },
    { clip: 'graph', act: ({ page }) => caption(page, step(3), story.captions.rooted ?? graph).then(() => sleep(7000)) },
    ...(story.afterGraph ? [{ offCamera: story.afterGraph }] : []),
    { offCamera: (shot) => stopAndReopen(shot, story.file) },
    { clip: 'fix', act: ({ page }) => fixScene(page, step(4), story) },
    { offCamera: relaunch },
    { clip: 'retrack', retries: 3, act: ({ page, set }) => caption(page, step(5), story.captions.retrack).then(() => startTracking(page, set.cues)) },
    { clip: 'verify', speed: 8, act: ({ page }) => verifyScene(page, step(5), story.captions.retrack) },
    { clip: 'steady', act: ({ page }) => steadyScene(page, step(6), story.captions.steady) },
  ];
}

/** Runs until the autopilot ranks a suspect High (three growths in a row), and long enough to watch the climb. */
async function growScene(page, step, text) {
  await caption(page, step, text, '8×');
  await awaitDashboard(page);
  const high = dashboard(page).locator('.leak-row .badge', { hasText: /high/i }).first();
  await Promise.all([high.waitFor({ state: 'attached', timeout: 120_000 }), sleep(GROW_SECONDS * 1000)]);
}

async function suspectScene({ page, set }, step, story) {
  await caption(page, step, story.captions.suspect);
  await scrollDashboard(page, 8000);
  await sleep(2500);
  await ringClick(page, set.cues, dashboard(page).locator('.leak-row', { hasText: story.file }).first(), 'Suspect');
  await sleep(3500);
}

async function askScene(page, step, text, type) {
  await caption(page, step, text);
  await capturing(page).waitFor({ state: 'detached', timeout: 60_000 });
  await sleep(600);
  await runCommand(page, 'SharpLsp: Show Reference Graph');
  await pickType(page, type);
}

/** The walk over a live heap of a hundred megabytes takes a while: fast-forwarded. */
async function walkScene(page, step, text) {
  await caption(page, step, text, '8×');
  await page.locator('.tab', { hasText: 'Retention Graph' }).waitFor({ timeout: 240_000 });
  await sleep(1000);
}

async function fixScene(page, step, story) {
  await caption(page, step, story.captions.fix);
  await sleep(2000);
  for (const edit of story.fix) await typeAt(page, edit);
  await page.keyboard.press('Meta+S');
  await sleep(3000);
}

async function verifyScene(page, step, text) {
  await caption(page, step, text, '8×');
  await awaitDashboard(page);
  await sleep(VERIFY_SECONDS * 1000);
}

async function steadyScene(page, step, text) {
  await caption(page, step, text);
  await sleep(2500);
  await scrollDashboard(page, 8000);
  await sleep(4000);
}

/** Shoot a scene again when a refreshing dashboard closes its palette, or the type is not listed yet. */
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

/** Stage `demo`, open it in an isolated VS Code, and shoot `scenes` into `<out>/clips`. */
export async function shootWalkthrough({ demo, out, scenes }) {
  const clips = path.join(out, 'clips');
  fs.mkdirSync(clips, { recursive: true });
  const { root, workspace } = stageDemo(demo);
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify(WORKSPACE));
  const editor = await launchVsCode({ workspace });
  const app = demoApp(workspace);
  await app.start();
  const set = { cdp: editor.cdp, cues: cueLog(clips), frames: path.join(out, 'frames'), clips };
  try {
    await shootScenes({ page: editor.page, set, app, workspace }, scenes);
  } catch (error) {
    await editor.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    app.stop();
    await editor.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Cut the scenes together at their speeds, then publish the MP4, the WebM and the poster. */
export function publishWalkthrough({ name, out, scenes, posterAt }) {
  const shot = scenes.filter((scene) => scene.clip);
  const clip = (name) => path.join(out, 'clips', `${name}.mp4`);
  const inputs = shot.flatMap((scene) => ['-i', clip(scene.clip)]);
  const chains = shot.map((scene, i) => `[${i}:v]setpts=PTS/${scene.speed ?? 1},fps=30,scale=1920:-2:flags=lanczos[v${i}]`);
  const joined = `${shot.map((_, i) => `[v${i}]`).join('')}concat=n=${shot.length}:v=1:a=0[cut]`;
  const master = path.join(out, `${name}-master.mp4`);
  const lossless = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p'];
  ffmpeg([...inputs, '-filter_complex', `${chains.join(';')};${joined}`, '-map', '[cut]', ...lossless, master], `${name} master`);
  ffmpeg(['-i', master, ...H264, path.join(videos, `${name}.mp4`)], `${name} mp4`);
  ffmpeg(['-i', master, ...VP9, path.join(videos, `${name}.webm`)], `${name} webm`);
  poster(clip(posterAt.scene), posterAt.at, name);
}
