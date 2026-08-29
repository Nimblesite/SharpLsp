/// Overlay-contract coverage for the F# sidecar — ALL real, NO mocks.
/// [HOVER-FSHARP-OVERLAY]: every per-file analysis must read the didChange
/// overlay (the live editor buffer) in preference to on-disk text, and the
/// overlay must be keyed by canonical path identity so any spelling of the
/// same file (drive-letter casing, separators, relative segments) hits it.
module SharpLsp.Sidecar.FSharp.Tests.FSharpOverlayTests

open System
open System.IO
open System.Xml.Linq
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Symbols
open Xunit
open MessagePack
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

/// A fresh, isolated real workspace over a real temp .fsproj, so overlays
/// applied here never leak into the shared fixtures of sibling suites.
let private freshWorkspace () =
    task {
        let dir = createTestProject ()
        let ws = FSharpWorkspace.create ()
        let! _ = FSharpWorkspace.loadProject ws dir
        return ws, dir, Path.Combine(dir, "Library.fs")
    }

let private isLibraryCompile (element: XElement) =
    match element.Attribute(XName.Get("Include")) with
    | null -> false
    | attribute -> attribute.Value = "Library.fs"

let private configureIdentityProject dir =
    let project = Path.Combine(dir, "TestProject.fsproj")
    let document = XDocument.Load(project)
    let properties = document.Descendants(XName.Get("PropertyGroup")) |> Seq.head
    properties.Add(XElement(XName.Get("AssemblyName"), "FSharpFixtures"))
    document.Descendants(XName.Get("Compile"))
    |> Seq.filter (isLibraryCompile >> not)
    |> Seq.toArray
    |> Array.iter _.Remove()
    document.Save(project)
    let source = Path.Combine(dir, "Library.fs")
    File.WriteAllText(source, "namespace FSharpFixtures.CrossLanguage\n\ntype FSharpOrigin(value: int) =\n    member _.Value = value\n")
    project, source

[<Fact>]
let ``rename identity uses the real project assembly name`` () =
    task {
        let dir = createTestProject ()
        try
            let project, source = configureIdentityProject dir
            let workspace = FSharpWorkspace.create ()
            let! loaded = FSharpWorkspace.loadProject workspace project
            Assert.True(match loaded with | Ok _ -> true | Error _ -> false)
            let options = workspace.ProjectOptions |> Option.map _.OtherOptions |> Option.defaultValue [||]
            Assert.Contains("--out:FSharpFixtures.dll", options)
            let! identity = FSharpRename.getRenameIdentity workspace source 2 7
            match identity with
            | Some value ->
                Assert.Equal("FSharpFixtures", value.AssemblyName)
                Assert.Equal("T:FSharpFixtures.CrossLanguage.FSharpOrigin", value.XmlDocSig)
                Assert.NotEqual<string>("DiagnosticsTarget", value.AssemblyName)
            | None -> Assert.Fail("FSharpOrigin must expose a cross-sidecar rename identity")
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }

[<NoComparison; NoEquality>]
type private ForeignRenameScenario =
    { Workspace: FSharpWorkspace.FSharpWorkspaceState
      Directory: string; SourcePath: string; OriginalText: string
      AssemblyName: string; OriginalXml: string }

let private foreignRenameSource =
    "namespace ForeignReverse\n\nopen System.Text\n\nmodule Uses =\n"
    + "    let length = function | \"RenamedStringBuilder\", (builder: StringBuilder) -> builder.Length | _ -> 0\n"
    + "    let ``RenamedStringBuilder`` = 42\n"
    + "    let literal = \"RenamedStringBuilder RenamedStringBuilder\"\n"
    + "    let comment = 1 // RenamedStringBuilder RenamedStringBuilder\n"

let private entityIdentity (entity: FSharpEntity) =
    string entity.Assembly.SimpleName, entity.XmlDocSig

