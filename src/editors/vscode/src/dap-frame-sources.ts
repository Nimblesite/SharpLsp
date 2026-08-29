// Editor-backed source knowledge for the DAP proxy: which paths are the
// user's own code, and where a method lives.
//
// Implements the sidecar half of [DEBUG-FEATURES-STACK-ASYNC] step 3 ("resolve
// the type with Roslyn") for Phase Four: the reconstructed awaiting frames
// carry only a method name, and the language server — Roslyn and FCS behind
// the LSP — is what turns that name into a navigable source location. The
// lookup goes through the editor's symbol providers so the same code path
// serves C# and F#, per [DEBUG-MISSION].
//
import * as vscode from 'vscode';

/** A resolved method declaration site, in DAP's one-based lines. */
export interface MethodSource {
  readonly path: string;
  readonly line: number;
}

/** Flatten a `DocumentSymbol` tree, depth first. */
function flatten(symbols: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  return symbols.flatMap((symbol) => [symbol, ...flatten(symbol.children)]);
}

/** True when a symbol's rendered name stands for `method`. */
function names(symbol: vscode.DocumentSymbol, method: string): boolean {
  return (
    symbol.name === method ||
    symbol.name.startsWith(`${method}(`) ||
    symbol.name.startsWith(`${method} `)
  );
}

/** Search one file's symbol tree for the method, via the LSP providers. */
async function findInFile(path: string, method: string): Promise<MethodSource | undefined> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
    'vscode.executeDocumentSymbolProvider',
    document.uri,
  );
  const match = flatten(symbols ?? []).find((symbol) => names(symbol, method));
  if (match === undefined) return undefined;
  return { path, line: match.selectionRange.start.line + 1 };
}

/** Search the whole workspace index for the method, as a fallback. */
async function findInWorkspace(method: string): Promise<MethodSource | undefined> {
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
    'vscode.executeWorkspaceSymbolProvider',
    method,
  );
  const match = (symbols ?? []).find(
    (symbol) => symbol.name === method || symbol.name.startsWith(`${method}(`),
  );
  if (match?.location.uri.scheme !== 'file') return undefined;
  return { path: match.location.uri.fsPath, line: match.location.range.start.line + 1 };
}

/**
 * Where `method` is declared, looked up through the language server.
 *
 * `candidateFiles` are the source files already on the stack — the overwhelming
 * home of an awaiting frame — tried first so the common case never touches the
 * workspace index. Fail-open: an unresolvable method yields undefined and the
 * frame is injected without navigation, which the spec prefers to dropping it.
 */
export async function resolveMethodSource(
  method: string,
  candidateFiles: readonly string[],
): Promise<MethodSource | undefined> {
  for (const path of [...new Set(candidateFiles)].slice(0, 4)) {
    try {
      const found = await findInFile(path, method);
      if (found !== undefined) return found;
    } catch {
      // An unreadable candidate must not abort the lookup.
    }
  }
  try {
    return await findInWorkspace(method);
  } catch {
    return undefined;
  }
}
