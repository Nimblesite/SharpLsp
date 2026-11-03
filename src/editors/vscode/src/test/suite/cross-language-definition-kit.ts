import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { positionOf } from './fsharp-helpers';
import {
  REVEAL_DECLARATION,
  REVEAL_TYPE_DEFINITION,
  type CrossLanguageSpec,
} from './cross-language-definition-specs';
import {
  openFixtureDocument,
  workspaceFixturePath,
  type OpenFixture,
} from './refactor-test-helpers';
import { comparablePath, executeProvider, pollUntilResult, sleep } from './test-helpers';
import { COMMAND_MS, SIDECAR_COLD_MS } from './test-timeouts';

// The user's view of Go To Definition across C# ↔ F#: the real command, then what
// the editor window shows. Implements [DEFINITION-CROSSLANG].

const DECOMPILED_DIRECTORY = 'sharplsp-decompiled';
const DECOMPILER_TRACES = ['ICSharpCode', '[CompilationMapping', 'CompilerGenerated'];
const LOAD_RETRY_MS = 1_500;

function activeFile(): string | undefined {
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

function samePath(left: string | undefined, right: string): boolean {
  return left !== undefined && comparablePath(left) === comparablePath(right);
}

/** Open only the use file, with the cursor on the symbol. */
export async function openUse(spec: CrossLanguageSpec): Promise<OpenFixture> {
  const use = await openFixtureDocument(spec.useFile);
  placeCursor(use, spec);
  return use;
}

function usePosition(use: OpenFixture, spec: CrossLanguageSpec): vscode.Position {
  return positionOf(use.document, spec.use, spec.use.indexOf(spec.cursorOn));
}

function placeCursor(use: OpenFixture, spec: CrossLanguageSpec): void {
  const position = usePosition(use, spec);
  use.editor.selection = new vscode.Selection(position, position);
}

/** True once the command took the editor away from the use site, or moved it inside the file. */
function hasLeft(use: OpenFixture, spec: CrossLanguageSpec): boolean {
  const editor = vscode.window.activeTextEditor;
  return (
    editor !== undefined &&
    (!samePath(editor.document.uri.fsPath, use.uri.fsPath) ||
      !editor.selection.active.isEqual(usePosition(use, spec)))
  );
}

/** Press the key once and wait, briefly, for the editor to go somewhere. */
export async function pressOnce(
  use: OpenFixture,
  spec: CrossLanguageSpec,
  waitMs = COMMAND_MS,
): Promise<boolean> {
  await vscode.window.showTextDocument(use.document, { preview: false });
  placeCursor(use, spec);
  await vscode.commands.executeCommand(spec.command);
  const deadline = Date.now() + waitMs;
  while (!hasLeft(use, spec) && Date.now() < deadline) await sleep(50);
  return hasLeft(use, spec);
}

/**
 * Keep pressing while the server is still loading, exactly as a user would: a press
 * that goes nowhere is fair, and the FIRST place the editor lands is the verdict.
 */
export async function pressUntilItLands(use: OpenFixture, spec: CrossLanguageSpec): Promise<void> {
  const deadline = Date.now() + SIDECAR_COLD_MS;
  while (!(await pressOnce(use, spec, LOAD_RETRY_MS))) {
    assert.ok(Date.now() < deadline, `${spec.name}: the editor never left ${activeFile()}`);
  }
}

function openTabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function tabFile(tab: vscode.Tab): string | undefined {
  return tab.input instanceof vscode.TabInputText ? tab.input.uri.fsPath : undefined;
}

/** No window state anywhere shows a decompiled file. */
function assertNothingDecompiledIsOpen(spec: CrossLanguageSpec): void {
  const shown = [
    ...openTabs().map(tabFile),
    ...vscode.window.visibleTextEditors.map((editor) => editor.document.uri.fsPath),
    ...vscode.workspace.textDocuments.map((document) => document.uri.fsPath),
  ];
  const decompiled = shown.filter((file) => file?.includes(DECOMPILED_DIRECTORY));
  assert.deepEqual(decompiled, [], `${spec.name}: decompiled source was opened`);
}

/** The active editor is a saved, real file holding exactly what is on disk. */
async function assertShowsOriginFile(
  editor: vscode.TextEditor,
  spec: CrossLanguageSpec,
): Promise<string> {
  const expected = workspaceFixturePath(spec.originFile);
  const { document } = editor;
  assert.equal(document.uri.scheme, 'file', `${spec.name}: not a file on disk`);
  assert.equal(
    comparablePath(document.uri.fsPath),
    comparablePath(expected),
    `${spec.name}: landed in the wrong file`,
  );
  assert.equal(document.languageId, spec.originLanguage, `${spec.name}: wrong language`);
  assert.equal(document.isUntitled, false, `${spec.name}: an untitled view`);
  assert.equal(document.isDirty, false, `${spec.name}: not the saved file`);
  const text = document.getText();
  assert.equal(text, await readFile(expected, 'utf8'), `${spec.name}: not the file on disk`);
  for (const trace of DECOMPILER_TRACES) {
    assert.equal(text.includes(trace), false, `${spec.name}: decompiler output (${trace})`);
  }
  return text;
}

/** The expected place, derived from the origin file's own text. */
function declaredPosition(document: vscode.TextDocument, spec: CrossLanguageSpec): vscode.Position {
  const text = document.getText();
  const at = text.indexOf(spec.declaration);
  assert.ok(at >= 0, `${spec.name}: the fixture declares no "${spec.declaration}"`);
  assert.equal(text.indexOf(spec.declaration, at + 1), -1, `${spec.name}: ambiguous declaration`);
  return document.positionAt(at + spec.declaration.indexOf(spec.landsOn));
}

/** The caret is on the declared name, and the name is on screen. */
function assertCaretOnDeclaration(editor: vscode.TextEditor, spec: CrossLanguageSpec): void {
  const expected = declaredPosition(editor.document, spec);
  const { active } = editor.selection;
  assert.equal(editor.selection.isEmpty, true, `${spec.name}: a selection, not a caret`);
  assert.equal(active.line + 1, expected.line + 1, `${spec.name}: wrong line`);
  assert.equal(active.character, expected.character, `${spec.name}: wrong column`);
  const word = editor.document.getWordRangeAtPosition(active);
  assert.ok(word, `${spec.name}: the caret is on no word`);
  assert.equal(
    editor.document.getText(word),
    spec.landsOn,
    `${spec.name}: caret on the wrong name`,
  );
  assert.ok(
    editor.visibleRanges.some((range) => range.contains(active)),
    `${spec.name}: the declaration is off screen`,
  );
}

/** The active tab names the origin file, and only the use and origin files are open. */
function assertTabs(spec: CrossLanguageSpec): void {
  const expected = workspaceFixturePath(spec.originFile);
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(active, `${spec.name}: no active tab`);
  assert.equal(active.label, path.basename(expected), `${spec.name}: wrong tab title`);
  assert.ok(samePath(tabFile(active), expected), `${spec.name}: the active tab shows another file`);
  const files = new Set(openTabs().map((tab) => comparablePath(tabFile(tab) ?? tab.label)));
  const allowed = [expected, workspaceFixturePath(spec.useFile)].map(comparablePath);
  assert.deepEqual(
    [...files].filter((file) => !allowed.includes(file)),
    [],
    `${spec.name}: an unrelated editor opened`,
  );
}

const PROVIDERS = new Map([
  [REVEAL_DECLARATION, 'vscode.executeDeclarationProvider'],
  [REVEAL_TYPE_DEFINITION, 'vscode.executeTypeDefinitionProvider'],
]);

function providerFor(spec: CrossLanguageSpec): string {
  return PROVIDERS.get(spec.command) ?? 'vscode.executeDefinitionProvider';
}

function targetOf(found: vscode.Location | vscode.LocationLink): vscode.Location {
  return 'targetUri' in found
    ? new vscode.Location(found.targetUri, found.targetSelectionRange ?? found.targetRange)
    : found;
}

/** Peek and the gutter see the same answer as F12: one target, the name itself. */
async function assertProviderAnswersOnlyOrigin(
  use: OpenFixture,
  spec: CrossLanguageSpec,
  origin: vscode.TextDocument,
): Promise<void> {
  const provider = providerFor(spec);
  const position = usePosition(use, spec);
  const found = await executeProvider<vscode.Location | vscode.LocationLink>(
    provider,
    use.uri,
    position,
  );
  assert.equal(found.length, 1, `${spec.name}: ${provider} must answer exactly the declaration`);
  const target = targetOf(found[0]!);
  assert.ok(samePath(target.uri.fsPath, origin.uri.fsPath), `${spec.name}: ${provider} elsewhere`);
  assert.equal(origin.getText(target.range), spec.landsOn, `${spec.name}: ${provider} range`);
}

/** Alt-Left returns to the very character the user pressed F12 on. */
async function assertNavigateBackReturns(use: OpenFixture, spec: CrossLanguageSpec): Promise<void> {
  const expected = usePosition(use, spec);
  await vscode.commands.executeCommand('workbench.action.navigateBack');
  await pollUntilResult(
    async () => samePath(activeFile(), use.uri.fsPath),
    (back) => back,
    COMMAND_MS,
    50,
    `${spec.name}: navigate back to the use site`,
  );
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor?.selection.active.isEqual(expected), `${spec.name}: back lost the use site`);
}

