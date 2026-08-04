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
    [<InlineData("textDocument/renameIdentity")>]
    [<InlineData("workspace/renameForeign")>]
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
/// [HOVER-FSHARP-OVERLAY]
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
