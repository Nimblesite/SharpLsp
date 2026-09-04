// Activation, contribution points and the activation-failure contract.
//
// Spec: [DIST-EDITOR-CONTRACT], [DIST-FAILURE-UX], [DIST-RUNTIME-ACQUIRE],
// [DIST-WORKSPACE-TRUST], [DIST-VERSION-INVARIANT],
// [SHARPLSP-ARCHITECTURE-EXTENSIONS], [SHARPLSP-FEATURES-FSHARP].
//
// Reading a manifest key back is not a test of anything: `contributes.commands`
// can name a command no handler answers, and a registered handler can be
// unreachable from the palette. Every test here therefore drives the editor as
// well as the manifest — open the file, run the command, write the setting,
// read the result back — because the pair is what a user actually experiences.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  EXTENSION_ID,
  closeAllEditors,
  loadFixtureSolution,
  openCSharpFile,
  openSharpLspPanel,
  setupLspTestSuite,
  settleForScreenshot,
  takeScreenshot,
  teardownLspTestSuite,
  waitForDocumentSymbols,
} from './test-helpers';
import { authoredPackageJson, invokeCommand, packageJson } from './run-debug-kit';
import {
  INSTALL_TOOL_ID,
  RECOVERY_COMMANDS,
  TRUST_RESTRICTED_SETTINGS,
  assertContributedSetting,
  assertLanguageOwnsExtension,
  assertReachableCommand,
  assertTrustRestricted,
  commandEntries,
  configProperties,
  languageEntries,
  languageNamed,
  manifestVersion,
  sharpLspExtension,
} from './extension-manifest-kit';
import {
  ACTIVATION_MS,
  COMMAND_MS,
  LSP_RESPONSE_MS,
  SETTINGS_WRITE_MS,
  SETTLE_MS,
} from './test-timeouts';

