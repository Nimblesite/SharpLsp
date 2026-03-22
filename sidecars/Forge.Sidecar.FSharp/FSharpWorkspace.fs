/// Manages the F# workspace: project loading and semantic queries via FCS.
module Forge.Sidecar.FSharp.FSharpWorkspace

open System
open System.IO
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Text
open FSharp.Compiler.Tokenization
open Forge.Sidecar.FSharp.Hover

/// Workspace state holding the FSharpChecker and loaded project options.
[<NoComparison; NoEquality>]
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

/// Load a project from a path (finds .fsproj or .fsx).
let loadProject (state: FSharpWorkspaceState) (path: string) =
    task {
        try
            // For now, create script-based options.
            // Full .fsproj support requires Ionide.ProjInfo (Phase 3).
            let dummyScript = Path.Combine(path, "script.fsx")
            let! options, _diagnostics =
                state.Checker.GetProjectOptionsFromScript(
                    dummyScript,
                    SourceText.ofString "",
                    assumeDotNetFramework = false)
            state.ProjectOptions <- Some options
            state.IsLoaded <- true
            eprintfn $"F# workspace loaded from {path}"
            return Ok()
        with ex ->
            eprintfn $"F# workspace load failed: {ex.Message}"
            return Error ex.Message
    }

/// Extract hover from FSharpCheckFileResults.
let private extractToolTip
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
        let island =
            QuickParse.GetCompleteIdentifierIsland true lineText character

        match island with
        | None -> None
        | Some(name, _, _) ->
            let names = [ name ]
            let tip =
                checkResults.GetToolTip(
                    fcsLine, character, lineText, names, FSharpTokenTag.Identifier)

            match FSharpHoverBuilder.renderToolTip tip with
            | Some markdown ->
                Some(markdown, line, character, line, character + name.Length)
            | None -> None

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

                let! _parseResults, checkAnswer =
                    state.Checker.ParseAndCheckFileInProject(
                        filePath,
                        0,
                        sourceText,
                        state.ProjectOptions.Value)

                match checkAnswer with
                | FSharpCheckFileAnswer.Succeeded checkResults ->
                    return extractToolTip checkResults source line character
                | FSharpCheckFileAnswer.Aborted ->
                    eprintfn "[F# Hover] Check aborted"
                    return None
        with ex ->
            eprintfn $"[F# Hover] Exception: {ex.Message}"
            return None
    }
