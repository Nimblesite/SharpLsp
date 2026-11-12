/// [RENAME-FSHARP-APPLY] Real project rename with compile order unlike filename order.
module SharpLsp.Sidecar.FSharp.Tests.FSharpRenameFileOrderTests

open System.Threading
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests
open SharpLsp.Sidecar.Common

[<Fact>]
let ``rename from a later F# file preserves project compile order and every use`` () = task {
    let! (state, dir, _fsproj, paths) =
        loadWorkspace
            [ "ZFirst.fs", source [ "module ZFirst"; "let number = 1" ]
              "AMiddle.fs", source [ "module AMiddle"; "let two = ZFirst.number + 1" ]
              "YLast.fs", source [ "module YLast"; "let three = ZFirst.number + AMiddle.two" ] ]
    try
        let sourceOrder =
            state.ProjectOptions.Value.SourceFiles
            |> Array.map NativePaths.NameOf
        Assert.Equal<string array>([| "ZFirst.fs"; "AMiddle.fs"; "YLast.fs" |], sourceOrder)
        let! renamed = FSharpRename.renameResult state paths[2] 1 20 "renamed" CancellationToken.None
        match renamed with
        | Error message -> failwith $"project-wide rename failed: {message}"
        | Ok edits ->
            let actual = edits |> List.map editKey |> List.sort
            Assert.Equal<string list>(
                [ "AMiddle.fs:1.17-1.23=>renamed"
                  "YLast.fs:1.19-1.25=>renamed"
                  "ZFirst.fs:1.4-1.10=>renamed" ],
                actual
            )
    finally
        cleanup dir
}

/// [RENAME-FSHARP-APPLY] A later auto-opened module wins the unqualified name;
/// the earlier same-named declaration must never acquire the reader's edit.
[<Fact>]
let ``rename follows compiler binding when later files shadow an earlier name`` () = task {
    let! (state, dir, _fsproj, paths) =
        loadWorkspace
            [ "ZFirst.fs", source [ "namespace Order"; "[<AutoOpen>]"; "module First ="; "    let value = 1" ]
              "AMiddle.fs", source [ "namespace Order"; "[<AutoOpen>]"; "module Second ="; "    let value = 2" ]
              "YLast.fs", source [ "namespace Order"; "module Uses ="; "    let read = value" ] ]
    try
        let! readerRename = FSharpRename.renameResult state paths[2] 2 16 "renamed" CancellationToken.None
        match readerRename with
        | Error message -> failwith $"reader rename failed: {message}"
        | Ok edits ->
            let actual = edits |> List.map editKey |> List.sort
            Assert.Equal<string list>(
                [ "AMiddle.fs:3.8-3.13=>renamed"; "YLast.fs:2.15-2.20=>renamed" ],
                actual
            )
        let! firstRename = FSharpRename.renameResult state paths[0] 3 9 "oldName" CancellationToken.None
        match firstRename with
        | Error message -> failwith $"first declaration rename failed: {message}"
        | Ok edits -> Assert.Equal<string list>([ "ZFirst.fs:3.8-3.13=>oldName" ], edits |> List.map editKey)
    finally
        cleanup dir
}
