/// Rename semantics that only appear on real multi-file F# projects: uses FCS
/// reports without renameable source text, and identifiers that carry their own
/// escaping. Implements [RENAME-FSHARP-PREPARE] / [RENAME-FSHARP-APPLY].
module SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

open FSharp.Compiler.CodeAnalysis
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

/// A string continuation (`\`) strips the leading whitespace of the next line, so
/// indentation-sensitive fixtures must be assembled from explicit lines.
let private source (lines: string list) = String.concat "\n" lines + "\n"

let private RECORD_DECLARATIONS =
    source [ "module Decls"; "type RecordThing = { Field: int }"; "type Alias = RecordThing" ]

let private RECORD_USAGES =
    source
        [ "module Uses"
          "open Decls"
          "let recordValue: RecordThing = { Field = 1 }"
          "let copied = { recordValue with Field = 2 }"
          "let readField = recordValue.Field"
          "let aliasValue: Alias = recordValue" ]

let private ESCAPED_SOURCE =
    source [ "module Escaped"; "let ``renamed value`` v = v + 1"; "let useIt = ``renamed value`` 2" ]

let private INDEXER_SOURCE =
    source
        [ "module Indexed"
          "type IndexerThing() ="
          "    member _.Item with get(index: int) = index" ]

let private INDEXER_USAGES =
    source [ "module IndexedUses"; "open Indexed"; "let indexerValue = IndexerThing().[0]" ]

/// Render an edit so a failed expectation names the exact span that moved.
let private editKey (edit: FSharpCodeActions.RawEdit) =
    let file = System.IO.Path.GetFileName edit.FilePath
    $"{file}:{edit.StartLine}.{edit.StartCharacter}-{edit.EndLine}.{edit.EndCharacter}=>{edit.NewText}"

/// Render a use so a failed expectation names the span FCS reported and whether
/// the lexer could recover an identifier token from it.
let private describeUse (state: FSharpWorkspace.FSharpWorkspaceState) (symbolUse: FSharpSymbolUse) =
    let range: FSharp.Compiler.Text.Range = symbolUse.Range
    let tokenized = FSharpRenameToken.tokenizeSource state.Checker (FSharpWorkspace.readSource state range.FileName)
    let token = FSharpRenameToken.tokenForUse state.Checker tokenized symbolUse
    let file = System.IO.Path.GetFileName range.FileName
    let located = token |> Option.map _.Text |> Option.defaultValue "NO-TOKEN"
    $"{file}:{range.StartLine}.{range.StartColumn}-{range.EndLine}.{range.EndColumn} token={located}"

let private assertEdits expected (state, uses: FSharpSymbolUse array) result =
    let report = uses |> Array.map (describeUse state) |> String.concat "; "
    match result with
    | Error message -> failwith $"rename failed: {message} — uses: {report}"
    | Ok edits ->
        let actual = edits |> List.map editKey |> List.sort
        Assert.Equal<string list>(List.sort expected, actual)

// ── Uses FCS reports without renameable source text ────────────────

/// A record copy-and-update expression `{ value with Field = 1 }` reports a use of
/// the record type at a ZERO-WIDTH range on the `{`. There is no identifier there
/// to rewrite, so it must be skipped — not treated as an unclassifiable use that
/// aborts the whole rename. [RENAME-FSHARP-APPLY]
[<Fact>]
let ``record copy-and-update does not abort renaming the record type`` () = task {
    let! (state, dir, _fsproj, paths) =
        loadWorkspace [ "Decls.fs", RECORD_DECLARATIONS; "Uses.fs", RECORD_USAGES ]
    try
        let! uses = FSharpReferences.getProjectUsages state paths[0] 1 5
        let! renamed = FSharpRename.renameResult state paths[0] 1 5 "RenamedRecord"
        Assert.Equal(4, uses.Length)
        assertEdits
            [ "Decls.fs:1.5-1.16=>RenamedRecord"
              "Decls.fs:2.13-2.24=>RenamedRecord"
              "Uses.fs:2.17-2.28=>RenamedRecord" ]
            (state, uses)
            renamed
    finally
        cleanup dir
}

/// An `x.[i]` call site reports a use of the indexer over the whole expression,
/// which carries no `Item` token. Renaming the declaration must skip that use and
/// keep the call site compiling by writing `DefaultMember` metadata for the new
/// name. [RENAME-FSHARP-APPLY]
[<Fact>]
let ``renaming an indexer rewrites the member and records DefaultMember metadata`` () = task {
    let! (state, dir, _fsproj, paths) =
        loadWorkspace [ "Indexed.fs", INDEXER_SOURCE; "IndexedUses.fs", INDEXER_USAGES ]
    try
        let! uses = FSharpReferences.getProjectUsages state paths[0] 2 14
        let! renamed = FSharpRename.renameResult state paths[0] 2 14 "Lookup"
        Assert.Equal(2, uses.Length)
        assertEdits
            [ "Indexed.fs:2.13-2.17=>Lookup"
              "Indexed.fs:1.0-1.0=>[<System.Reflection.DefaultMemberAttribute(\"Lookup\")>]\n" ]
            (state, uses)
            renamed
    finally
        cleanup dir
}

/// The indexer declaration is renameable: prepare must agree with the rename that
/// follows it rather than offering a rename that then fails. [RENAME-FSHARP-PREPARE]
[<Fact>]
let ``prepare offers the indexer member across its whole token`` () = task {
    let! (state, dir, _fsproj, paths) =
        loadWorkspace [ "Indexed.fs", INDEXER_SOURCE; "IndexedUses.fs", INDEXER_USAGES ]
    try
        for character in [ 13; 14; 15; 16 ] do
            let! prepare = FSharpRename.prepareRename state paths[0] 2 character
            match prepare with
            | None -> failwith $"prepare refused the indexer at column {character}"
            | Some result ->
                Assert.Equal("Item", result.Placeholder)
                Assert.Equal(13, result.StartCharacter)
                Assert.Equal(17, result.EndCharacter)
    finally
        cleanup dir
}

// ── Identifiers that carry their own escaping ──────────────────────

/// FCS reports `DisplayName` for ``an escaped identifier`` with its backticks, and
/// the lexer returns the same escaped text. Prepare must match the two and offer
/// the whole escaped token, backticks included. [RENAME-FSHARP-PREPARE]
[<Fact>]
let ``prepare offers an escaped identifier across its whole token`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Escaped.fs", ESCAPED_SOURCE ]
    try
        for character in [ 4; 5; 6; 12; 19; 20 ] do
            let! prepare = FSharpRename.prepareRename state paths[0] 1 character
            match prepare with
            | None -> failwith $"prepare refused the escaped identifier at column {character}"
            | Some result ->
                Assert.Equal("``renamed value``", result.Placeholder)
                Assert.Equal(4, result.StartCharacter)
                Assert.Equal(21, result.EndCharacter)
    finally
        cleanup dir
}

/// Renaming an escaped identifier replaces the backticks along with the name, so
/// every use stays a single well-formed token. [RENAME-FSHARP-APPLY]
[<Fact>]
let ``renaming an escaped identifier replaces the backticks with it`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Escaped.fs", ESCAPED_SOURCE ]
    try
        let! uses = FSharpReferences.getProjectUsages state paths[0] 1 6
        let! renamed = FSharpRename.renameResult state paths[0] 1 6 "``other value``"
        Assert.Equal(2, uses.Length)
        assertEdits
            [ "Escaped.fs:1.4-1.21=>``other value``"; "Escaped.fs:2.12-2.29=>``other value``" ]
            (state, uses)
            renamed
    finally
        cleanup dir
}
