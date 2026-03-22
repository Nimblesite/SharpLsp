/// Manages the F# workspace: project loading and semantic queries via FCS.
module Forge.Sidecar.FSharp.FSharpWorkspace

open System
open System.IO
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Text
open Forge.Sidecar.FSharp.Hover

/// Workspace state holding the FSharpChecker and loaded project options.
type FSharpWorkspaceState =
    { Checker: FSharpChecker
      mutable ProjectOptions: FSharpProjectOptions option
      mutable IsLoaded: bool }

/// Create a new workspace with an FSharpChecker.
let create () : FSharpWorkspaceState =
    let checker = FSharpChecker.Create(keepAssemblyContents = true)
    { Checker = checker
      ProjectOptions = None
      IsLoaded = false }

/// Load a project from a .fsproj path.
let loadProject (state: FSharpWorkspaceState) (projectPath: string) =
    task {
        try
            let! options, diagnostics =
                state.Checker.GetProjectOptionsFromScript(
                    projectPath,
                    SourceText.ofString "",
                    assumeDotNetFramework = false)
            state.ProjectOptions <- Some options
            state.IsLoaded <- true
            eprintfn $"F# workspace loaded: {projectPath}"
            return Ok()
        with ex ->
            eprintfn $"F# workspace load failed: {ex.Message}"
            return Error ex.Message
    }

/// Get hover information at a position in an F# file.
let getHover
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            if not state.IsLoaded then
                return None
            else
                let source = File.ReadAllText(filePath)
                let sourceText = SourceText.ofString source

                let! parseResults, checkAnswer =
                    state.Checker.ParseAndCheckFileInProject(
                        filePath,
                        0,
                        sourceText,
                        state.ProjectOptions.Value)

                match checkAnswer with
                | FSharpCheckFileAnswer.Succeeded checkResults ->
                    return getToolTip checkResults source line character
                | FSharpCheckFileAnswer.Aborted ->
                    eprintfn "[F# Hover] Check aborted"
                    return None
        with ex ->
            eprintfn $"[F# Hover] Exception: {ex.Message}"
            return None
    }

/// Extract hover from FSharpCheckFileResults.
let private getToolTip
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : (string * int * int * int * int) option =
    let lines = source.Split('\n')
    if line >= lines.Length then
        None
    else
        let lineText = lines[line]
        // FCS uses 1-based lines.
        let fcsLine = line + 1

        // Find the identifier at the position.
        let names =
            match QuickParse.GetCompleteIdentifierIsland true lineText character with
            | Some(island, _) -> [ island ]
            | None -> []

        if names.IsEmpty then
            None
        else
            let tip =
                checkResults.GetToolTip(
                    fcsLine, character, lineText, names, FSharpTokenTag.Identifier)

            match FSharpHoverBuilder.renderToolTip tip with
            | Some markdown ->
                // Return markdown + token range.
                Some(markdown, line, character, line, character + names.Head.Length)
            | None -> None
