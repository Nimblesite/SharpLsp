// Real release-LSP matrix for every feasible C# [RENAME-COVERAGE] category.
import { exerciseRename, type RenameCase, useRenameFixtures } from './csharp-rename-test-kit';
import { LSP_RESPONSE_MS } from './test-timeouts';

const SYMBOLS_ONLY = ['symbols'] as const;
const SYMBOLS_AND_USAGE = ['symbols', 'usage'] as const;
const ALL_FILES = ['symbols', 'usage', 'edge'] as const;

/**
 * One rename row, in fixture order: the label the test is named after, the
 * fixture text the caret aims at, the identifier it lands on, its new name, and
 * how many edits the rename must produce. `files` says which of the C#
 * fixture documents those edits may land in — `RenameSymbols.cs` alone by
 * default. `after` is the text the fixtures must hold once the rename applied.
 */
function row(
  label: string,
  snippet: string,
  oldName: string,
  newName: string,
  editCount: number,
  files: RenameCase['files'] = SYMBOLS_ONLY,
  after?: RenameCase['after'],
): RenameCase {
  return {
    fixture: 'symbols',
    label,
    snippet,
    oldName,
    newName,
    editCount,
    files,
    ...(after === undefined ? {} : { after }),
  };
}

const CASES: readonly RenameCase[] = [
  row(
    'class declaration and constructor-through-type references',
    'public class RenameClass<TType>',
    'RenameClass',
    'RenamedClass',
    3,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'struct declaration, constructor, and construction',
    'public readonly struct RenameStruct',
    'RenameStruct',
    'RenamedStruct',
    3,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'interface declaration, implementation, and typed use',
    'public interface IRenameContract<TContract>',
    'IRenameContract',
    'IRenamedContract',
    3,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'record declaration and construction',
    'public record RenameRecord',
    'RenameRecord',
    'RenamedRecord',
    2,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'delegate type declaration and use',
    'public delegate int RenameDelegate',
    'RenameDelegate',
    'RenamedDelegate',
    2,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'enum type declaration and use',
    'public enum RenameEnum',
    'RenameEnum',
    'RenamedEnum',
    2,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'enum member declaration and qualified use',
    'FirstMember,',
    'FirstMember',
    'RenamedMember',
    2,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'record primary-constructor property',
    'RenameRecord(int RecordComponent)',
    'RecordComponent',
    'RenamedComponent',
    2,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'ordinary method declaration and invocation',
    'public int RenameMethod(int methodParameter)',
    'RenameMethod',
    'RenamedMethod',
    2,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'interface method, implementation, and call',
    'TContract Transform<TMethod>',
    'Transform',
    'TransformRenamed',
    3,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'base method, XML cref, override, nameof, and virtual calls',
    'abstract int VirtualMember',
    'VirtualMember',
    'RenamedVirtualMember',
    6,
    SYMBOLS_AND_USAGE,
    {
      symbols: [
        'cref="RenamedVirtualMember"',
        'override int RenamedVirtualMember',
        'nameof(RenamedVirtualMember)',
        'value.RenamedVirtualMember(0)',
      ],
      usage: ['baseValue.RenamedVirtualMember(2)'],
    },
  ),
  row(
    'interface member, explicit implementation, and interface call',
    'int ExplicitMember(int value);',
    'ExplicitMember',
    'RenamedExplicitMember',
    3,
    SYMBOLS_AND_USAGE,
    {
      symbols: ['IExplicitRenameContract.RenamedExplicitMember'],
      usage: ['explicitValue.RenamedExplicitMember(3)'],
    },
  ),
  row(
    'local-function declaration and call',
    'int RenameLocalFunction(int localFunctionParameter)',
    'RenameLocalFunction',
    'RenamedLocalFunction',
    2,
  ),
  row(
    'property declaration, write, and read',
    'public int RenameProperty { get; set; }',
    'RenameProperty',
    'RenamedProperty',
    3,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'private field declaration and all accesses',
    'private int _renameField;',
    '_renameField',
    '_renamedField',
    4,
  ),
  row(
    'constant declaration and all reads',
    'const int RenameConstant',
    'RenameConstant',
    'RenamedConstant',
    3,
  ),
  row(
    'event declaration, raise, and subscription',
    'event EventHandler? RenameEvent',
    'RenameEvent',
    'RenamedEvent',
    3,
    SYMBOLS_AND_USAGE,
  ),
  row('ordinary local declaration and read', 'var renameLocal =', 'renameLocal', 'renamedLocal', 2),
  row(
    'foreach variable declaration and read',
    'var foreachValue in',
    'foreachValue',
    'renamedForeachValue',
    2,
  ),
  row(
    'catch variable declaration and read',
    'InvalidOperationException catchError',
    'catchError',
    'renamedCatchError',
    2,
  ),
  row(
    'using variable declaration and read',
    'using var usingResource',
    'usingResource',
    'renamedResource',
    2,
  ),
  row(
    'left deconstruction variable',
    '(deconstructedLeft, deconstructedRight)',
    'deconstructedLeft',
    'renamedLeft',
    2,
  ),
  row(
    'right deconstruction variable',
    '(deconstructedLeft, deconstructedRight)',
    'deconstructedRight',
    'renamedRight',
    2,
  ),
  row('pattern source local', 'object patternSource', 'patternSource', 'renamedPatternSource', 2),
  row(
    'pattern variable declaration and read',
    'is int patternValue',
    'patternValue',
    'renamedPatternValue',
    2,
  ),
  row(
    'ordinary method parameter',
    'RenameMethod(int methodParameter)',
    'methodParameter',
    'renamedMethodParameter',
    2,
  ),
  row(
    'constructor parameter',
    'RenameClass(TType constructorParameter)',
    'constructorParameter',
    'renamedConstructorParameter',
    2,
  ),
  row(
    'indexer parameter declaration and accessors',
    'this[int indexParameter]',
    'indexParameter',
    'renamedIndex',
    3,
  ),
  row(
    'local-function parameter',
    'RenameLocalFunction(int localFunctionParameter)',
    'localFunctionParameter',
    'renamedLocalParameter',
    2,
  ),
  row(
    'lambda parameter declaration and body',
    'lambdaParameter =>',
    'lambdaParameter',
    'renamedLambdaParameter',
    2,
  ),
  row(
    'delegate signature parameter',
    'RenameDelegate(int delegateParameter)',
    'delegateParameter',
    'renamedDelegateParameter',
    1,
  ),
  row('class generic type parameter', 'RenameClass<TType>', 'TType', 'TTypeRenamed', 6),
  row(
    'interface generic type parameter',
    'IRenameContract<TContract>',
    'TContract',
    'TContractRenamed',
    4,
  ),
  row('method generic type parameter', 'Transform<TMethod>', 'TMethod', 'TMethodRenamed', 2),
  row(
    'using alias declaration and use',
    'using ResourceAlias =',
    'ResourceAlias',
    'RenamedResourceAlias',
    2,
  ),
  row(
    'constructor token initiates the containing type rename',
    'public RenameClass(TType constructorParameter)',
    'RenameClass',
    'ConstructorRenamedClass',
    3,
    SYMBOLS_AND_USAGE,
  ),
  row(
    'namespace segment across every C# fixture document',
    'namespace SharpLsp.TestFixtures.RenameCoverage',
    'RenameCoverage',
    'RenamedCoverage',
    3,
    ALL_FILES,
  ),
];

suite('C# real LSP - exhaustive symbol rename matrix [RENAME-TESTS]', () => {
  const fixtures = useRenameFixtures();

  for (const renameCase of CASES) {
    test(`${renameCase.label}: prepare, edit, apply, requery, reverse, revert`, async function () {
      this.timeout(LSP_RESPONSE_MS + 5_000);
      await exerciseRename(fixtures(), renameCase);
    });
  }
});
