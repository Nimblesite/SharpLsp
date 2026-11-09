// Shared fixtures and assertion bundles for the NuGet + project-dependency
// suites: the reactive `projectDependencies` observer every store test needs,
// and the parsed-XML / quick-pick assertions the command flows re-assert.
//
// The store tests all observe the same way — an `effect` pushing
// `projectDependencies.value.size` — and the parse tests all assert the same
// bundle — package names sorted into `expected`. Keeping those in one place is
// what stops a reactive-contract change from having to be re-typed seven times.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseProjectDependencies } from '../../dependencies.js';
import { effect } from '../../signals.js';
import { projectDependencies } from '../../project-deps-store.js';
import { assertContainsAll } from './test-helpers';
import { type UiStubs } from './ui-stubs';

/** The dependency lists a parsed project carries, viewed by name only. */
interface ParsedDeps {
  readonly nugetPackages: readonly { readonly name: string }[];
  readonly projectReferences: readonly { readonly name: string; readonly includePath: string }[];
}

/** The severity channel of a recorded toast. */
type ToastKind = 'info' | 'warning' | 'error';

/** The recorded toasts of `kind`, in order. */
function toastsOf(stubs: UiStubs, kind: ToastKind): readonly string[] {
  switch (kind) {
    case 'info':
      return stubs.log.infoMessages;
    case 'warning':
      return stubs.log.warningMessages;
    case 'error':
      return stubs.log.errorMessages;
  }
}

/** Asserts some `kind` toast contains every substring in `parts`. */
export function assertSomeToastIncludes(
  stubs: UiStubs,
  kind: ToastKind,
  parts: readonly string[],
  message: string,
): void {
  assert.ok(
    toastsOf(stubs, kind).some((text) => parts.every((part) => text.includes(part))),
    `${message}; got: ${toastsOf(stubs, kind).join(' | ')}`,
  );
}

/** Asserts NO `kind` toast contains `part`. */
export function assertNoToastIncludes(
  stubs: UiStubs,
  kind: ToastKind,
  part: string,
  message: string,
): void {
  assert.ok(
    !toastsOf(stubs, kind).some((text) => text.includes(part)),
    `${message}; got: ${toastsOf(stubs, kind).join(' | ')}`,
  );
}

/**
 * Asserts `command` (given `args`) resolves rather than rejecting, discarding
 * its result — the `assert.doesNotReject` wrapper every command-flow test opens with.
 */
export async function expectResolved(
  command: string,
  message?: string,
  ...args: unknown[]
): Promise<void> {
  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand(command, ...args);
  }, message);
}

/** Asserts exactly one removal outcome was reported: an info naming 'Removed' or an error naming 'Failed to remove'. */
export function assertOneRemovalOutcome(stubs: UiStubs, message: string): void {
  assert.strictEqual(
    stubs.log.infoMessages.filter((m) => m.includes('Removed')).length +
      stubs.log.errorMessages.filter((m) => m.includes('Failed to remove')).length,
    1,
    message,
  );
}

/** Asserts `deps` lists exactly `expected` NuGet package names, in order. */
export function assertPackageNames(
  deps: ParsedDeps,
  expected: readonly string[],
  message: string,
): void {
  assert.deepEqual(
    deps.nugetPackages.map((pkg) => pkg.name),
    expected,
    message,
  );
}

/** An `effect` observer of `projectDependencies.value.size`, with its disposer. */
export function observeProjectCount(): { readonly runs: number[]; dispose: () => void } {
  const runs: number[] = [];
  const dispose = effect(() => {
    runs.push(projectDependencies.value.size);
  });
  return { runs, dispose };
}

/**
 * Parses `projectPath` from disk and asserts its sorted package names and its
 * single project reference named `refName`; returns the parsed dependencies.
 */
