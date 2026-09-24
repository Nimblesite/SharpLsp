// Real-world C# stress suite #1: serilog/serilog @ v4.4.0 (pinned).
//
// Clones the real repository, restores it, opens real source files in the
// extension host, and hammers the LSP with user interactions — symbols,
// hover, navigation, completion, live edits, diagnostics — asserting on
// every response AND on the server fleet's memory/CPU footprint.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  SERILOG,
  assertSaneRange,
  completionLabel,
  firstError,
  openRepoFile,
  positionOf,
  waitForErrorsCleared,
} from './real-repo-helpers';
import {
  type Anchor,
  assertHoverStorm,
  assertStructure,
  assertSurvivesStorm,
  completeAfterProbe,
  completionLabels,
  useRealRepo,
  assertSymbolSurface,
  assertDefinitionIn,
  assertReferencesSpan,
} from './real-repo-kit';
import { waitForDiagnostics, waitForDocumentSymbols } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

const LOG_CS = 'src/Serilog/Log.cs';
const LOGGER_CONFIGURATION_CS = 'src/Serilog/LoggerConfiguration.cs';
const ILOGGER_CS = 'src/Serilog/ILogger.cs';
const LOGGER: Anchor = ['public static ILogger Logger', 'Logger'];

suite('Real repo stress — serilog (C#)', () => {
  const repoDir = useRealRepo(SERILOG, LOG_CS, LOGGER);

  test('document symbols: Log.cs exposes the real static API surface', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), LOG_CS);
    await assertSymbolSurface(doc, {
      container: 'Log',
      members: ['Logger', 'CloseAndFlush', 'Information', 'Warning', 'Error', 'Debug'],
      minNames: 30,
      minChildren: 20,
    });
  });

  test('hover storm: five real API sites all produce meaningful markdown', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), LOG_CS);
    await assertHoverStorm(doc, [
      LOGGER,
      ['public static ILogger Logger', 'ILogger'],
      ['public static void CloseAndFlush()', 'CloseAndFlush'],
      ['public static void Information(string messageTemplate)', 'Information'],
      ['public static void Information(string messageTemplate)', 'messageTemplate'],
    ]);
  });

  test('navigation: definition and references thread Log.cs -> ILogger.cs', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri } = await openRepoFile(repoDir(), LOG_CS);
    const iloggerUsage = positionOf(doc, 'public static ILogger Logger', 'ILogger');
    await assertDefinitionIn(uri, iloggerUsage, ILOGGER_CS, 'ILogger');
    // ILogger is widely referenced, across multiple files.
    await assertReferencesSpan(uri, iloggerUsage, 3, 2);
  });

  test('live edit + completion: members of the static Log class appear after typing', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, editor } = await openRepoFile(repoDir(), LOG_CS);
    const initialVersion = doc.version;
    // Insert the probe directly before an existing member declaration —
    // Roslyn's recovery completes members reliably there, whereas a probe at
    // the class's closing brace yields only dot-snippet fallbacks.
    const insertAt = positionOf(doc, 'public static void CloseAndFlush()');
    const probe = 'static void SharpLspProbe() { Log.';
    const completions = await completeAfterProbe(editor, insertAt, probe, 'CloseAndFlush');
    assert.ok(doc.version > initialVersion, 'the edit and its undo must bump the document version');
    const labels = completionLabels(completions);
    for (const expected of ['Logger', 'CloseAndFlush', 'Information', 'Error']) {
      assert.ok(
        labels.has(expected),
        `completion after 'Log.' must offer ${expected} — got ${completions.items.length.toString()} items: ` +
          [...labels].slice(0, 25).join(', '),
      );
    }
    assert.ok(completions.items.length >= 5, 'the static class must offer a real member list');
    const method = completions.items.find((item) => completionLabel(item) === 'CloseAndFlush');
    assert.strictEqual(method?.kind, vscode.CompletionItemKind.Method);
    assert.ok(!doc.getText().includes('SharpLspProbe'), 'undo must restore the pristine file');
  });

  test('diagnostics round-trip: a type error surfaces and clears with the edit', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc, uri, editor } = await openRepoFile(repoDir(), LOGGER_CONFIGURATION_CS);
    await waitForDocumentSymbols(uri, LSP_RESPONSE_MS);
    const insertAt = positionOf(doc, 'public class LoggerConfiguration');
    const applied = await editor.edit((edit) => {
      edit.insert(insertAt, 'private static int __sharpLspBad = "not an int";\n');
    });
    assert.ok(applied, 'error-inducing edit must apply');

    try {
      const diagnostics = await waitForDiagnostics(uri, LSP_RESPONSE_MS);
      assert.ok(diagnostics.length >= 1, 'the bad assignment must produce diagnostics');
      const error = firstError(diagnostics, 'bad assignment');
      assertSaneRange(doc, error.range, 'error diagnostic');
      assert.ok(error.message.length > 0, 'diagnostic must carry a message');
    } finally {
      await vscode.commands.executeCommand('undo');
    }
    await waitForErrorsCleared(uri, LSP_RESPONSE_MS);
  });

  test('structure storm: folding, selection ranges, workspace symbols on real files', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), LOG_CS);
    await assertStructure(doc, {
      minFolds: 10,
      anchor: ['public static void CloseAndFlush()', 'CloseAndFlush'],
      minDepth: 2,
      query: 'LoggerConfiguration',
    });
  });

  test('stress: rapid-fire mixed requests stay within memory/CPU bounds', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openRepoFile(repoDir(), LOG_CS);
    await assertSurvivesStorm(doc, LOGGER, 10_000);
  });
});
