// Implements [WEB-DESIGN-MEDIA]. Shoots and publishes the memory-leak walkthrough
// the "Fix a Memory Leak" guide plays: a real, isolated VS Code with the packaged
// SharpLsp VSIX finds the Storefront demo's leak, follows it to the static field
// that roots it, types the fix, rebuilds, and tracks the fixed build again.
//
//   make _build-vsix VSIX_PREBUILT=1
//   node src/website/tools/profiler-film/leak.mjs              (shoot, then publish)
//   node src/website/tools/profiler-film/leak.mjs --publish    (publish the last shoot)
//
// Clips land in tools/profiler-film/out/leak/ (gitignored). Every stretch the
// published video fast-forwards carries a speed badge on screen.
import fs from 'node:fs';
import path from 'node:path';
import { launchVsCode, runCommand } from './vscode.mjs';
import { caption, ringClick } from './overlay.mjs';
import { H264, VP9, ffmpeg, out as filmOut, poster, videos } from './encode.mjs';
import {
  awaitDashboard,
  buildStorefront,
  clickSharpLspIcon,
  cueLog,
  headerButton,
  openFile,
  record,
  rowButton,
  scrollDashboard,
  sleep,
  stageStorefront,
  storefront,
  storefrontRow,
  waitForStorefrontRow,
} from './studio.mjs';

const out = path.join(filmOut, 'leak');
const clips = path.join(out, 'clips');
const NAME = 'profiler-fix-memory-leak';
const GROW_SECONDS = 6;
const VERIFY_SECONDS = 45;

/** Each clip, in order, and its playback speed in the published video. */
const SCENES = [
  ['track', 1], ['grow', 8], ['suspect', 1], ['ask', 1], ['walk', 8], ['graph', 1],
  ['fix', 1], ['retrack', 1], ['verify', 8], ['steady', 1],
];
const POSTER = { scene: 'graph', at: 5 };

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

/** The fix: each entry replaces one line of SessionCache.cs. */
const FIX = [
  { line: 3, text: '// Remembers the last 1,000 orders "for analytics", and forgets older ones.' },
  {
    line: 8,
    text: [
      '    public static void Remember(Order order)',
      '    {',
      '        Sessions[order.Id] = new CustomerSession(order);',
      '        Sessions.Remove(order.Id - 1_000);',
      '    }',
    ].join('\n'),
  },
];

const dashboard = (page) => page.frameLocator('iframe.webview').first().frameLocator('#active-frame');

/**
 * Hover the live Storefront row so its memory shows, then click Track Memory.
 * Other processes come and go in the list, so a click that started nothing
 * fails the take.
 */
async function startTracking(page, cues) {
  await storefrontRow(page).hover();
  await sleep(2500);
  await ringClick(page, cues, await rowButton(page, 'Track Memory'), 'Track Memory');
  await page.locator('.statusbar', { hasText: 'Memory: tracking' }).waitFor({ timeout: 15_000 });
  await sleep(1000);
}

async function trackScene(page, cues) {
  await caption(page, 1, 'Track Memory on the process whose memory keeps climbing');
  await startTracking(page, cues);
}

/** Runs until the autopilot ranks a suspect High (three growths in a row), and long enough to watch the climb. */
async function growScene(page) {
  await caption(page, 2, 'Let it run: SharpLsp snapshots the heap every 10 seconds', '8×');
  await awaitDashboard(page);
  const high = dashboard(page).locator('.leak-row .badge', { hasText: /high/i }).first();
  await Promise.all([high.waitFor({ state: 'attached', timeout: 120_000 }), sleep(GROW_SECONDS * 1000)]);
}

async function suspectScene(page, cues) {
  await caption(page, 3, 'Suspects rank by consistent growth. Click one to jump to its code');
  await scrollDashboard(page, 8000);
  await sleep(2500);
  await ringClick(page, cues, dashboard(page).locator('.leak-row', { hasText: 'SessionCache.cs' }).first(), 'Suspect');
  await sleep(3500);
}

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

const GRAPH_CAPTION = 'Ask what keeps it alive: SharpLsp: Show Reference Graph';

async function askScene(page) {
  await caption(page, 4, GRAPH_CAPTION);
  await capturing(page).waitFor({ state: 'detached', timeout: 60_000 });
  await sleep(600);
  await runCommand(page, 'SharpLsp: Show Reference Graph');
  await pickType(page, 'Storefront.CustomerSession');
}

/** The walk over a live heap of a hundred megabytes takes a while: fast-forwarded. */
async function walkScene(page) {
  await caption(page, 4, GRAPH_CAPTION, '8×');
  await page.locator('.tab', { hasText: 'Retention Graph' }).waitFor({ timeout: 240_000 });
  await sleep(1000);
}

async function graphScene(page) {
  await caption(page, 4, GRAPH_CAPTION);
  await sleep(7000);
}