let private externalEntityIdentity workspace sourcePath line character =
    task {
        let! checkedFile = FSharpWorkspace.checkFile workspace sourcePath
        match checkedFile with
        | None -> return failwith "real FCS check must complete"
        | Some(checkResults, source) ->
            match FSharpWorkspace.getSymbolUse checkResults source line character with
            | Some symbolUse ->
                match symbolUse.Symbol with
                | :? FSharpEntity as entity -> return entityIdentity entity
                | :? FSharpMemberOrFunctionOrValue as memberValue ->
                    match memberValue.DeclaringEntity with
                    | Some entity -> return entityIdentity entity
                    | None -> return failwith "constructor must have a declaring entity"
                | symbol -> return failwith $"expected entity, got {symbol.GetType().Name}"
            | None -> return failwith "StringBuilder must bind through real FCS"
    }

let private createForeignRenameScenario () =
    task {
        let dir = createTestProject ()
        let project, sourcePath = configureIdentityProject dir
        File.WriteAllText(sourcePath, foreignRenameSource)
        let workspace = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspace.loadProject workspace project
        match loaded with
        | Error message -> return failwith $"real project failed to load: {message}"
        | Ok _ ->
            let line = foreignRenameSource.Split('\n')[5]
            let character = line.LastIndexOf("StringBuilder", StringComparison.Ordinal) + 1
            let! assemblyName, xmlDocSig = externalEntityIdentity workspace sourcePath 5 character
            return
                { Workspace = workspace; Directory = dir; SourcePath = sourcePath
                  OriginalText = foreignRenameSource; AssemblyName = assemblyName
                  OriginalXml = xmlDocSig }
    }

let private applySingleLineEdit (source: string) (edit: FSharpCodeActions.RawEdit) =
    let lines = source.Split('\n')
    let line = lines[edit.StartLine]
    let before = line.Substring(0, edit.StartCharacter)
    let after = line.Substring(edit.EndCharacter)
    lines[edit.StartLine] <- before + edit.NewText + after
    String.Join("\n", lines)

let private assertSingleEdit
    (path: string) (line: int) (startCharacter: int)
    (oldName: string) (newName: string) (source: string)
    (edits: FSharpCodeActions.RawEdit list) =
    let edit = Assert.Single<FSharpCodeActions.RawEdit>(edits)
    Assert.Equal<string>(path, edit.FilePath)
    Assert.Equal(line, edit.StartLine)
    Assert.Equal(line, edit.EndLine)
    Assert.Equal(startCharacter, edit.StartCharacter)
    Assert.Equal(startCharacter + oldName.Length, edit.EndCharacter)
    Assert.Equal<string>(newName, edit.NewText)
    let sourceLine = source.Split('\n')[line]
    let actualName = sourceLine.Substring(startCharacter, oldName.Length)
    Assert.Equal<string>(oldName, actualName)
    edit

let private workspaceErrors (scenario: ForeignRenameScenario) =
    task {
        let! checkedFile = FSharpWorkspace.checkFile scenario.Workspace scenario.SourcePath
        return
            checkedFile
            |> Option.map (fun (result, _) ->
                result.Diagnostics |> Array.filter (fun item -> item.Severity = FSharpDiagnosticSeverity.Error))
            |> Option.defaultWith (fun () -> failwith "real FCS check must complete")
    }

let private runForeignForward (scenario: ForeignRenameScenario) =
    task {
        let! edits = FSharpRename.renameForeign scenario.Workspace scenario.AssemblyName
                         scenario.OriginalXml "RenamedStringBuilder"
        let line = scenario.OriginalText.Split('\n')[5]
        let startCharacter = line.LastIndexOf("StringBuilder", StringComparison.Ordinal)
        let edit = assertSingleEdit scenario.SourcePath 5 startCharacter "StringBuilder"
                       "RenamedStringBuilder" scenario.OriginalText edits
        let forwardText = applySingleLineEdit scenario.OriginalText edit
        Assert.Contains("(builder: RenamedStringBuilder)", forwardText)
        Assert.Contains("let ``RenamedStringBuilder`` = 42", forwardText)
        Assert.Equal(7, Text.RegularExpressions.Regex.Matches(forwardText, "RenamedStringBuilder").Count)
        FSharpWorkspace.applyDidChange scenario.Workspace scenario.SourcePath forwardText
        let! errors = workspaceErrors scenario
        Assert.NotEmpty(errors)
        let renamedXml = FSharpRename.renameXmlDocSignature scenario.OriginalXml "StringBuilder" "RenamedStringBuilder"
        Assert.Equal("T:System.Text.RenamedStringBuilder", renamedXml)
        return forwardText, renamedXml
    }

