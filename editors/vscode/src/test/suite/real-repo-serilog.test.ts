// Real-world C# stress suite #1: serilog/serilog @ v4.4.0 (pinned).
//
// Clones the real repository, restores it, opens real source files in the
// extension host, and hammers the LSP with user interactions — symbols,
// hover, navigation, completion, live edits, diagnostics — asserting on
// every response AND on the server fleet's memory/CPU footprint.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hoverText } from './fsharp-helpers';
import {
  SERILOG,
  assertCpuSettles,
  assertSaneRange,
  assertServerResourceBounds,
  ensureRepoReady,
  completionLabel,
  firstError,
  firstLocation,
  fixtureSolutionPath,
  loadSolutionInServer,
  openRepoFile,
  positionOf,
  sampleServerProcesses,
  selectionDepth,
  waitForErrorsCleared,
  waitForSemanticReady,
} from './real-repo-helpers';
import {
  closeAllEditors,
  flattenSymbolNames,
  pollUntilResult,
  waitForDiagnostics,
  waitForDocumentSymbols,
  waitForFoldingRanges,
  waitForHoverResult,
  waitForSelectionRanges,
} from './test-helpers';

const LOG_CS = 'src/Serilog/Log.cs';
const LOGGER_CONFIGURATION_CS = 'src/Serilog/LoggerConfiguration.cs';
const ILOGGER_CS = 'src/Serilog/ILogger.cs';

