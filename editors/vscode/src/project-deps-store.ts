/**
 * Reactive project-dependencies store.
 *
 * Single source of truth for what packages / project references each csproj
 * or fsproj contains. File watchers handle normal on-disk changes; an mtime
 * guard catches missed watcher events for tracked files outside the workspace.
 * The Signal notifies every consumer (solution tree, NuGet panel, future
 * surfaces) without manual refresh.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as deps from './dependencies.js';
import * as log from './log.js';
import { Signal } from './signals.js';

const WATCH_GLOB = '**/{*.csproj,*.fsproj,Directory.Packages.props}';
const DEBOUNCE_MS = 150;
const MTIME_GUARD_MS = 250;

/** Per-project parsed dependencies, keyed by absolute project path. */
export const projectDependencies = new Signal<Map<string, deps.ProjectDependencies>>(new Map());

let watcher: vscode.FileSystemWatcher | undefined;
let storeContext: vscode.ExtensionContext | undefined;
let mtimeGuard: NodeJS.Timeout | undefined;
const pending = new Map<string, NodeJS.Timeout>();
const projectWatchers = new Map<string, vscode.Disposable>();
const projectMtimes = new Map<string, number>();

/** Start watching project files and populate the signal. Idempotent. */
export function initProjectDepsStore(context: vscode.ExtensionContext): void {
  storeContext = context;
  startMtimeGuard(context);
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
  for (const projectPath of projectDependencies.value.keys()) ensureProjectWatcher(projectPath);
}

/**
 * Register a project path so its dependencies are tracked. Synchronously
 * returns the current snapshot (parsing on first call). Callers reading
 * `projectDependencies.value.get(path)` after this will see fresh data.
 */
export function ensureTracked(projectPath: string): deps.ProjectDependencies {
  const absolute = path.resolve(projectPath);
  ensureProjectWatcher(absolute);
  const existing = projectDependencies.value.get(absolute);
  if (existing !== undefined) {
    updateProjectMtime(absolute);
    return existing;
  }
  const parsed = deps.parseProjectDependencies(absolute);
  const next = new Map(projectDependencies.value);
  next.set(absolute, parsed);
  updateProjectMtime(absolute);
  projectDependencies.value = next;
  log.traceInfo(
    `project-deps-store: tracked ${absolute} (${parsed.nugetPackages.length.toString()} packages)`,
  );
  return parsed;
}

/** Synchronously refresh an already-tracked project from disk. */
export function refreshTracked(projectPath: string): deps.ProjectDependencies | undefined {
  const absolute = path.resolve(projectPath);
  if (!projectDependencies.value.has(absolute)) return undefined;
  const mtime = readMtime(absolute);
  if (mtime === undefined) {
    remove(absolute);
    return undefined;
  }

  const parsed = deps.parseProjectDependencies(absolute);
  projectMtimes.set(absolute, mtime);
  const existing = projectDependencies.value.get(absolute);
  if (existing !== undefined && dependenciesEqual(existing, parsed)) return parsed;

  const next = new Map(projectDependencies.value);
  next.set(absolute, parsed);
  projectDependencies.value = next;
  log.traceInfo(
    `project-deps-store: refreshed ${absolute} (${parsed.nugetPackages.length.toString()} packages)`,
  );
  return parsed;
}

function startMtimeGuard(context: vscode.ExtensionContext): void {
  if (mtimeGuard !== undefined) return;
  mtimeGuard = setInterval(checkTrackedProjectMtimes, MTIME_GUARD_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (mtimeGuard !== undefined) clearInterval(mtimeGuard);
      mtimeGuard = undefined;
    }),
  );
}

function ensureProjectWatcher(projectPath: string): void {
  if (storeContext === undefined || projectWatchers.has(projectPath)) return;
  const projectWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.dirname(projectPath), path.basename(projectPath)),
  );
  const nodeWatcher = watchTrackedProjectWithNode(projectPath);
  const subscription = vscode.Disposable.from(
    projectWatcher,
    projectWatcher.onDidChange((uri) => {
      schedule(uri.fsPath);
    }),
    projectWatcher.onDidCreate((uri) => {
      schedule(uri.fsPath);
    }),
    projectWatcher.onDidDelete((uri) => {
      remove(uri.fsPath);
    }),
    ...(nodeWatcher !== undefined ? [nodeWatcher] : []),
  );
  storeContext.subscriptions.push(subscription);
  projectWatchers.set(projectPath, subscription);
  log.traceInfo(`project-deps-store: watching tracked project ${projectPath}`);
}

