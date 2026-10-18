// Implements [WEB-DESIGN-MEDIA]. The set every profiler film is shot on: a demo
// app staged and built at a neutral temp path, the isolated VS Code's Processes
// view and editor moves, and the real-time screencast recorder. capture.mjs (the
// profiler film), leak.mjs (the C# leak walkthrough) and fsharp.mjs (the F#
// walkthrough) all shoot here.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './vscode.mjs';
import { startScreencast } from './screencast.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the mouse rests between actions: empty title bar, hovering nothing. */
export const PARK = { x: 1450, y: 22 };

export const DASHBOARD = 'SharpLsp Memory Dashboard';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The demo apps the films are shot on: a folder here holding one project. The
 * C# Storefront and its F# twin check out orders forever, with real hot paths
 * and a cache that never evicts.
 */
export const STOREFRONT = { folder: 'storefront', project: 'Storefront' };
export const FS_STOREFRONT = { folder: 'fs-storefront', project: 'FsStorefront' };

/** Build the staged demo; a failed build stops the shoot. */
export function buildDemo(workspace) {
  const build = spawnSync('dotnet', ['build', '-c', 'Debug', '--nologo', '-v', 'q'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`${path.basename(workspace)} build failed: ${build.stdout}`);
}

/**
 * Copy `demo` to a neutral temp path and build it there, so no home-directory
 * path (the user's name) can reach a frame name or tooltip on camera.
 */
export function stageDemo(demo) {
  // The real path: macOS's tmpdir is a symlink the .NET runtime resolves, and
  // heat-map decorations only land when both sides spell the file the same way.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'film-'));
  const workspace = path.join(root, demo.project);
  fs.cpSync(path.join(here, demo.folder), workspace, {
    recursive: true,
    filter: (source) => !['bin', 'obj', '.sharplsp'].includes(path.basename(source)),
  });
  buildDemo(workspace);
  return { root, workspace };
}

/** Start the demo by absolute path (discovery needs it) and wait for its banner. */
async function startDemo(workspace) {
  const project = path.basename(workspace);
  const app = spawn(path.join(workspace, `bin/Debug/net10.0/${project}`), [], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => {
    app.stdout.once('data', resolve);
    app.once('exit', (code) => reject(new Error(`${project} exited with ${code}`)));
  });
  return app;
}

/** The live demo's PID: its row, never a stale one from a restarted run. */
let demoPid = 0;

/** The staged demo app, restartable so a memory act starts from a fresh, small heap. */
export function demoApp(workspace) {
  let app;
  return {
    start: async () => {
      app = await startDemo(workspace);
      demoPid = app.pid;
    },
    stop: () => app?.kill(),
  };
}

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

const processesHeader = (page) => page.locator('.pane-header', { hasText: 'Processes' });

export const demoRow = (page) =>
  page.getByRole('treeitem').filter({ hasText: new RegExp(`PID ${demoPid}(?!\\d)`) }).first();

export async function headerButton(page, name) {
  await processesHeader(page).hover();
  return processesHeader(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

export async function rowButton(page, name) {
  await demoRow(page).hover();
  await sleep(250);
  return demoRow(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

/** Wait until the Processes view lists the live demo's row. */
export async function waitForDemoRow(page) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await demoRow(page).isVisible().catch(() => false)) return;
    await (await headerButton(page, 'Refresh Processes')).click();
    await sleep(1000);
  }
  throw new Error(`PID ${demoPid} never appeared in the Processes view`);
}

/** A clean frame: no hover (Do Not Disturb keeps toasts off screen). */
export async function still(page, dir, name) {
  await page.mouse.move(PARK.x, PARK.y);
  await sleep(700);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

/**
 * Click the SharpLsp activity-bar icon. It opens the SharpLsp view; on the view
 * already open it folds the side bar away. That is how a memory act hides it:
 * the dashboard webview refreshes on every auto-snapshot and would close a
 * palette, and the native menu owns Cmd+B, so a synthetic key never reaches it.
 */
export async function clickSharpLspIcon(page) {
  await page.locator('.activitybar a[aria-label^="SharpLsp"]').first().click({ force: true });
  await sleep(900);
}

export async function openFile(page, name) {
  await page.keyboard.press('Meta+P');
  await page.locator('.quick-input-widget input').fill(name);
  await sleep(700);
  await page.keyboard.press('Enter');
  await sleep(1200);
}

export async function scrollDashboard(page, pixels) {
  await page.mouse.move(1300, 600);
  await page.mouse.wheel(0, pixels);
  await sleep(1200);
}

/**
 * Start memory tracking on the demo's row and fold the side bar once the
 * dashboard opens. `click(locator, label)` is the act's own way of clicking.
 */
export async function trackMemory(page, click) {
  await click(await rowButton(page, 'Track Memory'), 'Track Memory');
  await awaitDashboard(page);
}

/** Wait for the memory dashboard to open, then fold the side bar away from it. */
export async function awaitDashboard(page) {
  await page.locator('.tab', { hasText: DASHBOARD }).waitFor({ timeout: 60_000 });
  await sleep(1500);
  await clickSharpLspIcon(page);
  await page.mouse.move(PARK.x, PARK.y);
}

/**
 * Toggle `title`'s editor group maximised by double-clicking its tab — no
 * palette, which a refreshing webview would close by stealing focus.
 */
export async function toggleMaximised(page, title) {
  await page.locator('.tab', { hasText: title }).first().dblclick();
  await sleep(1200);
}

export async function toggleSideBar(page) {
  await runCommand(page, 'View: Toggle Primary Side Bar Visibility');
  await sleep(800);
}

/**
 * After a CPU stop: `<prefix>-results`, the results panel maximised, and
 * `<prefix>-heatmap`, `file` maximised with its heat bars and no side bar.
 */
export async function cpuStills(page, dir, file, prefix) {
  await toggleMaximised(page, 'SharpLsp Profiler');
  await still(page, dir, `${prefix}-results`);
  await toggleMaximised(page, 'SharpLsp Profiler');
  await toggleMaximised(page, file);
  await toggleSideBar(page);
  await still(page, dir, `${prefix}-heatmap`);
  await toggleSideBar(page);
  await toggleMaximised(page, file);
}
