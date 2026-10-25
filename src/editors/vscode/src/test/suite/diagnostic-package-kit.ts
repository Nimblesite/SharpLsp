// SDK-built local dependencies for diagnostic truth. [DIAG-TRUTH-GUARANTEES]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension';
import { directoryOf, joinPath } from '../../paths';
import {
  assertClosedProblem,
  assertCompilerProblem,
  assertFileStillClosed,
  writeAccuracyFixture,
  type AccuracyCase,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { buildProjectXml, dotnet, writeProject } from './dotnet-project-kit';
import type { ProjectOptions } from './dotnet-project-kit';

export interface DiagnosticPackage {
  readonly id: string;
  readonly version: string;
  readonly assembly: string;
  readonly source: string;
}

export interface PackageDiagnosticCase {
  readonly base: AccuracyCase;
  readonly changedCode: string;
  readonly oracle: string;
}

export interface PackageProblemFixture {
  readonly subject: AccuracyFixture;
  readonly scenario: PackageDiagnosticCase;
}

interface SdkAssets {
  readonly project: { readonly restore: { readonly originalTargetFrameworks: readonly string[] } };
  readonly packageFolders: Record<string, unknown>;
  readonly libraries: Record<string, { readonly path: string }>;
  readonly targets: Record<string, Record<string, { readonly compile?: Record<string, unknown> }>>;
}

/** Read actual SDK output; callers assert their own package identity and compilation metadata. */
export function readSdkPackageAssets(assetsFile: string): SdkAssets {
  return JSON.parse(fs.readFileSync(assetsFile, 'utf8')) as SdkAssets;
}

/** Both restore fixtures inspect the owning project's actual SDK snapshot. */
export function packageProjectPaths(subject: AccuracyFixture): { project: string; assets: string } {
  const project = joinPath(directoryOf(subject.entryUri.fsPath), subject.scenario.project);
  const assets = joinPath(directoryOf(project), 'obj', 'project.assets.json');
  return { project, assets };
}

/** The independent compiler oracle cannot repair the subject's SDK assets. */
export async function assertPackageSdkTruth(
  api: SharpLspExtensionApi,
  root: string,
  scenario: PackageDiagnosticCase,
  options: ProjectOptions,
): Promise<void> {
  const oracle = { ...scenario.base, broken: scenario.oracle, code: scenario.changedCode };
  const fixture = await writeAccuracyFixture(api, joinPath(root, 'Oracle'), oracle, options);
  assert.ok(
    fs.existsSync(joinPath(directoryOf(fixture.closedUri.fsPath), 'obj', 'project.assets.json')),
  );
}

/** The unrelated error stays; the changed package error has its exact source and range. */
export async function assertPackageProblems(
  fixture: PackageProblemFixture,
  updated: boolean,
): Promise<void> {
  const { subject, scenario } = fixture;
  const sameCode = scenario.base.code === scenario.changedCode;
  await assertClosedProblem(subject, sameCode && updated ? 2 : 1);
  if (!sameCode) {
    const changed = { ...subject, scenario: { ...subject.scenario, code: scenario.changedCode } };
    const line = scenario.base.language === 'F#' ? 2 : 1;
    await assertCompilerProblem(changed, subject.closedUri, updated ? 1 : 0, line);
  }
  assertPackageErrorCount(subject, updated);
}

function assertPackageErrorCount(subject: AccuracyFixture, updated: boolean): void {
  assertFileStillClosed(subject);
  const errors = vscode.languages
    .getDiagnostics(subject.closedUri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error);
  const reason = 'no missing compiler errors or phantom package errors';
  assert.equal(errors.length, updated ? 2 : 1, reason);
}

function packageProperties(recipe: DiagnosticPackage): Record<string, string> {
  return {
    IsPackable: 'true',
    PackageId: recipe.id,
    Version: recipe.version,
    AssemblyName: recipe.assembly,
  };
}

/** The SDK builds and packs an actual assembly into a fixture-owned local feed. */
export async function packDiagnosticPackage(
  root: string,
  recipe: DiagnosticPackage,
): Promise<string> {
  const feed = joinPath(root, 'feed');
  const properties = packageProperties(recipe);
  const directory = joinPath(root, `Package-${recipe.version}`);
  const xml = buildProjectXml({ properties });
  const project = writeProject(directory, 'Dependency.csproj', xml, 'Api.cs', recipe.source);
  await dotnet(['pack', joinPath(project, 'Dependency.csproj'), '-c', 'Release', '-o', feed], root);
  assert.ok(fs.existsSync(joinPath(feed, `${recipe.id}.${recipe.version}.nupkg`)));
  return feed;
}
