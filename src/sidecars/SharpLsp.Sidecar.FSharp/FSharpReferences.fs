/// References and document highlights for the F# sidecar.
/// References are project-wide ([REFERENCES-FSHARP-FIND]); highlights stay file-local.
module SharpLsp.Sidecar.FSharp.FSharpReferences

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open Serilog
open SharpLsp.Sidecar.Common

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

/// FCS models an F# `[<CLIEvent>]` member as both its F# property and the
/// projected CLI event. Cross-file uses can bind to either symbol, so project
/// references and rename must query both projections.
let private projectUsageSymbols (symbol: FSharpSymbol) : FSharpSymbol array =
    match symbol with
    | :? FSharpMemberOrFunctionOrValue as memberOrValue ->
        [| yield symbol
           yield! memberOrValue.EventForFSharpProperty |> Option.toArray |> Array.map (fun event -> event :> FSharpSymbol) |]
    | _ -> [| symbol |]

let private sourceRangeKey (range: FSharp.Compiler.Text.Range) =
    NativePaths.NormalizeFullPath range.FileName, range.StartLine, range.StartColumn, range.EndLine, range.EndColumn

let private isCliEvent (memberOrValue: FSharpMemberOrFunctionOrValue) =
    memberOrValue.IsEvent
    || memberOrValue.IsEventAddMethod
    || memberOrValue.IsEventRemoveMethod
    || memberOrValue.EventForFSharpProperty.IsSome
    || (memberOrValue.Attributes |> Seq.exists (fun attribute -> attribute.AttributeType.DisplayName = "CLIEventAttribute"))

let private projectedEventKey (symbol: FSharpSymbol) =
    match symbol with
    | :? FSharpMemberOrFunctionOrValue as memberOrValue when isCliEvent memberOrValue ->
        Some(string symbol.Assembly.SimpleName, sourceRangeKey memberOrValue.DeclarationLocation)
    | _ -> None

let private matchesProjectedEvent key (symbolUse: FSharpSymbolUse) =
    projectedEventKey symbolUse.Symbol = Some key

let private semanticRangeKey (symbolUse: FSharpSymbolUse) =
    sourceRangeKey symbolUse.Range

/// Projection queries can report the same semantic occurrence twice. Keep one
/// use per source range, preferring a definition so includeDeclaration=false
/// never accidentally retains a duplicate declaration classified as a read.
let private deduplicateSemanticRanges (uses: FSharpSymbolUse array) =
    uses
    |> Array.groupBy semanticRangeKey
    |> Array.map (fun (_, sameRange) ->
        sameRange
        |> Array.tryFind (fun symbolUse -> symbolUse.IsFromDefinition)
        |> Option.defaultValue sameRange[0])

let private getFileUsages
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (symbol: FSharpSymbol)
    (filePath: string)
    =
    task {
        let! checkedFile = FSharpWorkspace.checkFile state filePath

        return
            checkedFile
            |> Option.map (fun (results, _) ->
                match projectedEventKey symbol with
                | Some key -> results.GetAllUsesOfAllSymbolsInFile() |> Seq.filter (matchesProjectedEvent key) |> Seq.toArray
                | None -> projectUsageSymbols symbol |> Array.collect results.GetUsesOfSymbolInFile)
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

        return uses.ToArray() |> deduplicateSemanticRanges
    }

/// Resolve project-wide uses from an already-resolved symbol. Rename uses this
/// entry point when it must retain the original semantic identity rather than
/// resolve the symbol again from a token-normalized source position.
let internal getProjectUsagesForSymbol
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (symbol: FSharpSymbol)
    =
    task {
        match state.ProjectOptions with
        | None -> return [||]
        | Some _ -> return! getOverlayAwareProjectUsages state symbol
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
                        return
                            match projectedEventKey symbolUse.Symbol with
                            | Some key -> checkResults.GetAllUsesOfAllSymbolsInFile() |> Seq.filter (matchesProjectedEvent key) |> Seq.toArray
                            | None -> projectUsageSymbols symbolUse.Symbol |> Array.collect checkResults.GetUsesOfSymbolInFile
                            |> deduplicateSemanticRanges
                    else
                        return! getProjectUsagesForSymbol state symbolUse.Symbol
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
