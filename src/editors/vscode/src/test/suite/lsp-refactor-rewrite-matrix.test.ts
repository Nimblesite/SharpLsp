// Full-lifecycle real-LSP matrix for remaining [SHARPLSP-FEATURES-REFACTORING] families.
import { exerciseCodeAction, type ActionLifecycleCase } from './csharp-refactor-test-kit';
import {
  activateRealSharpLsp,
  openFixtureDocument,
  revertDocument,
  type OpenFixture,
} from './refactor-test-helpers';

const TEST_TIMEOUT_MS = 180_000;

const CONSTANT_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class ConstantTarget
{
    public int Compute() => 1 + 2; // constant-sentinel
}
`;

const TYPE_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class TypeTarget
{
    public int Compute() { int value = 1; return value; } // type-sentinel
}
`;

const VAR_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class VarTarget
{
    public int Compute() { var value = 1; return value; } // var-sentinel
}
`;

const METHOD_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class MethodTarget
{
    public int Compute(int value) { return value + 1; } // method-sentinel
}
`;

const LOOP_SOURCE = `using System.Collections.Generic;
namespace SharpLsp.TestFixtures.Refactors;
public class LoopTarget
{
    public int Sum(List<int> values) { var total = 0; foreach (var value in values) { total += value; } return total; } // loop-sentinel
}
`;

const FOR_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class ForTarget
{
    public int Sum() { var total = 0; for (var index = 0; index < 10; index++) { total += index; } return total; } // for-sentinel
}
`;

const STRING_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class StringTarget
{
    public string Join(string left, string right) => left + "-" + right; // string-sentinel
}
`;

const INLINE_METHOD_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class InlineMethodTarget
{
    private int Double(int value) => value * 2;
    public int Compute() => Double(3); // inline-method-sentinel
}
`;

const EQUALITY_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class EqualityTarget
{
    public int X;
    public string Name = "equality-sentinel";
}
`;

const RECORD_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
// record-sentinel
public class RecordTarget
{
    public int X { get; }
    public RecordTarget(int x) { X = x; }
}
`;

const NAMESPACE_SOURCE = `namespace SharpLsp.TestFixtures.Refactors
{
    public class NamespaceTarget { } // namespace-sentinel
}
`;

const BLOCK_METHOD_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class BlockMethodTarget
{
    public int Compute(int value) => value + 1; // block-method-sentinel
}
`;

const MERGE_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class MergeTarget
{
    public int Compute() { int value; value = 1; return value; } // merge-sentinel
}
`;

const INLINE_DECLARATION_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class InlineDeclarationTarget
{
    public bool Parse(string text) { int value; return int.TryParse(text, out value); } // inline-declaration-sentinel
}
`;

const WRAP_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class WrapTarget
{
    private int Add(int first, int second) => first + second;
    public int Compute() => Add(1, 2); // wrap-sentinel
}
`;

const LINQ_SOURCE = `using System.Collections.Generic;
namespace SharpLsp.TestFixtures.Refactors;
public class LinqTarget
{
    public List<int> SelectPositive(List<int> values) { var result = new List<int>(); foreach (var value in values) { if (value > 0) result.Add(value * 2); } return result; } // linq-sentinel
}
`;

const FIELD_SOURCE = `using System;
namespace SharpLsp.TestFixtures.Refactors;
public class IntroduceFieldTarget
{
    public IntroduceFieldTarget() { Console.WriteLine(DateTime.Now.Year); } // field-sentinel
}
`;

const OVERRIDE_SOURCE = `using System;
namespace SharpLsp.TestFixtures.Refactors;
public abstract class OverrideBase
{
    public abstract int Compute(int value);
    public abstract string Name { get; }
    public abstract int this[int index] { get; }
    public abstract event EventHandler? Changed;
}
public class OverrideTarget : OverrideBase { } // override-sentinel
`;

const COMPARISON_SOURCE = `using System;
namespace SharpLsp.TestFixtures.Refactors;
public class ComparisonTarget : IComparable<ComparisonTarget>
{
    public int X;
    public int CompareTo(ComparisonTarget? other) => X.CompareTo(other?.X);
}
`;

const NULL_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;
public class NullTarget
{
    public string Name { get; }
    public NullTarget(string name) { Name = name; } // null-check-sentinel
}
`;

