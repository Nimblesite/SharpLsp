// Real command/LSP harness for [SE-CONTEXT-SORT-IMPLEMENTATION]. No providers are mocked.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateRealSharpLsp,
  openFixtureDocument,
  replaceDocumentText,
  revertDocument,
  workspaceFixturePath,
} from './refactor-test-helpers';
import {
  EXTENSION_ID,
  LSP_RESPONSE_TIMEOUT_MS,
  closeAllEditors,
  pollUntilResult,
} from './test-helpers';
import {
  CLASS_ANCHORS,
  assertAnchoredOrder,
  assertBlankLineBetween,
  assertBodySentinels,
  assertChildSymbol,
  assertClassRange,
  assertDecorations,
  assertLiveSentinels,
  assertOrderedSymbols,
  assertTreeChildren,
} from './sort-members-assertions';
import type {
  ExplorerProvider,
  ExtensionApi,
  LspRange,
  SavedSettings,
  SortOutcome,
  SortPolicy,
  SurfaceCase,
  TreeNode,
} from './sort-members-types';

export type { SortOutcome, SortPolicy, SurfaceCase } from './sort-members-types';

export { assertBlankLineBetween, assertLiveSentinels };

const COMMAND = 'sharplsp.sortMembers';
const FIXTURE_FILE = 'SortMembersCommand.cs';
const FIXTURE_SOLUTION = workspaceFixturePath('TestFixtures.sln');
const CLASS_NAME = 'SortMembersCommand';
const MEMBER_TIMEOUT_MS = LSP_RESPONSE_TIMEOUT_MS + 30_000;

let document: vscode.TextDocument;
let provider: ExplorerProvider;
let originalText: string;
let savedSettings: SavedSettings;

export async function initializeSortHarness(initialOrder: readonly string[]): Promise<void> {
  const client = await activateRealSharpLsp();
  assert.ok(client, 'the command suite must activate a real LanguageClient');
  ({ document } = await openFixtureDocument(FIXTURE_FILE));
  originalText = document.getText();
  savedSettings = captureSettings();
  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand('sharplsp.openSolution', FIXTURE_SOLUTION);
  });
  provider = getProvider();
  assert.strictEqual(provider, getProvider(), 'the activated extension owns one live explorer');
  assertClassNodeContract(await refreshNode(CLASS_NAME), initialOrder);
}

export async function prepareSortCase(): Promise<void> {
  ({ document } = await openFixtureDocument(FIXTURE_FILE));
  await restoreSettings();
  await revertDocument(document);
  assert.strictEqual(document.getText(), originalText, 'every case starts from the disk fixture');
  assert.ok(!document.isDirty, 'every case starts with a clean editor');
}

export async function cleanupSortHarness(): Promise<void> {
  await restoreSettings();
  await revertDocument(document);
  await closeAllEditors();
}

export function fixtureDocument(): vscode.TextDocument {
  assert.ok(document, 'Sort Members fixture document must be initialized');
  return document;
}

export function fixtureText(): string {
  assert.ok(originalText.length > 0, 'Sort Members fixture text must be initialized');
  return originalText;
}