/** From the moment the server starts, every answer is the source or nothing at all. */
export async function assertNoAnswerIsDecompiled(
  use: OpenFixture,
  spec: CrossLanguageSpec,
): Promise<void> {
  const origin = workspaceFixturePath(spec.originFile);
  const position = usePosition(use, spec);
  const provider = providerFor(spec);
  await pollUntilResult(
    async () =>
      (
        await executeProvider<vscode.Location | vscode.LocationLink>(provider, use.uri, position)
      ).map((found) => targetOf(found).uri.fsPath),
    (files) => {
      const shown = files.filter((file) => !samePath(file, origin) && file !== use.uri.fsPath);
      assert.deepEqual(shown, [], `${spec.name}: answered outside the source while loading`);
      return files.some((file) => samePath(file, origin));
    },
    SIDECAR_COLD_MS,
    50,
    `${spec.name}: the original source`,
  );
}

/** Every assertion a user could make by looking at the window after pressing F12. */
export async function assertLandedOnOriginalSource(
  use: OpenFixture,
  spec: CrossLanguageSpec,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, `${spec.name}: no active editor`);
  assertNothingDecompiledIsOpen(spec);
  await assertShowsOriginFile(editor, spec);
  assertCaretOnDeclaration(editor, spec);
  assertTabs(spec);
  await assertProviderAnswersOnlyOrigin(use, spec, editor.document);
}

/** The whole gesture: F12 lands on the source, and Alt-Left comes back. */
export async function assertRoundTrip(use: OpenFixture, spec: CrossLanguageSpec): Promise<void> {
  await assertLandedOnOriginalSource(use, spec);
  await assertNavigateBackReturns(use, spec);
}
