// Adversarial real-LSP rename coverage for [RENAME-TESTS] and [RENAME-COVERAGE].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { positionOf, rangeOf } from './document-anchors';
import {
  exerciseRename,
  fixtureOf,
  prepareAt,
  providerRename,
  rawRenameAt,
  revertRenameFixtures,
  waitForPrepare,
  type RenameCase,
  type RenameFixtureSet,
  useRenameFixtures,
} from './csharp-rename-test-kit';
import { replaceDocumentText, type OpenFixture } from './refactor-test-helpers';
import { underLspBudget } from './fsharp-refactor-test-kit';

const EDGE_ONLY = ['edge'] as const;

/** A rename case that lives in the C# edge fixture and touches only that file. */
function edgeCase(label: string, snippet: string, oldName: string, newName: string): RenameCase {
  return { label, fixture: 'edge', snippet, oldName, newName, editCount: 2, files: EDGE_ONLY };
}

interface Outcome<T> {
  readonly value?: T;
  readonly error?: unknown;
}

const PARTIAL_TYPE: RenameCase = edgeCase(
  'partial type declarations',
  'public partial class PartialRenameTarget',
  'PartialRenameTarget',
  'RenamedPartialTarget',
);

const PARTIAL_MEMBER: RenameCase = edgeCase(
  'partial member declaration and cross-part read',
  'public int PartialMember',
  'PartialMember',
  'RenamedPartialMember',
);

const CASE_ONLY: RenameCase = {
  ...PARTIAL_MEMBER,
  label: 'case-only identifier change',
  newName: 'partialMember',
};

const UNICODE: RenameCase = {
  ...PARTIAL_MEMBER,
  label: 'Unicode identifier change',
  newName: 'Μέλος',
};

const ESCAPED_KEYWORD: RenameCase = {
  ...PARTIAL_MEMBER,
  label: 'escaped-keyword identifier change',
  newName: '@class',
};

const CONTEXTUAL_KEYWORD: RenameCase = {
  ...PARTIAL_MEMBER,
  label: 'contextual-keyword identifier change',
  newName: 'record',
};

const POSITIVE_CASES = [PARTIAL_TYPE, PARTIAL_MEMBER, CASE_ONLY, UNICODE, ESCAPED_KEYWORD, CONTEXTUAL_KEYWORD];
const INVALID_NAMES = ['', ' ', '123member', 'two words', 'bad-name', '.', 'class'] as const;
const OVERLAY_CASE: RenameCase = edgeCase(
  'unsaved overlay local',
  'var overlayLocal',
  'overlayLocal',
  'renamedOverlayLocal',
);

const OVERLAY_SOURCE = `namespace SharpLsp.TestFixtures.RenameCoverage;

public sealed class OverlayTarget
{
    public int Compute(int overlayParameter)
    {
        var overlayLocal = overlayParameter + 1;
        return overlayLocal; // unsaved-overlay-sentinel
    }
}
`;

async function capture<T>(operation: Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await operation };
  } catch (error: unknown) {
    return { error };
  }
}

function assertRejectedOrEmpty<T>(outcome: Outcome<T | null | undefined>, label: string): void {
  const rejected = Object.hasOwn(outcome, 'error');
  const empty = Object.hasOwn(outcome, 'value') && outcome.value == null;
  assert.ok(rejected || empty, `${label} must reject or return no edit`);
}

function assertNoResultOrEmpty<T>(outcome: Outcome<T | null | undefined>): void {
  if (Object.hasOwn(outcome, 'error')) {
    assert.match(String(outcome.error), /No result/i);
  } else {
    assert.ok(outcome.value == null, 'same-name provider rename must return no edit');
  }
}

function assertCleanBaselines(fixtures: RenameFixtureSet): void {
  for (const key of ['symbols', 'usage', 'edge'] as const) {
    const fixture = fixtureOf(fixtures, key);
    assert.strictEqual(fixture.document.getText(), fixtures.baselines[key]);
    assert.ok(!fixture.document.isDirty);
  }
}

async function assertNoRenameAt(
  fixture: OpenFixture,
  position: vscode.Position,
  label: string,
): Promise<void> {
  assert.strictEqual(await prepareAt(fixture.uri, position), null, `${label} prepare must be null`);
  const raw = await capture(rawRenameAt(fixture.uri, position, 'ShouldNotRename'));
  assertRejectedOrEmpty(raw, `${label} raw rename`);
  const provider = await capture(providerRename(fixture.uri, position, 'ShouldNotRename'));
  assertRejectedOrEmpty(provider, `${label} VS Code rename`);
  assert.ok(!fixture.document.isDirty);
}

