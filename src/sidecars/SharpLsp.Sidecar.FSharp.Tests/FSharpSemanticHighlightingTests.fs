/// Standard semantic classifications preserve the active theme's F# colors.
/// Implements [SHARPLSP-FEATURES-HIGHLIGHTING]. Every assertion runs against real FCS and a real fsproj.
module SharpLsp.Sidecar.FSharp.Tests.FSharpSemanticHighlightingTests

open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

let private code =
    source
        [ "module Highlighting"
          "let number = 42"
          "let add (value: int) ="
          "    let local = value + number"
          "    local"
          "type Box() ="
          "    member _.Value = number"
          "    member _.Add(value: int) = add value"
          "let box = Box()"
          "let result = box.Add number" ]

/// Decode the LSP stream so assertions name absolute source spans and standard legend types.
let private decode (data: int array) =
    data
    |> Array.chunkBySize 5
    |> Array.mapFold (fun (line, character) token ->
        let nextLine = line + token[0]
        let nextCharacter = if token[0] = 0 then character + token[1] else token[1]
        (nextLine, nextCharacter, token[2], token[3]), (nextLine, nextCharacter)) (0, 0)
    |> fst

[<Theory>]
[<InlineData(1, 4, 6, 8)>] // A module value is a variable, not a method.
[<InlineData(2, 4, 3, 12)>] // A module function is a function, not a method.
[<InlineData(3, 8, 5, 8)>] // A local value is a variable, not a method.
[<InlineData(6, 13, 5, 9)>] // A member property remains a property.
[<InlineData(7, 13, 3, 13)>] // A member method remains a method.
[<InlineData(3, 22, 1, 21)>] // An overloaded operator keeps the standard operator category.
let ``full and range tokens use standard FSharp symbol categories`` line column length expected = task {
    let! state, directory, _, files = loadWorkspace [ "Highlighting.fs", code ]
    try
        let! full = FSharpFeatures.getSemanticTokens state files[0]
        let tokens = decode full
        Assert.Contains((line, column, length, expected), tokens)
        let! ranged = FSharpFeatures.getSemanticTokensRange state files[0] line line
        let selected = decode ranged
        Assert.Contains((line, column, length, expected), selected)
        Assert.All(selected, fun (actualLine, _, _, _) -> Assert.Equal(line, actualLine))
        Assert.DoesNotContain(tokens, fun (_, _, _, kind) -> kind = 15 || kind = 23)
    finally
        cleanup directory
}
