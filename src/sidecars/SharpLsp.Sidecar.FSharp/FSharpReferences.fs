/// References and document highlights for the F# sidecar.
/// References are project-wide ([REFERENCES-FSHARP-FIND]); highlights stay file-local.
module SharpLsp.Sidecar.FSharp.FSharpReferences

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open Serilog

/// Result type for document highlights: location + read/write kind.
type HighlightLocation =
    { FilePath: string
      StartLine: int
      StartCharacter: int
      EndLine: int
      EndCharacter: int
      Kind: int }

/// Check whether an FSharpSymbolUse represents a write (definition or pattern).
let private isWriteUse (su: FSharpSymbolUse) =
    su.IsFromDefinition || su.IsFromPattern

let private getFileUsages
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (symbol: FSharpSymbol)
    (filePath: string)
    =
    task {
        let! checkedFile = FSharpWorkspace.checkFile state filePath
        return
            checkedFile
            |> Option.map (fun (results, _) -> results.GetUsesOfSymbolInFile(symbol))
            |> Option.defaultValue [||]
    }

let private getOverlayAwareProjectUsages
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (symbol: FSharpSymbol)
    =
    task {
        let uses = ResizeArray<FSharpSymbolUse>()
        for filePath in state.ProjectOptions.Value.SourceFiles do
            let! fileUses = getFileUsages state symbol filePath
            uses.AddRange(fileUses)
        return uses.ToArray()
    }

/// Resolve the symbol at a position and return all of its uses across the
/// loaded project. Falls back to current-file uses if the project check is
/// unavailable. Shared by references ([REFERENCES-FSHARP-FIND]), rename, and code lens.
let getProjectUsages
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            match fileCheck with
            | None -> return [||]
            | Some(checkResults, source) ->
                match FSharpWorkspace.getSymbolUse checkResults source line character with
                | None -> return [||]
                | Some symbolUse ->
                    if state.ProjectOptions.IsNone then
                        return checkResults.GetUsesOfSymbolInFile(symbolUse.Symbol)
                    else
                        return! getOverlayAwareProjectUsages state symbolUse.Symbol
        with ex ->
            Log.Debug(ex, "[F# ProjectUsages] failed")
            return [||]
    }

/// Find all references to the symbol at a position (project-wide).
let getReferences
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    (includeDeclaration: bool)
    =
    task {
        let! uses = getProjectUsages state filePath line character
        return
            uses
            |> Array.choose (fun (su: FSharpSymbolUse) ->
                if not includeDeclaration && su.IsFromDefinition then None
                else FSharpWorkspace.rangeToLocation su.Range)
            |> Array.toList
    }

/// Find document highlights for the symbol at a position (current file only).
let getDocumentHighlights
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = FSharpWorkspace.checkFile state filePath
            match result with
            | None -> return []
            | Some(checkResults, source) ->
                match FSharpWorkspace.getSymbolUse checkResults source line character with
                | None -> return []
                | Some symbolUse ->
                    let usesInFile =
                        checkResults.GetUsesOfSymbolInFile(symbolUse.Symbol)
                    return
                        usesInFile
                        |> Array.choose (fun (su: FSharpSymbolUse) ->
                            let r = su.Range
                            if r.FileName = "" then None
                            else
                                let kind = if isWriteUse su then 3 else 2
                                Some
                                    { FilePath = r.FileName
                                      StartLine = r.StartLine - 1
                                      StartCharacter = r.StartColumn
                                      EndLine = r.EndLine - 1
                                      EndCharacter = r.EndColumn
                                      Kind = kind })
                        |> Array.toList
        with ex ->
            Log.Debug(ex, "[F# DocumentHighlight] failed")
            return []
    }
