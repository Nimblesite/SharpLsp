namespace FSharpFixtures.CrossLanguage

// Both directions of the real mixed-project contract. [RENAME-CROSSLANGUAGE]
open CrossLanguageFixtures

type FSharpOrigin(value: int) =
    member _.Value = value

module Usage =
    let readCSharp (origin: CSharpOrigin) = origin.Value
    let makeFSharp value = FSharpOrigin(value)