suite('Extension Activation & Configuration', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    const result = await setupLspTestSuite('ext-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // ── Activation ───────────────────────────────────────────────

  test('extension is present in the extension list', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — the id resolves out of the host's own list, exactly once.
    const listed = vscode.extensions.all.filter((candidate) => candidate.id === EXTENSION_ID);
    assert.strictEqual(
      listed.length,
      1,
      `exactly one ${EXTENSION_ID} in the host, not ${listed.length}`,
    );
    const ext = sharpLspExtension();
    assert.strictEqual(listed[0], ext, 'getExtension must hand back the object the host lists');
    assert.strictEqual(ext.id, EXTENSION_ID, 'the resolved extension carries the id we asked for');

    // Interaction 2 — the id is publisher.name, and both halves come from the manifest.
    const manifest = packageJson();
    assert.strictEqual(`${String(manifest.publisher)}.${String(manifest.name)}`, EXTENSION_ID);
    assert.strictEqual(manifest.name, 'sharplsp', 'the manifest name is the second half of the id');
    assert.strictEqual(manifest.publisher, 'nimblesite', 'the publisher is the first half');

    // Interaction 3 — it is INSTALLED, not merely declared: the payload is on disk.
    assert.ok(fs.existsSync(ext.extensionPath), `extensionPath must exist: ${ext.extensionPath}`);
    assert.ok(fs.statSync(ext.extensionPath).isDirectory(), 'extensionPath must be a directory');
    assert.ok(manifest.engines?.vscode, 'the manifest must declare an engines.vscode range');

    // Interaction 4 — activating an already-active extension is a no-op that
    // yields the SAME exports. [DIST-FAILURE-UX] rule 1: activate() resolves.
    const first = await ext.activate();
    const second = await ext.activate();
    assert.strictEqual(ext.isActive, true, 'the extension is active once activate() resolves');
    assert.strictEqual(first, second, 'a second activate() must hand back the same exports');
    assert.notStrictEqual(ext.exports, undefined, 'activation must publish an API object');
  });

  test('extension activates when a C# file is opened', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — opening a .cs file is the activation event a user hits first.
    const { doc, uri } = await openCSharpFile(tmpDir, 'activation.cs', 'class Activation { }');
    assert.strictEqual(doc.languageId, 'csharp', '.cs must resolve to the csharp language');
    assert.strictEqual(uri.scheme, 'file', 'a workspace file opens on the file scheme');
    assert.strictEqual(doc.isClosed, false, 'the opened document stays open');

    // Interaction 2 — and it activated the extension, not merely opened a buffer.
    const ext = sharpLspExtension();
    assert.strictEqual(ext.isActive, true, 'opening .cs must activate SharpLsp');
    assert.ok(ext.packageJSON.activationEvents, 'the manifest must declare activation events');
    assert.notStrictEqual(ext.exports, undefined, 'an active extension publishes its API');

    // Interaction 3 — .csx is the same language and must not need a second activation.
    const { doc: script } = await openCSharpFile(tmpDir, 'activation.csx', 'var x = 1;\n');
    assert.strictEqual(script.languageId, 'csharp', '.csx must resolve to csharp too');
    assert.strictEqual(ext.isActive, true, 'the extension stays active across both files');
    assert.notStrictEqual(script.uri.fsPath, doc.uri.fsPath, 'the two buffers are distinct files');
  });

  test('extension activates when an F# file is opened', async function () {
    this.timeout(COMMAND_MS);
    // F# is a first-class citizen: .fs resolves to fsharp, never to a C#
    // fallback. A .fs buffer reported as csharp is a buffer the FCS sidecar
    // never sees ([SHARPLSP-FEATURES-FSHARP]).
    const { doc } = await openCSharpFile(tmpDir, 'activation.fs', 'module Activation\nlet x = 1\n');
    assert.strictEqual(
      doc.languageId,
      'fsharp',
      '.fs must resolve to fsharp, not to a C# fallback',
    );
    assert.strictEqual(doc.isClosed, false, 'the F# buffer stays open');
    assert.strictEqual(doc.lineCount >= 2, true, 'the written module reached the buffer');

    // Interaction 2 — the extension is active off the back of an F# file ALONE.
    const ext = sharpLspExtension();
    assert.strictEqual(ext.isActive, true, 'opening .fs must activate SharpLsp');
    assert.notStrictEqual(ext.exports, undefined, 'an active extension publishes its API');
    assert.strictEqual(languageNamed('fsharp').id, 'fsharp', 'fsharp is a contributed language');

    // Interaction 3 — script and signature files are F# as well, all three shapes.
    const { doc: script } = await openCSharpFile(tmpDir, 'activation.fsx', 'let y = 2\n');
    const { doc: signature } = await openCSharpFile(
      tmpDir,
      'activation.fsi',
      'module Activation\n',
    );
    assert.strictEqual(script.languageId, 'fsharp', '.fsx must resolve to fsharp');
    assert.strictEqual(signature.languageId, 'fsharp', '.fsi must resolve to fsharp');
    assert.strictEqual(ext.isActive, true, 'the extension stays active across every F# shape');
  });

  // ── Commands ─────────────────────────────────────────────────

  test('sharplsp.restartServer command is registered', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — reachable: registered, declared once, titled, categorised.
    const palette = await vscode.commands.getCommands(true);
    const entry = assertReachableCommand('sharplsp.restartServer', palette);
    assert.ok(entry.title?.length, 'the palette entry must carry a title');

    // Interaction 2 — [DIST-FAILURE-UX] rule 6: restartServer is a RECOVERY
    // command. Every recovery command the spec names must be reachable, or a
    // user whose activation degraded has to uninstall to try again.
    for (const recovery of RECOVERY_COMMANDS) {
      assertReachableCommand(recovery, palette);
    }

    // Interaction 3 — no sharplsp command is registered without being declared,
    // which is how a command becomes invisible in the palette.
    const declared = new Set(commandEntries().map((command) => command.command));
    const undeclared = palette.filter(
      (id) => id.startsWith('sharplsp.') && !declared.has(id) && !id.startsWith('sharplsp._'),
    );
    assert.deepStrictEqual(undeclared, [], 'every registered sharplsp command must be declared');
    assert.ok(declared.has('sharplsp.restartServer'), 'restartServer is among the declared set');
  });

  test('sharplsp.showOutput command is registered', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — reachable from the palette.
    const palette = await vscode.commands.getCommands(true);
    const entry = assertReachableCommand('sharplsp.showOutput', palette);

    // Interaction 2 — [DIST-FAILURE-UX] rule 3 makes the log reachable from
    // every error toast, so the command backing [Show Log] must answer.
    const outcome = await invokeCommand('sharplsp.showOutput');
    assert.strictEqual(outcome.rejected, false, `showOutput must not reject: ${outcome.message}`);
    assert.strictEqual(outcome.message, '', 'a clean invocation reports no failure message');

    // Interaction 3 — its title names the log in plain language; a user
    // searching the palette for "output" has to find it.
    assert.ok(entry.title, 'showOutput must carry a title');
    assert.match(entry.title, /output|log/i, `title must name the log, got '${entry.title}'`);
    assert.strictEqual(entry.category, 'SharpLsp', 'and sit under the SharpLsp category');
  });

  test('sharplsp.showTraceOutput command is registered', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — reachable from the palette.
    const palette = await vscode.commands.getCommands(true);
    const entry = assertReachableCommand('sharplsp.showTraceOutput', palette);

    // Interaction 2 — the trace channel is a SECOND channel, not the same one
    // under another name: [DIST-CLEAN-OUTPUT] keeps per-request chatter out of
    // the user-facing panel, so the two commands must be distinct entries.
    const plain = commandEntries().find((command) => command.command === 'sharplsp.showOutput');
    assert.ok(plain, 'showOutput must also be declared');
    assert.notStrictEqual(entry.title, plain.title, 'trace and plain output need distinct titles');
    assert.notStrictEqual(entry.command, plain.command, 'and distinct command ids');

    // Interaction 3 — it answers.
    const outcome = await invokeCommand('sharplsp.showTraceOutput');
    assert.strictEqual(
      outcome.rejected,
      false,
      `showTraceOutput must not reject: ${outcome.message}`,
    );
    assert.match(entry.title ?? '', /trace/i, 'the title must name the trace channel');
  });

  // ── Configuration ────────────────────────────────────────────

  test('sharplsp.lspPath setting is contributed', async function () {
    // The ASSERTIONS here are instant — `config.inspect` reads a contribution
    // point out of the extension manifest — and on CI so is the rest: the
    // documentation screenshot and its render settle are both no-ops unless
    // SHARPLSP_SCREENSHOTS is set, leaving one command round trip.
    //
    // The budget has to cover the SCREENSHOT run as well, though, and there the
    // workbench must paint the filtered Settings list before the capture is worth
    // anything. That settle is longer than `COMMAND_MS` on its own, so this asks
    // for one round trip plus one settle.
    this.timeout(COMMAND_MS + SETTLE_MS);
    // Interaction 1 — contributed, documented, defaulted to "use the bundled binary".
    const property = assertContributedSetting('sharplsp.lspPath', '');
    assert.strictEqual(property.type, 'string', 'lspPath names a path, so it is a string setting');

    // Interaction 2 — [DIST-WORKSPACE-TRUST]: it names the executable SharpLsp
    // spawns, so an untrusted workspace must not be able to set it.
    assertTrustRestricted('sharplsp.lspPath');
    for (const restricted of TRUST_RESTRICTED_SETTINGS) {
      assertTrustRestricted(restricted);
    }

    // Interaction 3 — the empty default is what makes [DIST-RESOLUTION-LSP]'s
    // bundled source the default path; a non-empty default would pin a machine.
    assert.strictEqual(
      vscode.workspace.getConfiguration('sharplsp').get<string>('lspPath'),
      '',
      'an unset lspPath must read back empty so Shipwright resolves the bundled binary',
    );

    // Interaction 4 — the user opens Settings filtered to sharplsp and sees it.
    await vscode.commands.executeCommand('workbench.action.openSettings', 'sharplsp');
    await settleForScreenshot(1500);
    await takeScreenshot('vscode-configuration-page.png');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('sharplsp.server.extraArgs setting is contributed', () => {
    // Interaction 1 — contributed, documented, defaulted to no extra arguments.
    const property = assertContributedSetting('sharplsp.server.extraArgs', []);
    assert.strictEqual(property.type, 'array', 'extraArgs is an array of CLI arguments');

    // Interaction 2 — [DIST-WORKSPACE-TRUST]: arguments injected into a spawned
    // process are arbitrary code execution, so this is restricted too.
    assertTrustRestricted('sharplsp.server.extraArgs');
    assertTrustRestricted('sharplsp.fsi.extraArgs');

    // Interaction 3 — the default is EMPTY and a fresh read confirms it, so a
    // clean install never injects an argument nobody asked for.
    const read = vscode.workspace.getConfiguration('sharplsp').get<string[]>('server.extraArgs');
    assert.deepStrictEqual(read, [], 'an unset extraArgs must read back as no arguments');
    assert.strictEqual(Array.isArray(read), true, 'and as an array, not a string');
  });

  test('sharplsp.trace.server setting is contributed', async function () {
    this.timeout(SETTINGS_WRITE_MS);
    // Interaction 1 — contributed, documented, and OFF by default. LSP tracing
    // on by default would flood the panel [DIST-CLEAN-OUTPUT] keeps readable.
    const property = assertContributedSetting('sharplsp.trace.server', 'off');
    assert.strictEqual(property.type, 'string', 'trace.server is an enum of strings');
    assert.ok(Array.isArray(property.enum), 'trace.server must offer a closed enum');
    assert.ok(property.enum.includes('off'), "the enum must include 'off'");
    assert.ok(property.enum.includes('verbose'), "and 'verbose' for a bug report");

    // Interaction 2 — the user turns tracing up, and it reads back.
    const config = () => vscode.workspace.getConfiguration('sharplsp');
    await config().update('trace.server', 'verbose', vscode.ConfigurationTarget.Global);
    assert.strictEqual(config().get('trace.server'), 'verbose', 'the new level must read back');
    assert.strictEqual(
      config().inspect('trace.server')?.globalValue,
      'verbose',
      'and be recorded at the scope it was written to',
    );

    // Interaction 3 — and turning it back off restores the default exactly.
    await config().update('trace.server', undefined, vscode.ConfigurationTarget.Global);
    assert.strictEqual(config().get('trace.server'), 'off', 'clearing restores the default');
    assert.strictEqual(
      config().inspect('trace.server')?.globalValue,
      undefined,
      'and leaves no user-scope residue behind',
    );
  });

  test('sharplsp.logging.level setting is contributed', async function () {
    this.timeout(SETTINGS_WRITE_MS);
    // Interaction 1 — contributed, documented, and `info` by default: enough to
    // diagnose, quiet enough for [DIST-CLEAN-OUTPUT].
    const property = assertContributedSetting('sharplsp.logging.level', 'info');
    assert.strictEqual(property.type, 'string', 'logging.level is an enum of strings');
    assert.ok(Array.isArray(property.enum), 'logging.level must offer a closed enum');
    for (const level of ['error', 'warn', 'info', 'debug']) {
      assert.ok(property.enum.includes(level), `the enum must offer '${level}'`);
    }

    // Interaction 2 — the user turns logging up to debug and it reads back.
    const config = () => vscode.workspace.getConfiguration('sharplsp');
    await config().update('logging.level', 'debug', vscode.ConfigurationTarget.Global);
    assert.strictEqual(config().get('logging.level'), 'debug', 'the new level must read back');
    assert.notStrictEqual(config().get('logging.level'), 'info', 'and no longer be the default');

    // Interaction 3 — clearing it restores `info`, not the last value written.
    await config().update('logging.level', undefined, vscode.ConfigurationTarget.Global);
    assert.strictEqual(config().get('logging.level'), 'info', 'clearing restores the default');
    assert.strictEqual(
      config().inspect('logging.level')?.globalValue,
      undefined,
      'with no residue',
    );
  });

  // ── Package Metadata ─────────────────────────────────────────

  test('extension has correct display name', () => {
    // Interaction 1 — the marketplace name a user searches for.
    const manifest = packageJson();
    assert.strictEqual(manifest.displayName, 'SharpLsp', "Display name should be 'SharpLsp'");
    assert.strictEqual(
      manifest.displayName,
      authoredPackageJson().displayName,
      'the loaded manifest and the authored one must agree on the display name',
    );

    // Interaction 2 — it carries the marketplace copy that goes with the name.
    assert.ok(
      typeof manifest.description === 'string' && manifest.description.length > 0,
      'a marketplace listing needs a non-empty description',
    );
    assert.ok(manifest.icon, 'the listing needs an icon per [DIST-VSIX-ASSET-INTEGRITY]');
    assert.ok(Array.isArray(manifest.categories), 'the listing needs marketplace categories');

    // Interaction 3 — and the palette prefix matches the display name, so every
    // SharpLsp command groups under one heading in the command palette.
    const categories = new Set(commandEntries().map((command) => command.category));
    assert.deepStrictEqual(
      [...categories],
      ['SharpLsp'],
      'one palette heading, named for the product',
    );
  });

  test('extension contributes csharp language', async function () {
    this.timeout(LSP_RESPONSE_MS);
    // Interaction 1 — the manifest claims csharp and owns .cs outright.
    assertLanguageOwnsExtension('csharp', '.cs');
    const entry = languageNamed('csharp');
    assert.ok(entry.aliases?.length, 'csharp must carry at least one display alias');

    // Interaction 2 — a real .cs buffer resolves to that language AND the
    // server answers for it. A contributed language nothing serves is a
    // syntax-highlighting stub, not C# support.
    const { uri: csUri, doc } = await openCSharpFile(
      tmpDir,
      'editors-shot.cs',
      `namespace Demo\n{\n    public class Calculator\n    {\n        public int Add(int a, int b) => a + b;\n    }\n}`,
    );
    assert.strictEqual(doc.languageId, 'csharp', 'the fixture opens as csharp');
    const symbols = await waitForDocumentSymbols(csUri);
    assert.ok(symbols.length > 0, 'the csharp language must be served, not merely declared');
    assert.ok(
      JSON.stringify(symbols).includes('Calculator'),
      'and the served symbols must describe THIS document',
    );

    // Interaction 3 — C# and F# open side by side without either losing its
    // language, which is the split-editor case a .NET solution hits constantly.
    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    const { doc: fsDoc } = await openCSharpFile(
      tmpDir,
      'editors-shot.fs',
      'module Demo\n\nlet greet name = sprintf "Hello, %s!" name\n',
    );
    assert.strictEqual(fsDoc.languageId, 'fsharp', 'the F# split keeps its own language');
    assert.strictEqual(doc.languageId, 'csharp', 'and the C# side is unchanged by the split');
    await new Promise((r) => setTimeout(r, 800));
    if (process.env['SHARPLSP_SCREENSHOTS']) {
      await loadFixtureSolution(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
    }
    await openSharpLspPanel();
    await takeScreenshot('vscode-editors-page.png');
  });

  test('extension contributes fsharp language', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — fsharp is contributed and owns .fs outright. F# ahead of
    // C#: a .fs file claimed by both languages opens arbitrarily.
    assertLanguageOwnsExtension('fsharp', '.fs');
    const entry = languageNamed('fsharp');
    assert.ok(entry.aliases?.length, 'fsharp must carry at least one display alias');

    // Interaction 2 — it claims every F# shape, not just implementation files.
    for (const shape of ['.fs', '.fsx', '.fsi']) {
      assert.ok(entry.extensions?.includes(shape), `fsharp must claim ${shape}`);
    }

    // Interaction 3 — and a real F# buffer resolves to it.
    const { doc } = await openCSharpFile(tmpDir, 'contributes.fsx', 'let square x = x * x\n');
    assert.strictEqual(doc.languageId, 'fsharp', 'a script buffer resolves to fsharp');
    assert.strictEqual(doc.isClosed, false, 'and stays open');
  });

  // ── Command Handler Invocation ─────────────────────────────

  test('sharplsp.showOutput executes without error', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — [DIST-FAILURE-UX] rule 3: the [Show Log] path must never
    // throw, because it is the path a user takes when something ALREADY broke.
    const first = await invokeCommand('sharplsp.showOutput');
    assert.strictEqual(first.rejected, false, `showOutput must not throw: ${first.message}`);
    assert.strictEqual(first.message, '', 'a clean invocation reports nothing');

    // Interaction 2 — and it is idempotent: showing an already-shown channel is
    // a no-op, not a second panel or a rejection.
    const second = await invokeCommand('sharplsp.showOutput');
    assert.strictEqual(second.rejected, false, 'a second showOutput must not throw');
    assert.deepStrictEqual(second, first, 'the second invocation reports the same outcome');

    // Interaction 3 — it stays reachable afterwards; showing a channel must not
    // deregister the command that showed it.
    const palette = await vscode.commands.getCommands(true);
    assertReachableCommand('sharplsp.showOutput', palette);
  });

  test('sharplsp.showTraceOutput executes without error', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — the trace channel opens without throwing.
    const first = await invokeCommand('sharplsp.showTraceOutput');
    assert.strictEqual(first.rejected, false, `showTraceOutput must not throw: ${first.message}`);
    assert.strictEqual(first.message, '', 'a clean invocation reports nothing');

    // Interaction 2 — opening the trace channel does not disturb the plain one:
    // [DIST-CLEAN-OUTPUT] keeps per-request chatter and user-facing output apart.
    const plain = await invokeCommand('sharplsp.showOutput');
    assert.strictEqual(plain.rejected, false, 'the plain channel still opens afterwards');
    const again = await invokeCommand('sharplsp.showTraceOutput');
    assert.strictEqual(again.rejected, false, 'and the trace channel re-opens after it');

    // Interaction 3 — both remain reachable from the palette.
    const palette = await vscode.commands.getCommands(true);
    assertReachableCommand('sharplsp.showTraceOutput', palette);
    assertReachableCommand('sharplsp.showOutput', palette);
  });

  test('sharplsp.restartServer executes without error', async function () {
    this.timeout(ACTIVATION_MS);
    // Interaction 1 — the server is serving BEFORE the restart, so the
    // post-restart assertion below means something.
    const { uri } = await openCSharpFile(tmpDir, 'pre-restart.cs', 'class PreRestart { }');
    const before = await waitForDocumentSymbols(uri);
    assert.ok(before.length > 0, 'the server must be serving before the restart');
    assert.strictEqual(before[0]?.name, 'PreRestart', 'and serving THIS document');

    // Interaction 2 — [DIST-FAILURE-UX] rule 6: the recovery command runs
    // without throwing, however the server was behaving beforehand.
    const outcome = await invokeCommand('sharplsp.restartServer');
    assert.strictEqual(outcome.rejected, false, `restartServer must not throw: ${outcome.message}`);
    assert.strictEqual(outcome.message, '', 'a clean restart reports nothing');

    // Interaction 3 — and the server is serving AGAIN. A restart that leaves
    // the client dead is the failure this command exists to fix.
    const after = await waitForDocumentSymbols(uri, LSP_RESPONSE_MS);
    assert.ok(after.length > 0, 'the server must answer again after a restart');
    assert.deepStrictEqual(
      after.map((symbol) => symbol.name),
      before.map((symbol) => symbol.name),
      'and answer identically — a restart changes nothing about the document',
    );
    assert.strictEqual(
      sharpLspExtension().isActive,
      true,
      'the extension survives its own restart',
    );

    if (process.env['SHARPLSP_SCREENSHOTS']) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const calcUri = vscode.Uri.file(`${ws}/Calculator.cs`);
      const calcDoc = await vscode.workspace.openTextDocument(calcUri);
      await vscode.window.showTextDocument(calcDoc, { preview: false });
      await waitForDocumentSymbols(calcUri);
      await loadFixtureSolution(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
    }
    // Close any bottom panel, open SharpLsp sidebar — shows Rust host + Roslyn sidecar in action.
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await openSharpLspPanel();
    await settleForScreenshot(1_000);
    await takeScreenshot('vscode-architecture-page.png');
  });

  // ── C# Language Configuration ──────────────────────────────

  test('csharp language contributes .cs extension', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — the manifest claim, and it is exclusive.
    assertLanguageOwnsExtension('csharp', '.cs');

    // Interaction 2 — the claim is honoured by the editor for a real file.
    const { doc } = await openCSharpFile(tmpDir, 'owns-cs.cs', 'class OwnsCs { }');
    assert.strictEqual(doc.languageId, 'csharp', 'a .cs file opens as csharp');
    assert.strictEqual(doc.uri.fsPath.endsWith('.cs'), true, 'and it really is a .cs path');

    // Interaction 3 — the language-configuration file backing it is real JSON
    // with the bracket pairs a C# editor needs, not an empty placeholder.
    const configured = languageNamed('csharp').configuration ?? '';
    const parsed = readLanguageConfiguration(configured);
    assert.ok(parsed.brackets, 'the csharp language configuration must declare brackets');
    assert.ok(parsed.comments, 'and comment tokens, or Toggle Comment does nothing');
  });

  test('csharp language contributes .csx extension', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — the manifest claim for C# script files, exclusive.
    assertLanguageOwnsExtension('csharp', '.csx');

    // Interaction 2 — a .csx buffer opens as csharp, so scripts get the same
    // editor behaviour as compiled sources ([SCRIPTING-FILEBASED-SPEC]).
    const { doc } = await openCSharpFile(tmpDir, 'owns-csx.csx', 'var value = 41 + 1;\n');
    assert.strictEqual(doc.languageId, 'csharp', 'a .csx file opens as csharp');
    assert.strictEqual(doc.isClosed, false, 'and stays open');

    // Interaction 3 — .cs and .csx are the SAME language entry, not two.
    const entry = languageNamed('csharp');
    assert.ok(entry.extensions?.includes('.cs'), 'one csharp entry claims .cs');
    assert.ok(entry.extensions?.includes('.csx'), 'and the same entry claims .csx');
    assert.strictEqual(
      languageEntries().filter((language) => language.id === 'csharp').length,
      1,
      'there is exactly one csharp contribution, not one per extension',
    );
  });

  // ── F# Language Configuration ──────────────────────────────

  test('fsharp language contributes .fs extension', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — the manifest claim, exclusive to F#.
    assertLanguageOwnsExtension('fsharp', '.fs');

    // Interaction 2 — a real .fs buffer resolves to fsharp.
    const { doc } = await openCSharpFile(tmpDir, 'owns-fs.fs', 'module OwnsFs\nlet value = 1\n');
    assert.strictEqual(doc.languageId, 'fsharp', 'a .fs file opens as fsharp');
    assert.strictEqual(doc.lineCount >= 2, true, 'and carries the module we wrote');

    // Interaction 3 — its language configuration is real, with F# comment
    // tokens. F# comments are `//` and `(* *)`, not C#'s `/* */`.
    const parsed = readLanguageConfiguration(languageNamed('fsharp').configuration ?? '');
    assert.ok(parsed.comments, 'the fsharp language configuration must declare comment tokens');
    assert.ok(parsed.brackets, 'and bracket pairs');
  });

  test('fsharp language contributes .fsx extension', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — the manifest claim for F# scripts, exclusive.
    assertLanguageOwnsExtension('fsharp', '.fsx');

    // Interaction 2 — an .fsx buffer opens as fsharp, which is what routes it
    // to FSI rather than to a C# handler.
    const { doc } = await openCSharpFile(tmpDir, 'owns-fsx.fsx', 'printfn "hello"\n');
    assert.strictEqual(doc.languageId, 'fsharp', 'a .fsx file opens as fsharp');
    assert.strictEqual(doc.isClosed, false, 'and stays open');

    // Interaction 3 — no C# entry claims it, and the fsharp entry claims it once.
    const claims = languageEntries().filter((language) =>
      (language.extensions ?? []).includes('.fsx'),
    );
    assert.deepStrictEqual(
      claims.map((claim) => claim.id),
      ['fsharp'],
      'only fsharp claims .fsx',
    );
    assert.strictEqual(claims.length, 1, 'and it claims it exactly once');
  });

  test('fsharp language contributes .fsi extension', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — the manifest claim for F# signature files, exclusive.
    assertLanguageOwnsExtension('fsharp', '.fsi');

    // Interaction 2 — a signature file opens as fsharp. Signature files are
    // first-class F#: dropping them leaves a real F# project half-served.
    const { doc } = await openCSharpFile(
      tmpDir,
      'owns-fsi.fsi',
      'module OwnsFsi\nval value: int\n',
    );
    assert.strictEqual(doc.languageId, 'fsharp', 'a .fsi file opens as fsharp');
    assert.strictEqual(doc.lineCount >= 2, true, 'and carries the signature we wrote');

    // Interaction 3 — all three F# shapes land on ONE entry, so they share the
    // same language configuration and the same server routing.
    const entry = languageNamed('fsharp');
    for (const shape of ['.fs', '.fsx', '.fsi']) {
      assert.ok(entry.extensions?.includes(shape), `the single fsharp entry claims ${shape}`);
    }
  });

  // ── Package Metadata Extras ────────────────────────────────

  test('extension has MIT license', () => {
    // Interaction 1 — the manifest declares MIT, per [SHARPLSP-LICENSING].
    const manifest = packageJson();
    assert.strictEqual(manifest.license, 'MIT', 'SharpLsp ships under MIT');
    assert.strictEqual(
      authoredPackageJson().license,
      'MIT',
      'and the authored manifest agrees with the loaded one',
    );

    // Interaction 2 — the licence file ships in the VSIX beside the manifest,
    // so an offline install can read the terms it is bound by.
    const licensed = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].filter((name) =>
      fs.existsSync(`${sharpLspExtension().extensionPath}/${name}`),
    );
    assert.notDeepStrictEqual(licensed, [], 'a licence file must ship in the extension payload');

    // Interaction 3 — the listing points at a public repository, which is what
    // makes "open source, no vendor lock-in" verifiable by the user.
    assert.ok(manifest.repository, 'the manifest must declare a repository');
    assert.ok(
      JSON.stringify(manifest.repository).includes('github.com'),
      'and it must be a public one',
    );
  });

  test('extension has version string', () => {
    // Interaction 1 — a plain semver core, no `v`, per [DIST-VERSION-INVARIANT].
    const version = manifestVersion();
    assert.ok(version.length > 0, 'the version must not be empty');

    // Interaction 2 — the loaded manifest and the authored one agree. A release
    // stamps both Cargo.toml and package.json; a drift here means the VSIX was
    // packaged from a different commit than the one that was stamped.
    assert.strictEqual(
      authoredPackageJson().version,
      version,
      'the authored manifest and the loaded manifest must report the same version',
    );

    // Interaction 3 — it splits into three numeric components, which is what
    // makes a byte-for-byte comparison against Cargo.toml meaningful.
    const parts = version.split(/[-+]/)[0]?.split('.') ?? [];
    assert.strictEqual(parts.length, 3, `semver core must have three parts, got '${version}'`);
    for (const part of parts) {
      assert.match(part, /^\d+$/, `each version component must be numeric, got '${part}'`);
    }
  });

  // Implements [DIST-RUNTIME-ACQUIRE]. The test host installs the .NET Install
  // Tool unconditionally (.vscode-test.mjs `installExtensions`), so without
  // this guard the suite stays green even if the `extensionDependencies`
  // declaration is deleted from package.json — silently breaking automatic
  // SDK acquisition for real installs (the v0.1.0 failure mode).
  test('package.json declares the .NET Install Tool as an extensionDependency', () => {
    // Interaction 1 — rule 1: the dependency is declared, so VS Code installs
    // it silently alongside SharpLsp with no user prompt.
    const deps: string[] = packageJson().extensionDependencies ?? [];
    assert.ok(
      deps.includes(INSTALL_TOOL_ID),
      `extensionDependencies must include ${INSTALL_TOOL_ID}`,
    );
    assert.strictEqual(
      deps.filter((dep) => dep === INSTALL_TOOL_ID).length,
      1,
      'declared exactly once',
    );

    // Interaction 2 — the authored manifest declares it too, so the guard
    // survives a repackage rather than depending on host-side installation.
    const authored: string[] = authoredPackageJson().extensionDependencies ?? [];
    assert.deepStrictEqual(authored, deps, 'authored and loaded dependency lists must agree');
    assert.ok(authored.includes(INSTALL_TOOL_ID), 'and the authored one names the Install Tool');

    // Interaction 3 — [DIST-EDITOR-CONTRACT] rule 2: nothing else is a
    // dependency, because every other component ships inside the VSIX.
    assert.deepStrictEqual(
      deps,
      [INSTALL_TOOL_ID],
      'the .NET Install Tool is the ONLY dependency — every binary ships in the VSIX',
    );
  });

  test('the .NET Install Tool extension resolves in the extension host', async function () {
    this.timeout(SETTLE_MS);
    // Interaction 1 — the declared dependency is really present.
    const installTool = vscode.extensions.getExtension(INSTALL_TOOL_ID);
    assert.ok(installTool, `${INSTALL_TOOL_ID} must be present in the host`);
    assert.strictEqual(installTool.id, INSTALL_TOOL_ID, 'and resolve under the id we declared');

    // Interaction 2 — rule 2: SharpLsp activates it explicitly, so a disabled
    // dependency becomes a clear message instead of "command not found".
    await installTool.activate();
    assert.strictEqual(installTool.isActive, true, 'the Install Tool must activate on demand');

    // Interaction 3 — rules 3 and 4: the commands SharpLsp calls are really
    // registered by it. A renamed upstream command breaks SDK acquisition
    // silently, and only this assertion catches it.
    const palette = await vscode.commands.getCommands(true);
    for (const command of ['dotnet.findPath', 'dotnet.acquireGlobalSDK']) {
      assert.ok(palette.includes(command), `[DIST-RUNTIME-ACQUIRE] calls '${command}'`);
    }
    assert.ok(
      palette.includes('dotnet.acquire'),
      "the runtime-mode 'dotnet.acquire' is offered too",
    );

    // Interaction 4 — VS Code activates a dependency BEFORE its dependent. An
    // active SharpLsp beside a dormant Install Tool means the
    // `extensionDependencies` declaration is not being honoured, and rule 3's
    // acquisition call would fail at the worst possible moment: first launch.
    assert.strictEqual(sharpLspExtension().isActive, true, 'SharpLsp is active here');
    assert.strictEqual(installTool.isActive, true, 'so its declared dependency must be too');
    assert.notStrictEqual(installTool.id, EXTENSION_ID, 'the dependency is a separate extension');
    assert.ok(
      installTool.packageJSON.version,
      'and a resolvable one, with a version the acquisition contract can be pinned against',
    );
  });

  test('extension contributes all expected commands', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — every command the feature specs name is declared AND
    // registered. Declared-but-unregistered is a palette entry that errors.
    const palette = await vscode.commands.getCommands(true);
    for (const required of [
      'sharplsp.restartServer',
      'sharplsp.showOutput',
      'sharplsp.showTraceOutput',
      'sharplsp.selectSolution',
      'sharplsp.refreshExplorer',
      'sharplsp.sortNatural',
      'sharplsp.sortAlphabetical',
      'sharplsp.sortAccessibility',
      'sharplsp.build',
      'sharplsp.rebuild',
      'sharplsp.clean',
      'sharplsp.openProjectFile',
      'sharplsp.addProjectReference',
      'sharplsp.nuget.addFromExplorer',
      'sharplsp.nuget.add',
      'sharplsp.nuget.update',
      'sharplsp.nuget.restore',
    ]) {
      assertReachableCommand(required, palette);
    }

    // Interaction 2 — the declared set has no duplicates. A duplicate id shows
    // twice in the palette and the second declaration silently wins.
    const ids = commandEntries().map((command) => command.command);
    assert.deepStrictEqual([...new Set(ids)], ids, 'no command may be declared twice');
    assert.ok(ids.length >= 17, `at least the seventeen named commands, got ${ids.length}`);

    // Interaction 3 — and the recovery commands of [DIST-FAILURE-UX] are among
    // them, so a degraded activation is recoverable from the palette.
    for (const recovery of RECOVERY_COMMANDS) {
      assert.ok(ids.includes(recovery), `${recovery} must be declared as a recovery command`);
    }
  });

  test('extension contributes all expected configuration properties', () => {
    // Interaction 1 — every setting the distribution spec names is contributed.
    const keys = Object.keys(configProperties());
    for (const required of [
      'sharplsp.lspPath',
      'sharplsp.csharpSidecarPath',
      'sharplsp.fsharpSidecarPath',
      'sharplsp.server.extraArgs',
      'sharplsp.trace.server',
      'sharplsp.logging.level',
    ]) {
      assert.ok(keys.includes(required), `Missing required config property: ${required}`);
    }

    // Interaction 2 — every one of them is documented and typed. An
    // undocumented setting cannot be used from the Settings UI at all.
    for (const [key, property] of Object.entries(configProperties())) {
      assert.ok(key.startsWith('sharplsp.'), `${key} must live in the sharplsp namespace`);
      assert.ok(property.type, `${key} must declare a JSON type`);
      assert.ok(
        (property.description ?? property.markdownDescription ?? '').length > 0,
        `${key} must carry a description`,
      );
    }

    // Interaction 3 — [DIST-WORKSPACE-TRUST]: every restricted setting the spec
    // names is both contributed and restricted.
    for (const restricted of TRUST_RESTRICTED_SETTINGS) {
      assert.ok(keys.includes(restricted), `${restricted} must be contributed`);
      assertTrustRestricted(restricted);
    }
  });

  test('extension contributes exactly 2 languages', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — two languages, named. SharpLsp is one server for both.
    const ids = languageEntries().map((language) => language.id);
    assert.strictEqual(ids.length, 2, `exactly two contributed languages, got ${ids.length}`);
    assert.deepStrictEqual([...ids].sort(), ['csharp', 'fsharp']);

    // Interaction 2 — their extension claims are disjoint, so no file opens
    // under the wrong language.
    const csharp = new Set(languageNamed('csharp').extensions ?? []);
    const fsharp = new Set(languageNamed('fsharp').extensions ?? []);
    const shared = [...csharp].filter((claim) => fsharp.has(claim));
    assert.deepStrictEqual(shared, [], 'the two languages must claim disjoint extensions');
    assert.ok(csharp.size >= 2, 'csharp claims at least .cs and .csx');
    assert.ok(fsharp.size >= 3, 'fsharp claims at least .fs, .fsx and .fsi');

    // Interaction 3 — and both are live: the editor resolves a file of each.
    const { doc: cs } = await openCSharpFile(tmpDir, 'exactly-two.cs', 'class Two { }');
    const { doc: fsx } = await openCSharpFile(tmpDir, 'exactly-two.fsx', 'let two = 2\n');
    assert.strictEqual(cs.languageId, 'csharp', 'the C# half resolves');
    assert.strictEqual(fsx.languageId, 'fsharp', 'and the F# half resolves');
  });

  test('extension has language configuration files', () => {
    // Interaction 1 — every contributed language declares one, under the
    // directory the packaging step ships.
    for (const language of languageEntries()) {
      assert.ok(language.configuration, `Language ${language.id} must have a configuration file`);
      assert.ok(
        language.configuration.includes('language-configuration/'),
        `Configuration path should be in language-configuration/`,
      );
    }

    // Interaction 2 — each file EXISTS in the packaged payload and parses. A
    // path that ships nothing leaves the editor with no bracket matching at all.
    for (const language of languageEntries()) {
      const parsed = readLanguageConfiguration(language.configuration ?? '');
      assert.ok(parsed.brackets, `${language.id} must declare bracket pairs`);
      assert.ok(parsed.comments, `${language.id} must declare comment tokens`);
    }

    // Interaction 3 — the two languages use DIFFERENT configuration files. F#
    // is not C# with a different extension: sharing one file would give F#
    // block comments it does not have.
    const paths = languageEntries().map((language) => language.configuration);
    assert.deepStrictEqual([...new Set(paths)], paths, 'each language needs its own configuration');
    assert.strictEqual(paths.length, 2, 'one configuration file per contributed language');
  });

  test("all commands have a category of 'SharpLsp'", async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — every declared command sits under the one heading a user
    // types "SharpLsp" to find.
    for (const command of commandEntries()) {
      assert.strictEqual(
        command.category,
        'SharpLsp',
        `Command ${command.command} should have category 'SharpLsp'`,
      );
    }

    // Interaction 2 — one heading, not several near-identical ones.
    const categories = [...new Set(commandEntries().map((command) => command.category))];
    assert.deepStrictEqual(categories, ['SharpLsp'], 'exactly one palette heading');
    assert.strictEqual(categories.length, 1, 'and no second spelling of it');

    // Interaction 3 — the heading matches the product name, so the palette and
    // the marketplace listing agree on what this extension is called.
    assert.strictEqual(packageJson().displayName, categories[0], 'heading matches display name');
    const palette = await vscode.commands.getCommands(true);
    assert.ok(
      commandEntries().every((command) => palette.includes(command.command)),
      'and every command under that heading is really registered',
    );

    // Interaction 4 — the category is AUTHORED, not injected by core at load
    // time. Reading it back off the loaded manifest alone would still pass if
    // this repository shipped no category at all.
    const authored: { command: string; category?: string }[] =
      authoredPackageJson().contributes?.commands ?? [];
    assert.strictEqual(
      authored.length,
      commandEntries().length,
      'the authored and loaded command lists must be the same length',
    );
    for (const command of authored) {
      assert.strictEqual(
        command.category,
        'SharpLsp',
        `${command.command} must be AUTHORED under the SharpLsp category`,
      );
    }
    assert.deepStrictEqual(
      authored.map((command) => command.command),
      commandEntries().map((command) => command.command),
      'and both lists must name the same commands in the same order',
    );
  });

  test('all commands have a title', () => {
    // Interaction 1 — a non-empty title, or the palette row is blank.
    for (const command of commandEntries()) {
      assert.ok(
        command.title && command.title.length > 0,
        `Command ${command.command} must have a non-empty title`,
      );
    }

    // Interaction 2 — titles are DISTINCT. Two commands sharing a title are
    // indistinguishable in the palette, which is a usability defect the
    // manifest can express and nothing else catches.
    const titles = commandEntries().map((command) => command.title);
    assert.deepStrictEqual([...new Set(titles)], titles, 'no two commands may share a title');
    assert.strictEqual(titles.length, commandEntries().length, 'one title per command');

    // Interaction 3 — no title repeats the category, because VS Code already
    // renders it as "SharpLsp: <title>".
    for (const command of commandEntries()) {
      assert.strictEqual(
        command.title?.startsWith('SharpLsp'),
        false,
        `${command.command} must not repeat the category in its title`,
      );
    }

    // Interaction 4 — the titles are AUTHORED and human-readable: trimmed, not
    // a copy of the command id, and byte-identical to what this repository
    // ships. A title core normalised on load hides an unreadable manifest.
    const authored: { command: string; title?: string }[] =
      authoredPackageJson().contributes?.commands ?? [];
    assert.deepStrictEqual(
      authored.map((command) => command.title),
      titles,
      'the authored titles and the loaded titles must agree exactly',
    );
    for (const command of commandEntries()) {
      assert.strictEqual(
        command.title,
        command.title?.trim(),
        `${command.command} title must carry no leading or trailing whitespace`,
      );
      assert.notStrictEqual(
        command.title,
        command.command,
        `${command.command} needs a human title, not a copy of its id`,
      );
    }
  });

  // ── Activation Events ──────────────────────────────────────

  test('extension has workspaceContains activation events', async function () {
    this.timeout(COMMAND_MS);
    // Interaction 1 — a .NET workspace activates SharpLsp on sight, whichever
    // project shape it uses.
    const events: string[] = packageJson().activationEvents ?? [];
    for (const shape of ['*.sln', '*.slnx', '*.csproj', '*.fsproj']) {
      assert.ok(
        events.some((event) => event.includes(shape)),
        `Should activate on ${shape} files`,
      );
    }

    // Interaction 2 — every project shape is a `workspaceContains:` event, and
    // none is the `*` blanket. A blanket event activates SharpLsp in every
    // window, which is exactly the startup cost [SHARPLSP-PERFORMANCE] avoids.
    assert.strictEqual(events.includes('*'), false, 'SharpLsp must never activate unconditionally');
    assert.ok(
      events.some((event) => event.startsWith('workspaceContains:')),
      'project detection must use workspaceContains:',
    );
    assert.deepStrictEqual([...new Set(events)], events, 'no activation event may be listed twice');

    // Interaction 3 — and it is ALREADY active here, because this workspace
    // contains a solution: the declaration and the behaviour agree.
    assert.strictEqual(sharpLspExtension().isActive, true, 'the fixture workspace activated it');
    assert.deepStrictEqual(
      authoredPackageJson().activationEvents ?? [],
      events,
      'the authored events and the loaded ones must agree',
    );
  });
});

/** A language-configuration file, read out of the packaged payload and parsed. */
function readLanguageConfiguration(relativePath: string): Record<string, unknown> {
  assert.ok(relativePath.length > 0, 'a language must declare a configuration path');
  const resolved = `${sharpLspExtension().extensionPath}/${relativePath}`;
  assert.ok(fs.existsSync(resolved), `language configuration must ship at ${resolved}`);
  const parsed: unknown = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  assert.ok(parsed && typeof parsed === 'object', `${relativePath} must parse as a JSON object`);
  return parsed as Record<string, unknown>;
}
