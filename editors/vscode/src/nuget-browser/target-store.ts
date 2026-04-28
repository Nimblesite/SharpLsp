// Pure helpers for resolving and persisting the active NuGet target.
//
// `loadTargets` orchestration is here so the panel class doesn't have to
// know about the workspaceState key, fallback synthesis, or default-target
// resolution rules.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { fetchTargets } from './lsp.js';
import { type NuGetTarget } from './types.js';

export const LAST_TARGET_KEY = 'sharplsp.nuget.lastTargetId';

export interface LoadTargetsResult {
  targets: NuGetTarget[];
  selectedTargetId: string | undefined;
  error: string | undefined;
}

export async function loadTargetsWithDefaults(
  lsp: LanguageClient,
  context: vscode.ExtensionContext,
  initialProjectPath: string,
): Promise<LoadTargetsResult> {
  const workspaceRoot = computeWorkspaceRoot(initialProjectPath);
  const result = await fetchTargets(lsp, workspaceRoot);

  let targets: NuGetTarget[];
  let error: string | undefined;
  if (!result.ok) {
    error = result.error;
    targets = [synthesizeFallback(initialProjectPath)];
  } else {
    targets = result.value.targets;
    if (targets.length === 0) {
      targets = [synthesizeFallback(initialProjectPath)];
    }
  }

  if (!targets.some((t) => t.path === initialProjectPath)) {
    targets = [synthesizeFallback(initialProjectPath), ...targets];
  }

  const persisted = context.workspaceState.get<string>(LAST_TARGET_KEY);
  const persistedMatch = targets.find((t) => t.id === persisted);
  const initialMatch = targets.find((t) => t.path === initialProjectPath);
  const selectedTargetId = persistedMatch?.id ?? initialMatch?.id ?? targets[0]?.id;

  return { targets, selectedTargetId, error };
}

export async function persistTargetSelection(
  context: vscode.ExtensionContext,
  targetId: string,
): Promise<void> {
  await context.workspaceState.update(LAST_TARGET_KEY, targetId);
}

export function computeWorkspaceRoot(initialProjectPath: string): string {
  const fromVscode = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (fromVscode !== undefined) return fromVscode;
  return path.dirname(initialProjectPath);
}

export function synthesizeFallback(projectPath: string): NuGetTarget {
  const file = path.basename(projectPath);
  return {
    id: projectPath,
    kind: 'project',
    displayName: file,
    path: projectPath,
    language: file.endsWith('.fsproj') ? 'fsharp' : 'csharp',
  };
}
