/// Loads the project that owns a file no loaded project compiles, beside the workspace's
/// own, so a file opened from outside the solution still answers (GitHub #414).
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING].
module SharpLsp.Sidecar.FSharp.FSharpOwningProject

open System
open System.Collections.Concurrent
open System.Collections.Generic
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

/// An owner adoption in flight, keyed by the workspace generation that requested it and
/// the owner project, so a workspace replacement never reuses the previous load.
/// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING]
[<Struct>]
type private AdoptionKey =
    { Epoch: int
      Owner: string }

type private AdoptionKeyComparer() =
    interface IEqualityComparer<AdoptionKey> with
        member _.Equals(left, right) =
            left.Epoch = right.Epoch && NativePaths.Comparer.Equals(left.Owner, right.Owner)

        member _.GetHashCode(key) =
            HashCode.Combine(key.Epoch, NativePaths.Comparer.GetHashCode(key.Owner))

/// The owning-project loads in flight for each workspace, so a burst of edits loads once.
let private pending =
    ConditionalWeakTable<FSharpWorkspaceState, ConcurrentDictionary<AdoptionKey, Task>>()

/// Load `owner`'s design-time build, then commit it beside the workspace's projects only
/// when the workspace generation that requested it is still current; a replacement in
/// between returns false and discards the stale adoption.
/// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING]
let private load (state: FSharpWorkspaceState) (owner: string) (epoch: int) (ct: CancellationToken) =
    task {
        let! entry = FSharpDesignTime.loadEntry state.Checker (buildProjectOptions state) owner ct
        match FSharpDesignTime.builtFramework entry with
        | Some framework -> do! prepareReferencedBuilds state entry framework ct
        | None -> ()
        return FSharpWorkspace.commitAdoption state epoch owner entry
    }

let private needsOwner (state: FSharpWorkspaceState) (filePath: string) =
    (state.IsLoaded || state.LastLoadWasEmpty)
    && (NativePaths.HasExtension(filePath, ".fs") || NativePaths.HasExtension(filePath, ".fsi"))
    && (projectOf state filePath).IsNone

/// Load `owner` now, logging the outcome; never throws.
let private adoptNow
    (state: FSharpWorkspaceState)
    (inFlight: ConcurrentDictionary<AdoptionKey, Task>)
    (key: AdoptionKey)
    (owner: string)
    (path: string)
    : Task =
    task {
        try
            try
                match! load state owner key.Epoch CancellationToken.None with
                | true -> Log.Information("F# loaded {Project}, which owns {File}, beside the workspace", owner, path)
                | false ->
                    Log.Debug("F# dropped a superseded owner adoption for {Project}, which owns {File}", owner, path)
            with ex ->
                Log.Warning(ex, "F# could not load {Project}, which owns {File}", owner, path)
        finally
            inFlight.TryRemove(key) |> ignore
    }

/// Load the project owning `filePath` in the background, when no loaded project compiles it.
let adoptOwner (state: FSharpWorkspaceState) (filePath: string) : Task<Task option> =
    task {
        let path = NativePaths.NormalizeFullPath filePath
        let epoch = FSharpWorkspace.currentEpoch state

        if needsOwner state path then
            match! tryOwningProject state path with
            | None -> return None
            | Some owner ->
                let inFlight =
                    pending.GetValue(state, fun _ -> ConcurrentDictionary<AdoptionKey, Task>(AdoptionKeyComparer()))

                let key = { Epoch = epoch; Owner = owner }
                return Some(inFlight.GetOrAdd(key, fun _ -> Task.Run(fun () -> adoptNow state inFlight key owner path)))
        else
            return None
    }
