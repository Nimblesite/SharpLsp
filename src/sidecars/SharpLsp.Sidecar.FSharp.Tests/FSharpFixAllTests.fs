/// Fix-all for F# quick fixes, driven through the batch engine over real
/// two-project .fsproj fixtures: one fix, every occurrence of a scope
/// (document / project / solution), merged per file from AST ranges, with
/// overlapping edits dropped and reported — never merged by text. The offered
/// actions carry their stable fix-all key and scopes for the host's
/// `Fix all: …` menu. Implements [FIXALL-SCOPES] for F# (GitHub #577).
module SharpLsp.Sidecar.FSharp.Tests.FSharpFixAllTests

open System
open System.IO
open System.Threading
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open MessagePack
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionKit
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpMultiProjectTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

// ── Helpers ──────────────────────────────────────────────────────

/// `Core`: one unused `open System.IO` (0-based line 2), one live function.
let private coreOpens =
    String.Join("\n", [ "module Core.Library"; ""; "open System.IO"; ""; "let greet () = \"core\""; "" ])

/// `App`: one unused `open System.IO` (0-based line 2), one use of `Core.greet`.
let private appOpens =
    String.Join(
        "\n",
        [ "module App.Program"; ""; "open System.IO"; "open Core.Library"; ""; "let message = greet ()"; "" ]
    )

/// Core and App — App referencing Core — written as real .fsproj files, never
/// built, and opened as one folder: the solution-shaped fixture every scope
/// test anchors on App/Program.fs.
let private openSolution core app =
    task {
        let root = NativePaths.Temp($"sharplsp-fixall-{Guid.NewGuid():N}")
        let corePath = writeProject root "Core" "Library.fs" core []
        let appPath = writeProject root "App" "Program.fs" app [ NativePaths.Join("..", "Core", "Core.fsproj") ]
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspaceLoading.loadProject state root
        Assert.True(Result.isOk loaded, $"fixture must load: {loaded}")
        return (state, root, corePath, appPath)
    }

/// The edits a fix-all produced, or the test fails on its refusal reason.
let private editsOf (outcome: FSharpFixAll.FixAllOutcome) =
    match outcome with
    | FSharpFixAll.Applied(edits, _) -> edits
    | FSharpFixAll.Refused reason -> failwith $"fix-all was refused: {reason}"

/// A fix-all's per-file edit counts keyed by file name, sorted for stable assertions.
let private countsByFile (edits: FSharpCodeFixes.DocumentEdit list) =
    edits
    |> List.map (fun d -> ((NativePaths.NameOf d.FilePath |> string), d.Edits.Length))
    |> List.sort
    |> Array.ofList

/// The edits of `file` within a fix-all result.
let private editsFor file (edits: FSharpCodeFixes.DocumentEdit list) =
    (edits |> List.find (fun d -> (NativePaths.NameOf d.FilePath |> string) = file)).Edits

/// Apply several edits to a whole-file source, back-to-front.
let private applyEdits (src: string) (edits: FSharpCodeFixes.TextEdit list) =
    (src, edits) ||> List.fold applyEdit

/// One fix-all anchored on `anchor`, analyzers off, cancellations unused.
let private fixAll state anchor fixKey scope =
    FSharpFixAll.fixAll state None anchor fixKey scope CancellationToken.None

/// FCS's check of `edited` in place of `path`.
let private recheck state path edited =
    task {
        match! FSharpWorkspace.checkFileWithSource state path edited CancellationToken.None with
        | Some(_, check, _) -> return check
        | None -> return failwith $"FCS could not re-check {path}"
    }

/// FCS's file-local findings of `source` through `check`.
let private findingsOf (source: string) (check: FSharpCheckFileResults) =
    FSharpLocalAnalysis.getFileAnalyzerFindings check source

/// Turn FS1182 on for the workspace's own project options.
let private warnOn1182 (state: FSharpWorkspace.FSharpWorkspaceState) =
    let opts = state.ProjectOptions.Value
    state.ProjectOptions <- Some { opts with OtherOptions = Array.append opts.OtherOptions [| "--warnon:1182" |] }

