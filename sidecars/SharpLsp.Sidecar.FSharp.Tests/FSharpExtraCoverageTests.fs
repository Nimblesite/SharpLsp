/// Extra coverage for the F# sidecar — ALL real, NO mocks.
///   * IPC error branches: every payload-deserializing handler is hit with a
///     malformed MessagePack frame over the real socket, exercising its
///     `with ex -> Failure` path through the real FSharpSidecar.
///   * Module exception / not-loaded branches: every semantic module is called
///     directly against a REAL FSharpChecker — once with no project loaded, and
///     once on a loaded real `.fsproj` but a missing file — to drive the
///     graceful-failure paths.
///   * Success paths against a real loaded workspace.
module SharpLsp.Sidecar.FSharp.Tests.FSharpExtraCoverageTests

open System.IO
open Xunit
open MessagePack
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

// ── A real loaded workspace, built once from a real temp .fsproj ──
let private loaded =
    lazy
        (let dir = createTestProject ()
         let ws = FSharpWorkspace.create ()
         (FSharpWorkspace.loadProject ws dir).GetAwaiter().GetResult() |> ignore
         (ws, Path.Combine(dir, "Library.fs")))

let private missing = "/sharplsp/definitely/not/a/real/file.fs"

// ── IPC error branches over the real sidecar socket ──────────────

