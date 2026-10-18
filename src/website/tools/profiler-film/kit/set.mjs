// Implements [WEB-DESIGN-MEDIA]. The set a film is shot on: a demo app from
// demos/, staged and built at a neutral temp path and run beside an isolated
// VS Code. Every film, whatever its story, is shot through onSet.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchVsCode } from './editor.mjs';

const demos = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demos');

/**
 * The demo apps under demos/: a folder holding one project, run from its build
 * output. The C# Storefront and its F# twin check out orders forever, with real
 * hot paths and a cache that never evicts.
 */
export const STOREFRONT = { folder: 'storefront', project: 'Storefront' };
export const FS_STOREFRONT = { folder: 'fs-storefront', project: 'FsStorefront' };

/** Build the staged demo; a failed build stops the shoot. */
export function buildDemo(workspace) {
  const build = spawnSync('dotnet', ['build', '-c', 'Debug', '--nologo', '-v', 'q'], { cwd: workspace, encoding: 'utf8' });
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
  fs.cpSync(path.join(demos, demo.folder), workspace, {
    recursive: true,
    filter: (source) => !['bin', 'obj', '.sharplsp'].includes(path.basename(source)),
  });
  buildDemo(workspace);
  return { root, workspace };
}

/** Start the demo by absolute path (discovery needs it) and wait for its banner. */
async function startDemo(workspace) {
  const project = path.basename(workspace);
  const app = spawn(path.join(workspace, `bin/Debug/net10.0/${project}`), [], { cwd: workspace, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    app.stdout.once('data', resolve);
    app.once('exit', (code) => reject(new Error(`${project} exited with ${code}`)));
  });
  return app;
}

/** The live demo's PID: its row, never a stale one from a restarted run. */
let livePid = 0;

export const demoPid = () => livePid;

/** The staged demo app, restartable so a memory act starts from a fresh, small heap. */
export function demoApp(workspace) {
  let app;
  return {
    start: async () => {
      app = await startDemo(workspace);
      livePid = app.pid;
    },
    stop: () => app?.kill(),
  };
}

function writeSettings(workspace, settings) {
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify(settings));
}

/**
 * Stage `demo` with optional workspace `settings`, open it in an isolated VS Code
 * beside the running app, and run `shoot({ page, cdp, app, workspace })`. A failed
 * take leaves `<out>/failure.png`; the app, the editor and the staged copy always go.
 */
export async function onSet({ demo, out, settings }, shoot) {
  const { root, workspace } = stageDemo(demo);
  if (settings) writeSettings(workspace, settings);
  const editor = await launchVsCode({ workspace });
  const app = demoApp(workspace);
  await app.start();
  try {
    await shoot({ page: editor.page, cdp: editor.cdp, app, workspace });
  } catch (error) {
    await editor.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    app.stop();
    await editor.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
