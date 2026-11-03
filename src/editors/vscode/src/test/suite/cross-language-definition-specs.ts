// Every kind of declaration that crosses the C# ↔ F# boundary, in both directions:
// where the user presses F12, and the exact original source it must land on.
// Implements [DEFINITION-CROSSLANG] and [DEFINITION-CROSSLANG-IDENTITY].

export const FSHARP_ORIGIN = 'fsharp/CrossLanguageNavigation.fs';
export const CSHARP_ORIGIN = 'CrossLanguageNavigationCSharp.cs';
export const CSHARP_USE = 'crosslanguage/FSharpNavigationConsumer.cs';
export const FSHARP_USE = FSHARP_ORIGIN;

export const REVEAL_DEFINITION = 'editor.action.revealDefinition';
export const REVEAL_DECLARATION = 'editor.action.revealDeclaration';
export const REVEAL_TYPE_DEFINITION = 'editor.action.goToTypeDefinition';

export interface CrossLanguageSpec {
  readonly name: string;
  readonly useFile: string;
  /** Text unique in the use file holding the symbol under the cursor. */
  readonly use: string;
  /** The identifier in `use` the cursor sits on. */
  readonly cursorOn: string;
  readonly originFile: string;
  readonly originLanguage: 'fsharp' | 'csharp';
  /** Text unique in the origin file holding the declared name. */
  readonly declaration: string;
  /** The name in `declaration` the cursor must land on. */
  readonly landsOn: string;
  readonly command: string;
}

type Row = readonly [name: string, use: string, cursorOn: string, declaration: string];

function fromCSharp(
  [name, use, cursorOn, declaration]: Row,
  landsOn = cursorOn,
  command = REVEAL_DEFINITION,
): CrossLanguageSpec {
  return {
    name: `C# → F# ${name}`,
    useFile: CSHARP_USE,
    use,
    cursorOn,
    originFile: FSHARP_ORIGIN,
    originLanguage: 'fsharp',
    declaration,
    landsOn,
    command,
  };
}

function fromFSharp(
  [name, use, cursorOn, declaration]: Row,
  landsOn = cursorOn,
  command = REVEAL_DEFINITION,
): CrossLanguageSpec {
  return {
    name: `F# → C# ${name}`,
    useFile: FSHARP_USE,
    use,
    cursorOn,
    originFile: CSHARP_ORIGIN,
    originLanguage: 'csharp',
    declaration,
    landsOn,
    command,
  };
}

const FSHARP_DECLARATIONS: readonly Row[] = [
  ['class', 'NavClass instance', 'NavClass', 'type NavClass(seed'],
  ['interface', 'INavContract contract', 'INavContract', 'type INavContract ='],
  ['generic class', 'NavGenericBox<int> box', 'NavGenericBox', "type NavGenericBox<'T>"],
  ['record field', 'record.NavField', 'NavField', '{ NavField: int'],
  ['struct field', 'structValue.NavStructField', 'NavStructField', '{ NavStructField: int'],
  ['union type', 'var empty = NavUnion', 'NavUnion', 'type NavUnion ='],
  ['union case property', 'NavUnion.NavCaseEmpty', 'NavCaseEmpty', '| NavCaseEmpty'],
  ['union case field', 'payloadCase.navPayload', 'navPayload', 'navPayload: int'],
  ['enum type', 'NavEnum.NavEnumTwo', 'NavEnum', 'type NavEnum ='],
  ['enum member', 'NavEnum.NavEnumTwo', 'NavEnumTwo', '| NavEnumTwo = 2'],
  ['property', 'instance.NavProperty', 'NavProperty', 'member _.NavProperty'],
  ['settable property', 'instance.NavMutable', 'NavMutable', 'member _.NavMutable'],
  ['method', 'instance.NavMethod', 'NavMethod', 'member _.NavMethod'],
  ['int overload', 'instance.NavOverload(9)', 'NavOverload', 'NavOverload(value: int)'],
  ['string overload', 'instance.NavOverload("ten")', 'NavOverload', 'NavOverload(value: string)'],
  ['generic method', 'instance.NavGenericMethod', 'NavGenericMethod', 'member _.NavGenericMethod'],
  ['static method', 'NavClass.NavStatic', 'NavStatic', 'static member NavStatic'],
  ['interface member', 'contract.NavContractCall', 'NavContractCall', 'abstract NavContractCall'],
  ['generic class member', 'box.NavUnbox', 'NavUnbox', 'member _.NavUnbox'],
  ['exception', 'new NavFailure', 'NavFailure', 'exception NavFailure'],
  ['module', 'NavModule.navValue', 'NavModule', 'module NavModule ='],
  ['module value', 'NavModule.navValue', 'navValue', 'let navValue'],
  ['curried function', 'NavModule.navFunction', 'navFunction', 'let navFunction'],
  [
    'generic function',
    'NavModule.navGenericFunction',
    'navGenericFunction',
    'let navGenericFunction',
  ],
  ['nested module', 'NavModule.NavInner', 'NavInner', 'module NavInner ='],
  ['nested function', 'NavInner.navInnerFunction', 'navInnerFunction', 'let navInnerFunction'],
  ['nested record field', 'nested.NavNestedField', 'NavNestedField', '{ NavNestedField: int'],
  ['module-suffixed function', 'navSuffixed(record)', 'navSuffixed', 'let navSuffixed'],
  ['extension function', 'NavExtensions.NavExtended', 'NavExtended', 'let NavExtended'],
];

