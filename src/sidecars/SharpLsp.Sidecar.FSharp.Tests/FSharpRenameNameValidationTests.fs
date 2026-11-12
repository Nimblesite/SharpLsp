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
