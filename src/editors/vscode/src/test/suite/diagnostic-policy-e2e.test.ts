// Real compiler policy. Implements [DIAG-CONFIG], [DIAG-CONFIG-RELOAD], [DIAG-TRUTH-GUARANTEES].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { filePathFromUri, isWithin } from '../../paths';
import type {
  Diagnostic,
  DocumentDiagnosticReport,
  LanguageClient,
  WorkspaceDiagnosticReport,
} from 'vscode-languageclient/node';
import {
  ACCURACY_CASES,
  activateAccuracyFixture,
  assertFileStillClosed,
  assertFullDiagnosticReport,
  describeWorkspaceReport,
  teardownAccuracyFixture,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import { diagnosticCode } from './document-anchors';
import { dotnet } from './dotnet-project-kit';
import { openFixtureDocument } from './refactor-test-helpers';
import { pollUntilResult, waitForHoverResult } from './test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

const POLICY_CASES = [
  {
    scenario: {
      ...ACCURACY_CASES[0],
      broken:
        'module DiagnosticAccuracy.Closed\nlet answer: int = "first"\nlet another: int = "second"\nlet warning () =\n    42\n    43\n',
    },
    warning: 'FS0020',
  },
  {
    scenario: {
      ...ACCURACY_CASES[1],
      broken:
        'namespace DiagnosticAccuracy;\npublic static class Closed {\n    public static int Value => "first";\n    public static int Other => "second";\n    public static void Run() { int unused = 42; }\n}\n',
    },
    warning: 'CS0219',
  },
] as const;

/** The independent SDK build must contain both real compiler severities. */
async function assertPolicyBuildOracle(fixture: AccuracyFixture, warning: string): Promise<void> {
  await assert.rejects(
    dotnet(['build', fixture.solution, '--no-restore', '--nologo'], fixture.root),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(fixture.scenario.code));
      assert.ok(error.message.includes(warning));
      return true;
    },
  );
}

/** Pin exact counts and compiler provenance, including absence of duplicate reports. */
function assertPolicyDiagnostics(
  fixture: AccuracyFixture,
  diagnostics: readonly Diagnostic[],
  errors: number,
  warnings: number,
  found = '',
): void {
  assert.equal(diagnostics.length, errors + warnings, found);
  assert.equal(diagnostics.filter((item) => item.severity === 1).length, errors);
  assert.equal(diagnostics.filter((item) => item.severity === 2).length, warnings);
  const warning = POLICY_CASES.find(
    ({ scenario }) => scenario.language === fixture.scenario.language,
  )?.warning;
  assert.ok(
    diagnostics.every((item) => item.code === fixture.scenario.code || item.code === warning),
  );
  assert.ok(diagnostics.every((item) => item.source === fixture.scenario.sourceTag));
  assert.ok(diagnostics.every((item) => item.range.start.line >= 1));
}

/** The same policy must reach document pulls, workspace pulls and automatic Problems. */
async function assertPolicyTruth(
  fixture: AccuracyFixture,
  client: LanguageClient,
  errors: number,
  warnings: number,
): Promise<void> {
  const direct = await client.sendRequest<DocumentDiagnosticReport>('textDocument/diagnostic', {
    textDocument: { uri: fixture.closedUri.toString() },
  });
  assertFullDiagnosticReport(direct);
  assertPolicyDiagnostics(fixture, direct.items, errors, warnings);
  await assertWorkspacePolicy(fixture, client, errors, warnings);
  await assertProblemsPolicy(fixture, errors, warnings);
  assertFileStillClosed(fixture);
}

/**
 * Every fixture diagnostic comes from the same real two-file compiler fixture,
 * and the severity policy holds across the WHOLE report: a document another
 * suite left open brings its own owning project's diagnostics along, under the
 * same policy (#518).
 */