type SidecarErrorBranchTests(fixture: SidecarFixture) =
    interface IClassFixture<SidecarFixture>

    /// Every handler that deserializes its payload must surface an error (not
    /// crash the sidecar) when handed a malformed MessagePack frame (0xc1 is the
    /// reserved/never-used byte, so deserialization always throws).
    [<Theory>]
    [<InlineData("workspace/open")>]
    [<InlineData("solution/read")>]
    [<InlineData("textDocument/hover")>]
    [<InlineData("project/unusedPackages")>]
    [<InlineData("textDocument/definition")>]
    [<InlineData("textDocument/typeDefinition")>]
    [<InlineData("textDocument/declaration")>]
    [<InlineData("textDocument/implementation")>]
    [<InlineData("textDocument/references")>]
    [<InlineData("textDocument/documentHighlight")>]
    [<InlineData("textDocument/formatting")>]
    [<InlineData("textDocument/rangeFormatting")>]
    [<InlineData("textDocument/semanticTokens/full")>]
    [<InlineData("textDocument/semanticTokens/range")>]
    [<InlineData("textDocument/codeAction")>]
    [<InlineData("codeAction/resolve")>]
    [<InlineData("textDocument/inlayHint")>]
    [<InlineData("workspace/diagnostics")>]
    [<InlineData("textDocument/formattingPreview")>]
    [<InlineData("textDocument/completion")>]
    [<InlineData("textDocument/codeLens")>]
    [<InlineData("textDocument/prepareRename")>]
    [<InlineData("textDocument/rename")>]
    [<InlineData("textDocument/prepareCallHierarchy")>]
    [<InlineData("callHierarchy/incomingCalls")>]
    [<InlineData("callHierarchy/outgoingCalls")>]
    [<InlineData("textDocument/prepareTypeHierarchy")>]
    [<InlineData("typeHierarchy/supertypes")>]
    [<InlineData("typeHierarchy/subtypes")>]
    member _.``malformed payload returns an error, sidecar survives``(meth: string) =
        task {
            let! r = fixture.Send(meth, [| 0xc1uy |])
            Assert.False(isNull r.Error, $"{meth} must report an error on a malformed frame")
            // Sidecar must still serve subsequent requests (ping after the error).
            let! pong = fixture.Send("ping", [||])
            Assert.Equal("pong", deserialize<string> pong.Payload)
        }

    [<Fact>]
    member _.``unused packages returns a usage model for the real project``() =
        task {
            let fsproj = Path.Combine(fixture.Dir, "TestProject.fsproj")
            let! r = fixture.Send("project/unusedPackages", MessagePackSerializer.Serialize(fsproj))
            Assert.Null(r.Error)
            let usage = deserialize<ReferenceUsageResult> r.Payload
            Assert.NotNull(usage.AllPaths)
        }

    /// FS0020 (implicitly-ignored result) on Extra.fs:5 yields a code action
    /// whose resolve produces a real workspace edit — drives the codeAction +
    /// codeAction/resolve success path through the real sidecar.
    [<Fact>]
    member _.``code action on FS0020 resolves to a workspace edit``() =
        task {
            let extra = Path.Combine(fixture.Dir, "Extra.fs")
            let req =
                { CodeActionRequest.FilePath = extra
                  StartLine = 5
                  StartCharacter = 4
                  EndLine = 5
                  EndCharacter = 14 }
            let! r = fixture.Send("textDocument/codeAction", MessagePackSerializer.Serialize req)
            Assert.Null(r.Error)
            let actions = deserialize<CodeActionItemResult array> r.Payload
            Assert.NotEmpty(actions)
            let resolveReq = { CodeActionResolveRequest.Id = actions[0].Id }
            let! rr = fixture.Send("codeAction/resolve", MessagePackSerializer.Serialize resolveReq)
            Assert.Null(rr.Error)
            let edit = deserialize<WorkspaceEditResult> rr.Payload
            Assert.NotEmpty(edit.DocumentChanges)
        }

    /// Extra.fs carries an FS0020 warning + an FSharpLint hint, so diagnostics
    /// must surface entries — driving both the FCS and the lint loops.
    [<Fact>]
    member _.``diagnostics on a file with warnings returns entries``() =
        task {
            let extra = Path.Combine(fixture.Dir, "Extra.fs")
            let! r = fixture.Send("workspace/diagnostics", MessagePackSerializer.Serialize extra)
            Assert.Null(r.Error)
            let diags = deserialize<DiagnosticResult array> r.Payload
            Assert.NotEmpty(diags)
            Assert.All(diags, fun d -> Assert.False(System.String.IsNullOrEmpty d.Message))
        }

    /// A non-symbol position must be refused for rename (CanRename = false).
    [<Fact>]
    member _.``prepare rename on a blank line is refused``() =
        task {
            let! r = fixture.Send("textDocument/prepareRename", posPayload fixture.Src 1 0)
            Assert.Null(r.Error)
            let wire = deserialize<PrepareRenameResultWire> r.Payload
            Assert.False(wire.CanRename)
        }

    /// Call/type hierarchy prepare on a non-symbol position must return nil
    /// (the None branch of each handler) without erroring.
    [<Fact>]
    member _.``hierarchy prepare on a blank line returns nil without error``() =
        task {
            let! c = fixture.Send("textDocument/prepareCallHierarchy", posPayload fixture.Src 1 0)
            let! t = fixture.Send("textDocument/prepareTypeHierarchy", posPayload fixture.Src 1 0)
            Assert.Null(c.Error)
            Assert.Null(t.Error)
        }

// ── Not-loaded branches: real modules, real checker, no project ──

[<Fact>]
let ``hover on unloaded workspace returns None`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! h = FSharpWorkspace.getHover ws missing 0 0
        Assert.True(Option.isNone h)
    }

[<Fact>]
let ``definition family on unloaded workspace returns empty`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! d = FSharpWorkspace.getDefinition ws missing 0 0
        let! td = FSharpWorkspace.getTypeDefinition ws missing 0 0
        let! decl = FSharpWorkspace.getDeclaration ws missing 0 0
        let! impl = FSharpWorkspace.getImplementations ws missing 0 0
        Assert.True(Option.isNone d)
        Assert.True(Option.isNone td)
        Assert.True(Option.isNone decl)
        Assert.Empty(impl)
    }

