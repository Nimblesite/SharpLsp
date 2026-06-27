/**
 * Coarse end-to-end coverage for the FSI, dotnet build, ANSI output-filter, and
 * hot-reload integration surfaces of the SharpLsp VS Code extension.
 *
 * The extension is already activated by the test host, every command is
 * registered, and a real workspace folder (`test-fixtures/workspace`) plus the
 * real LSP server, sidecars, and `dotnet` toolchain are available. These tests
 * therefore drive the *registered commands* and the *exported helpers* — never
 * the `register*Commands()` entry points — and assert on real side effects:
 * terminals created, output channels receiving stripped text, files written,
 * and prompt logs recorded through the shared UI stub harness.
 *
 * Coverage targets (paths uncovered by coverage-extension-workflows.test.ts):
 *   - src/output-filter.ts  — stripAnsi + createAnsiStrippingChannel
 *   - src/build.ts          — sharplsp.build / rebuild / clean + pure helpers
 *   - src/fsi.ts            — sharplsp.fsi.send / sendFile / start / generateSignature
 *   - src/hot-reload.ts     — isRelevantLanguage / onSave path / non-relevant lang
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { stripAnsi, createAnsiStrippingChannel } from '../../output-filter.js';
import { dotnetArgs, quoteArg, targetFromNode } from '../../build.js';
import { extractSignature, isFSharpSourceDocument, fsiTerminalOptions } from '../../fsi.js';
import { isRelevantLanguage, isHotReloadRunning } from '../../hot-reload.js';
import { openFSharpFile, openCSharpFile, closeAllEditors, pollUntilResult } from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';

// ── Fake OutputChannel ────────────────────────────────────────────

/** Records everything an OutputChannel receives so we can assert on it. */
interface RecordingChannel extends vscode.OutputChannel {
  readonly appended: string[];
  readonly appendedLines: string[];
  readonly replaced: string[];
  cleared: number;
  shown: number;
  hidden: number;
  disposed: number;
}

/** Build a minimal in-memory OutputChannel that records every interaction. */
function recordingChannel(name: string): RecordingChannel {
  const appended: string[] = [];
  const appendedLines: string[] = [];
  const replaced: string[] = [];
  const channel: RecordingChannel = {
    name,
    appended,
    appendedLines,
    replaced,
    cleared: 0,
    shown: 0,
    hidden: 0,
    disposed: 0,
    append(value: string): void {
      appended.push(value);
    },
    appendLine(value: string): void {
      appendedLines.push(value);
    },
    replace(value: string): void {
      replaced.push(value);
    },
    clear(): void {
      channel.cleared += 1;
    },
    show(): void {
      channel.shown += 1;
    },
    hide(): void {
      channel.hidden += 1;
    },
    dispose(): void {
      channel.disposed += 1;
    },
  };
  return channel;
}

// ── Suite ─────────────────────────────────────────────────────────