const CONSTANT_OPTIONS = [
  "Introduce constant for '1 + 2'",
  "Introduce constant for all occurrences of '1 + 2'",
  "Introduce local constant for '1 + 2'",
  "Introduce local constant for all occurrences of '1 + 2'",
] as const;

const CASES: readonly ActionLifecycleCase[] = [
  {
    label: 'introduce class constant',
    source: CONSTANT_SOURCE,
    snippet: '1 + 2',
    focus: '1 + 2',
    title: CONSTANT_OPTIONS[0],
    kind: 'refactor.extract',
    options: CONSTANT_OPTIONS,
    presentAfter: ['constant-sentinel'],
    absentAfter: [],
    patternsAfter: [/const int \w+ = 1 \+ 2;/],
  },
  {
    label: 'introduce local constant',
    source: CONSTANT_SOURCE,
    snippet: '1 + 2',
    focus: '1 + 2',
    title: CONSTANT_OPTIONS[2],
    kind: 'refactor.extract',
    options: CONSTANT_OPTIONS,
    presentAfter: ['constant-sentinel'],
    absentAfter: [],
    patternsAfter: [/const int \w+ = 1 \+ 2;/],
  },
  {
    label: 'explicit type to var',
    source: TYPE_SOURCE,
    snippet: 'int value = 1',
    focus: 'int',
    title: "use 'var' instead of explicit type",
    kind: 'refactor.rewrite',
    presentAfter: ['var value = 1', 'type-sentinel'],
    absentAfter: ['int value = 1'],
  },
  {
    label: 'var to explicit type',
    source: VAR_SOURCE,
    snippet: 'var value = 1',
    focus: 'var',
    title: 'Use explicit type',
    kind: 'refactor.rewrite',
    presentAfter: ['int value = 1', 'var-sentinel'],
    absentAfter: ['var value = 1'],
  },
  {
    label: 'method to expression body',
    source: METHOD_SOURCE,
    snippet: 'Compute(int value)',
    focus: 'Compute',
    title: 'Use expression body for method',
    kind: 'refactor.rewrite',
    presentAfter: ['=> value + 1;', 'method-sentinel'],
    absentAfter: ['{ return value + 1; }'],
  },
  {
    label: 'foreach to for',
    source: LOOP_SOURCE,
    snippet: 'foreach (var value in values)',
    focus: 'foreach',
    title: "Convert to 'for'",
    kind: 'refactor.rewrite',
    presentAfter: ['for (', 'loop-sentinel'],
    absentAfter: ['foreach ('],
  },
  {
    label: 'reverse for loop',
    source: FOR_SOURCE,
    snippet: 'for (var index = 0;',
    focus: 'for',
    title: "Reverse 'for' statement",
    kind: 'refactor.rewrite',
    presentAfter: ['for-sentinel'],
    absentAfter: ['index = 0; index < 10; index++'],
    patternsAfter: [/index = 10 - 1; index >= 0; index--/],
  },
  {
    label: 'concatenation to interpolated string',
    source: STRING_SOURCE,
    snippet: 'left + "-" + right',
    focus: 'left + "-" + right',
    title: 'Convert to interpolated string',
    kind: 'refactor.rewrite',
    presentAfter: ['$"{left}-{right}"', 'string-sentinel'],
    absentAfter: ['left + "-" + right'],
  },
  {
    label: 'inline and remove method',
    source: INLINE_METHOD_SOURCE,
    snippet: 'Double(3)',
    focus: 'Double(3)',
    title: "Inline 'Double(int value)'",
    kind: 'refactor.inline',
    options: ["Inline 'Double(int value)'", "Inline and keep 'Double(int value)'"],
    postApplySnippet: '3 * 2',
    presentAfter: ['3 * 2', 'inline-method-sentinel'],
    absentAfter: ['private int Double'],
  },
  {
    label: 'inline and retain method',
    source: INLINE_METHOD_SOURCE,
    snippet: 'Double(3)',
    focus: 'Double(3)',
    title: "Inline and keep 'Double(int value)'",
    kind: 'refactor.inline',
    options: ["Inline 'Double(int value)'", "Inline and keep 'Double(int value)'"],
    presentAfter: ['private int Double', '3 * 2', 'inline-method-sentinel'],
    absentAfter: [],
  },
  {
    label: 'generate Equals',
    source: EQUALITY_SOURCE,
    snippet: 'public int X;\n    public string Name',
    focus: 'public int X;\n    public string Name',
    title: 'Generate Equals(...)',
    kind: 'refactor.rewrite',
    caretOnly: true,
    options: ['Generate Equals(...)', 'Generate Equals and GetHashCode'],
    presentAfter: ['override bool Equals', 'equality-sentinel'],
    absentAfter: [],
  },
  {
    label: 'generate Equals and GetHashCode',
    source: EQUALITY_SOURCE,
    snippet: 'public int X;\n    public string Name',
    focus: 'public int X;\n    public string Name',
    title: 'Generate Equals and GetHashCode',
    kind: 'refactor.rewrite',
    caretOnly: true,
    options: ['Generate Equals(...)', 'Generate Equals and GetHashCode'],
    presentAfter: ['override bool Equals', 'override int GetHashCode', 'equality-sentinel'],
    absentAfter: [],
  },
  {
    label: 'class to positional record',
    source: RECORD_SOURCE,
    snippet: 'class RecordTarget',
    focus: 'RecordTarget',
    title: 'Convert to positional record',
    kind: 'refactor.rewrite',
    presentAfter: ['record RecordTarget(', 'record-sentinel'],
    absentAfter: ['class RecordTarget'],
  },
  {
    label: 'block to file-scoped namespace',
    source: NAMESPACE_SOURCE,
    snippet: 'namespace SharpLsp',
    focus: 'namespace',
    outsideSnippet: 'class NamespaceTarget',
    title: 'Convert to file-scoped namespace',
    kind: 'refactor.rewrite',
    // This rewrite converts the whole file, so Roslyn offers it at every
    // position inside the namespace; there is no meaningful "outside" range.
    skipOutsideRange: true,
    presentAfter: ['namespace SharpLsp.TestFixtures.Refactors;', 'namespace-sentinel'],
    absentAfter: ['namespace SharpLsp.TestFixtures.Refactors\n{'],
  },
  {
    // Roslyn only offers the expression-wrapping rewrite here: converting an
    // expression body back to a block body is IDE0022, and this fixture project
    // disables the IDE analyzers, so no such quickfix exists to assert.
    label: 'wrap expression-bodied member',
    source: BLOCK_METHOD_SOURCE,
    snippet: 'Compute(int value) => value + 1;',
    focus: 'value + 1',
    title: 'Wrap expression',
    kind: 'refactor.rewrite',
    caretOnly: true,
    presentAfter: ['block-method-sentinel'],
    absentAfter: ['=> value + 1;'],
    patternsAfter: [/=>\s*value\s*\+\s*1;/],
  },
  {
    label: 'merge declaration and assignment',
    source: MERGE_SOURCE,
    snippet: 'int value; value = 1;',
    focus: 'int value; value = 1;',
    title: 'Merge declaration and assignment',
    kind: 'refactor.rewrite',
    presentAfter: ['int value = 1;', 'merge-sentinel'],
    absentAfter: ['int value; value = 1;'],
  },
  {
    // 'Inline variable declaration' is IDE0018, which this analyzer-disabled
    // fixture never reports; the extract family is what Roslyn really offers on
    // an out-argument call, so that is what this case proves end to end.
    label: 'extract local function from an out-argument call',
    source: INLINE_DECLARATION_SOURCE,
    snippet: 'int.TryParse(text, out value)',
    focus: 'int.TryParse(text, out value)',
    title: 'Extract local function',
    kind: 'refactor.extract',
    presentAfter: ['inline-declaration-sentinel'],
    absentAfter: [],
  },
  {
    label: 'wrap arguments',
    source: WRAP_SOURCE,
    snippet: 'Add(1, 2)',
    focus: '1, 2',
    title: 'Indent all arguments',
    kind: 'refactor.rewrite',
    caretOnly: true,
    presentAfter: ['wrap-sentinel'],
    absentAfter: ['Add(1, 2)'],
    patternsAfter: [/Add\(\s*1,\s*2\s*\)/],
  },
  {
    label: 'imperative loop to LINQ',
    source: LINQ_SOURCE,
    snippet: 'foreach (var value in values)',
    focus: 'foreach',
    title: 'Convert to LINQ (call form)',
    kind: 'refactor.rewrite',
    options: ['Convert to LINQ', 'Convert to LINQ (call form)'],
    presentAfter: ['.Where(', '.Select(', 'linq-sentinel'],
    absentAfter: ['foreach ('],
  },
  {
    // Roslyn offers 'Introduce local', never 'Introduce field', for an
    // expression inside a constructor body. The constructor-level rewrite it
    // does offer is the expression body conversion, proven here end to end.
    label: 'constructor to expression body',
    source: FIELD_SOURCE,
    snippet: 'DateTime.Now.Year',
    focus: 'DateTime.Now.Year',
    title: 'Use expression body for constructor',
    kind: 'refactor.rewrite',
    caretOnly: true,
    presentAfter: ['=> Console.WriteLine(DateTime.Now.Year);', 'field-sentinel'],
    absentAfter: ['{ Console.WriteLine(DateTime.Now.Year); }'],
  },
  {
    label: 'generate overrides',
    source: OVERRIDE_SOURCE,
    snippet: 'class OverrideTarget',
    focus: 'OverrideTarget',
    title: 'Generate overrides...',
    kind: 'refactor.rewrite',
    presentAfter: [
      'override int Compute',
      'override string Name',
      'override int this[int index]',
      'override event EventHandler? Changed',
      'override-sentinel',
    ],
    absentAfter: ['OverrideTarget : OverrideBase { }'],
    patternsAfter: [
      /override int Compute\(int value\)/,
      /override string Name\s*\{\s*get/,
      /override int this\[int index\]\s*\{\s*get/,
      /override event EventHandler\? Changed\s*\{\s*add[\s\S]*remove/,
    ],
  },
  {
    label: 'generate comparison operators',
    source: COMPARISON_SOURCE,
    snippet: 'class ComparisonTarget',
    focus: 'ComparisonTarget',
    title: 'Generate comparison operators',
    kind: 'refactor.rewrite',
    presentAfter: ['operator <', 'operator >'],
    absentAfter: [],
  },
  {
    label: 'add constructor null checks',
    source: NULL_SOURCE,
    snippet: 'NullTarget(string name)',
    focus: 'name',
    title: 'Add null check',
    kind: 'refactor.rewrite',
    presentAfter: ['ArgumentNullException', 'null-check-sentinel'],
    absentAfter: [],
  },
];

suite('C# real LSP - extended Roslyn rewrite families', () => {
  let fixture: OpenFixture;
  let committedText = '';

  suiteSetup(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await activateRealSharpLsp();
    fixture = await openFixtureDocument('RefactorCore.cs');
    committedText = fixture.document.getText();
  });

  teardown(async () => revertDocument(fixture.document));

  for (const actionCase of CASES) {
    test(`${actionCase.label}: list, resolve, apply, requery, and revert`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await exerciseCodeAction(fixture, committedText, actionCase);
    });
  }
});
