/// Owner-adoption epoch helpers: the workspace generation that retires a background
/// adoption whose workspace was replaced before it committed.
/// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING]
module SharpLsp.Sidecar.FSharp.FSharpOwningEpoch

open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.FSharpWorkspace

/// Begin replacing the workspace's project graph: advance its generation before any
/// await so an adoption already in flight against the old graph is retired.
/// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING]
let internal beginReplacement (state: FSharpWorkspaceState) =
    lock state.LifecycleLock (fun () -> state.Epoch <- state.Epoch + 1)

/// The current workspace generation, read under the lifecycle lock so an adoption
/// captures a value that can only advance afterwards. [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING]
let internal currentEpoch (state: FSharpWorkspaceState) =
    lock state.LifecycleLock (fun () -> state.Epoch)

/// Apply an owner adoption's final mutation only when the workspace generation that
/// requested it is still current; checked and applied atomically. False means a
/// replacement superseded it. [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING]
let internal commitAdoption
    (state: FSharpWorkspaceState)
    (epoch: int)
    (owner: string)
    (entry: FSharpDesignTime.FSharpProjectEntry)
    : bool =
    lock state.LifecycleLock (fun () ->
        if state.Epoch <> epoch then
            false
        else
            let key = NativePaths.NormalizeFullPath owner
            state.References[key] <- FSharpProjectGraph.fsharpReferences owner
            state.Projects[key] <- entry
            if state.LastLoadWasEmpty then
                state.ProjectOptions <- Some entry.Options
                state.LastLoadWasEmpty <- false
                state.IsLoaded <- true
            true)
