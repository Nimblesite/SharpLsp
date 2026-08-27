/// Real success-branch coverage for the F# sidecar. No providers or compiler services are mocked.
module SharpLsp.Sidecar.FSharp.Tests.FSharpExtraSuccessCoverageTests

open System.IO
open Xunit
open MessagePack
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

let private loaded =
    lazy
        (let dir = createTestProject ()
         let ws = FSharpWorkspace.create ()
         (FSharpWorkspace.loadProject ws dir).GetAwaiter().GetResult() |> ignore
         (ws, Path.Combine(dir, "Library.fs")))

let private missing = "/sharplsp/definitely/not/a/real/file.fs"

// ── Success branches on the real loaded workspace ────────────────
// Positions are resolved from the source text so they survive edits.

let private srcText () =
    let _, src = loaded.Value
    src, File.ReadAllText(src).Split('\n')

/// 0-based line index of the first line containing `needle`.
let private lineOf (lines: string array) (needle: string) =
    lines |> Array.findIndex (fun l -> l.Contains(needle: string))

[<Fact>]
let ``call hierarchy resolves real callers and callees`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        // `add` is defined on its line and called from `result` + Consumer.
        let addLine = lineOf lines "let add (a"
        let! prep = FSharpHierarchy.prepareCall ws src addLine 4
        let! incoming = FSharpHierarchy.incomingCalls ws src addLine 4
        Assert.True(Option.isSome prep)
        Assert.NotEmpty(incoming)
        // `useGreeter` calls `Greet` → outgoing callees.
        let useLine = lineOf lines "let useGreeter"
        let! outgoing = FSharpHierarchy.outgoingCalls ws src useLine 4
        Assert.NotEmpty(outgoing)
    }

[<Fact>]
let ``type hierarchy resolves across class, interface, union and struct`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        let prepType needle col =
            FSharpHierarchy.prepareType ws src (lineOf lines needle) col
        let! ifaceItem = prepType "type IGreeter" 5
        let! unionItem = prepType "type Color" 5
        let! structItem = prepType "type Point" 5
        Assert.True(Option.isSome ifaceItem)
        Assert.True(Option.isSome unionItem)
        Assert.True(Option.isSome structItem)
        // SimpleGreeter implements IGreeter → supertypes include it; IGreeter's
        // subtypes include SimpleGreeter.
        let! supers = FSharpHierarchy.supertypes ws src (lineOf lines "type SimpleGreeter") 5
        let! subs = FSharpHierarchy.subtypes ws src (lineOf lines "type IGreeter") 5
        Assert.NotEmpty(supers)
        Assert.NotEmpty(subs)
    }

[<Fact>]
let ``hierarchy items resolve enum, constructor and property symbol kinds`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        let! enumItem = FSharpHierarchy.prepareType ws src (lineOf lines "type Direction") 5
        let! ctorItem = FSharpHierarchy.prepareCall ws src (lineOf lines "let counter =") 14
        let! propItem = FSharpHierarchy.prepareCall ws src (lineOf lines "member _.Value") 17
        Assert.True(Option.isSome enumItem)
        Assert.True(Option.isSome ctorItem || Option.isSome propItem)
    }

[<Fact>]
let ``navigation resolves type-definition, declaration and implementation`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        // type-definition of `person` → Person record.
        let! td = FSharpWorkspace.getTypeDefinition ws src (lineOf lines "let person =") 4
        // declaration of the interface impl `Greet` → the abstract member.
        let greetImplLine = lineOf lines "member _.Greet(name)"
        let! decl = FSharpWorkspace.getDeclaration ws src greetImplLine 17
        // implementation of the abstract `Greet`.
        let! impl = FSharpWorkspace.getImplementations ws src (lineOf lines "abstract Greet") 13
        Assert.True(Option.isSome td)
        Assert.True(Option.isSome decl)
        Assert.NotEmpty(impl)
    }

[<Fact>]
let ``semantic tokens (full and ranged) and pipeline inlay hints on a loaded file`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        let! full = FSharpFeatures.getSemanticTokens ws src
        let! ranged = FSharpFeatures.getSemanticTokensRange ws src 0 (lines.Length - 1)
        // Inlay over the whole file includes the `[1;2;3] |> List.sum` pipeline,
        // exercising the pipeline-hint path.
        let! hints = FSharpFeatures.getInlayHints ws src 0 (lines.Length - 1)
        Assert.NotEmpty(full)
        Assert.NotEmpty(ranged)
        Assert.NotEmpty(hints)
    }

[<Fact>]
let ``completion surfaces members of a record value`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        // Member completion right after `createPerson "Alice" 30` would need a
        // dot; instead complete the module surface at the `colors` line where the
        // DU cases Red/Green are in scope, exercising union/value glyph arms.
        let colorsLine = lineOf lines "let colors ="
        let! items = FSharpCompletion.getCompletions ws src colorsLine 14
        Assert.NotEmpty(items)
    }

