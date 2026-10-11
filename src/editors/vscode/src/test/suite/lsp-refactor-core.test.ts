// Exhaustive real-LSP Roslyn refactor matrix for [SHARPLSP-FEATURES-REFACTORING].
import {
  applyAction,
  assertActionRequery,
  assertOutsideActionRange,
  discoverAction,
  resolveAction,
  type ActionLifecycleCase,
} from './csharp-refactor-test-kit';
import {
  replaceDocumentText,
  type OpenFixture,
  useRefactorFixture,
  restoreCommitted,
  type RefactorFixture,
} from './refactor-test-helpers';
import {
  EXPRESSION_OPTIONS,
  EXPRESSION_SOURCE,
  FIELD_OPTIONS,
  FIELD_SOURCE,
  IF_OPTIONS,
  IF_SOURCE,
  INLINE_SOURCE,
  PARAMETER_OPTIONS,
  PARAMETER_SOURCE,
  PROPERTY_OPTIONS,
  PROPERTY_SOURCE,
} from './lsp-refactor-core-fixtures';
import { LSP_RESPONSE_MS } from './test-timeouts';

const FILE = 'RefactorCore.cs';

/** A lifecycle case that lists every title its range offers. */
type RefactorScenario = ActionLifecycleCase & { readonly options: readonly string[] };

const EXPRESSION_SITE = {
  source: EXPRESSION_SOURCE,
  snippet: 'input * 2',
  focus: 'input * 2',
  kind: 'refactor.extract',
  options: EXPRESSION_OPTIONS,
};

const FIELD_SITE = {
  source: FIELD_SOURCE,
  snippet: 'public int EncapsulateTarget;',
  focus: 'EncapsulateTarget',
  kind: 'refactor.rewrite',
  options: FIELD_OPTIONS,
};

const PROPERTY_SITE = {
  source: PROPERTY_SOURCE,
  snippet: 'AutoProperty { get; set; }',
  focus: 'AutoProperty',
  kind: 'refactor.rewrite',
  options: PROPERTY_OPTIONS,
};

const IF_SITE = {
  source: IF_SOURCE,
  snippet: 'if (input > 0)',
  focus: 'if',
  kind: 'refactor.rewrite',
  options: IF_OPTIONS,
};

const PARAMETER_SITE = {
  source: PARAMETER_SOURCE,
  snippet: 'input * 2',
  focus: 'input * 2',
  kind: 'refactor.rewrite',
  options: PARAMETER_OPTIONS,
};

