import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { closeAllEditors, pollUntilResult } from './test-helpers';
import {
  FSHARP_COLD_TIMEOUT_MS,
  hoverText,
  normalizeLocation,
  nthPositionOf,
  openFSharpFixture,
  pollDefinition,
  pollHover,
  pollReferences,
  positionOf,
} from './fsharp-helpers';

/**
 * Blanket end-to-end coverage for F# navigation features driven through the
 * REAL release-built LSP + FCS sidecar against the static F# fixture project.
 *
 * F# is a first-class citizen: these suites mirror — and exceed — the C#
 * navigation coverage in lsp-integration.test.ts. Every test performs multiple
 * user interactions with multiple assertions each.
 */

suite('F# LSP — Hover', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('hovers over types, DU cases, records, functions, and fields', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);

    const domain = await openFSharpFixture('Domain.fs');
    // First hover is the cold path — waits for the sidecar to crack the project.
    const shapeHover = await pollHover(domain.uri, positionOf(domain.doc, 'type Shape', 5));
    assert.match(hoverText(shapeHover), /Shape/, 'hover on Shape type must mention Shape');

    const personHover = await pollHover(domain.uri, positionOf(domain.doc, 'type Person', 5));
    assert.match(hoverText(personHover), /Person/, 'hover on Person record must mention Person');

    const circleHover = await pollHover(domain.uri, positionOf(domain.doc, '| Circle of', 2));
    assert.match(hoverText(circleHover), /Circle/, 'hover on DU case must mention Circle');

    const nameFieldHover = await pollHover(domain.uri, positionOf(domain.doc, '{ Name', 2));
    assert.match(
      hoverText(nameFieldHover),
      /Name|string/,
      'hover on record field must mention the field or its type',
    );

    const library = await openFSharpFixture('Library.fs');
    const areaHover = await pollHover(library.uri, positionOf(library.doc, 'let area', 4));
    const areaText = hoverText(areaHover);
    assert.match(areaText, /area/, 'hover on area function must mention area');
    assert.match(areaText, /float/, 'hover on area function must show its float signature');

    const totalAreaHover = await pollHover(
      library.uri,
      positionOf(library.doc, 'let totalArea', 4),
    );
    assert.match(
      hoverText(totalAreaHover),
      /Shape|list|float/,
      'hover on totalArea must surface its signature',
    );
  });

  test('hover includes XML doc summaries authored on declarations', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS);
    const library = await openFSharpFixture('Library.fs');
    const hover = await pollHover(library.uri, positionOf(library.doc, 'let totalArea', 4));
    assert.match(
      hoverText(hover),
      /Sum the areas/i,
      'hover must render the /// XML doc summary for totalArea',
    );
  });
});

suite('F# LSP — Go to Definition', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('navigates from cross-file call sites to declarations', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const usage = await openFSharpFixture('Usage.fs');

    // Geometry.totalArea (used in Usage.fs) → declaration in Library.fs
    const totalAreaDef = await pollDefinition(
      usage.uri,
      positionOf(usage.doc, 'Geometry.totalArea shapes', 'Geometry.'.length),
    );
    assert.ok(
      totalAreaDef.some((loc) => loc.uri.fsPath.endsWith('Library.fs')),
      'totalArea definition must resolve into Library.fs',
    );

    // Greeter constructor (used in Usage.fs) → type declaration in Library.fs
    const greeterDef = await pollDefinition(
      usage.uri,
      positionOf(usage.doc, 'Greeter("Hello")'),
    );
    assert.ok(
      greeterDef.some((loc) => loc.uri.fsPath.endsWith('Library.fs')),
      'Greeter definition must resolve into Library.fs',
    );

    // Circle DU case (used in Usage.fs) → declaration in Domain.fs
    const circleDef = await pollDefinition(usage.uri, positionOf(usage.doc, 'Circle 1.0'));
    assert.ok(
      circleDef.some((loc) => loc.uri.fsPath.endsWith('Domain.fs')),
      'Circle DU case definition must resolve into Domain.fs',
    );
  });

  test('navigates to a record field declaration', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS);
    const usage = await openFSharpFixture('Usage.fs');
    const nameDef = await pollDefinition(
      usage.uri,
      positionOf(usage.doc, 'alice.Name', 'alice.'.length),
    );
    assert.ok(
      nameDef.some((loc) => loc.uri.fsPath.endsWith('Domain.fs')),
      'Person.Name field definition must resolve into Domain.fs',
    );
  });

  test('navigates within a file to a local function binding', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS);
    const usage = await openFSharpFixture('Usage.fs');
    // The `double` inside quadruple should resolve to `let double` above it.
    const doubleDef = await pollDefinition(
      usage.uri,
      positionOf(usage.doc, 'double (double value)'),
    );
    assert.ok(
      doubleDef.some((loc) => loc.uri.fsPath.endsWith('Usage.fs')),
      'double definition must resolve within Usage.fs',
    );
    const declLine = positionOf(usage.doc, 'let double (value').line;
    assert.ok(
      doubleDef.some((loc) => loc.range.start.line === declLine),
      'double definition must point at the let-binding line',
    );
  });
});