async function assertInvalidName(fixtures: RenameFixtureSet, invalidName: string): Promise<void> {
  const position = await preparedPartialMember(fixtures);
  assertRejectedOrEmpty(
    await capture(rawRenameAt(fixtures.edge.uri, position, invalidName)),
    'raw invalid name',
  );
  assertRejectedOrEmpty(
    await capture(providerRename(fixtures.edge.uri, position, invalidName)),
    'provider invalid name',
  );
  assertCleanBaselines(fixtures);
}

/** The edge fixture's `PartialMember` declaration and its caret position. */
function partialMemberAt(fixtures: RenameFixtureSet): {
  readonly fixture: OpenFixture;
  readonly position: vscode.Position;
} {
  const fixture = fixtures.edge;
  return {
    fixture,
    position: positionOf(fixture.document, 'public int PartialMember', 'PartialMember'),
  };
}

/** `PartialMember` prepares under its own name; returns the caret it prepares at. */
async function preparedPartialMember(fixtures: RenameFixtureSet): Promise<vscode.Position> {
  const { fixture, position } = partialMemberAt(fixtures);
  const prepared = await prepareAt(fixture.uri, position);
  assert.strictEqual(prepared?.placeholder, 'PartialMember');
  return position;
}

async function assertSameNameIsNoOp(fixtures: RenameFixtureSet): Promise<void> {
  const position = await preparedPartialMember(fixtures);
  assert.strictEqual(await rawRenameAt(fixtures.edge.uri, position, 'PartialMember'), null);
  assertNoResultOrEmpty(
    await capture(providerRename(fixtures.edge.uri, position, 'PartialMember')),
  );
  assertCleanBaselines(fixtures);
}

async function assertConflictRejected(fixtures: RenameFixtureSet): Promise<void> {
  const { position } = partialMemberAt(fixtures);
  assertRejectedOrEmpty(
    await capture(rawRenameAt(fixtures.edge.uri, position, 'UsePartialMember')),
    'conflicting member rename',
  );
  assertRejectedOrEmpty(
    await capture(providerRename(fixtures.edge.uri, position, 'UsePartialMember')),
    'conflicting provider rename',
  );
  assertCleanBaselines(fixtures);
}

async function assertUnsavedOverlay(fixtures: RenameFixtureSet): Promise<void> {
  await replaceDocumentText(fixtures.edge.document, OVERLAY_SOURCE);
  const position = positionOf(fixtures.edge.document, 'var overlayLocal', 'overlayLocal');
  assert.strictEqual(
    (await waitForPrepare(fixtures.edge.uri, position, 'overlayLocal')).placeholder,
    'overlayLocal',
  );
  const overlayFixtures: RenameFixtureSet = {
    ...fixtures,
    baselines: { ...fixtures.baselines, edge: OVERLAY_SOURCE },
  };
  await exerciseRename(overlayFixtures, OVERLAY_CASE, false);
  assert.ok(fixtures.edge.document.isDirty);
  assert.ok(fixtures.edge.document.getText().includes('unsaved-overlay-sentinel'));
  await revertRenameFixtures(fixtures);
}

async function assertTokenBoundaries(fixtures: RenameFixtureSet): Promise<void> {
  const range = rangeOf(fixtures.edge.document, 'public int PartialMember', 'PartialMember');
  await assertNoRenameAt(fixtures.edge, range.end, 'token end');
  await assertNoRenameAt(fixtures.edge, new vscode.Position(range.start.line, 0), 'line trivia');
  assertCleanBaselines(fixtures);
}

async function assertTriviaPositions(fixtures: RenameFixtureSet): Promise<void> {
  const document = fixtures.edge.document;
  const comment = positionOf(document, '// PartialRenameTarget and PartialMember', 'PartialMember');
  const literal = positionOf(document, '"PartialRenameTarget PartialMember"', 'PartialMember');
  const blank = new vscode.Position(positionOf(document, 'public partial class').line - 1, 0);
  await assertNoRenameAt(fixtures.edge, comment, 'comment');
  await assertNoRenameAt(fixtures.edge, literal, 'string');
  await assertNoRenameAt(fixtures.edge, blank, 'blank line');
}