async function assertWorkspacePolicy(
  fixture: AccuracyFixture,
  client: LanguageClient,
  errors: number,
  warnings: number,
): Promise<void> {
  const report = await client.sendRequest<WorkspaceDiagnosticReport>('workspace/diagnostic', {
    previousResultIds: [],
  });
  assert.ok(report.items.every((item) => item.kind === 'full'));
  const found = describeWorkspaceReport(report);
  const everywhere = report.items.flatMap((item) => (item.kind === 'full' ? item.items : []));
  if (warnings === 0) {
    assert.ok(everywhere.every((item) => item.severity === 1), `only errors remain: ${found}`);
  }
  const owned = report.items.filter((item) => isWithin(filePathFromUri(item.uri), fixture.root));
  const diagnostics = owned.flatMap((item) => (item.kind === 'full' ? item.items : []));
  assertPolicyDiagnostics(fixture, diagnostics, errors, warnings, found);
}

/** Wait for actual Problems convergence, without opening the source that owns the errors. */
async function assertProblemsPolicy(
  fixture: AccuracyFixture,
  errors: number,
  warnings: number,
): Promise<void> {
  const diagnostics = await pollUntilResult(
    async () => vscode.languages.getDiagnostics(fixture.closedUri),
    (items) =>
      items.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length === errors &&
      items.filter((item) => item.severity === vscode.DiagnosticSeverity.Warning).length ===
        warnings,
    LSP_RESPONSE_MS,
  );
  assert.equal(diagnostics.length, errors + warnings);
  assert.ok(diagnostics.every((item) => diagnosticCode(item) !== ''));
  assert.ok(diagnostics.every((item) => item.source === fixture.scenario.sourceTag));
}

for (const { scenario, warning } of POLICY_CASES) {
  suite(`Diagnostic policy contract — ${scenario.language}`, () => {
    let fixture: AccuracyFixture;
    let client: LanguageClient;
    suiteSetup(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      fixture = await activateAccuracyFixture('slsp-diagnostic-policy-', scenario);
      await assertPolicyBuildOracle(fixture, warning);
      // A shared-workspace document with a real CS0219, as other suites leave
      // open: its owner's diagnostics join every workspace report (#518).
      await openFixtureDocument('Refactor.cs');
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(fixture.entryUri),
      );
      assert.ok(
        (await waitForHoverResult(fixture.entryUri, scenario.hover, SIDECAR_COLD_MS)).length,
      );
      const active = fixture.api.getLspClient();
      assert.ok(active);
      client = active;
      await client.sendNotification('workspace/didChangeConfiguration', {
        settings: { sharplsp: { diagnostics: { analyzers_enabled: false } } },
      });
      await assertPolicyTruth(fixture, client, 2, 1);
    });
    suiteTeardown(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      await client.sendNotification('workspace/didChangeConfiguration', {
        settings: { sharplsp: {} },
      });
      await teardownAccuracyFixture(fixture);
    });

    test('severity changes keep compiler errors while removing and restoring warnings', async function () {
      this.timeout(6 * LSP_RESPONSE_MS);
      for (const [min_severity, warnings] of [
        ['error', 0],
        ['warning', 1],
        ['info', 1],
        ['hint', 1],
        ['error', 0],
      ] as const) {
        await client.sendNotification('workspace/didChangeConfiguration', {
          settings: {
            sharplsp: { diagnostics: { analyzers_enabled: false, min_severity, max_per_file: 0 } },
          },
        });
        await assertPolicyTruth(fixture, client, 2, warnings);
      }
    });

    test('per-file limits apply after severity filtering and zero restores every diagnostic', async function () {
      this.timeout(6 * LSP_RESPONSE_MS);
      for (const [max_per_file, errors] of [
        [1, 1],
        [0, 2],
        [2, 2],
        [5, 2],
      ] as const) {
        await client.sendNotification('workspace/didChangeConfiguration', {
          settings: {
            sharplsp: {
              diagnostics: { analyzers_enabled: false, min_severity: 'error', max_per_file },
            },
          },
        });
        await assertPolicyTruth(fixture, client, errors, 0);
      }
    });
  });
}
