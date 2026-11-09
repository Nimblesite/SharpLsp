// Shared fixtures and assertion bundles for the NuGet + project-dependency
// suites: the reactive `projectDependencies` observer every store test needs,
// and the parsed-XML / quick-pick assertions the command flows re-assert.
//
// The store tests all observe the same way — an `effect` pushing
// `projectDependencies.value.size` — and the parse tests all assert the same
// bundle — package names sorted into `expected`. Keeping those in one place is
// what stops a reactive-contract change from having to be re-typed seven times.
import * as assert from 'node:assert/strict';
import { effect } from '../../signals.js';
import { projectDependencies } from '../../project-deps-store.js';
import { assertContainsAll } from './test-helpers';
import { type UiStubs } from './ui-stubs';

/** The dependency lists a parsed project carries, viewed by name only. */
interface ParsedDeps {
  readonly nugetPackages: readonly { readonly name: string }[];
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