const SCENARIOS: readonly RefactorScenario[] = [
  {
    ...EXPRESSION_SITE,
    label: 'introduce one local',
    title: "Introduce local for 'input * 2'",
    presentAfter: ['expression-refactor-sentinel'],
    absentAfter: [],
    patternsAfter: [/var \w+ = input \* 2;/],
  },
  {
    ...EXPRESSION_SITE,
    label: 'introduce local for all occurrences',
    title: "Introduce local for all occurrences of 'input * 2'",
    presentAfter: ['expression-refactor-sentinel'],
    absentAfter: ['input * 2 + input * 2'],
    patternsAfter: [/var \w+ = input \* 2;/],
  },
  {
    ...EXPRESSION_SITE,
    label: 'extract method',
    title: 'Extract method',
    presentAfter: ['expression-refactor-sentinel'],
    absentAfter: [],
    patternsAfter: [/private static int \w+\(int input\)/],
  },
  {
    ...EXPRESSION_SITE,
    label: 'extract local function',
    title: 'Extract local function',
    presentAfter: ['expression-refactor-sentinel'],
    absentAfter: [],
    patternsAfter: [/static int \w+\(int input\)/],
  },
  {
    label: 'inline temporary',
    source: INLINE_SOURCE,
    snippet: 'var doubled = input * 2',
    focus: 'doubled',
    title: 'Inline temporary variable',
    kind: 'refactor.inline',
    options: ['Inline temporary variable'],
    presentAfter: ['return input * 2 + _seed;', 'inline-sentinel'],
    absentAfter: ['var doubled'],
    mustDisappear: true,
    postApplySnippet: 'input * 2 + _seed',
    postApplyFocus: 'input * 2',
  },
  {
    ...FIELD_SITE,
    label: 'encapsulate and redirect uses',
    title: FIELD_OPTIONS[0],
    presentAfter: ['field-refactor-sentinel', 'Read() => EncapsulateTarget'],
    absentAfter: [],
    patternsAfter: [/private int \w*encapsulateTarget/i, /public int EncapsulateTarget\s*\{/],
    mustDisappear: true,
  },
  {
    ...FIELD_SITE,
    label: 'encapsulate while retaining field uses',
    title: FIELD_OPTIONS[1],
    presentAfter: ['field-refactor-sentinel'],
    absentAfter: ['public int EncapsulateTarget;'],
    patternsAfter: [
      /private int _?encapsulateTarget;/i,
      /public int EncapsulateTarget\s*\{\s*get => _?encapsulateTarget;/i,
      /Read\(\) => _?encapsulateTarget/i,
    ],
    mustDisappear: true,
  },
  {
    ...FIELD_SITE,
    label: 'generate constructor from field',
    title: FIELD_OPTIONS[2],
    presentAfter: [
      'RefactorTarget(int encapsulateTarget)',
      'EncapsulateTarget = encapsulateTarget',
    ],
    absentAfter: [],
    mustDisappear: true,
  },
  {
    ...PROPERTY_SITE,
    label: 'convert auto property to full property',
    title: 'Convert to full property',
    presentAfter: ['property-refactor-sentinel'],
    absentAfter: ['AutoProperty { get; set; }'],
    patternsAfter: [/private int _?autoProperty/i, /public int AutoProperty\s*\{\s*get/],
    mustDisappear: true,
  },
  {
    ...PROPERTY_SITE,
    label: 'convert auto property to field-backed accessors',
    title: "Convert to 'field' property",
    presentAfter: ['property-refactor-sentinel', 'field'],
    absentAfter: ['AutoProperty { get; set; }'],
    mustDisappear: true,
  },
  {
    ...PROPERTY_SITE,
    label: 'replace property with methods',
    title: "Replace 'AutoProperty' with methods",
    presentAfter: ['GetAutoProperty', 'SetAutoProperty', 'property-refactor-sentinel'],
    absentAfter: ['AutoProperty { get; set; }'],
    mustDisappear: true,
  },
  {
    ...PROPERTY_SITE,
    label: 'generate constructor from property',
    title: "Generate constructor 'RefactorTarget(int autoProperty)'",
    presentAfter: ['RefactorTarget(int autoProperty)', 'AutoProperty = autoProperty'],
    absentAfter: [],
    mustDisappear: true,
  },
  {
    ...IF_SITE,
    label: 'invert condition',
    title: 'Invert if',
    presentAfter: ['condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'],
    patternsAfter: [/if \(input <= 0\)|if \(!\(input > 0\)\)/],
    postApplySnippet: 'if',
    requeryTitleCount: 1,
  },
  {
    ...IF_SITE,
    label: 'convert condition to switch statement',
    title: "Convert to 'switch' statement",
    presentAfter: ['switch', 'condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'],
    mustDisappear: true,
  },
  {
    ...IF_SITE,
    label: 'convert condition to switch expression',
    title: "Convert to 'switch' expression",
    presentAfter: ['switch', 'condition-refactor-sentinel'],
    absentAfter: ['if (input > 0)'],
    mustDisappear: true,
  },
  {
    ...PARAMETER_SITE,
    label: 'introduce parameter and update call sites directly',
    title: PARAMETER_OPTIONS[0],
    presentAfter: ['introduce-parameter-sentinel'],
    absentAfter: [],
    patternsAfter: [/Compute\(int input, int \w+\)/, /Compute\(3, 3 \* 2\)/],
  },
  {
    ...PARAMETER_SITE,
    label: 'introduce parameter through an extracted call-site method',
    title: PARAMETER_OPTIONS[1],
    presentAfter: ['introduce-parameter-sentinel'],
    absentAfter: [],
    patternsAfter: [/Compute\(int input, int \w+\)/, /Compute\(3, \w+\(3\)\)/],
  },
  {
    ...PARAMETER_SITE,
    label: 'introduce parameter through a compatibility overload',
    title: PARAMETER_OPTIONS[2],
    presentAfter: ['introduce-parameter-sentinel'],
    absentAfter: [],
    patternsAfter: [
      /Compute\(int input, int \w+\)/,
      /Compute\(int input\)[\s\S]*Compute\(input, input \* 2\)/,
    ],
  },
];

async function runScenario(
  fixture: OpenFixture,
  committedText: string,
  scenario: RefactorScenario,
): Promise<void> {
  await replaceDocumentText(fixture.document, scenario.source);
  await assertOutsideActionRange(fixture, scenario);
  const discovered = await discoverAction(fixture, scenario);
  await applyAction(fixture, scenario, await resolveAction(fixture, scenario, discovered.range));
  await assertActionRequery(fixture, scenario, discovered.range, discovered.raw);
  await restoreCommitted(fixture, committedText);
}

function registerCoreTests(refactor: RefactorFixture): void {
  for (const scenario of SCENARIOS) {
    test(`${scenario.label}: list, resolve, apply, requery, and revert`, async function () {
      this.timeout(LSP_RESPONSE_MS + 5_000);
      await runScenario(refactor.fixture, refactor.committedText, scenario);
    });
  }
}

suite('C# real LSP - Roslyn refactor families', () => {
  const refactor = useRefactorFixture(FILE);
  registerCoreTests(refactor);
});
