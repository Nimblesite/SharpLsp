// Implements [WEB-DESIGN-MEDIA]. The set every profiler film is shot on: the
// Storefront demo staged and built at a neutral temp path, the isolated VS Code's
// Processes view and editor moves, and the real-time screencast recorder.
// capture.mjs (the profiler film) and leak.mjs (the leak walkthrough) both shoot here.
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

/** Build the staged Storefront; a failed build stops the shoot. */
export function buildStorefront(workspace) {
  const build = spawnSync('dotnet', ['build', '-c', 'Debug', '--nologo', '-v', 'q'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`Storefront build failed: ${build.stdout}`);
}

/**
 * Copy the demo to a neutral temp path and build it there, so no home-directory
 * path (the user's name) can reach a frame name or tooltip on camera.
 */
export function stageStorefront() {
  // The real path: macOS's tmpdir is a symlink the .NET runtime resolves, and
  // heat-map decorations only land when both sides spell the file the same way.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'film-'));
  const workspace = path.join(root, 'Storefront');
  fs.cpSync(path.join(here, 'storefront'), workspace, {
    recursive: true,
    filter: (source) => !['bin', 'obj', '.sharplsp'].includes(path.basename(source)),
  });
  buildStorefront(workspace);
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

/** The live Storefront's PID: its row, never a stale one from a restarted run. */
let storefrontPid = 0;

/** The demo app, restartable so a memory act starts from a fresh, small heap. */
export function storefront(workspace) {
  let app;
  return {
    start: async () => {
      app = await startStorefront(workspace);
      storefrontPid = app.pid;
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

export const storefrontRow = (page) =>
  page.getByRole('treeitem').filter({ hasText: `Storefront — StorefrontPID ${storefrontPid}` }).first();

export async function headerButton(page, name) {
  await processesHeader(page).hover();
  return processesHeader(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

export async function rowButton(page, name) {
  await storefrontRow(page).hover();
  await sleep(250);
  return storefrontRow(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

/** Wait until the Processes view lists the live Storefront row. */
export async function waitForStorefrontRow(page) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await storefrontRow(page).isVisible().catch(() => false)) return;
    await (await headerButton(page, 'Refresh Processes')).click();
    await sleep(1000);
  }
  throw new Error('Storefront never appeared in the Processes view');
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
 * Start memory tracking on the Storefront row and fold the side bar once the
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

export async function toggleSideBar(page) {
  await runCommand(page, 'View: Toggle Primary Side Bar Visibility');
  await sleep(800);
}
