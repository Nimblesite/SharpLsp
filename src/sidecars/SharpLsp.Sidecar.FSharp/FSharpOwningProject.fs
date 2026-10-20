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

/// True when `project` lists `filePath` among its Compile items.
let private compiles (filePath: string) (project: string) =
    try
        FSharpProjectLoading.parseFsprojSourceFiles project
        |> Array.exists (fun source -> NativePaths.AreEqual(source, filePath))
    with ex ->
        Log.Debug(ex, "F# project {Project} could not be read", project)
        false

/// The nearest `.fsproj` at or above `filePath`'s directory that compiles it.
let tryOwningProject (filePath: string) =
    let rec search (directory: string) =
        match projectsIn directory |> Array.tryFind (compiles filePath) with
        | Some owner -> Some owner
        | None ->
            let parent = NativePaths.DirectoryOf directory
            if String.IsNullOrEmpty parent || NativePaths.AreEqual(parent, directory) then None else search parent

    search (NativePaths.DirectoryOf filePath)

/// Load `owner` into `state` beside the workspace's projects, its references prepared.
let private load (state: FSharpWorkspaceState) (owner: string) (ct: CancellationToken) =
    task {
        let! entry = FSharpDesignTime.loadEntry state.Checker (buildProjectOptions state) owner ct
        let key = NativePaths.NormalizeFullPath owner
        state.References[key] <- FSharpProjectGraph.fsharpReferences owner
        state.Projects[key] <- entry

        match FSharpDesignTime.builtFramework entry with
        | Some framework -> do! prepareReferencedBuilds state entry framework ct
        | None -> ()
    }

/// The owning-project loads in flight for each workspace, so a burst of edits loads once.
let private pending = ConditionalWeakTable<FSharpWorkspaceState, ConcurrentDictionary<string, Task>>()

let private needsOwner (state: FSharpWorkspaceState) (filePath: string) =
    state.IsLoaded
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
let adoptOwner (state: FSharpWorkspaceState) (filePath: string) =
    let path = NativePaths.NormalizeFullPath filePath

    match if needsOwner state path then tryOwningProject path else None with
    | None -> Task.CompletedTask
    | Some owner ->
        let inFlight = pending.GetValue(state, fun _ -> ConcurrentDictionary(NativePaths.Comparer))
        inFlight.GetOrAdd(owner, fun _ -> Task.Run(fun () -> adoptNow state inFlight owner path))
