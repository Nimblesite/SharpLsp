// The shared preamble of the F# LSP end-to-end suites (navigation,
// intelligence, hierarchy): set the LSP budget, open the fixture, aim the
// caret, poll the provider, assert. Every F# semantic feature needs the file
// to be part of a project the FCS sidecar has cracked, so these suites repeat
// the same open-and-aim dance before every provider round trip; it lives here.
//
// Spec: [SHARPLSP-FEATURES-NAVIGATION], [SHARPLSP-FEATURES-INTELLIGENCE],
// [SHARPLSP-FEATURES-CODE-LENS], [SHARPLSP-FEATURES-FSHARP].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { assertContainsAll, pollProvider, pollUntilResult } from './test-helpers';
import {
  hoverText,
  normalizeLocation,
  openFSharpFixture,
  pollDefinition,
  pollHover,
  pollReferences,
  positionOf,
} from './fsharp-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

/** An F# fixture opened under the LSP budget, with the caret aimed at a token. */
export interface FSharpAt {
  readonly doc: vscode.TextDocument;
  readonly uri: vscode.Uri;
  readonly position: vscode.Position;
}

/** Set the LSP timeout on `ctx`, open `fixture`, and aim the caret `offset` characters into `needle`. */
export async function openFSharpAt(
  ctx: Mocha.Context,
  fixture: string,
  needle: string,
  offset = 0,
): Promise<FSharpAt> {
  ctx.timeout(LSP_RESPONSE_MS + 5_000);
  const opened = await openFSharpFixture(fixture);
  return { ...opened, position: positionOf(opened.doc, needle, offset) };
}

/** Hover `needle` in `fixture` and assert the tooltip matches `pattern`; returns the hover text. */
export async function assertFixtureHover(
  ctx: Mocha.Context,
  fixture: string,
  needle: string,
  offset: number,
  pattern: RegExp,
  why: string,
): Promise<string> {
  const at = await openFSharpAt(ctx, fixture, needle, offset);
  const text = hoverText(await pollHover(at.uri, at.position));
  assert.match(text, pattern, why);
  return text;
}

/** Poll the definition provider at `position` and assert the answer lands in `file`. */
export async function assertDefinitionLandsIn(
  uri: vscode.Uri,
  position: vscode.Position,
  file: string,
  why: string,
): Promise<vscode.Location[]> {
  const locations = await pollDefinition(uri, position);
  assert.ok(
    locations.some((location) => location.uri.fsPath.endsWith(file)),
    why,
  );
  return locations;
}

/** Poll references at `at.position` until `min` exist, then assert the count; `label` heads it. */
export async function assertReferences(
  at: FSharpAt,
  min: number,
  label: string,
): Promise<vscode.Location[]> {
  const locations = await pollReferences(at.uri, at.position, min);
  assert.ok(locations.length >= min, `${label}, got ${locations.length}`);
  return locations;
}

/** Poll the type-definition provider at `position` until it answers, as plain locations. */
export async function pollTypeDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.Location[]> {
  const found = await pollProvider<vscode.Location | vscode.LocationLink>(
    'vscode.executeTypeDefinitionProvider',
    [uri, position],
    (locations) => locations.length > 0,
    LSP_RESPONSE_MS,
    2_000,
  );
  return found.map(normalizeLocation);
}

/** Poll document highlights at `position` until at least `min` occurrences are marked. */
export async function pollHighlights(
  uri: vscode.Uri,
  position: vscode.Position,
  min: number,
): Promise<vscode.DocumentHighlight[]> {
  return pollProvider<vscode.DocumentHighlight>(
    'vscode.executeDocumentHighlights',
    [uri, position],
    (items) => items.length >= min,
    LSP_RESPONSE_MS,
    2_000,
  );
}

/** Run the completion provider at `uri:position` until `predicate` holds. */
export async function pollCompletion(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (list: vscode.CompletionList) => boolean,
  timeoutMs: number = LSP_RESPONSE_MS,
): Promise<vscode.CompletionList> {
  return pollUntilResult(
    async () =>
      (await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        position,
        '.',
      )) ?? new vscode.CompletionList(),
    predicate,
    timeoutMs,
    2_000,
  );
}

/** Poll completion until every name in `required` is offered; returns the label set. */
export async function pollCompletionLabels(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (labels: Set<string>) => boolean,
  timeoutMs: number = LSP_RESPONSE_MS,
): Promise<Set<string>> {
  const list = await pollCompletion(
    uri,
    position,
    (l) => predicate(new Set(l.items.map((i) => i.label.toString()))),
    timeoutMs,
  );
  return new Set(list.items.map((i) => i.label.toString()));
}

/** Complete after `needle` in `fixture` and assert every label in `required` is offered. */
export async function assertFixtureCompletion(
  ctx: Mocha.Context,
  fixture: string,
  needle: string,
  offset: number,
  required: readonly string[],
  why: string,
): Promise<Set<string>> {
  const at = await openFSharpAt(ctx, fixture, needle, offset);
  const labels = await pollCompletionLabels(at.uri, at.position, (set) =>
    required.every((name) => set.has(name)),
  );
  assertContainsAll(labels, required, why);
  return labels;
}