export function assertParsedProjectDeps(
  projectPath: string,
  expectedPackages: readonly string[],
  packagesMessage: string,
  refCountMessage: string,
  refName: string,
  refNameMessage: string,
): ParsedDeps {
  const parsed = parseProjectDependencies(projectPath);
  assertPackageNames(parsed, expectedPackages, packagesMessage);
  assert.strictEqual(parsed.projectReferences.length, 1, refCountMessage);
  assert.strictEqual(parsed.projectReferences[0]?.name, refName, refNameMessage);
  return parsed;
}

/** Asserts `deps` includes a NuGet package named `name`. */
export function assertHasPackageName(deps: ParsedDeps, name: string, message: string): void {
  assert.ok(
    deps.nugetPackages.some((pkg) => pkg.name === name),
    message,
  );
}

/** Asserts `deps` does not include a NuGet package named `name`. */
export function assertLacksPackageName(deps: ParsedDeps, name: string, message: string): void {
  assert.ok(!deps.nugetPackages.some((pkg) => pkg.name === name), message);
}

/** Asserts `parsed` carries exactly one project reference, named `refName`. */
export function assertSoleProjectReference(
  parsed: ParsedDeps,
  refName: string,
  countMessage: string,
  nameMessage: string,
): void {
  assert.strictEqual(parsed.projectReferences.length, 1, countMessage);
  assert.strictEqual(parsed.projectReferences[0]?.name, refName, nameMessage);
}

/** An SDK project's XML with one ItemGroup holding one PackageReference (`version` `undefined` omits the attribute). */
export function singlePackageProjectXml(include: string, version?: string): string {
  const versionAttribute = version === undefined ? '' : ` Version="${version}"`;
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <ItemGroup>',
    `    <PackageReference Include="${include}"${versionAttribute} />`,
    '  </ItemGroup>',
    '</Project>',
  ].join('\n');
}

/** A project-count observer asserted to start with the store holding `initial` projects. */
export function observeCountAt(
  initial: number,
  message: string,
): { readonly runs: number[]; dispose: () => void } {
  const observation = observeProjectCount();
  assert.deepEqual(observation.runs, [initial], message);
  return observation;
}

/** Asserts the project tracked under `projectPath` keeps `name` as its first NuGet package. */
export function assertStoredFirstName(projectPath: string, name: string, message: string): void {
  assert.strictEqual(
    projectDependencies.value.get(path.resolve(projectPath))?.nugetPackages[0]?.name,
    name,
    message,
  );
}

/** Asserts the first recorded QuickPick offered an item labelled `label`. */
export function assertFirstPickOffered(
  stubs: UiStubs,
  label: string,
  listMessage: string,
  itemMessage: string,
): void {
  const offered = stubs.log.quickPickItems[0] as { label?: string }[] | undefined;
  assert.ok(offered, listMessage);
  assert.ok(
    offered.some((item) => item.label === label),
    itemMessage,
  );
}

/** Asserts mutated project XML is still a well-formed SDK project. */
export function assertSdkProjectIntact(xml: string, label: string, closeMessage: string): void {
  assertContainsAll(
    xml,
    ['<Project Sdk="Microsoft.NET.Sdk">', '<TargetFramework>net9.0</TargetFramework>'],
    label,
  );
  assert.ok(xml.trim().endsWith('</Project>'), closeMessage);
}

/** Asserts project XML still opens and closes as an SDK project document. */
export function assertProjectXmlCloses(
  xml: string,
  intactMessage: string,
  closeMessage: string,
): void {
  assert.ok(xml.includes('<Project Sdk="Microsoft.NET.Sdk">'), intactMessage);
  assert.ok(xml.trim().endsWith('</Project>'), closeMessage);
}

/** The Solution Explorer tree-row shape of a NuGet package under a project. */
export function packageNode(
  projectFilePath: string,
  packageName: string,
): {
  projectFilePath: string;
  referenceName: string;
  label: string;
  contextValue: string;
} {
  return {
    projectFilePath,
    referenceName: packageName,
    label: packageName,
    contextValue: 'nugetPackage',
  };
}
