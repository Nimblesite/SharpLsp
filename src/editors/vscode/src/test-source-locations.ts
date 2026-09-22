/**
 * Where each discovered test is declared, read from the target's syntax tree.
 *
 * VSTest reports no source location, and neither does MTP's NUnit, so those
 * tests carried the project folder: "Go to Test" was offered and opened
 * nothing. The host's workspace symbols are parsed from the source itself —
 * tree-sitter for C#, FCS for F# — so a test's declaration is found by its
 * qualified name and lands on the declared name, never on its attributes.
 *
 * Implements [TEST-GOTO-SOURCE].
 */

import { State } from 'vscode-languageclient/node';
import { info } from './log.js';
import { listTests } from './test-discovery.js';
import * as state from './state.js';
import type { LspPosition, SymbolNode, WorkspaceSymbolsResponse } from './state.js';
import type { TestListing, TestLocation } from './test-listing-model.js';
import { getErrorMessage } from './utils.js';

/**
 * Kinds the runtime names as types, so what nests inside joins with `+`
 * (`Outer+Inner`). An F# module compiles to a static class, so it is one.
 */
const TYPE_KINDS = new Set(['Class', 'Struct', 'Interface', 'Record', 'Enum', 'Module']);

/** One enclosing declaration on the way down the symbol tree. */
interface Scope {
  readonly name: string;
  readonly isType: boolean;
}

/**
 * Call `rediscover` whenever what discovery reads changes: the loaded solution,
 * or the server whose symbols locate the tests coming (back) up. Returns the
 * unsubscribe.
 */
export function onDiscoveryInputs(rediscover: () => void): () => void {
  const stops = [
    state.solutionPath.subscribe(rediscover),
    state.serverRunning.subscribe((running) => {
      if (running) rediscover();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

/** Enumerate `target`, locating every test it declares. */
export async function listLocatedTests(target: string): Promise<TestListing> {
  return await withSourceLocations(target, await listTests(target));
}

/**
 * `listing`, with a declaration for every test its runner did not locate. A
 * runner-reported location always wins. The target is a solution, a project or
 * a folder, which the host resolves the same way discovery does.
 */
export async function withSourceLocations(
  target: string,
  listing: TestListing,
): Promise<TestListing> {
  if (listing.names.length === 0) return listing;
  const declared = await declarations(target);
  const locations = new Map(listing.locations);
  for (const name of listing.names) {
    const found = declared.get(name) ?? declared.get(withoutArguments(name));
    if (found !== undefined && !locations.has(name)) locations.set(name, found);
  }
  return { ...listing, locations };
}

/** Every declaration in `response`, by each qualified name it can be reported as. */
export function indexDeclarations(
  response: WorkspaceSymbolsResponse,
): ReadonlyMap<string, TestLocation> {
  const index = new Map<string, TestLocation>();
  for (const project of response.projects) {
    for (const file of project.symbols) indexFile(file.symbols, file.file, index);
  }
  return index;
}

/** The target's declarations, or none while the language server is unavailable. */
async function declarations(target: string): Promise<ReadonlyMap<string, TestLocation>> {
  const lsp = state.client.value;
  if (lsp?.state !== State.Running) return new Map();
  try {
    const response = await lsp.sendRequest<WorkspaceSymbolsResponse>('sharplsp/workspaceSymbols', {
      solution: target,
    });
    return indexDeclarations(response);
  } catch (error: unknown) {
    info(`Test discovery: no source locations for ${target}: ${getErrorMessage(error)}`);
    return new Map();
  }
}

/**
 * Index one file. F# lists every module and type flat, each named relative to
 * the file's root namespace or module (`Inner.Deeper`), so a declaration a root
 * encloses is re-rooted under it. C#'s tree already nests.
 */
function indexFile(
  symbols: readonly SymbolNode[],
  file: string,
  index: Map<string, TestLocation>,
): void {
  const roots = symbols.filter((symbol) => !symbols.some((other) => encloses(other, symbol)));
  for (const symbol of symbols) {
    const root = roots.find((candidate) => encloses(candidate, symbol));
    if (root === undefined) {
      indexSymbols([symbol], file, [], index);
      continue;
    }
    const segments = symbol.name.split('.');
    const within = segments.slice(0, -1).map((name) => ({ name, isType: true }));
    const leaf = { ...symbol, name: segments.at(-1) ?? symbol.name };
    indexSymbols([leaf], file, [scopeOf(root), ...within], index);
  }
}

function indexSymbols(
  symbols: readonly SymbolNode[],
  file: string,
  scopes: readonly Scope[],
  index: Map<string, TestLocation>,
): void {
  for (const symbol of symbols) {
    const here = [...scopes, scopeOf(symbol)];
    const location = { file, line: symbol.selectionRange.start.line + 1 };
    for (const name of qualifiedNames(here)) {
      if (!index.has(name)) index.set(name, location);
    }
    indexSymbols(symbol.children, file, here, index);
  }
}

/** `Ns.Outer.Inner.M`, and the runtime's `Ns.Outer+Inner.M` when types nest. */
function qualifiedNames(scopes: readonly Scope[]): string[] {
  const dotted = scopes.map((scope) => scope.name).join('.');
  const nested = scopes
    .map(
      (scope, i) =>
        (i > 0 && scope.isType && scopes[i - 1]?.isType === true ? '+' : '.') + scope.name,
    )
    .join('')
    .slice(1);
  return dotted === nested ? [dotted] : [dotted, nested];
}

function scopeOf(symbol: SymbolNode): Scope {
  return { name: symbol.name, isType: TYPE_KINDS.has(symbol.kind) };
}

/** Whether `outer`'s range contains `inner`'s, and they are different symbols. */
function encloses(outer: SymbolNode, inner: SymbolNode): boolean {
  return (
    outer !== inner &&
    before(outer.range.start, inner.range.start) &&
    before(inner.range.end, outer.range.end)
  );
}

/** `a` is at or before `b`. */
function before(a: LspPosition, b: LspPosition): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

/** A data-row id's method: `M(a: 1)` is declared as `M`. */
function withoutArguments(name: string): string {
  const open = name.indexOf('(');
  return open < 0 ? name : name.slice(0, open);
}
