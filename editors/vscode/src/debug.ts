import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DEBUG_TYPE, CMD_DEBUG_PROGRAM } from './constants';
import { info } from './log';

interface LaunchProfile {
  commandName: string;
  applicationUrl?: string;
  environmentVariables?: Record<string, string>;
  commandLineArgs?: string;
}

interface LaunchSettings {
  profiles: Record<string, LaunchProfile>;
}

/**
 * Provides automatic launch configurations by discovering .csproj files
 * and integrating launchSettings.json profiles.
 */
export class SharpLspLaunchProvider implements vscode.DebugConfigurationProvider {
  public resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    // If no config provided (F5 with no launch.json), create one.
    if (config.type.length === 0 && config.request.length === 0 && config.name.length === 0) {
      config.type = DEBUG_TYPE;
      config.name = 'Launch .NET Project';
      config.request = 'launch';
      config.preLaunchTask = 'dotnet: build';
    }

    if (config.program === undefined && folder !== undefined) {
      const found = findEntryProject(folder.uri.fsPath);
      if (found !== undefined) {
        config.program = found.dll;
        config.cwd = found.cwd;
      }
    }

    // Apply launchSettings.json profile if available.
    if (folder !== undefined && config.request === 'launch') {
      applyLaunchProfile(folder.uri.fsPath, config);
    }

    // Just My Code support.
    if (config.justMyCode === undefined) {
      config.justMyCode = true;
    }

    return config;
  }

  public provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    const configs: vscode.DebugConfiguration[] = [];
    if (folder === undefined) return configs;

    // Generate configs from launchSettings.json profiles.
    const profiles = readLaunchProfiles(folder.uri.fsPath);
    for (const [name, profile] of Object.entries(profiles)) {
      if (profile.commandName !== 'Project') continue;
      const entry = findEntryProject(folder.uri.fsPath);
      if (entry === undefined) continue;

      const config: vscode.DebugConfiguration = {
        type: DEBUG_TYPE,
        request: 'launch',
        name: `Launch: ${name}`,
        program: entry.dll,
        cwd: entry.cwd,
        justMyCode: true,
      };

      if (profile.environmentVariables !== undefined) {
        config.env = profile.environmentVariables;
      }
      if (profile.commandLineArgs !== undefined && profile.commandLineArgs.length > 0) {
        config.args = profile.commandLineArgs.split(' ');
      }
      configs.push(config);
    }

    // Default config if no profiles found.
    if (configs.length === 0) {
      const entry = findEntryProject(folder.uri.fsPath);
      configs.push({
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Launch .NET Project',
        program: entry?.dll ?? '${workspaceFolder}/bin/Debug/net9.0/${workspaceFolderBasename}.dll',
        cwd: entry?.cwd ?? '${workspaceFolder}',
        justMyCode: true,
      });
    }

    return configs;
  }
}

/**
 * Spawns netcoredbg as the debug adapter process.
 */
export class SharpLspDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  public createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const netcoredbgPath = findNetcoredbg();
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

/** Apply the first `Project` profile from launchSettings.json onto a debug config. */
export function applyLaunchProfile(rootPath: string, config: vscode.DebugConfiguration): void {
  const profiles = readLaunchProfiles(rootPath);
  const entries = Object.entries(profiles);
  if (entries.length === 0) return;

  // Use the first Project profile.
  const projectProfile = entries.find(([, p]) => p.commandName === 'Project');
  if (projectProfile === undefined) return;

  const [, profile] = projectProfile;
  if (profile.environmentVariables !== undefined && config.env === undefined) {
    config.env = profile.environmentVariables;
  }
  if (
    profile.commandLineArgs !== undefined &&
    profile.commandLineArgs.length > 0 &&
    config.args === undefined
  ) {
    config.args = profile.commandLineArgs.split(' ');
  }
}

/** Read and parse launchSettings.json profiles under `rootPath/Properties`. */
export function readLaunchProfiles(rootPath: string): Record<string, LaunchProfile> {
  const candidates = [path.join(rootPath, 'Properties', 'launchSettings.json')];

  // Also check subdirectories for the first .csproj project.
  try {
    const files = fs.readdirSync(rootPath);
    const proj = files.find((f) => f.endsWith('.csproj') || f.endsWith('.fsproj'));
    if (proj !== undefined) {
      candidates.push(path.join(rootPath, 'Properties', 'launchSettings.json'));
    }
  } catch {
    // Ignore.
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (isLaunchSettings(parsed)) return parsed.profiles;
      return {};
    } catch {
      // Malformed JSON — skip.
    }
  }
  return {};
}

