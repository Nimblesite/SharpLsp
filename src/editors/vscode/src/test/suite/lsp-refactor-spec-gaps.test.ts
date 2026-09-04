// Real-LSP lifecycle matrix for the [SHARPLSP-FEATURES-REFACTORING] families
// that the existing refactor matrices never exercise.
//
// Every row here is a feature the spec table names with a Roslyn API and a
// priority. A row that fails is not a broken test -- it is the spec's P0/P1
// column reporting that the family is not wired up yet.
import { exerciseCodeAction, type ActionLifecycleCase } from './csharp-refactor-test-kit';
import {
  activateRealSharpLsp,
  openFixtureDocument,
  revertDocument,
  warmSemanticEngine,
  type OpenFixture,
} from './refactor-test-helpers';
import { FIXTURE_BUILD_MS, LSP_RESPONSE_MS } from './test-timeouts';

const INTRODUCE_LOCAL_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class IntroduceLocalTarget
{
    public int Compute(int left, int right) { return (left + right) * (left + right); } // introduce-local-sentinel
}
`;

const INTRODUCE_CONSTANT_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class IntroduceConstantTarget
{
    public int Compute() { return 3 * 7; } // introduce-constant-sentinel
}
`;

const GENERATE_CONSTRUCTOR_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class GenerateConstructorTarget
{
    private readonly int _count;
    private readonly string _label; // generate-constructor-sentinel
    public string Describe() => $"{_label}:{_count}";
}
`;

const INLINE_METHOD_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class InlineMethodTarget
{
    private static int Doubled(int value) => value * 2;
    public int Compute(int seed) { return Doubled(seed) + 1; } // inline-method-sentinel
}
`;

const ENCAPSULATE_FIELD_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class EncapsulateFieldTarget
{
    public int Value; // encapsulate-field-sentinel
    public int Read() => Value + 1;
}
`;

const INTRODUCE_PARAMETER_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class IntroduceParameterTarget
{
    public int Compute(int seed) { return seed * 2; } // introduce-parameter-sentinel
}
`;

const METHOD_TO_PROPERTY_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class MethodToPropertyTarget
{
    public int GetValue() => 42; // method-to-property-sentinel
}
`;

// Extract variable and Extract constant, both P0 in the spec table, are the
// two families with no row anywhere in the existing matrices.
const EXTRACT_CASES: readonly ActionLifecycleCase[] = [
  {
    label: 'extract variable introduces a local for a repeated expression',
    source: INTRODUCE_LOCAL_SOURCE,
    snippet: 'return (left + right) * (left + right);',
    focus: 'left + right',
    title: "Introduce local for 'left + right'",
    kind: 'refactor.extract',
    presentAfter: ['introduce-local-sentinel'],
    absentAfter: ['(left + right) * (left + right)'],
    patternsAfter: [/(?:int|var)\s+\w+\s*=\s*left \+ right;/],
  },
  {
    label: 'extract constant introduces a const for a literal',
    source: INTRODUCE_CONSTANT_SOURCE,
    snippet: 'return 3 * 7;',
    focus: '7',
    title: "Introduce constant for '7'",
    kind: 'refactor.extract',
    presentAfter: ['const int', 'introduce-constant-sentinel'],
    absentAfter: ['return 3 * 7;'],
    patternsAfter: [/const int \w+ = 7;/],
  },
];

// Generate constructor is P0; inline method and encapsulate field are the
// remaining P1/P2 rewrite families with no coverage.
const GENERATE_CASES: readonly ActionLifecycleCase[] = [
  {
    label: 'generate constructor seeds every readonly field',
    source: GENERATE_CONSTRUCTOR_SOURCE,
    snippet: 'class GenerateConstructorTarget',
    focus: 'GenerateConstructorTarget',
    title: "Generate constructor 'GenerateConstructorTarget(int, string)'",
    kind: 'refactor',
    caretOnly: true,
    presentAfter: ['generate-constructor-sentinel'],
    absentAfter: [],
    patternsAfter: [
      /public GenerateConstructorTarget\(int \w+, string \w+\)/,
      /_count = \w+;/,
      /_label = \w+;/,
    ],
  },
  {
    label: 'inline method replaces the call with the callee body',
    source: INLINE_METHOD_SOURCE,
    snippet: 'return Doubled(seed) + 1;',
    focus: 'Doubled',
    title: "Inline 'Doubled'",
    kind: 'refactor.inline',
    presentAfter: ['inline-method-sentinel'],
    absentAfter: ['Doubled(seed)'],
    patternsAfter: [/seed \* 2/],
  },
  {
    label: 'encapsulate field converts a public field into a property',
    source: ENCAPSULATE_FIELD_SOURCE,
    snippet: 'public int Value;',
    focus: 'Value',
    title: "Encapsulate field: 'Value' (and use property)",
    kind: 'refactor',
    caretOnly: true,
    presentAfter: ['encapsulate-field-sentinel'],
    absentAfter: ['public int Value;'],
    patternsAfter: [/private int \w+;/, /public int Value\s*\{[\s\S]*get/],
  },
];

// P2 families. They are the lowest priority in the table and the likeliest to
// be missing, which is exactly why the spec's own column deserves a row.
const SIGNATURE_CASES: readonly ActionLifecycleCase[] = [
  {
    label: 'introduce parameter lifts an expression into the signature',
    source: INTRODUCE_PARAMETER_SOURCE,
    snippet: 'return seed * 2;',
    focus: 'seed * 2',
    title: "Introduce parameter for 'seed * 2'",
    kind: 'refactor.extract',
    presentAfter: ['introduce-parameter-sentinel'],
    absentAfter: ['return seed * 2;'],
    patternsAfter: [/Compute\(int seed, int \w+\)/],
  },
  {
    label: 'convert method to property rewrites a getter-shaped method',
    source: METHOD_TO_PROPERTY_SOURCE,
    snippet: 'public int GetValue() => 42;',
    focus: 'GetValue',
    title: 'Convert to property',
    kind: 'refactor.rewrite',
    caretOnly: true,
    presentAfter: ['method-to-property-sentinel'],
    absentAfter: ['GetValue()'],
    patternsAfter: [/public int Value\b/],
  },
];

const CASES: readonly ActionLifecycleCase[] = [
  ...EXTRACT_CASES,
  ...GENERATE_CASES,
  ...SIGNATURE_CASES,
];

suite('C# real LSP - refactoring families the spec table requires', () => {
  let fixture: OpenFixture;
  let committedText = '';

  suiteSetup(async function () {
    // ONE initialization for the whole suite: activation, fixture open, and the
    // Roslyn project load are paid here so no test body carries a build tier.
    this.timeout(FIXTURE_BUILD_MS);
    await activateRealSharpLsp();
    fixture = await openFixtureDocument('RefactorCore.cs');
    await warmSemanticEngine(fixture.uri);
    committedText = fixture.document.getText();
  });

  teardown(async () => revertDocument(fixture.document));

  for (const actionCase of CASES) {
    test(`${actionCase.label}: list, resolve, apply, requery, undo, redo, retry`, async function () {
      this.timeout(LSP_RESPONSE_MS + 5_000);
      await exerciseCodeAction(fixture, committedText, actionCase);
    });
  }
});
