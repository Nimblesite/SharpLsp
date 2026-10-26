/// Loads the project that owns a file no loaded project compiles, beside the workspace's
/// own, so a file opened from outside the solution still answers (GitHub #414).
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING].
module SharpLsp.Sidecar.FSharp.FSharpOwningProject

open System
open System.Collections.Concurrent
open System.IO
open System.Runtime.CompilerServices
open System.Threading
open System.Threading.Tasks
open Serilog
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.FSharpWorkspace

/// The `.fsproj` files in `directory`, in name order; none when it cannot be read.
let private projectsIn (directory: string) =
    try
        Directory.GetFiles(directory, "*.fsproj") |> Array.sort
    with _ ->
        [||]

/// True when `project` lists `filePath` among its MSBuild-evaluated Compile items.
let private compiles (state: FSharpWorkspaceState) (filePath: string) (project: string) =
    task {
        match! FSharpWorkspace.compileSources state project CancellationToken.None with
        | Ok sources -> return sources |> Array.exists (fun source -> NativePaths.AreEqual(source, filePath))
        | Error reason ->
            Log.Debug("F# project {Project} compile items unavailable: {Reason}", project, reason)
            return false
    }

/// The nearest `.fsproj` at or above `filePath`'s directory that compiles it.
let tryOwningProject (state: FSharpWorkspaceState) (filePath: string) =
    let rec firstOwner (projects: string array) (index: int) =
        task {
            if index >= projects.Length then
                return None
            else
                let! owns = compiles state filePath projects[index]
                if owns then return Some projects[index]
                else return! firstOwner projects (index + 1)
        }

    let rec search (directory: string) =
        task {
            match! firstOwner (projectsIn directory) 0 with
            | Some owner -> return Some owner
            | None ->
                let parent = NativePaths.DirectoryOf directory
                if String.IsNullOrEmpty parent || NativePaths.AreEqual(parent, directory) then
                    return None
                else
                    return! search parent
        }

    search (NativePaths.DirectoryOf filePath)

/// Load `owner` into `state` beside the workspace's projects, its references prepared.
let private load (state: FSharpWorkspaceState) (owner: string) (ct: CancellationToken) =
    task {
        let! entry = FSharpDesignTime.loadEntry state.Checker (buildProjectOptions state) owner ct
        let key = NativePaths.NormalizeFullPath owner
        match FSharpDesignTime.builtFramework entry with
        | Some framework -> do! prepareReferencedBuilds state entry framework ct
        | None -> ()
        state.References[key] <- FSharpProjectGraph.fsharpReferences owner
        state.Projects[key] <- entry
        if state.LastLoadWasEmpty then
            state.ProjectOptions <- Some entry.Options
            state.LastLoadWasEmpty <- false
            state.IsLoaded <- true
    }

/// The owning-project loads in flight for each workspace, so a burst of edits loads once.
let private pending = ConditionalWeakTable<FSharpWorkspaceState, ConcurrentDictionary<string, Task>>()

let private needsOwner (state: FSharpWorkspaceState) (filePath: string) =
    (state.IsLoaded || state.LastLoadWasEmpty)
    && (NativePaths.HasExtension(filePath, ".fs") || NativePaths.HasExtension(filePath, ".fsi"))
    && (projectOf state filePath).IsNone

/// Load `owner` now, logging the outcome; never throws.
let private adoptNow state (inFlight: ConcurrentDictionary<string, Task>) (owner: string) path : Task =
    task {
        try
            try
                do! load state owner CancellationToken.None
                Log.Information("F# loaded {Project}, which owns {File}, beside the workspace", owner, path)
            with ex ->
                Log.Warning(ex, "F# could not load {Project}, which owns {File}", owner, path)
        finally
            inFlight.TryRemove(owner) |> ignore
    }

/// Load the project owning `filePath` in the background, when no loaded project compiles it.
let adoptOwner (state: FSharpWorkspaceState) (filePath: string) : Task<Task option> =
    task {
        let path = NativePaths.NormalizeFullPath filePath

        if needsOwner state path then
            match! tryOwningProject state path with
            | None -> return None
            | Some owner ->
                let inFlight = pending.GetValue(state, fun _ -> ConcurrentDictionary(NativePaths.Comparer))
                return Some(inFlight.GetOrAdd(owner, fun _ -> Task.Run(fun () -> adoptNow state inFlight owner path)))
        else
            return None
    }
