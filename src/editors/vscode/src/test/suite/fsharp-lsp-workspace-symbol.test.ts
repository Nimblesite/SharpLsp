import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { closeAllEditors, waitForDocumentSymbols } from './test-helpers';
import { openFSharpFixture } from './fsharp-helpers';
import { assertWorkspaceSymbolHit, namedSymbol, pollWorkspaceSymbols } from './lsp-symbol-kit';
import { LSP_RESPONSE_MS } from './test-timeouts';

/**
 * End-to-end coverage for F# `workspace/symbol` (the editor's "Go to Symbol in
 * Workspace" / Ctrl-T) against the REAL release LSP + FCS sidecar.
 *
 * The host has no F# tree-sitter grammar, so F# symbols are sourced from the FCS
 * sidecar's document symbols and merged into the standard workspace-symbol
 * response. The search covers OPEN documents, so each test opens the relevant F#
 * fixtures first, then drives several `executeWorkspaceSymbolProvider` queries with
 * many assertions per query. [SHARPLSP-FEATURES-NAVIGATION]
 */

// VS Code numeric SymbolKind values (LSP enum).
const MODULE = vscode.SymbolKind.Module;
const ENUM = vscode.SymbolKind.Enum;

suite('F# LSP — Workspace Symbol (Ctrl-T)', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('finds module + member symbols from an open F# file', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    // Interaction 1 — open Library.fs and warm the FCS project crack.
    const library = await openFSharpFixture('Library.fs');
    await waitForDocumentSymbols(library.uri, LSP_RESPONSE_MS);

    // Interaction 2 — query for the `Geometry` module.
    await assertWorkspaceSymbolHit({
      query: 'Geometry',
      name: 'Geometry',
      file: 'Library.fs',
      missingWhy: 'workspace symbol search must find the Geometry module',
      locatedWhy: 'the Geometry module must be located in Library.fs',
      kind: { kind: MODULE, why: 'Geometry must be reported as a Module' },
    });

    // Interaction 3 — query for the `area` member (nested inside the module).
    // Nested members carry their container name.
    await assertWorkspaceSymbolHit({
      query: 'area',
      name: 'area',
      file: 'Library.fs',
      missingWhy: 'workspace symbol search must find the nested `area` function',
      locatedWhy: '`area` must be located in Library.fs',
      containerWhy: 'a nested member must report a container name',
    });
  });

  test('finds type symbols across multiple open F# files with correct kinds', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    // Interaction 1 — open both the domain types and the logic file.
    const domain = await openFSharpFixture('Domain.fs');
    const library = await openFSharpFixture('Library.fs');
    await waitForDocumentSymbols(domain.uri, LSP_RESPONSE_MS);
    await waitForDocumentSymbols(library.uri, LSP_RESPONSE_MS);

    // Interaction 2 — the `Shape` discriminated union (Enum-kind) from Domain.fs.
    await assertWorkspaceSymbolHit({
      query: 'Shape',
      name: 'Shape',
      file: 'Domain.fs',
      missingWhy: 'workspace symbol search must find the Shape type',
      locatedWhy: 'Shape must be located in Domain.fs',
      kind: {
        kind: ENUM,
        why: 'a discriminated union must report as an Enum-kind symbol',
      },
    });

    // Interaction 3 — the `IAnimal` type also surfaces from Domain.fs. (FCS's exact
    // SymbolKind for an F# interface declaration is an implementation detail; for
    // workspace search, presence + correct file location are what matter.)
    await assertWorkspaceSymbolHit({
      query: 'IAnimal',
      name: 'IAnimal',
      file: 'Domain.fs',
      missingWhy: 'workspace symbol search must find the IAnimal type',
      locatedWhy: 'IAnimal must be located in Domain.fs',
    });

    // Interaction 4 — the `Greeter` class lives in Library.fs (different file).
    await assertWorkspaceSymbolHit({
      query: 'Greeter',
      name: 'Greeter',
      file: 'Library.fs',
      missingWhy: 'workspace symbol search must find the Greeter class',
      locatedWhy: 'Greeter must be located in Library.fs, proving multi-file coverage',
    });
  });

  test('matches fuzzily and returns nothing for a non-matching query', async function () {
    this.timeout(LSP_RESPONSE_MS + 5_000);

    const library = await openFSharpFixture('Library.fs');
    await waitForDocumentSymbols(library.uri, LSP_RESPONSE_MS);

    // Interaction 1 — fuzzy subsequence: `geom` must match `Geometry`.
    const fuzzy = await pollWorkspaceSymbols('geom', (syms) =>
      syms.some((s) => s.name === 'Geometry'),
    );
    assert.ok(
      namedSymbol(fuzzy, 'Geometry'),
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
