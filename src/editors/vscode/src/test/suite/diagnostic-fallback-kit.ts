// Real SDK cache locations, never synthesized assets. [PKG-ASSETS-FS] [DIAG-TRUTH-GUARANTEES]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { SharpLspExtensionApi } from '../../extension';
import { directoryOf, joinPath, samePath } from '../../paths';
import {
  ACCURACY_CASES,
  loadAccuracyFixture,
  writeAccuracyFixture,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { buildProjectXml, dotnet, writeProject, type ProjectOptions } from './dotnet-project-kit';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';
import { packDiagnosticPackage, readSdkPackageAssets } from './diagnostic-package-kit';

const PACKAGE = { id: 'SharpLsp.DiagnosticFallbackFixture', version: '1.0.0' };
const PACKAGE_KEY = 'SharpLsp.DiagnosticFallbackFixture/1.0.0';
const PACKAGE_PATH = 'sharplsp.diagnosticfallbackfixture/1.0.0';
const COMPILE_PATH = 'lib/net10.0/DiagnosticFallback.dll';
const PACKAGE_SOURCE =
  'namespace DiagnosticFallback; public static class Api { public static string Render(object value) => "fallback"; }\n';
export const FALLBACK_CASE = {
  ...ACCURACY_CASES[0],
  broken: 'module DiagnosticAccuracy.Closed\nlet answer: int = DiagnosticFallback.Api.Render(42)\n',
  clean:
    'module DiagnosticAccuracy.Closed\nlet answer: string = DiagnosticFallback.Api.Render(42)\n',
  code: 'FS0193',
};

export interface FallbackFixture {
  readonly primary: AccuracyFixture;
  readonly external: AccuracyFixture;
  readonly primaryCache: string;
  readonly fallback: string;
}

/** Restore the local package with the SDK, preserving its real NuGet cache layout. */
async function seedFallback(root: string): Promise<string> {
  const feed = await packDiagnosticPackage(root, {
    ...PACKAGE,
    assembly: 'DiagnosticFallback',
    source: PACKAGE_SOURCE,
  });
  const fallback = joinPath(root, 'fallback');
  const seed = writeProject(
    joinPath(root, 'Seed'),
    'Seed.csproj',
    buildProjectXml({ packages: [PACKAGE] }),
    'Empty.cs',
    'public class Empty {}\n',
  );
  const project = joinPath(seed, 'Seed.csproj');
  await dotnet(['restore', project, '--packages', fallback, '--source', feed], root);
  assert.ok(fs.existsSync(joinPath(fallback, PACKAGE_PATH, COMPILE_PATH)));
  return fallback;
}

/** Project-level fallback input is recorded by NuGet alongside the empty primary. */
function fallbackOptions(primary: string, fallback: string): ProjectOptions {
  return {
    packages: [PACKAGE],
    properties: { RestorePackagesPath: primary, RestoreAdditionalProjectFallbackFolders: fallback },
  };
}

/** An already-active F# solution adopts an independent package-bearing F# owner. */
export async function prepareFallbackFixture(
  api: SharpLspExtensionApi,
  root: string,
): Promise<FallbackFixture> {
  isolateFromRepoMsbuild(root);
  const fallback = await seedFallback(root);
  const primaryCache = joinPath(root, 'empty-primary');
  const primary = await writeAccuracyFixture(api, joinPath(root, 'Selected'), ACCURACY_CASES[0]);
  const options = fallbackOptions(primaryCache, fallback);
  const externalRoot = joinPath(root, 'External');
  const external = await writeAccuracyFixture(api, externalRoot, FALLBACK_CASE, options);
  const fixture = { primary, external, primaryCache, fallback };
  assertFallbackAssets(fixture);
  await loadAccuracyFixture(primary);
  return fixture;
}

/** Check SDK-generated target/library metadata before testing editor behavior. */
function readPackageAssets(fixture: AccuracyFixture): ReturnType<typeof readSdkPackageAssets> {
  const path = joinPath(directoryOf(fixture.closedUri.fsPath), 'obj', 'project.assets.json');
  const assets = readSdkPackageAssets(path);
  assert.equal(assets.libraries[PACKAGE_KEY]?.path, PACKAGE_PATH);
  assert.ok(assets.targets['net10.0']?.[PACKAGE_KEY]?.compile?.[COMPILE_PATH] !== undefined);
  return assets;
}

/** The real assembly lives only in a later SDK-declared package folder. */
export function assertFallbackAssets(fixture: FallbackFixture): void {
  const roots = Object.keys(readPackageAssets(fixture.external).packageFolders);
  assert.ok(roots.length >= 2);
  assert.ok(samePath(roots[0] ?? '', fixture.primaryCache));
  assert.ok(roots.some((root) => samePath(root, fixture.fallback)));
  assert.equal(fs.existsSync(joinPath(fixture.primaryCache, PACKAGE_PATH, COMPILE_PATH)), false);
  assert.equal(fs.existsSync(joinPath(fixture.fallback, PACKAGE_PATH, COMPILE_PATH)), true);
}
