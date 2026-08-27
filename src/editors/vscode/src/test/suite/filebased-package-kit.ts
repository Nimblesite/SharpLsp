import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LSP_RESPONSE_TIMEOUT_MS, pollUntilResult } from './test-helpers';
import { loadSolutionInServer } from './real-repo-helpers';

export const PACKAGE = '#:package Newtonsoft.Json@13.0.3';
export const RESTORE_TIMEOUT_MS = 120_000;

export function positionAfter(text: string, marker: string): vscode.Position {
  const offset = text.indexOf(marker);
  assert.notStrictEqual(offset, -1, `fixture must contain ${JSON.stringify(marker)}`);
  const prefix = text.slice(0, offset + marker.length);
  const lines = prefix.split('\n');
  return new vscode.Position(lines.length - 1, lines.at(-1)?.length ?? 0);
}

export function positionInside(text: string, marker: string): vscode.Position {
  const after = positionAfter(text, marker);
  assert.ok(after.character > 0, `fixture token ${JSON.stringify(marker)} must be non-empty`);
  return after.translate(0, -1);
}

export function diagnosticCode(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  if (code === undefined) return '';
  if (typeof code === 'object') return String(code.value);
  return String(code);
}

export function errorsFor(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
}

export async function openFileBasedApp(
  tmpDir: string,
  filename: string,
  content: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
  const uri = vscode.Uri.file(path.join(tmpDir, filename));
  fs.writeFileSync(uri.fsPath, content, 'utf8');
  await loadSolutionInServer(uri.fsPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  return { doc, uri };
}

export async function waitForErrorCode(
  uri: vscode.Uri,
  code: string,
): Promise<vscode.Diagnostic[]> {
  const diagnostics = await pollUntilResult(
    async () => errorsFor(uri),
    (items) => items.some((diagnostic) => diagnosticCode(diagnostic) === code),
    LSP_RESPONSE_TIMEOUT_MS * 4,
  );
  assert.ok(
    diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === code),
    `expected ${code}; got ${diagnostics.map(diagnosticCode).join(', ') || 'no diagnostics'}`,
  );
  return diagnostics;
}

export async function completionList(
  uri: vscode.Uri,
  position: vscode.Position,
  requiredLabel: string,
  resolveCount = 0,
): Promise<vscode.CompletionList> {
  return pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        position,
        undefined,
        resolveCount,
      )) ?? new vscode.CompletionList(),
    (list) => list.items.some((item) => item.label.toString() === requiredLabel),
    RESTORE_TIMEOUT_MS,
    1_000,
  );
}

export function itemNamed(list: vscode.CompletionList, label: string): vscode.CompletionItem {
  const item = list.items.find((candidate) => candidate.label.toString() === label);
  assert.ok(item, `completion list must contain ${label}`);
  return item;
}

export function hoverText(hovers: readonly vscode.Hover[]): string {
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => {
      if (typeof content === 'string') return content;
      if (content instanceof vscode.MarkdownString) return content.value;
      return JSON.stringify(content);
    })
    .join('\n');
}

export function assertNoPackageBindingErrors(uri: vscode.Uri): void {
  const errors = errorsFor(uri);
  const codes = errors.map(diagnosticCode);
  assert.ok(!codes.includes('CS0234'), `package namespace must bind; errors: ${codes.join(', ')}`);
  assert.ok(!codes.includes('CS0246'), `package types must bind; errors: ${codes.join(', ')}`);
  assert.ok(!codes.includes('CS0103'), `package values must bind; errors: ${codes.join(', ')}`);
  assert.deepStrictEqual(errors, [], 'a restored package-backed file-based app has zero errors');
}