/// The error-severity diagnostics of a check.
let private errorsOf (check: FSharpCheckFileResults) =
    check.Diagnostics |> Array.filter (fun d -> d.Severity = FSharpDiagnosticSeverity.Error)

// ── Unused opens at every scope (GitHub #577) ───────────────────

/// Fix all unused opens at each scope of the two-project fixture: document
/// touches only the anchor, project only the owning project's files, solution
/// every project — and the solution-fixed sources re-check clean with FCS.
[<Fact>]
let ``fix all unused opens spans document project and solution and the fixed files re-check clean`` () =
    task {
        let! state, root, corePath, appPath = openSolution coreOpens appOpens
        try
            // 1. Document: only the anchor file, one whole-line deletion of its unused open.
            let! document = fixAll state appPath FSharpCodeFixes.FixAllKeys.RemoveUnusedOpen "document"
            let document = editsOf document

            Assert.Equal<(string * int) array>([| ("Program.fs", 1) |], countsByFile document)
            let deletion = Assert.Single(editsFor "Program.fs" document)

            Assert.Equal((2, 0, 3, 0, ""), (deletion.StartLine, deletion.StartCharacter, deletion.EndLine, deletion.EndCharacter, deletion.NewText))

            // 2. Project: the owning project of Program.fs compiles one file — Core stays untouched.
            let! project = fixAll state appPath FSharpCodeFixes.FixAllKeys.RemoveUnusedOpen "project"
            let project = editsOf project

            Assert.Equal<(string * int) array>([| ("Program.fs", 1) |], countsByFile project)

            // 3. Anchoring on Core instead shows the difference: its project holds Library.fs alone.
            let! coreProject = fixAll state corePath FSharpCodeFixes.FixAllKeys.RemoveUnusedOpen "project"
            let coreProject = editsOf coreProject

            Assert.Equal<(string * int) array>([| ("Library.fs", 1) |], countsByFile coreProject)

            // 4. Solution: both projects' files, one deletion each.
            let! solution = fixAll state appPath FSharpCodeFixes.FixAllKeys.RemoveUnusedOpen "solution"
            let solution = editsOf solution

            Assert.Equal<(string * int) array>([| ("Library.fs", 1); ("Program.fs", 1) |], countsByFile solution)

            // 5. Applying the solution edit leaves both files error-free with no unused opens.
            let coreEdited = applyEdits coreOpens (editsFor "Library.fs" solution)
            let! coreCheck = recheck state corePath coreEdited
            Assert.Empty(errorsOf coreCheck)
            let! coreFindings = findingsOf coreEdited coreCheck
            Assert.Empty(coreFindings.UnusedOpens)

            let appEdited = applyEdits appOpens (editsFor "Program.fs" solution)
            let! appCheck = recheck state appPath appEdited
            Assert.Empty(errorsOf appCheck)
            let! appFindings = findingsOf appEdited appCheck
            Assert.Empty(appFindings.UnusedOpens)
        finally
            cleanup root
    }

// ── Refusals: never a silent empty edit ─────────────────────────

/// A fix-all that finds nothing, an unknown fix key and an unknown scope each
/// refuse with a plain-words reason — never an empty edit. [REFACTOR-NEVER-SILENT]
[<Fact>]
let ``a fix all that finds nothing or cannot run refuses with a reason`` () =
    task {
        let! state, root, _, appPath = openSolution coreOpens appOpens
        try
            // The anchor holds one unused open; the simplify-name key finds nothing there.
            match! fixAll state appPath FSharpCodeFixes.FixAllKeys.SimplifyName "document" with
            | FSharpFixAll.Applied(edits, _) -> failwith $"expected a refusal, got {edits.Length} edits"
            | FSharpFixAll.Refused reason -> Assert.Contains("no occurrences", reason)

            // An unknown key is refused, not treated as a no-op.
            match! fixAll state appPath "NOT-A-FIX" "document" with
            | FSharpFixAll.Applied(edits, _) -> failwith $"expected a refusal, got {edits.Length} edits"
            | FSharpFixAll.Refused reason -> Assert.Contains("NOT-A-FIX", reason)

            // An unknown scope is refused with the scope's own name.
            match! fixAll state appPath FSharpCodeFixes.FixAllKeys.RemoveUnusedOpen "universe" with
            | FSharpFixAll.Applied(edits, _) -> failwith $"expected a refusal, got {edits.Length} edits"
            | FSharpFixAll.Refused reason -> Assert.Contains("universe", reason)
        finally
            cleanup root
    }

