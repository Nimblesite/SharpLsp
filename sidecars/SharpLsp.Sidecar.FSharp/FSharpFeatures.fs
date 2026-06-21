/// F# formatting (Fantomas), semantic tokens, and inlay hints via FCS.
module SharpLsp.Sidecar.FSharp.FSharpFeatures

open System
open System.IO
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open MessagePack
open Serilog

// ── Formatting via Fantomas (SEQUESTERED) ───────────────────────
// This code is not wired into the LSP server. SharpLsp does not provide
// formatting — use Fantomas via the Ionide extension for F#.
// See docs/formatting/README.md for details.

/// Format an entire F# file using Fantomas.
let formatDocument (filePath: string) =
    task {
        try
            let source = File.ReadAllText(filePath)
            let! formatResult = Fantomas.Core.CodeFormatter.FormatDocumentAsync(false, source)
            let result = formatResult.Code
            if result = source then
                return [||]
            else
                let lines = source.Split('\n')
                let lastLine = max 0 (lines.Length - 1)
                let lastChar = if lines.Length > 0 then lines[lastLine].Length else 0
                return
                    [| {| StartLine = 0
                          StartCharacter = 0
                          EndLine = lastLine
                          EndCharacter = lastChar
                          NewText = result |} |]
        with ex ->
            Log.Debug(ex, "[F# Format] failed")
            return [||]
    }

/// Format a range of an F# file using Fantomas.
let formatRange (filePath: string) (startLine: int) (startChar: int) (endLine: int) (endChar: int) =
    task {
        try
            let source = File.ReadAllText(filePath)
            let lines = source.Split('\n')
            // Extract the range and format just that portion.
            let rangeLines = lines[startLine..endLine]
            let rangeText = String.Join("\n", rangeLines)
            let! formatResult = Fantomas.Core.CodeFormatter.FormatDocumentAsync(false, rangeText)
            let result = formatResult.Code
            if result = rangeText then
                return [||]
            else
                return
                    [| {| StartLine = startLine
                          StartCharacter = 0
                          EndLine = endLine
                          EndCharacter = if endLine < lines.Length then lines[endLine].Length else 0
                          NewText = result |} |]
        with ex ->
            Log.Debug(ex, "[F# FormatRange] failed")
            return [||]
    }

// ── Formatting Preview (Fantomas) (SEQUESTERED) ────────────────

/// Preview Fantomas formatting: returns original and formatted text for diff view.
let formatPreview (filePath: string) =
    task {
        try
            let source = File.ReadAllText(filePath)
            let! formatResult = Fantomas.Core.CodeFormatter.FormatDocumentAsync(false, source)
            let formatted = formatResult.Code
            return Some {| Original = source; Formatted = formatted |}
        with ex ->
            Log.Debug(ex, "[F# FormatPreview] failed")
            return None
    }

// ── Semantic Tokens ──────────────────────────────────────────────

/// Map FCS symbol to LSP semantic token type index.
let private mapFcsSymbolKind (symbol: FSharpSymbol) : int =
    match symbol with
    | :? FSharpEntity as ent ->
        if ent.IsNamespace then 0
        elif ent.IsInterface then 4
        elif ent.IsEnum then 3
        elif ent.IsValueType then 5
        elif ent.IsFSharpModule then 0
        else 2
    | :? FSharpMemberOrFunctionOrValue as mfv ->
        if mfv.IsProperty then 9
        elif mfv.IsEvent then 11
        else 13
    | :? FSharpField -> 8
    | :? FSharpUnionCase -> 10
    | :? FSharpGenericParameter -> 6
    | _ -> -1

/// Extract semantic tokens from check results using symbol uses.
let private extractSemanticTokens
    (checkResults: FSharpCheckFileResults)
    (_source: string)
    (rangeFilter: (int -> bool) option)
    : int array =
    // Callers (getSemanticTokens / getSemanticTokensRange) wrap this in their own
    // try/with, so no exception needs to be re-caught here.
    let uses = checkResults.GetAllUsesOfAllSymbolsInFile() |> Seq.toArray
    let mutable prevLine = 0
    let mutable prevChar = 0
    let data = System.Collections.Generic.List<int>()

    let sorted = uses |> Array.sortBy (fun u ->
        let r = u.Range
        r.StartLine, r.StartColumn)

    for su in sorted do
        let r = su.Range
        let line = r.StartLine - 1
        let character = r.StartColumn
        let length = r.EndColumn - r.StartColumn
        let tokenType = mapFcsSymbolKind su.Symbol
        let inRange =
            match rangeFilter with
            | Some f -> f line
            | None -> true
        if tokenType >= 0 && length > 0 && inRange then
            let deltaLine = line - prevLine
            let deltaChar = if deltaLine = 0 then character - prevChar else character
            data.Add(deltaLine)
            data.Add(deltaChar)
            data.Add(length)
            data.Add(tokenType)
            data.Add(0)
            prevLine <- line
            prevChar <- character

    data.ToArray()

/// Compute semantic tokens for an F# file using FCS.
let getSemanticTokens
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    =
    task {
        try
            if not state.IsLoaded then
                return [||]
            else
                let source = File.ReadAllText(filePath)
                let sourceText = SourceText.ofString source
                let! _parseResults, checkAnswer =
                    state.Checker.ParseAndCheckFileInProject(
                        filePath, 0, sourceText, state.ProjectOptions.Value)
                match checkAnswer with
                | FSharpCheckFileAnswer.Succeeded checkResults ->
                    return extractSemanticTokens checkResults source None
                | FSharpCheckFileAnswer.Aborted ->
                    return [||]
        with ex ->
            Log.Debug(ex, "[F# SemanticTokens] failed")
            return [||]
    }

