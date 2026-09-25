import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { info } from './log';
import { getErrorMessage } from './utils';

/**
 * NuGet package management: search, add, update packages.
 */

const NUGET_SEARCH_URL = 'https://azuresearch-usnc.nuget.org/query';

interface NuGetSearchResult {
  data: NuGetPackage[];
}

/** Type guard for the NuGet search API response: an object with an array `data` field. */
export function isNuGetSearchResult(value: unknown): value is NuGetSearchResult {
  return (
    value !== null && typeof value === 'object' && 'data' in value && Array.isArray(value.data)
  );
}

interface NuGetPackage {
  id: string;
  version: string;
  description: string;
  totalDownloads: number;
}

/**
 * Search NuGet.org, let the user pick a package, and add it to the project
 * `target` names — or asks for, only once a package has been chosen.
 */
async function searchAndAdd(target: string | (() => Promise<string | undefined>)): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: 'Search NuGet packages',
    placeHolder: 'e.g. Newtonsoft.Json',
  });
  if (query === undefined || query === '') {
    return;
  }

  try {
    const pick = await pickPackage(await searchNuGet(query));
    const projectFile =
      pick === undefined ? undefined : typeof target === 'string' ? target : await target();
    if (pick === undefined || projectFile === undefined) {
      return;
    }
    await addPackageToProject(projectFile, pick.id, pick.version);
    void vscode.window.showInformationMessage(`Added ${pick.id} ${pick.version}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`NuGet search failed: ${getErrorMessage(err)}`);
  }
}

/** The package the user picks from `packages`, or undefined (with a notice when there were none). */
async function pickPackage(packages: NuGetPackage[]): Promise<NuGetPackage | undefined> {
  if (packages.length === 0) {
    void vscode.window.showInformationMessage('No packages found.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    packages.map((p) => ({
      label: p.id,
      description: p.version,
      detail: p.description,
      package: p,
    })),
    { placeHolder: 'Select a package to add' },
  );
  return pick?.package;
}

/** Search NuGet.org for packages and let the user pick one, then the project to add it to. */
export async function addNuGetPackage(): Promise<void> {
  await searchAndAdd(pickProjectFile);
}

/**
 * Update a NuGet package in a project.
 */
export async function updateNuGetPackage(): Promise<void> {
  const projectFile = await pickProjectFile();
  if (projectFile === undefined) {
    return;
  }

  const packageName = await vscode.window.showInputBox({
    prompt: 'Package name to update',
  });
  if (packageName === undefined || packageName === '') {
    return;
  }

  try {
    await runDotnet(['add', projectFile, 'package', packageName]);
    void vscode.window.showInformationMessage(`Updated ${packageName}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Update failed: ${getErrorMessage(err)}`);
  }
}

/** Restore NuGet packages for all projects. */
export async function restorePackages(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder === undefined) {
    void vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  try {
    await runDotnet(['restore']);
    void vscode.window.showInformationMessage('NuGet packages restored.');
    info('NuGet restore completed');
  } catch (err) {
    void vscode.window.showErrorMessage(`Restore failed: ${getErrorMessage(err)}`);
  }
}

/** Add NuGet package from explorer context (project node). */
export async function addNuGetPackageToProject(projectPath: string): Promise<void> {
  await searchAndAdd(projectPath);
}

/** Whether prerelease packages should be included in NuGet searches (config-driven, defaults false). */
export function includePrerelease(): boolean {
  return (
    vscode.workspace.getConfiguration('sharplsp').get<boolean>('nuget.includePrerelease') ?? false
  );
}

async function searchNuGet(query: string): Promise<NuGetPackage[]> {
  const prerelease = includePrerelease();
  const url = `${NUGET_SEARCH_URL}?q=${encodeURIComponent(query)}&take=20&prerelease=${String(prerelease)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NuGet API returned ${String(response.status)}`);
  }
  const json: unknown = await response.json();
  if (!isNuGetSearchResult(json)) {
    throw new Error('Unexpected NuGet API response shape');
  }
  return json.data;
}

async function pickProjectFile(): Promise<string | undefined> {
  const files = await vscode.workspace.findFiles('**/*.{csproj,fsproj}', '**/node_modules/**');
  if (files.length === 0) {
    void vscode.window.showWarningMessage('No .csproj/.fsproj files found.');
    return undefined;
  }
  if (files.length === 1) {
    return files[0]?.fsPath;
  }

  const pick = await vscode.window.showQuickPick(
    files.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f })),
    { placeHolder: 'Select project' },
  );
  return pick?.uri.fsPath;
}

async function addPackageToProject(
  projectFile: string,
  packageId: string,
  version: string,
): Promise<void> {
  await runDotnet(['add', projectFile, 'package', packageId, '--version', version]);
  info(`Added ${packageId}@${version} to ${projectFile}`);
}

async function runDotnet(args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile('dotnet', args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr !== '' ? stderr : error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Register NuGet commands.
 */
export function registerNuGetCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sharplsp.nuget.add', addNuGetPackage),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('sharplsp.nuget.update', updateNuGetPackage),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('sharplsp.nuget.restore', restorePackages),
  );
  info('NuGet commands registered');
}
