/// Coverage for F# document symbols and signature help — ALL real, NO mocks.
/// Drives FSharpSymbols (parse-only navigation items) and FSharpSignature
/// (FCS GetMethods) against a real loaded workspace plus pure-helper branches.
module SharpLsp.Sidecar.FSharp.Tests.FSharpSymbolsTests

open System.IO
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests
open SharpLsp.Sidecar.Common

// A real loaded workspace, built once from a real temp .fsproj.
let private loaded =
    lazy
        (let dir = createTestProject ()
         let ws = FSharpWorkspace.create ()
         (FSharpWorkspace.loadProject ws dir).GetAwaiter().GetResult() |> ignore
         (ws, NativePaths.Resolve(dir, "Library.fs")))

let private missing = "/sharplsp/definitely/not/a/real/file.fs"

/// Flatten a symbol tree to the set of all names (top-level + nested).
let private symbolNames (items: FSharpSymbols.SymbolItem list) : string list =
    let rec walk acc (xs: FSharpSymbols.SymbolItem list) =
        xs |> List.fold (fun a (x: FSharpSymbols.SymbolItem) -> walk (x.Name :: a) x.Children) acc
    walk [] items

// ── Document symbols ─────────────────────────────────────────────

[<Fact>]
let ``documentSymbols returns top-level types and nested members`` () =
    task {
        let (ws, src) = loaded.Value
        let! symbols = FSharpSymbols.documentSymbols ws src
        Assert.NotEmpty(symbols)
        let names = symbolNames symbols
        // Top-level declarations spanning record, function, interface and class.
        Assert.Contains("Person", names)
        Assert.Contains("add", names)
        Assert.Contains("IGreeter", names)
        Assert.Contains("SimpleGreeter", names)
        Assert.Contains("Counter", names)
        // A nested member (Counter.Value) proves children are populated.
        Assert.Contains("Value", names)
    }

/// A namespace of doc-commented declarations, the shape of the tutorial's fixture.
let private documented =
    String.concat
        "\n"
        [ "namespace Documented"
          ""
          "/// A geometric shape."
          "type Shape ="
          "    | Circle of radius: float"
          ""
          "/// Shapes and what they cover."
          "module Geometry ="
          "    /// The area of a shape."
          "    let area (Circle r) = r * r"
          "" ]

/// Every symbol in a tree, top level and nested.
let rec private allSymbols (items: FSharpSymbols.SymbolItem list) =
    items |> List.collect (fun item -> item :: allSymbols item.Children)

/// The text a symbol's selectionRange covers in `lines`.
let private selected (lines: string[]) (item: FSharpSymbols.SymbolItem) =
    Assert.Equal(item.SelStartLine, item.SelEndLine)
    lines[item.SelStartLine].Substring(item.SelStartCharacter, item.SelEndCharacter - item.SelStartCharacter)

/// LSP 3.17: selectionRange is "the range that should be selected and revealed when
/// this symbol is being picked, e.g. the name of a function". A doc comment is not
/// the name: an editor that reveals it, or hovers there, lands on `///`. [FS-DOCSYMBOL]
[<Fact>]
let ``documentSymbols selects each declaration's name, never its doc comment`` () =
    task {
        let file = NativePaths.Temp($"sharplsp-docsym-{System.Guid.NewGuid():N}.fs")
        File.WriteAllText(file, documented)

        try
            let! symbols = FSharpSymbols.documentSymbols (FSharpWorkspace.create ()) file
            let lines = documented.Split('\n')
            let byName name = allSymbols symbols |> List.find (fun item -> item.Name = name)

            Assert.Equal("Shape", selected lines (byName "Shape"))
            Assert.Equal((3, 5), ((byName "Shape").SelStartLine, (byName "Shape").SelStartCharacter))
            Assert.Equal("Geometry", selected lines (byName "Geometry"))
            Assert.Equal("area", selected lines (byName "area"))
            // The outer range still spans the declaration, so it contains the selection.
            Assert.True((byName "Shape").StartLine <= 3 && (byName "Shape").EndLine >= 4)
        finally
            File.Delete file
    }

[<Fact>]
let ``documentSymbols on a missing file returns empty`` () =
    task {
        let (ws, _) = loaded.Value
        let! symbols = FSharpSymbols.documentSymbols ws missing
        Assert.Empty(symbols)
    }

[<Fact>]
let ``documentSymbols parses without a loaded project`` () =
    task {
        let (_, src) = loaded.Value
        // Fresh workspace: ProjectOptions = None drives the Default-parsing-options arm.
        let fresh = FSharpWorkspace.create ()
        let! symbols = FSharpSymbols.documentSymbols fresh src
        Assert.NotEmpty(symbols)
    }

// ── Signature help ───────────────────────────────────────────────

[<Fact>]
let ``signatureHelp resolves a constructor call`` () =
    task {
        let (ws, src) = loaded.Value
        let lines = File.ReadAllText(src).Replace("\r\n", "\n").Split('\n')
        let lineIdx = lines |> Array.findIndex (fun l -> l.Contains "Counter(0)")
        let col = lines[lineIdx].IndexOf("Counter(") + "Counter(".Length
        let! help = FSharpSignature.signatureHelp ws src lineIdx col
        Assert.True(help.IsSome)
        Assert.NotEmpty((help.Value).Signatures)
    }

[<Fact>]
let ``signatureHelp on a missing file returns None`` () =
    task {
        let (ws, _) = loaded.Value
        let! help = FSharpSignature.signatureHelp ws missing 0 0
        Assert.True(help.IsNone)
    }

[<Fact>]
let ``signatureHelp outside any call returns None`` () =
    task {
        let (ws, src) = loaded.Value
        // Line 0 col 0 is the `module` header — no enclosing call.
        let! help = FSharpSignature.signatureHelp ws src 0 0
        Assert.True(help.IsNone)
    }

// ── nameBeforeParen (pure parsing) ───────────────────────────────

[<Fact>]
let ``nameBeforeParen extracts simple and qualified names`` () =
    Assert.Equal(Some(7, [ "Counter" ]), FSharpSignature.nameBeforeParen "Counter(0)" 8)
    Assert.Equal(Some(10, [ "A"; "B"; "create" ]), FSharpSignature.nameBeforeParen "A.B.create(1)" 11)

[<Fact>]
let ``nameBeforeParen returns None without a usable call`` () =
    Assert.Equal(None, FSharpSignature.nameBeforeParen "no parens" 5)
    Assert.Equal(None, FSharpSignature.nameBeforeParen "" 0)
    Assert.Equal(None, FSharpSignature.nameBeforeParen "()" 1)

[<Fact>]
let ``nameBeforeParen skips balanced inner parens`` () =
    // Caret after the comma must resolve the OUTER call `f`, skipping `g(x)`.
    match FSharpSignature.nameBeforeParen "f(g(x), y)" 8 with
    | Some(_, names) -> Assert.Equal<string list>([ "f" ], names)
    | None -> Assert.Fail("expected the outer call name")
