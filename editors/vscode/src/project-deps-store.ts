/**
 * Reactive project-dependencies store.
 *
 * Single source of truth for what packages / project references each csproj
 * or fsproj contains. A FileSystemWatcher rescans the file whenever it changes
 * on disk; the Signal notifies every consumer (solution tree, NuGet panel,
 * future surfaces). No polling, no manual refresh.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import * as deps from './dependencies.js';
import * as log from './log.js';
import { Signal } from './signals.js';

const WATCH_GLOB = '**/{*.csproj,*.fsproj,Directory.Packages.props}';
const DEBOUNCE_MS = 150;

/** Per-project parsed dependencies, keyed by absolute project path. */
export const projectDependencies = new Signal<Map<string, deps.ProjectDependencies>>(new Map());

let watcher: vscode.FileSystemWatcher | undefined;
const pending = new Map<string, NodeJS.Timeout>();

/** Start watching project files and populate the signal. Idempotent. */
export function initProjectDepsStore(context: vscode.ExtensionContext): void {
  if (watcher !== undefined) return;
  watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
  context.subscriptions.push(watcher);
  context.subscriptions.push(
    watcher.onDidChange((uri) => {
      schedule(uri.fsPath);
    }),
  );
  context.subscriptions.push(
    watcher.onDidCreate((uri) => {
      schedule(uri.fsPath);
    }),
  );
  context.subscriptions.push(
    watcher.onDidDelete((uri) => {
      remove(uri.fsPath);
    }),
  );
  log.traceInfo(`project-deps-store: watching ${WATCH_GLOB}`);
}

/**
 * Register a project path so its dependencies are tracked. Synchronously
 * returns the current snapshot (parsing on first call). Callers reading
 * `projectDependencies.value.get(path)` after this will see fresh data.
 */
export function ensureTracked(projectPath: string): deps.ProjectDependencies {
  const absolute = path.resolve(projectPath);
  const existing = projectDependencies.value.get(absolute);
  if (existing !== undefined) return existing;
  const parsed = deps.parseProjectDependencies(absolute);
  const next = new Map(projectDependencies.value);
  next.set(absolute, parsed);
  projectDependencies.value = next;
  log.traceInfo(
    `project-deps-store: tracked ${absolute} (${parsed.nugetPackages.length.toString()} packages)`,
  );
  return parsed;
}

/** Force a rescan of every tracked project path. Used after install/uninstall. */
export function rescanAll(): void {
  const next = new Map<string, deps.ProjectDependencies>();
  for (const projectPath of projectDependencies.value.keys()) {
    next.set(projectPath, deps.parseProjectDependencies(projectPath));
  }
  projectDependencies.value = next;
}

function schedule(filePath: string): void {
  const existing = pending.get(filePath);
  if (existing !== undefined) clearTimeout(existing);
  pending.set(
    filePath,
    setTimeout(() => {
      pending.delete(filePath);
      rescan(filePath);
    }, DEBOUNCE_MS),
  );
}

function rescan(filePath: string): void {
  const lower = filePath.toLowerCase();
  const isProject = lower.endsWith('.csproj') || lower.endsWith('.fsproj');
  if (isProject) {
    rescanOne(filePath);
    return;
  }
  // Directory.Packages.props affects every tracked project — rescan all.
  log.traceInfo(`project-deps-store: Directory.Packages.props changed, rescanning all`);
  rescanAll();
}

function rescanOne(projectPath: string): void {
  const absolute = path.resolve(projectPath);
  if (!projectDependencies.value.has(absolute)) return;
  const parsed = deps.parseProjectDependencies(absolute);
  const next = new Map(projectDependencies.value);
  next.set(absolute, parsed);
  projectDependencies.value = next;
  log.traceInfo(
    `project-deps-store: rescanned ${absolute} (${parsed.nugetPackages.length.toString()} packages)`,
  );
}

function remove(filePath: string): void {
  const absolute = path.resolve(filePath);
  if (!projectDependencies.value.has(absolute)) return;
  const next = new Map(projectDependencies.value);
  next.delete(absolute);
  projectDependencies.value = next;
  log.traceInfo(`project-deps-store: removed ${absolute}`);
}

/** Test-only: tear down the watcher so test suites can start fresh. */
export function resetForTests(): void {
  watcher?.dispose();
  watcher = undefined;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  projectDependencies.value = new Map();
}
