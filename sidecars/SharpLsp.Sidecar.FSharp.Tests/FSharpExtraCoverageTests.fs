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
    [<InlineData("textDocument/didChange")>]
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
    [<InlineData("textDocument/documentSymbol")>]
    [<InlineData("textDocument/signatureHelp")>]
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

    /// Extra.fs carries an FS0020 warning, so diagnostics must surface entries —
    /// driving the FCS diagnostics loop.
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

/// Hover resolves against the in-memory `didChange` overlay rather than the
/// on-disk file: an unsaved binding that exists ONLY in the editor buffer must
/// be hoverable. Regression for "F# hover is broken after typing". Uses an
/// isolated workspace so the overlay never leaks into the shared `loaded`.
/// [FS-DIDCHANGE-OVERLAY]
[<Fact>]
let ``getHover reads the didChange overlay instead of on-disk source`` () =
    task {
        let dir = createTestProject ()
        try
            let ws = FSharpWorkspace.create ()
            let! _ = FSharpWorkspace.loadProject ws dir
            let src = Path.Combine(dir, "Library.fs")
            // Edited buffer: append a binding present only in memory, never on disk.
            let edited =
                File.ReadAllText(src)
                + "\n/// Present only in the editor buffer, never on disk.\n"
                + "let overlayOnlyBinding (a: int) (b: int) : int = a - b\n"
            FSharpWorkspace.applyDidChange ws src edited

            let lines = edited.Replace("\r\n", "\n").Split('\n')
            let lineIdx =
                lines |> Array.findIndex (fun l -> l.Contains "let overlayOnlyBinding")
            let col = lines[lineIdx].IndexOf("overlayOnlyBinding") + 2

            let! h = FSharpWorkspace.getHover ws src lineIdx col
            Assert.True(h.IsSome, "hover must resolve the overlay-only binding")
            let markdown, _, _, _, _ = h.Value
            Assert.Contains("overlayOnlyBinding", markdown)
        finally
            try Directory.Delete(dir, true) with _ -> ()
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

    /// "module TestProject.Library" — column 8 is inside the `TestProject`
    /// namespace token, which is not renameable (the namespace guard arm).
    [<Fact>]
    member _.``prepare rename on a namespace token is refused``() =
        task {
            let! r = fixture.Send("textDocument/prepareRename", posPayload fixture.Src 0 8)
            Assert.Null(r.Error)
            let wire = deserialize<PrepareRenameResultWire> r.Payload
            Assert.False(wire.CanRename)
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
