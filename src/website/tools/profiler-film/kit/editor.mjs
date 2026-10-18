// Implements [WEB-DESIGN-MEDIA]. The isolated VS Code the profiler film is shot in: the build @vscode/test-electron
// downloaded for the e2e suites, a throwaway user-data and extensions dir with the
// PACKAGED SharpLsp VSIX installed (the extension users get, not a dev host), and
// a CDP port Playwright drives. It never touches the user's own VS Code.
// Prerequisite: `make _build-vsix VSIX_PREBUILT=1` (writes dist/sharplsp.vsix).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../../../..');
const testHome = path.join(repoRoot, 'src/editors/vscode/.vscode-test');
const vsix = path.join(repoRoot, 'dist/sharplsp.vsix');
const RUNTIME_EXTENSION = 'ms-dotnettools.vscode-dotnet-runtime';

/** The editor settings every shot is filmed with: one theme, no clutter. */
const FILM_SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.editor.enablePreview': false,
  'workbench.editor.doubleClickTabToToggleEditorGroupSizes': 'maximize',
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'window.commandCenter': true,
  'window.restoreWindows': 'none',
  'window.title': '${rootName}',
  'editor.fontSize': 15,
  'editor.lineHeight': 24,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'editor.inlayHints.enabled': 'off',
  'editor.codeLens': false,
  'editor.lightbulb.enabled': 'off',
  'editor.cursorBlinking': 'solid',
  'editor.renderLineHighlight': 'none',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'extensions.autoCheckUpdates': false,
  'security.workspace.trust.enabled': false,
  'git.enabled': false,
  // The memory timeline grows on camera: a snapshot every few seconds while tracking.
  'sharplsp.profiler.autoSnapshot': true,
  'sharplsp.profiler.autoSnapshotInterval': 3,
};

/** The newest VS Code build the e2e harness downloaded. */
function vscodeApp() {
  const build = fs
    .readdirSync(testHome)
    .filter((name) => name.startsWith(`vscode-${process.platform}`))
    .sort()
    .at(-1);
  if (!build) throw new Error(`no VS Code under ${testHome}: run the VSIX suite once`);
  return path.join(testHome, build, 'Visual Studio Code.app/Contents');
}

/**
 * The environment the editor starts in. A terminal inside VS Code exports
 * ELECTRON_RUN_AS_NODE, which turns the editor binary into plain Node; the
 * SHARPLSP_* path overrides would point the extension away from the VSIX.
 */
function editorEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('VSCODE_') || key.startsWith('SHARPLSP_')) {
      delete env[key];
    }
  }
  return env;
}

/** A short scratch root (the main IPC socket path must stay under ~104 chars). */
function freshProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-film-'));
  const userData = path.join(root, 'u');
  const extensions = path.join(root, 'x');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify(FILM_SETTINGS));
  installExtensions(extensions, userData);
  return { root, userData, extensions };
}

/**
 * Seed the extensions dir with the harness's (it holds the runtime-acquisition
 * dependency the extension declares), then install the packaged VSIX on top.
 */
function installExtensions(extensions, userData) {
  if (!fs.existsSync(vsix)) throw new Error(`${vsix} missing: run make _build-vsix VSIX_PREBUILT=1`);
  const seeded = fs.readdirSync(path.join(testHome, 'extensions'));
  if (!seeded.some((name) => name.startsWith(RUNTIME_EXTENSION))) {
    throw new Error(`${RUNTIME_EXTENSION} missing under ${testHome}: run the VSIX suite once`);
  }
  fs.cpSync(path.join(testHome, 'extensions'), extensions, { recursive: true });
  const result = spawnSync(
    path.join(vscodeApp(), 'Resources/app/bin/code'),
    ['--extensions-dir', extensions, '--user-data-dir', userData, '--install-extension', vsix],
    { env: editorEnv(), encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`installing ${vsix} failed: ${result.stderr}`);
}

async function waitForCdp(port) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`VS Code never opened CDP port ${port}`);
}

async function workbenchPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      if (await page.locator('.monaco-workbench').isVisible().catch(() => false)) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('VS Code workbench never rendered');
}

/**
 * Pin the workbench to one frame at 2x. Electron has no window-bounds CDP, so
 * the viewport is emulated: the layout, every screenshot and every screencast
 * frame share this size whatever the OS window does.
 */
async function frameWindow(page, width, height) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  return cdp;
}

/**
 * Start the isolated editor on `workspace` and hand back the workbench page.
 * `close()` ends only the process this module spawned.
 */
export async function launchVsCode({ workspace, port = 9241, width = 1600, height = 1000 }) {
  const profile = freshProfile();
  const child = spawnEditor(profile, workspace, port);
  await waitForCdp(port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await workbenchPage(browser);
  const cdp = await frameWindow(page, width, height);
  return { page, cdp, close: () => closeEditor(browser, child, profile) };
}

function spawnEditor(profile, workspace, port) {
  const args = [
    `--extensions-dir=${profile.extensions}`,
    `--user-data-dir=${profile.userData}`,
    `--remote-debugging-port=${port}`,
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--new-window',
    workspace,
  ];
  return spawn(path.join(vscodeApp(), 'MacOS/Code'), args, { stdio: 'ignore', env: editorEnv() });
}

/** Disconnect, end only the editor this module spawned, then drop its profile. */
async function closeEditor(browser, child, profile) {
  await browser.close().catch(() => undefined);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
  fs.rmSync(profile.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

/** Run a workbench command by its exact palette label (clicks that row; never a fuzzy top hit). */
export async function runCommand(page, label) {
  // The title-bar command center, not a shortcut: a focused webview swallows keys.
  await page.locator('.command-center .command-center-center').click();
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible' });
  await input.fill(`>${label}`);
  await page.waitForTimeout(350);
  const rows = page.locator('.quick-input-list .monaco-list-row');
  const labels = (await rows.locator('.label-name').allInnerTexts()).map((text) => text.trim());
  const index = labels.indexOf(label);
  if (index < 0) {
    await page.keyboard.press('Escape');
    throw new Error(`no palette entry "${label}" in ${JSON.stringify(labels)}`);
  }
  await rows.nth(index).click();
  await page.waitForTimeout(400);
}
