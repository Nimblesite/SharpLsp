/// Verify the selected compiler inputs without retaining diagnostic results.
/// Implements [DIAG-TRUTH-GUARANTEES], [NETFX-CONTEXT].
module SharpLsp.Sidecar.FSharp.FSharpDiagnosticInputs

open FSharp.Compiler.CodeAnalysis
open SharpLsp.Sidecar.Common

/// A different, successfully evaluated framework keeps its independent compiler identity.
let private ownError (state: FSharpWorkspace.FSharpWorkspaceState) (options: FSharpProjectOptions) =
    state.Projects.Values
    |> Seq.tryPick (fun entry ->
        if NativePaths.AreEqual(entry.Path, options.ProjectFileName) && entry.Options.ProjectId = options.ProjectId then
            entry.SdkError |> Option.map (sprintf "SDK compiler inputs unavailable: %s")
        else None)

/// Walk the existing acyclic compiler graph; independent projects remain available.
let rec failure state (options: FSharpProjectOptions) =
    ownError state options
    |> Option.orElseWith (fun () ->
        options.ReferencedProjects
        |> Array.tryPick (function
            | FSharpReferencedProject.FSharpReference(_, referenced) -> failure state referenced
            | _ -> None))

/// The project query uses the same selected, wired compiler inputs as document queries.
let project state projectPath =
    let owner = FSharpWorkspace.projectOptions state
                |> List.tryFind (fun options -> NativePaths.AreEqual(options.ProjectFileName, projectPath))
    match owner |> Option.map (FSharpWorkspace.wired state) with
    | None -> Error "The requested compiler project is not loaded."
    | Some options ->
        match failure state options with
        | Some reason -> Error reason
        | None -> Ok options
