// Editor navigation through the real extension and the real host:
// "Go to Related File" ([SHARPLSP-FEATURES-NAVIGATION-RELATED]) and
// "Go to Next/Previous Member" ([SHARPLSP-FEATURES-NAVIGATION-MEMBERS]).
//
// Each test drives the COMMAND a user runs and asserts what the editor shows
// afterwards — the active document, the caret — never only the reply.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openCSharpOutline, openFSharpFile, waitForDocumentSymbols } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';
import { useLspTestSuite } from './lsp-suite-kit';
import { useUiStubs } from './ui-stubs';

const RELATED = 'sharplsp.goToRelatedFile';
const NEXT = 'sharplsp.goToNextMember';
const PREVIOUS = 'sharplsp.goToPreviousMember';

const MEMBERS_CS = `namespace N;
public class A
{
    public int F;
    public void M()
    {
        var x = 1;
    }
    public int P { get; set; }
}
`;

const MEMBERS_FS = `module Members

let value = 41

let next x = x + 1
`;

/** The active editor, which every command here acts on. */
function activeEditor(): vscode.TextEditor {
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, 'a document is active');
  return editor;
}

/** Put the caret at a position, as a click would. */
function placeCaret(line: number, character: number): void {
  const at = new vscode.Position(line, character);
  activeEditor().selection = new vscode.Selection(at, at);
}

/** Run a member command and return where the caret ended up. */
async function step(command: string): Promise<[number, number]> {
  await vscode.commands.executeCommand(command);
  const { active } = activeEditor().selection;
  return [active.line, active.character];
}

suite('LSP Integration — Editor Navigation', () => {
  const tmpDir = useLspTestSuite('editor-nav-');
  const stubs = useUiStubs();

  test('Go to Related File opens the only sibling, picks among several, and says when there is none', async function () {
    this.timeout(LSP_RESPONSE_MS * 3);
    const dir = tmpDir();
    for (const name of ['Form1.Designer.cs', 'Form1.resx', 'Pair.Generated.cs', 'Form10.cs']) {
      fs.writeFileSync(path.join(dir, name), '// related\n');
    }

    // Interaction 1 — one sibling: it opens with no question asked.
    await openCSharpOutline(dir, 'Pair.cs', 'public class Pair { }\n');
    await vscode.commands.executeCommand(RELATED);
    assert.strictEqual(path.basename(activeEditor().document.fileName), 'Pair.Generated.cs');
    assert.strictEqual(stubs().log.quickPickItems.length, 0, 'nothing to choose between');
    assert.deepStrictEqual(stubs().log.infoMessages, []);

    // Interaction 2 — several siblings: a picker lists exactly them, in order,
    // never the look-alike Form10.cs, and the picked one opens.
    await openCSharpOutline(dir, 'Form1.cs', 'public class Form1 { }\n');
    stubs().queuePick('Form1.resx');
    await vscode.commands.executeCommand(RELATED);
    const offered = (stubs().log.quickPickItems[0] ?? []).map(
      (item) => (item as { label: string }).label,
    );
    assert.deepStrictEqual(offered, ['Form1.Designer.cs', 'Form1.resx']);
    assert.strictEqual(stubs().log.quickPickOptions[0]?.placeHolder, 'Go to related file');
    assert.strictEqual(path.basename(activeEditor().document.fileName), 'Form1.resx');

    // Interaction 3 — a dismissed picker opens nothing.
    await openCSharpOutline(dir, 'Form1.cs', 'public class Form1 { }\n');
    await vscode.commands.executeCommand(RELATED);
    assert.strictEqual(stubs().log.quickPickItems.length, 2, 'the picker was shown again');
    assert.strictEqual(path.basename(activeEditor().document.fileName), 'Form1.cs');

    // Interaction 4 — a file that stands alone says so and stays put.
    await openCSharpOutline(dir, 'Form10.cs', 'public class Form10 { }\n');
    await vscode.commands.executeCommand(RELATED);
    assert.deepStrictEqual(stubs().log.infoMessages, ['SharpLsp: this file has no related files.']);
    assert.strictEqual(path.basename(activeEditor().document.fileName), 'Form10.cs');
  });

  test('Go to Next/Previous Member walks the C# outline and stops at its ends', async function () {
    this.timeout(LSP_RESPONSE_MS * 3);
    await openCSharpOutline(tmpDir(), 'Members.cs', MEMBERS_CS);

    // Interaction 1 — next, from the top: class, field, method, property.
    placeCaret(0, 0);
    assert.deepStrictEqual(await step(NEXT), [1, 13]);
    assert.deepStrictEqual(await step(NEXT), [3, 15]);
    assert.deepStrictEqual(await step(NEXT), [4, 16]);
    assert.deepStrictEqual(await step(NEXT), [8, 15]);
    // Interaction 2 — past the last member the caret stays where it is.
    assert.deepStrictEqual(await step(NEXT), [8, 15]);
    // Interaction 3 — previous walks back, and stops at the first member.
    assert.deepStrictEqual(await step(PREVIOUS), [4, 16]);
    assert.deepStrictEqual(await step(PREVIOUS), [3, 15]);
    assert.deepStrictEqual(await step(PREVIOUS), [1, 13]);
    assert.deepStrictEqual(await step(PREVIOUS), [1, 13]);
    // Interaction 4 — from inside a body: back to its own name, on to the next.
    placeCaret(6, 12);
    assert.deepStrictEqual(await step(PREVIOUS), [4, 16]);
    placeCaret(6, 12);
    assert.deepStrictEqual(await step(NEXT), [8, 15]);
    assert.ok(activeEditor().selection.isEmpty, 'the caret moves; nothing is selected');
  });

  test('Go to Next/Previous Member walks the F# outline', async function () {
    this.timeout(LSP_RESPONSE_MS * 3);
    const { uri } = await openFSharpFile(tmpDir(), 'Members.fs', MEMBERS_FS);
    const symbols = await waitForDocumentSymbols(uri, LSP_RESPONSE_MS);
    assert.ok(symbols.length > 0, 'the F# outline arrived');

    // Interaction 1 — next from the module line reaches each binding in order.
    placeCaret(1, 0);
    assert.deepStrictEqual(await step(NEXT), [2, 4]);
    assert.deepStrictEqual(await step(NEXT), [4, 4]);
    assert.deepStrictEqual(await step(NEXT), [4, 4]);
    // Interaction 2 — and previous walks back to the first binding.
    assert.deepStrictEqual(await step(PREVIOUS), [2, 4]);
    // Interaction 3 — from inside `next`'s body: back to its own name.
    placeCaret(4, 14);
    assert.deepStrictEqual(await step(PREVIOUS), [4, 4]);
  });
});