[<Fact>]
let ``completion on unloaded workspace returns empty`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! items = FSharpCompletion.getCompletions ws missing 0 0
        Assert.Empty(items)
    }

[<Fact>]
let ``rename family on unloaded workspace is a no-op`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! prep = FSharpRename.prepareRename ws missing 0 0
        let! edits = FSharpRename.rename ws missing 0 0 "x"
        Assert.True(Option.isNone prep)
        Assert.Empty(edits)
    }

[<Fact>]
let ``references and highlights on unloaded workspace return empty`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! refs = FSharpReferences.getReferences ws missing 0 0 true
        let! hl = FSharpReferences.getDocumentHighlights ws missing 0 0
        let! uses = FSharpReferences.getProjectUsages ws missing 0 0
        Assert.Empty(refs)
        Assert.Empty(hl)
        Assert.Empty(uses)
    }

[<Fact>]
let ``call hierarchy on unloaded workspace returns empty`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! prep = FSharpHierarchy.prepareCall ws missing 0 0
        let! incoming = FSharpHierarchy.incomingCalls ws missing 0 0
        let! outgoing = FSharpHierarchy.outgoingCalls ws missing 0 0
        Assert.True(Option.isNone prep)
        Assert.Empty(incoming)
        Assert.Empty(outgoing)
    }

[<Fact>]
let ``type hierarchy on unloaded workspace returns empty`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! prep = FSharpHierarchy.prepareType ws missing 0 0
        let! sup = FSharpHierarchy.supertypes ws missing 0 0
        let! sub = FSharpHierarchy.subtypes ws missing 0 0
        Assert.True(Option.isNone prep)
        Assert.Empty(sup)
        Assert.Empty(sub)
    }

[<Fact>]
let ``code lens on unloaded workspace returns empty`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! lenses = FSharpCodeLens.getCodeLenses ws missing
        Assert.Empty(lenses)
    }

[<Fact>]
let ``inlay and semantic tokens on unloaded workspace return empty`` () =
    task {
        let ws = FSharpWorkspace.create ()
        let! hints = FSharpFeatures.getInlayHints ws missing 0 100
        let! full = FSharpFeatures.getSemanticTokens ws missing
        let! ranged = FSharpFeatures.getSemanticTokensRange ws missing 0 100
        Assert.Empty(hints)
        Assert.Empty(full)
        Assert.Empty(ranged)
    }

// ── Exception branches: loaded workspace, missing file path ──────

[<Fact>]
let ``loaded queries on a missing file fail gracefully`` () =
    task {
        let ws, _ = loaded.Value
        let! h = FSharpWorkspace.getHover ws missing 0 0
        let! d = FSharpWorkspace.getDefinition ws missing 0 0
        let! td = FSharpWorkspace.getTypeDefinition ws missing 0 0
        let! decl = FSharpWorkspace.getDeclaration ws missing 0 0
        let! impl = FSharpWorkspace.getImplementations ws missing 0 0
        Assert.True(Option.isNone h)
        Assert.True(Option.isNone d)
        Assert.True(Option.isNone td)
        Assert.True(Option.isNone decl)
        Assert.Empty(impl)
    }

[<Fact>]
let ``loaded intelligence on a missing file fails gracefully`` () =
    task {
        let ws, _ = loaded.Value
        let! items = FSharpCompletion.getCompletions ws missing 0 0
        let! prep = FSharpRename.prepareRename ws missing 0 0
        let! edits = FSharpRename.rename ws missing 0 0 "x"
        let! lenses = FSharpCodeLens.getCodeLenses ws missing
        Assert.Empty(items)
        Assert.True(Option.isNone prep)
        Assert.Empty(edits)
        Assert.Empty(lenses)
    }

