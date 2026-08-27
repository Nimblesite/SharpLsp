// The VS Code run and debug surface.
//
// Implements [DEBUG-FEATURES-LAUNCH-NOCONFIG], [DEBUG-FEATURES-LAUNCH-NODEBUG],
// [DEBUG-FEATURES-LAUNCH-DYNAMIC], [DEBUG-ADAPTER-NETCOREDBG].
//
// Target resolution lives in launch-resolver.ts, output resolution in msbuild.ts,
// profile parsing in launch-profiles.ts and script dispatch in launch-run.ts —
// one resolver behind F5, Ctrl/Cmd+F5, both commands and the Solution Explorer.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CMD_DEBUG_PROGRAM, CMD_RUN_PROGRAM, DEBUG_TYPE } from './constants';
import { exeName } from './platform';
import { info, warn } from './log';
import {
  NO_TARGET_MESSAGE,
  folderFor,
  resolveLaunchTarget,
  type LaunchTarget,
  type ProjectTarget,
} from './launch-resolver';
import {
  CSX_TOOL_MESSAGE,
  FSX_DEBUG_MESSAGE,
  buildFileBasedApp,
  buildProject,
  hasDotnetScript,
  runTask,
} from './launch-run';
import {
  applyLaunchProfile,
  isLaunchSettings,
  profileArgs,
  profileEnv,
  projectProfiles,
  readLaunchProfiles,
  readProfiles,
} from './launch-profiles';
import {
  findEntryProject,
  findProjectFile,
  isWithin,
  projectEntryFromFile,
  type ProjectEntry,
} from './launch-target';

/** The name a synthesized F5 configuration carries. */
export const SYNTHESIZED_NAME = 'Launch .NET Project';

// One implementation each, re-exported so every caller — the Solution Explorer,
// the commands and the suites — shares the same resolver rather than growing a
// second, divergent walk.
export { readProfiles, readLaunchProfiles, applyLaunchProfile, isLaunchSettings };
export { findEntryProject, findProjectFile, projectEntryFromFile, type ProjectEntry };

/**
 * Fills in a debug configuration for F5 and Ctrl/Cmd+F5.
 * Spec: [DEBUG-FEATURES-LAUNCH-NOCONFIG].
 */
export class SharpLspLaunchProvider implements vscode.DebugConfigurationProvider {
  /**
   * Fill in whatever the user did not supply.
   *
   * Asynchronous on purpose: `ProviderResult` accepts a Thenable, and the target
   * a document implies can only be settled by asking MSBuild where the output is
   * ([DEBUG-FEATURES-LAUNCH-BUILD]). Guessing a path synchronously is the defect
   * this replaces.
   */
  public async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // Detect "no configuration supplied" by ABSENCE. VS Code builds this object
    // with `Object.create(null)`, so `type`/`request`/`name` are undefined and a
    // `.length` dereference throws before a session can ever start.
    if (isEmptyConfiguration(config)) {
      config.type = DEBUG_TYPE;
      config.name = SYNTHESIZED_NAME;
    }
    // `request` is typed non-optional but arrives absent on this path, so the
    // blank test — not `??=` — is what actually defaults it.
    if (isBlank(config.request)) config.request = 'launch';
    if (isBlank(config.type)) config.type = DEBUG_TYPE;
    config.justMyCode ??= true;
    config.console ??= 'integratedTerminal';

