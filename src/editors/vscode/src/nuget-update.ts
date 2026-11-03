// Bounded update interaction for [NUGET-REQUESTS-UPDATE-BOUNDS] and
// [NUGET-REQUESTS-UPDATE-CONFIRM]. All package knowledge and mutation stays in the host.
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import * as log from './log.js';
import { extensionOf, fileNameOf, samePath } from './paths.js';
import { fetchInstalled, fetchUpdatePreview, installPackage } from './nuget-browser/lsp.js';
import {
  updateKey,
  type LoadingKey,
  type NuGetTarget,
  type NuGetUpdatePreview,
} from './nuget-browser/types.js';

/** Preview and confirm an exact explicit-picker version, including opt-in boundaries. */
export async function runExplicitVersionUpdate(
  lsp: LanguageClient,
  target: NuGetTarget,
  packageId: string,
  selectedVersion: string,
): Promise<boolean> {
  const preview = await fetchUpdatePreview(lsp, target, packageId, selectedVersion);
  if (!preview.ok) return updateError(packageId, preview.error);
  return await confirmAndApply(lsp, preview.value);
}

/** Run a browser update with its reactive spinner, then let the panel reload. */
export async function runBrowserUpdate(
  lsp: LanguageClient,
  target: NuGetTarget,
  packageId: string,
  selectedVersion: string | undefined,
  loading: Set<LoadingKey>,
  render: () => void,
): Promise<boolean> {
  const key = updateKey(packageId);
  loading.add(key);
  render();
  try {
    return selectedVersion === undefined
      ? await runBoundedUpdate(lsp, target, packageId)
      : await runExplicitVersionUpdate(lsp, target, packageId, selectedVersion);
  } finally {
    loading.delete(key);
    render();
  }
}

/** Construct only the explicitly picked project target, never a substitute. */
export function projectTarget(projectPath: string): NuGetTarget {
  return {
    id: projectPath,
    kind: 'project',
    displayName: fileNameOf(projectPath),
    path: projectPath,
    language: extensionOf(projectPath) === 'fsproj' ? 'fsharp' : 'csharp',
  };
}

/** Pick an installed direct package, preview, confirm, revalidate, then apply exactly. */
export async function runBoundedUpdate(
  lsp: LanguageClient,
  target: NuGetTarget,
  packageId?: string,
): Promise<boolean> {
  const selected = packageId ?? (await pickInstalledPackage(lsp, target));
  if (selected === undefined) return false;
  const preview = await fetchUpdatePreview(lsp, target, selected);
  if (!preview.ok) return updateError(selected, preview.error);
  if (preview.value.proposedVersion === null) {
    void vscode.window.showInformationMessage(preview.value.message);
    return false;
  }
  return await confirmAndApply(lsp, preview.value);
}

async function pickInstalledPackage(
  lsp: LanguageClient,
  target: NuGetTarget,
): Promise<string | undefined> {
  const installed = await fetchInstalled(lsp, target);
  if (!installed.ok) {
    // Nothing to pick from: the browser this command opens reports it in its own panel.
    log.warn(`NuGet update: installed packages unavailable for ${target.path}: ${installed.error}`);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    installed.value.packages.map((pkg) => ({
      label: pkg.id,
      description: pkg.resolvedVersion,
      detail: `Installed direct package in ${target.displayName}`,
    })),
    { placeHolder: 'Select an installed direct package to update' },
  );
  return pick?.label;
}

async function confirmAndApply(lsp: LanguageClient, preview: NuGetUpdatePreview): Promise<boolean> {
  const answer = await vscode.window.showInformationMessage(
    confirmationText(preview),
    { modal: true },
    'Update',
  );
  if (answer !== 'Update') return false;
  const current = await fetchUpdatePreview(
    lsp,
    preview.target,
    preview.packageId,
    preview.explicitVersion,
  );
  if (!current.ok) return updateError(preview.packageId, current.error);
  if (!sameProposal(preview, current.value)) {
    void vscode.window.showInformationMessage(
      `Declaration changed; preview refreshed. Run Update again to confirm ${current.value.message}.`,
    );
    return false;
  }
  return await applyPreview(lsp, current.value);
}

async function applyPreview(lsp: LanguageClient, preview: NuGetUpdatePreview): Promise<boolean> {
  const version = preview.proposedVersion;
  if (version === null) return false;
  const result = await installPackage(
    lsp,
    preview.target,
    preview.packageId,
    version,
    preview.currentVersion,
    preview.requestedVersion,
  );
  if (!result.ok) return updateError(preview.packageId, result.error);
  if (!result.value.success) return updateError(preview.packageId, result.value.message);
  void vscode.window.showInformationMessage(
    `Applied ${preview.packageId} ${version} in ${preview.target.displayName}; awaiting restore confirmation`,
  );
  return true;
}

/** Every field that identifies the declaration and fixed choice must survive confirmation. */
export function sameProposal(before: NuGetUpdatePreview, after: NuGetUpdatePreview): boolean {
  return (
    before.target.id === after.target.id &&
    before.packageId === after.packageId &&
    before.requestedVersion === after.requestedVersion &&
    before.currentVersion === after.currentVersion &&
    before.proposedVersion === after.proposedVersion &&
    before.boundary === after.boundary &&
    before.explicitVersion === after.explicitVersion &&
    samePath(before.versionOwner, after.versionOwner) &&
    before.affectedProjects.length === after.affectedProjects.length &&
    before.affectedProjects.every((project, index) =>
      samePath(project, after.affectedProjects[index] ?? ''),
    )
  );
}

function confirmationText(preview: NuGetUpdatePreview): string {
  const proposed = preview.proposedVersion ?? 'none';
  const boundary =
    preview.boundary === 'sameLine' ? '' : `\nExplicit boundary: ${preview.boundary}.`;
  return [
    `Update ${preview.packageId} for ${preview.target.displayName} (${preview.target.path})?`,
    `Current: ${preview.currentVersion}; exact proposed version: ${proposed}.${boundary}`,
    `Version owner: ${preview.versionOwner}.`,
    `Affected projects: ${preview.affectedProjects.join(', ')}.`,
  ].join('\n');
}

function updateError(packageId: string, error: string): false {
  void vscode.window.showErrorMessage(`Update ${packageId} failed: ${error}`);
  return false;
}