// ── The dead-declaration fix needs its analyzer ─────────────────

/// Removing unused declarations is the dead-code analyzer's fix (SLSPF0101):
/// with the analyzers off it refuses to run rather than fix nothing silently,
/// and with them on it sweeps every dead private of the scope.
[<Fact>]
let ``fix all unused declarations needs the analyzer and then sweeps every dead private of the solution`` () =
    task {
        let core = source [ "module Core.Dead"; ""; "let private deadCore () = 42"; ""; "let greeting () = \"core\"" ]
        let app = source [ "module App.Numbers"; ""; "open Core.Dead"; ""; "let private deadApp () = 7"; ""; "let total = greeting ()" ]
        let! state, root, corePath, appPath = openSolution core app
        try
            // 1. Analyzers off: refused with the reason, never an empty edit.
            match! fixAll state appPath FSharpCodeFixes.FixAllKeys.RemoveUnusedDeclaration "document" with
            | FSharpFixAll.Applied(edits, _) -> failwith $"expected a refusal, got {edits.Length} edits"
            | FSharpFixAll.Refused reason -> Assert.Contains("dead-code analyzer", reason)

            // 2. Analyzers on, solution scope: both projects' dead privates go, one edit each.
            let analyzers = FSharpAnalyzers.AnalyzerConfig.Default
            let! outcome =
                FSharpFixAll.fixAll state (Some analyzers) appPath FSharpCodeFixes.FixAllKeys.RemoveUnusedDeclaration "solution" CancellationToken.None

            let edits = editsOf outcome
            Assert.Equal<(string * int) array>([| ("Library.fs", 1); ("Program.fs", 1) |], countsByFile edits)

            // 3. Both edited files re-check clean: no errors, and no dead declaration remains.
            for path, original in [ (corePath, core); (appPath, app) ] do
                let name = NativePaths.NameOf path |> string
                let edited = applyEdits original (editsFor name edits)
                let! check = recheck state path edited
                Assert.Empty(errorsOf check)
                // The editor's overlay: the analyzer judges the fixed buffer, as it would live.
                FSharpWorkspace.applyDidChange state path edited
                let! dead = FSharpAnalyzers.deadCodeInFile state analyzers path CancellationToken.None
                Assert.Empty(dead)
        finally
            cleanup root
    }

// ── Diagnostics-driven fixes: `_` prefix and `new` ───────────────

/// FS1182: with the warning on, fix-all prefixes every unused value of the
/// document with `_`, the offered action carries the fix's key, and the fixed
/// file reports no FS1182 again.
[<Fact>]
let ``fix all unused values prefixes every occurrence in the document`` () =
    task {
        let! state, dir, _, paths =
            loadWorkspace [ ("M.fs", "module M\n\nlet f () =\n    let first = 42\n    let second = 43\n    ()\n") ]
        try
            warnOn1182 state
            let! outcome = fixAll state paths[0] FSharpCodeFixes.FixAllKeys.PrefixUnusedValue "document"
            let edits = editsOf outcome
            Assert.Equal<(string * int) array>([| ("M.fs", 2) |], countsByFile edits)
            let edited = applyEdits (File.ReadAllText paths[0]) (editsFor "M.fs" edits)
            Assert.Equal("    let _first = 42", edited.Split('\n')[3])
            Assert.Equal("    let _second = 43", edited.Split('\n')[4])
            let! check = recheck state paths[0] edited
            Assert.Empty(check.Diagnostics |> Array.filter (fun d -> d.ErrorNumber = 1182))

            // The offered single-site fix carries the same batch identity.
            let! _, actions = actionsWith None state paths[0] 3 4
            let prefix = actions |> List.find (fun a -> a.Title = "Prefix 'first' with _")
            Assert.Equal(FSharpCodeFixes.FixAllKeys.PrefixUnusedValue, prefix.FixKey)
        finally
            cleanup dir
    }