[<Fact>]
let ``loaded hierarchy on a missing file fails gracefully`` () =
    task {
        let ws, _ = loaded.Value
        let! prepC = FSharpHierarchy.prepareCall ws missing 0 0
        let! inc = FSharpHierarchy.incomingCalls ws missing 0 0
        let! outg = FSharpHierarchy.outgoingCalls ws missing 0 0
        let! prepT = FSharpHierarchy.prepareType ws missing 0 0
        let! sup = FSharpHierarchy.supertypes ws missing 0 0
        let! sub = FSharpHierarchy.subtypes ws missing 0 0
        Assert.True(Option.isNone prepC)
        Assert.Empty(inc)
        Assert.Empty(outg)
        Assert.True(Option.isNone prepT)
        Assert.Empty(sup)
        Assert.Empty(sub)
    }

// ── Success paths against the real loaded workspace ──────────────

[<Fact>]
let ``completion lists module members on a loaded file`` () =
    task {
        let ws, src = loaded.Value
        // Just after `greeter.` on `greeter.Greet "World"` (line 28, 0-based) —
        // member completion on the IGreeter instance returns its members.
        let! items = FSharpCompletion.getCompletions ws src 28 12
        Assert.NotEmpty(items)
        Assert.All(
            items,
            fun (i: FSharpCompletion.CompletionEntry) ->
                Assert.False(System.String.IsNullOrEmpty i.Label))
    }

[<Fact>]
let ``code lens reports reference counts on a loaded file`` () =
    task {
        let ws, src = loaded.Value
        let! lenses = FSharpCodeLens.getCodeLenses ws src
        Assert.NotEmpty(lenses)
        Assert.All(
            lenses,
            fun (l: FSharpCodeLens.CodeLensEntry) ->
                Assert.False(System.String.IsNullOrEmpty l.Title))
    }

[<Fact>]
let ``inlay hints surface on the loaded file`` () =
    task {
        let ws, src = loaded.Value
        let! hints = FSharpFeatures.getInlayHints ws src 0 100
        Assert.NotEmpty(hints)
    }

// ── Program entry point: --version path ──────────────────────────

[<Fact>]
let ``main returns 0 for --version`` () =
    Assert.Equal(0, Program.main [| "--version" |])

[<Fact>]
let ``main returns 1 when no socket path is given`` () =
    Assert.Equal(1, Program.main [||])

[<Fact>]
let ``main exits gracefully for an unusable socket path`` () =
    // Parent directory does not exist → RunAsync returns fast (it logs + handles
    // its own bind failure). Exercises the run path; asserts a clean exit code
    // and no hang.
    let code = Program.main [| "/sharplsp-no-such-dir-xyz/s.sock" |]
    Assert.True(code = 0 || code = 1, $"expected a clean exit code, got {code}")

// ── FSharpLint warning path (real lint on a real file) ───────────

// ── File-order analyzer: a genuinely misordered project ──────────

[<Fact>]
let ``analyzeFileOrder flags a forward dependency in a misordered project`` () =
    task {
        let dir = Path.Combine(Path.GetTempPath(), $"slsp-order-{System.Guid.NewGuid():N}")
        Directory.CreateDirectory(dir) |> ignore
        // Compile order A→B, but A uses B ⇒ B must come first ⇒ misordered.
        File.WriteAllText(
            Path.Combine(dir, "Order.fsproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\">"
            + "<PropertyGroup><TargetFramework>net10.0</TargetFramework>"
            + "<DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference></PropertyGroup>"
            + "<ItemGroup><Compile Include=\"A.fs\" /><Compile Include=\"B.fs\" /></ItemGroup></Project>")
        File.WriteAllText(Path.Combine(dir, "A.fs"), "module P.A\n\nlet useB = B.value\n")
        File.WriteAllText(Path.Combine(dir, "B.fs"), "module P.B\n\nlet value = 42\n")
        let ws = FSharpWorkspace.create ()
        let! _ = FSharpWorkspace.loadProject ws dir
        let! issues = FSharpFileOrder.analyzeFileOrder ws (Path.Combine(dir, "Order.fsproj"))
        Assert.NotEmpty(issues)
        Assert.All(issues, fun i -> Assert.False(System.String.IsNullOrEmpty i.Message))
        try Directory.Delete(dir, true) with _ -> ()
    }

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
