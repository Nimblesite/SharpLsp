// Real project-level compiler errors. Implements [DIAG-CATEGORIES-COMPILER], [DIAG-TRUTH-GUARANTEES].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { Diagnostic, WorkspaceDiagnosticReport } from 'vscode-languageclient/node';
import { directoryOf, joinPath, samePath } from '../../paths';
import {
  ACCURACY_CASES,
  accuracyProjectXml,
  activateAccuracyFixture,
  assertClosedProblem,
  assertCompilerProblem,
  teardownAccuracyFixture,
  type AccuracyCase,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { dotnet } from './dotnet-project-kit';
import { setCompilerGenerator, writeCompilerGenerator } from './diagnostic-generator-fixtures';
import { waitForHoverResult } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

interface ProjectCase extends AccuracyCase {
  readonly projectCode: string;
  readonly buildCode: string;
  readonly brokenProperties: Readonly<Record<string, string>>;
  readonly cleanProperties: Readonly<Record<string, string>>;
}
const PROJECT_CASES: readonly ProjectCase[] = [
  {
    ...ACCURACY_CASES[0],
    // FCS startup diagnostics use FS0084; the SDK command-line resolver uses FS0078.
    // Independently verified against the installed compiler APIs and actual SDK build.
    projectCode: 'FS0084',
    buildCode: 'FS0078',
    brokenProperties: { OtherFlags: '--reference:DefinitelyMissingDiagnosticFixture.dll' },
    cleanProperties: { OtherFlags: '' },
  },
  {
    ...ACCURACY_CASES[1],
    projectCode: 'CS5001',
    buildCode: 'CS5001',
    brokenProperties: { OutputType: 'Exe' },
    cleanProperties: { OutputType: 'Library' },
  },
];

/** Start from a proven loaded compiler project, then repair its initial source error. */
async function prepareProjectCase(scenario: ProjectCase): Promise<AccuracyFixture> {
  const fixture = await activateAccuracyFixture('slsp-project-diagnostics-', scenario);
  const document = await vscode.workspace.openTextDocument(fixture.entryUri);
  await vscode.window.showTextDocument(document);
  const hover = await waitForHoverResult(fixture.entryUri, scenario.hover, SIDECAR_COLD_MS);
  assert.ok(hover.length > 0, 'real compiler semantics are ready before changing project inputs');
  await assertClosedProblem(fixture, 1);
  fs.writeFileSync(fixture.closedUri.fsPath, scenario.clean);
  await dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root);
  await assertClosedProblem(fixture, 0);
  return fixture;
}

/** Select the actual compiler code from every full workspace report. */
function projectErrors(report: WorkspaceDiagnosticReport, code: string) {
  return report.items.flatMap((item) =>
    item.kind === 'full'
      ? item.items
          .filter((diagnostic) => diagnostic.code === code)
          .map((diagnostic) => ({ uri: item.uri, diagnostic }))
      : [],
  );
}

/** The compiler owns the severity, source and stable project location. */
function assertProjectDiagnostic(
  fixture: AccuracyFixture,
  project: string,
  item: { uri: string; diagnostic: Diagnostic },
): void {
  assert.ok(samePath(vscode.Uri.parse(item.uri).fsPath, project));
  assert.equal(item.diagnostic.severity, 1);
  assert.equal(item.diagnostic.source, fixture.scenario.sourceTag);
  assert.deepEqual(item.diagnostic.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  });
}

/** Each global compiler error appears once at its project, with a useful stable location. */
async function assertProjectPull(
  fixture: AccuracyFixture,
  project: string,
  count: number,
): Promise<void> {
  const client = fixture.api.getLspClient();
  assert.ok(client);
  const report = await client.sendRequest<WorkspaceDiagnosticReport>('workspace/diagnostic', {
    previousResultIds: [],
  });
  const found = projectErrors(report, fixture.scenario.code);
  assert.equal(
    found.length,
    count,
    'workspace truth contains each real project failure exactly once',
  );
  for (const item of found) {
    assertProjectDiagnostic(fixture, project, item);
  }
}

