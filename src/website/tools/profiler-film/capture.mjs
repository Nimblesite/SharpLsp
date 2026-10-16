// Implements [WEB-DESIGN-MEDIA]. Shoots the profiler film's raw material in a real, isolated VS Code running the
// packaged SharpLsp VSIX against the Storefront demo app: stills (PNG, 3200x2000)
// and real-time screencast clips, plus the click cues the film's cursor follows.
//
//   make _build-vsix VSIX_PREBUILT=1
//   node src/website/tools/profiler-film/capture.mjs
//
// Output lands in tools/profiler-film/out/ (gitignored); render.mjs turns it into
// the website's assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchVsCode, runCommand } from './vscode.mjs';
import { captureFlameGraph } from './flamegraph.mjs';
import {
  PARK,
  clickSharpLspIcon,
  cueLog,
  headerButton,
  openFile,
  record,
  rowButton,
  scrollDashboard,
  sleep,
  stageStorefront,
  still,
  storefront,
  storefrontRow,
  toggleSideBar,
  trackMemory,
  waitForStorefrontRow,
} from './studio.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const stills = path.join(out, 'stills');
const clips = path.join(out, 'clips');
const PROFILE_SECONDS = 10;
const MEMORY_SECONDS = 26;

/**
 * Toggle `title`'s editor group maximised by double-clicking its tab — no
 * palette, which a refreshing webview would close by stealing focus.
 */
async function toggleMaximised(page, title) {
  await page.locator('.tab', { hasText: title }).first().dblclick();
  await sleep(1200);
}

async function cpuAct(page, cues) {
  await cues.click(page, await rowButton(page, 'Profile CPU'), 'Profile CPU');
  await sleep(7000);
  await still(page, stills, 'profiler-live');
  await sleep((PROFILE_SECONDS - 7) * 1000);
  await cues.click(page, await headerButton(page, 'Stop Profiling'), 'Stop Profiling');
  await page.locator('.tab', { hasText: 'SharpLsp Profiler' }).waitFor({ timeout: 60_000 });
  await sleep(3500);
}

async function cpuStills(page) {
  await toggleMaximised(page, 'SharpLsp Profiler');
  await still(page, stills, 'profiler-results');
  await toggleMaximised(page, 'SharpLsp Profiler');
  await toggleMaximised(page, 'CheckoutPipeline.cs');
  await toggleSideBar(page);
  await still(page, stills, 'profiler-heatmap');
  await toggleSideBar(page);
  await toggleMaximised(page, 'CheckoutPipeline.cs');
}

async function memoryAct(page, cues) {
  await trackMemory(page, (locator, label) => cues.click(page, locator, label));
  await sleep(MEMORY_SECONDS * 1000);
}

/** The autopilot's consecutive snapshots already rank the leak suspects: no Compare step. */
async function memoryStills(page) {
  await scrollDashboard(page, 250);
  await still(page, stills, 'profiler-memory');
  await scrollDashboard(page, 8000);
  await still(page, stills, 'profiler-leaks');
}

async function prepare(page) {
  await runCommand(page, 'Notifications: Toggle Do Not Disturb Mode');
  await clickSharpLspIcon(page);
  await openFile(page, 'CheckoutPipeline.cs');
  await sleep(15_000);
  await waitForStorefrontRow(page);
  await page.mouse.move(PARK.x, PARK.y);
  await storefrontRow(page).hover();
  await sleep(600);
  await page.screenshot({ path: path.join(stills, 'profiler-processes.png') });
}

async function shoot(page, cdp, app) {
  const set = { cdp, cues: cueLog(clips), frames: path.join(out, 'frames'), clips };
  await prepare(page);
  await record(set, 'cpu', () => cpuAct(page, set.cues));
  await cpuStills(page);
  await runCommand(page, 'View: Close All Editors');
  await openFile(page, 'SessionCache.cs');
  app.stop();
  await app.start();
  await waitForStorefrontRow(page);
  await record(set, 'memory', () => memoryAct(page, set.cues));
  await memoryStills(page);
}

async function main() {
  fs.mkdirSync(stills, { recursive: true });
  fs.mkdirSync(clips, { recursive: true });
  const { root, workspace } = stageStorefront();
  const editor = await launchVsCode({ workspace });
  const app = storefront(workspace);
  await app.start();
  try {
    await shoot(editor.page, editor.cdp, app);
    await captureFlameGraph(path.join(workspace, '.sharplsp/profiles'), out);
  } catch (error) {
    await editor.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    app.stop();
    await editor.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
