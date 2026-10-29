// Implements [REFACTOR-NEVER-SILENT]: the client hides failed requests
// (`revealOutputChannelOn: Never`), so middleware on `resolveCodeAction`
// reports each failure ONCE, in the exact words the spec gives, with a
// `Show Log` button that reveals the SharpLsp channel. A failed
// `sharplsp.addReferenceAndImport` is covered through the real command in
// csharp-reference-import.test.ts.
//
// Every test drives the REAL language client of the activated extension: the
// middleware is the client's own, `next` sends the real request to the real
// server, exactly as vscode-languageclient's own features invoke it.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  CodeActionResolveRequest,
  type LanguageClient,
  type ResolveCodeActionSignature,
} from 'vscode-languageclient/node';
import {
  failureMessage,
  NO_CHANGES_REASON,
  SERVER_GONE_REASON,
} from '../../code-action-failures.js';
import { rawCodeActions } from './csharp-refactor-test-kit';
import { diagnosticCode, positionOf } from './document-anchors';
import {
  activateRealSharpLsp,
  applyWorkspaceEdit,
  replaceDocumentText,
  useRefactorFixture,
  waitForMatchingDiagnostics,
  type OpenFixture,
} from './refactor-test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';
import { useUiStubs } from './ui-stubs';
import * as log from '../../log.js';

/** One unresolved `StringBuilder` — the CS0246 the quick fix clears. */
const MISSING_USING =
  'namespace SharpLsp.TestFixtures.NeverSilent;\n\npublic class Probe\n{\n' +
  '    public object Make() => new StringBuilder(); // missing-using-sentinel\n}\n';

/** The raw protocol shape `next` sends, as the client's own feature does. */
interface WireCodeAction {
  readonly title: string;
  readonly kind: string;
  readonly data?: { readonly id?: number; readonly uri?: string };
}

/** A wire text edit: `{ range, newText }`. */
interface WireTextEdit {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly newText: string;
}

/** The wire `WorkspaceEdit` the server answers a resolve with, in either LSP
 * shape: per-document `changes`, or `documentChanges` resource operations. */
interface WireWorkspaceEdit {
  readonly changes?: Record<string, readonly WireTextEdit[]>;
  readonly documentChanges?: readonly {
    readonly textDocument?: { readonly uri?: string };
    readonly edits?: readonly WireTextEdit[];
  }[];
}

/** The real client's middleware `next` for `codeAction/resolve`: the raw
 * request, then the same protocol→VS Code conversion the client's own feature
 * performs before the middleware sees the answer. */
function resolveNext(client: LanguageClient): ResolveCodeActionSignature {
  return async (item, token) => {
    const wire = await client.sendRequest<WireCodeAction & { edit?: WireWorkspaceEdit }>(
      CodeActionResolveRequest.method,
      item as unknown,
      token,
    );
    if (wire === null || wire === undefined) return item;
    const resolved = new vscode.CodeAction(item.title, item.kind);
    resolved.edit = asWorkspaceEdit(wire.edit);
    return resolved;
  };
}

/** A protocol `WorkspaceEdit` as a real `vscode.WorkspaceEdit`. */
function asWorkspaceEdit(wire: WireWorkspaceEdit | undefined): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  const asTextEdit = (textEdit: WireTextEdit): vscode.TextEdit =>
    new vscode.TextEdit(
      new vscode.Range(
        new vscode.Position(textEdit.range.start.line, textEdit.range.start.character),
        new vscode.Position(textEdit.range.end.line, textEdit.range.end.character),
      ),
      textEdit.newText,
    );
  for (const [uri, textEdits] of Object.entries(wire?.changes ?? {})) {
    edit.set(vscode.Uri.parse(uri), textEdits.map(asTextEdit));
  }
  for (const change of wire?.documentChanges ?? []) {
    const uri = change.textDocument?.uri;
    if (uri !== undefined) edit.set(vscode.Uri.parse(uri), (change.edits ?? []).map(asTextEdit));
  }
  return edit;
}