function getProvider(): ExplorerProvider {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the VSIX host`);
  assert.ok(extension.isActive, `${EXTENSION_ID} must be active before reading its API`);
  assert.ok(extension.exports.explorerProvider, 'the real extension must export explorerProvider');
  assert.ok(extension.exports.getLspClient(), 'the exported API must retain the real LSP client');
  return extension.exports.explorerProvider;
}

function sortConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('sharplsp.memberSortOrder', document.uri);
}

function captureSettings(): SavedSettings {
  const config = sortConfiguration();
  return {
    hierarchy: config.inspect<string[]>('hierarchy')?.workspaceValue,
    accessibilityOrder: config.inspect<string[]>('accessibilityOrder')?.workspaceValue,
    categoryOrder: config.inspect<string[]>('categoryOrder')?.workspaceValue,
  };
}

async function restoreSettings(): Promise<void> {
  const config = sortConfiguration();
  await config.update('hierarchy', savedSettings.hierarchy, vscode.ConfigurationTarget.Workspace);
  await config.update(
    'accessibilityOrder',
    savedSettings.accessibilityOrder,
    vscode.ConfigurationTarget.Workspace,
  );
  await config.update(
    'categoryOrder',
    savedSettings.categoryOrder,
    vscode.ConfigurationTarget.Workspace,
  );
}

export async function configureSort(policy: SortPolicy): Promise<void> {
  const config = sortConfiguration();
  await config.update('hierarchy', policy.hierarchy, vscode.ConfigurationTarget.Workspace);
  await config.update(
    'accessibilityOrder',
    policy.accessibilityOrder,
    vscode.ConfigurationTarget.Workspace,
  );
  await config.update('categoryOrder', policy.categoryOrder, vscode.ConfigurationTarget.Workspace);
  assertConfigured(policy);
}

function assertConfigured(policy: SortPolicy): void {
  const config = sortConfiguration();
  assert.deepStrictEqual(config.get('hierarchy'), [...policy.hierarchy]);
  assert.deepStrictEqual(config.get('accessibilityOrder'), [...policy.accessibilityOrder]);
  assert.deepStrictEqual(config.get('categoryOrder'), [...policy.categoryOrder]);
  assert.strictEqual(config.get<string[]>('hierarchy')?.length, 3);
  assert.ok((config.get<string[]>('accessibilityOrder')?.length ?? 0) >= 2);
  assert.ok((config.get<string[]>('categoryOrder')?.length ?? 0) >= 4);
}

async function refreshNode(name: string): Promise<TreeNode> {
  await provider.refresh();
  const node = await pollUntilResult(
    async () => findNode(provider.getChildren(), name),
    (candidate) => candidate !== undefined,
    MEMBER_TIMEOUT_MS,
    1_000,
  );
  assert.ok(node, `the live explorer must expose ${name}`);
  return node;
}

function findNode(nodes: TreeNode[] | undefined, name: string): TreeNode | undefined {
  if (nodes === undefined) return undefined;
  for (const node of nodes) {
    if (node.sortName === name) return node;
    const child = findNode(node.children, name);
    if (child !== undefined) return child;
  }
  return undefined;
}

function assertClassNodeContract(node: TreeNode, expected: readonly string[]): void {
  assertCommonNode(node, CLASS_NAME);
  assert.strictEqual(node.symbolKind, 'Class');
  assert.strictEqual(node.contextValue, 'symbol.class');
  assert.ok(node.symbolRange, 'class node must have a server-provided range');
  assertClassRange(document, node.symbolRange);
  assertTreeChildren(node, expected);
}

function assertCommonNode(node: TreeNode, name: string): void {
  assert.strictEqual(node.nodeType, 'symbol');
  assert.strictEqual(node.sortName, name);
  assert.ok(nodeLabel(node).includes(name));
  assert.ok(node.parent, `${name} must retain its explorer parent`);
  assert.ok(node.symbolUri, `${name} must have a file URI`);
  assert.strictEqual(
    vscode.Uri.parse(node.symbolUri).fsPath.toLowerCase(),
    document.uri.fsPath.toLowerCase(),
  );
}

function nodeLabel(node: TreeNode): string {
  return typeof node.label === 'string' ? node.label : (node.label?.label ?? '');
}

function toRange(range: LspRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

async function requestTypeSymbol(name: string): Promise<vscode.DocumentSymbol | undefined> {
  const roots =
    (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    )) ?? [];
  return findDocumentSymbol(roots, name);
}

function findDocumentSymbol(
  symbols: readonly vscode.DocumentSymbol[],
  name: string,
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.name === name) return symbol;
    const child = findDocumentSymbol(symbol.children, name);
    if (child !== undefined) return child;
  }
  return undefined;
}

async function waitForTypeOrder(
  typeName: string,
  expected: readonly string[],
): Promise<vscode.DocumentSymbol> {
  const symbol = await pollUntilResult(
    async () => requestTypeSymbol(typeName),
    (candidate) => hasMemberOrder(candidate, expected),
    MEMBER_TIMEOUT_MS,
    500,
  );
  assert.ok(symbol, `the real document-symbol provider must return ${typeName}`);
  assertSymbolContract(symbol, typeName, expected);
  return symbol;
}

function hasMemberOrder(
  symbol: vscode.DocumentSymbol | undefined,
  expected: readonly string[],
): boolean {
  if (symbol === undefined) return false;
  return symbol.children.map((child) => child.name).join('|') === expected.join('|');
}

function assertSymbolContract(
  symbol: vscode.DocumentSymbol,
  typeName: string,
  expected: readonly string[],
): void {
  const actual = symbol.children.map((child) => child.name);
  assert.strictEqual(symbol.name, typeName);
  assert.strictEqual(
    symbol.children.length,
    expected.length,
    `${typeName} expected ${expected.join(', ')}; received ${actual.join(', ')}`,
  );
  assert.deepStrictEqual(actual, expected, `${typeName} members must follow source order`);
  for (const child of symbol.children) assertChildSymbol(document, child);
  for (let index = 1; index < symbol.children.length; index += 1) {
    assertOrderedSymbols(symbol.children[index - 1], symbol.children[index]);
  }
}

async function executeSortCommand(node: TreeNode): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes(COMMAND), `${COMMAND} must be registered by the real extension`);
  assert.strictEqual(
    vscode.window.activeTextEditor?.document.uri.toString(),
    document.uri.toString(),
  );
  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand(COMMAND, node);
  });
}

export async function assertInitialState(initial: readonly string[]): Promise<void> {
  await waitForTypeOrder(CLASS_NAME, initial);
  assert.strictEqual(document.getText(), originalText);
  assert.ok(!document.isDirty);
  assertAnchoredOrder(document.getText(), initial, CLASS_ANCHORS);
  assertDecorations(document.getText());
  assertBodySentinels(document.getText());
}

export async function sortAndObserve(expected: readonly string[]): Promise<SortOutcome> {
  const node = await refreshNode(CLASS_NAME);
  assertClassNodeContract(node, expected);
  const beforeText = document.getText();
  const beforeVersion = document.version;
  await executeSortCommand(node);
  await waitForTypeOrder(CLASS_NAME, expected);
  const afterText = document.getText();
  const afterVersion = document.version;
  assert.ok(afterVersion > beforeVersion, 'sorting advances the live document version');
  assert.ok(document.isDirty, 'sorting changes the open buffer without saving it');
  assert.notStrictEqual(afterText, beforeText, 'an unsorted buffer must change');
  assertAnchoredOrder(afterText, expected, CLASS_ANCHORS);
  assertDecorations(afterText);
  assertBodySentinels(afterText);
  return { beforeText, beforeVersion, afterText, afterVersion };
}

export async function assertNoOp(outcome: SortOutcome, expected: readonly string[]): Promise<void> {
  const node = await refreshNode(CLASS_NAME);
  assertClassNodeContract(node, expected);
  const beforeVersion = document.version;
  await executeSortCommand(node);
  assert.strictEqual(
    document.version,
    beforeVersion,
    'already-sorted command is version-idempotent',
  );
  assert.strictEqual(
    document.getText(),
    outcome.afterText,
    'already-sorted command is text-idempotent',
  );
  assert.strictEqual(document.version, outcome.afterVersion);
  assert.ok(document.isDirty, 'no-op sorting does not silently save the buffer');
  await waitForTypeOrder(CLASS_NAME, expected);
}

export async function undoCleanSort(
  outcome: SortOutcome,
  initial: readonly string[],
): Promise<void> {
  const beforeVersion = document.version;
  await runEditorCommand('undo');
  await waitForText(outcome.beforeText);
  assert.ok(document.version > beforeVersion, 'undo advances the document version');
  assert.strictEqual(document.getText(), originalText);
  assert.ok(!document.isDirty, 'undo returns the originally clean fixture to clean state');
  await waitForTypeOrder(CLASS_NAME, initial);
  assertAnchoredOrder(document.getText(), initial, CLASS_ANCHORS);
  assertDecorations(document.getText());
}

export async function redoSort(outcome: SortOutcome, expected: readonly string[]): Promise<void> {
  const beforeVersion = document.version;
  await runEditorCommand('redo');
  await waitForText(outcome.afterText);
  assert.ok(document.version > beforeVersion, 'redo advances the document version');
  assert.strictEqual(document.getText(), outcome.afterText);
  assert.ok(document.isDirty, 'redo restores the unsaved sorted edit');
  await waitForTypeOrder(CLASS_NAME, expected);
  assertAnchoredOrder(document.getText(), expected, CLASS_ANCHORS);
  assertDecorations(document.getText());
}

async function runEditorCommand(command: 'undo' | 'redo'): Promise<void> {
  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand(command);
  });
}

async function waitForText(expected: string): Promise<void> {
  const text = await pollUntilResult(
    async () => document.getText(),
    (candidate) => candidate === expected,
    LSP_RESPONSE_TIMEOUT_MS,
    250,
  );
  assert.strictEqual(text, expected, 'the editor must reach the requested undo/redo text');
}

export function buildLiveText(): string {
  return originalText
    .replace('Private helper must travel', 'Unsaved helper must travel')
    .replace('return "ZEBRA";', 'return "LIVE-ZEBRA";')
    .replace('_zeta = 7;', '_zeta = 99;');
}

export async function installLiveBuffer(
  liveText: string,
  initial: readonly string[],
): Promise<void> {
  await replaceDocumentText(document, liveText);
  assert.notStrictEqual(liveText, originalText);
  assert.strictEqual(document.getText(), liveText);
  assert.ok(document.isDirty, 'the user-edited VFS buffer must be dirty');
  assert.ok(!originalText.includes('LIVE-ZEBRA'));
  assert.ok(!originalText.includes('_zeta = 99'));
  assert.ok(document.getText().includes('Unsaved helper must travel'));
  await waitForTypeOrder(CLASS_NAME, initial);
  assertClassNodeContract(await refreshNode(CLASS_NAME), initial);
}

export async function undoLiveSort(
  outcome: SortOutcome,
  liveText: string,
  initial: readonly string[],
): Promise<void> {
  const beforeVersion = document.version;
  await runEditorCommand('undo');
  await waitForText(liveText);
  assert.ok(document.version > beforeVersion);
  assert.strictEqual(document.getText(), outcome.beforeText);
  assert.ok(document.isDirty, 'undoing sort retains the earlier unsaved user edit');
  await waitForTypeOrder(CLASS_NAME, initial);
  assertAnchoredOrder(document.getText(), initial, CLASS_ANCHORS);
  assertLiveSentinels(document.getText());
}

export async function exerciseTypeSurface(surface: SurfaceCase): Promise<void> {
  await waitForTypeOrder(surface.typeName, surface.initial);
  const node = await refreshNode(surface.typeName);
  assertSurfaceNode(node, surface);
  const beforeText = document.getText();
  const beforeVersion = document.version;
  await executeSortCommand(node);
  const symbol = await waitForTypeOrder(surface.typeName, surface.expected);
  assert.ok(document.version > beforeVersion, `${surface.typeName} sort advances its version`);
  assert.ok(document.isDirty, `${surface.typeName} sort leaves an unsaved edit`);
  assert.notStrictEqual(document.getText(), beforeText);
  const sortedText = document.getText(symbol.range);
  assertAnchoredOrder(sortedText, surface.expected, surface.anchors);
  surface.validateSorted?.(sortedText);
  await undoSurface(beforeText, surface);
}

function assertSurfaceNode(node: TreeNode, surface: SurfaceCase): void {
  assertCommonNode(node, surface.typeName);
  assert.ok(surface.kinds.includes(node.symbolKind ?? ''), `${surface.typeName} has a type kind`);
  assert.ok(
    surface.contexts.includes(node.contextValue ?? ''),
    `${surface.typeName} has a type context`,
  );
  assert.ok(node.symbolRange, `${surface.typeName} must have a real type range`);
  const text = document.getText(toRange(node.symbolRange));
  assert.ok(text.includes(surface.typeName));
  assertAnchoredOrder(text, surface.initial, surface.anchors);
  assertTreeChildren(node, surface.initial);
}

async function undoSurface(beforeText: string, surface: SurfaceCase): Promise<void> {
  const beforeVersion = document.version;
  await runEditorCommand('undo');
  await waitForText(beforeText);
  assert.ok(document.version > beforeVersion, `${surface.typeName} undo advances its version`);
  assert.strictEqual(document.getText(), originalText);
  assert.ok(!document.isDirty, `${surface.typeName} undo restores a clean fixture`);
  await waitForTypeOrder(surface.typeName, surface.initial);
}

export async function assertNonTypeRejected(
  initial: readonly string[],
  methodName: string,
): Promise<void> {
  await waitForTypeOrder(CLASS_NAME, initial);
  const classNode = await refreshNode(CLASS_NAME);
  const method = classNode.children.find((child) => child.sortName === methodName);
  assert.ok(method, `the live tree must expose method ${methodName}`);
  assert.strictEqual(method.symbolKind, 'Method');
  assert.strictEqual(method.contextValue, 'symbol.method');
  assert.ok(method.symbolUri && method.symbolRange, 'method node must carry its real URI/range');
  const beforeText = document.getText();
  const beforeVersion = document.version;
  await executeSortCommand(method);
  assert.strictEqual(document.getText(), beforeText, 'a non-type range must not be edited');
  assert.strictEqual(document.version, beforeVersion, 'a rejected range must not change version');
  assert.ok(!document.isDirty, 'a rejected range must not dirty the document');
  await waitForTypeOrder(CLASS_NAME, initial);
}
