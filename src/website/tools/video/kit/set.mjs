// Implements [WEB-DESIGN-MEDIA]. The set a film is shot on: a demo app from
// demos/, staged and built at a neutral temp path and run beside an isolated
// VS Code. Every film, whatever its story, is shot through onSet.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH, launchVsCode, repoRoot } from './editor.mjs';

const demos = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demos');

/**
 * The demo apps under demos/: a folder holding one project, run from its build
 * output. The C# Storefront and its F# twin check out orders forever, with real
 * hot paths and a cache that never evicts.
 */
export const STOREFRONT = { folder: 'storefront', project: 'Storefront' };
export const FS_STOREFRONT = { folder: 'fs-storefront', project: 'FsStorefront' };

/**
 * Both demos in one workspace under Shop.slnx, the language films' set: C# and
 * F# side by side in one solution. Each demo's own solution is left out, so the
 * workspace holds exactly one, and nothing runs.
 */
export const SHOP = { folder: '.', project: 'Shop', omit: ['Storefront.slnx', 'FsStorefront.slnx'], runs: false };

/**
 * The Blazor Web App the Razor film is shot on: a basket page whose markup and
 * `@code` block share one C# engine. Nothing runs. It keeps the repository's
 * SDK pin, because the Razor generator comes from the SDK that builds it and
 * must match the Roslyn the sidecar bundles (#399).
 */
export const BLAZOR_STOREFRONT = { folder: 'blazor-storefront', project: 'BlazorStorefront', runs: false, pinSdk: true };

/** `git archive` of HEAD in `repo`, unpacked into `into`: the committed tree, nothing local. */
function unpackHead(repo, into) {
  fs.mkdirSync(into, { recursive: true });
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error(`git archive of ${repo} failed: ${archive.stderr}`);
  const unpack = spawnSync('tar', ['-x', '-C', into], { input: archive.stdout });
  if (unpack.status !== 0) throw new Error(`unpacking ${repo} failed: ${unpack.stderr}`);
}

/**
 * The SharpLsp repository itself, the contributors' film's set: its committed
 * tree and lspkit's, staged at a neutral path, opened without the extension
 * (its own sidecar solutions are not the subject), with nothing run.
 */
export const REPO = {
  project: 'SharpLsp',
  runs: false,
  disabled: ['nimblesite.sharplsp'],
  stage: () => {
    const root = fs.mkdtempSync(path.join(SCRATCH, 'film-'));
    const workspace = path.join(root, 'SharpLsp');
    unpackHead(repoRoot, workspace);
    unpackHead(path.join(repoRoot, 'lspkit'), path.join(workspace, 'lspkit'));
    return { root, workspace };
  },
};

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
  // The real path: macOS's /tmp is a symlink the .NET runtime resolves, and
  // heat-map decorations only land when both sides spell the file the same way.
  const root = fs.mkdtempSync(path.join(SCRATCH, 'film-'));
  const workspace = path.join(root, demo.project);
  fs.cpSync(path.join(demos, demo.folder), workspace, {
    recursive: true,
    filter: (source) => !['bin', 'obj', '.sharplsp', ...(demo.omit ?? [])].includes(path.basename(source)),
  });
  if (demo.pinSdk) fs.copyFileSync(path.join(repoRoot, 'global.json'), path.join(workspace, 'global.json'));
  buildDemo(workspace);
  return { root, workspace };
}

/**
 * Start the demo by absolute path (discovery needs it) and wait for its banner.
 * It shares the editor's temp folder, where .NET opens the diagnostics socket
 * the profiler attaches through.
 */
async function startDemo(workspace) {
  const project = path.basename(workspace);
  const env = { ...process.env, TMPDIR: `${SCRATCH}/` };
  const app = spawn(path.join(workspace, `bin/Debug/net10.0/${project}`), [], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'ignore'] });
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
 * shoot leaves `<out>/failure.png` and the editor's `<out>/logs`; the app, the
 * editor and the staged copy always go.
 */
export async function onSet({ demo, out, settings }, shoot) {
  const { root, workspace } = (demo.stage ?? stageDemo)(demo);
  if (settings) writeSettings(workspace, settings);
  const editor = await launchVsCode({ workspace, disabled: demo.disabled });
  const app = demo.runs === false ? { start: async () => undefined, stop: () => undefined } : demoApp(workspace);
  await app.start();
  try {
    await shoot({ page: editor.page, cdp: editor.cdp, app, workspace });
  } catch (error) {
    await editor.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => undefined);
    fs.cpSync(editor.logs, path.join(out, 'logs'), { recursive: true });
    throw error;
  } finally {
    app.stop();
    await editor.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
