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
let internal source (lines: string list) = String.concat "\n" lines + "\n"

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

let private ALIAS_SOURCE =
    source
        [ "module Aliases"
          "module Deep ="
          "    module Nested ="
          "        let value = 1"
          ""
          "module Short = Deep.Nested"
          "let viaAlias = Short.value"
          "let viaFull = Deep.Nested.value" ]

/// The decoy type comes first so the parse-tree search has to reject a
/// non-matching type definition before it reaches the indexer's own.
let private DEFAULT_MEMBER_SOURCE =
    source
        [ "module Explicit"
          "type Decoy() ="
          "    member _.Plain = 1"
          "[<System.Reflection.DefaultMember(\"Chars\")>]"
          "type Holder() ="
          "    member _.Chars with get(index: int) = index"
          "let ch = Holder().[0]" ]

/// An indexed property that is neither named `Item` nor carries DefaultMember
/// metadata cannot be renamed without breaking its call sites.
let private UNMARKED_INDEXER_SOURCE =
    source
        [ "module Unmarked"
          "type Holder() ="
          "    member _.Lookup with get(index: int) = index" ]

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

let private recordProject () =
    loadWorkspace [ "Decls.fs", RECORD_DECLARATIONS; "Uses.fs", RECORD_USAGES ]

// ── Uses FCS reports without renameable source text ────────────────

/// A record copy-and-update expression `{ value with Field = 1 }` reports a use of
/// the record type at a ZERO-WIDTH range on the `{`. There is no identifier there
/// to rewrite, so it must be skipped — not treated as an unclassifiable use that
/// aborts the whole rename. [RENAME-FSHARP-APPLY]
[<Fact>]
let ``record copy-and-update does not abort renaming the record type`` () = task {
    let! (state, dir, _fsproj, paths) = recordProject ()
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

/// An `x.[i]` call site has no `Item` token, so prepare and rename must resolve
/// the indexer from the parse tree at the `.[` marker and at the closing bracket.
/// Renaming from the call site must produce the same edits as renaming from the
/// declaration. [RENAME-FSHARP-PREPARE] [RENAME-FSHARP-APPLY]
[<Fact>]
let ``prepare and rename resolve an indexer from its call site`` () = task {
    let! (state, dir, _fsproj, paths) =
        loadWorkspace [ "Indexed.fs", INDEXER_SOURCE; "IndexedUses.fs", INDEXER_USAGES ]
    try
        for character in [ 33; 34; 36 ] do
            let! prepare = FSharpRename.prepareRename state paths[1] 2 character
            match prepare with
            | None -> failwith $"prepare refused the indexer call site at column {character}"
            | Some result -> Assert.Equal("Item", result.Placeholder)
        let! renamed = FSharpRename.renameResult state paths[1] 2 34 "Lookup"
        assertEdits
            [ "Indexed.fs:2.13-2.17=>Lookup"
              "Indexed.fs:1.0-1.0=>[<System.Reflection.DefaultMemberAttribute(\"Lookup\")>]\n" ]
            (state, [||])
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

// ── Rename driven by another sidecar ───────────────────────────────

/// A cross-language rename arrives as a compiler identity — assembly name plus
/// XML doc signature — because the declaration lives in the other sidecar's
/// language and has no position in any F# file. Resolving that identity must
/// reach the same uses a positional rename does, or a C# rename would silently
/// leave the F# side stale. [SHARPLSP-FEATURES-REFACTORING]
[<Fact>]
let ``renaming by compiler identity reaches the same uses as a positional rename`` () = task {
    let! (state, dir, _fsproj, paths) = recordProject ()
    try
        let! identity = FSharpRename.getRenameIdentity state paths[0] 1 5
        match identity with
        | None -> failwith "the record type carried no cross-language identity"
        | Some target ->
            let! edits =
                FSharpRename.renameForeign state target.AssemblyName target.XmlDocSig "RenamedRecord"
            let actual = edits |> List.map editKey |> List.sort
            Assert.Equal<string list>(
                List.sort
                    [ "Decls.fs:1.5-1.16=>RenamedRecord"
                      "Decls.fs:2.13-2.24=>RenamedRecord"
                      "Uses.fs:2.17-2.28=>RenamedRecord" ],
                actual
            )
    finally
        cleanup dir
}

/// A blank identity is a malformed request from the other sidecar, not a rename
/// of everything: it must produce no edits at all.
[<Fact>]
let ``renaming by an empty compiler identity produces no edits`` () = task {
    let! (state, dir, _fsproj, paths) = recordProject ()
    try
        Assert.NotEmpty(paths)
        let! edits = FSharpRename.renameForeign state "" "" "RenamedRecord"
        Assert.Empty(edits)
    finally
        cleanup dir
}

// ── Module abbreviations ───────────────────────────────────────────

/// A module abbreviation is not a compiler symbol with uses of its own, so rename
/// resolves it from the syntax tree. Renaming the abbreviation must rewrite its
/// declaration and every qualified use of it. [RENAME-FSHARP-APPLY]
[<Fact>]
let ``renaming a module abbreviation rewrites its declaration and its uses`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Aliases.fs", ALIAS_SOURCE ]
    try
        let! renamed = FSharpRename.renameResult state paths[0] 5 8 "Brief"
        assertEdits
            [ "Aliases.fs:5.7-5.12=>Brief"; "Aliases.fs:6.15-6.20=>Brief" ]
            (state, [||])
            renamed
    finally
        cleanup dir
}

/// Renaming the module an abbreviation points at must rewrite the real module and
/// the abbreviation's right-hand side, but never a use qualified by the
/// abbreviation — `Short.value` still resolves after the target is renamed.
[<Fact>]
let ``renaming an abbreviated module leaves uses qualified by the abbreviation alone`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Aliases.fs", ALIAS_SOURCE ]
    try
        let! uses = FSharpReferences.getProjectUsages state paths[0] 2 12
        let! renamed = FSharpRename.renameResult state paths[0] 2 12 "Inner"
        assertEdits
            [ "Aliases.fs:2.11-2.17=>Inner"
              "Aliases.fs:5.20-5.26=>Inner"
              "Aliases.fs:7.19-7.25=>Inner" ]
            (state, uses)
            renamed
    finally
        cleanup dir
}

/// Prepare must offer the abbreviation itself, not the module it stands for.
[<Fact>]
let ``prepare offers a module abbreviation under its own name`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Aliases.fs", ALIAS_SOURCE ]
    try
        let! prepare = FSharpRename.prepareRename state paths[0] 5 8
        match prepare with
        | None -> failwith "prepare refused the module abbreviation"
        | Some result ->
            Assert.Equal("Short", result.Placeholder)
            Assert.Equal(7, result.StartCharacter)
            Assert.Equal(12, result.EndCharacter)
    finally
        cleanup dir
}

/// An indexer that already carries DefaultMember metadata must have that literal
/// rewritten in place rather than gaining a second attribute. [RENAME-FSHARP-APPLY]
[<Fact>]
let ``renaming an indexer rewrites existing DefaultMember metadata in place`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Explicit.fs", DEFAULT_MEMBER_SOURCE ]
    try
        let! renamed = FSharpRename.renameResult state paths[0] 5 14 "Slot"
        assertEdits
            [ "Explicit.fs:3.34-3.41=>\"Slot\""; "Explicit.fs:5.13-5.18=>Slot" ]
            (state, [||])
            renamed
    finally
        cleanup dir
}

