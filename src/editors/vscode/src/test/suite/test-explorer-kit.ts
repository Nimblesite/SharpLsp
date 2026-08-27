// Driving and observing the extension-owned Test Explorer from the extension
// host.
//
// The controller belongs to the ALREADY-ACTIVATED extension — constructing a
// second `SharpLspTestController` throws "duplicate controller id" — so every
// suite reaches it through the public API and drives the same entry points the
// workbench does: the refresh/resolve handlers, the run profiles' handlers, and
// the shared `state.solutionPath` signal behind `loadSolution`.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import type { SharpLspTestController } from '../../testing.js';
import { EXTENSION_ID, sleep } from './test-helpers';

/** Longer than the controller's 1 s reactive-discovery debounce. */
export const DISCOVERY_SETTLE_MS = 1_800;

/** A cold `dotnet test` sweep over a freshly written fixture solution. */
export const DISCOVERY_TIMEOUT_MS = 240_000;

/** Everything about a TestItem an assertion could care about. */
export interface TestItemSnapshot {
  readonly id: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly uriPath: string | undefined;
  readonly tags: readonly string[];
  readonly childCount: number;
}

/** Activate the extension and hand back its API, asserting the Test Explorer. */
export async function activateTestExplorer(): Promise<SharpLspExtensionApi> {
  const extension = vscode.extensions.getExtension<SharpLspExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the VSIX host`);
  const api = await extension.activate();
  assert.ok(api.testController, 'the extension must expose its Test Explorer controller');
  assert.ok(api.explorerProvider, 'the extension must expose its Solution Explorer provider');
  return api;
}

/** Recursively collect every TestItem id in a controller collection. */
export function collectItemIds(items: vscode.TestItemCollection): string[] {
  const ids: string[] = [];
  items.forEach((item) => {
    ids.push(item.id);
    ids.push(...collectItemIds(item.children));
  });
  return ids;
}

/** Recursively snapshot every TestItem, for shape assertions. */
export function snapshotItems(items: vscode.TestItemCollection): TestItemSnapshot[] {
  const snapshots: TestItemSnapshot[] = [];
  items.forEach((item) => {
    snapshots.push({
      id: item.id,
      label: item.label,
      description: item.description,
      uriPath: item.uri?.fsPath,
      tags: item.tags.map((tag) => tag.id),
      childCount: item.children.size,
    });
    snapshots.push(...snapshotItems(item.children));
  });
  return snapshots;
}

/** The TestItem with `id`, searched recursively. */
export function findItem(
  items: vscode.TestItemCollection,
  id: string,
): vscode.TestItem | undefined {
  let found: vscode.TestItem | undefined;
  items.forEach((item) => {
    if (found !== undefined) return;
    if (item.id === id) {
      found = item;
      return;
    }
    found = findItem(item.children, id);
  });
  return found;
}

/**
 * Poll the tree until `predicate` holds, then return the ids. Returns the last
 * read on timeout so the caller's assertions — not an opaque timeout — report
 * what was actually discovered.
 */
export async function pollForIds(
  controller: SharpLspTestController,
  predicate: (ids: string[]) => boolean,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
  intervalMs = 500,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let ids = collectItemIds(controller.items);
  while (!predicate(ids) && Date.now() < deadline) {
    await sleep(intervalMs);
    ids = collectItemIds(controller.items);
  }
  return ids;
}

/** Poll until every name in `expected` is in the tree. */
export async function pollUntilDiscovered(
  controller: SharpLspTestController,
  expected: readonly string[],
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<string[]> {
  return pollForIds(controller, (ids) => expected.every((name) => ids.includes(name)), timeoutMs);
}

/**
 * Apply a state change, then let reactive re-discovery settle.
 *
 * The controller debounces solution-change discovery rather than cancelling it,
 * so a mutation schedules a `dotnet test` that starts ~1 s later. Deleting the
 * fixture before that lands leaves `dotnet` pointed at a removed directory,
 * where it hangs and poisons every later run in the same host.
 */
export async function drainDiscovery(
  mutate: () => void,
  controller: SharpLspTestController,
): Promise<void> {
  mutate();
  await sleep(DISCOVERY_SETTLE_MS);
  await controller.whenIdle();
}

/** Load a solution and force one discovery sweep, then wait for `expected`. */
export async function discoverSolution(
  api: SharpLspExtensionApi,
  solutionPath: string,
  expected: readonly string[],
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<string[]> {
  await api.explorerProvider.loadSolution(solutionPath);
  await api.testController.activateAndDiscover();
  return pollUntilDiscovered(api.testController, expected, timeoutMs);
}

/** The controller's profile of a given kind, asserted present. */
export function profileOfKind(
  controller: SharpLspTestController,
  kind: vscode.TestRunProfileKind,
): vscode.TestRunProfile {
  const profile = controller.profiles.find((candidate) => candidate.kind === kind);
  assert.ok(profile, `the controller must register a ${String(kind)} run profile`);
  return profile;
}

/**
 * Press the Test Explorer's ▶ (or coverage) button for `items`: invoke the very
 * `runHandler` the workbench invokes, with a real cancellation token.
 */
export async function runViaProfile(
  controller: SharpLspTestController,
  kind: vscode.TestRunProfileKind,
  items: readonly vscode.TestItem[],
  cancelAfterMs?: number,
): Promise<void> {
  const profile = profileOfKind(controller, kind);
  const request = new vscode.TestRunRequest(
    items.length > 0 ? [...items] : undefined,
    undefined,
    profile,
  );
  const source = new vscode.CancellationTokenSource();
  if (cancelAfterMs !== undefined) {
    setTimeout(() => {
      source.cancel();
    }, cancelAfterMs);
  }
  try {
    await profile.runHandler(request, source.token);
  } finally {
    source.dispose();
  }
}

/** Resolve on the controller's next `onResultsChanged`, or on timeout. */
export async function nextResultsChange(
  controller: SharpLspTestController,
  timeoutMs = 300_000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(false);
    }, timeoutMs);
    const subscription = controller.onResultsChanged(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(true);
    });
  });
}
