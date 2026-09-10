// "Go to Test" — the Testing view's built-in reveal action — driven against a
// REAL discovered tree. Covers [TEST-GOTO-SOURCE].
//
// The workbench command is `testing.editFocusedTest` ("Go to Test"). It is
// menu-gated on `testItemHasUri` and does nothing more than reveal the focused
// item at its `TestItem.uri` and `TestItem.range`. So the whole feature IS those
// two properties: an item with no URI never offers the action, an item whose URI
// is a DIRECTORY opens nothing, and an item with no range lands on line 1 of a
// file holding a hundred tests instead of on the test the user right-clicked.
//
// Reported bug: right-click a test → Go to Test → "it doesn't find the test or
// even open the file that it's in". Discovery attributes every item the
// *project directory* (`vscode.Uri.file(dirOf(target))` in `testing.ts`) and
// never a range, so there is nothing for the reveal to open.
//
// F# leads here, per the project's F#-first rule: an idiomatic backtick binding
// in a module must resolve to its own line in the `.fs` file exactly as a C#
// `[Fact]` resolves to its line in the `.cs` file.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { forEachLeaf } from '../../test-tree.js';
import { AnchoredSource } from './debug-anchors';
import {
  createSolution,
  projectXml,
  warmDiscovery,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import {
  activateTestExplorer,
  discoverSolution,
  drainDiscovery,
  findItem,
} from './test-explorer-kit';
import { closeAllEditors, comparablePath, removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/**
 * The F# fixture, ANCHORED — its own module namespace so its FQNs never collide
 * with the other Test Explorer suites' shared result cache.
 *
 * Both bindings live in ONE file at DIFFERENT lines: a reveal that always
 * landed on line 1 would satisfy "has a range" and still be the reported bug.
 */
const FS_SOURCE = new AnchoredSource([
  'module Fs.Goto.Fixtures',
  '',
  'open Xunit',
  '',
  '[<Fact>]',
  'let ``navigates to the test`` () = Assert.Equal(3, 1 + 2)              // @anchor:fs-fact',
  '',
  '[<Theory>]',
  '[<InlineData(2, 2, 4)>]',
  'let ``navigates to the theory`` (a: int) (b: int) (expected: int) =    // @anchor:fs-theory',
  '    Assert.Equal(expected, a + b)',
  '',
]);

/** The C# fixture, ANCHORED — same shape, same file, two distinct lines. */
const CS_SOURCE = new AnchoredSource([
  'using Xunit;',
  '',
  'namespace Cs.Goto.Fixtures;',
  '',
  'public class NavigationTests                                           // @anchor:cs-class',
  '{',
  '    [Fact]',
  '    public void Navigates_ToTheTest()                                  // @anchor:cs-fact',
  '    {',
  '        Assert.Equal(3, 1 + 2);',
  '    }',
  '',
  '    [Theory]',
  '    [InlineData(2, 2, 4)]',
  '    public void Navigates_ToTheTheory(int a, int b, int expected)      // @anchor:cs-theory',
  '    {',
  '        Assert.Equal(expected, a + b);',
  '    }',
  '}',
  '',
]);

const FS_PROJECT = 'GotoFs';
const FS_FILE = 'Tests.fs';
const CS_PROJECT = 'GotoCs';
const CS_FILE = 'Tests.cs';

const FS_FACT = 'Fs.Goto.Fixtures.navigates to the test';
const FS_THEORY = 'Fs.Goto.Fixtures.navigates to the theory';
const CS_FACT = 'Cs.Goto.Fixtures.NavigationTests.Navigates_ToTheTest';
const CS_THEORY = 'Cs.Goto.Fixtures.NavigationTests.Navigates_ToTheTheory';

/** Every FQN the two fixtures expose — F# first. */
const EXPECTED = [FS_FACT, FS_THEORY, CS_FACT, CS_THEORY] as const;

/** The declaring file and 0-based declaration line each FQN must reveal. */
interface GotoExpectation {
  readonly fqn: string;
  readonly fileName: string;
  readonly line: number;
  /** Text that MUST appear on the revealed line — the declaration itself. */
  readonly declares: string;
}

/** The whole contract, as data, so every assertion below reads off one table. */
const EXPECTATIONS: readonly GotoExpectation[] = [
  {
    fqn: FS_FACT,
    fileName: FS_FILE,
    line: FS_SOURCE.line('fs-fact'),
    declares: 'navigates to the test',
  },
  {
    fqn: FS_THEORY,
    fileName: FS_FILE,
    line: FS_SOURCE.line('fs-theory'),
    declares: 'navigates to the theory',
  },
  {
    fqn: CS_FACT,
    fileName: CS_FILE,
    line: CS_SOURCE.line('cs-fact'),
    declares: 'Navigates_ToTheTest',
  },
  {
    fqn: CS_THEORY,
    fileName: CS_FILE,
    line: CS_SOURCE.line('cs-theory'),
    declares: 'Navigates_ToTheTheory',
  },
];

/** The expectation for `fqn`, failing loudly on a typo. */
function expectationFor(fqn: string): GotoExpectation {
  const expectation = EXPECTATIONS.find((candidate) => candidate.fqn === fqn);
  assert.ok(expectation, `no Go to Test expectation declared for '${fqn}'`);
  return expectation;
}

/** The discovered leaf for `fqn`, asserted present. */
function leafFor(api: SharpLspExtensionApi, fqn: string): vscode.TestItem {
  const item = findItem(api.testController.items, fqn);
  assert.ok(item, `'${fqn}' must be in the tree before Go to Test can reveal it`);
  return item;
}

/**
 * The URI "Go to Test" would hand the editor, asserted to be a real FILE.
 *
 * `testItemHasUri` only gates on a URI EXISTING, so a directory passes the menu
 * gate and then opens nothing — which is exactly the reported symptom.
 */
function gotoUri(item: vscode.TestItem): vscode.Uri {
  const uri = item.uri;
  assert.ok(
    uri,
    `Go to Test is menu-gated on 'testItemHasUri'; '${item.label}' carries no URI, so the ` +
      'action is not even offered',
  );
  assert.strictEqual(
    fs.existsSync(uri.fsPath),
    true,
    `Go to Test on '${item.label}' would open ${uri.fsPath}, which does not exist`,
  );
  assert.strictEqual(
    fs.statSync(uri.fsPath).isFile(),
    true,
    `Go to Test on '${item.label}' must open the SOURCE FILE that declares it; ` +
      `${uri.fsPath} is a directory, so the editor never moves`,
  );
  return uri;
}

/** The range "Go to Test" would select, asserted present. */
function gotoRange(item: vscode.TestItem): vscode.Range {
  const range = item.range;
  assert.ok(
    range,
    `'${item.label}' carries no range, so Go to Test lands on line 1 of its file instead of ` +
      'on the test the user right-clicked',
  );
  return range;
}

/** Open a URI the way the reveal does, reporting a failure as the FEATURE's. */
async function openForGoto(uri: vscode.Uri, label: string): Promise<vscode.TextDocument> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    return assert.fail(`Go to Test on '${label}' could not open ${uri.fsPath}: ${String(error)}`);
  }
}