let private assertReverseNegatives (scenario: ForeignRenameScenario) (renamedXml: string) =
    task {
        let! wrongAssembly =
            FSharpRename.renameForeign
                scenario.Workspace (scenario.AssemblyName + ".Wrong") renamedXml "StringBuilder"
        Assert.Empty(wrongAssembly)
        let! wrongIdentity =
            FSharpRename.renameForeign
                scenario.Workspace scenario.AssemblyName "T:System.Text.NotTheBuilder" "StringBuilder"
        Assert.Empty(wrongIdentity)
        let! noOp =
            FSharpRename.renameForeign
                scenario.Workspace scenario.AssemblyName renamedXml "RenamedStringBuilder"
        Assert.Empty(noOp)
    }

let private runForeignReverse
    (scenario: ForeignRenameScenario) (forwardText: string) (renamedXml: string) =
    task {
        let! edits =
            FSharpRename.renameForeign
                scenario.Workspace scenario.AssemblyName renamedXml "StringBuilder"
        let line = forwardText.Split('\n')[5]
        let startCharacter = line.LastIndexOf("RenamedStringBuilder", StringComparison.Ordinal)
        let edit = assertSingleEdit scenario.SourcePath 5 startCharacter
                       "RenamedStringBuilder" "StringBuilder" forwardText edits
        let restored = applySingleLineEdit forwardText edit
        Assert.Equal<string>(scenario.OriginalText, restored)
        Assert.Equal(6, Text.RegularExpressions.Regex.Matches(restored, "RenamedStringBuilder").Count)
        Assert.Contains("let ``RenamedStringBuilder`` = 42", restored)
        Assert.DoesNotContain("(builder: RenamedStringBuilder)", restored)
        FSharpWorkspace.applyDidChange scenario.Workspace scenario.SourcePath restored
    }

let private assertRestoredSemantics (scenario: ForeignRenameScenario) =
    task {
        let! errors = workspaceErrors scenario
        Assert.Empty(errors)
        let line = scenario.OriginalText.Split('\n')[5]
        let character = line.LastIndexOf("StringBuilder", StringComparison.Ordinal) + 1
        let! assemblyName, xmlDocSig =
            externalEntityIdentity scenario.Workspace scenario.SourcePath 5 character
        Assert.Equal<string>(scenario.AssemblyName, assemblyName)
        Assert.Equal<string>(scenario.OriginalXml, xmlDocSig)
        Assert.Equal("T:System.Text.StringBuilder", xmlDocSig)
        Assert.NotEqual<string>("FSharpFixtures", assemblyName)
    }

/// [SHARPLSP-FEATURES-REFACTORING] Complete unsaved cross-language lifecycle.
/// Same-line negatives also exercise shifted columns in the batched real-FCS check.
[<Fact>]
let ``foreign rename reverses an unresolved overlay without touching same-name text`` () =
    task {
        let! scenario = createForeignRenameScenario ()
        try
            Assert.False(String.IsNullOrWhiteSpace(scenario.AssemblyName))
            Assert.Equal("T:System.Text.StringBuilder", scenario.OriginalXml)
            Assert.Equal(6, Text.RegularExpressions.Regex.Matches(scenario.OriginalText, "RenamedStringBuilder").Count)
            let! forwardText, renamedXml = runForeignForward scenario
            do! assertReverseNegatives scenario renamedXml
            do! runForeignReverse scenario forwardText renamedXml
            do! assertRestoredSemantics scenario
        finally
            try Directory.Delete(scenario.Directory, true) with _ -> ()
    }

