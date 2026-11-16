/// F# compile-order awareness: a name FS0039 cannot find that a LATER file of
/// the same project declares is a file-order problem, not a missing import. The
/// quick fix moves the declaring file above the current one; the host makes the
/// move through the MSBuild DOM. Implements [REFACTOR-FSHARP-FILE-ORDER].
module SharpLsp.Sidecar.FSharp.FSharpFileOrder

open System
open System.Threading
open FSharp.Compiler.Text
open Serilog
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// Whether a declared name is `name` or ends in it: `module P.B` declares `B`.
let private names (name: string) (declared: string) =
    declared = name || declared.EndsWith("." + name, StringComparison.Ordinal)

/// Whether the file declares `name` at its top level or one level in. Parse-only,
/// through the overlay so unsaved declarations count. [HOVER-FSHARP-OVERLAY]
let private declares (state: FSharpWorkspace.FSharpWorkspaceState) options (name: string) (filePath: string) =
    task {
        let source = FSharpWorkspace.readSource state filePath |> SourceText.ofString
        let! parsed = state.Checker.ParseFile(filePath, source, options)
        return
            parsed.GetNavigationItems().Declarations
            |> Array.exists (fun top ->
                names name top.Declaration.LogicalName
                || top.Nested |> Array.exists (fun nested -> names name nested.LogicalName))
    }

/// The files compiled after `filePath`; none when the project does not list it.
let private laterFiles (files: string array) (filePath: string) =
    files
    |> Array.tryFindIndex (fun file -> NativePaths.AreEqual(file, filePath))
    |> Option.map (fun index -> files[index + 1 ..])
    |> Option.defaultValue [||]

/// The action moving `later` directly above `filePath`. It has no text edit: the
/// command the host builds from its reference is the whole fix.
let private moveAction (project: string) (filePath: string) (name: string) (later: string) =
    let directory = NativePaths.DirectoryOf project
    let moved, above = NativePaths.NameOf later, NativePaths.NameOf filePath
    let title =
        $"Move {moved} above {above} in {NativePaths.NameOf project} — {moved} declares '{name}' but compiles after {above}"
    let reference =
        ReferenceImport.ToCompileOrder(
            project,
            NativePaths.RelativeTo(directory, later),
            NativePaths.RelativeTo(directory, filePath)
        )
    { Title = title; Kind = "quickfix"; IsPreferred = false; Edits = [] }, reference

let rec private declaring state options name (files: string list) =
    task {
        match files with
        | [] -> return []
        | file :: rest ->
            let! declared = declares state options name file
            let! more = declaring state options name rest
            return if declared then file :: more else more
    }

/// One move action per later file of the project that declares `name`, in
/// compile order.
let actions (state: FSharpWorkspace.FSharpWorkspaceState) (filePath: string) (name: string) =
    task {
        match FSharpWorkspace.optionsFor state filePath with
        | None -> return []
        | Some own ->
            match! FSharpWorkspace.compileSources state own.ProjectFileName CancellationToken.None with
            | Error reason ->
                Log.Warning("F# compile order of {Project} unavailable: {Reason}", own.ProjectFileName, reason)
                return []
            | Ok files ->
                let parsing = fst (state.Checker.GetParsingOptionsFromProjectOptions own)
                let! found = declaring state parsing name (laterFiles files filePath |> List.ofArray)
                return found |> List.map (moveAction own.ProjectFileName filePath name)
    }
