// Exhaustive real-project rename overlays for [RENAME-FSHARP-PREPARE]/[RENAME-FSHARP-APPLY].

export interface RenameScenario {
  readonly name: string;
  readonly target: string;
  readonly targetOccurrence?: number;
  readonly newName: string;
  readonly minimumEdits: number;
  readonly crossFile: boolean;
}

type RenameInput = readonly [string, string, string, number, boolean];

export const RENAME_SENTINEL =
  'NestedModule IService Choice Status RecordThing Field CaseOne Ready Alias ClassThing ' +
  'Property Method ModuleAlias StructThing ObjectModelThing Changed Item moduleValue ' +
  'functionName parameter localValue localFunction lambdaParameter firstValue T Positive .+.';

export const RENAME_DECLARATIONS_SOURCE = `module FSharpFixtures.RenameDeclarations

// Compiled real-project symbols for [RENAME-FSHARP-PREPARE] and [RENAME-FSHARP-APPLY].
module NestedModule =
    let moduleMember = 10

let nestedUse = NestedModule.moduleMember

module ModuleAlias = NestedModule
let moduleAliasUse = ModuleAlias.moduleMember

type IService =
    abstract member Execute: int -> int

type Service() =
    interface IService with
        member _.Execute value = value

type RecordThing = { Field: int }
type Choice = CaseOne of int | CaseTwo
type Status = Ready = 0 | Busy = 1
type Alias = RecordThing

[<Struct>]
type StructThing = { StructValue: int }

type ObjectModelThing(initial: int) =
    member val Current = initial with get, set

type EventSource() =
    let changed = Event<int>()
    [<CLIEvent>]
    member _.Changed = changed.Publish
    member _.Raise value = changed.Trigger value

type IndexerThing() =
    member _.Item with get(index: int) = index

type ClassThing(seed: int) =
    member _.Property = seed
    member _.Method(parameter: int) =
        let localName = parameter + seed
        localName

let moduleValue = 3
let functionName parameter =
    let localValue = parameter + moduleValue
    localValue

let withLocalFunction value =
    let localFunction input = input + value
    localFunction 1

let lambdaResult = [ 1 ] |> List.map (fun lambdaParameter -> lambdaParameter + 1)
let tupleFunction (firstValue, secondValue) = firstValue + secondValue

let identity<'T> (item: 'T) : 'T = item
let (|Positive|NonPositive|) number = if number > 0 then Positive else NonPositive
let positiveHere = match 1 with | Positive -> true | NonPositive -> false
let inline (.+.) left right = left + right

// ${RENAME_SENTINEL}
let textSentinel = "${RENAME_SENTINEL}"
`;

export const RENAME_USAGES_SOURCE = `module FSharpFixtures.RenameUsages

// Cross-file uses for [RENAME-FSHARP-APPLY].
open FSharpFixtures.RenameDeclarations

let nestedValue = NestedModule.moduleMember
let service: IService = Service()
let structValue: StructThing = { StructValue = 1 }
let objectModel = ObjectModelThing(1)
let eventSource = EventSource()
let eventSubscription = eventSource.Changed.Subscribe(fun _ -> ())
let indexerValue = IndexerThing().[0]
let recordValue: RecordThing = { Field = 1 }
let copied = { recordValue with Field = 2 }
let readField = recordValue.Field
let choose: Choice = CaseOne 3
let matchChoice (value: Choice) = match value with | CaseOne number -> number | CaseTwo -> 0
let status: Status = Status.Ready
let aliasValue: Alias = recordValue
let instance = ClassThing(4)
let propertyValue = instance.Property
let methodValue = instance.Method(5)
let moduleCopy = moduleValue
let functionValue = functionName 6
let genericValue = identity "value"
let activeValue = match 1 with | Positive -> true | NonPositive -> false
let operatorValue = 1 .+. 2

// ${RENAME_SENTINEL}
let textSentinel = "${RENAME_SENTINEL}"
`;

export const RENAME_SCENARIOS: readonly RenameScenario[] = [
  rename(['nested module', 'NestedModule', 'RenamedModule', 4, true]),
  rename(['module abbreviation', 'ModuleAlias', 'RenamedAlias', 2, false]),
  rename(['interface type', 'IService', 'IRenamedService', 3, true]),
  rename(['union type', 'Choice', 'Selection', 3, true]),
  rename(['enum type', 'Status', 'State', 3, true]),
  rename(['record type', 'RecordThing', 'RenamedRecord', 3, true]),
  rename(['record field', 'Field', 'Amount', 4, true]),
  rename(['union case', 'CaseOne', 'PrimaryCase', 3, true]),
  rename(['enum case', 'Ready', 'Available', 2, true]),
  // Occurrences are counted over renameable tokens, so the substrings inside
  // `ModuleAlias` and the sentinel comment do not shift this index.
  rename(['type alias', 'Alias', 'RecordAlias', 2, true]),
  rename(['class', 'ClassThing', 'RenamedClass', 2, true]),
  rename(['struct type', 'StructThing', 'RenamedStruct', 2, true]),
  rename(['object-model type', 'ObjectModelThing', 'RenamedObject', 2, true]),
  rename(['property', 'Property', 'Result', 2, true]),
  rename(['member', 'Method', 'Calculate', 2, true]),
  rename(['CLI event', 'Changed', 'Updated', 2, true]),
  rename(['module value', 'moduleValue', 'sharedValue', 3, true]),
  rename(['module function', 'functionName', 'computeValue', 2, true]),
  rename(['parameter', 'parameter', 'input', 2, false]),
  rename(['local binding', 'localValue', 'resultValue', 2, false]),
  rename(['local function', 'localFunction', 'localCompute', 2, false]),
  rename(['lambda parameter', 'lambdaParameter', 'mappedValue', 2, false]),
  rename(['pattern parameter', 'firstValue', 'leftValue', 2, false]),
  rename(['generic type parameter', "'T", "'U", 3, false]),
  rename(['active pattern case', 'Positive', 'AboveZero', 4, true]),
  rename(['custom operator', '.+.', '.*.', 2, true]),
];

function rename([name, target, newName, minimumEdits, crossFile]: RenameInput): RenameScenario {
  return { name, target, newName, minimumEdits, crossFile };
}

export const RENAME_EDGE_SOURCE = `module FSharpFixtures.RenameEdge

// Live overlay intentionally differs from the saved baseline. [RENAME-FSHARP-APPLY]
let unsavedName value = value + 1
let useUnsaved = unsavedName 2
let metadataValue = System.String.Empty
// unsavedName in a comment must remain unchanged.
let stringValue = "unsavedName"
`;

export const RENAME_NAMESPACE_SOURCE = `namespace FSharpFixtures.RenameNamespace

// Namespace is external to rename; the owned type is not. [RENAME-FSHARP-PREPARE]
type PublicType = { Value: int }
`;

export const RENAME_NAMESPACE_USAGE_SOURCE = `module FSharpFixtures.NamespaceConsumer

// Cross-file namespace use for [RENAME-FSHARP-APPLY].
open FSharpFixtures.RenameNamespace

let item: PublicType = { Value = 1 }
`;