[<Fact>]
let ``cross-sidecar rename analysis failures propagate instead of returning partial success`` () =
    task {
        let workspace = FSharpWorkspace.create ()
        let identityCall () =
            FSharpRename.getRenameIdentity workspace "missing.fs" 0 0 :> Threading.Tasks.Task
        let foreignCall () =
            FSharpRename.renameForeign workspace "Any" "T:Any.Type" "Other" :> Threading.Tasks.Task
        let! identityError = Assert.ThrowsAsync<InvalidOperationException>(Func<Threading.Tasks.Task>(identityCall))
        let! foreignError = Assert.ThrowsAsync<InvalidOperationException>(Func<Threading.Tasks.Task>(foreignCall))
        Assert.Equal("F# workspace is not loaded", identityError.Message)
        Assert.Equal("F# workspace is not loaded", foreignError.Message)
        Assert.NotSame(identityError, foreignError)
        Assert.IsType<InvalidOperationException>(identityError) |> ignore
        Assert.IsType<InvalidOperationException>(foreignError) |> ignore
    }

/// Store `overlayText` under `storePath`, then hover over the binding named by
/// `needle` via `requestPath`. Hover is already overlay-aware, so a `Some`
/// result proves the overlay bridged the two path spellings.
let private hoverViaOverlay
    (ws: FSharpWorkspace.FSharpWorkspaceState)
    (storePath: string)
    (requestPath: string)
    (overlayText: string)
    (needle: string)
    =
    task {
        FSharpWorkspace.applyDidChange ws storePath overlayText
        let lines = overlayText.Replace("\r\n", "\n").Split('\n')
        let lineIdx = lines |> Array.findIndex (fun l -> l.Contains(needle: string))
        let col = lines[lineIdx].IndexOf(needle: string) + 2
        return! FSharpWorkspace.getHover ws requestPath lineIdx col
    }

// ── Bug A: features must read the overlay, not stale disk text ──

/// Document symbols must reflect the live buffer: a type that exists ONLY in
/// the didChange overlay (never on disk) must appear in the outline.
[<Fact>]
let ``documentSymbols reflect the didChange overlay instead of on-disk text`` () =
    task {
        let! ws, dir, src = freshWorkspace ()
        try
            let edited =
                File.ReadAllText(src)
                + "\ntype OverlayOnlySymbol = { OverlayField: int }\n"
            FSharpWorkspace.applyDidChange ws src edited
            let! symbols = FSharpSymbols.documentSymbols ws src
            Assert.NotEmpty(symbols)
            Assert.Contains(symbols, fun s -> s.Name = "OverlayOnlySymbol")
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }

// ── Bug B: overlay keys must be canonical path identities ────────

/// VS Code lowercases the drive letter while FCS and the project loader report
/// the uppercase spelling; a didChange stored under one casing must be found
/// via the other. Windows-only: case-sensitive filesystems keep Ordinal keys.
[<Fact>]
let ``overlay stored under one drive-letter casing is read via another on Windows`` () =
    task {
        if OperatingSystem.IsWindows() then
            let! ws, dir, src = freshWorkspace ()
            try
                let flippedDrive =
                    let head = src[0]
                    let flipped =
                        if Char.IsUpper head then Char.ToLowerInvariant head
                        else Char.ToUpperInvariant head
                    string flipped + src[1..]
                Assert.NotEqual<string>(src, flippedDrive)
                let edited =
                    File.ReadAllText(src)
                    + "\nlet overlayCasingBinding (a: int) : int = a * 2\n"
                let! hover = hoverViaOverlay ws flippedDrive src edited "overlayCasingBinding"
                Assert.True(
                    hover.IsSome,
                    "hover must see the overlay stored under a different drive-letter casing")
            finally
                try Directory.Delete(dir, true) with _ -> ()
    }