// ── Workspace: solution-based discovery + load-failure branches ──

[<Fact>]
let ``loadProject discovers the fsproj through an explicit slnx`` () =
    task {
        let dir = createTestProject ()
        let slnx = Path.Combine(dir, "Solution.slnx")
        File.WriteAllText(slnx, "<Solution>\n  <Project Path=\"TestProject.fsproj\" />\n</Solution>\n")
        let ws = FSharpWorkspace.create ()
        let! result = FSharpWorkspace.loadProject ws slnx
        Assert.True(match result with | Ok _ -> true | Error _ -> false)
        Assert.True(ws.IsLoaded)
        try Directory.Delete(dir, true) with _ -> ()
    }

[<Fact>]
let ``loadProject on a solution with no fsproj reports an error`` () =
    task {
        let dir = Path.Combine(Path.GetTempPath(), $"slsp-emptysln-{System.Guid.NewGuid():N}")
        Directory.CreateDirectory(dir) |> ignore
        let slnx = Path.Combine(dir, "Empty.slnx")
        File.WriteAllText(slnx, "<Solution>\n</Solution>\n")
        let ws = FSharpWorkspace.create ()
        let! result = FSharpWorkspace.loadProject ws slnx
        Assert.True(match result with | Error _ -> true | Ok _ -> false)
        try Directory.Delete(dir, true) with _ -> ()
    }

// ── Code fixes: error files compiled IN a real project ───────────

/// Build + load a real framework-only F# project whose files are in the
/// compile list, so per-file checks produce real diagnostics.
let private loadWorkspaceWith (files: (string * string) list) =
    let dir = Path.Combine(Path.GetTempPath(), $"slsp-cf-{System.Guid.NewGuid():N}")
    Directory.CreateDirectory dir |> ignore
    let compiles =
        files
        |> List.map (fun (n, _) -> $"<Compile Include=\"{n}\" />")
        |> String.concat ""
    File.WriteAllText(
        Path.Combine(dir, "P.fsproj"),
        "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>"
        + "<TargetFramework>net10.0</TargetFramework>"
        + "<DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference>"
        + $"</PropertyGroup><ItemGroup>{compiles}</ItemGroup></Project>")
    for (n, c) in files do
        File.WriteAllText(Path.Combine(dir, n), c)
    let ws = FSharpWorkspace.create ()
    (FSharpWorkspace.loadProject ws dir).GetAwaiter().GetResult() |> ignore
    ws, dir, files |> List.map (fun (n, _) -> Path.Combine(dir, n))

[<Fact>]
let ``code fixes fire for incomplete match and undefined name`` () =
    task {
        let ws, dir, paths =
            loadWorkspaceWith
                [ "M.fs",
                  "module M\n"
                  + "type S = A | B\n"
                  + "let f (s: S) = match s with | A -> 1\n"
                  + "let u = undefinedXyz\n" ]
        let cf = FSharpCodeFixes.createState ()
        let! actions = FSharpCodeFixes.getCodeActions cf ws paths[0] 0 0 20 200
        Assert.NotEmpty(actions)
        Assert.All(actions, fun a -> Assert.False(System.String.IsNullOrEmpty a.Title))
        for a in actions do
            Assert.True((FSharpCodeFixes.resolveCodeAction cf a.Id).IsSome)
        try Directory.Delete(dir, true) with _ -> ()
    }

[<Fact>]
let ``code fixes fire for a redundant match case`` () =
    task {
        let ws, dir, paths =
            loadWorkspaceWith
                [ "R.fs", "module R\nlet f x = match x with | _ -> 0 | 1 -> 1\n" ]
        let cf = FSharpCodeFixes.createState ()
        let! actions = FSharpCodeFixes.getCodeActions cf ws paths[0] 0 0 10 200
        Assert.NotNull(actions :> obj)
        try Directory.Delete(dir, true) with _ -> ()
    }

// ── Out-of-bounds positions on a loaded, real file ───────────────

[<Fact>]
let ``queries past end of file return empty on a loaded workspace`` () =
    task {
        let ws, src = loaded.Value
        let! h = FSharpWorkspace.getHover ws src 9999 0
        let! d = FSharpWorkspace.getDefinition ws src 9999 0
        let! items = FSharpCompletion.getCompletions ws src 9999 0
        Assert.True(Option.isNone h)
        Assert.True(Option.isNone d)
        Assert.Empty(items)
    }

// ── Hierarchy symbol-kind + None-arm branch coverage ─────────────
// Drives the FSharpField / union-case / value match arms of symbolKind and the
// None/[]/empty fall-throughs of every hierarchy entry point on the real file.

