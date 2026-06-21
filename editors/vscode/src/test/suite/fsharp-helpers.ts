import * as path from 'node:path';
import * as vscode from 'vscode';
import { pollUntilResult } from './test-helpers';

/**
 * Shared helpers for the F# LSP end-to-end suites.
 *
 * Every F# semantic feature requires the file to be part of a project the F#
 * sidecar (FSharp.Compiler.Service) has cracked. These helpers target the
 * static fixture project under `test-fixtures/workspace/fsharp/` — see
 * `FSharpFixtures.fsproj`. Cursor positions are derived from document text via
 * `positionAt(indexOf(...))` so they survive edits to the fixture source.
 */

/** The F# fixture project directory inside the opened test workspace. */
export function fsharpFixtureDir(): string {
  return path.resolve(__dirname, '../../../test-fixtures/workspace/fsharp');
}

/** Absolute path to an F# fixture file. */
export function fsharpFixturePath(filename: string): string {
  return path.join(fsharpFixtureDir(), filename);
}

/** Open an F# fixture file and return its document + uri. */
export async function openFSharpFixture(
  filename: string,
): Promise<{ doc: vscode.TextDocument; uri: vscode.Uri }> {
  const uri = vscode.Uri.file(fsharpFixturePath(filename));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  return { doc, uri };
}

/**
 * Resolve a cursor position at the first occurrence of `needle`, optionally
 * offset by `column` characters into the match (e.g. to land on a member after
 * a `.`). Throws if the needle is absent so a malformed fixture fails loudly.
 */
export function positionOf(
  doc: vscode.TextDocument,
  needle: string,
  offsetIntoMatch = 0,
): vscode.Position {
  const index = doc.getText().indexOf(needle);
  if (index < 0) {
    throw new Error(`Fixture ${doc.uri.fsPath} does not contain "${needle}"`);
  }
  return doc.positionAt(index + offsetIntoMatch);
}

/**
 * Resolve a cursor position at the Nth occurrence (0-based) of `needle`.
 * Used when the same identifier appears multiple times (call sites, etc.).
 */
export function nthPositionOf(
  doc: vscode.TextDocument,
  needle: string,
  occurrence: number,
  offsetIntoMatch = 0,
): vscode.Position {
  const text = doc.getText();
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) {
      throw new Error(
        `Fixture ${doc.uri.fsPath} has fewer than ${occurrence + 1} "${needle}" occurrences`,
      );
    }
  }
  return doc.positionAt(index + offsetIntoMatch);
}

/** Long timeout for the first semantic call while the F# sidecar cracks the project. */
export const FSHARP_COLD_TIMEOUT_MS = 75_000;

/**
 * Short timeout for features that respond (or fail) immediately and need no
 * project crack: tree-sitter syntax features (Rust host, <5ms) and capabilities
 * not advertised at all. Keeps the suite fast when these are still unimplemented.
 */
export const FSHARP_SYNTAX_TIMEOUT_MS = 15_000;

/** Poll a hover provider at a position until it returns content. */
export async function pollHover(
  uri: vscode.Uri,
  position: vscode.Position,
  timeoutMs: number = FSHARP_COLD_TIMEOUT_MS,
): Promise<vscode.Hover[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        position,
      );
      return result ?? [];
    },
    (hovers) => hovers.length > 0 && hoverText(hovers).trim().length > 0,
    timeoutMs,
    2_000,
  );
}

/** Poll a definition provider at a position until it returns at least one location. */
export async function pollDefinition(
  uri: vscode.Uri,
  position: vscode.Position,
  timeoutMs: number = FSHARP_COLD_TIMEOUT_MS,
): Promise<vscode.Location[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider',
        uri,
        position,
      );
      return (result ?? []).map(normalizeLocation);
    },
    (locations) => locations.length > 0,
    timeoutMs,
    2_000,
  );
}

/** Poll a references provider at a position until it returns at least `min` locations. */
export async function pollReferences(
  uri: vscode.Uri,
  position: vscode.Position,
  min: number,
  timeoutMs: number = FSHARP_COLD_TIMEOUT_MS,
): Promise<vscode.Location[]> {
  return pollUntilResult(
    async () => {
      const result = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        position,
      );
      return result ?? [];
    },
    (locations) => locations.length >= min,
    timeoutMs,
    2_000,
  );
}

/** Flatten a Hover[] into a single searchable string. */
export function hoverText(hovers: vscode.Hover[]): string {
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) =>
      typeof content === 'string' ? content : (content as vscode.MarkdownString).value,
    )
    .join('\n');
}

/** Normalize a Location | LocationLink into a Location. */
export function normalizeLocation(loc: vscode.Location | vscode.LocationLink): vscode.Location {
  if ('targetUri' in loc) {
    return new vscode.Location(loc.targetUri, loc.targetRange);
  }
  return loc;
}