/** Independently verify project validity with the SDK compiler. */
async function assertProjectBuild(
  fixture: AccuracyFixture,
  scenario: ProjectCase,
  broken: boolean,
): Promise<void> {
  const build = dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root);
  if (broken)
    await assert.rejects(
      build,
      new RegExp(scenario.buildCode),
      'the real compiler rejects this project',
    );
  else await build;
}

/** Change a real project input and compare compiler output, Problems and the workspace pull. */
async function assertProjectStep(
  fixture: AccuracyFixture,
  scenario: ProjectCase,
  broken: boolean,
): Promise<void> {
  const project = joinPath(directoryOf(fixture.entryUri.fsPath), scenario.project);
  const properties = broken ? scenario.brokenProperties : scenario.cleanProperties;
  fs.writeFileSync(project, accuracyProjectXml(scenario, { properties }));
  await assertProjectBuild(fixture, scenario, broken);
  const global = { ...fixture, scenario: { ...scenario, code: scenario.projectCode } };
  await assertCompilerProblem(global, vscode.Uri.file(project), broken ? 1 : 0, 0);
  await assertProjectPull(global, project, broken ? 1 : 0);
  await assertClosedProblem(fixture, 0);
}

for (const scenario of PROJECT_CASES) {
  suite(`Diagnostic accuracy — project errors ${scenario.language}`, () => {
    let fixture: AccuracyFixture;
    suiteSetup(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      fixture = await prepareProjectCase(scenario);
    });
    suiteTeardown(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      await teardownAccuracyFixture(fixture);
    });
    test('project failures appear, clear after repair and return without a window restart', async function () {
      this.timeout(FIXTURE_BUILD_MS + 5 * LSP_RESPONSE_MS);
      for (const broken of [false, true, false, true]) {
        await assertProjectStep(fixture, scenario, broken);
      }
    });
  });
}

suite('Diagnostic accuracy — generated compiler errors', () => {
  let fixture: AccuracyFixture;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const selected = PROJECT_CASES.find((item) => item.language === 'C#');
    assert.ok(selected);
    fixture = await prepareProjectCase(selected);
    writeCompilerGenerator(fixture);
    const client = fixture.api.getLspClient();
    assert.ok(client);
    await client.sendNotification('workspace/didChangeConfiguration', {
      settings: { sharplsp: { diagnostics: { analyzers_enabled: false } } },
    });
  });
  suiteTeardown(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const client = fixture.api.getLspClient();
    assert.ok(client);
    await client.sendNotification('workspace/didChangeConfiguration', { settings: {} });
    await teardownAccuracyFixture(fixture);
  });
  test('real generated compiler errors survive analyzer opt-out and clear when the reference is removed', async function () {
    this.timeout(4 * FIXTURE_BUILD_MS);
    const client = fixture.api.getLspClient();
    assert.ok(client);
    const policy = await client.sendRequest<{ diagnostics: { analyzers_enabled: boolean } }>(
      'sharplsp/configuration',
      {},
    );
    assert.equal(policy.diagnostics.analyzers_enabled, false);
    for (const enabled of [true, false, true]) {
      await assertGeneratorStep(fixture, enabled);
    }
  });
});

async function assertGeneratorStep(fixture: AccuracyFixture, enabled: boolean): Promise<void> {
  const project = setCompilerGenerator(fixture, enabled);
  await dotnet(['restore', fixture.solution, '--nologo'], fixture.root);
  const build = dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root);
  if (enabled) await assert.rejects(build, /CS0029/, 'the SDK compiles the generated source');
  else await build;
  await assertCompilerProblem(fixture, vscode.Uri.file(project), enabled ? 1 : 0, 0);
  await assertProjectPull(fixture, project, enabled ? 1 : 0);
  await assertClosedProblem(fixture, 0);
}
