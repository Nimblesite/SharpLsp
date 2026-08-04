/// Coverage for F# document symbols and signature help — ALL real, NO mocks.
/// Drives FSharpSymbols (parse-only navigation items) and FSharpSignature
/// (FCS GetMethods) against a real loaded workspace plus pure-helper branches.
module SharpLsp.Sidecar.FSharp.Tests.FSharpSymbolsTests

open System.IO
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

// A real loaded workspace, built once from a real temp .fsproj.
let private loaded =
    lazy
        (let dir = createTestProject ()
         let ws = FSharpWorkspace.create ()
         (FSharpWorkspace.loadProject ws dir).GetAwaiter().GetResult() |> ignore
         (ws, Path.Combine(dir, "Library.fs")))

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