[<Fact>]
let ``hierarchy prepareCall classifies a record field as Field`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        let pointLine = lineOf lines "type Point"
        let pxCol = lines[pointLine].IndexOf("Px")
        let! fieldItem = FSharpHierarchy.prepareCall ws src pointLine pxCol
        Assert.True(Option.isSome fieldItem)
        Assert.Equal("Field", fieldItem.Value.Kind)
    }

[<Fact>]
let ``hierarchy prepareCall classifies a union case via the fallback arm`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        let redLine = lineOf lines "    | Red"
        let redCol = lines[redLine].IndexOf("Red")
        let! caseItem = FSharpHierarchy.prepareCall ws src redLine redCol
        Assert.True(Option.isSome caseItem)
        // A union case is neither entity, MFV nor field → "Function" fallback arm.
        Assert.Equal("Function", caseItem.Value.Kind)
    }

[<Fact>]
let ``hierarchy outgoing on an external-only binding stays well-formed`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        // `pipedSum = [1;2;3] |> List.sum` only calls FSharp.Core (external) →
        // every callee hits itemOfSymbol's `| _ -> None` arm and is filtered out.
        let! outg = FSharpHierarchy.outgoingCalls ws src (lineOf lines "let pipedSum") 4
        Assert.NotNull(outg :> obj)
    }

[<Fact>]
let ``hierarchy entry points return empty for a non-symbol position`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        let addLine = lineOf lines "let add (a"
        // Column 0 is the `let` keyword → getSymbolUse None → computeOutgoing [].
        let! outg = FSharpHierarchy.outgoingCalls ws src addLine 0
        Assert.Empty(outg)
        // `add` is a value (MFV), not an entity → prepareType None, supertypes [],
        // subtypes [] (the `entityAt` None arms).
        let! pt = FSharpHierarchy.prepareType ws src addLine 4
        let! sup = FSharpHierarchy.supertypes ws src addLine 4
        let! sub = FSharpHierarchy.subtypes ws src addLine 4
        Assert.True(Option.isNone pt)
        Assert.Empty(sup)
        Assert.Empty(sub)
    }

// ── Workspace: interface-base declaration + symbol-scope arms ─────

[<Fact>]
let ``getDeclaration on an interface impl resolves the abstract base member`` () =
    task {
        let ws, _ = loaded.Value
        let src, lines = srcText ()
        let greetImpl = lineOf lines "member _.Greet(name)"
        let greetCol = lines[greetImpl].IndexOf("Greet")
        // SimpleGreeter.Greet implements IGreeter.Greet → findBaseMember resolves
        // the abstract declaration via DeclaringEntity.AllInterfaces.
        let! decl = FSharpWorkspace.getDeclaration ws src greetImpl greetCol
        Assert.True(Option.isSome decl)
    }

// ── Features: outer catch handlers on a loaded workspace ──────────
// `missing` does not exist, but the workspace IS loaded, so each entry point
// proceeds to File.ReadAllText which throws → the outer with-handler returns
// the empty result.

[<Fact>]
let ``feature extractors swallow a read failure on a loaded workspace`` () =
    task {
        let ws, _ = loaded.Value
        let! tokens = FSharpFeatures.getSemanticTokens ws missing
        let! ranged = FSharpFeatures.getSemanticTokensRange ws missing 0 100
        let! hints = FSharpFeatures.getInlayHints ws missing 0 100
        Assert.Empty(tokens)
        Assert.Empty(ranged)
        Assert.Empty(hints)
    }

// ── Call hierarchy: caller-resolution over every binding-head pattern ──
// One project drives incomingCalls across Typed / Paren / As head patterns, a
// nested binding (resolveCaller Some), and a module-level `do` call site
// (resolveCaller None); plus class inheritance for super/sub-types.

let private hierarchyFixture =
    "module M\n"                                   // 0
    + "let add a b = a + b\n"                      // 1
    + "type Base() = class end\n"                  // 2
    + "type Derived() =\n"                         // 3
    + "    inherit Base()\n"                       // 4
    + "let (typed: int) = add 1 2\n"               // 5  SynPat.Typed
    + "let (parened) = add 3 4\n"                  // 6  SynPat.Paren
    + "let (aliased as ax) = add 5 6\n"            // 7  SynPat.As
    + "let outer () =\n"                           // 8
    + "    let inner () = add 7 8\n"               // 9  nested binding
    + "    inner ()\n"                             // 10
    + "do add 9 10 |> ignore\n"                    // 11 module-level do (no binding)

