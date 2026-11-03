namespace FSharpFixtures.CrossLanguageNavigation

// Every kind of F# declaration a C# project can reach, and every kind of C#
// declaration F# can reach: F12 lands on the original source. [DEFINITION-CROSSLANG]
open CrossLanguageNavigationFixtures

type NavRecord = { NavField: int; NavOther: string }

type NavUnion =
    | NavCaseEmpty
    | NavCaseWith of navPayload: int

type NavShade =
    | NavLight
    | NavDark

type NavGenericUnion<'T> =
    | NavGenericEmpty
    | NavGenericCase of 'T

type NavEnum =
    | NavEnumOne = 1
    | NavEnumTwo = 2

[<Struct>]
type NavStruct = { NavStructField: int }

type INavContract =
    abstract NavContractCall: int -> int

type NavClass(seed: int) =
    let mutable stored = seed
    member _.NavProperty = seed
    member _.NavMutable
        with get () = stored
        and set value = stored <- value
    member _.NavMethod(amount: int) = seed + amount
    member _.NavOverload(value: int) = value
    member _.NavOverload(value: string) = value.Length
    member _.NavGenericMethod<'T>(value: 'T) = value
    static member NavStatic(value: int) = value * 2
    interface INavContract with
        member _.NavContractCall value = value

type NavGenericBox<'T>(value: 'T) =
    member _.NavUnbox = value

exception NavFailure of string

module NavModule =
    let navValue = 7
    let navFunction left right = left + right
    let navGenericFunction (value: 'T) = value

    type NavNestedRecord = { NavNestedField: int }

    module NavInner =
        let navInnerFunction value = value + 1

[<CompilationRepresentation(CompilationRepresentationFlags.ModuleSuffix)>]
module NavRecord =
    let navSuffixed (record: NavRecord) = record.NavField

[<System.Runtime.CompilerServices.Extension>]
module NavExtensions =
    [<System.Runtime.CompilerServices.Extension>]
    let NavExtended (value: NavClass) = value.NavProperty

module CSharpUses =
    let constructed = NavCSharpClass(1)
    let viaMethod = constructed.NavCSharpMethod(2)
    let viaOverloadInt = constructed.NavCSharpOverload(3)
    let viaOverloadString = constructed.NavCSharpOverload("four")
    let viaProperty = constructed.NavCSharpProperty
    let viaField = constructed.NavCSharpField
    let viaConstant = NavCSharpClass.NavCSharpConstant
    let viaStatic = NavCSharpClass.NavCSharpStatic(5)
    let viaGenericMethod = constructed.NavCSharpGeneric<int>(6)
    let viaNested = NavCSharpClass.NavCSharpNested()
    let viaNestedMember = viaNested.NavCSharpNestedValue
    let viaEvent = constructed.NavCSharpEvent
    let viaExtension = NavCSharpExtensions.NavCSharpExtended(constructed)
    let viaEnum = NavCSharpEnum.NavCSharpEnumTwo
    let viaStruct = NavCSharpStruct(7)
    let viaStructMember = viaStruct.NavCSharpStructValue
    let viaRecord = NavCSharpRecord(8)
    let viaRecordMember = viaRecord.NavCSharpPositional
    let viaBox = NavCSharpBox<int>(9)
    let viaBoxMember = viaBox.NavCSharpBoxed
    let viaDelegate = NavCSharpDelegate(fun value -> value)
    let callContract (contract: INavCSharpContract) = contract.NavCSharpCall(10)