/// Compute semantic tokens for a range of an F# file.
let getSemanticTokensRange
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (startLine: int)
    (endLine: int)
    =
    task {
        try
            if not state.IsLoaded then
                return [||]
            else
                let source = File.ReadAllText(filePath)
                let sourceText = SourceText.ofString source
                let! _parseResults, checkAnswer =
                    state.Checker.ParseAndCheckFileInProject(
                        filePath, 0, sourceText, state.ProjectOptions.Value)
                match checkAnswer with
                | FSharpCheckFileAnswer.Succeeded checkResults ->
                    let filter = fun line -> line >= startLine && line <= endLine
                    return extractSemanticTokens checkResults source (Some filter)
                | FSharpCheckFileAnswer.Aborted ->
                    return [||]
        with ex ->
            Log.Debug(ex, "[F# SemanticTokensRange] failed")
            return [||]
    }

// ── Inlay Hints ──────────────────────────────────────────────────

/// Wire-compatible inlay hint, positionally matched to the Rust host's
/// `SidecarInlayHint` ([line, character, label, kind]). This MUST be a keyed
/// MessagePack record — F# anonymous records (`{| ... |}`) serialize with
/// alphabetically-sorted, named fields, which the host cannot deserialize
/// (it fails with `missing field \`line\``), so inlay hints silently vanished.
[<MessagePackObject>]
type InlayHintItem =
    { [<Key(0)>] Line: int
      [<Key(1)>] Character: int
      [<Key(2)>] Label: string
      [<Key(3)>] Kind: int }

/// Extract type hints for let bindings (Kind = 1 = Type).
let private extractTypeHints
    (checkResults: FSharpCheckFileResults)
    (startLine: int)
    (endLine: int)
    : InlayHintItem list =
    // getInlayHints wraps all extractors in a try/with, so no re-catch here.
    let uses = checkResults.GetAllUsesOfAllSymbolsInFile() |> Seq.toArray
    [ for su in uses do
        let r = su.Range
        let line = r.StartLine - 1
        if line >= startLine && line <= endLine then
            match su.Symbol with
            | :? FSharpMemberOrFunctionOrValue as mfv
                when su.IsFromDefinition && not mfv.IsProperty ->
                let typeName = mfv.FullType.Format(FSharpDisplayContext.Empty)
                let endCol = r.EndColumn
                yield
                    { Line = line
                      Character = endCol
                      Label = $": {typeName}"
                      Kind = 1 }
            | _ -> () ]

/// Extract parameter name hints for function applications (Kind = 2 = Parameter).
let private extractParameterHints
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    (startLine: int)
    (endLine: int)
    : InlayHintItem list =
    // getInlayHints wraps all extractors in a try/with, so no re-catch here.
    let uses = checkResults.GetAllUsesOfAllSymbolsInFile() |> Seq.toArray
    [ for su in uses do
        let r = su.Range
        let line = r.StartLine - 1
        if line >= startLine && line <= endLine then
            match su.Symbol with
            | :? FSharpMemberOrFunctionOrValue as mfv
                when not su.IsFromDefinition && mfv.CurriedParameterGroups.Count > 0 ->
                // Show parameter names for the first parameter group.
                for paramGroup in mfv.CurriedParameterGroups do
                    for param in paramGroup do
                        match param.DisplayName with
                        | name when name <> "" ->
                            yield
                                { Line = line
                                  Character = r.StartColumn
                                  Label = $"{name}:"
                                  Kind = 2 }
                        | _ -> ()
            | _ -> () ]

/// Extract pipeline type hints (Kind = 1 = Type).
let private extractPipelineHints
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (startLine: int)
    (endLine: int)
    : InlayHintItem list =
    // getInlayHints wraps all extractors in a try/with, so no re-catch here.
    let lines = source.Split('\n')
    [ for lineIdx in startLine .. (min endLine (lines.Length - 1)) do
        let line = lines[lineIdx]
        let pipeIdx = line.IndexOf("|>", StringComparison.Ordinal)
        if pipeIdx >= 0 then
            // Try to get type info just before the pipe.
            let col = max 0 (pipeIdx - 1)
            let tooltip = checkResults.GetToolTip(lineIdx + 1, col, line, [], FSharp.Compiler.Tokenization.FSharpTokenTag.Identifier)
            match tooltip with
            | FSharp.Compiler.EditorServices.ToolTipText(elems) when not (List.isEmpty elems) ->
                match elems[0] with
                | FSharp.Compiler.EditorServices.ToolTipElement.Group(items) when not (List.isEmpty items) ->
                    let typeName = items[0].MainDescription |> Array.map (fun t -> t.Text) |> String.concat ""
                    if typeName <> "" then
                        yield
                            { Line = lineIdx
                              Character = pipeIdx
                              Label = $": {typeName}"
                              Kind = 1 }
                | _ -> ()
            | _ -> () ]

/// Get inlay hints for an F# file.
let getInlayHints
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (startLine: int)
    (endLine: int)
    =
    task {
        try
            if not state.IsLoaded then
                return []
            else
                let source = File.ReadAllText(filePath)
                let sourceText = SourceText.ofString source
                let! parseResults, checkAnswer =
                    state.Checker.ParseAndCheckFileInProject(
                        filePath, 0, sourceText, state.ProjectOptions.Value)
                match checkAnswer with
                | FSharpCheckFileAnswer.Succeeded checkResults ->
                    let typeHints = extractTypeHints checkResults startLine endLine
                    let paramHints = extractParameterHints checkResults parseResults startLine endLine
                    let pipeHints = extractPipelineHints checkResults source startLine endLine
                    return typeHints @ paramHints @ pipeHints
                | FSharpCheckFileAnswer.Aborted ->
                    return []
        with ex ->
            Log.Debug(ex, "[F# InlayHints] failed")
            return []
    }
