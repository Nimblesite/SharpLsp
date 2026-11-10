// What the editor asks about a SYMBOL: the hover tooltip over one, and the
// workspace-wide search ("Go to Symbol in Workspace", Ctrl-T) for one.
//
// Spec: LSP 3.17 `textDocument/hover` and `workspace/symbol`;
// [HOVER-PROTOCOL-RESPONSE], [SHARPLSP-FEATURES-NAVIGATION].
//
// Both surfaces are symbol lookups the user reads rather than navigates with,
// so both are asserted on what the reply SAYS: a hover must be Markdown that
// names the thing under the caret, and a workspace-symbol hit must be the right
// kind, in the right file, with a container for a nested member.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { pollProvider, waitForHoverResult } from './test-helpers';
import { hoverText } from './fsharp-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

/** Poll the workspace-symbol provider for `query` until `predicate` holds over its reply. */
export async function pollWorkspaceSymbols(
  query: string,
  predicate: (symbols: vscode.SymbolInformation[]) => boolean,
  timeoutMs: number = LSP_RESPONSE_MS,
): Promise<vscode.SymbolInformation[]> {
  return pollProvider<vscode.SymbolInformation>(
    'vscode.executeWorkspaceSymbolProvider',
    [query],
    predicate,
    timeoutMs,
    2_000,
  );
}

/** The symbol called `name` in a workspace-symbol reply, if the reply holds one. */
export function namedSymbol(
  symbols: readonly vscode.SymbolInformation[],
  name: string,
): vscode.SymbolInformation | undefined {
  return symbols.find((symbol) => symbol.name === name);
}

/** What one workspace-symbol hit must be, each expectation carrying its own failure message. */
export interface WorkspaceSymbolHit {
  readonly query: string;
  readonly name: string;
  /** The fixture file the symbol must be declared in (matched as a path suffix). */
  readonly file: string;
  readonly missingWhy: string;
  readonly locatedWhy: string;
  readonly kind?: { readonly kind: vscode.SymbolKind; readonly why: string };
  /** When set, the hit must report a container name, failing with this message. */
  readonly containerWhy?: string;
}

/** Query for `query`, then assert the hit named `name` is the right kind in the right file. */
export async function assertWorkspaceSymbolHit(
  hit: WorkspaceSymbolHit,
): Promise<vscode.SymbolInformation> {
  const symbols = await pollWorkspaceSymbols(hit.query, (all) =>
    all.some((symbol) => symbol.name === hit.name),
  );
  const symbol = namedSymbol(symbols, hit.name);
  assert.ok(symbol, hit.missingWhy);
  assert.ok(symbol.location.uri.fsPath.endsWith(hit.file), hit.locatedWhy);
  if (hit.kind) assert.strictEqual(symbol.kind, hit.kind.kind, hit.kind.why);
  if (hit.containerWhy) {
    assert.ok((symbol.containerName ?? '').length > 0, hit.containerWhy);
  }
  return symbol;
}

/** Hover at `line:character` and assert a reply arrived (`why` says what the caret was on). */
export async function hoversAt(
  uri: vscode.Uri,
  line: number,
  character: number,
  why: string,
): Promise<vscode.Hover[]> {
  const hovers = await waitForHoverResult(uri, new vscode.Position(line, character));
  assert.ok(hovers.length > 0, why);
  return hovers;
}

/** The hover at `line:character`, as `[reply, its markdown text]`, the reply asserted real. */
export async function hoverReplyAt(
  uri: vscode.Uri,
  line: number,
  character: number,
  why: string,
): Promise<readonly [vscode.Hover[], string]> {
  const hovers = await hoversAt(uri, line, character, why);
  return [hovers, hoverText(hovers)];
}

/** Hover at `line:character`, assert every entry is Markdown, and return its markdown text. */
export async function markdownHoverAt(
  uri: vscode.Uri,
  line: number,
  character: number,
  where: string,
): Promise<string> {
  const hovers = await hoversAt(uri, line, character, where);
  assertMarkdownContents(hovers, where);
  return hoverText(hovers);
}

/** The hover text at `line:character`, asserted to exist (`why` says what the caret was on). */
export async function hoverTextAt(
  uri: vscode.Uri,
  line: number,
  character: number,
  why: string,
): Promise<string> {
  return hoverText(await hoversAt(uri, line, character, why));
}

/**
 * [HOVER-PROTOCOL-RESPONSE]: every content entry MUST be Markdown.
 *
 * "Plain-text fallback is not supported — all LSP 3.17 clients support
 * Markdown." A hover that arrives as a bare string renders its backticks and
 * its fenced code block as literal characters, which is the difference between
 * a signature and a line of punctuation.
 */
export function assertMarkdownContents(hovers: readonly vscode.Hover[], where: string): void {
  assert.ok(hovers.length > 0, `${where}: a hover must have been returned`);
  for (const hover of hovers) {
    assert.ok(hover.contents.length > 0, `${where}: a hover must carry content entries`);
    for (const entry of hover.contents) {
      assert.ok(
        entry instanceof vscode.MarkdownString,
        `${where}: every content entry must be Markdown, got ${typeof entry}`,
      );
      assert.ok(entry.value.trim().length > 0, `${where}: no content entry may be blank`);
    }
  }
}

/** Assert `text` mentions at least one of `alternatives`, ignoring case when `fold` is set. */
export function assertMentionsAny(
  text: string,
  alternatives: readonly string[],
  why: string,
  fold = false,
): void {
  const haystack = fold ? text.toLowerCase() : text;
  assert.ok(
    alternatives.some((alternative) => haystack.includes(alternative)),
    `${why}: ${text}`,
  );
}

/** Assert `text` mentions every one of `needles`, ignoring case when `fold` is set. */
export function assertMentionsAll(
  text: string,
  needles: readonly string[],
  why: string,
  fold = false,
): void {
  const haystack = fold ? text.toLowerCase() : text;
  for (const needle of needles) assert.ok(haystack.includes(needle), `${why}: ${text}`);
}
