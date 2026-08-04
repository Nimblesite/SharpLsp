module FSharpFixtures.Implement

/// Valid baseline; the real-LSP test injects an incomplete live overlay.
/// [ANALYZERS-FSAC-CODEFIX-INTERFACE-STUB]
type IShape =
    abstract member Area: unit -> float
    abstract member Name: string

type Square() =
    interface IShape with
        member _.Area() = 1.0
        member _.Name = "square"