suite('Real repo stress — serilog (C#)', () => {
  let repoDir: string;

  suiteSetup(async function () {
    this.timeout(900_000);
    repoDir = ensureRepoReady(SERILOG);
    // Point the sidecars at the real solution (the server's workspace root is
    // the fixture workspace), then wait for actual semantics, not just syntax.
    await loadSolutionInServer(path.join(repoDir, SERILOG.sln));
    const { doc, uri } = await openRepoFile(repoDir, LOG_CS);
    await waitForDocumentSymbols(uri, 120_000);
    await waitForSemanticReady(uri, positionOf(doc, 'public static ILogger Logger', 'Logger'), 600_000);
  });

  suiteTeardown(async function () {
    this.timeout(120_000);
    await closeAllEditors();
    // Downstream suites rely on the fixture solution's semantics.
    await loadSolutionInServer(fixtureSolutionPath());
  });

  test('document symbols: Log.cs exposes the real static API surface', async function () {
    this.timeout(120_000);
    const { doc, uri } = await openRepoFile(repoDir, LOG_CS);
    const symbols = await waitForDocumentSymbols(uri, 120_000);
    const names = flattenSymbolNames(symbols);

    assert.ok(names.includes('Log'), 'static Log class must be present');
    for (const member of ['Logger', 'CloseAndFlush', 'Information', 'Warning', 'Error', 'Debug']) {
      assert.ok(names.includes(member), `Log.cs must expose ${member}`);
    }
    assert.ok(names.length >= 30, `expected a rich symbol tree, got ${names.length.toString()}`);

    const logClass = findSymbol(symbols, 'Log');
    assert.ok(logClass, 'Log symbol resolvable');
    assert.ok(logClass.children.length >= 20, 'Log class must have many members');
    assertSaneRange(doc, logClass.range, 'Log class range');
    for (const child of logClass.children.slice(0, 10)) {
      assertSaneRange(doc, child.range, `member ${child.name}`);
      assert.ok(
        logClass.range.contains(child.range),
        `member ${child.name} must nest inside the Log class`,
      );
    }
  });

  test('hover storm: five real API sites all produce meaningful markdown', async function () {
    this.timeout(180_000);
    const { doc, uri } = await openRepoFile(repoDir, LOG_CS);
    const anchors: [string, string][] = [
      ['public static ILogger Logger', 'Logger'],
      ['public static ILogger Logger', 'ILogger'],
      ['public static void CloseAndFlush()', 'CloseAndFlush'],
      ['public static void Information(string messageTemplate)', 'Information'],
      ['public static void Information(string messageTemplate)', 'messageTemplate'],
    ];
    for (const [snippet, focus] of anchors) {
      const hover = await waitForHoverResult(uri, positionOf(doc, snippet, focus), 60_000);
      const text = hoverText(hover);
      assert.ok(text.length > 0, `hover on '${focus}' must not be empty`);
      assert.ok(
        text.toLowerCase().includes(focus.toLowerCase()),
        `hover on '${focus}' must mention it, got: ${text.slice(0, 200)}`,
      );
    }
  });

  test('navigation: definition and references thread Log.cs -> ILogger.cs', async function () {
    this.timeout(180_000);
    const { doc, uri } = await openRepoFile(repoDir, LOG_CS);
    const iloggerUsage = positionOf(doc, 'public static ILogger Logger', 'ILogger');

    const definitions = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          uri,
          iloggerUsage,
        )) ?? [],
      (locations) => locations.length > 0,
      120_000,
      2_000,
    );
    const definition = firstLocation(definitions, 'ILogger definition');
    const defPath = definition.uri.fsPath.replace(/\\/g, '/');
    assert.ok(defPath.endsWith(ILOGGER_CS), `definition must land in ILogger.cs, got ${defPath}`);
    const defDoc = await vscode.workspace.openTextDocument(definition.uri);
    assertSaneRange(defDoc, definition.range, 'ILogger definition');
    assert.ok(
      defDoc.getText(definition.range).includes('ILogger'),
      'definition range must cover the ILogger identifier',
    );

    const references = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          uri,
          iloggerUsage,
        )) ?? [],
      (locations) => locations.length >= 3,
      120_000,
      2_000,
    );
    assert.ok(references.length >= 3, `ILogger must be widely referenced, got ${references.length.toString()}`);
    const files = new Set(references.map((ref) => ref.uri.fsPath));
    assert.ok(files.size >= 2, 'references must span multiple files');
  });

  test('live edit + completion: members of the static Log class appear after typing', async function () {
    this.timeout(180_000);
    const { doc, uri, editor } = await openRepoFile(repoDir, LOG_CS);
    const initialVersion = doc.version;
    // Insert the probe directly before an existing member declaration —
    // Roslyn's recovery completes members reliably there, whereas a probe at
    // the class's closing brace yields only dot-snippet fallbacks.
    const insertAt = positionOf(doc, 'public static void CloseAndFlush()');
    const probe = 'static void SharpLspProbe() { Log.';
    const applied = await editor.edit((edit) => {
      edit.insert(insertAt, probe);
    });
    assert.ok(applied, 'probe edit must apply');
    assert.ok(doc.version > initialVersion, 'edit must bump the document version');

    try {
      const cursor = doc.positionAt(doc.getText().indexOf(probe) + probe.length);
      const completions = await pollUntilResult(
        async () =>
          (await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            uri,
            cursor,
            '.',
          )) ?? new vscode.CompletionList(),
        (list) => list.items.some((item) => completionLabel(item) === 'CloseAndFlush'),
        120_000,
        2_000,
      );
      const labels = new Set(completions.items.map(completionLabel));
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
    } finally {
      await vscode.commands.executeCommand('undo');
    }
    assert.ok(!doc.getText().includes('SharpLspProbe'), 'undo must restore the pristine file');
  });

  test('diagnostics round-trip: a type error surfaces and clears with the edit', async function () {
    this.timeout(180_000);
    const { doc, uri, editor } = await openRepoFile(repoDir, LOGGER_CONFIGURATION_CS);
    await waitForDocumentSymbols(uri, 120_000);
    const anchor = 'public class LoggerConfiguration';
    const insertAt = positionOf(doc, anchor);
    const applied = await editor.edit((edit) => {
      edit.insert(insertAt, 'private static int __sharpLspBad = "not an int";\n');
    });
    assert.ok(applied, 'error-inducing edit must apply');

    try {
      const diagnostics = await waitForDiagnostics(uri, 120_000);
      assert.ok(diagnostics.length >= 1, 'the bad assignment must produce diagnostics');
      const error = firstError(diagnostics, 'bad assignment');
      assertSaneRange(doc, error.range, 'error diagnostic');
      assert.ok(error.message.length > 0, 'diagnostic must carry a message');
    } finally {
      await vscode.commands.executeCommand('undo');
    }
    await waitForErrorsCleared(uri, 120_000);
  });

  test('structure storm: folding, selection ranges, workspace symbols on real files', async function () {
    this.timeout(180_000);
    const { doc, uri } = await openRepoFile(repoDir, LOG_CS);
    const folding = await waitForFoldingRanges(uri, 60_000);
    assert.ok(folding.length >= 10, `Log.cs must fold richly, got ${folding.length.toString()}`);
    for (const range of folding.slice(0, 10)) {
      assert.ok(range.start <= range.end, 'folding range must be ordered');
      assert.ok(range.end < doc.lineCount, 'folding range must stay in the file');
    }

    const selections = await waitForSelectionRanges(
      uri,
      [positionOf(doc, 'public static void CloseAndFlush()', 'CloseAndFlush')],
      60_000,
    );
    const depth = selectionDepth(selections[0], 'CloseAndFlush selection');
    assert.ok(depth >= 2, `selection range must expand through nesting, depth ${depth.toString()}`);

    const workspaceSymbols = await pollUntilResult(
      async () =>
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          'LoggerConfiguration',
        )) ?? [],
      (symbols) => symbols.length > 0,
      120_000,
      2_000,
    );
    assert.ok(
      workspaceSymbols.some((symbol) => symbol.name.includes('LoggerConfiguration')),
      'workspace symbol search must find LoggerConfiguration',
    );
  });

  test('stress: rapid-fire mixed requests stay within memory/CPU bounds', async function () {
    this.timeout(300_000);
    const { doc, uri } = await openRepoFile(repoDir, LOG_CS);
    const hoverAt = positionOf(doc, 'public static ILogger Logger', 'Logger');

    for (let round = 0; round < 10; round += 1) {
      const [symbols, hover, folding] = await Promise.all([
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri),
        vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, hoverAt),
        vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', uri),
      ]);
      assert.ok((symbols ?? []).length > 0, `round ${round.toString()}: symbols must keep answering`);
      assert.ok((hover ?? []).length > 0, `round ${round.toString()}: hover must keep answering`);
      assert.ok((folding ?? []).length > 0, `round ${round.toString()}: folding must keep answering`);
    }

    const fleet = sampleServerProcesses();
    assertServerResourceBounds(fleet);
    await assertCpuSettles(5_000, 20);

    const after = await waitForDocumentSymbols(uri, 10_000);
    assert.ok(after.length > 0, 'server must stay responsive after the storm');
  });
});

function findSymbol(symbols: vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.name === name) return symbol;
    const nested = findSymbol(symbol.children, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

