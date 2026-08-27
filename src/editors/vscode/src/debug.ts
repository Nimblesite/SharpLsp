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
  hasDotnetScript,
  runTask,
} from './launch-run';
import { applyLaunchProfile, isLaunchSettings, readLaunchProfiles, readProfiles } from './launch-profiles';
import {
  findEntryProject,
  findProjectFile,
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
  public resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    // Detect "no configuration supplied" by ABSENCE. VS Code builds this object
    // with `Object.create(null)`, so `type`/`request`/`name` are undefined and a
    // `.length` dereference throws before a session can ever start.
    if (isEmptyConfiguration(config)) {
      config.type = DEBUG_TYPE;
      config.name = SYNTHESIZED_NAME;
      config.request = 'launch';
    }
    config.request ??= 'launch';
    config.justMyCode ??= true;
    config.console ??= 'integratedTerminal';

    if (config.program === undefined && folder !== undefined) {
      applyResolvedTarget(folder, config);
    }
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
      void vscode.window.showWarningMessage(`Build produced no output for ${path.basename(program)}.`);
      return undefined;
    }
    return config;
  }

  public provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    if (folder === undefined) return [];
    const cached = lastTargetFor(folder);
    const program = cached?.kind === 'project' ? cached.program : undefined;
    const cwd = cached?.kind === 'project' ? cached.cwd : folder.uri.fsPath;
    const profiles = cached === undefined ? [] : readProfiles(targetSource(cached));
    const named = profiles.filter((profile) => profile.commandName === 'Project');
    if (named.length === 0) return [baseConfiguration(SYNTHESIZED_NAME, program, cwd)];
    return named.map((profile) => baseConfiguration(`Launch: ${profile.name}`, program, cwd));
  }
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

/**
 * The most recent target resolved for a folder.
 *
 * `resolveDebugConfiguration` is synchronous by contract while target resolution
 * shells out to MSBuild, so the commands — which ARE async — resolve first and
 * leave the answer here for the provider to reuse. A cold F5 with no prior
 * command still resolves through `resolveDebugConfigurationWithSubstitutedVariables`.
 */
const lastTargets = new Map<string, LaunchTarget>();

function lastTargetFor(folder: vscode.WorkspaceFolder): LaunchTarget | undefined {
  return lastTargets.get(folder.uri.fsPath);
}

/** Remember the target a command resolved, keyed by workspace folder. */
export function rememberTarget(folder: vscode.WorkspaceFolder, target: LaunchTarget): void {
  lastTargets.set(folder.uri.fsPath, target);
}

/** Copy a remembered target onto a configuration the provider is filling in. */
function applyResolvedTarget(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
): void {
  const target = lastTargetFor(folder);
  if (target === undefined || target.kind === 'script') return;
  config.program = target.kind === 'project' ? target.program : target.file;
  config.cwd = target.cwd;
  if (target.args !== undefined && config.args === undefined) config.args = [...target.args];
  if (target.env !== undefined && config.env === undefined) config.env = { ...target.env };
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
  const named = target.kind === 'project' ? path.basename(target.projectFile) : path.basename(target.file);
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

/** The assembly to debug, building a file-based app first when needed. */
async function programFor(target: LaunchTarget): Promise<string | undefined> {
  if (target.kind === 'project') return target.program;
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
        'netcoredbg not found. Install it: https://github.com/Samsung/netcoredbg',
      );
      return undefined;
    }
    info(`Starting netcoredbg: ${netcoredbgPath}`);
    return new vscode.DebugAdapterExecutable(netcoredbgPath, ['--interpreter=vscode']);
  }
}

function findNetcoredbg(extensionPath?: string): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('sharplsp')
    .get<string>('debug.netcoredbgPath');
  if (configured !== undefined && configured.length > 0 && fs.existsSync(configured)) {
    return configured;
  }
  for (const candidate of getNetcoredbgCandidates(extensionPath)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Last resort on the platforms with no upstream prebuilt (win32-arm64,
  // darwin-x64), where the VSIX cannot bundle netcoredbg.
  return 'netcoredbg';
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
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const anchor = node?.projectFilePath ?? activeFile;
  const folder = folderFor(anchor);
  if (folder === undefined) {
    void vscode.window.showWarningMessage(NO_TARGET_MESSAGE);
    return;
  }
  const resolved = await resolveLaunchTarget(activeFile, folder, {
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
  rememberTarget(folder, target);
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
