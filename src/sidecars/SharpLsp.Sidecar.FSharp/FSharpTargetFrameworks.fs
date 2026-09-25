/// The active target framework of a multi-targeted F# project: which one it
/// answers from, and switching the WHOLE project to another. Implements [NETFX-CONTEXT].
module SharpLsp.Sidecar.FSharp.FSharpTargetFrameworks

open System.Collections.Generic
open System.IO
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp.FSharpDesignTime
open SharpLsp.Sidecar.FSharp.FSharpWorkspace

let private resultOf (entry: FSharpProjectEntry) =
    TargetFrameworkResult(
        Active = Option.toObj entry.Active,
        Available = (Array.ofList entry.Frameworks :> IReadOnlyList<string>),
        Project = entry.Path
    )

let private notFound (filePath: string) = Error $"Document not found: {filePath}"

/// The active framework and every framework of the project that compiles `filePath`;
/// nothing to choose, and no project, when no loaded project compiles it.
let current (state: FSharpWorkspaceState) (filePath: string) : Result<TargetFrameworkResult, string> =
    projectOf state filePath
    |> Option.map resultOf
    |> Option.defaultWith TargetFrameworkResult
    |> Ok

let private isPrimary (state: FSharpWorkspaceState) (entry: FSharpProjectEntry) =
    state.ProjectOptions
    |> Option.exists (fun primary -> NativePaths.AreEqual(primary.ProjectFileName, entry.Path))

/// Answer from `framework`'s options from now on; the primary project also
/// becomes the workspace's options for project-wide queries.
let private activate (state: FSharpWorkspaceState) (entry: FSharpProjectEntry) framework options =
    if isPrimary state entry then
        state.ProjectOptions <- Some options

    entry.Active <- Some framework
    entry.Options <- options
    resultOf entry

/// Switch the project that compiles `filePath` to `framework`.
let switch (state: FSharpWorkspaceState) (filePath: string) (framework: string) ct =
    task {
        match projectOf state filePath with
        | None -> return notFound filePath
        | Some entry when not (List.contains framework entry.Frameworks) ->
            return Error $"{framework} is not a target framework of {Path.GetFileName entry.Path}"
        | Some entry ->
            let! options = optionsForFramework state.Checker entry framework ct
            return options |> Result.map (activate state entry framework)
    }
