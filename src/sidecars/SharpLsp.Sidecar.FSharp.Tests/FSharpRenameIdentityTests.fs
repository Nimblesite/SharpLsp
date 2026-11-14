/// Rename identity, union cases, and indexer metadata over real F# projects.
module SharpLsp.Sidecar.FSharp.Tests.FSharpRenameIdentityTests

open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

// ── Compiler identity for fields and union cases ───────────────────

let private IDENTITY_SOURCE =
    source [ "module Ident"; "type Rec = { Field: int }"; "type Union = | Case of int" ]

/// [RENAME-ERRORS] An ordinary union case must retain an uppercase first letter.
[<Fact>]
let ``rename refuses a lowercase ordinary union case`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Ident.fs", IDENTITY_SOURCE ]
    try
        let! renamed =
            FSharpRename.renameResult state paths[0] 2 16 "value" System.Threading.CancellationToken.None
        match renamed with
        | Ok edits -> failwith $"lowercase union-case rename returned {edits |> List.map editKey}"
        | Error message -> Assert.Contains("Invalid F# rename name", message)
    finally
        cleanup dir
}

/// [RENAME-FSHARP-APPLY] Qualified union cases may use lowercase names.
[<Fact>]
let ``rename accepts a lowercase qualified union case`` () = task {
    let input =
        source
            [ "module Qualified"
              "[<RequireQualifiedAccess>]"
              "type Union = | Case of int"
              "let value = Union.Case 1" ]
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Qualified.fs", input ]
    try
        let! renamed =
            FSharpRename.renameResult state paths[0] 2 16 "value" System.Threading.CancellationToken.None
        match renamed with
        | Error message -> failwith $"qualified union-case rename failed: {message}"
        | Ok edits ->
            let actual = edits |> List.map editKey |> List.sort
            Assert.Equal<string list>([ "Qualified.fs:2.15-2.19=>value"; "Qualified.fs:3.18-3.22=>value" ], actual)
    finally
        cleanup dir
}

/// [RENAME-ERRORS] Exception labels must begin with an uppercase letter.
[<Fact>]
let ``rename refuses a lowercase exception label`` () = task {
    let input = source [ "module Exceptions"; "exception Failure of int"; "let useIt = Failure 1" ]
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Exceptions.fs", input ]
    try
        let! renamed =
            FSharpRename.renameResult state paths[0] 1 10 "failure" System.Threading.CancellationToken.None
        match renamed with
        | Ok edits -> failwith $"lowercase exception rename returned {edits |> List.map editKey}"
        | Error message -> Assert.Contains("Invalid F# rename name", message)
    finally
        cleanup dir
}

let private RW_INDEXER_SOURCE =
    source
        [ "module RW"
          "type Holder() ="
          "    let mutable store = 0"
          "    member _.Item"
          "        with get(i: int) = store + i"
          "        and set (i: int) (v: int) = store <- v + i" ]

/// A cross-language rename identifies its target by XML doc signature. Record
/// fields and union cases carry their own signature kind, so both must resolve —
/// otherwise a C# rename of either silently skips the F# side.
[<Fact>]
let ``record fields and union cases expose a cross-language identity`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Ident.fs", IDENTITY_SOURCE ]
    try
        let! field = FSharpRename.getRenameIdentity state paths[0] 1 14
        match field with
        | None -> failwith "record field carried no cross-language identity"
        | Some target -> Assert.Contains("Field", target.XmlDocSig)
        let! case = FSharpRename.getRenameIdentity state paths[0] 2 16
        match case with
        | None -> failwith "union case carried no cross-language identity"
        | Some target -> Assert.Contains("Case", target.XmlDocSig)
    finally
        cleanup dir
}

/// A read/write indexer reaches its property through the setter as well as the
/// getter. Renaming one must still rewrite the member and record the metadata.
[<Fact>]
let ``a read-write indexer renames through either accessor`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "RW.fs", RW_INDEXER_SOURCE ]
    try
        let! renamed = FSharpRename.renameResult state paths[0] 3 14 "Slot" System.Threading.CancellationToken.None
        match renamed with
        | Error message -> failwith $"read/write indexer rename failed: {message}"
        | Ok edits ->
            let text = edits |> List.map editKey |> String.concat " | "
            Assert.Contains("RW.fs:3.13-3.17=>Slot", text)
            Assert.Contains("DefaultMemberAttribute", text)
    finally
        cleanup dir
}

/// DefaultMember metadata whose name comes from a literal constant rather than an
/// inline string cannot be rewritten in place — editing the attribute would mean
/// editing the constant, which may be shared. The rename must refuse instead of
/// silently leaving the metadata pointing at the old name.
let private LITERAL_CONST_SOURCE =
    source
        [ "module LiteralConst"
          "[<Literal>]"
          "let MemberName = \"Chars\""
          "[<System.Reflection.DefaultMember(MemberName)>]"
          "type Holder() ="
          "    member _.Chars with get(index: int) = index" ]

[<Fact>]
let ``renaming an indexer named by a literal constant is refused`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "LiteralConst.fs", LITERAL_CONST_SOURCE ]
    try
        let! renamed = FSharpRename.renameResult state paths[0] 5 14 "Slot" System.Threading.CancellationToken.None
        match renamed with
        | Ok edits -> failwith $"expected a refusal, got {edits.Length} edits"
        | Error message -> Assert.Contains("literal", message)
    finally
        cleanup dir
}