    // An explicit program is the user's decision and is never overwritten; an
    // attach request has no program at all.
    if (config.request !== 'launch' || config.program !== undefined) return config;
    if (folder === undefined) return config;
    await applyTarget(folder, config);
    return config;
  }

  /**
   * Runs after VS Code expanded every `${...}`. The last chance to refuse a
   * launch with a message the user can act on, rather than handing netcoredbg a
   * path that does not exist.
   */
  public resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (config.request !== 'launch') return config;
    const program = typeof config.program === 'string' ? config.program : '';
    if (program.length === 0) {
      void vscode.window.showWarningMessage(NO_TARGET_MESSAGE);
      return undefined;
    }
    if (!fs.existsSync(program)) {
      void vscode.window.showWarningMessage(
        `Build produced no output for ${path.basename(program)}.`,
      );
      return undefined;
    }
    return config;
  }

  public async provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<vscode.DebugConfiguration[]> {
    if (folder === undefined) return [];
    // Resolve the target ONCE per invocation, not once per profile: each
    // resolution is a filesystem walk plus an MSBuild evaluation.
    const resolved = await resolveLaunchTarget(anchorWithin(folder), folder, { choose: noPrompt });
    const target = resolved.ok ? resolved.value : undefined;
    const program = target?.kind === 'project' ? target.program : undefined;
    const cwd = target === undefined ? folder.uri.fsPath : target.cwd;
    const profiles = target === undefined ? [] : readProfiles(targetSource(target));
    const named = projectProfiles(profiles);
    if (named.length === 0) return [baseConfiguration(SYNTHESIZED_NAME, program, cwd)];
    // One configuration per profile, each carrying ITS OWN arguments and
    // environment — a generated list where every entry shares one profile's
    // values is worse than no list, because the names imply otherwise.
    return named.map((profile) => ({
      ...baseConfiguration(`Launch: ${profile.name}`, program, cwd),
      ...spreadOptional('args', profileArgs(profile)),
      ...spreadOptional('env', profileEnv(profile)),
    }));
  }
}

/** Spread helper: omit the key entirely when the value is undefined. */
function spreadOptional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** The active document's path, if an editor is focused. */
function activeFile(): string | undefined {
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

/**
 * The active document, but only when it belongs to `folder`.
 *
 * VS Code hands the provider the folder the session is scoped to, which is not
 * necessarily the one the user is looking at. Anchoring on an editor from a
 * DIFFERENT folder resolves that folder's project instead — the wrong program,
 * and a disambiguation prompt for projects the caller never asked about.
 */
function anchorWithin(folder: vscode.WorkspaceFolder): string | undefined {
  const focused = activeFile();
  if (focused === undefined) return undefined;
  return isWithin(focused, folder.uri.fsPath) ? focused : undefined;
}

/**
 * Generating configurations must never block on a QuickPick: VS Code calls
 * `provideDebugConfigurations` while building a menu, so a prompt there would
 * hang the dropdown. With several candidates the generated config simply
 * carries no program and the user picks when they launch.
 */
function noPrompt(): Thenable<vscode.QuickPickItem | undefined> {
  return Promise.resolve(undefined);
}

/**
 * Resolve the folder's target and copy it onto a configuration being filled.
 *
 * The real chooser, NOT `noPrompt`: this is the user pressing F5, so an
 * ambiguous cone or several launch profiles is a question worth asking. Only
 * `provideDebugConfigurations`, which VS Code may call unprompted to populate a
 * list, must stay silent.
 */
async function applyTarget(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
): Promise<void> {
  const resolved = await resolveLaunchTarget(anchorWithin(folder), folder);
  if (!resolved.ok) return;
  const target = resolved.value;
  if (target.kind === 'script') return;
  config.program = target.kind === 'project' ? target.program : target.file;
  config.cwd = target.cwd;
  if (target.args !== undefined && config.args === undefined) config.args = [...target.args];
  if (target.env !== undefined && config.env === undefined) config.env = { ...target.env };
}

/** True when VS Code supplied no configuration at all. */
export function isEmptyConfiguration(config: vscode.DebugConfiguration): boolean {
  return isBlank(config.type) && isBlank(config.request) && isBlank(config.name);
}

/** Absent, or present but empty — both mean "not supplied". */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** A launch configuration in the shape [DEBUG-FEATURES-LAUNCH-NOCONFIG] fixes. */
function baseConfiguration(
  name: string,
  program: string | undefined,
  cwd: string,
): vscode.DebugConfiguration {
  return {
    type: DEBUG_TYPE,
    request: 'launch',
    name,
    ...(program === undefined ? {} : { program }),
    cwd,
    console: 'integratedTerminal',
    justMyCode: true,
  };
}

/** The file a target's launch profiles belong to. */
function targetSource(target: LaunchTarget): string {
  return target.kind === 'project' ? target.projectFile : target.file;
}

/** Everything a launch needs, once a target has been turned into a program. */
export interface LaunchPlan {
  readonly configuration: vscode.DebugConfiguration;
  readonly folder: vscode.WorkspaceFolder;
}

/** Build a debug configuration for a resolved project or file-based target. */
export async function planLaunch(
  target: LaunchTarget,
  folder: vscode.WorkspaceFolder,
  noDebug: boolean,
): Promise<LaunchPlan | undefined> {
  const program = await programFor(target);
  if (program === undefined) return undefined;
  const named =
    target.kind === 'project' ? path.basename(target.projectFile) : path.basename(target.file);
  const configuration: vscode.DebugConfiguration = {
    ...baseConfiguration(`${noDebug ? 'Run' : 'Debug'} ${named}`, program, target.cwd),
    ...(target.kind === 'script' ? {} : argsAndEnv(target)),
  };
  return { configuration, folder };
}

/** The `args`/`env` a non-script target contributes. */
function argsAndEnv(target: ProjectTarget | Exclude<LaunchTarget, ProjectTarget>): object {
  if (target.kind === 'script') return {};
  return {
    ...(target.args === undefined ? {} : { args: [...target.args] }),
    ...(target.env === undefined ? {} : { env: { ...target.env } }),
  };
}

/** The assembly to debug, building the target first so its output exists. */
async function programFor(target: LaunchTarget): Promise<string | undefined> {
  if (target.kind === 'project') return await builtProgram(target);
  if (target.kind === 'script') {
    void vscode.window.showWarningMessage(FSX_DEBUG_MESSAGE);
    return undefined;
  }
  const built = await buildFileBasedApp(target.file);
  if (!built.ok) {
    void vscode.window.showWarningMessage(built.error);
    return undefined;
  }
  return built.value;
}

/**
 * Build a project, then confirm on disk that it produced what will be launched.
 *
 * [DEBUG-FEATURES-LAUNCH-BUILD] rule 3: after the build step the resolved
 * program MUST exist; if it does not, the session MUST NOT start.
 */
async function builtProgram(target: ProjectTarget): Promise<string | undefined> {
  const built = await buildProject(target.projectFile);
  const named = path.basename(target.projectFile);
  if (!built.ok) {
    void vscode.window.showWarningMessage(`Build failed for ${named}: ${built.error}`);
    return undefined;
  }
  const program = target.program;
  if (program.length > 0 && fs.existsSync(program)) return program;
  void vscode.window.showWarningMessage(`Build produced no output for ${named}.`);
  return undefined;
}

/**
 * Spawns netcoredbg as the debug adapter process. The debugger is bundled in the
 * VSIX ([DIST-DEBUGGER-BUNDLE]); `extensionPath` lets the resolver prefer that
 * bundled copy over a user-installed one.
 * Spec: [DEBUG-ADAPTER-NETCOREDBG], [DEBUG-ARCHITECTURE-NETCOREDBG].
 */
export class SharpLspDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly extensionPath?: string) {}

  public createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const netcoredbgPath = findNetcoredbg(this.extensionPath);
    if (netcoredbgPath === undefined) {
      void vscode.window.showErrorMessage(
        'netcoredbg not found. SharpLsp bundles it for this platform — reinstall the ' +
          'extension, or set sharplsp.debug.netcoredbgPath. ' +
          'Upstream: https://github.com/Samsung/netcoredbg',
      );
      return undefined;
    }
    info(`Starting netcoredbg: ${netcoredbgPath}`);
    return new vscode.DebugAdapterExecutable(netcoredbgPath, ['--interpreter=vscode']);
  }
}