/** The quick fix importing `System.Text` for the probe's `StringBuilder`. */
async function systemTextFix(
  fixture: OpenFixture,
): Promise<{ item: WireCodeAction; range: vscode.Range }> {
  const caret = positionOf(fixture.document, 'new StringBuilder()', 'StringBuilder');
  const range = new vscode.Range(caret, caret);
  const actions = await rawCodeActions(fixture.uri, range);
  const fix = actions.find(
    (action) => action.data?.id !== undefined && action.title.includes('System.Text'),
  );
  assert.ok(
    fix,
    `a System.Text import fix must be offered: ${actions.map((a) => a.title).join(', ')}`,
  );
  return { item: fix as WireCodeAction, range };
}

/** Count reveals of the SharpLsp channel until `restore` puts `show` back. */
function stubShowLog(): { readonly shown: () => number; readonly restore: () => void } {
  const channel = log.output();
  // Read and replace `show` without naming its deprecated two-argument overload.
  const original: unknown = Reflect.get(channel, 'show');
  assert.ok(typeof original === 'function', 'the channel has a show method');
  let shown = 0;
  const counting = (preserveFocus?: boolean): void => {
    shown += 1;
    Reflect.apply(original, channel, [preserveFocus]);
  };
  Reflect.set(channel, 'show', counting);
  return { shown: () => shown, restore: () => Reflect.set(channel, 'show', original) };
}

