// Package edits must not trust preserved project timestamps. [DIAG-RESTORE]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { SharpLspExtensionApi } from '../../extension';
import { joinPath } from '../../paths';
import {
  ACCURACY_CASES,
  accuracyProjectXml,
  writeAccuracyFixture,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { IMPORT_CASES, packageOptions, packVersions } from './diagnostic-imported-restore-kit';
import {
  assertPackageSdkTruth,
  packageProjectPaths,
  readSdkPackageAssets,
} from './diagnostic-package-kit';
import type { ProjectOptions } from './dotnet-project-kit';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';

const PACKAGE_CASES = IMPORT_CASES.flatMap((scenario) => [
  { ...scenario, kind: 'version' as const },
  {
    ...scenario,
    kind: 'remove' as const,
    changedCode: scenario.base.language === 'F#' ? 'FS0039' : 'CS0103',
  },
]);
const FRAMEWORK_CASES = [
  {
    base: ACCURACY_CASES[0],
    kind: 'framework' as const,
    changedCode: 'FS0039',
    subject:
      'module DiagnosticAccuracy.Closed\nlet unrelated: int = "broken"\nlet gate = new System.Threading.Lock()\n',
    oracle: 'module DiagnosticAccuracy.Closed\nlet gate = new System.Threading.Lock()\n',
  },
  {
    base: ACCURACY_CASES[1],
    kind: 'framework' as const,
    changedCode: 'CS0234',
    subject:
      'namespace DiagnosticAccuracy;\npublic static class Closed { public static int Unrelated => "broken"; public static object Gate => new System.Threading.Lock(); }\n',
    oracle:
      'namespace DiagnosticAccuracy;\npublic static class Closed { public static object Gate => new System.Threading.Lock(); }\n',
  },
];
export const SNAPSHOT_CASES = [...PACKAGE_CASES, ...FRAMEWORK_CASES];
export type SnapshotCase = (typeof SNAPSHOT_CASES)[number];

export interface PackageSnapshotFixture {
  readonly subject: AccuracyFixture;
  readonly scenario: SnapshotCase;
  readonly options: ProjectOptions;
  readonly project: string;
  readonly assets: string;
  readonly projectTime: number;
}

function changedOptions(options: ProjectOptions, scenario: SnapshotCase): ProjectOptions {
  if (scenario.kind === 'framework')
    return { properties: { ...options.properties, TargetFramework: 'netstandard2.1' } };
  return {
    ...options,
    packages:
      scenario.kind === 'remove'
        ? []
        : (options.packages ?? []).map((item) => ({ ...item, version: '2.0.0' })),
  };
}

/** The timestamp is representable exactly on both NTFS and Linux. */
function preservedTime(project: string, assets: string): number {
  const assetTime = fs.statSync(assets).mtimeMs;
  const time = new Date((Math.floor(assetTime / 1000) - 1) * 1000);
  fs.utimesSync(project, time, time);
  assert.equal(fs.statSync(project).mtimeMs, time.getTime());
  assert.ok(assetTime > time.getTime());
  return time.getTime();
}

function snapshot(
  subject: AccuracyFixture,
  scenario: SnapshotCase,
  options: ProjectOptions,
): PackageSnapshotFixture {
  const { project, assets } = packageProjectPaths(subject);
  return {
    subject,
    scenario,
    options,
    project,
    assets,
    projectTime: preservedTime(project, assets),
  };
}

/** Genuine SDK package signatures and a separately restored compiler failure. */
export async function preparePackageSnapshot(
  api: SharpLspExtensionApi,
  root: string,
  scenario: SnapshotCase,
): Promise<PackageSnapshotFixture> {
  isolateFromRepoMsbuild(root);
  const feed = scenario.kind === 'framework' ? '' : await packVersions(root);
  const options = feed
    ? packageOptions(root, feed, '1.0.0')
    : { properties: { LangVersion: 'latest' } };
  const initial = { ...scenario.base, broken: scenario.subject };
  const subject = await writeAccuracyFixture(api, joinPath(root, 'Subject'), initial, options);
  await assertPackageSdkTruth(api, root, scenario, changedOptions(options, scenario));
  return snapshot(subject, scenario, options);
}

/** Only project bytes change; timestamps and existing assemblies remain untouched. */
export function stagePackageSnapshot(fixture: PackageSnapshotFixture, changed: boolean): void {
  const options = changed ? changedOptions(fixture.options, fixture.scenario) : fixture.options;
  const xml = accuracyProjectXml(fixture.subject.scenario, options);
  const before = fs.readFileSync(fixture.project);
  fs.writeFileSync(fixture.project, xml);
  const time = new Date(fixture.projectTime);
  fs.utimesSync(fixture.project, time, time);
  assert.equal(fs.statSync(fixture.project).mtimeMs, fixture.projectTime);
  assert.notDeepEqual(fs.readFileSync(fixture.project), before);
  assert.deepEqual(fs.readFileSync(fixture.project), Buffer.from(xml));
}

/** Inspect only actual SDK output; no diagnostic request may rescue the fixture. */
export function assertSnapshotAssets(fixture: PackageSnapshotFixture, changed: boolean): void {
  assert.equal(fs.statSync(fixture.project).mtimeMs, fixture.projectTime);
  const check =
    fixture.scenario.kind === 'framework' ? assertFrameworkSnapshot : assertPackageSnapshotAssets;
  check(fixture, changed);
}

function assertPackageSnapshotAssets(fixture: PackageSnapshotFixture, changed: boolean): void {
  const assets = readSdkPackageAssets(fixture.assets);
  const reference = fixture.options.packages?.[0];
  assert.ok(reference);
  assert.equal(Boolean(assets.libraries[`${reference.id}/1.0.0`]), !changed);
  assert.equal(
    Boolean(assets.libraries[`${reference.id}/2.0.0`]),
    changed && fixture.scenario.kind === 'version',
  );
}

function assertFrameworkSnapshot(fixture: PackageSnapshotFixture, changed: boolean): void {
  const assets = readSdkPackageAssets(fixture.assets);
  assert.deepEqual(assets.project.restore.originalTargetFrameworks, [
    changed ? 'netstandard2.1' : 'net10.0',
  ]);
}
