/// "Remove unused" driven through the real code-action pipeline over a real
/// parsed .fsproj fixture: offered at the declarations the dead-code analyzer
/// reports, resolved, applied, and the edited file re-checked by FCS. Never
/// offered for live code, for a binding that declares more than one name or
/// shares its line, for a declaration a signature file declares, or while the
/// analyzer is off. Implements [ANALYZERS-DEADCODE-FIX].
module SharpLsp.Sidecar.FSharp.Tests.FSharpDeadCodeFixTests

open System.Threading
open FSharp.Compiler.Diagnostics
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionKit
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

//  0: module Dead
//  2: let shared = 1
//  4: /// The answer nobody asks for.
//  5: [<System.Obsolete("unused")>]
//  6: let private unusedAnswer () = 42
//  8: type Counter() =
//  9:     member private _.Unused() = 0
// 10:     member _.Value = shared
// 12: let private first, second = 1, 2
// 13: let private commented = 3 // kept for a reason
// 14: let live = shared + 1
let private DEAD =
    source
        [ "module Dead"
          ""
          "let shared = 1"
          ""
          "/// The answer nobody asks for."
          "[<System.Obsolete(\"unused\")>]"
          "let private unusedAnswer () = 42"
          ""
          "type Counter() ="
          "    member private _.Unused() = 0"
          "    member _.Value = shared"
          ""
          "let private first, second = 1, 2"
          "let private commented = 3 // kept for a reason"
          "let live = shared + 1" ]

/// The editor's default analyzers: dead code on, outside monorepo mode.
let private ANALYZERS = Some FSharpAnalyzers.AnalyzerConfig.Default

/// Monorepo mode, where unused public code is dead too.
let private MONOREPO = Some(FSharpAnalyzers.AnalyzerConfig.Create(true, true))

/// The "Remove unused" titles offered on 0-based `line` with `analyzers`.
let private removalsAt analyzers state path line =
    task {
        let! _, actions = actionsWith analyzers state path line 0
        return actions |> List.map _.Title |> List.filter (fun title -> title.StartsWith "Remove unused '")
    }

[<Fact>]
let ``a dead private function goes whole, with its documentation and attributes, leaving one gap`` () =
    task {
        let! state, dir, _, paths = loadWorkspace [ "Dead.fs", DEAD ]
        try
            // 1. Offered once, at the dead function, as a quick fix nobody applies by accident.
            let! fixes, actions = actionsWith ANALYZERS state paths[0] 6 0
            let removal = actions |> List.filter (fun action -> action.Title = "Remove unused 'unusedAnswer'")
            let offered = Assert.Single(removal)
            Assert.Equal("quickfix", offered.Kind)
            Assert.False(offered.IsPreferred, "deleting code is never the preferred fix")

            // 2. It deletes the documentation, the attribute, the binding and one of the two gaps.
            let edit = (resolveSole fixes "Remove unused 'unusedAnswer'" actions).Value
            let deletion = Assert.Single(Assert.Single(edit.DocumentChanges).Edits)
            Assert.Equal((4, 0, 8, 0), (deletion.StartLine, deletion.StartCharacter, deletion.EndLine, deletion.EndCharacter))
            Assert.Equal("", deletion.NewText)
            let edited = applyEdit DEAD deletion
            let lines = edited.Split('\n')
            Assert.Equal<string array>([| "let shared = 1"; ""; "type Counter() =" |], lines[2..4])

            // 3. FCS finds the edited file clean.
            match! FSharpWorkspace.checkFileWithSource state paths[0] edited with
            | Some(_, check, _) -> Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error check)
            | None -> failwith "FCS could not re-check the edited file"
        finally
            cleanup dir
    }

[<Fact>]
let ``a dead member goes whole, and a binding sharing its names or its line is never offered`` () =
    task {
        let! state, dir, _, paths = loadWorkspace [ "Dead.fs", DEAD ]
        try
            // 1. The private member nothing calls goes alone; its type still checks.
            let! check =
                applyActionWith ANALYZERS state paths[0] DEAD "quickfix" "Remove unused 'Unused'" (9, 0) (9, "    member _.Value = shared")
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error check)

            // 2. Dead, but one binding declares two names: deleting it would decide for both.
            let! tuple = removalsAt ANALYZERS state paths[0] 12
            Assert.Empty(tuple)

            // 3. Dead, but its line also holds a comment the fix would take with it.
            let! commented = removalsAt ANALYZERS state paths[0] 13
            Assert.Empty(commented)

            // 4. Live, or public outside monorepo mode: nothing to remove.
            let! shared = removalsAt ANALYZERS state paths[0] 2
            let! live = removalsAt ANALYZERS state paths[0] 14
            Assert.Empty(shared)
            Assert.Empty(live)
        finally
            cleanup dir
    }

