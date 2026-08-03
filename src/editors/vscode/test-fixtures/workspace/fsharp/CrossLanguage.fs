namespace FSharpFixtures.CrossLanguage

// Both directions of the real mixed-project contract. [RENAME-CROSSLANGUAGE]
open CrossLanguageFixtures

type FSharpOrigin(value: int) =
    member _.FSharpValue = value

module Usage =
    let readCSharp (origin: CSharpOrigin) = origin.CSharpValue
    let readFSharp (origin: FSharpOrigin) = origin.FSharpValue
    let makeFSharp value = FSharpOrigin(value)

module Unrelated =
    // A same-name value must never be swept into request-local foreign recovery.
    let BridgedCSharpType = "UNCHANGED-FSHARP-SENTINEL"
    let BridgedCSharpMember = "UNCHANGED-FSHARP-MEMBER-SENTINEL"
