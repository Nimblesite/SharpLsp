/// Overlay-contract coverage for the F# sidecar — ALL real, NO mocks.
/// [FS-DIDCHANGE-OVERLAY]: every per-file analysis must read the didChange
/// overlay (the live editor buffer) in preference to on-disk text, and the
/// overlay must be keyed by canonical path identity so any spelling of the
/// same file (drive-letter casing, separators, relative segments) hits it.
module SharpLsp.Sidecar.FSharp.Tests.FSharpOverlayTests

open System
open System.IO
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
