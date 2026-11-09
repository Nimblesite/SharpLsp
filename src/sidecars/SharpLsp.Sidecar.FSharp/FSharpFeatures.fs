/// F# formatting (Fantomas) and semantic tokens via FCS.
module SharpLsp.Sidecar.FSharp.FSharpFeatures

open System
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open MessagePack
open Serilog

// ── Formatting via Fantomas ─────────────────────────────────────
// Wired into the sidecar: FSharpSidecar registers textDocument/formatting,
// textDocument/rangeFormatting, and textDocument/formattingPreview against
// these functions. Sources are read through the workspace overlay so edits
// are computed from the live buffer, never stale disk text.
// [HOVER-FSHARP-OVERLAY]

/// Fantomas defaults to the environment's newline (CRLF on Windows), but a
/// formatter must preserve the document's own line endings — an LF file must
/// never be rewritten to CRLF just because the host OS is Windows.
let private formatConfigFor (source: string) : Fantomas.Core.FormatConfig =
    { Fantomas.Core.FormatConfig.Default with
        EndOfLine =
            if source.Contains("\r\n") then
                Fantomas.Core.EndOfLineStyle.CRLF
            else
                Fantomas.Core.EndOfLineStyle.LF }

/// Format an entire F# file using Fantomas.
let formatDocument (state: FSharpWorkspace.FSharpWorkspaceState) (filePath: string) =
    task {
        try
            let source = FSharpWorkspace.readSource state filePath

            let! formatResult =
                Fantomas.Core.CodeFormatter.FormatDocumentAsync(false, source, formatConfigFor source)
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
let formatRange
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (startLine: int)
    (startChar: int)
    (endLine: int)
    (endChar: int)
    =
    task {
        try
            let source = FSharpWorkspace.readSource state filePath
            let lines = source.Split('\n')
            // Extract the range and format just that portion.
            let rangeLines = lines[startLine..endLine]
            let rangeText = String.Join("\n", rangeLines)

            let! formatResult =
                Fantomas.Core.CodeFormatter.FormatDocumentAsync(false, rangeText, formatConfigFor rangeText)
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

// ── Formatting Preview (Fantomas) ───────────────────────────────

/// Preview Fantomas formatting: returns original and formatted text for diff view.
let formatPreview (state: FSharpWorkspace.FSharpWorkspaceState) (filePath: string) =
    task {
        try
            let source = FSharpWorkspace.readSource state filePath

            let! formatResult =
                Fantomas.Core.CodeFormatter.FormatDocumentAsync(false, source, formatConfigFor source)

            let formatted = formatResult.Code
            return Some {| Original = source; Formatted = formatted |}
        with ex ->
            Log.Debug(ex, "[F# FormatPreview] failed")
            return None
    }

// ── Semantic Tokens ──────────────────────────────────────────────

/// Keep values, functions and members in their standard LSP categories.
let private mapFcsMemberKind (mfv: FSharpMemberOrFunctionOrValue) =
    if mfv.IsProperty || mfv.IsPropertyGetterMethod || mfv.IsPropertySetterMethod then 9
    elif mfv.IsEvent then 11
    elif mfv.IsConstructor then
        match mfv.DeclaringEntity with
        | Some entity when entity.IsValueType -> 5
        | _ -> 2
    elif mfv.IsMember then 13
    elif mfv.IsFunction then 12
    else 8

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
    | :? FSharpMemberOrFunctionOrValue as mfv -> mapFcsMemberKind mfv
    | :? FSharpField -> 8
    | :? FSharpUnionCase -> 10
    | :? FSharpGenericParameter -> 6
    | _ -> -1

/// FCS ranges may include a receiver (`box.Value`). Reuse the real lexer to
/// color only the symbol token, never its receiver or punctuation.
/// [SHARPLSP-FEATURES-HIGHLIGHTING]
let private semanticSpans checker source (checkResults: FSharpCheckFileResults) =
    let tokenized = FSharpRenameToken.tokenizeSource checker source
    checkResults.GetAllUsesOfAllSymbolsInFile()
    |> Seq.choose (fun symbolUse ->
        let range = symbolUse.Range
        FSharpRenameToken.tokenForUse checker tokenized symbolUse
        |> Option.map (fun token ->
            let kind =
                match token.Kind with
                | FSharpRenameToken.OperatorToken -> 21
                | FSharpRenameToken.IdentifierToken -> mapFcsSymbolKind symbolUse.Symbol
            range.EndLine - 1, token.StartCharacter,
            token.EndCharacter - token.StartCharacter, kind))
    |> Seq.distinct
    |> Seq.sortBy (fun (line, character, _, _) -> line, character)
    |> Seq.toArray

/// Extract semantic tokens from check results using symbol uses.
let private extractSemanticTokens
    checker
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (rangeFilter: (int -> bool) option)
    : int array =
    // Callers (getSemanticTokens / getSemanticTokensRange) wrap this in their own
    // try/with, so no exception needs to be re-caught here.
    let sorted = semanticSpans checker source checkResults
    let mutable prevLine = 0
    let mutable prevChar = 0
    let data = System.Collections.Generic.List<int>()

    for line, character, length, tokenType in sorted do
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

/// Compute semantic tokens for an F# file using FCS. The overlay-aware
/// `checkFile` supplies the live buffer text. [HOVER-FSHARP-OVERLAY]
let getSemanticTokens
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    =
    task {
        try
            let! result = FSharpWorkspace.checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractSemanticTokens state.Checker checkResults source None
            | None -> return [||]
        with ex ->
            Log.Debug(ex, "[F# SemanticTokens] failed")
            return [||]
    }

/// Compute semantic tokens for a range of an F# file. [HOVER-FSHARP-OVERLAY]
let getSemanticTokensRange
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (startLine: int)
    (endLine: int)
    =
    task {
        try
            let! result = FSharpWorkspace.checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                let filter = fun line -> line >= startLine && line <= endLine
                return extractSemanticTokens state.Checker checkResults source (Some filter)
            | None -> return [||]
        with ex ->
            Log.Debug(ex, "[F# SemanticTokensRange] failed")
            return [||]
    }
