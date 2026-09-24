import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

// The `CompletionShot.cs` fixture's member-access site, shared by every suite
// that completes there. [SHARPLSP-FEATURES-INTELLIGENCE]

/** The caret inside `CompletionShot.cs` that sits after a member-access dot. */
export const MEMBER_CARET = new vscode.Position(11, 24);

/**
 * The member-access list offers the fixture's instance members, each with the
 * KIND its completion icon is drawn from, and hands back the items by label.
 */
export function assertShotMembers(list: vscode.CompletionList): Map<string, vscode.CompletionItem> {
  const items = new Map(list.items.map((item) => [item.label.toString(), item]));
  assert.strictEqual(items.get('Name')?.kind, vscode.CompletionItemKind.Property);
  assert.strictEqual(items.get('Add')?.kind, vscode.CompletionItemKind.Method);
  assert.strictEqual(items.get('_count')?.kind, vscode.CompletionItemKind.Field);
  return items;
}