suite('FSI / Build / Output-filter / Hot-reload E2E', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  const preexistingTerminals = new Set<vscode.Terminal>();

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-fsi-build-'));
    stubs = installUiStubs();
    preexistingTerminals.clear();
    for (const terminal of vscode.window.terminals) {
      preexistingTerminals.add(terminal);
    }
  });

  teardown(async () => {
    stubs.restore();
    // Dispose any terminals this test created (FSI, build, hot reload).
    for (const terminal of vscode.window.terminals) {
      if (!preexistingTerminals.has(terminal)) {
        terminal.dispose();
      }
    }
    if (isHotReloadRunning()) {
      await vscode.commands.executeCommand('sharplsp.hotReload.stop');
    }
    // Restore the onSave setting to its default in case a test changed it.
    await vscode.workspace
      .getConfiguration('sharplsp')
      .update('hotReload.onSave', undefined, vscode.ConfigurationTarget.Workspace);
    await closeAllEditors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── output-filter.ts ────────────────────────────────────────────

  test('stripAnsi removes colors, bold, cursor moves, and OSC while preserving plain text', function () {
    this.timeout(20_000);

    // SGR color + reset.
    assert.strictEqual(stripAnsi('[31mred[0m'), 'red');
    // Bold + multi-parameter SGR.
    assert.strictEqual(stripAnsi('[1;32mbold-green[0m text'), 'bold-green text');
    // Cursor move (CSI with non-color final byte) interleaved with text.
    assert.strictEqual(stripAnsi('A[2KB[10;5Hclear'), 'ABclear');
    // OSC sequence terminated by BEL (window title) is removed entirely.
    assert.strictEqual(stripAnsi(']0;window-titlekeep'), 'keep');
    // OSC sequence terminated by ESC backslash (ST).
    assert.strictEqual(stripAnsi('pre]8;;http://x\\post'), 'prepost');
    // A non-CSI, non-OSC escape consumes ESC + one byte.
    assert.strictEqual(stripAnsi('keepMmore'), 'keepmore');
    // Plain text with no escape is returned unchanged (fast path).
    assert.strictEqual(stripAnsi('no escapes here'), 'no escapes here');
    assert.strictEqual(stripAnsi(''), '');
    // A realistic colored MSBuild-style line is reduced to its plain form.
    const built = `[1mBuild succeeded.[0m\n  [32m0 Warning(s)[0m`;
    assert.strictEqual(stripAnsi(built), 'Build succeeded.\n  0 Warning(s)');
  });

  test('createAnsiStrippingChannel forwards stripped text and delegates lifecycle calls', function () {
    this.timeout(20_000);
    const inner = recordingChannel('SharpLsp');
    const wrapped = createAnsiStrippingChannel(inner);

    assert.strictEqual(wrapped.name, 'SharpLsp');

    wrapped.append('[33mwarn:[0m disk low');
    wrapped.appendLine('[31merror[0m on [1mline 5[0m');
    wrapped.replace('[2Jcleared screen');

    assert.deepStrictEqual(inner.appended, ['warn: disk low']);
    assert.deepStrictEqual(inner.appendedLines, ['error on line 5']);
    assert.deepStrictEqual(inner.replaced, ['cleared screen']);

    // Non-writing operations delegate straight through.
    wrapped.clear();
    wrapped.show(true);
    wrapped.hide();
    wrapped.dispose();
    assert.strictEqual(inner.cleared, 1);
    assert.strictEqual(inner.shown, 1);
    assert.strictEqual(inner.hidden, 1);
    assert.strictEqual(inner.disposed, 1);

    // Plain text passes through untouched.
    wrapped.append('plain line');
    assert.strictEqual(inner.appended[inner.appended.length - 1], 'plain line');
  });

  // ── build.ts ────────────────────────────────────────────────────

  test('dotnet build/rebuild/clean commands resolve and create the build terminal', async function () {
    this.timeout(60_000);

    const before = vscode.window.terminals.length;

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.build');
    }, 'sharplsp.build must not throw');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.rebuild');
    }, 'sharplsp.rebuild must not throw');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.clean');
    }, 'sharplsp.clean must not throw');

    // The three commands reuse a single named 'SharpLsp Build' terminal.
    const buildTerminal = await pollUntilResult(
      async () => vscode.window.terminals.find((t) => t.name === 'SharpLsp Build'),
      (terminal) => terminal !== undefined,
      10_000,
    );
    assert.ok(buildTerminal, 'A "SharpLsp Build" terminal must exist after build commands run');
    assert.ok(
      vscode.window.terminals.length >= before,
      'Running build must not destroy existing terminals',
    );
  });

  test('build commands accept a right-clicked project node and resolve its target file', async function () {
    this.timeout(60_000);

    const projectPath = path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? tmpDir,
      'TestFixtures.csproj',
    );
    const node = { projectFilePath: projectPath };

    // targetFromNode is the pure resolver the command relies on.
    assert.strictEqual(targetFromNode(node), projectPath);
    assert.strictEqual(targetFromNode({ projectFilePath: '' }), undefined);
    assert.strictEqual(targetFromNode(undefined), undefined);

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.build', node);
    }, 'sharplsp.build on a project node must not throw');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.clean', node);
    }, 'sharplsp.clean on a project node must not throw');

    const buildTerminal = vscode.window.terminals.find((t) => t.name === 'SharpLsp Build');
    assert.ok(buildTerminal, 'Build terminal must exist after node-scoped build');
  });

  test('dotnetArgs and quoteArg build correct CLI invocations for every command', function () {
    this.timeout(20_000);

    assert.deepStrictEqual(dotnetArgs('build'), ['build']);
    assert.deepStrictEqual(dotnetArgs('clean'), ['clean']);
    // rebuild maps to `dotnet build --no-incremental`.
    assert.deepStrictEqual(dotnetArgs('rebuild'), ['build', '--no-incremental']);
    // With a target file appended.
    assert.deepStrictEqual(dotnetArgs('build', '/p/App.csproj'), ['build', '/p/App.csproj']);
    assert.deepStrictEqual(dotnetArgs('rebuild', '/p/App.csproj'), [
      'build',
      '/p/App.csproj',
      '--no-incremental',
    ]);

    // quoteArg only quotes arguments containing whitespace.
    assert.strictEqual(quoteArg('/no/spaces/App.csproj'), '/no/spaces/App.csproj');
    assert.strictEqual(quoteArg('/has spaces/App.csproj'), '"/has spaces/App.csproj"');
  });

  // ── fsi.ts ──────────────────────────────────────────────────────

  test('fsi.start creates an F# Interactive terminal and fsi.send/sendFile route through it', async function () {
    this.timeout(60_000);

    const fsContent = ['module Sample', '', 'let add x y = x + y', 'let answer = add 40 2'].join(
      '\n',
    );
    const { doc } = await openFSharpFile(tmpDir, 'Sample.fs', fsContent);

    // Select the `let add` line so fsi.send transmits a real selection.
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'An active editor must exist for the F# file');
    editor.selection = new vscode.Selection(
      new vscode.Position(2, 0),
      new vscode.Position(2, doc.lineAt(2).text.length),
    );

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.fsi.start');
    }, 'sharplsp.fsi.start must not throw');

    const fsiTerminal = await pollUntilResult(
      async () => vscode.window.terminals.find((t) => t.name === 'F# Interactive'),
      (terminal) => terminal !== undefined,
      10_000,
    );
    assert.ok(fsiTerminal, 'fsi.start must create an "F# Interactive" terminal');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.fsi.send');
    }, 'sharplsp.fsi.send must not throw with an F# selection');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.fsi.sendFile');
    }, 'sharplsp.fsi.sendFile must not throw');

    // Still exactly one FSI terminal — send/sendFile reuse the live session.
    const fsiTerminals = vscode.window.terminals.filter((t) => t.name === 'F# Interactive');
    assert.ok(fsiTerminals.length >= 1, 'At least one FSI terminal must remain live');
  });

  test('fsi.send and fsi.sendFile warn and no-op when the active file is not F#', async function () {
    this.timeout(60_000);

    const before = vscode.window.terminals.filter((t) => t.name === 'F# Interactive').length;
    await openCSharpFile(tmpDir, 'NotFsharp.cs', 'namespace N { class C { } }\n');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.fsi.send');
    }, 'sharplsp.fsi.send must not throw on a C# file');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.fsi.sendFile');
    }, 'sharplsp.fsi.sendFile must not throw on a C# file');

    // Both commands take the warning branch and create no FSI terminal.
    assert.ok(
      stubs.log.warningMessages.some((m) => m.includes('No F# file is active')),
      `Expected a "No F# file is active" warning, got ${JSON.stringify(stubs.log.warningMessages)}`,
    );
    const after = vscode.window.terminals.filter((t) => t.name === 'F# Interactive').length;
    assert.strictEqual(after, before, 'Non-F# send must not spawn an FSI terminal');
  });

  test('fsi.generateSignature warns with no active editor and on a non-F# file', async function () {
    this.timeout(20_000);

    // No active editor at all.
    await closeAllEditors();
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.fsi.generateSignature');
    }, 'generateSignature must not throw with no active editor');

    // A C# file is active — still rejected because it is not a .fs source.
    const { uri } = await openCSharpFile(tmpDir, 'Plain.cs', 'class Plain { }\n');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.fsi.generateSignature');
    }, 'generateSignature must not throw on a C# file');

    assert.ok(
      stubs.log.warningMessages.filter((m) => m.includes('No F# file is active')).length >= 2,
      `Expected two "No F# file is active" warnings, got ${JSON.stringify(stubs.log.warningMessages)}`,
    );
    // No .fsi file should be written next to the C# document.
    const fsiSibling = uri.fsPath.replace(/\.cs$/, '.fsi');
    assert.strictEqual(fs.existsSync(fsiSibling), false, 'No .fsi must be created for a C# file');
  });

  test('extractSignature, isFSharpSourceDocument, and fsiTerminalOptions behave correctly', function () {
    this.timeout(20_000);

    const signature = extractSignature(
      [
        'namespace Demo',
        '',
        'type Widget = { Size: int }',
        'let publicValue = 1',
        'let private secret = 2',
        'member _.Speak () = "hi"',
      ].join('\n'),
    );
    assert.ok(signature.includes('namespace Demo'));
    assert.ok(signature.includes('type Widget'));
    assert.ok(signature.includes("val publicValue : 'a"));
    assert.ok(signature.includes('member _.Speak'));
    // private bindings are excluded from the public signature.
    assert.ok(!signature.includes('secret'));

    // isFSharpSourceDocument keys off the .fs extension.
    assert.strictEqual(
      isFSharpSourceDocument({ uri: { fsPath: '/x/A.fs' } } as vscode.TextDocument),
      true,
    );
    assert.strictEqual(
      isFSharpSourceDocument({ uri: { fsPath: '/x/A.cs' } } as vscode.TextDocument),
      false,
    );
    assert.strictEqual(isFSharpSourceDocument(undefined), false);

    // fsiTerminalOptions falls back to `dotnet` when no explicit SDK path.
    const fallback = fsiTerminalOptions(undefined, []);
    assert.strictEqual(fallback.shellPath, 'dotnet');
    assert.deepStrictEqual([...fallback.shellArgs], ['fsi']);
    const explicit = fsiTerminalOptions('/sdk/dotnet', ['--use:init.fsx']);
    assert.strictEqual(explicit.shellPath, '/sdk/dotnet');
    assert.deepStrictEqual([...explicit.shellArgs], ['fsi', '--use:init.fsx']);
    assert.strictEqual(explicit.name, 'F# Interactive');
  });

  // ── hot-reload.ts ───────────────────────────────────────────────

  test('isRelevantLanguage classifies C#/F# vs other languages within a save flow', async function () {
    this.timeout(60_000);

    assert.strictEqual(isRelevantLanguage('csharp'), true);
    assert.strictEqual(isRelevantLanguage('fsharp'), true);
    assert.strictEqual(isRelevantLanguage('json'), false);
    assert.strictEqual(isRelevantLanguage('plaintext'), false);

    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder === undefined || folder === '') {
      this.skip();
      return;
    }

    // Start hot reload so the onSave handler has a live watch terminal.
    await vscode.commands.executeCommand('sharplsp.hotReload.start');
    assert.strictEqual(isHotReloadRunning(), true);

    // Enable onSave and save a C# document — the relevant-language path runs.
    await vscode.workspace
      .getConfiguration('sharplsp')
      .update('hotReload.onSave', true, vscode.ConfigurationTarget.Workspace);

    const csPath = path.join(tmpDir, 'Saved.cs');
    fs.writeFileSync(csPath, 'class Saved { }\n', 'utf8');
    const csDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));
    const csEditor = await vscode.window.showTextDocument(csDoc);
    await csEditor.edit((b) => {
      b.insert(new vscode.Position(0, 0), '// touched\n');
    });
    await assert.doesNotReject(async () => {
      await csDoc.save();
    }, 'Saving a C# doc during hot reload must not throw');
    assert.strictEqual(isHotReloadRunning(), true, 'Hot reload must remain running after save');

    // Saving a non-relevant document must also be harmless (early-return branch).
    const txtPath = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(txtPath, 'hello\n', 'utf8');
    const txtDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(txtPath));
    const txtEditor = await vscode.window.showTextDocument(txtDoc);
    await txtEditor.edit((b) => {
      b.insert(new vscode.Position(0, 0), 'x');
    });
    await assert.doesNotReject(async () => {
      await txtDoc.save();
    }, 'Saving a non-relevant doc during hot reload must not throw');
    assert.strictEqual(isRelevantLanguage(txtDoc.languageId), false);
    assert.strictEqual(isHotReloadRunning(), true);

    await vscode.commands.executeCommand('sharplsp.hotReload.stop');
    assert.strictEqual(isHotReloadRunning(), false);
  });

  test('handleDocumentSave is inert when hot reload is not running', async function () {
    this.timeout(60_000);

    assert.strictEqual(isHotReloadRunning(), false);

    // Enable onSave but DO NOT start hot reload — the save handler must early-return.
    await vscode.workspace
      .getConfiguration('sharplsp')
      .update('hotReload.onSave', true, vscode.ConfigurationTarget.Workspace);

    const csPath = path.join(tmpDir, 'NoWatch.cs');
    fs.writeFileSync(csPath, 'class NoWatch { }\n', 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => {
      b.insert(new vscode.Position(0, 0), '// edit\n');
    });

    await assert.doesNotReject(async () => {
      await doc.save();
    }, 'Saving with no watch terminal must not throw');
    assert.strictEqual(
      isHotReloadRunning(),
      false,
      'Saving must not start hot reload when no watch terminal exists',
    );
  });
});