/**
 * The netcoredbg the adapter factory will spawn, or undefined when there is none.
 *
 * PATH is searched properly rather than returning a bare `netcoredbg` and hoping:
 * a name that does not resolve fails later as a spawn ENOENT inside the adapter
 * process, which surfaces to the user as an unexplained failed debug session.
 * Refusing here lets the factory say what is actually wrong.
 */
export function findNetcoredbg(extensionPath?: string): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('sharplsp')
    .get<string>('debug.netcoredbgPath');
  if (configured !== undefined && configured.length > 0 && fs.existsSync(configured)) {
    return configured;
  }
  for (const candidate of getNetcoredbgCandidates(extensionPath)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // The only route on platforms with no upstream prebuilt (win32-arm64,
  // darwin-x64), where the VSIX cannot bundle a debugger.
  return findOnPath(exeName('netcoredbg'));
}

/** Resolve `name` against PATH, honouring PATHEXT on Windows. */
function findOnPath(name: string): string | undefined {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions = process.platform === 'win32' ? ['', ...windowsPathExt()] : [''];
  for (const dir of entries) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The executable suffixes Windows treats as runnable. */
function windowsPathExt(): string[] {
  return (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Platform-aware netcoredbg search paths, most-preferred first. When
 * `extensionPath` is supplied, the VSIX-bundled binary
 * (`bin/<platform>/netcoredbg/netcoredbg[.exe]`, staged by
 * `tools/vsix/fetch-netcoredbg.sh`) is preferred over any user-installed copy.
 */
export function getNetcoredbgCandidates(extensionPath?: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'netcoredbg.exe' : 'netcoredbg';

  const candidates: string[] = [];
  if (extensionPath !== undefined && extensionPath.length > 0) {
    candidates.push(
      path.join(extensionPath, 'bin', `${process.platform}-${process.arch}`, 'netcoredbg', exe),
    );
  }
  candidates.push(
    path.join(home, '.dotnet', 'tools', exe),
    path.join(home, '.local', 'share', 'netcoredbg', exe),
    `/usr/local/bin/${exe}`,
    `/usr/bin/${exe}`,
    path.join(home, 'AppData', 'Local', 'netcoredbg', exe),
  );
  return candidates;
}

/** A project the Solution Explorer passed to a run/debug command. */
interface ExplorerNode {
  readonly projectFilePath?: string;
}

/** Register the adapter, the configuration providers and both commands. */
export function registerDebugAdapter(context: vscode.ExtensionContext): void {
  const provider = new SharpLspLaunchProvider();
  context.subscriptions.push(
    // Both trigger kinds: `Initial` fills a generated launch.json, `Dynamic`
    // puts SharpLsp in the "Show all automatic debug configurations" dropdown.
    vscode.debug.registerDebugConfigurationProvider(
      DEBUG_TYPE,
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Initial,
    ),
    vscode.debug.registerDebugConfigurationProvider(
      DEBUG_TYPE,
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
    vscode.debug.registerDebugAdapterDescriptorFactory(
      DEBUG_TYPE,
      new SharpLspDebugAdapterFactory(context.extensionPath),
    ),
    vscode.commands.registerCommand(CMD_DEBUG_PROGRAM, async (node?: ExplorerNode) => {
      await launch(node, false);
    }),
    vscode.commands.registerCommand(CMD_RUN_PROGRAM, async (node?: ExplorerNode) => {
      await launch(node, true);
    }),
  );
  info('Debug adapter registered for sharplsp-coreclr');
}

/** Resolve the active context and run or debug it. */
export async function launch(node: ExplorerNode | undefined, noDebug: boolean): Promise<void> {
  const focused = activeFile();
  const anchor = node?.projectFilePath ?? focused;
  const folder = folderFor(anchor);
  if (folder === undefined) {
    void vscode.window.showWarningMessage(NO_TARGET_MESSAGE);
    return;
  }
  const resolved = await resolveLaunchTarget(focused, folder, {
    ...(node?.projectFilePath === undefined ? {} : { projectFile: node.projectFilePath }),
  });
  if (!resolved.ok) {
    // An empty error is a user cancellation — already silent by choice.
    if (resolved.error.length > 0) void vscode.window.showWarningMessage(resolved.error);
    return;
  }
  await dispatch(resolved.value, folder, noDebug);
}

/** Send a resolved target to the runner or the debugger. */
async function dispatch(
  target: LaunchTarget,
  folder: vscode.WorkspaceFolder,
  noDebug: boolean,
): Promise<void> {
  if (noDebug && target.kind !== 'project') {
    await runWithoutDebugger(target, folder);
    return;
  }
  const plan = await planLaunch(target, folder, noDebug);
  if (plan === undefined) return;
  const started = await vscode.debug.startDebugging(plan.folder, plan.configuration, { noDebug });
  if (!started) {
    warn(`startDebugging refused ${plan.configuration.name}`);
    void vscode.window.showWarningMessage(`Could not start ${plan.configuration.name}.`);
  }
}

/** Run a script or file-based app as a task, with no adapter involved. */
async function runWithoutDebugger(
  target: LaunchTarget,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  if (target.kind === 'project') return;
  if (target.kind === 'script' && target.runner === 'dotnet-script' && !(await hasDotnetScript())) {
    void vscode.window.showWarningMessage(CSX_TOOL_MESSAGE);
    return;
  }
  await vscode.tasks.executeTask(runTask(target, folder));
}
