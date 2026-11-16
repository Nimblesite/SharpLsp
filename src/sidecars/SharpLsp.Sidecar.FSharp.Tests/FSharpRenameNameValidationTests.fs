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
    let! (state, dir, _fsproj, paths) = loadWorkspace [ ("Names.fs", input) ]
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
    let! (state, dir, _fsproj, paths) = loadWorkspace [ ("Ops.fs", input) ]
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
    let! (state, dir, _fsproj, paths) = loadWorkspace [ ("Generic.fs", input) ]
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
    let! (state, dir, _fsproj, paths) = loadWorkspace [ ("Generic.fs", input) ]
    try
        let! renamed =
            FSharpRename.renameResult state paths[0] 1 13 "^U" System.Threading.CancellationToken.None
        match renamed with
        | Ok edits -> failwith $"invalid non-inline caret rename returned {edits.Length} edits"
        | Error message -> Assert.Contains("Invalid F# rename name", message)
    finally
        cleanup dir
}

/// [RENAME-ERRORS] A name its module already declares would compile to FS0037: the
/// compiler judges the renamed declaring file, and the rename is refused with its error.
[<Fact>]
let ``rename refuses a name its module already declares, and takes a free one`` () = task {
    let input =
        source
            [ "module Names"
              "let private DOMAIN = \"x\""
              "let private domain () = DOMAIN.Length"
              "let total = domain () + DOMAIN.Length" ]
    let! (state, dir, _fsproj, paths) = loadWorkspace [ ("Names.fs", input) ]
    try
        // Interaction 1 — the colliding name is refused, from the declaration and from a use.
        for (line, character) in [ (1, 12); (3, 24) ] do
            let! collided = FSharpRename.renameResult state paths[0] line character "domain" System.Threading.CancellationToken.None
            match collided with
            | Ok edits -> failwith $"a rename to an existing name returned {edits.Length} edits"
            | Error message ->
                // The compiler's own error is the reason: here the later uses no longer
                // bind to a string (FS0039), in a module that also redeclares the name (FS0037).
                Assert.StartsWith("Invalid F# rename: FS00", message)
        // Interaction 2 — a free name renames the declaration and both uses.
        let! renamed = FSharpRename.renameResult state paths[0] 1 12 "domainSource" System.Threading.CancellationToken.None
        match renamed with
        | Error message -> failwith $"a rename to a free name was refused: {message}"
        | Ok edits ->
            Assert.Equal<string list>(
                [ "Names.fs:1.12-1.18=>domainSource"; "Names.fs:2.24-2.30=>domainSource"; "Names.fs:3.24-3.30=>domainSource" ],
                edits |> List.map editKey |> List.sort)
    finally
        cleanup dir
}

/// [RENAME-ERRORS] The declaring file is the one judged: a rename started from a later
/// file is refused for a collision in the file that declares the name, and a free name
/// renames across both files without the later file's stale view refusing it.
[<Fact>]
let ``rename from a later file is judged in the declaring file`` () = task {
    let declares = source [ "module Shared"; "let width = 4"; "let height = 3" ]
    let uses = source [ "module Area"; "let area = Shared.width * Shared.height" ]
    let! (state, dir, _fsproj, paths) = loadWorkspace [ ("Shared.fs", declares); ("Area.fs", uses) ]
    try
        let! collided = FSharpRename.renameResult state paths[1] 1 18 "height" System.Threading.CancellationToken.None
        match collided with
        | Ok edits -> failwith $"a cross-file rename to an existing name returned {edits.Length} edits"
        | Error message -> Assert.Contains("FS0037", message)
        let! renamed = FSharpRename.renameResult state paths[1] 1 18 "breadth" System.Threading.CancellationToken.None
        match renamed with
        | Error message -> failwith $"a cross-file rename to a free name was refused: {message}"
        | Ok edits ->
            Assert.Equal<string list>(
                [ "Area.fs:1.18-1.23=>breadth"; "Shared.fs:1.4-1.9=>breadth" ],
                edits |> List.map editKey |> List.sort)
    finally
        cleanup dir
}
