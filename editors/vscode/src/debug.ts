import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DEBUG_TYPE } from './constants';
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
export class ForgeLaunchProvider implements vscode.DebugConfigurationProvider {
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
export class ForgeDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
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

function applyLaunchProfile(rootPath: string, config: vscode.DebugConfiguration): void {
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

function readLaunchProfiles(rootPath: string): Record<string, LaunchProfile> {
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

function isLaunchSettings(value: unknown): value is LaunchSettings {
  return typeof value === 'object' && value !== null && 'profiles' in value;
}

function findNetcoredbg(): string | undefined {
  // Check user setting first.
  const configured = vscode.workspace.getConfiguration('forge').get<string>('debug.netcoredbgPath');
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

function getNetcoredbgCandidates(): string[] {
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

function findEntryProject(rootPath: string): ProjectEntry | undefined {
  try {
    const files = fs.readdirSync(rootPath);
    const csproj = files.find((f) => f.endsWith('.csproj') || f.endsWith('.fsproj'));
    if (csproj === undefined) {
      return undefined;
    }

    const projectName = path.basename(csproj, path.extname(csproj));
    const dll = path.join(rootPath, 'bin', 'Debug', 'net9.0', `${projectName}.dll`);
    return { dll, cwd: rootPath };
  } catch {
    return undefined;
  }
}

/**
 * Register debug adapter and launch configuration provider.
 */
export function registerDebugAdapter(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new ForgeLaunchProvider()),
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new ForgeDebugAdapterFactory()),
  );
  info('Debug adapter registered for forge-coreclr');
}
