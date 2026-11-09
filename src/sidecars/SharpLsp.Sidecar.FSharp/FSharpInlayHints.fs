/// F# inlay hints via FCS: inferred types, parameter names and pipeline types.
module SharpLsp.Sidecar.FSharp.FSharpInlayHints

open System
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open MessagePack
open Serilog

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

/// Get inlay hints for an F# file. The overlay-aware `checkFileWithParse`
/// supplies the live buffer text. [HOVER-FSHARP-OVERLAY]
let getInlayHints
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (startLine: int)
    (endLine: int)
    =
    task {
        try
            let! result = FSharpWorkspace.checkFileWithParse state filePath
            match result with
            | Some(parseResults, checkResults, source) ->
                let typeHints = extractTypeHints checkResults startLine endLine
                let paramHints = extractParameterHints checkResults parseResults startLine endLine
                let pipeHints = extractPipelineHints checkResults source startLine endLine
                return typeHints @ paramHints @ pipeHints
            | None -> return []
        with ex ->
            Log.Debug(ex, "[F# InlayHints] failed")
            return []
    }