async function assertMetadataRejected(fixtures: RenameFixtureSet): Promise<void> {
  await assertNoRenameToken(fixtures, 'edge', 'Console.ReadLine()', 'Console', 'metadata symbol');
}

async function assertIndexerRejected(fixtures: RenameFixtureSet): Promise<void> {
  await assertNoRenameToken(
    fixtures,
    'symbols',
    'this[int indexParameter]',
    'this',
    'indexer keyword',
  );
}

/** No rename is possible at `token` inside `snippet`, and no fixture text changed. */
async function assertNoRenameToken(
  fixtures: RenameFixtureSet,
  key: 'edge' | 'symbols',
  snippet: string,
  token: string,
  label: string,
): Promise<void> {
  const fixture = fixtureOf(fixtures, key);
  await assertNoRenameAt(fixture, positionOf(fixture.document, snippet, token), label);
  assertCleanBaselines(fixtures);
}

async function assertOperatorRejected(fixtures: RenameFixtureSet): Promise<void> {
  await assertNoRenameToken(fixtures, 'symbols', 'operator +', 'operator', 'operator keyword');
  await assertNoRenameToken(fixtures, 'symbols', 'operator +', '+', 'operator punctuation');
}

async function assertConversionRejected(fixtures: RenameFixtureSet): Promise<void> {
  await assertNoRenameToken(
    fixtures,
    'symbols',
    'explicit operator int',
    'operator',
    'conversion operator keyword',
  );
  await assertNoRenameToken(
    fixtures,
    'symbols',
    'explicit operator int',
    'int',
    'conversion target type',
  );
}

async function assertOutOfRangeRejected(fixtures: RenameFixtureSet): Promise<void> {
  const position = new vscode.Position(99_999, 99_999);
  const outcome = await capture(prepareAt(fixtures.edge.uri, position));
  assert.ok(Object.hasOwn(outcome, 'error'), 'out-of-range prepareRename must reject');
  assertCleanBaselines(fixtures);
}

function registerPositiveTests(getFixtures: () => RenameFixtureSet): void {
  for (const renameCase of POSITIVE_CASES)
    test(
      `${renameCase.label}: exact edits, apply, reverse, and revert`,
      underLspBudget(() => exerciseRename(getFixtures(), renameCase)),
    );
}

function registerBoundaryTests(getFixtures: () => RenameFixtureSet): void {
  const cases: readonly [string, (fixtures: RenameFixtureSet) => Promise<void>][] = [
    ['token-end and token-before positions are not renameable', assertTokenBoundaries],
    ['comments, strings, and blank-line trivia are never renameable', assertTriviaPositions],
    ['metadata symbols cannot produce source rename edits', assertMetadataRejected],
    ['the C# indexer this keyword is not a renameable identifier', assertIndexerRejected],
    [
      'operator declarations reject keyword and punctuation rename positions',
      assertOperatorRejected,
    ],
    [
      'conversion-operator type tokens cannot masquerade as renameable declarations',
      assertConversionRejected,
    ],
  ];
  for (const [label, operation] of cases)
    test(
      label,
      underLspBudget(() => operation(getFixtures())),
    );
}

function registerInvalidNameTests(getFixtures: () => RenameFixtureSet): void {
  for (const invalidName of INVALID_NAMES)
    test(
      `invalid new name ${JSON.stringify(invalidName)} is rejected without edits`,
      underLspBudget(() => assertInvalidName(getFixtures(), invalidName)),
    );
  test(
    'renaming to the current name is an exact no-op',
    underLspBudget(() => assertSameNameIsNoOp(getFixtures())),
  );
  test(
    'conflicting member names are rejected without corrupting the project',
    underLspBudget(() => assertConflictRejected(getFixtures())),
  );
}

function registerOverlayTests(getFixtures: () => RenameFixtureSet): void {
  test(
    'out-of-range positions reject instead of crashing or editing',
    underLspBudget(() => assertOutOfRangeRejected(getFixtures())),
  );
  test(
    'unsaved overlay symbols prepare, rename, reverse, and revert through the real LSP',
    underLspBudget(() => assertUnsavedOverlay(getFixtures())),
  );
}

suite('C# real LSP - rename boundaries, rejection, and overlays [RENAME-TESTS]', () => {
  const fixtures = useRenameFixtures();
  registerPositiveTests(fixtures);
  registerBoundaryTests(fixtures);
  registerInvalidNameTests(fixtures);
  registerOverlayTests(fixtures);
});