/** Constructors and compiled names F# declares only as the type or case. */
const FSHARP_COMPILED_NAMES: readonly CrossLanguageSpec[] = [
  fromCSharp(['generated Equals', 'record.Equals', 'Equals', 'type NavRecord ='], 'NavRecord'),
  fromCSharp(['generated Tag', 'withPayload.Tag', 'Tag', 'type NavUnion ='], 'NavUnion'),
  fromCSharp(['exception field', 'failure.Data0', 'Data0', 'exception NavFailure'], 'NavFailure'),
  fromCSharp(['fieldless union case', 'NavShade.NavLight', 'NavLight', '| NavLight']),
  fromCSharp(
    ['generic union factory', '.NewNavGenericCase', 'NewNavGenericCase', '| NavGenericCase of'],
    'NavGenericCase',
  ),
  fromCSharp([
    'generic union property',
    '<int>.NavGenericEmpty',
    'NavGenericEmpty',
    '| NavGenericEmpty',
  ]),
  fromCSharp(
    ['generic union test', '.IsNavGenericEmpty', 'IsNavGenericEmpty', '| NavGenericEmpty'],
    'NavGenericEmpty',
  ),
  fromCSharp(
    ['unnamed case field', 'genericCase.Item', 'Item', '| NavGenericCase of'],
    'NavGenericCase',
  ),
  fromCSharp(['record constructor', 'new NavRecord', 'NavRecord', 'type NavRecord =']),
  fromCSharp(['struct constructor', 'new NavStruct', 'NavStruct', '[<Struct>]\ntype NavStruct =']),
  fromCSharp(['class constructor', 'new NavClass', 'NavClass', 'type NavClass(seed']),
  fromCSharp(
    ['union case factory', 'NavUnion.NewNavCaseWith', 'NewNavCaseWith', '| NavCaseWith of'],
    'NavCaseWith',
  ),
  fromCSharp(['union case class', '(NavUnion.NavCaseWith)', 'NavCaseWith', '| NavCaseWith of']),
  fromCSharp(
    ['union case test', 'empty.IsNavCaseEmpty', 'IsNavCaseEmpty', '| NavCaseEmpty'],
    'NavCaseEmpty',
  ),
  fromCSharp(
    [
      'module-suffixed module',
      'NavRecordModule.navSuffixed',
      'NavRecordModule',
      'module NavRecord =',
    ],
    'NavRecord',
  ),
  fromCSharp([
    'nested record',
    'NavModule.NavNestedRecord',
    'NavNestedRecord',
    'type NavNestedRecord =',
  ]),
];

/** The other navigation commands take the same route to the same source. */
const FSHARP_OTHER_COMMANDS: readonly CrossLanguageSpec[] = [
  fromCSharp(
    ['type of a local', 'var constructed', 'constructed', 'type NavClass(seed'],
    'NavClass',
    REVEAL_TYPE_DEFINITION,
  ),
  fromCSharp(
    ['declaration of a method', 'instance.NavMethod', 'NavMethod', 'member _.NavMethod'],
    'NavMethod',
    REVEAL_DECLARATION,
  ),
];

