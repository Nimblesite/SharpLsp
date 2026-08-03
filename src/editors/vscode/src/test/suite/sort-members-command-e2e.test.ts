// Implements [SE-CONTEXT-SORT-MEMBERS], [SE-CONTEXT-SORT-HIERARCHY],
// [SE-CONTEXT-SORT-SETTINGS], [SE-CONTEXT-SORT-IMPLEMENTATION], and
// [SHARPLSP-FEATURES-REFACTORING] through the shipped command and real LSP.
import * as assert from 'node:assert/strict';
import {
  type SortPolicy,
  type SurfaceCase,
  assertBlankLineBetween,
  assertInitialState,
  assertLiveSentinels,
  assertNoOp,
  assertNonTypeRejected,
  buildLiveText,
  cleanupSortHarness,
  configureSort,
  exerciseTypeSurface,
  fixtureDocument,
  fixtureText,
  initializeSortHarness,
  installLiveBuffer,
  prepareSortCase,
  redoSort,
  sortAndObserve,
  undoCleanSort,
  undoLiveSort,
} from './sort-members-test-kit';

const DEFAULT_ACCESS = [
  'public',
  'protected internal',
  'internal',
  'protected',
  'private protected',
  'private',
] as const;
const DEFAULT_CATEGORIES = [
  'constant',
  'field',
  'constructor',
  'finalizer',
  'delegate',
  'event',
  'enum',
  'interface',
  'property',
  'indexer',
  'operator',
  'method',
  'struct',
  'class',
  'record',
] as const;
const DEFAULT_POLICY: SortPolicy = {
  hierarchy: ['accessibility', 'category', 'alphabetical'],
  accessibilityOrder: DEFAULT_ACCESS,
  categoryOrder: DEFAULT_CATEGORIES,
};
const CATEGORY_FIRST_POLICY: SortPolicy = {
  ...DEFAULT_POLICY,
  hierarchy: ['category', 'accessibility', 'alphabetical'],
};
const REVERSED_POLICY: SortPolicy = {
  hierarchy: ['accessibility', 'category', 'alphabetical'],
  accessibilityOrder: [...DEFAULT_ACCESS].reverse(),
  categoryOrder: [...DEFAULT_CATEGORIES].reverse(),
};
const ALPHABETICAL_FIRST_POLICY: SortPolicy = {
  ...DEFAULT_POLICY,
  hierarchy: ['alphabetical', 'category', 'accessibility'],
};

const INITIAL_ORDER = [
  'Zebra',
  'Beta',
  'Omega',
  '_zeta',
  'AlphaConstant',
  'SortMembersCommand',
  'Alpha',
] as const;
const DEFAULT_ORDER = [
  'AlphaConstant',
  'SortMembersCommand',
  'Omega',
  'Alpha',
  'Beta',
  '_zeta',
  'Zebra',
] as const;
const CATEGORY_FIRST_ORDER = [
  'AlphaConstant',
  '_zeta',
  'SortMembersCommand',
  'Omega',
  'Alpha',
  'Beta',
  'Zebra',
] as const;
const REVERSED_ORDER = [
  'Zebra',
  '_zeta',
  'Alpha',
  'Beta',
  'Omega',
  'SortMembersCommand',
  'AlphaConstant',
] as const;
const ALPHABETICAL_ORDER = [
  '_zeta',
  'Alpha',
  'AlphaConstant',
  'Beta',
  'Omega',
  'SortMembersCommand',
  'Zebra',
] as const;

const STRUCT_SURFACE: SurfaceCase = {
  typeName: 'SortMembersStruct',
  kinds: ['Struct'],
  contexts: ['symbol.struct'],
  initial: ['Zebra', 'Alpha'],
  expected: ['Alpha', 'Zebra'],
  anchors: { Alpha: 'public int Alpha;', Zebra: 'public void Zebra()' },
};
const INTERFACE_SURFACE: SurfaceCase = {
  typeName: 'ISortMembers',
  kinds: ['Interface'],
  contexts: ['symbol.interface'],
  initial: ['Zebra', 'Alpha'],
  expected: ['Alpha', 'Zebra'],
  anchors: { Alpha: 'int Alpha { get; }', Zebra: 'void Zebra();' },
};
const ENUM_SURFACE: SurfaceCase = {
  typeName: 'SortMembersEnum',
  kinds: ['Enum'],
  contexts: ['symbol.enum'],
  initial: ['Zebra', 'Alpha', 'Middle'],
  expected: ['Alpha', 'Middle', 'Zebra'],
  anchors: { Alpha: 'Alpha', Middle: 'Middle', Zebra: 'Zebra' },
  validateSorted: assertSortedEnum,
};
const RECORD_SURFACE: SurfaceCase = {
  typeName: 'SortMembersRecord',
  kinds: ['Class', 'Record'],
  contexts: ['symbol.class', 'symbol.record'],
  initial: ['Zebra', 'Beta', 'Alpha'],
  expected: ['Alpha', 'Beta', 'Zebra'],
  anchors: {
    Alpha: 'public int Alpha { get; init; }',
    Beta: 'public void Beta()',
    Zebra: 'private void Zebra()',
  },
};
const TYPE_SURFACES = [STRUCT_SURFACE, INTERFACE_SURFACE, ENUM_SURFACE, RECORD_SURFACE];

