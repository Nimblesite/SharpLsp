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
import { findNetcoredbg, getNetcoredbgCandidates } from './netcoredbg';
import { info, warn } from './log';
import { DapRouter } from './dap-router';
import { resolveAttachTarget } from './attach-target';
import {
  NO_TARGET_MESSAGE,
  folderFor,
  resolveLaunchTarget,
  type LaunchTarget,
  type ProjectTarget,
} from './launch-resolver';
import {
  CSX_TOOL_MESSAGE,
  buildFileBasedApp,
  buildProject,
  hasDotnetScript,
  runTask,
  scriptDebugMessage,
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
export { findNetcoredbg, getNetcoredbgCandidates };

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
    // A cancelled pick is a decision, not a failure: returning `undefined` aborts
    // the launch silently, which is exactly what VS Code's contract asks for.
    // Returning the configuration instead starts a session with no program.
    if ((await applyTarget(folder, config)) === 'cancelled') return undefined;
    return config;
  }

  /**
   * Runs after VS Code expanded every `${...}`. The last chance to refuse a
   * launch with a message the user can act on, rather than handing netcoredbg a
   * path that does not exist.
   */
  public async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // An attach names a process, not a program. netcoredbg reads only
    // `processId`, so a `processName` must be resolved here and a pid that no
    // longer exists refused here — [DEBUG-FEATURES-LAUNCH]'s two attach rows.
    if (config.request === 'attach') return await settleAttach(config);
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

/**
 * Resolve an attach configuration onto a live pid, or refuse it out loud.
 *
 * Exactly one message per refusal: [DEBUG-FEATURES-LAUNCH-SCRIPT] rule 6 makes
 * a silent no-op non-conforming, and returning `undefined` is what makes
 * `startDebugging` answer `false` instead of opening a session onto nothing.
 */
async function settleAttach(
  config: vscode.DebugConfiguration,
): Promise<vscode.DebugConfiguration | undefined> {
  const outcome = await resolveAttachTarget(config);
  if (outcome === undefined) return config;
  if (outcome.kind === 'refused') {
    void vscode.window.showWarningMessage(outcome.reason);
    return undefined;
  }
  // A fresh object rather than a mutation: `config` was captured before the
  // process listing was awaited, and writing back onto it after the await is
  // exactly the stale-state hazard `require-atomic-updates` names.
  return { ...config, processId: outcome.processId };
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

/** What resolving the folder's target did to the configuration being filled. */
type TargetOutcome = 'applied' | 'cancelled' | 'unresolved';

/**
 * Resolve the folder's target, BUILD it, and copy it onto a configuration.
 *
 * The real chooser, NOT `noPrompt`: this is the user pressing F5, so an
 * ambiguous cone or several launch profiles is a question worth asking. Only
 * `provideDebugConfigurations`, which VS Code may call unprompted to populate a
 * list, must stay silent.
 *
 * The build is what makes the answer honest. MSBuild reports a `TargetPath` for
 * a project that was never compiled, so writing it straight onto the
 * configuration hands netcoredbg a path that does not exist
 * ([DEBUG-FEATURES-LAUNCH-BUILD] rule 3: an existing assembly, or nothing).
 */
async function applyTarget(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
): Promise<TargetOutcome> {
  const resolved = await resolveLaunchTarget(anchorWithin(folder), folder);
  // An empty error is a user cancellation — already silent by choice.
  if (!resolved.ok) return resolved.error.length === 0 ? 'cancelled' : 'unresolved';
  const target = resolved.value;
  if (target.kind === 'script') return 'unresolved';
  const program = await programFor(target);
  if (program === undefined) return 'unresolved';
  config.program = program;
  config.cwd = target.cwd;
  if (target.args !== undefined && config.args === undefined) config.args = [...target.args];
  if (target.env !== undefined && config.env === undefined) config.env = { ...target.env };
  return 'applied';
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
    void vscode.window.showWarningMessage(scriptDebugMessage(target.runner));
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
    // Routed, not spawned directly: [DEBUG-ARCHITECTURE-ROUTER] makes the proxy
    // layer responsible for capability augmentation and async stack enrichment,
    // and a bare `DebugAdapterExecutable` gives VS Code netcoredbg's raw wire
    // with none of it.
    return new vscode.DebugAdapterInlineImplementation(new DapRouter(netcoredbgPath));
  }
}

/** A project the Solution Explorer passed to a run/debug command. */
interface ExplorerNode {
  readonly projectFilePath?: string;
}

/**
 * What a run/debug command invocation can name.
 *
 * The Solution Explorer passes its tree node; `editor/context` and
 * `editor/title/run` pass the editor's resource `Uri`. Both are the user
 * pointing at something specific, and [DEBUG-FEATURES-LAUNCH-TARGET] routes
 * every surface through one resolver — so a `Uri` argument must be READ, not
 * dropped in favour of `activeTextEditor`. Dropping it launches whatever editor
 * happens to be focused, which is a different file whenever the editor group
 * that was clicked is not the active one.
 */
type LaunchArgument = ExplorerNode | vscode.Uri | undefined;

/** The project a Solution Explorer node named, if it named one. */
function namedProject(argument: LaunchArgument): string | undefined {
  return argument instanceof vscode.Uri ? undefined : argument?.projectFilePath;
}

/** The document a menu invocation named, if it named one. */
function namedResource(argument: LaunchArgument): string | undefined {
  return argument instanceof vscode.Uri ? argument.fsPath : undefined;
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
    vscode.commands.registerCommand(CMD_DEBUG_PROGRAM, async (argument?: LaunchArgument) => {
      await launch(argument, false);
    }),
    vscode.commands.registerCommand(CMD_RUN_PROGRAM, async (argument?: LaunchArgument) => {
      await launch(argument, true);
    }),
  );
  info('Debug adapter registered for sharplsp-coreclr');
}

/** Resolve the named or active context and run or debug it. */
export async function launch(argument: LaunchArgument, noDebug: boolean): Promise<void> {
  const projectFile = namedProject(argument);
  // An explicitly named resource wins over the focused editor; they differ
  // whenever the click landed on an editor group that is not the active one.
  const document = namedResource(argument) ?? activeFile();
  const folder = folderFor(projectFile ?? document);
  if (folder === undefined) {
    void vscode.window.showWarningMessage(NO_TARGET_MESSAGE);
    return;
  }
  const resolved = await resolveLaunchTarget(document, folder, {
    ...(projectFile === undefined ? {} : { projectFile }),
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
