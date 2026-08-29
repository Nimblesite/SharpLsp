/// What the F# sidecar does BEFORE a project is loaded.
///
/// The host connects and starts forwarding editor traffic immediately, so every
/// one of these entry points is called against an empty workspace on real
/// sessions — during startup, and again after a crash-restart. Each must answer
/// "nothing yet" instead of throwing: an exception here escapes into the IPC
/// loop and takes the language features down for the rest of the session.
/// [HOVER-FSHARP-OVERLAY] / [SHARPLSP-FEATURES-NAVIGATION].
module SharpLsp.Sidecar.FSharp.Tests.FSharpUnloadedWorkspaceTests

open System.IO
open FSharp.Compiler.Text
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpDeclarationKindTests

/// An editor sends `didChange` for files the workspace has never heard of —
/// including before the project finishes cracking. The buffer must still be
/// recorded, and read back in preference to whatever is on disk.
[<Fact>]
let ``didChange before a project loads still records the live buffer`` () =
    let fresh = FSharpWorkspace.create ()
    let path = Path.Combine(Path.GetTempPath(), "sharplsp-unloaded-buffer.fs")
    let text = "module Unloaded\n\nlet typedButNeverSaved = 1\n"

    FSharpWorkspace.applyDidChange fresh path text

    Assert.False(fresh.IsLoaded)
    Assert.Equal(text, FSharpWorkspace.readSource fresh path)

/// With no project options there is no canonical spelling to map onto, so the
/// request path must be normalised to the same key `didChange` wrote under —
/// otherwise the overlay is written and then never found again.
[<Fact>]
let ``a request path resolves to the overlay key when no project is loaded`` () =
    let fresh = FSharpWorkspace.create ()
    let relative = Path.Combine(".", "Unloaded.fs")

    let resolved = FSharpWorkspace.projectFilePath fresh relative

    Assert.Equal(FSharpWorkspaceRuntime.overlayKey relative, resolved)
    Assert.True(Path.IsPathRooted(resolved), "overlay keys are absolute so one file has one key")

/// Completion, hover and diagnostics all funnel through a check. Without a
/// project there is nothing to check against, so the check must decline rather
/// than dereference the absent project options.
[<Fact>]
let ``checking a file against an unloaded workspace declines instead of throwing`` () = task {
    let fresh = FSharpWorkspace.create ()
    let path = Path.Combine(Path.GetTempPath(), "sharplsp-unloaded-check.fs")

    let! withSource = FSharpWorkspace.checkFileWithSource fresh path "module Unloaded\nlet x = 1\n"
    let! project = FSharpWorkspace.checkProject fresh

    Assert.True(withSource.IsNone)
    Assert.True(project.IsNone, "there is no project to check")
}

/// Rename filters uses down to those declared inside the project. With no
/// project loaded nothing qualifies — the alternative is renaming symbols that
/// live in a NuGet package or the BCL.
[<Fact>]
let ``no symbol belongs to a workspace that has not been loaded`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let! checkData = FSharpWorkspace.checkFileWithParse state paths[0]

        match checkData with
        | None -> failwith "the kind fixture must check"
        | Some(_parse, check, source) ->
            let line = kindLineOf "let sample ="
            let symbolUse = FSharpWorkspace.getSymbolUse check source line 6

            match symbolUse with
            | None -> failwith "expected a symbol use on the `sample` binding"
            | Some found ->
                // The very same symbol IS in the loaded workspace...
                Assert.True(FSharpWorkspace.isSymbolInProject state found.Symbol)
                // ...and is not in one that owns no project options.
                Assert.False(FSharpWorkspace.isSymbolInProject (FSharpWorkspace.create ()) found.Symbol)
    finally
        cleanup dir
}

/// FCS reports compiler-synthesised constructs with a range that names no file.
/// Turning one into a navigation target would send the editor to a file that
/// does not exist, so it must produce no location at all.
[<Fact>]
let ``a range that names no file never becomes a navigation target`` () =
    let anonymous = Range.mkRange "" (Position.mkPos 1 0) (Position.mkPos 1 4)
    let real = Range.mkRange "/src/Real.fs" (Position.mkPos 3 2) (Position.mkPos 3 8)

    Assert.True((FSharpWorkspace.rangeToLocation anonymous).IsNone)

    match FSharpWorkspace.rangeToLocation real with
    | None -> failwith "a range with a real file must produce a location"
    | Some location ->
        // Ranges are 1-based, LSP locations are 0-based.
        Assert.Equal("/src/Real.fs", location.FilePath)
        Assert.Equal(2, location.Line)
        Assert.Equal(2, location.Character)
        Assert.Equal(8, location.EndCharacter)

/// Analyzer defaults must stay conservative until the host configures them:
/// dead-code on (it is the useful half) but monorepo off, so an unused PUBLIC
/// symbol is never reported — in a library it is the API, not dead code.
/// [ANALYZERS-DEADCODE-SEVERITY]
[<Fact>]
let ``analyzer configuration defaults preserve the public API`` () =
    let defaults = FSharpAnalyzers.AnalyzerConfig.Default

    Assert.True(defaults.DeadCodeEnabled)
    Assert.False(defaults.Monorepo)

    let configured = FSharpAnalyzers.AnalyzerConfig.Create(false, true)

    Assert.False(configured.DeadCodeEnabled)
    Assert.True(configured.Monorepo)
