// An unavailable SDK context cannot become compiler truth. [DIAG-TRUTH-GUARANTEES]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { ResponseError } from 'vscode-languageclient/node';
import { directoryOf, joinPath } from '../../paths';
import {
  readClosedDiagnosticReport,
  retryIncompleteDiagnostic,
  useAccuracyTeardown,
} from './diagnostic-accuracy-fixtures';
import { assertPackageProblems } from './diagnostic-package-kit';
import {
  SNAPSHOT_CASES,
  preparePackageSnapshot,
  stagePackageSnapshot,
  type PackageSnapshotFixture,
} from './diagnostic-package-snapshot-kit';
import { dotnet, projectBuilder } from './dotnet-project-kit';
import { loadSolutionInServer } from './real-repo-helpers';
import { useScratchSuite } from './test-explorer-harness';
import { pollUntilResult } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

const CONTEXT_TARGET = {
  '@_Name': 'ObserveDiagnosticDesignTimeContext',
  '@_BeforeTargets': 'CoreCompile',
  '@_Condition': "'$(DesignTimeBuild)' == 'true'",
  WriteLinesToFile: {
    '@_File': '$(MSBuildThisFileDirectory)sdk-context-entered.txt',
    '@_Lines': 'entered',
    '@_Overwrite': 'True',
  },
  Error: { '@_Text': 'SDK diagnostic context is unavailable', '@_Code': 'SLSPTEST1001' },
};
const DESIGN_TIME_ARGS = [
  '-nologo',
  '-t:ResolveReferences;CoreCompile',
  '-p:DesignTimeBuild=true',
  '-p:SkipCompilerExecution=true',
  '-p:ProvideCommandLineArgs=true',
];

/** The SDK itself owns the failure; normal restore and property evaluation still work. */
function setContextTarget(fixture: PackageSnapshotFixture, failed: boolean): string {
  const root = directoryOf(fixture.project);
  const errorTask = {
    ...CONTEXT_TARGET.Error,
    '@_Condition': failed ? "'1' == '1'" : "'1' == '0'",
  };
  const target = { ...CONTEXT_TARGET, Error: errorTask };
  fs.writeFileSync(
    joinPath(root, 'Directory.Build.targets'),
    projectBuilder.build({ Project: { Target: target } }),
  );
  return joinPath(root, 'sdk-context-entered.txt');
}

/** Exercise the real SDK target independently before observing the server's own attempt. */
async function assertDesignTimeContext(
  fixture: PackageSnapshotFixture,
  failed: boolean,
): Promise<void> {
  const build = dotnet(
    ['msbuild', fixture.project, ...DESIGN_TIME_ARGS],
    directoryOf(fixture.project),
  );
  if (failed) await assert.rejects(build, /SLSPTEST1001/);
  else await build;
}

/** A fresh marker distinguishes the real sidecar attempt from the independent SDK oracle. */
async function loadContext(fixture: PackageSnapshotFixture, failed: boolean): Promise<void> {
  const marker = setContextTarget(fixture, failed);
  await assertDesignTimeContext(fixture, failed);
  assert.ok(fs.existsSync(marker), 'the independent SDK actually executed the target');
  fs.rmSync(marker);
  assert.equal(fs.existsSync(marker), false);
  await loadSolutionInServer(fixture.subject.solution);
  await pollUntilResult(
    async () => fs.existsSync(marker),
    (exists) => exists,
    LSP_RESPONSE_MS,
    100,
    'the sidecar must independently reach the same SDK target',
  );
}

/** Retry only explicit supersession; never wait for a successful but incomplete answer to change. */
function retriggerOnly(error: unknown): undefined {
  if (error instanceof ResponseError && error.code === -32802) {
    retryIncompleteDiagnostic(error);
    return undefined;
  }
  throw error;
}

/** The actual SDK failure remains actionable rather than masquerading as source diagnostics. */
function assertContextError(error: unknown): boolean {
  assert.ok(error instanceof ResponseError);
  assert.equal(error.code, -32603);
  assert.ok(error.message.includes('SLSPTEST1001'), 'retain the actual SDK failure');
  return true;
}

/** Document and solution APIs share the same honest failure contract. */
async function assertUnavailable(fixture: PackageSnapshotFixture): Promise<void> {
  const client = fixture.subject.api.getLspClient();
  assert.ok(client);
  for (const [method, params] of [
    ['textDocument/diagnostic', { textDocument: { uri: fixture.subject.closedUri.toString() } }],
    ['workspace/diagnostic', { previousResultIds: [] }],
  ] as const) {
    const query = () => client.sendRequest(method, params).catch(retriggerOnly);
    await assert.rejects(
      pollUntilResult(query, (result) => result !== undefined, LSP_RESPONSE_MS),
      assertContextError,
    );
  }
}

/** SDK truth survives failure and recovery without reusing an earlier report identity. */
async function contextCycle(fixture: PackageSnapshotFixture): Promise<void> {
  await loadContext(fixture, false);
  await assertPackageProblems(fixture, true);
  const before = await readClosedDiagnosticReport(fixture.subject);
  assert.equal(before.items.filter((item) => item.severity === 1).length, 2);
  await loadContext(fixture, true);
  await assertUnavailable(fixture);
  await loadContext(fixture, false);
  await assertPackageProblems(fixture, true);
  const after = await readClosedDiagnosticReport(fixture.subject);
  assert.equal(after.items.filter((item) => item.severity === 1).length, 2);
  assert.notEqual(after.resultId, before.resultId, 'SDK repair must have a fresh result identity');
}

suite('Diagnostic accuracy — unavailable SDK context', () => {
  let fixture: PackageSnapshotFixture;
  useAccuracyTeardown(() => fixture?.subject);
  useScratchSuite('slsp-sdk-context-', async ({ api, root }) => {
    const scenario = SNAPSHOT_CASES.find(
      (item) => item.kind === 'framework' && item.base.language === 'F#',
    );
    assert.ok(scenario);
    fixture = await preparePackageSnapshot(api, root, scenario);
    stagePackageSnapshot(fixture, true);
    await dotnet(['restore', fixture.project, '--nologo'], directoryOf(fixture.project));
  });
  test('SDK design-time failures reject diagnostics and recover without framework-only guesses', async function () {
    this.timeout(10 * LSP_RESPONSE_MS);
    await contextCycle(fixture);
  });
});