const CSHARP_DECLARATIONS: readonly Row[] = [
  ['class', 'NavCSharpClass.NavCSharpConstant', 'NavCSharpClass', 'class NavCSharpClass'],
  [
    'constructor',
    'constructed = NavCSharpClass',
    'NavCSharpClass',
    'public NavCSharpClass(int seed)',
  ],
  ['method', 'constructed.NavCSharpMethod', 'NavCSharpMethod', 'int NavCSharpMethod'],
  ['int overload', 'NavCSharpOverload(3)', 'NavCSharpOverload', 'NavCSharpOverload(int value)'],
  [
    'string overload',
    'NavCSharpOverload("four")',
    'NavCSharpOverload',
    'NavCSharpOverload(string value)',
  ],
  ['property', 'constructed.NavCSharpProperty', 'NavCSharpProperty', 'int NavCSharpProperty {'],
  ['field', 'constructed.NavCSharpField', 'NavCSharpField', 'int NavCSharpField'],
  ['constant', 'NavCSharpClass.NavCSharpConstant', 'NavCSharpConstant', 'int NavCSharpConstant'],
  ['static method', 'NavCSharpClass.NavCSharpStatic', 'NavCSharpStatic', 'int NavCSharpStatic'],
  ['generic method', 'constructed.NavCSharpGeneric', 'NavCSharpGeneric', 'T NavCSharpGeneric<T>'],
  ['nested class', 'NavCSharpClass.NavCSharpNested', 'NavCSharpNested', 'class NavCSharpNested'],
  [
    'nested member',
    'viaNested.NavCSharpNestedValue',
    'NavCSharpNestedValue',
    'int NavCSharpNestedValue',
  ],
  ['event', 'constructed.NavCSharpEvent', 'NavCSharpEvent', 'EventHandler? NavCSharpEvent'],
  [
    'extension method',
    'NavCSharpExtensions.NavCSharpExtended',
    'NavCSharpExtended',
    'int NavCSharpExtended',
  ],
  ['enum type', 'NavCSharpEnum.NavCSharpEnumTwo', 'NavCSharpEnum', 'enum NavCSharpEnum'],
  ['enum member', 'NavCSharpEnum.NavCSharpEnumTwo', 'NavCSharpEnumTwo', 'NavCSharpEnumTwo = 2'],
  [
    'struct member',
    'viaStruct.NavCSharpStructValue',
    'NavCSharpStructValue',
    'int NavCSharpStructValue {',
  ],
  ['record type', 'viaRecord = NavCSharpRecord', 'NavCSharpRecord', 'record NavCSharpRecord'],
  [
    'record member',
    'viaRecord.NavCSharpPositional',
    'NavCSharpPositional',
    'int NavCSharpPositional',
  ],
  ['generic constructor', 'viaBox = NavCSharpBox', 'NavCSharpBox', 'public NavCSharpBox(T value)'],
  ['generic class member', 'viaBox.NavCSharpBoxed', 'NavCSharpBoxed', 'T NavCSharpBoxed {'],
  ['delegate', 'viaDelegate = NavCSharpDelegate', 'NavCSharpDelegate', 'int NavCSharpDelegate'],
  [
    'interface',
    'contract: INavCSharpContract',
    'INavCSharpContract',
    'interface INavCSharpContract',
  ],
  ['interface member', 'contract.NavCSharpCall', 'NavCSharpCall', 'int NavCSharpCall'],
];

const CSHARP_OTHER_COMMANDS: readonly CrossLanguageSpec[] = [
  fromFSharp(
    ['type of a value', 'let constructed', 'constructed', 'class NavCSharpClass'],
    'NavCSharpClass',
    REVEAL_TYPE_DEFINITION,
  ),
  fromFSharp(
    [
      'declaration of a method',
      'constructed.NavCSharpMethod',
      'NavCSharpMethod',
      'int NavCSharpMethod',
    ],
    'NavCSharpMethod',
    REVEAL_DECLARATION,
  ),
];

export const FSHARP_CLASS_FROM_CSHARP = fromCSharp(FSHARP_DECLARATIONS[0]!);
export const CSHARP_CLASS_FROM_FSHARP = fromFSharp(CSHARP_DECLARATIONS[0]!);

export const CROSS_LANGUAGE_SPECS: readonly CrossLanguageSpec[] = [
  ...FSHARP_DECLARATIONS.map((row) => fromCSharp(row)),
  ...FSHARP_COMPILED_NAMES,
  ...FSHARP_OTHER_COMMANDS,
  ...CSHARP_DECLARATIONS.map((row) => fromFSharp(row)),
  ...CSHARP_OTHER_COMMANDS,
];