function watchTrackedProjectWithNode(projectPath: string): vscode.Disposable | undefined {
  try {
    const nodeWatcher = fs.watch(projectPath, { persistent: false }, () => {
      handleTrackedFileEvent(projectPath);
    });
    // FSWatcher emits async 'error' events (e.g. EPERM on Windows when the
    // watched file's directory tree is deleted). Without a listener Node
    // re-raises them as uncaught exceptions and crashes the extension host
    // (VSCODE-REACTIVITY-SPEC §4). Close the watcher and treat it like a
    // delete: re-evaluate the file and untrack it when gone.
    nodeWatcher.on('error', (err: Error) => {
      log.traceInfo(`project-deps-store: node watcher error for ${projectPath}: ${err.message}`);
      nodeWatcher.close();
      handleTrackedFileEvent(projectPath);
    });
    return new vscode.Disposable(() => {
      nodeWatcher.close();
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.traceInfo(`project-deps-store: node watcher unavailable for ${projectPath}: ${msg}`);
    return undefined;
  }
}

function handleTrackedFileEvent(projectPath: string): void {
  if (fs.existsSync(projectPath)) {
    schedule(projectPath);
  } else {
    remove(projectPath);
  }
}

/** Force a rescan of every tracked project path. Used after install/uninstall. */
export function rescanAll(): void {
  const next = new Map<string, deps.ProjectDependencies>();
  for (const projectPath of projectDependencies.value.keys()) {
    next.set(projectPath, deps.parseProjectDependencies(projectPath));
    updateProjectMtime(projectPath);
  }
  projectDependencies.value = next;
}

function checkTrackedProjectMtimes(): void {
  for (const projectPath of projectDependencies.value.keys()) {
    const current = readMtime(projectPath);
    if (current === undefined) {
      remove(projectPath);
      continue;
    }
    const previous = projectMtimes.get(projectPath);
    if (previous === undefined) {
      projectMtimes.set(projectPath, current);
      continue;
    }
    if (previous !== current) {
      projectMtimes.set(projectPath, current);
      schedule(projectPath);
    }
  }
}

function readMtime(projectPath: string): number | undefined {
  try {
    return fs.statSync(projectPath).mtimeMs;
  } catch {
    return undefined;
  }
}

function updateProjectMtime(projectPath: string): void {
  const mtime = readMtime(projectPath);
  if (mtime === undefined) {
    projectMtimes.delete(projectPath);
  } else {
    projectMtimes.set(projectPath, mtime);
  }
}

function dependenciesEqual(
  left: deps.ProjectDependencies,
  right: deps.ProjectDependencies,
): boolean {
  return (
    packagesEqual(left.nugetPackages, right.nugetPackages) &&
    projectReferencesEqual(left.projectReferences, right.projectReferences)
  );
}

function packagesEqual(left: deps.NuGetPackage[], right: deps.NuGetPackage[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((pkg, index) => {
    const other = right[index];
    return pkg.name === other?.name && pkg.version === other.version;
  });
}

function projectReferencesEqual(
  left: deps.ProjectReference[],
  right: deps.ProjectReference[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((ref, index) => {
    const other = right[index];
    return ref.name === other?.name && ref.includePath === other.includePath;
  });
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
  updateProjectMtime(absolute);
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
  projectMtimes.delete(absolute);
  projectDependencies.value = next;
  log.traceInfo(`project-deps-store: removed ${absolute}`);
}

/** Test-only: tear down the watcher so test suites can start fresh. */
export function resetForTests(): void {
  watcher?.dispose();
  watcher = undefined;
  // Reset the captured ExtensionContext too: a leaked storeContext makes
  // pre-init ensureTracked() attach a watcher to a stale context and pollute
  // projectWatchers, which breaks "start fresh" isolation across suites.
  storeContext = undefined;
  if (mtimeGuard !== undefined) clearInterval(mtimeGuard);
  mtimeGuard = undefined;
  for (const disposable of projectWatchers.values()) disposable.dispose();
  projectWatchers.clear();
  projectMtimes.clear();
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  projectDependencies.value = new Map();
}