/// FS0760: fix-all adds `new` before every disposable construction of the
/// project — one per file here — and each fixed file reports no FS0760 again.
[<Fact>]
let ``fix all add-new prefixes every construction in the project`` () =
    task {
        let disposable name =
            source [ $"module {name}"; ""; $"let reader = System.IO.StringReader(\"{name}\")" ]
        let! state, dir, _, paths = loadWorkspace [ "A.fs", disposable "Alpha"; "B.fs", disposable "Beta" ]
        try
            let! outcome = fixAll state paths[0] FSharpCodeFixes.FixAllKeys.AddNewForDisposable "project"
            let edits = editsOf outcome
            Assert.Equal<(string * int) array>([| ("A.fs", 1); ("B.fs", 1) |], countsByFile edits)
            for path, moduleName in [ (paths[0], "Alpha"); (paths[1], "Beta") ] do
                let name = NativePaths.NameOf path |> string
                let edited = applyEdits (File.ReadAllText path) (editsFor name edits)
                Assert.Equal($"let reader = new System.IO.StringReader(\"{moduleName}\")", edited.Split('\n')[2])
                let! check = recheck state path edited
                Assert.Empty(check.Diagnostics |> Array.filter (fun d -> d.ErrorNumber = 760))

            // The offered single-site fix carries the same batch identity.
            let! _, actions = actionsWith None state paths[0] 2 13
            let addNew = actions |> List.find (fun a -> a.Title = "Add 'new'")
            Assert.Equal(FSharpCodeFixes.FixAllKeys.AddNewForDisposable, addNew.FixKey)
        finally
            cleanup dir
    }

// ── Simplify names across the solution ──────────────────────────

/// SLSPF0103: one redundant qualifier per file across both projects; the
/// simplified files re-check clean of simplifiable names.
[<Fact>]
let ``fix all simplify names spans the solution and leaves no redundant qualifier`` () =
    task {
        let core = source [ "module Core.Stamps"; ""; "open System"; ""; "let stamp = System.DateTime.Now" ]
        let app = source [ "module App.Ranges"; ""; "open System"; ""; "let started = System.DateTime.UtcNow" ]
        let! state, root, corePath, appPath = openSolution core app
        try
            let! outcome = fixAll state appPath FSharpCodeFixes.FixAllKeys.SimplifyName "solution"
            let edits = editsOf outcome
            Assert.Equal<(string * int) array>([| ("Library.fs", 1); ("Program.fs", 1) |], countsByFile edits)

            let coreEdited = applyEdits core (editsFor "Library.fs" edits)
            Assert.Equal("let stamp = DateTime.Now", coreEdited.Split('\n')[4])
            let! coreCheck = recheck state corePath coreEdited
            Assert.Empty(errorsOf coreCheck)
            let! coreFindings = findingsOf coreEdited coreCheck
            Assert.Empty(coreFindings.SimplifiableNames)

            let appEdited = applyEdits app (editsFor "Program.fs" edits)
            Assert.Equal("let started = DateTime.UtcNow", appEdited.Split('\n')[4])
            let! appCheck = recheck state appPath appEdited
            Assert.Empty(errorsOf appCheck)
            let! appFindings = findingsOf appEdited appCheck
            Assert.Empty(appFindings.SimplifiableNames)
        finally
            cleanup root
    }

// ── Overlapping edits are dropped and reported ───────────────────

