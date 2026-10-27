/// Workspace loading and replacement: turning projects, solutions, and scripts into
/// the loaded F# project graph, and clearing it when a selection has no F# projects.
/// [DIAG-RESTORE]
module SharpLsp.Sidecar.FSharp.FSharpWorkspaceLoading

open System
open System.IO
open System.Threading
open System.Threading.Tasks
open FSharp.Compiler.CodeAnalysis
open Serilog
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.FSharpOwningEpoch
open SharpLsp.Sidecar.FSharp.FSharpWorkspace

let private activateWorkspace
    (state: FSharpWorkspaceState)
    (options: FSharpProjectOptions)
    (path: string)
    (kind: string)
    =
    state.ProjectOptions <- Some options
    state.IsLoaded <- true
    let files = String.Join(", ", options.SourceFiles |> Array.map NativePaths.NameOf)
    Log.Debug("F# {Kind} loaded from {Path} with files: [{Files}]", kind, path, files)

/// Replace the loaded project graph when a valid workspace has no F# projects.
let private clearWorkspace (state: FSharpWorkspaceState) =
    state.LastLoadWasEmpty <- true
    state.ProjectOptions <- None
    state.IsLoaded <- false
    state.Projects.Clear()
    state.References.Clear()
    state.CSharpBuilds.Clear()
    state.CompileSources.Clear()
    state.Checker.InvalidateAll()

/// Load EVERY project; the first one is the workspace's for project-wide queries.
let private loadProjects (state: FSharpWorkspaceState) (fsprojFiles: string array) autoRestore ct =
    task {
        if fsprojFiles.Length = 0 then
            clearWorkspace state
            return Error "No .fsproj found"
        else
            try
                state.CompileSources.Clear()
                let fallback path ct = buildProjectOptions state path ct
                let! entries = fsprojFiles |> Array.map (fun path -> FSharpDesignTime.loadEntryWithRestore state.Checker fallback path autoRestore ct) |> Task.WhenAll
                state.Projects.Clear()
                state.References.Clear()

                for entry in entries do
                    let key = NativePaths.NormalizeFullPath entry.Path
                    state.Projects[key] <- entry
                    state.References[key] <- FSharpProjectGraph.fsharpReferences entry.Path

                for entry in entries do
                    match FSharpDesignTime.builtFramework entry with
                    | Some framework -> do! prepareReferencedBuilds state entry framework ct
                    | None -> ()

                Log.Debug("F# workspace loaded {Count} project(s); {Path} is primary", entries.Length, fsprojFiles[0])
                activateWorkspace state entries[0].Options fsprojFiles[0] "workspace"
                return Ok()
            with ex ->
                return Error ex.Message
    }

let private logScriptDiagnostics (scriptPath: string) (diagnostics: FSharp.Compiler.Diagnostics.FSharpDiagnostic seq) =
    diagnostics
    |> Seq.iter (fun diagnostic ->
        Log.Debug("F# script option diagnostic for {Path}: {Message}", scriptPath, diagnostic.Message))

let private loadScript (state: FSharpWorkspaceState) scriptPath ct =
    task {
        let source = readSource state scriptPath
        let! options, diagnostics = FSharpProjectLoading.scriptOptions state.Checker scriptPath source ct
        logScriptDiagnostics scriptPath diagnostics
        clearWorkspace state
        state.LastLoadWasEmpty <- false
        activateWorkspace state options scriptPath "script"
        return Ok()
    }

let private loadDiscoveredProject (state: FSharpWorkspaceState) (discovered: Result<string array, string>) autoRestore ct =
    task {
        match discovered with
        | Error message ->
            Log.Debug("F# workspace diagnostic: {Message}", message)
            return Error message
        | Ok projectFiles ->
            match! loadProjects state projectFiles autoRestore ct with
            | Ok() -> return Ok()
            | Error message ->
                Log.Debug("F# workspace load failed: {Message}", message)
                return Error message
    }

/// Load a project, solution, workspace directory, or self-describing script.
let loadProjectWithCancellation (state: FSharpWorkspaceState) (path: string) (ct: CancellationToken) =
    task {
        try
            beginReplacement state
            state.LastLoadWasEmpty <- false
            if File.Exists(path) && FSharpProjectLoading.isScriptPath path then
                return! loadScript state (NativePaths.NormalizeFullPath path) ct
            else
                let! discovered = FSharpProjectLoading.discoverFsprojFiles path ct
                return! loadDiscoveredProject state discovered true ct
        with ex ->
            Log.Debug(ex, "F# workspace load failed")
            return Error ex.Message
    }

let loadProject (state: FSharpWorkspaceState) (path: string) =
    loadProjectWithCancellation state path CancellationToken.None

let private restoreWorkspaceInputs projects autoRestore ct =
    task {
        if not autoRestore then return Ok()
        else
            let! result = WorkspaceRestore.EnsureProjectsAsync(projects, ct)
            return result.Match((fun _ -> Ok()), Error)
    }

/// Explicit workspace opens restore stale SDK inputs before compiler creation. [DIAG-RESTORE]
let loadWorkspaceWithCancellation (state: FSharpWorkspaceState) path autoRestore ct =
    task {
        beginReplacement state
        state.LastLoadWasEmpty <- false
        if FSharpProjectLoading.isScriptPath path then
            return! loadProjectWithCancellation state path ct
        else
            let! discovered = FSharpProjectLoading.discoverFsprojFiles path ct
            match discovered with
            | Error message -> return Error message
            | Ok projects ->
                match! restoreWorkspaceInputs projects autoRestore ct with
                | Error message -> return Error message
                | Ok () -> return! loadDiscoveredProject state (Ok projects) autoRestore ct
    }