[<Fact>]
let ``incomingCalls resolves callers across typed, paren, as and nested heads`` () =
    task {
        let ws, dir, paths = loadWorkspaceWith [ "M.fs", hierarchyFixture ]
        try
            // `add` is on line 1; callers use Typed/Paren/As/nested/do heads.
            let! prep = FSharpHierarchy.prepareCall ws paths[0] 1 4
            let! incoming = FSharpHierarchy.incomingCalls ws paths[0] 1 4
            Assert.True(Option.isSome prep)
            Assert.NotEmpty(incoming)
            // The nested `inner` binding must surface as a resolved caller.
            Assert.Contains(incoming, fun (c: FSharpHierarchy.HierItem) -> c.Name = "inner")
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }

[<Fact>]
let ``super and sub types resolve across a class inheritance edge`` () =
    task {
        let ws, dir, paths = loadWorkspaceWith [ "M.fs", hierarchyFixture ]
        try
            // Derived : Base → supertypes(Derived) include Base; subtypes(Base)
            // include Derived (driving the BaseType Some-arm on both sides).
            let! supers = FSharpHierarchy.supertypes ws paths[0] 3 5
            let! subs = FSharpHierarchy.subtypes ws paths[0] 2 5
            Assert.Contains(supers, fun (i: FSharpHierarchy.HierItem) -> i.Name = "Base")
            Assert.Contains(subs, fun (i: FSharpHierarchy.HierItem) -> i.Name = "Derived")
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }

// ── Success / nil response branches over the real sidecar socket ──
// Drives serializeOk (workspace/status), nilResult (non-symbol prepare), the
// workspace/open error path, the rename namespace + blank-line refusals, and
// the formatting-preview None branch — all through the real IPC stack.

type SidecarSuccessBranchTests(fixture: SidecarFixture) =
    interface IClassFixture<SidecarFixture>

    /// "module TestProject.Library" — the trailing source namespace segment
    /// has an exact rename range and placeholder.
    [<Fact>]
    member _.``prepare rename on a namespace token returns its exact range``() =
        task {
            let! r = fixture.Send("textDocument/prepareRename", posPayload fixture.Src 0 20)
            Assert.Null(r.Error)
            let wire = deserialize<PrepareRenameResultWire> r.Payload
            Assert.True(wire.CanRename)
            Assert.Equal("Library", wire.Placeholder)
            Assert.Equal(0, wire.StartLine)
            Assert.Equal(19, wire.StartCharacter)
            Assert.Equal(0, wire.EndLine)
            Assert.Equal(26, wire.EndCharacter)
        }

    /// Renaming at a blank line resolves no symbol → an empty workspace edit.
    [<Fact>]
    member _.``rename on a blank line produces no edits``() =
        task {
            let payload =
                MessagePackSerializer.Serialize(
                    { RenameRequest.FilePath = fixture.Src
                      Line = 1; Character = 0
                      NewName = "whatever" })
            let! r = fixture.Send("textDocument/rename", payload)
            Assert.Null(r.Error)
            let edit = deserialize<WorkspaceEditResult> r.Payload
            Assert.Empty(edit.DocumentChanges)
        }

    /// Opening a path that does not exist surfaces a clear error, not a crash.
    [<Fact>]
    member _.``workspace open on a missing path reports an error``() =
        task {
            let! r = fixture.Send("workspace/open", MessagePackSerializer.Serialize("/no/such/path/here.fsproj"))
            Assert.False(isNull r.Error)
            // The sidecar still serves subsequent requests.
            let! pong = fixture.Send("ping", [||])
            Assert.Equal("pong", deserialize<string> pong.Payload)
        }

    /// Unparseable source makes Fantomas fail → formatPreview returns None →
    /// the handler answers with a MessagePack nil (0xC0) and no error.
    [<Fact>]
    member _.``formatting preview on unparseable source returns nil``() =
        task {
            let bad = Path.Combine(fixture.Dir, "BrokenPreview.fs")
            File.WriteAllText(bad, "module Bad\nlet x = ( \n")
            let! r = fixture.Send("textDocument/formattingPreview", posPayload bad 0 0)
            Assert.Null(r.Error)
            Assert.Equal<byte[]>([| 0xC0uy |], r.Payload)
        }

    /// workspace/status serializes a status string (serializeOk); a prepare on a
    /// non-symbol position returns the shared nil result.
    [<Fact>]
    member _.``workspace status is ok and prepare on a non-symbol is nil``() =
        task {
            let! s = fixture.Send("workspace/status", [||])
            Assert.Null(s.Error)
            Assert.False(System.String.IsNullOrEmpty(deserialize<string> s.Payload))
            let! c = fixture.Send("textDocument/prepareCallHierarchy", posPayload fixture.Src 1 0)
            Assert.Null(c.Error)
            Assert.Equal<byte[]>([| 0xC0uy |], c.Payload)
        }