suite('Code actions never fail silently [REFACTOR-NEVER-SILENT]', function () {
  this.timeout(120_000);
  const stubs = useUiStubs();
  const refactor = useRefactorFixture('RefactorCore.cs');

  teardown(async () => {
    await replaceDocumentText(refactor.fixture.document, refactor.committedText);
  });

  test('an expired quick fix reports exactly one message; Show Log reveals the channel', async () => {
    const client = await activateRealSharpLsp();
    const resolve = client.middleware.resolveCodeAction;
    assert.ok(resolve, 'the client must carry the resolveCodeAction middleware');
    await replaceDocumentText(refactor.fixture.document, MISSING_USING);
    await waitForMatchingDiagnostics(
      refactor.fixture.uri,
      (diagnostics) => diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === 'CS0246'),
      LSP_RESPONSE_MS,
    );

    // Interaction 1 — the healthy resolve: the fix resolves to a real edit and
    // the middleware shows NOTHING. This is the no-failure control.
    const { item } = await systemTextFix(refactor.fixture);
    const resolved = await resolve(
      item as unknown as vscode.CodeAction,
      new vscode.CancellationTokenSource().token,
      resolveNext(client),
    );
    assert.ok(resolved, 'the healthy resolve must answer the action');
    assert.strictEqual(stubs().log.errorMessages.length, 0, 'a healthy resolve says nothing');

    // Interaction 2 — the SAME item again: the sidecar consumed its id, the
    // resolve fails, and exactly ONE error message appears, in the exact words.
    stubs().queueError('Show Log');
    const showLog = stubShowLog();
    let expired: vscode.CodeAction | null | undefined;
    try {
      expired = await resolve(
        item as unknown as vscode.CodeAction,
        new vscode.CancellationTokenSource().token,
        resolveNext(client),
      );
    } finally {
      showLog.restore();
    }
    assert.strictEqual(
      stubs().log.errorMessages.length,
      1,
      'the expired resolve shows exactly one message',
    );
    const [message] = stubs().log.errorMessages;
    assert.ok(message !== undefined, 'the failure message must exist');
    assert.ok(
      message.startsWith(`SharpLsp could not apply "${item.title}": `),
      `the message must name the action and the reason: ${message}`,
    );
    assert.ok(
      message.endsWith('. The details are in Output › SharpLsp.'),
      `the message must point at the log: ${message}`,
    );
    assert.match(message, /the code action is no longer available/);
    assert.match(message, /invoke the quick fix again/);
    assert.deepStrictEqual(
      stubs().log.errorActions[0],
      ['Show Log'],
      'the message offers exactly one Show Log button',
    );
    assert.strictEqual(showLog.shown(), 1, 'clicking Show Log reveals the SharpLsp channel');

    // The middleware returns the unresolved item instead of throwing, so VS
    // Code does not ALSO surface its own error for the same failure.
    assert.strictEqual(expired, item, 'the failed resolve returns the unresolved item');
  });

  test('a cancelled resolve is not a failure: no message', async () => {
    const client = await activateRealSharpLsp();
    const resolve = client.middleware.resolveCodeAction;
    assert.ok(resolve, 'the client must carry the resolveCodeAction middleware');
    await replaceDocumentText(refactor.fixture.document, MISSING_USING);
    await waitForMatchingDiagnostics(
      refactor.fixture.uri,
      (diagnostics) => diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === 'CS0246'),
      LSP_RESPONSE_MS,
    );
    const { item } = await systemTextFix(refactor.fixture);

    const source = new vscode.CancellationTokenSource();
    source.cancel();
    const resolved = await resolve(
      item as unknown as vscode.CodeAction,
      source.token,
      resolveNext(client),
    );
    assert.strictEqual(
      stubs().log.errorMessages.length,
      0,
      'cancellation is not a failure and says nothing',
    );
    assert.strictEqual(resolved, item, 'a cancelled resolve returns the item untouched');
  });

  test('a resolve with no changes gets the no-changes message', async () => {
    const client = await activateRealSharpLsp();
    const resolve = client.middleware.resolveCodeAction;
    assert.ok(resolve, 'the client must carry the resolveCodeAction middleware');
    const item: WireCodeAction = {
      title: 'Change nothing',
      kind: 'quickfix',
      data: { id: 1, uri: refactor.fixture.uri.toString() },
    };
    // A server answer of the unresolved action back: no edit, no command.
    const resolved = await resolve(
      item as unknown as vscode.CodeAction,
      new vscode.CancellationTokenSource().token,
      async () => ({ title: item.title, kind: vscode.CodeActionKind.QuickFix }),
    );
    assert.strictEqual(stubs().log.errorMessages.length, 1, 'the empty resolve says so');
    assert.strictEqual(
      stubs().log.errorMessages[0],
      failureMessage(item.title, NO_CHANGES_REASON),
      'the exact no-changes message',
    );
    assert.strictEqual(resolved, item, 'the empty resolve returns the unresolved item');
  });

  test('a resolve the client gave up on reports that the server did not answer', async () => {
    const client = await activateRealSharpLsp();
    const resolve = client.middleware.resolveCodeAction;
    assert.ok(resolve, 'the client must carry the resolveCodeAction middleware');
    const item: WireCodeAction = {
      title: 'Import the namespace',
      kind: 'quickfix',
      data: { id: 2, uri: refactor.fixture.uri.toString() },
    };
    // vscode-languageclient answers the unresolved item itself, without a
    // cancellation, when the connection closed under the request.
    const unresolved = item as unknown as vscode.CodeAction;
    const resolved = await resolve(
      unresolved,
      new vscode.CancellationTokenSource().token,
      async () => unresolved,
    );
    assert.strictEqual(stubs().log.errorMessages.length, 1, 'the lost answer says so, once');
    assert.strictEqual(
      stubs().log.errorMessages[0],
      failureMessage(item.title, SERVER_GONE_REASON),
      'the exact no-answer message',
    );
    assert.deepStrictEqual(stubs().log.errorActions[0], ['Show Log'], 'with the way to the log');
    assert.strictEqual(resolved, unresolved, 'and the item comes back unresolved');
  });

  test('a healthy quick fix applies its edit and says nothing', async () => {
    const client = await activateRealSharpLsp();
    const resolve = client.middleware.resolveCodeAction;
    assert.ok(resolve, 'the client must carry the resolveCodeAction middleware');
    await replaceDocumentText(refactor.fixture.document, MISSING_USING);
    await waitForMatchingDiagnostics(
      refactor.fixture.uri,
      (diagnostics) => diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === 'CS0246'),
      LSP_RESPONSE_MS,
    );

    // Interaction 1 — resolve through the middleware: a real edit comes back.
    const { item } = await systemTextFix(refactor.fixture);
    const resolved = await resolve(
      item as unknown as vscode.CodeAction,
      new vscode.CancellationTokenSource().token,
      resolveNext(client),
    );
    const action = resolved!;
    assert.ok(action?.edit, 'the middleware must return the resolved edit');
    assert.strictEqual(stubs().log.errorMessages.length, 0, 'no failure, no message');

    // Interaction 2 — apply it for real and the CS0246 is gone.
    await applyWorkspaceEdit(action.edit);
    assert.match(refactor.fixture.document.getText(), /using System\.Text;/);
    await waitForMatchingDiagnostics(
      refactor.fixture.uri,
      (diagnostics) => !diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === 'CS0246'),
      LSP_RESPONSE_MS,
    );
    assert.strictEqual(
      stubs().log.errorMessages.length,
      0,
      'a clean apply never reports a failure',
    );
  });
});