/// Two findings of one file can claim overlapping ranges; the batch keeps the
/// earlier edit, drops the overlapping one and reports the count — identical
/// findings merge into one edit. [FIXALL-SCOPES]
[<Fact>]
let ``overlapping edits are dropped and identical findings merge`` () =
    let edit startLine startChar endLine endChar text : FSharpCodeFixes.TextEdit =
        { StartLine = startLine
          StartCharacter = startChar
          EndLine = endLine
          EndCharacter = endChar
          NewText = text }

    // Two distinct edits of the same range overlap; the first survives.
    let kept, dropped = FSharpFixAll.mergeFileEdits [ edit 2 0 3 0 ""; edit 2 0 3 0 "_x" ]
    Assert.Equal(1, kept.Length)
    Assert.Equal(1, dropped)

    // Nested ranges overlap: the earlier start wins, the contained edit goes.
    let kept, dropped = FSharpFixAll.mergeFileEdits [ edit 2 0 10 0 ""; edit 3 0 4 0 "" ]
    Assert.Equal(1, kept.Length)
    Assert.Equal(1, dropped)

    // A deletion spanning a whole line swallows a later edit inside that line.
    let kept, dropped = FSharpFixAll.mergeFileEdits [ edit 2 0 3 0 ""; edit 2 4 2 9 "_x" ]
    Assert.Equal(1, kept.Length)
    Assert.Equal(1, dropped)

    // Identical findings from two diagnostics become one edit, not a dropped one.
    let kept, dropped = FSharpFixAll.mergeFileEdits [ edit 2 4 2 9 "_first"; edit 2 4 2 9 "_first" ]
    Assert.Equal(1, kept.Length)
    Assert.Equal(0, dropped)

    // Disjoint edits all survive, in document order.
    let kept, dropped = FSharpFixAll.mergeFileEdits [ edit 4 8 4 13 ""; edit 2 4 2 9 "_x"; edit 2 0 2 3 "" ]
    Assert.Equal<(int * int) list>([ (2, 0); (2, 4); (4, 8) ], kept |> List.map (fun e -> (e.StartLine, e.StartCharacter)))
    Assert.Equal(0, dropped)

// ── Offered actions carry their fix-all identity ─────────────────

/// Every batch-capable fix carries its stable key and the three scopes on the
/// offered action, so the host can offer `Fix all: …` for it; the single-site
/// fixes of other diagnostics carry none. [FIXALL-SCOPES]
[<Fact>]
let ``offered actions carry their fix-all key and scopes`` () =
    task {
        let! state, dir, _, paths =
            loadWorkspace
                [ "Opens.fs", source [ "module Opens"; ""; "open System.Text"; ""; "let value = 1" ]
                  "Simplify.fs", source [ "module Simplify"; ""; "open System"; ""; "let redundant = System.DateTime.MinValue" ]
                  "Typos.fs", source [ "module Typos"; ""; "let length = 3"; "let total = lenght + 1" ]
                  "Dead.fs", source [ "module Dead"; ""; "let private deadBinding = 2"; ""; "let live = 1" ] ]
        try
            let! _, openActions = actionsWith None state paths[0] 2 0
            let unusedOpen = openActions |> List.find (fun a -> a.Title = "Remove unused open")
            Assert.Equal(FSharpCodeFixes.FixAllKeys.RemoveUnusedOpen, unusedOpen.FixKey)
            Assert.Equal<string list>(FSharpCodeFixes.FixAllKeys.scopes, unusedOpen.FixAllScopes |> Option.ofObj |> Option.defaultValue [])

            let! _, simplifyActions = actionsWith None state paths[1] 4 0
            let simplify = simplifyActions |> List.find (fun a -> a.Title = "Simplify name")
            Assert.Equal(FSharpCodeFixes.FixAllKeys.SimplifyName, simplify.FixKey)
            Assert.Equal<string list>(FSharpCodeFixes.FixAllKeys.scopes, simplify.FixAllScopes |> Option.ofObj |> Option.defaultValue [])

            // The typo replacement has no batch form: no key, no scopes.
            let! _, typoActions = actionsWith None state paths[2] 3 12
            Assert.Contains(typoActions, fun a -> a.Title.StartsWith "Replace with")
            Assert.True(typoActions |> List.forall (fun a -> isNull a.FixKey && isNull a.FixAllScopes))

            let! _, deadActions = actionsWith (Some FSharpAnalyzers.AnalyzerConfig.Default) state paths[3] 2 0
            let dead = deadActions |> List.find (fun a -> a.Title.StartsWith "Remove unused '")
            Assert.Equal(FSharpCodeFixes.FixAllKeys.RemoveUnusedDeclaration, dead.FixKey)
        finally
            cleanup dir
    }