/**
 * Do exactly what `testing.editFocusedTest` → `vscode.revealTest` does: open
 * `item.uri` and select `item.range`. Returns the editor the user would land in.
 */
async function goToTest(item: vscode.TestItem): Promise<vscode.TextEditor> {
  const uri = gotoUri(item);
  const range = gotoRange(item);
  const document = await openForGoto(uri, item.label);
  return await vscode.window.showTextDocument(document, { selection: range, preview: false });
}

/** Assert the editor a reveal produced is the one the expectation describes. */
function assertRevealed(
  editor: vscode.TextEditor,
  item: vscode.TestItem,
  expectation: GotoExpectation,
  projectDir: string,
): void {
  const expectedPath = path.join(projectDir, expectation.fileName);
  assert.strictEqual(
    comparablePath(editor.document.uri.fsPath),
    comparablePath(expectedPath),
    `Go to Test on '${expectation.fqn}' must open ${expectation.fileName}`,
  );
  const line = gotoRange(item).start.line;
  assert.strictEqual(
    line,
    expectation.line,
    `Go to Test on '${expectation.fqn}' must land on its declaration (0-based line ` +
      `${String(expectation.line)}), not line ${String(line)}`,
  );
  assert.strictEqual(
    editor.document.lineAt(line).text.includes(expectation.declares),
    true,
    `the revealed line must DECLARE the test; line ${String(line)} of ${expectation.fileName} ` +
      `reads: ${editor.document.lineAt(line).text.trim()}`,
  );
  assert.strictEqual(
    editor.selection.active.line,
    expectation.line,
    `the cursor must sit on '${expectation.fqn}' after the reveal`,
  );
}

/** Every LEAF in the settled tree — the tests, never the group nodes. */
function leaves(api: SharpLspExtensionApi): vscode.TestItem[] {
  const items: vscode.TestItem[] = [];
  forEachLeaf(api.testController.items, (item) => items.push(item));
  return items;
}

