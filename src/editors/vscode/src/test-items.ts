/**
 * Building the rows the Testing view shows.
 *
 * The tree is **Assembly → Namespace → Class → Test**, and only the leaves are
 * tests. It lives apart from `testing.ts` so the controller file stays about
 * the VS Code Testing API wiring and nothing else.
 *
 * Both runners build the same tree from the same ids, because both discovery
 * paths report `namespace.Type.Method` ([TEST-DISCOVERY-FQN],
 * [TEST-MTP-DISCOVERY]). A Microsoft.Testing.Platform sweep also reports where
 * each test is WRITTEN, so its leaves carry a file and a line; a VSTest sweep
 * reports none, and its leaves carry the target folder as before.
 *
 * Implements [TEST-EXPLORER].
 */

import * as vscode from 'vscode';
import type { TestAssemblyListing, TestLocation } from './test-listing-model.js';
import { isExpectoTest, isFsCheckTest } from './test-targets.js';

/**
 * Id prefix marking the row that explains WHY discovery failed. Error rows are
 * leaves that never run; a successful sweep removes them.
 */
export const ERROR_ITEM_PREFIX = 'discovery-error:';

/** What every row of one sweep is built from. */
export interface ItemContext {
  readonly controller: vscode.TestController;
  /** Fallback uri for a row whose test reported no source file. */
  readonly uri: vscode.Uri;
  /** Source location per test id, when the runner reported one. */
  readonly locations: ReadonlyMap<string, TestLocation> | undefined;
}

/** The uri a test row points at: its own source file, else the target folder. */
function uriFor(context: ItemContext, fullName: string): vscode.Uri {
  const location = context.locations?.get(fullName);
  return location === undefined ? context.uri : vscode.Uri.file(location.file);
}

/** The one-line range a test row selects, when its line is known. */
function rangeFor(context: ItemContext, fullName: string): vscode.Range | undefined {
  const line = context.locations?.get(fullName)?.line;
  if (line === undefined) return undefined;
  const zeroBased = Math.max(0, line - 1);
  return new vscode.Range(zeroBased, 0, zeroBased, 0);
}

/** Build a TestItem for a fully-qualified name, tagging F# tests. */
export function makeTestItem(context: ItemContext, fullName: string): vscode.TestItem {
  const parts = fullName.split('.');
  const label = parts.at(-1) ?? fullName;
  const item = context.controller.createTestItem(fullName, label, uriFor(context, fullName));
  item.description = fullName;
  item.range = rangeFor(context, fullName);
  if (isExpectoTest(fullName) || isFsCheckTest(fullName)) {
    item.tags = [new vscode.TestTag('fsharp')];
  }
  return item;
}

/** A non-test group node: an assembly, a namespace or a class. */
function makeGroupItem(context: ItemContext, id: string, label: string): vscode.TestItem {
  const item = context.controller.createTestItem(id, label, context.uri);
  item.canResolveChildren = true;
  return item;
}

/** The namespace and class labels one fully-qualified name sits under. */
function levelsOf(fullName: string): { namespaceLabel: string; classLabel: string } {
  const parts = fullName.split('.');
  return {
    namespaceLabel: parts.length >= 3 ? parts.slice(0, -2).join('.') : '',
    classLabel: parts.length >= 2 ? (parts.at(-2) ?? '') : '',
  };
}

/** Find or create one level of the tree under `parent`. */
function levelItem(
  context: ItemContext,
  cache: Map<string, vscode.TestItem>,
  parent: vscode.TestItem,
  level: { id: string; label: string },
): vscode.TestItem {
  const existing = cache.get(level.id);
  if (existing !== undefined) return existing;
  const item = makeGroupItem(context, level.id, level.label);
  cache.set(level.id, item);
  parent.children.add(item);
  return item;
}

/**
 * Build one assembly's Assembly → Namespace → Class → Test subtree.
 *
 * The last dotted segment is the test, the one before it the class, the rest
 * joined the namespace — deterministic for C# namespaces and dotted F# modules
 * alike (`Fs.Xunit.Fixtures.adds two numbers` → `Fs.Xunit` / `Fixtures` /
 * `adds two numbers`). Shorter names nest under whatever levels exist; nothing
 * is ever dropped.
 */
export function makeAssemblyItem(
  context: ItemContext,
  assembly: TestAssemblyListing,
): vscode.TestItem {
  const root = makeGroupItem(context, `assembly:${assembly.path}`, assembly.name);
  const namespaces = new Map<string, vscode.TestItem>();
  const classes = new Map<string, vscode.TestItem>();
  for (const fqn of assembly.names) {
    const { namespaceLabel, classLabel } = levelsOf(fqn);
    let parent = root;
    if (namespaceLabel !== '') {
      parent = levelItem(context, namespaces, parent, {
        id: `namespace:${assembly.path}|${namespaceLabel}`,
        label: namespaceLabel,
      });
    }
    if (classLabel !== '') {
      parent = levelItem(context, classes, parent, {
        id: `class:${assembly.path}|${namespaceLabel}|${classLabel}`,
        label: classLabel,
      });
    }
    parent.children.add(makeTestItem(context, fqn));
  }
  return root;
}

/**
 * The row that explains WHY discovery failed: the real `dotnet` diagnostic plus
 * a remedy, so the user acts instead of staring at an empty view.
 */
export function makeErrorItem(
  context: ItemContext,
  target: string,
  warnings: readonly string[],
): vscode.TestItem {
  const item = context.controller.createTestItem(
    `${ERROR_ITEM_PREFIX}${target}`,
    'Test discovery failed',
    context.uri,
  );
  item.description = target;
  const diagnostics =
    warnings.length > 0 ? warnings.join('\n\n') : 'dotnet test produced no test listing.';
  item.error = new vscode.MarkdownString(
    `SharpLsp could not enumerate tests for \`${target}\`.\n\n` +
      `${diagnostics}\n\n` +
      'Load one solution with the **SharpLsp: Select Solution** command, fix the build errors above, then refresh the Testing view.',
  );
  return item;
}