// ── The wire shape mirrors the C# sidecar's ──────────────────────

/// The `codeAction/fixAll` request mirrors the C# sidecar's positional layout
/// `(file_path, fix_key, scope)`, which is what the Rust host sends; and a
/// listed action round-trips its key and scopes over MessagePack.
[<Fact>]
let ``the fix-all wire shape mirrors the C# sidecar positional layout`` () =
    // The host serializes its request struct as a positional MessagePack array.
    let positional = MessagePackSerializer.Serialize(("anchor.fs", "SLSPF0102", "solution"))
    let request = MessagePackSerializer.Deserialize<FixAllRequest>(positional)
    Assert.Equal("anchor.fs", request.FilePath)
    Assert.Equal("SLSPF0102", request.FixKey)
    Assert.Equal("solution", request.Scope)

    // The listed action carries the identity the host's `Fix all: …` menu reads.
    let item =
        MessagePackSerializer.Serialize(
            { CodeActionItemResult.Id = 1
              Title = "Remove unused open"
              Kind = "quickfix"
              IsPreferred = false
              Reference = null
              FixKey = FSharpCodeFixes.FixAllKeys.RemoveUnusedOpen
              FixAllScopes = [| "document"; "project"; "solution" |] }
        )
        |> MessagePackSerializer.Deserialize<CodeActionItemResult>

    Assert.Equal(FSharpCodeFixes.FixAllKeys.RemoveUnusedOpen, item.FixKey)
    Assert.Equal<string array>([| "document"; "project"; "solution" |], item.FixAllScopes |> Option.ofObj |> Option.defaultValue [||])

/// Containing-binding and containing-type AST scopes restrict batch fixes to
/// the enclosing `let` binding or `type` definition ([FIXALL-SCOPES]).
[<Fact>]
let ``fix all containingMember and containingType restrict edits to the enclosing AST node`` () =
    task {
        let src =
            String.Join(
                "\n",
                [ "module Scoped"
                  "open System"
                  "let first () = System.String.IsNullOrEmpty(\"a\")"
                  "let second () = System.String.IsNullOrEmpty(\"b\")"
                  "type Box() ="
                  "    member _.A() = System.String.IsNullOrEmpty(\"c\")"
                  "    member _.B() = System.String.IsNullOrEmpty(\"d\")"
                  "" ]
            )

        let! state, root, _, appPath = openSolution coreOpens src
        try
            // Containing member on `first` (line 2) touches only line 2, not line 3 or Box.
            let! memberEdits =
                FSharpFixAll.fixAllAt state None appPath FSharpCodeFixes.FixAllKeys.SimplifyName "containingMember" (Some 2) CancellationToken.None

            let memberEdits = editsOf memberEdits |> editsFor "Program.fs"
            Assert.Equal(1, memberEdits.Length)
            Assert.Equal(2, memberEdits.[0].StartLine)

            // Containing type on `Box` (line 5) touches both members of Box (lines 5 & 6), not top-level bindings.
            let! typeEdits =
                FSharpFixAll.fixAllAt state None appPath FSharpCodeFixes.FixAllKeys.SimplifyName "containingType" (Some 5) CancellationToken.None

            let typeEdits = editsOf typeEdits |> editsFor "Program.fs"
            Assert.Equal(2, typeEdits.Length)
            Assert.Equal<int list>([ 5; 6 ], typeEdits |> List.map (fun e -> e.StartLine))
        finally
            try
                Directory.Delete(root, true)
            with :? IOException -> ()
    }
