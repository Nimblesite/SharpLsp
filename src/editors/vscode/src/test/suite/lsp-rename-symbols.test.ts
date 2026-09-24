// Real release-LSP matrix for every feasible C# [RENAME-COVERAGE] category.
import { exerciseRename, type RenameCase, useRenameFixtures } from './csharp-rename-test-kit';
import { LSP_RESPONSE_MS } from './test-timeouts';

const SYMBOLS_ONLY = ['symbols'] as const;
const SYMBOLS_AND_USAGE = ['symbols', 'usage'] as const;
const ALL_FILES = ['symbols', 'usage', 'edge'] as const;

/** A rename row on the symbols fixture; its edits stay in that file unless `files` says otherwise. */
function symbolRename(
  row: Omit<RenameCase, 'fixture' | 'files'> & { readonly files?: RenameCase['files'] },
): RenameCase {
  return { fixture: 'symbols', files: SYMBOLS_ONLY, ...row };
}

const CASES: readonly RenameCase[] = [
  symbolRename({
    label: 'class declaration and constructor-through-type references',
    snippet: 'public class RenameClass<TType>',
    oldName: 'RenameClass',
    newName: 'RenamedClass',
    editCount: 3,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'struct declaration, constructor, and construction',
    snippet: 'public readonly struct RenameStruct',
    oldName: 'RenameStruct',
    newName: 'RenamedStruct',
    editCount: 3,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'interface declaration, implementation, and typed use',
    snippet: 'public interface IRenameContract<TContract>',
    oldName: 'IRenameContract',
    newName: 'IRenamedContract',
    editCount: 3,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'record declaration and construction',
    snippet: 'public record RenameRecord',
    oldName: 'RenameRecord',
    newName: 'RenamedRecord',
    editCount: 2,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'delegate type declaration and use',
    snippet: 'public delegate int RenameDelegate',
    oldName: 'RenameDelegate',
    newName: 'RenamedDelegate',
    editCount: 2,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'enum type declaration and use',
    snippet: 'public enum RenameEnum',
    oldName: 'RenameEnum',
    newName: 'RenamedEnum',
    editCount: 2,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'enum member declaration and qualified use',
    snippet: 'FirstMember,',
    oldName: 'FirstMember',
    newName: 'RenamedMember',
    editCount: 2,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'record primary-constructor property',
    snippet: 'RenameRecord(int RecordComponent)',
    oldName: 'RecordComponent',
    newName: 'RenamedComponent',
    editCount: 2,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'ordinary method declaration and invocation',
    snippet: 'public int RenameMethod(int methodParameter)',
    oldName: 'RenameMethod',
    newName: 'RenamedMethod',
    editCount: 2,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'interface method, implementation, and call',
    snippet: 'TContract Transform<TMethod>',
    oldName: 'Transform',
    newName: 'TransformRenamed',
    editCount: 3,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'base method, XML cref, override, nameof, and virtual calls',
    snippet: 'abstract int VirtualMember',
    oldName: 'VirtualMember',
    newName: 'RenamedVirtualMember',
    editCount: 6,
    files: SYMBOLS_AND_USAGE,
    after: {
      symbols: [
        'cref="RenamedVirtualMember"',
        'override int RenamedVirtualMember',
        'nameof(RenamedVirtualMember)',
        'value.RenamedVirtualMember(0)',
      ],
      usage: ['baseValue.RenamedVirtualMember(2)'],
    },
  }),
  symbolRename({
    label: 'interface member, explicit implementation, and interface call',
    snippet: 'int ExplicitMember(int value);',
    oldName: 'ExplicitMember',
    newName: 'RenamedExplicitMember',
    editCount: 3,
    files: SYMBOLS_AND_USAGE,
    after: {
      symbols: ['IExplicitRenameContract.RenamedExplicitMember'],
      usage: ['explicitValue.RenamedExplicitMember(3)'],
    },
  }),
  symbolRename({
    label: 'local-function declaration and call',
    snippet: 'int RenameLocalFunction(int localFunctionParameter)',
    oldName: 'RenameLocalFunction',
    newName: 'RenamedLocalFunction',
    editCount: 2,
  }),
  symbolRename({
    label: 'property declaration, write, and read',
    snippet: 'public int RenameProperty { get; set; }',
    oldName: 'RenameProperty',
    newName: 'RenamedProperty',
    editCount: 3,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'private field declaration and all accesses',
    snippet: 'private int _renameField;',
    oldName: '_renameField',
    newName: '_renamedField',
    editCount: 4,
  }),
  symbolRename({
    label: 'constant declaration and all reads',
    snippet: 'const int RenameConstant',
    oldName: 'RenameConstant',
    newName: 'RenamedConstant',
    editCount: 3,
  }),
  symbolRename({
    label: 'event declaration, raise, and subscription',
    snippet: 'event EventHandler? RenameEvent',
    oldName: 'RenameEvent',
    newName: 'RenamedEvent',
    editCount: 3,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'ordinary local declaration and read',
    snippet: 'var renameLocal =',
    oldName: 'renameLocal',
    newName: 'renamedLocal',
    editCount: 2,
  }),
  symbolRename({
    label: 'foreach variable declaration and read',
    snippet: 'var foreachValue in',
    oldName: 'foreachValue',
    newName: 'renamedForeachValue',
    editCount: 2,
  }),
  symbolRename({
    label: 'catch variable declaration and read',
    snippet: 'InvalidOperationException catchError',
    oldName: 'catchError',
    newName: 'renamedCatchError',
    editCount: 2,
  }),
  symbolRename({
    label: 'using variable declaration and read',
    snippet: 'using var usingResource',
    oldName: 'usingResource',
    newName: 'renamedResource',
    editCount: 2,
  }),
  symbolRename({
    label: 'left deconstruction variable',
    snippet: '(deconstructedLeft, deconstructedRight)',
    focus: 'deconstructedLeft',
    oldName: 'deconstructedLeft',
    newName: 'renamedLeft',
    editCount: 2,
  }),
  symbolRename({
    label: 'right deconstruction variable',
    snippet: '(deconstructedLeft, deconstructedRight)',
    focus: 'deconstructedRight',
    oldName: 'deconstructedRight',
    newName: 'renamedRight',
    editCount: 2,
  }),
  symbolRename({
    label: 'pattern source local',
    snippet: 'object patternSource',
    oldName: 'patternSource',
    newName: 'renamedPatternSource',
    editCount: 2,
  }),
  symbolRename({
    label: 'pattern variable declaration and read',
    snippet: 'is int patternValue',
    oldName: 'patternValue',
    newName: 'renamedPatternValue',
    editCount: 2,
  }),
  symbolRename({
    label: 'ordinary method parameter',
    snippet: 'RenameMethod(int methodParameter)',
    oldName: 'methodParameter',
    newName: 'renamedMethodParameter',
    editCount: 2,
  }),
  symbolRename({
    label: 'constructor parameter',
    snippet: 'RenameClass(TType constructorParameter)',
    oldName: 'constructorParameter',
    newName: 'renamedConstructorParameter',
    editCount: 2,
  }),
  symbolRename({
    label: 'indexer parameter declaration and accessors',
    snippet: 'this[int indexParameter]',
    oldName: 'indexParameter',
    newName: 'renamedIndex',
    editCount: 3,
  }),
  symbolRename({
    label: 'local-function parameter',
    snippet: 'RenameLocalFunction(int localFunctionParameter)',
    oldName: 'localFunctionParameter',
    newName: 'renamedLocalParameter',
    editCount: 2,
  }),
  symbolRename({
    label: 'lambda parameter declaration and body',
    snippet: 'lambdaParameter =>',
    oldName: 'lambdaParameter',
    newName: 'renamedLambdaParameter',
    editCount: 2,
  }),
  symbolRename({
    label: 'delegate signature parameter',
    snippet: 'RenameDelegate(int delegateParameter)',
    oldName: 'delegateParameter',
    newName: 'renamedDelegateParameter',
    editCount: 1,
  }),
  symbolRename({
    label: 'class generic type parameter',
    snippet: 'RenameClass<TType>',
    oldName: 'TType',
    newName: 'TTypeRenamed',
    editCount: 6,
  }),
  symbolRename({
    label: 'interface generic type parameter',
    snippet: 'IRenameContract<TContract>',
    oldName: 'TContract',
    newName: 'TContractRenamed',
    editCount: 4,
  }),
  symbolRename({
    label: 'method generic type parameter',
    snippet: 'Transform<TMethod>',
    oldName: 'TMethod',
    newName: 'TMethodRenamed',
    editCount: 2,
  }),
  symbolRename({
    label: 'using alias declaration and use',
    snippet: 'using ResourceAlias =',
    oldName: 'ResourceAlias',
    newName: 'RenamedResourceAlias',
    editCount: 2,
  }),
  symbolRename({
    label: 'constructor token initiates the containing type rename',
    snippet: 'public RenameClass(TType constructorParameter)',
    oldName: 'RenameClass',
    newName: 'ConstructorRenamedClass',
    editCount: 3,
    files: SYMBOLS_AND_USAGE,
  }),
  symbolRename({
    label: 'namespace segment across every C# fixture document',
    snippet: 'namespace SharpLsp.TestFixtures.RenameCoverage',
    oldName: 'RenameCoverage',
    newName: 'RenamedCoverage',
    editCount: 3,
    files: ALL_FILES,
  }),
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