/** Go to `line`, select it, and type `text` over it. */
async function typeOver(page, line, text) {
  await page.keyboard.press('Control+G');
  await page.locator('.quick-input-widget input').fill(`:${line}`);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+End');
  await page.keyboard.type(text, { delay: 28 });
}

async function fixScene(page) {
  await caption(page, 5, 'Fix it: keep a bounded window and evict the rest');
  await sleep(2000);
  for (const { line, text } of FIX) await typeOver(page, line, text);
  await page.keyboard.press('Meta+S');
  await sleep(3000);
}

async function retrackScene(page, cues) {
  await caption(page, 6, 'Rebuild, run, and track memory again');
  await startTracking(page, cues);
}

async function verifyScene(page) {
  await caption(page, 6, 'Rebuild, run, and track memory again', '8×');
  await awaitDashboard(page);
  await sleep(VERIFY_SECONDS * 1000);
}

async function steadyScene(page) {
  await caption(page, 7, 'The heap holds steady, and no suspect climbs past Low');
  await sleep(2500);
  await scrollDashboard(page, 8000);
  await sleep(4000);
}

/** The status-bar progress of an auto-capture still talking to the target. */
const capturing = (page) => page.locator('.statusbar', { hasText: 'Auto-capturing memory' });

/**
 * Off camera: stop tracking, let any in-flight capture finish before the
 * leaking app exits, and reopen a clean SessionCache.cs.
 */
async function stopAndReopen(page, app) {
  await clickSharpLspIcon(page);
  await (await headerButton(page, 'Stop Memory Tracking')).click();
  await capturing(page).waitFor({ state: 'detached', timeout: 60_000 });
  app.stop();
  await openFile(page, 'SessionCache.cs');
  await runCommand(page, 'File: Revert File');
  await runCommand(page, 'View: Close All Editors');
  await openFile(page, 'SessionCache.cs');
  await clickSharpLspIcon(page);
  await page.locator('.monaco-editor .view-lines').first().click();
}

/** Off camera: build the fixed code and start it with the Processes view open. */
async function relaunch(page, app, workspace) {
  buildStorefront(workspace);
  await app.start();
  await clickSharpLspIcon(page);
  await waitForStorefrontRow(page);
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

async function prepare(page, app) {
  await runCommand(page, 'Notifications: Toggle Do Not Disturb Mode');
  await clickSharpLspIcon(page);
  await openFile(page, 'SessionCache.cs');
  await sleep(15_000);
  app.stop();
  await app.start();
  await waitForStorefrontRow(page);
}

async function shoot(page, set, app, workspace) {
  await prepare(page, app);
  await retried(3, () => record(set, 'track', () => trackScene(page, set.cues)));
  await record(set, 'grow', () => growScene(page));
  await record(set, 'suspect', () => suspectScene(page, set.cues));
  await retried(5, () => record(set, 'ask', () => askScene(page)));
  await record(set, 'walk', () => walkScene(page));
  await record(set, 'graph', () => graphScene(page));
  await stopAndReopen(page, app);
  await record(set, 'fix', () => fixScene(page));
  await relaunch(page, app, workspace);
  await retried(3, () => record(set, 'retrack', () => retrackScene(page, set.cues)));
  await record(set, 'verify', () => verifyScene(page));
  await record(set, 'steady', () => steadyScene(page));
}

async function shootAll() {
  fs.mkdirSync(clips, { recursive: true });
  const { root, workspace } = stageStorefront();
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify(WORKSPACE));
  const editor = await launchVsCode({ workspace });
  const app = storefront(workspace);
  await app.start();
  try {
    await shoot(editor.page, { cdp: editor.cdp, cues: cueLog(clips), frames: path.join(out, 'frames'), clips }, app, workspace);
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
function publish() {
  const inputs = SCENES.flatMap(([name]) => ['-i', path.join(clips, `${name}.mp4`)]);
  const chains = SCENES.map(([, speed], i) => `[${i}:v]setpts=PTS/${speed},fps=30,scale=1920:-2:flags=lanczos[v${i}]`);
  const joined = `${SCENES.map((_, i) => `[v${i}]`).join('')}concat=n=${SCENES.length}:v=1:a=0[cut]`;
  const master = path.join(out, `${NAME}-master.mp4`);
  const lossless = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p'];
  ffmpeg([...inputs, '-filter_complex', `${chains.join(';')};${joined}`, '-map', '[cut]', ...lossless, master], 'leak master');
  ffmpeg(['-i', master, ...H264, path.join(videos, `${NAME}.mp4`)], 'leak mp4');
  ffmpeg(['-i', master, ...VP9, path.join(videos, `${NAME}.webm`)], 'leak webm');
  poster(path.join(clips, `${POSTER.scene}.mp4`), POSTER.at, NAME);
}

if (!process.argv.includes('--publish')) await shootAll();
publish();
