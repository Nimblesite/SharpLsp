// Real imported-package inputs, never synthesized assets. [DIAG-RESTORE] [DIAG-TRUTH-GUARANTEES]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { SharpLspExtensionApi } from '../../extension';
import { directoryOf, joinPath } from '../../paths';
import {
  ACCURACY_CASES,
  writeAccuracyFixture,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import {
  assertPackageSdkTruth,
  packDiagnosticPackage,
  packageProjectPaths,
  readSdkPackageAssets,
} from './diagnostic-package-kit';
import { writeRestoreMarker } from './diagnostic-restore-kit';
import { dotnet, projectBuilder, type ProjectOptions } from './dotnet-project-kit';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';

const PACKAGE_ID = 'SharpLsp.DiagnosticRestoreImportFixture';
const RECIPES = [
  {
    version: '1.0.0',
    source:
      'namespace DiagnosticRestore; public static class Api { public static string Render(object value) => "one"; }\n',
  },
  {
    version: '2.0.0',
    source:
      'namespace DiagnosticRestore; public static class Api { public static int Render(object value) => 42; }\n',
  },
] as const;

export const IMPORT_CASES = [
  {
    base: ACCURACY_CASES[0],
    changedCode: 'FS0193',
    subject:
      'module DiagnosticAccuracy.Closed\nlet unrelated: int = "broken"\nlet answer: string = DiagnosticRestore.Api.Render(42)\n',
    oracle:
      'module DiagnosticAccuracy.Closed\nlet answer: string = DiagnosticRestore.Api.Render(42)\n',
  },
  {
    base: ACCURACY_CASES[1],
    changedCode: 'CS0029',
    subject:
      'namespace DiagnosticAccuracy;\npublic static class Closed { public static int Unrelated => "broken"; public static string Answer => DiagnosticRestore.Api.Render(42); }\n',
    oracle:
      'namespace DiagnosticAccuracy;\npublic static class Closed { public static string Answer => DiagnosticRestore.Api.Render(42); }\n',
  },
] as const;
export type ImportCase = (typeof IMPORT_CASES)[number];

export interface ImportedRestoreFixture {
  readonly subject: AccuracyFixture;
  readonly scenario: ImportCase;
  readonly props: string;
  readonly marker: string;
  readonly project: string;
  readonly projectBytes: Buffer;
  readonly projectTime: number;
  readonly assets: string;
}
type ImportedSubject = Pick<ImportedRestoreFixture, 'subject' | 'props' | 'marker'>;

/** Both signatures come from genuine SDK-packed assemblies in one owned feed. */
export async function packVersions(root: string): Promise<string> {
  let feed = '';
  for (const recipe of RECIPES) {
    feed = await packDiagnosticPackage(root, {
      ...recipe,
      id: PACKAGE_ID,
      assembly: 'DiagnosticRestore',
    });
  }
  return feed;
}

/** The imported property is written as XML, without touching the project file. */
export function writeImportedVersion(props: string, version: '1.0.0' | '2.0.0'): void {
  fs.mkdirSync(directoryOf(props), { recursive: true });
  fs.writeFileSync(
    props,
    projectBuilder.build({ Project: { PropertyGroup: { DiagnosticDependencyVersion: version } } }),
  );
}

export function packageOptions(root: string, feed: string, version: string): ProjectOptions {
  return {
    packages: [{ id: PACKAGE_ID, version }],
    properties: {
      RestoreAdditionalProjectSources: feed,
      RestorePackagesPath: joinPath(root, 'packages'),
    },
  };
}

function importedOptions(root: string, feed: string, props: string): ProjectOptions {
  return {
    ...packageOptions(root, feed, '$(DiagnosticDependencyVersion)'),
    imports: [props, joinPath(root, 'Directory.Build.targets')],
  };
}

async function createSubject(
  api: SharpLspExtensionApi,
  root: string,
  scenario: ImportCase,
  feed: string,
): Promise<ImportedSubject> {
  const marker = writeRestoreMarker(root);
  const directory = joinPath(root, 'Subject');
  const props = joinPath(directory, 'Package.props');
  writeImportedVersion(props, '1.0.0');
  const options = importedOptions(root, feed, props);
  const initial = { ...scenario.base, broken: scenario.subject };
  const subject = await writeAccuracyFixture(api, directory, initial, options);
  return { subject, props, marker };
}

function snapshot(data: ImportedSubject, scenario: ImportCase): ImportedRestoreFixture {
  const { subject } = data;
  const { project, assets } = packageProjectPaths(subject);
  return {
    ...data,
    scenario,
    project,
    assets,
    projectBytes: fs.readFileSync(project),
    projectTime: fs.statSync(project).mtimeMs,
  };
}

/** The subject retains the SDK's v1 snapshot while an independent v2 oracle fails compilation. */
export async function prepareImportedRestore(
  api: SharpLspExtensionApi,
  root: string,
  scenario: ImportCase,
): Promise<ImportedRestoreFixture> {
  isolateFromRepoMsbuild(root);
  const feed = await packVersions(root);
  const data = await createSubject(api, root, scenario, feed);
  const fixture = snapshot(data, scenario);
  await dotnet(['restore', fixture.project, '--nologo'], root);
  assert.ok(fs.existsSync(fixture.marker), 'the SDK executes the imported Restore observer');
  const oracleOptions = packageOptions(root, feed, '2.0.0');
  await assertPackageSdkTruth(api, root, scenario, oracleOptions);
  return fixture;
}

/** SDK output proves the selected package identity without using a language-server query. */
export function assertImportedAssets(
  fixture: ImportedRestoreFixture,
  version: '1.0.0' | '2.0.0',
): void {
  const assets = readSdkPackageAssets(fixture.assets);
  assert.ok(assets.libraries[`${PACKAGE_ID}/${version}`]);
  assert.equal(fs.statSync(fixture.project).mtimeMs, fixture.projectTime);
  assert.deepEqual(fs.readFileSync(fixture.project), fixture.projectBytes);
}

/** The only changed compiler input is newer than actual SDK assets; its project stays untouched. */
export function stageImportedVersion(
  fixture: ImportedRestoreFixture,
  version: '1.0.0' | '2.0.0',
): void {
  fs.unlinkSync(fixture.marker);
  writeImportedVersion(fixture.props, version);
  const assetsTime = fs.statSync(fixture.assets).mtimeMs;
  const changed = new Date(Math.max(Date.now(), assetsTime + 1));
  fs.utimesSync(fixture.props, changed, changed);
  assert.ok(fs.statSync(fixture.props).mtimeMs > assetsTime);
  assert.equal(fs.statSync(fixture.project).mtimeMs, fixture.projectTime);
}
