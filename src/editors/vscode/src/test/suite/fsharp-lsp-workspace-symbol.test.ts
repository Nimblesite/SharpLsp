import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { closeAllEditors, pollUntilResult, waitForDocumentSymbols } from './test-helpers';
import { FSHARP_COLD_TIMEOUT_MS, openFSharpFixture } from './fsharp-helpers';

/**
 * End-to-end coverage for F# `workspace/symbol` (the editor's "Go to Symbol in
 * Workspace" / Ctrl-T) against the REAL release LSP + FCS sidecar.
 *
 * The host has no F# tree-sitter grammar, so F# symbols are sourced from the FCS
 * sidecar's document symbols and merged into the standard workspace-symbol
 * response. The search covers OPEN documents, so each test opens the relevant F#
 * fixtures first, then drives several `executeWorkspaceSymbolProvider` queries with
 * many assertions per query. [FS-WORKSPACE-SYMBOL]
 */

// VS Code numeric SymbolKind values (LSP enum).
const MODULE = vscode.SymbolKind.Module;
const ENUM = vscode.SymbolKind.Enum;

async function pollWorkspaceSymbols(
  query: string,
  predicate: (symbols: vscode.SymbolInformation[]) => boolean,
  timeoutMs: number = FSHARP_COLD_TIMEOUT_MS,
): Promise<vscode.SymbolInformation[]> {
  return pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query,
      )) ?? [],
    predicate,
    timeoutMs,
    2_000,
  );
}

function named(
  symbols: vscode.SymbolInformation[],
  name: string,
): vscode.SymbolInformation | undefined {
  return symbols.find((s) => s.name === name);
}

suite('F# LSP — Workspace Symbol (Ctrl-T)', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('finds module + member symbols from an open F# file', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);

    // Interaction 1 — open Library.fs and warm the FCS project crack.
    const library = await openFSharpFixture('Library.fs');
    await waitForDocumentSymbols(library.uri, FSHARP_COLD_TIMEOUT_MS);

    // Interaction 2 — query for the `Geometry` module.
    const geometry = await pollWorkspaceSymbols('Geometry', (syms) =>
      syms.some((s) => s.name === 'Geometry'),
    );
    const moduleSym = named(geometry, 'Geometry');
    assert.ok(moduleSym, 'workspace symbol search must find the Geometry module');
    assert.strictEqual(moduleSym?.kind, MODULE, 'Geometry must be reported as a Module');
    assert.ok(
      moduleSym?.location.uri.fsPath.endsWith('Library.fs'),
      'the Geometry module must be located in Library.fs',
    );

    // Interaction 3 — query for the `area` member (nested inside the module).
    const area = await pollWorkspaceSymbols('area', (syms) => syms.some((s) => s.name === 'area'));
    const areaSym = named(area, 'area');
    assert.ok(areaSym, 'workspace symbol search must find the nested `area` function');
    assert.ok(
      areaSym?.location.uri.fsPath.endsWith('Library.fs'),
      '`area` must be located in Library.fs',
    );
    // Nested members carry their container name.
    assert.ok(
      (areaSym?.containerName ?? '').length > 0,
      'a nested member must report a container name',
    );
  });

  test('finds type symbols across multiple open F# files with correct kinds', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 60_000);

    // Interaction 1 — open both the domain types and the logic file.
    const domain = await openFSharpFixture('Domain.fs');
    const library = await openFSharpFixture('Library.fs');
    await waitForDocumentSymbols(domain.uri, FSHARP_COLD_TIMEOUT_MS);
    await waitForDocumentSymbols(library.uri, FSHARP_COLD_TIMEOUT_MS);

    // Interaction 2 — the `Shape` discriminated union (Enum-kind) from Domain.fs.
    const shape = await pollWorkspaceSymbols('Shape', (syms) =>
      syms.some((s) => s.name === 'Shape'),
    );
    const shapeSym = named(shape, 'Shape');
    assert.ok(shapeSym, 'workspace symbol search must find the Shape type');
    assert.strictEqual(
      shapeSym?.kind,
      ENUM,
      'a discriminated union must report as an Enum-kind symbol',
    );
    assert.ok(
      shapeSym?.location.uri.fsPath.endsWith('Domain.fs'),
      'Shape must be located in Domain.fs',
    );

    // Interaction 3 — the `IAnimal` type also surfaces from Domain.fs. (FCS's exact
    // SymbolKind for an F# interface declaration is an implementation detail; for
    // workspace search, presence + correct file location are what matter.)
    const animal = await pollWorkspaceSymbols('IAnimal', (syms) =>
      syms.some((s) => s.name === 'IAnimal'),
    );
    const animalSym = named(animal, 'IAnimal');
    assert.ok(animalSym, 'workspace symbol search must find the IAnimal type');
    assert.ok(
      animalSym?.location.uri.fsPath.endsWith('Domain.fs'),
      'IAnimal must be located in Domain.fs',
    );

    // Interaction 4 — the `Greeter` class lives in Library.fs (different file).
    const greeter = await pollWorkspaceSymbols('Greeter', (syms) =>
      syms.some((s) => s.name === 'Greeter'),
    );
    const greeterSym = named(greeter, 'Greeter');
    assert.ok(greeterSym, 'workspace symbol search must find the Greeter class');
    assert.ok(
      greeterSym?.location.uri.fsPath.endsWith('Library.fs'),
      'Greeter must be located in Library.fs, proving multi-file coverage',
    );
  });

  test('matches fuzzily and returns nothing for a non-matching query', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 45_000);

    const library = await openFSharpFixture('Library.fs');
    await waitForDocumentSymbols(library.uri, FSHARP_COLD_TIMEOUT_MS);

    // Interaction 1 — fuzzy subsequence: `geom` must match `Geometry`.
    const fuzzy = await pollWorkspaceSymbols('geom', (syms) =>
      syms.some((s) => s.name === 'Geometry'),
    );
    assert.ok(
      fuzzy.some((s) => s.name === 'Geometry'),
      'fuzzy subsequence query `geom` must match the Geometry module',
    );

    // Interaction 2 — a query that matches no symbol returns no F# symbols.
    const none = await pollWorkspaceSymbols('zzqqxxnotreal', () => true, 20_000);
    assert.ok(
      !none.some((s) => s.location.uri.fsPath.endsWith('.fs')),
      'a non-matching query must surface no F# symbols',
    );
  });
});
