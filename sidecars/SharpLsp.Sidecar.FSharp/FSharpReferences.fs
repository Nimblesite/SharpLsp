/// References and document highlights for the F# sidecar.
/// References are project-wide ([FS-REFS-PROJECT]); highlights stay file-local.
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

/// Resolve the symbol at a position and return all of its uses across the
/// loaded project. Falls back to current-file uses if the project check is
/// unavailable. Shared by references ([FS-REFS-PROJECT]), rename, and code lens.
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
                    let! proj = FSharpWorkspace.checkProject state
                    match proj with
                    | Some projResults -> return projResults.GetUsesOfSymbol(symbolUse.Symbol)
                    | None -> return checkResults.GetUsesOfSymbolInFile(symbolUse.Symbol)
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
