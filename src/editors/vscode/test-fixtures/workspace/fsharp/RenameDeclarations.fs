module FSharpFixtures.RenameDeclarations

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

// NestedModule IService Choice Status RecordThing Field CaseOne Ready Alias ClassThing Property Method ModuleAlias StructThing ObjectModelThing Changed Item moduleValue functionName parameter localValue localFunction lambdaParameter firstValue T Positive .+.
let textSentinel = "NestedModule IService Choice Status RecordThing Field CaseOne Ready Alias ClassThing Property Method ModuleAlias StructThing ObjectModelThing Changed Item moduleValue functionName parameter localValue localFunction lambdaParameter firstValue T Positive .+."