[<Fact>]
let ``the fix follows the analyzer: off, disabled or outside monorepo mode it offers nothing`` () =
    task {
        let! state, dir, _, paths = loadWorkspace [ "Dead.fs", DEAD ]
        try
            // 1. With the analyzers off, or the dead-code analyzer disabled, nothing is offered.
            let! off = removalsAt None state paths[0] 6
            let! disabled = removalsAt (Some(FSharpAnalyzers.AnalyzerConfig.Create(false, false))) state paths[0] 6
            Assert.Empty(off)
            Assert.Empty(disabled)

            // 2. In monorepo mode the unused public binding is dead, so it can go too.
            let! publicOutside = removalsAt ANALYZERS state paths[0] 14
            let! publicMonorepo = removalsAt MONOREPO state paths[0] 14
            Assert.Empty(publicOutside)
            Assert.Equal<string list>([ "Remove unused 'live'" ], publicMonorepo)

            // 3. A used binding is live in every mode.
            let! sharedMonorepo = removalsAt MONOREPO state paths[0] 2
            Assert.Empty(sharedMonorepo)
        finally
            cleanup dir
    }

[<Fact>]
let ``a declaration a signature file declares is never removed from its implementation alone`` () =
    task {
        let signature = source [ "module Lib"; ""; "val internal helper: int -> int"; "val api: int" ]
        let implementation = source [ "module Lib"; ""; "let internal helper x = x + 1"; "let api = 1" ]
        let! state, dir, _, paths = loadWorkspace [ "Lib.fsi", signature; "Lib.fs", implementation ]
        try
            // 1. The analyzer still finds both unused in monorepo mode.
            let config = MONOREPO.Value
            let! inSignature = FSharpAnalyzers.deadCodeInFile state config paths[0] CancellationToken.None
            let! inImplementation = FSharpAnalyzers.deadCodeInFile state config paths[1] CancellationToken.None
            let found = inSignature @ inImplementation |> List.map _.Message
            Assert.Contains(found, fun message -> message.Contains "'helper'")
            Assert.Contains(found, fun message -> message.Contains "'api'")

            // 2. Neither is removed from the implementation, whose signature still declares it.
            let! helper = removalsAt MONOREPO state paths[1] 2
            let! api = removalsAt MONOREPO state paths[1] 3
            Assert.Empty(helper)
            Assert.Empty(api)

            // 3. Nor from the signature file, which holds no implementation to delete.
            let! signatureHelper = removalsAt MONOREPO state paths[0] 2
            Assert.Empty(signatureHelper)
        finally
            cleanup dir
    }

//  0: module Nested
//  2: module Inner =
//  3:     let private nestedDead = 0
//  4:     let visible = 1
//  6: type Point =
//  7:     { X: int }
//  8:     member private p.Hidden() = p.X
//  9:     member p.Shown = p.X
let private NESTED =
    source
        [ "module Nested"
          ""
          "module Inner ="
          "    let private nestedDead = 0"
          "    let visible = 1"
          ""
          "type Point ="
          "    { X: int }"
          "    member private p.Hidden() = p.X"
          "    member p.Shown = p.X" ]

[<Fact>]
let ``dead code in a nested module or on a record goes whole, and its neighbours stay`` () =
    task {
        let! state, dir, _, paths = loadWorkspace [ "Nested.fs", NESTED ]
        try
            // 1. A nested module's dead binding goes; the module's live binding moves up.
            let! inModule =
                applyActionWith ANALYZERS state paths[0] NESTED "quickfix" "Remove unused 'nestedDead'" (3, 0) (3, "    let visible = 1")
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error inModule)

            // 2. A record's dead member goes; its live member moves up.
            let! onRecord =
                applyActionWith ANALYZERS state paths[0] NESTED "quickfix" "Remove unused 'Hidden'" (8, 0) (8, "    member p.Shown = p.X")
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error onRecord)

            // 3. The live public neighbours offer nothing.
            let! visible = removalsAt ANALYZERS state paths[0] 4
            let! shown = removalsAt ANALYZERS state paths[0] 9
            Assert.Empty(visible)
            Assert.Empty(shown)
        finally
            cleanup dir
    }

/// The single deletion of the dead binding offered on 0-based `line`.
let private soleRemoval state path line =
    task {
        let! fixes, actions = actionsWith ANALYZERS state path line 0
        let edit = (resolveSole fixes "Remove unused 'dead'" actions).Value
        return Assert.Single(Assert.Single(edit.DocumentChanges).Edits)
    }

[<Fact>]
let ``removing the last declaration leaves one gap, with or without a final line break`` () =
    task {
        let tail = source [ "module Tail"; ""; "let live = 1"; ""; "let private dead = 2" ]
        let last = "module Last\n\nlet private dead = 2\nlet other = 1"
        let! state, dir, _, paths = loadWorkspace [ "Tail.fs", tail; "Last.fs", last ]
        try
            // 1. A file's last declaration takes the blank line above it, so no gap trails the file.
            let! atEnd = soleRemoval state paths[0] 4
            Assert.Equal((3, 5), (atEnd.StartLine, atEnd.EndLine))
            Assert.Equal("module Tail\n\nlet live = 1\n", applyEdit tail atEnd)

            // 2. Above a last line with no line break, it goes alone and the gap above it stays.
            let! beforeLast = soleRemoval state paths[1] 2
            Assert.Equal((2, 3), (beforeLast.StartLine, beforeLast.EndLine))
            Assert.Equal("module Last\n\nlet other = 1", applyEdit last beforeLast)
        finally
            cleanup dir
    }
