// Implements [WEB-DESIGN-MEDIA]. Shoots the profiler film's raw material in a real, isolated VS Code running the
// packaged SharpLsp VSIX against the Storefront demo app: stills (PNG, 3200x2000)
// and real-time screencast clips, plus the click cues the film's cursor follows.
//
//   make _build-vsix VSIX_PREBUILT=1
//   node src/website/tools/profiler-film/capture.mjs
//
// Output lands in tools/profiler-film/out/ (gitignored); render.mjs turns it into
// the website's assets.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchVsCode, runCommand } from './vscode.mjs';
import { startScreencast } from './screencast.mjs';
import { captureFlameGraph } from './flamegraph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const stills = path.join(out, 'stills');
const clips = path.join(out, 'clips');
const PROFILE_SECONDS = 10;
const MEMORY_SECONDS = 26;

/** Where the mouse rests between actions: empty title bar, hovering nothing. */
const PARK = { x: 1450, y: 22 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Copy the demo to a neutral temp path and build it there, so no home-directory
 * path (the user's name) can reach a frame name or tooltip on camera.
 */
function stageStorefront() {
  // The real path: macOS's tmpdir is a symlink the .NET runtime resolves, and
  // heat-map decorations only land when both sides spell the file the same way.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'film-'));
  const workspace = path.join(root, 'Storefront');
  fs.cpSync(path.join(here, 'storefront'), workspace, {
    recursive: true,
    filter: (source) => !['bin', 'obj', '.sharplsp'].includes(path.basename(source)),
  });
  const build = spawnSync('dotnet', ['build', '-c', 'Debug', '--nologo', '-v', 'q'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`Storefront build failed: ${build.stdout}`);
  return { root, workspace };
}

/** Start Storefront by absolute path (discovery needs it) and wait for its banner. */
async function startStorefront(workspace) {
  const app = spawn(path.join(workspace, 'bin/Debug/net10.0/Storefront'), [], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => {
    app.stdout.once('data', resolve);
    app.once('exit', (code) => reject(new Error(`Storefront exited with ${code}`)));
  });
  return app;
}

/** Click-cue log: where and when the (invisible) mouse acted, relative to a clip's start. */
function cueLog() {
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

const processesHeader = (page) => page.locator('.pane-header', { hasText: 'Processes' });
/** The live Storefront's PID: its row, never a stale one from a restarted run. */
let storefrontPid = 0;
const storefrontRow = (page) =>
  page.getByRole('treeitem').filter({ hasText: `Storefront — StorefrontPID ${storefrontPid}` }).first();

async function headerButton(page, name) {
  await processesHeader(page).hover();
  return processesHeader(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

async function rowButton(page, name) {
  await storefrontRow(page).hover();
  await sleep(250);
  return storefrontRow(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

/** A clean frame: no hover (Do Not Disturb keeps toasts off screen). */
async function still(page, name) {
  await page.mouse.move(PARK.x, PARK.y);
  await sleep(700);
  await page.screenshot({ path: path.join(stills, `${name}.png`) });
}

/**
 * Click the SharpLsp activity-bar icon. It opens the SharpLsp view; on the view
 * already open it folds the side bar away. That is how the memory act hides it:
 * the dashboard webview refreshes on every auto-snapshot and would close a
 * palette, and the native menu owns Cmd+B, so a synthetic key never reaches it.
 */
async function clickSharpLspIcon(page) {
  await page.locator('.activitybar a[aria-label^="SharpLsp"]').first().click({ force: true });
  await sleep(900);
}

async function openFile(page, name) {
  await page.keyboard.press('Meta+P');
  await page.locator('.quick-input-widget input').fill(name);
  await sleep(700);
  await page.keyboard.press('Enter');
  await sleep(1200);
}

/** Wait until the Processes view lists the Storefront row. */
async function waitForStorefrontRow(page) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await storefrontRow(page).isVisible().catch(() => false)) return;
    await (await headerButton(page, 'Refresh Processes')).click();
    await sleep(1000);
  }
  throw new Error('Storefront never appeared in the Processes view');
}

/**
 * Toggle `title`'s editor group maximised by double-clicking its tab — no
 * palette, which a refreshing webview would close by stealing focus.
 */
async function toggleMaximised(page, title) {
  await page.locator('.tab', { hasText: title }).first().dblclick();
  await sleep(1200);
}

async function toggleSideBar(page) {
  await runCommand(page, 'View: Toggle Primary Side Bar Visibility');
  await sleep(800);
}

async function cpuAct(page, cues) {
  await cues.click(page, await rowButton(page, 'Profile CPU'), 'Profile CPU');
  await sleep(7000);
  await still(page, 'profiler-live');
  await sleep((PROFILE_SECONDS - 7) * 1000);
  await cues.click(page, await headerButton(page, 'Stop Profiling'), 'Stop Profiling');
  await page.locator('.tab', { hasText: 'SharpLsp Profiler' }).waitFor({ timeout: 60_000 });
  await sleep(3500);
}

async function cpuStills(page) {
  await toggleMaximised(page, 'SharpLsp Profiler');
  await still(page, 'profiler-results');
  await toggleMaximised(page, 'SharpLsp Profiler');
  await toggleMaximised(page, 'CheckoutPipeline.cs');
  await toggleSideBar(page);
  await still(page, 'profiler-heatmap');
  await toggleSideBar(page);
  await toggleMaximised(page, 'CheckoutPipeline.cs');
}

const DASHBOARD = 'SharpLsp Memory Dashboard';

async function memoryAct(page, cues) {
  await cues.click(page, await rowButton(page, 'Track Memory'), 'Track Memory');
  await page.locator('.tab', { hasText: DASHBOARD }).waitFor({ timeout: 60_000 });
  await sleep(1500);
  await clickSharpLspIcon(page);
  await page.mouse.move(PARK.x, PARK.y);
  await sleep(MEMORY_SECONDS * 1000);
}

async function scrollDashboard(page, pixels) {
  await page.mouse.move(1300, 600);
  await page.mouse.wheel(0, pixels);
  await sleep(1200);
}

/** The autopilot's consecutive snapshots already rank the leak suspects: no Compare step. */
async function memoryStills(page) {
  await scrollDashboard(page, 250);
  await still(page, 'profiler-memory');
  await scrollDashboard(page, 8000);
  await still(page, 'profiler-leaks');
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

async function record(cdp, cues, name, act) {
  cues.restart();
  const stop = await startScreencast(cdp, path.join(out, 'frames', name));
  await act();
  await stop(path.join(clips, `${name}.mp4`));
  cues.save(name);
}

/** The demo app, restartable so the memory act starts from a fresh, small heap. */
function storefront(workspace) {
  let app;
  return {
    start: async () => {
      app = await startStorefront(workspace);
      storefrontPid = app.pid;
    },
    stop: () => app?.kill(),
  };
}

async function shoot(page, cdp, app) {
  const cues = cueLog();
  await prepare(page);
  await record(cdp, cues, 'cpu', () => cpuAct(page, cues));
  await cpuStills(page);
  await runCommand(page, 'View: Close All Editors');
  await openFile(page, 'SessionCache.cs');
  app.stop();
  await app.start();
  await waitForStorefrontRow(page);
  await record(cdp, cues, 'memory', () => memoryAct(page, cues));
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