suite('Sort Members command E2E — real explorer node and real LSP', function () {
  this.timeout(180_000);
  suiteSetup(async () => initializeSortHarness(INITIAL_ORDER));
  setup(prepareSortCase);
  teardown(cleanupSortHarness);
  suiteTeardown(cleanupSortHarness);
  test('default policy, no-op re-entry, undo, and redo', runDefaultScenario);
  test('category-first hierarchy moves private fields ahead of public methods', runCategoryFirst);
  test('reversed accessibility and category lists still alphabetize ties', runReversedPolicy);
  test('alphabetical-first policy sorts the unsaved VFS buffer, then undo/redo', runLiveBuffer);
  test('class/struct/interface/enum/record boundaries and non-type rejection', runTypeSurfaces);
});

async function runDefaultScenario(): Promise<void> {
  await configureSort(DEFAULT_POLICY);
  await assertInitialState(INITIAL_ORDER);
  const outcome = await sortAndObserve(DEFAULT_ORDER);
  assertBlankLineBetween(outcome.afterText, 'Beta', '_zeta');
  await assertNoOp(outcome, DEFAULT_ORDER);
  await undoCleanSort(outcome, INITIAL_ORDER);
  await redoSort(outcome, DEFAULT_ORDER);
}

async function runCategoryFirst(): Promise<void> {
  await configureSort(CATEGORY_FIRST_POLICY);
  await assertInitialState(INITIAL_ORDER);
  const outcome = await sortAndObserve(CATEGORY_FIRST_ORDER);
  assertBlankLineBetween(outcome.afterText, 'AlphaConstant', '_zeta');
  assertBlankLineBetween(outcome.afterText, '_zeta', 'SortMembersCommand');
  assert.ok(outcome.afterText.indexOf('_zeta') < outcome.afterText.indexOf('Alpha()'));
  await undoCleanSort(outcome, INITIAL_ORDER);
  await redoSort(outcome, CATEGORY_FIRST_ORDER);
}

async function runReversedPolicy(): Promise<void> {
  await configureSort(REVERSED_POLICY);
  await assertInitialState(INITIAL_ORDER);
  const outcome = await sortAndObserve(REVERSED_ORDER);
  assertBlankLineBetween(outcome.afterText, 'Zebra', '_zeta');
  assertBlankLineBetween(outcome.afterText, '_zeta', 'Alpha');
  assert.ok(outcome.afterText.indexOf('Alpha()') < outcome.afterText.indexOf('Beta()'));
  assert.ok(
    outcome.afterText.indexOf('SortMembersCommand()') < outcome.afterText.indexOf('AlphaConstant'),
  );
  await assertNoOp(outcome, REVERSED_ORDER);
}

async function runLiveBuffer(): Promise<void> {
  await configureSort(ALPHABETICAL_FIRST_POLICY);
  await assertInitialState(INITIAL_ORDER);
  const liveText = buildLiveText();
  await installLiveBuffer(liveText, INITIAL_ORDER);
  const outcome = await sortAndObserve(ALPHABETICAL_ORDER);
  assertLiveSentinels(outcome.afterText);
  await undoLiveSort(outcome, liveText, INITIAL_ORDER);
  await redoSort(outcome, ALPHABETICAL_ORDER);
  assertLiveSentinels(fixtureDocument().getText());
}

async function runTypeSurfaces(): Promise<void> {
  await configureSort(DEFAULT_POLICY);
  await assertInitialState(INITIAL_ORDER);
  for (const surface of TYPE_SURFACES) {
    await exerciseTypeSurface(surface);
    await assertInitialState(INITIAL_ORDER);
  }
  await assertNonTypeRejected(INITIAL_ORDER, 'Alpha');
  assert.strictEqual(fixtureDocument().getText(), fixtureText());
  assert.ok(!fixtureDocument().isDirty, 'type-boundary rejection leaves the fixture clean');
}

function assertSortedEnum(text: string): void {
  assert.match(text, /Alpha,\s+Middle,\s+Zebra/);
  assert.strictEqual(text.match(/,/g)?.length, 2, 'three enum members require two separators');
  assert.ok(!text.includes('Zebra,'), 'the original non-trailing-comma style is preserved');
}
