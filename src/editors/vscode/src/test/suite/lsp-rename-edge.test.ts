// Adversarial real-LSP rename coverage for [RENAME-TESTS] and [RENAME-COVERAGE].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { positionOf, rangeOf } from './csharp-refactor-test-kit';
import {
  exerciseRename,
  fixtureOf,
  openRenameFixtures,
  prepareAt,
  providerRename,
  rawRenameAt,
  revertRenameFixtures,
  waitForPrepare,
  type RenameCase,
  type RenameFixtureSet,
} from './csharp-rename-test-kit';
import {
  activateRealSharpLsp,
  replaceDocumentText,
  type OpenFixture,
} from './refactor-test-helpers';

const TEST_TIMEOUT_MS = 180_000;
const EDGE_ONLY = ['edge'] as const;

interface Outcome<T> {
  readonly value?: T;
  readonly error?: unknown;
}

const PARTIAL_TYPE: RenameCase = {
  label: 'partial type declarations',
  fixture: 'edge',
  snippet: 'public partial class PartialRenameTarget',
  oldName: 'PartialRenameTarget',
  newName: 'RenamedPartialTarget',
  editCount: 2,
  files: EDGE_ONLY,
};

const PARTIAL_MEMBER: RenameCase = {
  label: 'partial member declaration and cross-part read',
  fixture: 'edge',
  snippet: 'public int PartialMember',
  oldName: 'PartialMember',
  newName: 'RenamedPartialMember',
  editCount: 2,
  files: EDGE_ONLY,
};

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

const POSITIVE_CASES = [PARTIAL_TYPE, PARTIAL_MEMBER, CASE_ONLY, UNICODE, ESCAPED_KEYWORD];
const INVALID_NAMES = ['', ' ', '123member', 'two words', 'bad-name', '.', 'class'] as const;
const OVERLAY_CASE: RenameCase = {
  label: 'unsaved overlay local',
  fixture: 'edge',
  snippet: 'var overlayLocal',
  oldName: 'overlayLocal',
  newName: 'renamedOverlayLocal',
  editCount: 2,
  files: EDGE_ONLY,
};

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
  const fixture = fixtures.edge;
  const position = positionOf(fixture.document, 'public int PartialMember', 'PartialMember');
  const prepared = await prepareAt(fixture.uri, position);
  assert.strictEqual(prepared?.placeholder, 'PartialMember');
  assertRejectedOrEmpty(
    await capture(rawRenameAt(fixture.uri, position, invalidName)),
    'raw invalid name',
  );
  assertRejectedOrEmpty(
    await capture(providerRename(fixture.uri, position, invalidName)),
    'provider invalid name',
  );
  assertCleanBaselines(fixtures);
}

async function assertSameNameIsNoOp(fixtures: RenameFixtureSet): Promise<void> {
  const fixture = fixtures.edge;
  const position = positionOf(fixture.document, 'public int PartialMember', 'PartialMember');
  const prepared = await prepareAt(fixture.uri, position);
  assert.strictEqual(prepared?.placeholder, 'PartialMember');
  assert.strictEqual(await rawRenameAt(fixture.uri, position, 'PartialMember'), null);
  assertNoResultOrEmpty(await capture(providerRename(fixture.uri, position, 'PartialMember')));
  assertCleanBaselines(fixtures);
}

async function assertConflictRejected(fixtures: RenameFixtureSet): Promise<void> {
  const fixture = fixtures.edge;
  const position = positionOf(fixture.document, 'public int PartialMember', 'PartialMember');
  assertRejectedOrEmpty(
    await capture(rawRenameAt(fixture.uri, position, 'UsePartialMember')),
    'conflicting member rename',
  );
  assertRejectedOrEmpty(
    await capture(providerRename(fixture.uri, position, 'UsePartialMember')),
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
  const position = positionOf(fixtures.edge.document, 'Console.ReadLine()', 'Console');
  await assertNoRenameAt(fixtures.edge, position, 'metadata symbol');
  assertCleanBaselines(fixtures);
}

async function assertIndexerRejected(fixtures: RenameFixtureSet): Promise<void> {
  const position = positionOf(fixtures.symbols.document, 'this[int indexParameter]', 'this');
  await assertNoRenameAt(fixtures.symbols, position, 'indexer keyword');
  assertCleanBaselines(fixtures);
}

async function assertOperatorRejected(fixtures: RenameFixtureSet): Promise<void> {
  const document = fixtures.symbols.document;
  const keyword = positionOf(document, 'operator +', 'operator');
  const punctuation = positionOf(document, 'operator +', '+');
  await assertNoRenameAt(fixtures.symbols, keyword, 'operator keyword');
  await assertNoRenameAt(fixtures.symbols, punctuation, 'operator punctuation');
  assertCleanBaselines(fixtures);
}

async function assertConversionRejected(fixtures: RenameFixtureSet): Promise<void> {
  const document = fixtures.symbols.document;
  const keyword = positionOf(document, 'explicit operator int', 'operator');
  const targetType = positionOf(document, 'explicit operator int', 'int');
  await assertNoRenameAt(fixtures.symbols, keyword, 'conversion operator keyword');
  await assertNoRenameAt(fixtures.symbols, targetType, 'conversion target type');
  assertCleanBaselines(fixtures);
}

async function assertOutOfRangeRejected(fixtures: RenameFixtureSet): Promise<void> {
  const position = new vscode.Position(99_999, 99_999);
  const outcome = await capture(prepareAt(fixtures.edge.uri, position));
  assert.ok(Object.hasOwn(outcome, 'error'), 'out-of-range prepareRename must reject');
  assertCleanBaselines(fixtures);
}

function registerPositiveTests(getFixtures: () => RenameFixtureSet): void {
  for (const renameCase of POSITIVE_CASES) {
    test(`${renameCase.label}: exact edits, apply, reverse, and revert`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await exerciseRename(getFixtures(), renameCase);
    });
  }
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
    test(label, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await operation(getFixtures());
    });
}

function registerInvalidNameTests(getFixtures: () => RenameFixtureSet): void {
  for (const invalidName of INVALID_NAMES) {
    test(`invalid new name ${JSON.stringify(invalidName)} is rejected without edits`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await assertInvalidName(getFixtures(), invalidName);
    });
  }
  test('renaming to the current name is an exact no-op', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await assertSameNameIsNoOp(getFixtures());
  });
  test('conflicting member names are rejected without corrupting the project', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await assertConflictRejected(getFixtures());
  });
}

function registerOverlayTests(getFixtures: () => RenameFixtureSet): void {
  test('out-of-range positions reject instead of crashing or editing', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await assertOutOfRangeRejected(getFixtures());
  });
  test('unsaved overlay symbols prepare, rename, reverse, and revert through the real LSP', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await assertUnsavedOverlay(getFixtures());
  });
}

suite('C# real LSP - rename boundaries, rejection, and overlays [RENAME-TESTS]', () => {
  let fixtures: RenameFixtureSet;

  suiteSetup(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await activateRealSharpLsp();
    fixtures = await openRenameFixtures();
  });

  teardown(async () => revertRenameFixtures(fixtures));
  suiteTeardown(async () => revertRenameFixtures(fixtures));
  registerPositiveTests(() => fixtures);
  registerBoundaryTests(() => fixtures);
  registerInvalidNameTests(() => fixtures);
  registerOverlayTests(() => fixtures);
});