/// Cross-platform: `Path.GetFullPath` normalization must collapse separator
/// and relative-segment spellings (`dir/./Library.fs` with forward slashes)
/// onto the canonical key the analyses look up.
[<Fact>]
let ``overlay stored under a denormalized path spelling is read via the canonical one`` () =
    task {
        let! ws, dir, src = freshWorkspace ()
        try
            let denormalized = dir.Replace('\\', '/') + "/./Library.fs"
            Assert.NotEqual<string>(src, denormalized)
            let edited =
                File.ReadAllText(src)
                + "\nlet overlaySpellingBinding (a: int) : int = a + 41\n"
            let! hover = hoverViaOverlay ws denormalized src edited "overlaySpellingBinding"
            Assert.True(
                hover.IsSome,
                "hover must see the overlay stored under a denormalized path spelling")
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }

// ── [GitHub #160]: checks must track the newest overlay text ─────

/// FCS error messages in a `checkFile` result; an unusable result (workspace
/// not loaded / check aborted) surfaces as a pseudo-error so asserts fail loud.
let private errorMessages (result: (FSharpCheckFileResults * string) option) =
    match result with
    | Some(check, _) ->
        check.Diagnostics
        |> Array.filter (fun d -> d.Severity = FSharpDiagnosticSeverity.Error)
        |> Array.map (fun d -> d.Message)
    | None -> [| "check aborted or workspace not loaded" |]

/// [GitHub #160] Sequential edit/revert cycles through the real checker: the
/// broken buffer must always error, the reverted buffer must always be clean,
/// across repeated alternations of the same two texts. Regression guard that
/// every per-file check reads the newest didChange overlay rather than a cached
/// result for superseded text — the property that lets a reverted buffer clear
/// its phantom errors. [HOVER-FSHARP-OVERLAY]
[<Fact>]
let ``edit and revert cycles always check the newest overlay text`` () =
    task {
        let! ws, dir, src = freshWorkspace ()
        try
            let pristine = File.ReadAllText(src)
            let broken = pristine + "\nlet __sharpLspBad: int = \"not an int\"\n"
            for cycle in 1 .. 3 do
                FSharpWorkspace.applyDidChange ws src broken
                let! brokenCheck = FSharpWorkspace.checkFile ws src
                Assert.True(
                    brokenCheck.IsSome,
                    $"cycle {cycle}: check of the broken overlay must complete")
                Assert.False(
                    Array.isEmpty (errorMessages brokenCheck),
                    $"cycle {cycle}: the broken overlay must produce a type error")
                FSharpWorkspace.applyDidChange ws src pristine
                let! cleanCheck = FSharpWorkspace.checkFile ws src
                let staleErrors = errorMessages cleanCheck
                Assert.True(
                    Array.isEmpty staleErrors,
                    $"cycle {cycle}: the reverted overlay must check clean; got: "
                    + String.Join("; ", staleErrors))
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }

// ── Bug A over real IPC: diagnostics + formatting handlers ───────

