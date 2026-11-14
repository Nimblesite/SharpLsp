/// Compiler-backed rename-name validation over real F# projects. [RENAME-ERRORS]
module SharpLsp.Sidecar.FSharp.Tests.FSharpRenameNameValidationTests

open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

/// FCS lexes adjacent escaped-name tokens, but FS3563 rejects the whole result.
[<Fact>]
let ``rename refuses embedded escaped identifier delimiters`` () = task {
    let input = source [ "module Names"; "let compute value = value + 1" ]
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Names.fs", input ]
    try
        let! renamed =
            FSharpRename.renameResult state paths[0] 1 4 "``a``b``" System.Threading.CancellationToken.None
        match renamed with
        | Ok edits -> failwith $"invalid escaped rename returned {edits.Length} edits"
        | Error message -> Assert.Contains("Invalid F# rename name", message)
    finally
        cleanup dir
}

/// [RENAME-ERRORS] A bare escape delimiter is an invalid name, never an exception.
[<Fact>]
let ``operator rename refuses a bare escape delimiter`` () = task {
    let input = source [ "module Ops"; "let (+.) a b = a + b" ]
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Ops.fs", input ]
    try
        let! renamed =
            FSharpRename.renameResult state paths[0] 1 5 "``" System.Threading.CancellationToken.None
        match renamed with
        | Ok edits -> failwith $"bare escape delimiter rename returned {edits.Length} edits"
        | Error message -> Assert.Contains("Invalid F# rename name", message)
    finally
        cleanup dir
}

/// [RENAME-FSHARP-APPLY] Inline generic parameters may use caret spelling.
[<Fact>]
let ``inline generic parameter accepts a caret rename`` () = task {
    let input = source [ "module Generic"; "let inline identity<'T> (value: 'T) = value" ]
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Generic.fs", input ]
    try
        let! renamed =
            FSharpRename.renameResult state paths[0] 1 20 "^U" System.Threading.CancellationToken.None
        match renamed with
        | Error message -> failwith $"valid inline generic rename was rejected: {message}"
        | Ok edits ->
            Assert.Equal<string list>(
                [ "Generic.fs:1.20-1.22=>^U"; "Generic.fs:1.32-1.34=>^U" ],
                edits |> List.map editKey |> List.sort)
    finally
        cleanup dir
}

/// [RENAME-ERRORS] A caret generic in a non-inline binding fails FS0670.
[<Fact>]
let ``non-inline generic parameter refuses a caret rename`` () = task {
    let input = source [ "module Generic"; "let identity<'T> (value: 'T) = value" ]
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Generic.fs", input ]
    try
        let! renamed =
            FSharpRename.renameResult state paths[0] 1 13 "^U" System.Threading.CancellationToken.None
        match renamed with
        | Ok edits -> failwith $"invalid non-inline caret rename returned {edits.Length} edits"
        | Error message -> Assert.Contains("Invalid F# rename name", message)
    finally
        cleanup dir
}
