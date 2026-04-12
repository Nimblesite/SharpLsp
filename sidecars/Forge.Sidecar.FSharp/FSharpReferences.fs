/// References and document highlights for the F# sidecar.
module Forge.Sidecar.FSharp.FSharpReferences

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols

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

/// Convert an FCS symbol use range to a DefinitionLocation (1-based → 0-based).
let private toDefinitionLocation (r: FSharp.Compiler.Text.Range) : FSharpWorkspace.DefinitionLocation =
    { FilePath = r.FileName
      Line = r.StartLine - 1
      Character = r.StartColumn
      EndLine = r.EndLine - 1
      EndCharacter = r.EndColumn }

/// Find all references to the symbol at a position (current file).
let getReferences
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    (includeDeclaration: bool)
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
                            if not includeDeclaration && su.IsFromDefinition then
                                None
                            else
                                let r = su.Range
                                if r.FileName = "" then None
                                else Some(toDefinitionLocation r))
                        |> Array.toList
        with ex ->
            eprintfn $"[F# References] Exception: {ex.Message}"
            return []
    }

/// Find document highlights for the symbol at a position (current file).
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
            eprintfn $"[F# DocumentHighlight] Exception: {ex.Message}"
            return []
    }