/** Type guard for a parsed launchSettings.json document. */
export function isLaunchSettings(value: unknown): value is LaunchSettings {
  return typeof value === 'object' && value !== null && 'profiles' in value;
}

function findNetcoredbg(): string | undefined {
  // Check user setting first.
  const configured = vscode.workspace
    .getConfiguration('sharplsp')
    .get<string>('debug.netcoredbgPath');
  if (configured !== undefined && configured.length > 0 && fs.existsSync(configured)) {
    return configured;
  }

  // Check common installation paths.
  const candidates = getNetcoredbgCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to PATH.
  return 'netcoredbg';
}

/** Platform-aware list of common netcoredbg installation paths. */
export function getNetcoredbgCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'netcoredbg.exe' : 'netcoredbg';

  return [
    path.join(home, '.dotnet', 'tools', exe),
    path.join(home, '.local', 'share', 'netcoredbg', exe),
    `/usr/local/bin/${exe}`,
    `/usr/bin/${exe}`,
    path.join(home, 'AppData', 'Local', 'netcoredbg', exe),
  ];
}

interface ProjectEntry {
  dll: string;
  cwd: string;
}

/** Find the nearest project entry by searching `rootPath` only. */
export function findEntryProject(rootPath: string): ProjectEntry | undefined {
  return findProjectFile(rootPath, rootPath);
}

/** Walk up from `startPath` to `stopPath` looking for the nearest .csproj/.fsproj. */
export function findProjectFile(startPath: string, stopPath: string): ProjectEntry | undefined {
  let current: string | undefined = startPath;
  while (current !== undefined) {
    try {
      const files = fs.readdirSync(current);
      const proj = files.find((f) => f.endsWith('.csproj') || f.endsWith('.fsproj'));
      if (proj !== undefined) {
        return projectEntryFromFile(path.join(current, proj));
      }
    } catch {
      return undefined;
    }
    if (current === stopPath) return undefined;
    const parent = path.dirname(current);
    current = parent === current ? undefined : parent;
  }
  return undefined;
}

/** Build a project entry (dll path + cwd) from a project file path. */
export function projectEntryFromFile(projFile: string): ProjectEntry {
  const dir = path.dirname(projFile);
  const name = path.basename(projFile, path.extname(projFile));
  // Prefer net10.0, fall back to net9.0, then net8.0.
  const tfms = ['net10.0', 'net9.0', 'net8.0'];
  for (const tfm of tfms) {
    const dll = path.join(dir, 'bin', 'Debug', tfm, `${name}.dll`);
    if (fs.existsSync(dll)) return { dll, cwd: dir };
  }
  // Not built yet — return net10.0 path so the error message is meaningful.
  return { dll: path.join(dir, 'bin', 'Debug', 'net10.0', `${name}.dll`), cwd: dir };
}

/**
 * Register debug adapter and launch configuration provider.
 */
export function registerDebugAdapter(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new SharpLspLaunchProvider()),
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      DEBUG_TYPE,
      new SharpLspDebugAdapterFactory(),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_DEBUG_PROGRAM, () => {
      debugCurrentProject();
    }),
  );
  info('Debug adapter registered for sharplsp-coreclr');
}

/**
 * Launch a debug session for the project containing the active editor file,
 * or the first project in the workspace if no editor is open.
 */
function debugCurrentProject(): void {
  const folder = resolveWorkspaceFolder();
  if (folder === undefined) {
    void vscode.window.showWarningMessage('No workspace folder open.');
    return;
  }

  // Start search from the active file's directory so that right-clicking inside
  // a subfolder project (e.g. tests/fixtures/ProfileTarget/Program.cs) finds
  // that project's .csproj rather than looking only at the workspace root.
  const activeDir = vscode.window.activeTextEditor?.document.uri.fsPath;
  const searchStart = activeDir !== undefined ? path.dirname(activeDir) : folder.uri.fsPath;

  const entry = findProjectFile(searchStart, folder.uri.fsPath);
  if (entry === undefined) {
    void vscode.window.showWarningMessage(
      "No .csproj or .fsproj found in this file's directory tree.",
    );
    return;
  }

  const config: vscode.DebugConfiguration = {
    type: DEBUG_TYPE,
    request: 'launch',
    name: 'Debug Program',
    program: entry.dll,
    cwd: entry.cwd,
    justMyCode: true,
  };

  void vscode.debug.startDebugging(folder, config);
}

function resolveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeFile = vscode.window.activeTextEditor?.document.uri;
  if (activeFile !== undefined) {
    const folder = vscode.workspace.getWorkspaceFolder(activeFile);
    if (folder !== undefined) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}