/// Renaming an indexer to an escaped identifier must write the *logical* name
/// into the DefaultMember literal — backticks are source syntax, not part of the
/// member's name, and `[<DefaultMember("``My Slot``")>]` would not bind.
[<Fact>]
let ``renaming an indexer to an escaped name stores the logical name in metadata`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Explicit.fs", DEFAULT_MEMBER_SOURCE ]
    try
        let! renamed = FSharpRename.renameResult state paths[0] 5 14 "``My Slot``"
        assertEdits
            [ "Explicit.fs:3.34-3.41=>\"My Slot\""
              "Explicit.fs:5.13-5.18=>``My Slot``" ]
            (state, [||])
            renamed
    finally
        cleanup dir
}

/// An indexed property that is neither named `Item` nor carries DefaultMember
/// metadata has no way to keep `x.[i]` binding after a rename, so the request
/// must fail loudly instead of silently producing a half-rename.
[<Fact>]
let ``renaming an indexer with no DefaultMember metadata is refused`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Unmarked.fs", UNMARKED_INDEXER_SOURCE ]
    try
        let! renamed = FSharpRename.renameResult state paths[0] 2 15 "Fetch"
        match renamed with
        | Ok edits -> failwith $"expected a refusal, got {edits.Length} edits"
        | Error message -> Assert.Contains("DefaultMember", message)
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

// ── Compiler identity for fields and union cases ───────────────────

let private IDENTITY_SOURCE =
    source [ "module Ident"; "type Rec = { Field: int }"; "type Union = | Case of int" ]

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
        let! renamed = FSharpRename.renameResult state paths[0] 3 14 "Slot"
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
        let! renamed = FSharpRename.renameResult state paths[0] 5 14 "Slot"
        match renamed with
        | Ok edits -> failwith $"expected a refusal, got {edits.Length} edits"
        | Error message -> Assert.Contains("literal", message)
    finally
        cleanup dir
}
