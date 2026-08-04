module FSharpFixtures.RenameUsages

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

// NestedModule IService Choice Status RecordThing Field CaseOne Ready Alias ClassThing Property Method ModuleAlias StructThing ObjectModelThing Changed Item moduleValue functionName parameter localValue localFunction lambdaParameter firstValue T Positive .+.
let textSentinel = "NestedModule IService Choice Status RecordThing Field CaseOne Ready Alias ClassThing Property Method ModuleAlias StructThing ObjectModelThing Changed Item moduleValue functionName parameter localValue localFunction lambdaParameter firstValue T Positive .+."