type SidecarOverlayTests(fixture: SidecarFixture) =
    interface IClassFixture<SidecarFixture>

    /// The user broke the file on disk, then fixed it in the (unsaved) buffer:
    /// pulled diagnostics must be computed from the overlay — no stale errors.
    [<Fact>]
    member _.``diagnostics reflect the didChange overlay, not stale disk text``() =
        task {
            let fixedText = File.ReadAllText(fixture.Consumer)
            let brokenText =
                "module TestProject.Consumer\n\n"
                + "open TestProject.Library\n\n"
                + "let consumeAdd () = add 100 \"oops\"\n"
            File.WriteAllText(fixture.Consumer, brokenText)
            try
                let didChange =
                    MessagePackSerializer.Serialize(
                        { DidChangeRequest.FilePath = fixture.Consumer; NewText = fixedText })
                let! dc = fixture.Send("textDocument/didChange", didChange)
                Assert.Null(dc.Error)
                let! r =
                    fixture.Send(
                        "workspace/diagnostics", MessagePackSerializer.Serialize(fixture.Consumer))
                Assert.Null(r.Error)
                let diags = deserialize<DiagnosticResult array>(r.Payload)
                let errors = diags |> Array.filter (fun d -> d.Severity = "Error")
                Assert.True(
                    Array.isEmpty errors,
                    "diagnostics must check the fixed overlay, not the broken disk text; got: "
                    + String.Join("; ", errors |> Array.map (fun d -> d.Message)))
            finally
                File.WriteAllText(fixture.Consumer, fixedText)
        }

    /// [GitHub #160] Phantom-diagnostics repro: inject a type error via
    /// didChange (buffer-only, never saved to disk), confirm the error is
    /// reported, then revert the buffer to pristine text via didChange. The
    /// next pulled diagnostics MUST be clean — a check result computed from
    /// older text must never be served for newer text.
    [<Fact>]
    member _.``diagnostics clear after an error edit is reverted``() =
        task {
            let pristine = File.ReadAllText(fixture.Src)
            let broken = pristine + "\nlet __sharpLspBad: int = \"not an int\"\n"
            let sendDidChange text =
                fixture.Send(
                    "textDocument/didChange",
                    MessagePackSerializer.Serialize(
                        { DidChangeRequest.FilePath = fixture.Src; NewText = text }))
            let pullDiagnostics () =
                task {
                    let! r =
                        fixture.Send(
                            "workspace/diagnostics", MessagePackSerializer.Serialize(fixture.Src))
                    Assert.Null(r.Error)
                    return deserialize<DiagnosticResult array>(r.Payload)
                }

            // 1. Break the buffer — the error must surface (repro precondition).
            let! dcBroken = sendDidChange broken
            Assert.Null(dcBroken.Error)
            let! brokenDiags = pullDiagnostics ()
            Assert.Contains(brokenDiags, fun d -> d.Severity = "Error")

            // 2. Deterministic revert, exactly like the e2e: buffer back to pristine.
            let! dcReverted = sendDidChange pristine
            Assert.Null(dcReverted.Error)

            // 3. Every subsequent pull must be clean; a single stale answer is
            //    the #160 phantom.
            for attempt in 1 .. 3 do
                let! diags = pullDiagnostics ()
                let errors = diags |> Array.filter (fun d -> d.Severity = "Error")
                Assert.True(
                    Array.isEmpty errors,
                    $"pull #{attempt} after revert must be clean; got: "
                    + String.Join("; ", errors |> Array.map (fun d -> $"{d.Code} {d.Message}")))
        }

    /// Formatting must derive its whole-file replacement from the live buffer:
    /// an edit computed from disk would silently revert the user's unsaved work.
    [<Fact>]
    member _.``formatting computes edits from the didChange overlay, not disk``() =
        task {
            let path = Path.Combine(fixture.Dir, "OverlayFormat.fs")
            File.WriteAllText(path, "module OverlayFormat\nlet    diskOnly=1\n")
            try
                let overlayText = "module OverlayFormat\nlet    bufferOnly=2\n"
                let didChange =
                    MessagePackSerializer.Serialize(
                        { DidChangeRequest.FilePath = path; NewText = overlayText })
                let! dc = fixture.Send("textDocument/didChange", didChange)
                Assert.Null(dc.Error)
                let! r = fixture.Send("textDocument/formatting", posPayload path 0 0)
                Assert.Null(r.Error)
                let edits = deserialize<FormatEditWire array>(r.Payload)
                Assert.Single(edits) |> ignore
                Assert.Contains("let bufferOnly = 2", edits[0].NewText)
                Assert.DoesNotContain("diskOnly", edits[0].NewText)
            finally
                try File.Delete(path) with _ -> ()
        }