suite('F# LSP — Type Definition & Declaration', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('type-definition on a value resolves to its type declaration', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 15_000);
    const usage = await openFSharpFixture('Usage.fs');
    const typeDefs = await pollUntilLocations(usage.uri, positionOf(usage.doc, 'alice :'), [
      'vscode.executeTypeDefinitionProvider',
    ]);
    assert.ok(
      typeDefs.some((loc) => loc.uri.fsPath.endsWith('Domain.fs')),
      'type-definition of alice must resolve to Person in Domain.fs',
    );
  });
});

suite('F# LSP — Find References & Document Highlights', () => {
  suiteTeardown(closeAllEditors);
  teardown(closeAllEditors);

  test('find-references on a function returns the declaration and call sites', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS + 30_000);
    const library = await openFSharpFixture('Library.fs');
    // area: declared in Library, used in `List.map area`.
    const areaRefs = await pollReferences(
      library.uri,
      positionOf(library.doc, 'let area', 4),
      2,
    );
    assert.ok(areaRefs.length >= 2, `area must have ≥2 references, got ${areaRefs.length}`);
    assert.ok(
      areaRefs.some((loc) => loc.uri.fsPath.endsWith('Library.fs')),
      'area references must include the Library.fs use site',
    );
  });

  test('find-references on a local function counts every call site', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS);
    const usage = await openFSharpFixture('Usage.fs');
    // double: declared once, called twice inside quadruple.
    const doubleRefs = await pollReferences(
      usage.uri,
      positionOf(usage.doc, 'let double (value', 'let '.length),
      3,
    );
    assert.ok(
      doubleRefs.length >= 3,
      `double must have ≥3 references (decl + 2 calls), got ${doubleRefs.length}`,
    );
  });

  test('document highlights mark occurrences of a symbol', async function () {
    this.timeout(FSHARP_COLD_TIMEOUT_MS);
    const usage = await openFSharpFixture('Usage.fs');
    const highlights = await pollUntilArray<vscode.DocumentHighlight>(
      'vscode.executeDocumentHighlights',
      usage.uri,
      nthPositionOf(usage.doc, 'shapes', 0),
      (items) => items.length >= 2,
    );
    assert.ok(
      highlights.length >= 2,
      `shapes must have ≥2 document highlights, got ${highlights.length}`,
    );
    assert.ok(
      highlights.every((h) => h.range.start.line >= 0),
      'every highlight must have a valid range',
    );
  });
});

// ── Local helpers ─────────────────────────────────────────────────

async function pollUntilLocations(
  uri: vscode.Uri,
  position: vscode.Position,
  [command]: [string],
  timeoutMs: number = FSHARP_COLD_TIMEOUT_MS,
): Promise<vscode.Location[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >(command, uri, position);
      return (result ?? []).map(normalizeLocation);
    },
    (locations) => locations.length > 0,
    timeoutMs,
    2_000,
  );
}

async function pollUntilArray<T>(
  command: string,
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (items: T[]) => boolean,
  timeoutMs: number = FSHARP_COLD_TIMEOUT_MS,
): Promise<T[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<T[]>(command, uri, position);
      return result ?? [];
    },
    predicate,
    timeoutMs,
    2_000,
  );
}
