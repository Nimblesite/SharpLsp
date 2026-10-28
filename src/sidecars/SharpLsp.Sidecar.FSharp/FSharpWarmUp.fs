/// Background warm-up of every loaded project's check, so the user's first
/// solution-wide query (references, rename, lens counts) answers warm instead
/// of paying a full check (GitHub #513). The host walks the projects one
/// request at a time, as preemptible background work: an interactive request
/// cancels the check in flight, and the next attempt resumes from the checks
/// FCS already holds. Implements [SHARPLSP-FEATURES-WARM-UP].
module SharpLsp.Sidecar.FSharp.FSharpWarmUp

open System.Threading
open FSharp.Compiler.CodeAnalysis
open SharpLsp.Sidecar.Common

/// The loaded projects, wired as every query sees them, in project-path order:
/// one order across a workspace's requests, so an index names one project.
let private projects (state: FSharpWorkspace.FSharpWorkspaceState) : FSharpProjectOptions list =
    state.Projects.Values
    |> Seq.map (fun entry -> FSharpWorkspace.wired state entry.Options)
    |> Seq.sortWith (fun a b -> NativePaths.SpellingComparer.Compare(a.ProjectFileName, b.ProjectFileName))
    |> List.ofSeq

/// Check the `index`-th loaded project, as a solution-wide query would, build
/// its referenced entities for completion, and answer with how many projects
/// the workspace holds. An index past the end checks nothing.
let warmProject (state: FSharpWorkspace.FSharpWorkspaceState) (index: int) (ct: CancellationToken) =
    task {
        let loaded = projects state

        match List.tryItem index loaded with
        | Some options ->
            let! checkedProjects = FSharpWorkspace.checkAllWithCancellation state [ options ] ct
            checkedProjects |> List.iter (fun results -> FSharpEntityIndex.warm state results.ProjectContext ct)
            return loaded.Length
        | None -> return loaded.Length
    }