suite('Test Explorer — Go to Test reveals the declaring source', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let fsProjDir: string;
  let csProjDir: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-goto-test-'));
    fsProjDir = writeProject(
      path.join(root, FS_PROJECT),
      `${FS_PROJECT}.fsproj`,
      projectXml(XUNIT_PACKAGES, FS_FILE),
      FS_FILE,
      FS_SOURCE.text,
    );
    csProjDir = writeProject(
      path.join(root, CS_PROJECT),
      `${CS_PROJECT}.csproj`,
      projectXml(XUNIT_PACKAGES),
      CS_FILE,
      CS_SOURCE.text,
    );
    slnPath = await createSolution(root, 'Goto', [fsProjDir, csProjDir]);
    await warmDiscovery(slnPath, root);
  });

  teardown(async () => {
    await closeAllEditors();
    await drainDiscovery(() => {
      api.explorerProvider.clear();
    }, api.testController);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await closeAllEditors();
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('Go to Test on an F# backtick test opens its .fs file at the binding', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ids = await discoverSolution(api, slnPath, EXPECTED);
    assert.strictEqual(ids.includes(FS_FACT), true, `discovery must surface ${FS_FACT}`);
    assert.strictEqual(ids.includes(FS_THEORY), true, `discovery must surface ${FS_THEORY}`);

    const fact = leafFor(api, FS_FACT);
    const factUri = gotoUri(fact);
    assert.strictEqual(
      path.basename(factUri.fsPath),
      FS_FILE,
      `an F# test must point at the .fs file that declares it, not ${factUri.fsPath}`,
    );
    assert.strictEqual(
      comparablePath(factUri.fsPath),
      comparablePath(path.join(fsProjDir, FS_FILE)),
      'the URI must be the fixture source file itself',
    );
    const factEditor = await goToTest(fact);
    assertRevealed(factEditor, fact, expectationFor(FS_FACT), fsProjDir);

    const theory = leafFor(api, FS_THEORY);
    const theoryEditor = await goToTest(theory);
    assertRevealed(theoryEditor, theory, expectationFor(FS_THEORY), fsProjDir);
    assert.notStrictEqual(
      gotoRange(theory).start.line,
      gotoRange(fact).start.line,
      'two tests in ONE file must reveal at DIFFERENT lines — a constant range is the bug',
    );
  });

  test('Go to Test on a C# test opens its .cs file at the method', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ids = await discoverSolution(api, slnPath, EXPECTED);
    assert.strictEqual(ids.includes(CS_FACT), true, `discovery must surface ${CS_FACT}`);

    const fact = leafFor(api, CS_FACT);
    const factUri = gotoUri(fact);
    assert.strictEqual(
      path.extname(factUri.fsPath),
      '.cs',
      `a C# test must point at a .cs file, not ${factUri.fsPath}`,
    );
    assert.strictEqual(
      comparablePath(factUri.fsPath),
      comparablePath(path.join(csProjDir, CS_FILE)),
      'the URI must be the fixture source file itself',
    );
    const factEditor = await goToTest(fact);
    assertRevealed(factEditor, fact, expectationFor(CS_FACT), csProjDir);

    const theory = leafFor(api, CS_THEORY);
    const theoryEditor = await goToTest(theory);
    assertRevealed(theoryEditor, theory, expectationFor(CS_THEORY), csProjDir);
    assert.notStrictEqual(
      gotoRange(theory).start.line,
      gotoRange(fact).start.line,
      'two methods in ONE class must reveal at DIFFERENT lines',
    );
  });

  test('every discovered test offers Go to Test — a file URI and a declaration range', async function () {
    this.timeout(DOTNET_CLI_MS);
    await discoverSolution(api, slnPath, EXPECTED);
    const tests = leaves(api);
    assert.strictEqual(
      tests.length,
      EXPECTATIONS.length,
      `the fixture exposes ${String(EXPECTATIONS.length)} tests; the tree holds ` +
        String(tests.length),
    );
    const withoutUri = tests.filter((item) => item.uri === undefined).map((item) => item.id);
    assert.deepStrictEqual(
      withoutUri,
      [],
      'a test with no URI fails the `testItemHasUri` menu gate — Go to Test is not even offered',
    );
    const notFiles = tests
      .filter((item) => item.uri !== undefined && !fs.statSync(item.uri.fsPath).isFile())
      .map((item) => `${item.id} -> ${item.uri?.fsPath ?? ''}`);
    assert.deepStrictEqual(
      notFiles,
      [],
      'every test must carry the SOURCE FILE that declares it, never a directory',
    );
    const withoutRange = tests.filter((item) => item.range === undefined).map((item) => item.id);
    assert.deepStrictEqual(
      withoutRange,
      [],
      'every test must carry the range of its own declaration',
    );
    for (const expectation of EXPECTATIONS) {
      const item = leafFor(api, expectation.fqn);
      assert.strictEqual(
        path.basename(gotoUri(item).fsPath),
        expectation.fileName,
        `${expectation.fqn} is declared in ${expectation.fileName}`,
      );
      assert.strictEqual(
        gotoRange(item).start.line,
        expectation.line,
        `${expectation.fqn} is declared on 0-based line ${String(expectation.line)}`,
      );
    }
  });
});
